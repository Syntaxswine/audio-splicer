// Loopable-crop analysis: find the (start, end) crop of a track that loops most
// seamlessly while staying as long as possible.
//
// The core idea: when a looped player jumps from `end` back to `start`, the
// listener compares what they hear next (the audio AFTER `start`) with what
// would naturally have come next (the audio AFTER `end`). So a good loop cut is
// a pair of points whose following ~1.5s of audio has the same spectral texture
// and loudness. We score every candidate pair on that, keep the LONGEST crop
// within a small tolerance of the best score (loopability first, length as the
// tiebreak), then refine to sample level: waveform cross-correlation alignment
// plus upward zero-crossing snap, so the seam doesn't click.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { encoderArgsFor } from './engine.mjs';

const run = promisify(execFile);

export const ANALYSIS_RATE = 22050;
const FRAME = 2048;            // ~93ms analysis frames
const HOP = 1024;              // ~46ms hop
const BANDS = 24;              // log-spaced spectral bands 50Hz..8kHz
const FMIN = 50, FMAX = 8000;
const LEVEL_WEIGHT = 0.35;     // how much loudness-match matters vs texture-match
const SLACK = 0.04;            // candidates within this of the best score count as "as loopable"

export async function decodeMono(file, rate = ANALYSIS_RATE) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-']);
    const chunks = [];
    let err = '';
    p.stdout.on('data', c => chunks.push(c));
    p.stderr.on('data', c => { err += c; });
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`could not decode ${path.basename(file)}: ${err.slice(-300)}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

// ---------------------------------------------------------------------------
// Minimal iterative radix-2 FFT (power spectrum only, real input).

function makeFft(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const r = rev[i];
      if (r > i) {
        let t = re[i]; re[i] = re[r]; re[r] = t;
        t = im[i]; im[i] = im[r]; im[r] = t;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Per-frame features: unit vectors of [spectral shape, weighted loudness term],
// so similarity between two moments is a single dot product.

export function featurize(x, rate = ANALYSIS_RATE) {
  const nFrames = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  if (nFrames < 8) throw new Error('Track is too short to analyze.');
  const fft = makeFft(FRAME);
  const hann = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));

  // geometric band edges in bin space
  const binHz = rate / FRAME;
  const edges = new Uint32Array(BANDS + 1);
  for (let b = 0; b <= BANDS; b++) {
    const hz = FMIN * Math.pow(FMAX / FMIN, b / BANDS);
    edges[b] = Math.max(1, Math.min(FRAME / 2, Math.round(hz / binHz)));
  }

  const D = BANDS + 1;
  const feats = new Float64Array(nFrames * D);
  const energies = new Float64Array(nFrames);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const bands = new Float64Array(BANDS);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let total = 0;
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[off + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    bands.fill(0);
    for (let b = 0; b < BANDS; b++) {
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) {
        bands[b] += re[k] * re[k] + im[k] * im[k];
      }
      total += bands[b];
    }
    energies[f] = Math.log10(total + 1e-12);
    let mean = 0;
    for (let b = 0; b < BANDS; b++) bands[b] = Math.log10(bands[b] + 1e-12);
    for (let b = 0; b < BANDS; b++) mean += bands[b];
    mean /= BANDS;
    let norm = 0;
    for (let b = 0; b < BANDS; b++) {
      const v = bands[b] - mean;
      feats[f * D + b] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-6) for (let b = 0; b < BANDS; b++) feats[f * D + b] /= norm;
    else for (let b = 0; b < BANDS; b++) feats[f * D + b] = 0; // silence: shape carries nothing
  }

  // loudness term: z-scored against this track, weighted, then renormalize
  let eMean = 0, eStd = 0;
  for (let f = 0; f < nFrames; f++) eMean += energies[f];
  eMean /= nFrames;
  for (let f = 0; f < nFrames; f++) eStd += (energies[f] - eMean) ** 2;
  eStd = Math.sqrt(eStd / nFrames) || 1;
  for (let f = 0; f < nFrames; f++) {
    const z = ((energies[f] - eMean) / eStd) * LEVEL_WEIGHT;
    feats[f * D + BANDS] = z;
    let norm = 0;
    for (let d = 0; d < D; d++) norm += feats[f * D + d] ** 2;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let d = 0; d < D; d++) feats[f * D + d] /= norm;
  }

  return { feats, nFrames, D, hopSec: HOP / rate };
}

// ---------------------------------------------------------------------------

function pairScore(F, s, e, W, stride) {
  const { feats, D } = F;
  let sum = 0, count = 0;
  for (let k = 0; k < W; k += stride) {
    const a = (s + k) * D, b = (e + k) * D;
    let dot = 0;
    for (let d = 0; d < D; d++) dot += feats[a + d] * feats[b + d];
    sum += dot;
    count++;
  }
  return sum / count;
}

// Among scored pairs: best score wins on quality; everything within SLACK of it
// competes on length. "Most loopable, as long as possible."
function pickLongest(cands) {
  let best = -2;
  for (const c of cands) if (c.score > best) best = c.score;
  let pick = null;
  for (const c of cands) {
    if (c.score >= best - SLACK && (!pick || c.len > pick.len)) pick = c;
  }
  return pick;
}

export function findLoopFrames(F, {
  windowSec = 1.5,
  maxTrimStartSec,
  maxTrimEndSec,
  minLoopSec = 5,
} = {}) {
  const { nFrames, hopSec } = F;
  const W = Math.max(4, Math.round(windowSec / hopSec));
  const sMax = Math.min(nFrames - W - 1, Math.round(maxTrimStartSec / hopSec));
  const eHigh = nFrames - W;
  const eLow = Math.max(0, eHigh - Math.round(maxTrimEndSec / hopSec));
  const minLen = Math.round(minLoopSec / hopSec);

  // coarse grid (~0.23s), full window sampled at stride 4
  const C = Math.max(1, Math.round(0.23 / hopSec));
  const coarse = [];
  for (let s = 0; s <= sMax; s += C) {
    for (let e = eLow; e <= eHigh; e += C) {
      if (e - s < minLen) continue;
      coarse.push({ s, e, len: e - s, score: pairScore(F, s, e, W, 4) });
    }
  }
  if (coarse.length === 0) {
    throw new Error('Track is too short for these trim limits — nothing satisfies the minimum loop length.');
  }
  const rough = pickLongest(coarse);

  // local refinement around the coarse winner at full hop resolution
  const fine = [];
  for (let s = Math.max(0, rough.s - C); s <= Math.min(sMax, rough.s + C); s++) {
    for (let e = Math.max(eLow, rough.e - C); e <= Math.min(eHigh, rough.e + C); e++) {
      if (e - s < minLen) continue;
      fine.push({ s, e, len: e - s, score: pairScore(F, s, e, W, 1) });
    }
  }
  const pick = pickLongest(fine);

  // seam quality in context: how does this cut pair rank against every other
  // candidate cut pair? (adjacent-frame baselines are useless here — analysis
  // frames overlap 50%, so they're unfairly "glassy" on clean material)
  let worse = 0;
  for (const c of coarse) if (c.score <= pick.score) worse++;
  return { ...pick, percentile: worse / coarse.length };
}

// Sample-level refinement: align the end-cut waveform to the start-cut by
// cross-correlation, then snap both cuts to upward zero crossings.
export function refineToSamples(x, sFrame, eFrame, rate = ANALYSIS_RATE) {
  const W = 4096, SEARCH = 1536;
  let s0 = sFrame * HOP;
  let e0 = eFrame * HOP;

  let bestDelta = 0, bestCorr = -Infinity;
  const eMaxBase = Math.min(e0, x.length - W - SEARCH - 1);
  for (let delta = -SEARCH; delta <= SEARCH; delta += 8) {
    const eAt = eMaxBase + delta;
    if (eAt < 0) continue;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < W; i += 2) {
      const a = x[s0 + i], b = x[eAt + i];
      dot += a * b; na += a * a; nb += b * b;
    }
    const corr = dot / (Math.sqrt(na * nb) + 1e-12);
    if (corr > bestCorr) { bestCorr = corr; bestDelta = delta; }
  }
  let e1 = eMaxBase + bestDelta;

  const snapUp = idx => {
    for (let r = 1; r < 600; r++) {
      for (const i of [idx - r, idx + r]) {
        if (i > 0 && i < x.length && x[i - 1] < 0 && x[i] >= 0) return i;
      }
    }
    return idx;
  };
  const s1 = snapUp(s0);
  e1 = snapUp(e1 + (s1 - s0));
  if (e1 <= s1) throw new Error('Refinement collapsed the loop — track may be unsuitable.');
  return { startSec: s1 / rate, endSec: e1 / rate };
}

// ---------------------------------------------------------------------------

export async function findLoopCrop(file, {
  windowSec = 1.5,
  maxTrim = null,        // seconds, or '30%' style string; per side
  minLoopSec = null,
  onLog = null,
} = {}) {
  const log = m => { if (onLog) onLog(m); };
  log('decoding...');
  const x = await decodeMono(file);
  const durSec = x.length / ANALYSIS_RATE;

  let trim;
  if (typeof maxTrim === 'string' && maxTrim.trim().endsWith('%')) {
    trim = (parseFloat(maxTrim) / 100) * durSec;
  } else if (maxTrim != null && maxTrim !== '') {
    trim = parseFloat(maxTrim);
  } else {
    trim = Math.min(0.3 * durSec, 90);
  }
  if (!(trim > 0)) throw new Error('max trim must be a positive number of seconds or a percentage');
  const minLoop = minLoopSec ?? Math.min(10, 0.4 * durSec);

  log(`analyzing ${durSec.toFixed(1)}s (may trim up to ${trim.toFixed(1)}s from each end)...`);
  const F = featurize(x);
  const frames = findLoopFrames(F, {
    windowSec,
    maxTrimStartSec: trim,
    maxTrimEndSec: trim,
    minLoopSec: minLoop,
  });
  log('refining cut points to sample level...');
  const { startSec, endSec } = refineToSamples(x, frames.s, frames.e);

  return {
    file,
    durSec,
    startSec,
    endSec,
    keptSec: endSec - startSec,
    score: frames.score,          // 0..1 texture match between the two cut contexts
    percentile: frames.percentile, // fraction of candidate cut pairs this one beats or ties
  };
}

// Crop render: cut [start, end), with a tiny safety fade (~3ms) at both ends so
// the seam can't click on any channel layout.
export async function renderLoopCrop(file, outPath, startSec, endSec, { fadeMs = 3 } = {}) {
  const fade = fadeMs / 1000;
  const dur = endSec - startSec;
  let af = `atrim=start=${startSec.toFixed(6)}:end=${endSec.toFixed(6)},asetpts=PTS-STARTPTS`;
  if (fade > 0 && dur > fade * 4) {
    af += `,afade=t=in:st=0:d=${fade},afade=t=out:st=${(dur - fade).toFixed(6)}:d=${fade}`;
  }
  try {
    await run(ffmpegPath, [
      '-hide_banner', '-y', '-i', file, '-af', af, ...encoderArgsFor(outPath), outPath,
    ], { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const tail = String(err.stderr || err.message).split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed:\n${tail}`);
  }
}
