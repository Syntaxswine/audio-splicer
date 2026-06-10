// audio-splicer engine: probe, plan, render.
// Plans are pure data (events with absolute start times) so they can be tested
// without ffmpeg; render() and the loudness measurer are the only things that
// shell out. Silence is implicit — it's just where no event is playing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

const run = promisify(execFile);
const ffprobePath = ffprobeStatic.path;

const TARGET_LUFS = -16;
const TARGET_TP = -1.5;

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
// Plans. Event: {path, dur, start, fadeIn, fadeOut} — start is absolute seconds.

function validateCrossfade(files, crossfade) {
  if (crossfade < 0) throw new Error('--crossfade must be >= 0');
  if (crossfade === 0) return;
  const shortest = files.reduce((a, b) => (a.dur <= b.dur ? a : b));
  if (shortest.dur < crossfade * 2) {
    throw new Error(
      `--crossfade ${crossfade}s needs every file to be at least ${(crossfade * 2).toFixed(1)}s; ` +
      `${path.basename(shortest.path)} is only ${shortest.dur.toFixed(1)}s`
    );
  }
}

export function buildConcatPlan(files, { gap = 0, crossfade = 0 } = {}) {
  validateCrossfade(files, crossfade);
  const events = [];
  let end = 0;
  files.forEach((f, i) => {
    const start = i === 0 ? 0 : end + gap - crossfade;
    events.push({
      path: f.path, dur: f.dur, start,
      fadeIn: i > 0 ? crossfade : 0,
      fadeOut: i < files.length - 1 ? crossfade : 0,
    });
    end = start + f.dur;
  });
  return { events, totalDur: end };
}

// Random splice: place files in random order until nothing more fits; the joint
// between consecutive clips is drawn uniform from [-crossfade, maxGap] — negative
// means the clips overlap-blend, positive is silence. Leftover time becomes
// silence at the head/tail (those two gaps may exceed maxGap — that's where the
// long whitespace goes). Repeat cap per file: floor(target / totalSourceDur) + 1.
export function buildRandomPlan(files, targetSec, { maxGap = 5, crossfade = 0, rng = Math.random } = {}) {
  validateCrossfade(files, crossfade);
  const totalSource = files.reduce((s, f) => s + f.dur, 0);
  const cap = Math.floor(targetSec / totalSource) + 1;
  const usesLeft = files.map(() => cap);

  const events = [];
  let end = 0; // end time of the last clip placed
  for (;;) {
    const first = events.length === 0;
    let joint = first ? 0 : -crossfade + rng() * (maxGap + crossfade);
    const fitting = j => files
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => usesLeft[i] > 0 && end + j + f.dur <= targetSec + 1e-9);
    let fits = fitting(joint);
    if (fits.length === 0 && !first) {
      // the drawn joint was too greedy — try the tightest legal packing
      joint = -crossfade;
      fits = fitting(joint);
    }
    if (fits.length === 0) break;
    const pick = fits[Math.floor(rng() * fits.length)];
    events.push({
      path: pick.f.path, dur: pick.f.dur,
      start: first ? 0 : end + joint,
      fadeIn: crossfade, fadeOut: crossfade,
    });
    usesLeft[pick.i] -= 1;
    end = events[events.length - 1].start + pick.f.dur;
  }

  if (events.length === 0) {
    throw new Error(
      `No input file fits within the target length (${targetSec.toFixed(1)}s); ` +
      `shortest input is ${Math.min(...files.map(f => f.dur)).toFixed(1)}s`
    );
  }

  const leftover = targetSec - end;
  const head = leftover * rng();
  for (const e of events) e.start += head;

  const counts = {};
  for (const e of events) counts[e.path] = (counts[e.path] || 0) + 1;
  return { events, totalDur: targetSec, cap, counts, leftover };
}

export function planSequence(plan) {
  return plan.events.map(e => path.basename(e.path));
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
// Loudness: two-pass normalization. Measure each unique file with loudnorm,
// then apply a static volume gain to hit TARGET_LUFS, capped so the true peak
// never exceeds TARGET_TP. Static gain = no pumping on quiet recordings.

export async function measureLoudness(file) {
  const { stderr } = await run(ffmpegPath, [
    '-hide_banner', '-i', file,
    '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=11:print_format=json`,
    '-f', 'null', '-',
  ], { maxBuffer: 64 * 1024 * 1024 }).catch(err => err);
  const jsonStart = stderr ? stderr.lastIndexOf('{') : -1;
  if (jsonStart < 0) throw new Error(`Could not measure loudness of ${file}`);
  const j = JSON.parse(stderr.slice(jsonStart));
  return { lufs: parseFloat(j.input_i), truePeak: parseFloat(j.input_tp) };
}

export function gainForTarget({ lufs, truePeak }) {
  if (!Number.isFinite(lufs) || lufs < -70) return null; // effectively silent — leave alone
  const wanted = TARGET_LUFS - lufs;
  const headroom = TARGET_TP - truePeak;
  return Math.min(wanted, headroom);
}

async function computeGains(plan, onLog) {
  const gains = new Map();
  const unique = [...new Set(plan.events.map(e => e.path))];
  for (const file of unique) {
    const measured = await measureLoudness(file);
    const gain = gainForTarget(measured);
    gains.set(file, gain ?? 0);
    if (onLog) {
      onLog(gain == null
        ? `  ${path.basename(file)}: silent, left untouched`
        : `  ${path.basename(file)}: ${measured.lufs.toFixed(1)} LUFS -> gain ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`);
    }
  }
  return gains;
}

// ---------------------------------------------------------------------------
// Render: every event becomes its own -i input (duplicates are fine and bounded
// by the repeat cap). Each chain gets gain -> resample -> equal-power edge fades
// -> sample-exact adelay to its start time, then everything is summed with amix.
// Silence falls out wherever nothing is playing. Filter graph goes via a script
// file to dodge Windows command-line length limits.

export async function renderPlan(plan, outPath, { sampleRate = 44100, normalize = false, onLog } = {}) {
  const total = plan.totalDur;
  const gains = normalize ? await computeGains(plan, onLog) : null;

  const inputs = [];
  const filterLines = [];
  const labels = [];

  plan.events.forEach((ev, k) => {
    const idx = inputs.length;
    inputs.push(ev.path);
    const chain = [];
    const gain = gains?.get(ev.path) ?? 0;
    if (Math.abs(gain) > 0.05) chain.push(`volume=${gain.toFixed(2)}dB`);
    chain.push(`aresample=${sampleRate}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo');
    if (ev.fadeIn > 0.002) chain.push(`afade=t=in:st=0:d=${ev.fadeIn.toFixed(4)}:curve=qsin`);
    if (ev.fadeOut > 0.002) {
      chain.push(`afade=t=out:st=${(ev.dur - ev.fadeOut).toFixed(4)}:d=${ev.fadeOut.toFixed(4)}:curve=qsin`);
    }
    const startSamples = Math.round(ev.start * sampleRate);
    if (startSamples > 0) chain.push(`adelay=${startSamples}S:all=1`);
    filterLines.push(`[${idx}:a]${chain.join(',')}[s${k}]`);
    labels.push(`[s${k}]`);
  });

  if (labels.length > 1) {
    filterLines.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[mx]`);
  } else {
    filterLines.push(`${labels[0]}anull[mx]`);
  }

  // overlapping crossfades sum — limit to be safe against correlated peaks;
  // pad+trim makes the final length sample-exact
  const hasOverlap = plan.events.some((e, i) =>
    i > 0 && e.start < plan.events[i - 1].start + plan.events[i - 1].dur - 0.002);
  const post = `${hasOverlap ? 'alimiter=limit=0.97,' : ''}apad=whole_dur=${total},atrim=end=${total}`;
  filterLines.push(`[mx]${post}[out]`);

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
