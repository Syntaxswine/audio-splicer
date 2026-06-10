// audio-splicer engine: probe, plan, render.
// Plans are pure data (arrays of segments) so they can be tested without ffmpeg;
// render() is the only thing that shells out.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const run = promisify(execFile);
const ffprobePath = ffprobeStatic.path;

export const AUDIO_EXTENSIONS = new Set([
  '.ogg', '.oga', '.oog', // .oog: common typo'd rename of .ogg; ffmpeg sniffs content, not extension
  '.mp3', '.wav', '.flac', '.m4a', '.aac', '.opus', '.wma', '.aiff', '.aif', '.webm', '.mka',
]);

const ENCODERS = {
  '.wav': ['-c:a', 'pcm_s16le'],
  '.ogg': ['-c:a', 'libvorbis', '-q:a', '5'],
  '.oga': ['-c:a', 'libvorbis', '-q:a', '5'],
  '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2'],
  '.flac': ['-c:a', 'flac'],
  '.m4a': ['-c:a', 'aac', '-b:a', '192k'],
  '.aac': ['-c:a', 'aac', '-b:a', '192k'],
  '.opus': ['-c:a', 'libopus', '-b:a', '128k'],
};

export function encoderArgsFor(outPath) {
  const ext = path.extname(outPath).toLowerCase();
  const args = ENCODERS[ext];
  if (!args) {
    throw new Error(
      `Unsupported output format "${ext}". Supported: ${Object.keys(ENCODERS).join(', ')}`
    );
  }
  return args;
}

export async function probeDuration(file) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const dur = parseFloat(stdout.trim());
  if (!Number.isFinite(dur) || dur <= 0) {
    throw new Error(`Could not read duration of ${file}`);
  }
  return dur;
}

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32 seeded via xmur3 string hash) so --seed reproduces a mix.

export function makeRng(seed) {
  const str = String(seed);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (h >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Plans. Segment: {type:'file', path, dur} | {type:'silence', dur}

export function buildConcatPlan(files, { gap = 0 } = {}) {
  const segments = [];
  files.forEach((f, i) => {
    if (i > 0 && gap > 0.002) segments.push({ type: 'silence', dur: gap });
    segments.push({ type: 'file', path: f.path, dur: f.dur });
  });
  return { segments, totalDur: segments.reduce((s, x) => s + x.dur, 0) };
}

// Random splice: place files in random order with random 0..maxGap gaps between
// them until nothing more fits; the leftover becomes silence at the head/tail
// (those two gaps may exceed maxGap — that's where the long whitespace goes).
// Repeat cap per file: floor(target / totalSourceDur) + 1.
export function buildRandomPlan(files, targetSec, { maxGap = 5, rng = Math.random } = {}) {
  const totalSource = files.reduce((s, f) => s + f.dur, 0);
  const cap = Math.floor(targetSec / totalSource) + 1;
  const usesLeft = files.map(() => cap);

  const body = [];
  let elapsed = 0;
  let first = true;
  for (;;) {
    let gap = first ? 0 : rng() * maxGap;
    let fits = files
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => usesLeft[i] > 0 && elapsed + gap + f.dur <= targetSec + 1e-9);
    if (fits.length === 0 && gap > 0) {
      // the drawn gap was too greedy — see if anything fits flush
      gap = 0;
      fits = files
        .map((f, i) => ({ f, i }))
        .filter(({ f, i }) => usesLeft[i] > 0 && elapsed + f.dur <= targetSec + 1e-9);
    }
    if (fits.length === 0) break;
    const pick = fits[Math.floor(rng() * fits.length)];
    if (gap > 0.002) body.push({ type: 'silence', dur: gap });
    body.push({ type: 'file', path: pick.f.path, dur: pick.f.dur });
    usesLeft[pick.i] -= 1;
    elapsed += gap + pick.f.dur;
    first = false;
  }

  if (body.length === 0) {
    throw new Error(
      `No input file fits within the target length (${targetSec.toFixed(1)}s); ` +
      `shortest input is ${Math.min(...files.map(f => f.dur)).toFixed(1)}s`
    );
  }

  const leftover = targetSec - elapsed;
  const head = leftover * rng();
  const tail = leftover - head;
  const segments = [];
  if (head > 0.002) segments.push({ type: 'silence', dur: head });
  segments.push(...body);
  if (tail > 0.002) segments.push({ type: 'silence', dur: tail });

  const counts = {};
  for (const s of segments) {
    if (s.type === 'file') counts[s.path] = (counts[s.path] || 0) + 1;
  }
  return { segments, totalDur: targetSec, cap, counts, leftover };
}

export function planSequence(plan) {
  return plan.segments.filter(s => s.type === 'file').map(s => path.basename(s.path));
}

// ---------------------------------------------------------------------------
// Novelty: normalized Levenshtein between file-name sequences. 0 = identical mix
// order, 1 = nothing in common. Used to pick the candidate plan farthest from
// everything in the history file.

export function sequenceDistance(a, b) {
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[m] / Math.max(n, m);
}

export function pickNovelPlan(candidates, historySequences) {
  if (historySequences.length === 0) return { plan: candidates[0], novelty: 1 };
  let best = null;
  let bestScore = -1;
  for (const plan of candidates) {
    const seq = planSequence(plan);
    const score = Math.min(...historySequences.map(h => sequenceDistance(seq, h)));
    if (score > bestScore) {
      bestScore = score;
      best = plan;
    }
  }
  return { plan: best, novelty: bestScore };
}

// ---------------------------------------------------------------------------
// Render: every file segment becomes its own -i input (duplicates are fine and
// bounded by the repeat cap), silence comes from anullsrc, everything is
// resampled to a common format and concat'd. Filter graph goes via a script
// file to dodge Windows command-line length limits.

export async function renderPlan(plan, outPath, { sampleRate = 44100, padTo = null, onLog } = {}) {
  const segs = plan.segments.filter(s => !(s.type === 'silence' && s.dur < 0.002));
  const inputs = [];
  const filterLines = [];
  const labels = [];

  segs.forEach((seg, k) => {
    const label = `s${k}`;
    if (seg.type === 'file') {
      const idx = inputs.length;
      inputs.push(seg.path);
      filterLines.push(
        `[${idx}:a]aresample=${sampleRate},` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`
      );
    } else {
      filterLines.push(
        `anullsrc=r=${sampleRate}:cl=stereo,atrim=duration=${seg.dur.toFixed(4)}[${label}]`
      );
    }
    labels.push(`[${label}]`);
  });

  filterLines.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[cat]`);
  if (padTo != null) {
    // sample-exact final length: pad with silence to the target, then trim to it
    filterLines.push(`[cat]apad=whole_dur=${padTo},atrim=end=${padTo}[out]`);
  } else {
    filterLines.push(`[cat]anull[out]`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'splice-'));
  const scriptPath = path.join(workDir, 'filter.txt');
  await writeFile(scriptPath, filterLines.join(';\n'), 'utf8');

  const args = [
    '-hide_banner', '-y',
    ...inputs.flatMap(f => ['-i', f]),
    '-filter_complex_script', scriptPath,
    '-map', '[out]',
    ...encoderArgsFor(outPath),
    outPath,
  ];

  try {
    await run(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const tail = String(err.stderr || err.message).split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed:\n${tail}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
  if (onLog) onLog(`wrote ${outPath}`);
}
