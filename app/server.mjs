// audio-splicer app server: serves the UI on 127.0.0.1 and opens it in an Edge
// app window (chromeless, looks like a native app). Reuses lib/engine.mjs for
// all the actual work. Auto-exits ~45s after the window closes so launches
// don't pile up node processes.

import http from 'node:http';
import { readFile, readdir, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import {
  AUDIO_EXTENSIONS, probeDuration, makeRng, parseLength, mixArtifactRegex,
  buildConcatPlan, buildRandomPlan, planSequence, pickNovelPlan, renderPlan,
} from '../lib/engine.mjs';
import {
  findLoopCrop, renderLoopCrop, decodeMono, featurize, scorePairSeconds,
  refineSeconds, autoSeamFade, ANALYSIS_RATE,
} from '../lib/loop.mjs';

// "auto" / blank -> scale the wrap-blend with seam weakness; a number forces it
function resolveSeamFade(requested, score, startSec) {
  const v = String(requested ?? '').trim().toLowerCase();
  if (v === '' || v === 'auto') return autoSeamFade(score, startSec);
  return Math.max(0, parseFloat(v) || 0);
}

const PORT = parseInt(process.env.SPLICE_PORT || '8741', 10);
const appDir = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_NAME = '.splice-history.json';
const HISTORY_LIMIT = 200;
const pexec = promisify(execFile);

const MIME = {
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.oog': 'audio/ogg', '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff', '.aif': 'audio/aiff', '.webm': 'audio/webm', '.mka': 'audio/x-matroska',
};

let lastPing = Date.now();
let rendering = false;
let byeTimer = null;

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function scanFolder(folder, excludeBase = null) {
  const artifact = excludeBase ? mixArtifactRegex(excludeBase) : null;
  const entries = await readdir(folder, { withFileTypes: true });
  const names = entries
    .filter(e => e.isFile() && AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .filter(e => !(artifact && artifact.test(e.name)))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const files = [];
  for (const name of names) {
    const p = path.join(folder, name);
    files.push({ path: p, name, dur: await probeDuration(p) });
  }
  return files;
}

// Run a WinForms picker. The dialog must open IN FRONT of the borderless Edge
// app window, so we create a real owner form, make it topmost, and actually
// Show()+Activate() it (an unshown TopMost form does NOT pull a child dialog
// forward — that was the "browse does nothing" bug). $setup builds $d and emits
// the chosen path. Script runs from a temp .ps1 to avoid -Command quoting.
async function runPicker(setup) {
  // The dialog has to land IN FRONT of the borderless Edge app window. A
  // background process can't steal foreground focus from another process's
  // window (Windows foreground lock — that was the "browse does nothing" bug:
  // dialog opened behind, taskbar button just flashed). The fix that does work
  // regardless of focus: a genuinely TopMost owner window renders above all
  // non-topmost windows (Edge is non-topmost), and a modal dialog owned by it
  // inherits that z-order. The owner must be ON-SCREEN and shown to be a real
  // topmost window (Opacity 0 keeps it invisible; centering keeps the dialog,
  // which centers on its owner, on the primary monitor).
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.BringToFront()
$owner.Activate()
[System.Windows.Forms.Application]::DoEvents()
try {
${setup}
} finally {
  $owner.Close()
  $owner.Dispose()
}
`;
  const dir = await mkdtemp(path.join(tmpdir(), 'splice-pick-'));
  const scriptPath = path.join(dir, 'pick.ps1');
  await writeFile(scriptPath, script, 'utf8');
  try {
    const { stdout } = await pexec('powershell',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]);
    return stdout.trim() || null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function pickFile() {
  const filter = 'Audio files|*.ogg;*.oga;*.oog;*.mp3;*.wav;*.flac;*.m4a;*.aac;*.opus;*.wma;*.aiff;*.aif;*.webm;*.mka|All files|*.*';
  return runPicker(`
  $d = New-Object System.Windows.Forms.OpenFileDialog
  $d.Title = 'Choose the track to make loopable'
  $d.Filter = '${filter}'
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }
`);
}

async function pickFolder(kind) {
  const desc = kind === 'output'
    ? 'Choose where the mix should be saved'
    : 'Choose the folder with your audio files';
  return runPicker(`
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = '${desc}'
  $d.ShowNewFolderButton = $true
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
`);
}

async function loadHistory(historyPath) {
  try {
    const data = JSON.parse(await readFile(historyPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let n = 2;
  while (existsSync(p)) p = path.join(dir, `${base}-${n++}${ext}`);
  return p;
}

async function handleMix(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  rendering = true;
  try {
    const q = await readBody(req);
    const inputFolder = (q.inputFolder || '').trim();
    if (!inputFolder || !existsSync(inputFolder)) throw new Error('Pick an input folder first.');
    let outputFolder = (q.outputFolder || '').trim();
    if (!outputFolder) {
      // default: a "mixes" subfolder, so outputs never land in the source pool
      outputFolder = path.join(inputFolder, 'mixes');
      await mkdir(outputFolder, { recursive: true });
    }
    if (!existsSync(outputFolder)) throw new Error(`Output folder does not exist: ${outputFolder}`);

    const crossfade = Math.max(0, parseFloat(q.crossfade) || 0);
    const normalize = !!q.normalize;
    const baseName = (q.name || 'mix').replace(/[\\/:*?"<>|]/g, '').trim() || 'mix';
    const ext = q.format || '.ogg';
    const outPath = uniquePath(outputFolder, baseName, ext);

    send({ log: 'reading input folder...' });
    // if mixes are saved into the source folder anyway, never re-ingest our own outputs
    const sameFolder = path.resolve(outputFolder) === path.resolve(inputFolder);
    const files = await scanFolder(inputFolder, sameFolder ? baseName : null);
    if (files.length === 0) throw new Error('No audio files found in the input folder.');
    const totalSource = files.reduce((s, f) => s + f.dur, 0);
    send({ log: `${files.length} file(s), ${totalSource.toFixed(1)}s of source audio` });

    let plan, seed = null, novelty = null;
    if (q.mode === 'concat') {
      const gap = Math.max(0, parseFloat(q.gap) || 0);
      plan = buildConcatPlan(files, { gap: crossfade > 0 ? 0 : gap, crossfade });
    } else {
      const target = parseLength(q.length);
      if (!target) throw new Error('Enter a target length like 9:00, 540 or 9m.');
      const maxGap = Math.max(0, parseFloat(q.maxGap) || 5);
      const explicitSeed = !!(q.seed && String(q.seed).trim());
      seed = explicitSeed ? String(q.seed).trim() : String(randomInt(1, 2 ** 31));
      const rng = makeRng(seed);
      const historyPath = path.join(outputFolder, HISTORY_NAME);
      const useHistory = q.history !== false && !explicitSeed;
      const history = useHistory ? await loadHistory(historyPath) : [];

      if (explicitSeed) {
        plan = buildRandomPlan(files, target, { maxGap, crossfade, rng });
      } else {
        const candidates = Array.from({ length: 64 }, () =>
          buildRandomPlan(files, target, { maxGap, crossfade, rng })
        );
        ({ plan, novelty } = pickNovelPlan(candidates, history.map(h => h.sequence)));
      }
      send({ log: `repeat cap: ${plan.cap} use(s) per file` });
      if (novelty != null && history.length > 0) {
        send({ log: `novelty: ${(novelty * 100).toFixed(0)}% different from nearest of ${history.length} previous mix(es)` });
      }

      if (q.history !== false) {
        // record after render below
        plan._history = { historyPath, target, seed };
      }
    }

    if (normalize) send({ log: 'normalizing to -16 LUFS:' });
    send({ log: 'rendering...' });
    await renderPlan(plan, outPath, { normalize, onLog: m => send({ log: m }) });

    if (plan._history) {
      const { historyPath, target, seed: s } = plan._history;
      const all = await loadHistory(historyPath);
      all.push({
        when: new Date().toISOString(),
        output: path.basename(outPath),
        target, seed: s,
        sequence: planSequence(plan),
      });
      await writeFile(historyPath, JSON.stringify(all.slice(-HISTORY_LIMIT), null, 1), 'utf8');
    }

    send({
      done: {
        outPath,
        outName: path.basename(outPath),
        seed, novelty,
        cap: plan.cap ?? null,
        totalDur: plan.totalDur,
        counts: plan.counts
          ? Object.fromEntries(Object.entries(plan.counts).map(([p, c]) => [path.basename(p), c]))
          : null,
        events: plan.events.map(e => ({
          name: path.basename(e.path), start: e.start, dur: e.dur,
        })),
      },
    });
  } catch (err) {
    send({ error: err.message });
  } finally {
    rendering = false;
    res.end();
  }
}

async function handleLoop(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const send = obj => res.write(JSON.stringify(obj) + '\n');
  rendering = true;
  try {
    const q = await readBody(req);
    const file = (q.file || '').trim();
    if (!file || !existsSync(file)) throw new Error('Pick a track first.');
    const srcExt = path.extname(file).toLowerCase();
    const ext = q.format || (srcExt === '.oog' ? '.ogg' : srcExt);
    const outDir = (q.outputFolder || '').trim() || path.dirname(file);
    if (!existsSync(outDir)) throw new Error(`Output folder does not exist: ${outDir}`);
    const outPath = uniquePath(outDir, `${path.basename(file, srcExt)}-loop`, ext);

    if (q.startSec != null && q.endSec != null) {
      // manual slice: the user clicked a spot on the similarity map
      send({ log: `manual slice ${(+q.startSec).toFixed(1)}s -> ${(+q.endSec).toFixed(1)}s — refining...` });
      const x = await decodeMono(file);
      const durSec = x.length / ANALYSIS_RATE;
      const F = featurize(x);
      const score = scorePairSeconds(F, +q.startSec, +q.endSec);
      const { startSec, endSec } = refineSeconds(x, +q.startSec, +q.endSec);
      const weakSeam = score < 0.85;
      const seamFade = resolveSeamFade(q.seamFade, score, startSec);
      send({ log: 'rendering crop...' });
      const { seamFadeSec: fadeUsed } = await renderLoopCrop(file, outPath, startSec, endSec, { seamFadeSec: seamFade });
      send({
        done: {
          kind: 'loop', manual: true,
          outPath, outName: path.basename(outPath),
          durSec, startSec, endSec, keptSec: endSec - startSec,
          score, percentile: null,
          bpm: null, beatAligned: false, beatsKept: null,
          weakSeam, seamFadeSec: fadeUsed,
          totalDur: endSec - startSec,
        },
      });
      return;
    }

    const r = await findLoopCrop(file, {
      maxTrim: q.maxTrim || null, quality: q.quality || null, withMap: true,
      onLog: m => send({ log: m }),
    });
    // wrap-blend the trimmed lead-in under the tail; auto scales with seam weakness
    const seamFade = resolveSeamFade(q.seamFade, r.score, r.startSec);
    send({ log: 'rendering crop...' });
    const { seamFadeSec: fadeUsed } = await renderLoopCrop(file, outPath, r.startSec, r.endSec, { seamFadeSec: seamFade });
    send({
      done: {
        kind: 'loop',
        outPath, outName: path.basename(outPath),
        durSec: r.durSec, startSec: r.startSec, endSec: r.endSec, keptSec: r.keptSec,
        score: r.score, percentile: r.percentile,
        bpm: r.bpm, beatAligned: r.beatAligned, beatsKept: r.beatsKept,
        weakSeam: r.weakSeam, seamFadeSec: fadeUsed,
        cutsOn: r.cutsOn, breaks: r.breaks,
        map: r.map,
        totalDur: r.keptSec,
      },
    });
  } catch (err) {
    send({ error: err.message });
  } finally {
    rendering = false;
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(path.join(appDir, 'ui.html')));
    } else if (url.pathname === '/api/ping') {
      lastPing = Date.now();
      if (byeTimer) { clearTimeout(byeTimer); byeTimer = null; }
      sendJson(res, { ok: true });
    } else if (url.pathname === '/api/bye') {
      // window closed; give a reload 6s to re-ping before exiting
      res.end();
      if (!byeTimer) {
        byeTimer = setTimeout(() => { if (!rendering) process.exit(0); }, 6000);
      }
    } else if (url.pathname === '/api/browse') {
      const { kind } = await readBody(req);
      sendJson(res, { path: await pickFolder(kind) });
    } else if (url.pathname === '/api/scan') {
      const { folder, excludeBase } = await readBody(req);
      if (!folder || !existsSync(folder)) throw new Error('Folder not found.');
      const files = await scanFolder(folder, excludeBase || null);
      sendJson(res, {
        files: files.map(f => ({ name: f.name, dur: f.dur })),
        total: files.reduce((s, f) => s + f.dur, 0),
      });
    } else if (url.pathname === '/api/browse-file') {
      sendJson(res, { path: await pickFile() });
    } else if (url.pathname === '/api/mix') {
      await handleMix(req, res);
    } else if (url.pathname === '/api/loop') {
      await handleLoop(req, res);
    } else if (url.pathname === '/api/audio') {
      const p = url.searchParams.get('p') || '';
      const ext = path.extname(p).toLowerCase();
      if (!MIME[ext] || !existsSync(p)) throw new Error('Not an audio file.');
      res.writeHead(200, { 'Content-Type': MIME[ext] });
      createReadStream(p).pipe(res);
    } else if (url.pathname === '/api/open') {
      const { file } = await readBody(req);
      if (file && existsSync(file)) {
        execFile('explorer', [`/select,${file}`], () => {}); // explorer's exit code is junk; ignore
      }
      sendJson(res, { ok: true });
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  } catch (err) {
    sendJson(res, { error: err.message }, 400);
  }
});

function openWindow() {
  if (process.env.SPLICE_NO_OPEN) return;
  spawn('cmd', ['/c', 'start', '', 'msedge', `--app=http://127.0.0.1:${PORT}/`],
    { detached: true, stdio: 'ignore' }).on('error', () => {
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}/`],
        { detached: true, stdio: 'ignore' });
    });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    openWindow(); // an instance is already running — just show its window
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`audio-splicer app on http://127.0.0.1:${PORT}`);
  openWindow();
  if (!process.env.SPLICE_NO_TIMEOUT) {
    setInterval(() => {
      if (!rendering && Date.now() - lastPing > 45000) process.exit(0);
    }, 5000).unref(); // unref'd: the listening server keeps the loop alive
  }
});
