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
import ffprobeStatic from 'ffprobe-static';
import { encoderArgsFor } from './engine.mjs';

const run = promisify(execFile);
const ffprobePath = ffprobeStatic.path;

export const ANALYSIS_RATE = 22050;
const FRAME = 2048;            // ~93ms analysis frames
const HOP = 1024;              // ~46ms hop
const BANDS = 24;              // log-spaced spectral bands 50Hz..8kHz
const FMIN = 50, FMAX = 8000;
const CHROMA = 12;             // pitch classes — hears harmony, not just texture
const CHROMA_WEIGHT = 0.8;
const CHROMA_REF_NORM = 2.0;   // soft normalization: tonal frames reach full weight,
                               // noisy/atonal frames contribute little instead of
                               // being amplified to unit length
const LEVEL_WEIGHT = 0.35;     // how much loudness-match matters vs texture-match
const SLACK = 0.04;            // fallback tolerance when nothing clears the floor
const QUALITY_FLOOR = 0.85;    // absolute "audibly seamless" bar — above it, LENGTH
                               // decides. Without this, self-similarity decaying with
                               // distance makes nearby pairs always outscore distant
                               // ones and the search slams into the trim limits.

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
// Beat detection: onset-strength envelope (half-wave-rectified spectral flux at
// ~23ms resolution) -> tempo by autocorrelation with a log-normal prior near
// 120 BPM (resolves octave ambiguity) -> beat phase by comb alignment.
// Used to snap loop cuts onto the beat grid for rhythmic material.

const ONSET_FRAME = 1024;
const ONSET_HOP = 512;

function onsetEnvelope(x, rate) {
  const n = Math.max(0, Math.floor((x.length - ONSET_FRAME) / ONSET_HOP) + 1);
  if (n < 16) return null;
  const fft = makeFft(ONSET_FRAME);
  const hann = new Float64Array(ONSET_FRAME);
  for (let i = 0; i < ONSET_FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (ONSET_FRAME - 1));
  const nBins = ONSET_FRAME / 2;
  const re = new Float64Array(ONSET_FRAME), im = new Float64Array(ONSET_FRAME);
  const prev = new Float64Array(nBins);
  const env = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const off = f * ONSET_HOP;
    for (let i = 0; i < ONSET_FRAME; i++) { re[i] = x[off + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < nBins; k++) {
      const mag = Math.log1p(1000 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = mag - prev[k];
      if (d > 0) flux += d;
      prev[k] = mag;
    }
    env[f] = f === 0 ? 0 : flux;
  }
  return { env, hopSec: ONSET_HOP / rate };
}

export function detectBeats(x, rate = ANALYSIS_RATE) {
  const none = { bpm: null, period: null, confidence: 0, beats: [] };
  const o = onsetEnvelope(x, rate);
  if (!o) return none;
  const { env, hopSec } = o;
  const n = env.length;

  // mean-removed autocorrelation over 30..250 BPM lags
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) z[i] = env[i] - mean;
  let ac0 = 0;
  for (let i = 0; i < n; i++) ac0 += z[i] * z[i];
  if (ac0 < 1e-12) return none;

  const minLag = Math.max(2, Math.round(0.24 / hopSec));   // 250 BPM
  const maxLag = Math.min(n - 2, Math.round(2.0 / hopSec)); // 30 BPM
  if (maxLag <= minLag + 2) return none;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += z[i] * z[i + lag];
    ac[lag] = s / ac0;
  }
  let bestLag = minLag, bestVal = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const prior = Math.exp(-0.5 * ((Math.log2((lag * hopSec) / 0.5)) / 0.9) ** 2);
    const v = ac[lag] * prior;
    if (v > bestVal) { bestVal = v; bestLag = lag; }
  }
  // parabolic peak interpolation for sub-frame tempo precision
  const y1 = ac[bestLag - 1], y2 = ac[bestLag], y3 = ac[bestLag + 1];
  const denom = y1 - 2 * y2 + y3;
  const shift = denom !== 0 ? Math.max(-1, Math.min(1, 0.5 * (y1 - y3) / denom)) : 0;
  const lagF = bestLag + shift;
  const period = lagF * hopSec;
  const confidence = Math.max(0, Math.min(1, ac[bestLag]));

  // beat phase: comb sum of the raw envelope along the detected period
  const phases = Math.max(1, Math.floor(lagF));
  let bestPhase = 0, bestSum = -Infinity;
  for (let p = 0; p < phases; p++) {
    let s = 0;
    for (let j = 0; ; j++) {
      const idx = Math.round(p + j * lagF);
      if (idx >= n) break;
      s += env[idx];
    }
    if (s > bestSum) { bestSum = s; bestPhase = p; }
  }
  const beats = [];
  const dur = x.length / rate;
  for (let k = 0; ; k++) {
    const t = (bestPhase + k * lagF) * hopSec;
    if (t >= dur) break;
    beats.push(t);
  }
  return { bpm: 60 / period, period, confidence, beats };
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
  // bin -> pitch class (80Hz..5kHz; below is rumble, above is cymbal smear)
  const pcOfBin = new Int8Array(FRAME / 2);
  for (let k = 1; k < FRAME / 2; k++) {
    const hz = k * binHz;
    pcOfBin[k] = hz >= 80 && hz <= 5000
      ? ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12
      : -1;
  }

  const D = BANDS + CHROMA + 1;
  const feats = new Float64Array(nFrames * D);
  const energies = new Float64Array(nFrames);
  const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
  const bands = new Float64Array(BANDS);
  const chroma = new Float64Array(CHROMA);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let total = 0;
    for (let i = 0; i < FRAME; i++) {
      re[i] = x[off + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    bands.fill(0);
    chroma.fill(0);
    for (let b = 0; b < BANDS; b++) {
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        bands[b] += p;
        if (pcOfBin[k] >= 0) chroma[pcOfBin[k]] += p;
      }
      total += bands[b];
    }
    energies[f] = Math.log10(total + 1e-12);

    // spectral shape: mean-removed log bands, hard-normalized to unit
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

    // chroma: mean-removed log pitch classes, SOFT-normalized so atonal frames
    // (noise, ambience) contribute near-zero rather than amplified noise
    let cMean = 0;
    for (let c = 0; c < CHROMA; c++) { chroma[c] = Math.log10(chroma[c] + 1e-12); cMean += chroma[c]; }
    cMean /= CHROMA;
    let cNorm = 0;
    for (let c = 0; c < CHROMA; c++) {
      const v = chroma[c] - cMean;
      feats[f * D + BANDS + c] = v;
      cNorm += v * v;
    }
    cNorm = Math.max(Math.sqrt(cNorm), CHROMA_REF_NORM);
    for (let c = 0; c < CHROMA; c++) feats[f * D + BANDS + c] = (feats[f * D + BANDS + c] / cNorm) * CHROMA_WEIGHT;
  }

  // loudness term: z-scored against this track, weighted, then renormalize
  let eMean = 0, eStd = 0;
  for (let f = 0; f < nFrames; f++) eMean += energies[f];
  eMean /= nFrames;
  for (let f = 0; f < nFrames; f++) eStd += (energies[f] - eMean) ** 2;
  eStd = Math.sqrt(eStd / nFrames) || 1;
  for (let f = 0; f < nFrames; f++) {
    const z = ((energies[f] - eMean) / eStd) * LEVEL_WEIGHT;
    feats[f * D + BANDS + CHROMA] = z;
    let norm = 0;
    for (let d = 0; d < D; d++) norm += feats[f * D + d] ** 2;
    norm = Math.sqrt(norm);
    if (norm > 1e-9) for (let d = 0; d < D; d++) feats[f * D + d] /= norm;
  }

  return { feats, nFrames, D, hopSec: HOP / rate };
}

// ---------------------------------------------------------------------------
// Section-break detection (novelty): a break is a moment where the audio
// BEFORE stops resembling the audio AFTER — compare the average feature vector
// of the past few seconds against the next few seconds at every frame. Peaks
// of that distance curve are the section boundaries; cutting there puts the
// loop seam where the track already changes character, so the wrap reads as
// "next section" instead of "a splice". Kernel shrinks near the track edges
// so early/late breaks are still found.

export function detectBreaks(F, { kernelSec = 3, minKernelSec = 0.8, minSepSec = 1.5, threshold = 1.2 } = {}) {
  const { feats, nFrames, D, hopSec } = F;
  const K = Math.max(8, Math.round(kernelSec / hopSec));
  const minK = Math.max(4, Math.round(minKernelSec / hopSec));
  // prefix sums per dim -> windowed centroids in O(1)
  const cum = new Float64Array((nFrames + 1) * D);
  for (let f = 0; f < nFrames; f++) {
    for (let d = 0; d < D; d++) cum[(f + 1) * D + d] = cum[f * D + d] + feats[f * D + d];
  }
  const centroidDot = (a0, a1, b0, b1) => {
    let dot = 0, na = 0, nb = 0;
    for (let d = 0; d < D; d++) {
      const va = (cum[a1 * D + d] - cum[a0 * D + d]) / (a1 - a0);
      const vb = (cum[b1 * D + d] - cum[b0 * D + d]) / (b1 - b0);
      dot += va * vb; na += va * va; nb += vb * vb;
    }
    return dot / (Math.sqrt(na * nb) + 1e-12);
  };
  const nov = new Float64Array(nFrames);
  for (let f = minK; f < nFrames - minK; f++) {
    const Kf = Math.min(K, f, nFrames - f);
    nov[f] = 1 - centroidDot(f - Kf, f, f, f + Kf);
  }
  // light smoothing, then peak-pick with a prominence bar that stays silent on
  // uniform material (absolute floor) and adapts on structured material
  const sm = new Float64Array(nFrames);
  for (let f = 1; f < nFrames - 1; f++) sm[f] = (nov[f - 1] + nov[f] + nov[f + 1]) / 3;
  let mean = 0, maxNov = 0;
  for (let f = 0; f < nFrames; f++) { mean += sm[f]; if (sm[f] > maxNov) maxNov = sm[f]; }
  mean /= nFrames;
  let std = 0;
  for (let f = 0; f < nFrames; f++) std += (sm[f] - mean) ** 2;
  std = Math.sqrt(std / nFrames);
  // two ways in: statistically prominent, OR clearly comparable to the track's
  // strongest break (edge breaks run on truncated kernels and score lower, and
  // a couple of very strong interior breaks would otherwise inflate the bar
  // past them). The absolute floor keeps uniform material silent.
  const bar = Math.max(0.12, Math.min(mean + threshold * std, 0.55 * maxNov));
  const sep = Math.max(1, Math.round(minSepSec / hopSec));
  const breaks = [];
  for (let f = minK; f < nFrames - minK; f++) {
    if (sm[f] < bar) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - sep); k <= Math.min(nFrames - 1, f + sep); k++) {
      if (sm[k] > sm[f]) { isPeak = false; break; }
    }
    if (isPeak) breaks.push({ t: f * hopSec, strength: sm[f] });
  }
  return breaks;
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

// Pair selection. Self-similarity decays with distance in real music, so "best
// score with a small tolerance" degenerates: nearby pairs always win and the
// search slams into the trim limits (cuts land exactly at max-trim). Instead:
// LONGEST pair above an absolute quality floor — above the bar, score
// differences aren't what the ear notices, length is. Only when nothing clears
// the floor do we fall back to best-score-with-slack, flagged so the report
// can be honest about it.
export function selectLoopPair(cands, { floor = QUALITY_FLOOR, slack = SLACK } = {}) {
  let bestScore = -2;
  for (const c of cands) if (c.score > bestScore) bestScore = c.score;
  const fellBack = bestScore < floor;
  const bar = fellBack ? bestScore - slack : floor;
  let pick = null;
  for (const c of cands) {
    if (c.score < bar) continue;
    if (!pick || c.len > pick.len || (c.len === pick.len && c.score > pick.score)) pick = c;
  }
  return { pick, fellBack };
}

export function findLoopFrames(F, {
  windowSec = 1.5,
  maxTrimStartSec,
  maxTrimEndSec,
  minLoopSec = 5,
  grid = null,        // beat-frame indices: when set, cuts may only land on these
  qualityFloor = QUALITY_FLOOR,
} = {}) {
  const { nFrames, hopSec } = F;
  const W = Math.max(4, Math.round(windowSec / hopSec));
  const sMax = Math.min(nFrames - W - 1, Math.round(maxTrimStartSec / hopSec));
  const eHigh = nFrames - W;
  const eLow = Math.max(0, eHigh - Math.round(maxTrimEndSec / hopSec));
  const minLen = Math.round(minLoopSec / hopSec);

  let coarse = [];
  let pick, fellBack;
  if (grid) {
    // beat-locked search: both cuts on the grid, so the loop is a whole number
    // of beats and both cut points share beat phase — no frame-level drift
    // refinement afterwards, that would pull the cuts off the grid
    const sCands = grid.filter(f => f >= 0 && f <= sMax);
    const eCands = grid.filter(f => f >= eLow && f <= eHigh);
    for (const s of sCands) {
      for (const e of eCands) {
        if (e - s < minLen) continue;
        coarse.push({ s, e, len: e - s, score: pairScore(F, s, e, W, 2) });
      }
    }
    if (coarse.length === 0) return null; // caller falls back to texture search
    ({ pick, fellBack } = selectLoopPair(coarse, { floor: qualityFloor }));
  } else {
    // coarse grid (~0.23s), full window sampled at stride 4
    const C = Math.max(1, Math.round(0.23 / hopSec));
    for (let s = 0; s <= sMax; s += C) {
      for (let e = eLow; e <= eHigh; e += C) {
        if (e - s < minLen) continue;
        coarse.push({ s, e, len: e - s, score: pairScore(F, s, e, W, 4) });
      }
    }
    if (coarse.length === 0) {
      throw new Error('Track is too short for these trim limits — nothing satisfies the minimum loop length.');
    }
    const rough = selectLoopPair(coarse, { floor: qualityFloor }).pick;

    // local refinement around the coarse winner at full hop resolution
    const fine = [];
    for (let s = Math.max(0, rough.s - C); s <= Math.min(sMax, rough.s + C); s++) {
      for (let e = Math.max(eLow, rough.e - C); e <= Math.min(eHigh, rough.e + C); e++) {
        if (e - s < minLen) continue;
        fine.push({ s, e, len: e - s, score: pairScore(F, s, e, W, 1) });
      }
    }
    ({ pick, fellBack } = selectLoopPair(fine, { floor: qualityFloor }));
  }

  // seam quality in context: how does this cut pair rank against every other
  // candidate cut pair? (adjacent-frame baselines are useless here — analysis
  // frames overlap 50%, so they're unfairly "glassy" on clean material)
  let worse = 0;
  for (const c of coarse) if (c.score <= pick.score) worse++;
  return { ...pick, fellBack, percentile: worse / coarse.length };
}

// Similarity map over the whole candidate space: every start cut (x) against
// every end cut (y), scored exactly like the search scores them. This is the
// picture of "where to slice" — bright regions are pairs whose following
// context sounds alike. Cells are quantized 1..255 (0 = pair shorter than the
// minimum loop, i.e. not a candidate at all).
export function buildSimilarityMap(F, {
  windowSec = 1.5,
  maxTrimStartSec,
  maxTrimEndSec,
  minLoopSec = 5,
  maxCells = 220,
} = {}) {
  const { nFrames, hopSec } = F;
  const W = Math.max(4, Math.round(windowSec / hopSec));
  const sMax = Math.min(nFrames - W - 1, Math.round(maxTrimStartSec / hopSec));
  const eHigh = nFrames - W;
  const eLow = Math.max(0, eHigh - Math.round(maxTrimEndSec / hopSec));
  const minLen = Math.round(minLoopSec / hopSec);
  const base = Math.max(1, Math.round(0.23 / hopSec));
  const stepS = Math.max(base, Math.ceil((sMax + 1) / maxCells));
  const stepE = Math.max(base, Math.ceil((eHigh - eLow + 1) / maxCells));
  const sIdx = [];
  for (let s = 0; s <= sMax; s += stepS) sIdx.push(s);
  const eIdx = [];
  for (let e = eLow; e <= eHigh; e += stepE) eIdx.push(e);
  const scores = new Uint8Array(sIdx.length * eIdx.length);
  for (let i = 0; i < sIdx.length; i++) {
    for (let j = 0; j < eIdx.length; j++) {
      if (eIdx[j] - sIdx[i] < minLen) continue; // 0 = not a candidate
      const v = pairScore(F, sIdx[i], eIdx[j], W, 4);
      scores[i * eIdx.length + j] = Math.max(1, Math.min(255, Math.round(v * 255)));
    }
  }
  return {
    sStartSec: 0, sStepSec: stepS * hopSec, nS: sIdx.length,
    eStartSec: eLow * hopSec, eStepSec: stepE * hopSec, nE: eIdx.length,
    minLoopSec,
    scores: Buffer.from(scores).toString('base64'),
  };
}

// Score one explicit (start, end) pair in seconds — used when the user picks a
// slice off the map by hand.
export function scorePairSeconds(F, sSec, eSec, windowSec = 1.5) {
  const W = Math.max(4, Math.round(windowSec / F.hopSec));
  const clamp = v => Math.max(0, Math.min(F.nFrames - W, Math.round(v / F.hopSec)));
  return pairScore(F, clamp(sSec), clamp(eSec), W, 1);
}

// Second-based wrapper for manual picks (e.g. clicked off the similarity map).
export function refineSeconds(x, sSec, eSec, rate = ANALYSIS_RATE) {
  return refineToSamples(x, Math.round((sSec * rate) / HOP), Math.round((eSec * rate) / HOP), rate);
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

const BEAT_CONFIDENCE_FLOOR = 0.35;

export async function findLoopCrop(file, {
  windowSec = 1.5,
  maxTrim = null,        // seconds, or '30%' style string; per side
  minLoopSec = null,
  useBeats = true,       // auto: snap cuts to the beat grid when a pulse is confident
  useBreaks = true,      // auto: prefer cuts AT section breaks when the track has them
  quality = null,        // 0..1 override of the seamlessness bar (default 0.85)
  withMap = false,       // also return the full start×end similarity map
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

  let beat = { bpm: null, period: null, confidence: 0, beats: [] };
  let grid = null;
  if (useBeats) {
    beat = detectBeats(x);
    if (beat.confidence >= BEAT_CONFIDENCE_FLOOR && beat.beats.length >= 4) {
      grid = [...new Set(beat.beats.map(t => Math.round(t / F.hopSec)))];
      log(`beat grid: ${beat.bpm.toFixed(1)} BPM (confidence ${(beat.confidence * 100).toFixed(0)}%) — snapping cuts to beats`);
    } else {
      log(`no confident beat pulse (confidence ${(beat.confidence * 100).toFixed(0)}%) — matching texture only`);
    }
  }

  const qualityFloor = quality != null && quality !== '' ? parseFloat(quality) : QUALITY_FLOOR;
  if (!(qualityFloor > 0 && qualityFloor <= 1)) throw new Error('quality must be between 0 and 1');

  // section breaks: the preferred place to cut — the seam lands where the
  // track already changes, so the wrap reads as "next section", not a splice
  let breaks = [];
  let breakFrames = [];
  if (useBreaks) {
    breaks = detectBreaks(F);
    if (breaks.length > 0) {
      breakFrames = [...new Set(breaks.map(b => {
        let f = Math.round(b.t / F.hopSec);
        if (grid) { // keep whole-beat loops: snap each break to the beat grid
          let best = grid[0];
          for (const g of grid) if (Math.abs(g - f) < Math.abs(best - f)) best = g;
          f = best;
        }
        return f;
      }))];
      log(`section breaks: ${breaks.map(b => b.t.toFixed(1) + 's').join(', ')}${grid ? ' (snapped to beats)' : ''}`);
    } else {
      log('no section breaks detected — the track reads as one continuous texture');
    }
  }

  const searchOpts = { windowSec, maxTrimStartSec: trim, maxTrimEndSec: trim, minLoopSec: minLoop, qualityFloor };
  let frames = null;
  let cutsOn = 'texture';
  if (breakFrames.length >= 2) {
    frames = findLoopFrames(F, { ...searchOpts, grid: breakFrames });
    if (frames) cutsOn = 'section breaks';
    else log('breaks don\'t leave a usable pair inside the trim limits — trying the next strategy');
  }
  if (!frames && grid) {
    frames = findLoopFrames(F, { ...searchOpts, grid });
    if (frames) cutsOn = 'beat grid';
    else log('beat grid too sparse inside the trim limits — falling back to texture matching');
  }
  if (!frames) {
    frames = findLoopFrames(F, searchOpts);
  }
  const beatAligned = !!grid && cutsOn !== 'texture';
  if (frames.fellBack) {
    log(`weak seam: no cut pair reaches ${(qualityFloor * 100).toFixed(0)}% match (best ${(frames.score * 100).toFixed(0)}%) — picking the best available`);
  }
  log('refining cut points to sample level...');
  const { startSec, endSec } = refineToSamples(x, frames.s, frames.e);

  let map = null;
  if (withMap) {
    log('building the similarity map...');
    map = buildSimilarityMap(F, {
      windowSec, maxTrimStartSec: trim, maxTrimEndSec: trim, minLoopSec: minLoop,
    });
  }

  return {
    map,
    file,
    durSec,
    startSec,
    endSec,
    keptSec: endSec - startSec,
    score: frames.score,          // 0..1 texture match between the two cut contexts
    percentile: frames.percentile, // fraction of candidate cut pairs this one beats or ties
    bpm: beat.bpm,
    beatConfidence: beat.confidence,
    beatAligned,
    beatsKept: beatAligned ? Math.round((endSec - startSec) / beat.period) : null,
    cutsOn,                       // 'section breaks' | 'beat grid' | 'texture'
    breaks: breaks.map(b => b.t), // for drawing on the similarity map
    weakSeam: !!frames.fellBack, // nothing cleared the quality bar; score is best-available
  };
}

// How much wrap-blend a seam needs: none when the cut pair clears the quality
// bar, and progressively more the weaker the match — a 1s blend covers a
// near-miss, a 65% seam needs ~3s to read as a transition instead of a jump.
// Capped at 4s and by how much trimmed lead-in actually exists.
export function autoSeamFade(score, startSec, floor = QUALITY_FLOOR) {
  if (score >= floor) return 0;
  const want = Math.min(4, 1 + (floor - score) * 10);
  return Math.max(0, Math.min(want, startSec - 0.1));
}

// Crop render: cut [start, end), with a tiny safety fade (~3ms) at both ends so
// the seam can't click on any channel layout.
//
// seamFadeSec > 0 enables a WRAP CROSSFADE for tracks whose cut points don't
// match strongly: the material just BEFORE the start cut (which we trimmed off)
// is exactly what naturally leads INTO the loop's first sample, so it gets
// blended under the loop's final seamFadeSec. On wrap, the listener hears the
// track's own real transition — the file's last sample is content[start−ε] and
// its first is content[start], sample-continuous by construction. No micro
// fades in this mode, the continuity IS the click guard.
export async function renderLoopCrop(file, outPath, startSec, endSec, { fadeMs = 3, seamFadeSec = 0 } = {}) {
  const dur = endSec - startSec;
  // clamp the blend to the lead-in that exists and to a third of the loop
  const X = Math.min(Math.max(0, seamFadeSec), Math.max(0, startSec - 0.01), dur / 3);
  let args;
  if (X > 0.05) {
    // sample-exact delay (ms rounding would shift the wrap by up to 0.5ms —
    // an audible phase error on tonal content)
    const { stdout: srOut } = await run(ffprobePath, [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_rate', '-of', 'default=nw=1:nk=1', file,
    ]);
    const sr = parseInt(srOut.trim(), 10) || 44100;
    const fc =
      `[0:a]asplit[a][b];` +
      `[a]atrim=start=${startSec.toFixed(6)}:end=${endSec.toFixed(6)},asetpts=PTS-STARTPTS,` +
      `afade=t=out:st=${(dur - X).toFixed(6)}:d=${X.toFixed(6)}:curve=qsin[main];` +
      `[b]atrim=start=${(startSec - X).toFixed(6)}:end=${startSec.toFixed(6)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${X.toFixed(6)}:curve=qsin,adelay=${Math.round((dur - X) * sr)}S:all=1[pre];` +
      `[main][pre]amix=inputs=2:duration=longest:normalize=0,atrim=end=${dur.toFixed(6)}[out]`;
    args = ['-hide_banner', '-y', '-i', file, '-filter_complex', fc, '-map', '[out]',
      ...encoderArgsFor(outPath), outPath];
  } else {
    const fade = fadeMs / 1000;
    let af = `atrim=start=${startSec.toFixed(6)}:end=${endSec.toFixed(6)},asetpts=PTS-STARTPTS`;
    if (fade > 0 && dur > fade * 4) {
      af += `,afade=t=in:st=0:d=${fade},afade=t=out:st=${(dur - fade).toFixed(6)}:d=${fade}`;
    }
    args = ['-hide_banner', '-y', '-i', file, '-af', af, ...encoderArgsFor(outPath), outPath];
  }
  try {
    await run(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const tail = String(err.stderr || err.message).split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed:\n${tail}`);
  }
  return { seamFadeSec: X > 0.05 ? X : 0 }; // the blend actually applied
}
