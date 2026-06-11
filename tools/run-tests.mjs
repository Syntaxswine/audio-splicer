// Self-test: generates tone fixtures (mixed formats), exercises both modes
// end-to-end through the CLI, and verifies the spec rules:
//   1. concat output duration == sum of inputs
//   2. random output duration == target, exactly
//   3. repeat cap == floor(target/totalSource)+1 and never exceeded
//   4. inner gaps <= max-gap; long whitespace only at head/tail
//   5. two unseeded runs -> different sequences (novelty)
//   6. same --seed twice -> identical sequence (reproducibility)
//   7. crossfade: concat shortens by (n-1)*X; random joints stay in [-X, maxGap]
//   8. normalize: mismatched-loudness inputs come out at ~-16 LUFS
// Run: npm test

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { probeDuration, buildRandomPlan, buildConcatPlan, makeRng, measureLoudness } from '../lib/engine.mjs';
import { findLoopCrop, renderLoopCrop, detectBeats, detectBreaks, decodeMono, featurize, selectLoopPair, autoSeamFade } from '../lib/loop.mjs';

const run = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fix = path.join(root, 'test-fixtures');
const out = path.join(fix, 'out');
const cli = path.join(root, 'bin', 'splice.mjs');

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

async function tone(freq, dur, file, volume = null) {
  await run(ffmpegPath, [
    '-hide_banner', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${freq}:duration=${dur}`,
    ...(volume ? ['-af', `volume=${volume}`] : []),
    ...(file.endsWith('.ogg') ? ['-c:a', 'libvorbis'] :
        file.endsWith('.mp3') ? ['-c:a', 'libmp3lame'] : []),
    path.join(fix, file),
  ]);
}

async function splice(args) {
  const { stdout } = await run('node', [cli, ...args], { cwd: root });
  return stdout;
}

await rm(fix, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await mkdir(path.join(fix, 'loud'), { recursive: true });

// Mixed-format pool: 3+5+7+4 = 19s of source
await tone(220, 3, 'a220.wav');
await tone(330, 5, 'b330.ogg');
await tone(440, 7, 'c440.mp3');
await tone(550, 4, 'd550.wav');
// Deliberately mismatched loudness pool for --normalize
await tone(300, 4, 'loud/quiet.wav', 0.04);
await tone(400, 4, 'loud/loud.wav', 0.8);

// --- 1. concat: folder input, ogg output ---
const catOut = path.join(out, 'cat.ogg');
await splice(['concat', fix, '-o', catOut]);
const catDur = await probeDuration(catOut);
check('concat duration == 19s', Math.abs(catDur - 19) < 0.15, `got ${catDur.toFixed(2)}s`);

// concat with gaps: 19 + 3*2 = 25s
const catGapOut = path.join(out, 'cat-gap.mp3');
await splice(['concat', fix, '-o', catGapOut, '--gap', '2']);
const catGapDur = await probeDuration(catGapOut);
check('concat --gap 2 duration == 25s', Math.abs(catGapDur - 25) < 0.15, `got ${catGapDur.toFixed(2)}s`);

// --- 7a. concat with crossfade: 19 - 3*1 = 16s ---
const catXfOut = path.join(out, 'cat-xf.ogg');
await splice(['concat', fix, '-o', catXfOut, '--crossfade', '1']);
const catXfDur = await probeDuration(catXfOut);
check('concat --crossfade 1 duration == 16s', Math.abs(catXfDur - 16) < 0.15, `got ${catXfDur.toFixed(2)}s`);

// --- 2-4. random plan math (engine-level, 500 seeded plans) ---
const files = [
  { path: 'a.wav', dur: 3 }, { path: 'b.ogg', dur: 5 },
  { path: 'c.mp3', dur: 7 }, { path: 'd.wav', dur: 4 },
];
const target = 60; // cap = floor(60/19)+1 = 4

function auditPlans(crossfade) {
  let capOk = true, jointOk = true, boundsOk = true;
  for (let s = 0; s < 500; s++) {
    const plan = buildRandomPlan(files, target, { maxGap: 5, crossfade, rng: makeRng(`${crossfade}-${s}`) });
    if (plan.cap !== 4) capOk = false;
    if (Object.values(plan.counts).some(c => c > plan.cap)) capOk = false;
    const evs = plan.events;
    for (let i = 1; i < evs.length; i++) {
      const joint = evs[i].start - (evs[i - 1].start + evs[i - 1].dur);
      if (joint > 5.001 || joint < -crossfade - 0.001) jointOk = false;
    }
    const lastEnd = evs[evs.length - 1].start + evs[evs.length - 1].dur;
    if (evs[0].start < -1e-9 || lastEnd > target + 1e-6) boundsOk = false;
  }
  return { capOk, jointOk, boundsOk };
}

const plain = auditPlans(0);
check('repeat cap == floor(60/19)+1 == 4, never exceeded (500 plans)', plain.capOk);
check('inner joints in [0, 5s], long whitespace only head/tail (500 plans)', plain.jointOk);
check('all clips inside [0, target] (500 plans)', plain.boundsOk);

// --- 7b. random with crossfade: joints in [-1.5, 5], cap still held ---
const xf = auditPlans(1.5);
check('crossfade 1.5: joints in [-1.5s, 5s] (500 plans)', xf.jointOk);
check('crossfade 1.5: cap + bounds still hold (500 plans)', xf.capOk && xf.boundsOk);

// crossfade too long for shortest file -> clear error
let xfThrew = false;
try { buildConcatPlan(files, { crossfade: 2 }); } catch { xfThrew = true; }
check('crossfade > shortest/2 -> clear error', xfThrew);

// --- 2. random render: exact output length, wav output from mixed inputs ---
const rndOut = path.join(out, 'rnd.wav');
const log1 = await splice(['random', fix, '-o', rndOut, '-l', '60']);
const rndDur = await probeDuration(rndOut);
check('random render duration == 60s exactly', Math.abs(rndDur - 60) < 0.05, `got ${rndDur.toFixed(3)}s`);
check('CLI reports cap of 4', /= 4 use\(s\)/.test(log1), log1.match(/repeat cap.*/)?.[0] ?? 'no cap line');

// random + crossfade renders to exact length too
const rndXfOut = path.join(out, 'rnd-xf.ogg');
await splice(['random', fix, '-o', rndXfOut, '-l', '45', '--crossfade', '1', '--no-history']);
const rndXfDur = await probeDuration(rndXfOut);
check('random --crossfade render duration == 45s', Math.abs(rndXfDur - 45) < 0.05, `got ${rndXfDur.toFixed(3)}s`);

// --- 5. novelty: second run differs from first, history grows ---
await splice(['random', fix, '-o', path.join(out, 'rnd2.wav'), '-l', '60']);
const history = JSON.parse(await readFile(path.join(out, '.splice-history.json'), 'utf8'));
check('history file has 2 entries', history.length === 2, `got ${history.length}`);
check('unseeded runs produce different sequences',
  JSON.stringify(history[0].sequence) !== JSON.stringify(history[1].sequence),
  history[0].sequence.join(','));

// --- 6. reproducibility: same seed -> same plan ---
const seeded1 = buildRandomPlan(files, target, { maxGap: 5, rng: makeRng('boss') });
const seeded2 = buildRandomPlan(files, target, { maxGap: 5, rng: makeRng('boss') });
check('same seed -> identical plan',
  JSON.stringify(seeded1.events) === JSON.stringify(seeded2.events));

// --- 8. normalize: quiet (vol 0.04) + loud (vol 0.8) -> output near -16 LUFS ---
const normOut = path.join(out, 'norm.wav');
const normLog = await splice(['concat', path.join(fix, 'loud'), '-o', normOut, '--normalize']);
const normMeasured = await measureLoudness(normOut);
check('normalize: output integrated loudness ~= -16 LUFS',
  Math.abs(normMeasured.lufs - -16) < 2.5, `got ${normMeasured.lufs.toFixed(1)} LUFS`);
check('normalize: per-file gains reported', /gain [+-]/.test(normLog));
// same pool without normalize stays lopsided (sanity that the flag does something)
const rawOut = path.join(out, 'raw.wav');
await splice(['concat', path.join(fix, 'loud'), '-o', rawOut]);
const rawMeasured = await measureLoudness(rawOut);
check('without --normalize the same pool is NOT at -16',
  Math.abs(rawMeasured.lufs - -16) > 3, `got ${rawMeasured.lufs.toFixed(1)} LUFS`);

// --- output pollution: a mix saved into the input folder must not be re-ingested ---
await splice(['concat', fix, '-o', path.join(fix, 'pol.ogg')]);          // 19s mix lands IN the pool
await splice(['concat', fix, '-o', path.join(fix, 'pol-2.ogg')]);        // would be 38s if pol.ogg got ingested
const polDur = await probeDuration(path.join(fix, 'pol-2.ogg'));
check('own outputs in the input folder are excluded from the next mix',
  Math.abs(polDur - 19) < 0.15, `got ${polDur.toFixed(2)}s (38 would mean pollution)`);
await rm(path.join(fix, 'pol.ogg'), { force: true });
await rm(path.join(fix, 'pol-2.ogg'), { force: true });

// --- 9. loop crop: synthetic track with one known-correct loop ---
// P(1900Hz,1s) M(600Hz,3s) Q(250Hz,4s) M(600Hz,3s) R(3400Hz,1s) = 12s.
// The only seamless cut pair: start of first M -> same offset into second M.
// Longest such loop: s ~= 1.0, e ~= 9.5 (limited by the 1.5s context before R).
await mkdir(path.join(fix, 'loop'), { recursive: true });
await tone(1900, 1, 'loop/p.wav');
await tone(600, 3, 'loop/m.wav');
await tone(250, 4, 'loop/q.wav');
await tone(3400, 1, 'loop/r.wav');
const loopSrc = path.join(fix, 'loop', 'loopsrc.wav');
await splice(['concat',
  path.join(fix, 'loop', 'p.wav'), path.join(fix, 'loop', 'm.wav'),
  path.join(fix, 'loop', 'q.wav'), path.join(fix, 'loop', 'm.wav'),
  path.join(fix, 'loop', 'r.wav'), '-o', loopSrc]);

const lc = await findLoopCrop(loopSrc);
// section breaks take priority: the right answer is the WHOLE-SECTION loop
// (break at M1 start -> break at M2 start, M+Q = 7.0s), not the max-length
// texture stretch
check('loop: cuts placed on section breaks', lc.cutsOn === 'section breaks', lc.cutsOn);
check('loop: start cut lands on the P->M break (~1.0s)',
  lc.startSec > 0.6 && lc.startSec < 1.4, `got ${lc.startSec.toFixed(2)}s`);
check('loop: end cut lands on the Q->M break (~8.0s)',
  lc.endSec > 7.6 && lc.endSec < 8.4, `got ${lc.endSec.toFixed(2)}s`);
check('loop: keeps whole sections (~7.0s)',
  lc.keptSec > 6.5 && lc.keptSec < 7.5, `got ${lc.keptSec.toFixed(2)}s`);
check('loop: seam match clears the quality floor on identical motifs',
  lc.score >= 0.85 && !lc.weakSeam, `got ${lc.score.toFixed(3)} weak=${lc.weakSeam}`);

// the break detector itself: P|M|Q|M|R has breaks at 1, 4, 8 (and 11)
const lcF = featurize(await decodeMono(loopSrc));
const lcBreaks = detectBreaks(lcF).map(b => b.t);
const near = (t, target) => Math.abs(t - target) < 0.5;
check('breaks: finds the section boundaries of P|M|Q|M|R',
  lcBreaks.some(t => near(t, 1)) && lcBreaks.some(t => near(t, 4)) && lcBreaks.some(t => near(t, 8)),
  `got ${lcBreaks.map(t => t.toFixed(1)).join(', ')}`);
check('breaks: --no-breaks falls back to texture search',
  (await findLoopCrop(loopSrc, { useBreaks: false })).cutsOn === 'texture');
// note: ~20% of candidate pairs here tie the winner by design (any M1 offset
// pairs perfectly with the same M2 offset), so the bar is 0.6, not 0.9
check('loop: chosen cut pair beats most alternative cut pairs',
  lc.percentile > 0.6, `got ${(lc.percentile * 100).toFixed(0)}%`);

const lc2 = await findLoopCrop(loopSrc);
check('loop: analysis is deterministic',
  lc.startSec === lc2.startSec && lc.endSec === lc2.endSec);

// end-to-end through the CLI: renders the crop at the found cuts
const loopLog = await splice(['loop', loopSrc, '-o', path.join(out, 'looped.ogg')]);
const loopDur = await probeDuration(path.join(out, 'looped.ogg'));
check('loop: CLI renders crop matching the analysis',
  Math.abs(loopDur - lc.keptSec) < 0.1, `got ${loopDur.toFixed(2)}s vs ${lc.keptSec.toFixed(2)}s`);
check('loop: CLI reports the seam quality', /texture match/.test(loopLog));

// --- 9a2. seam crossfade: the wrap must play the track's own transition ---
// render with the trimmed lead-in blended under the tail; the file's last
// samples must equal the source content just before the start cut, so
// end -> start is sample-continuous on loop
const sfOut = path.join(out, 'seamfade.wav');
await renderLoopCrop(loopSrc, sfOut, lc.startSec, lc.endSec, { seamFadeSec: 0.5 });
const sfDur = await probeDuration(sfOut);
check('seam fade: rendered length unchanged', Math.abs(sfDur - lc.keptSec) < 0.05,
  `got ${sfDur.toFixed(3)} vs ${lc.keptSec.toFixed(3)}`);
const sfPcm = await decodeMono(sfOut);
const srcPcm = await decodeMono(loopSrc);
const s0 = Math.round(lc.startSec * 22050);
let maxDiff = 0;
for (let i = 40; i <= 160; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(sfPcm[sfPcm.length - i] - srcPcm[s0 - i]));
}
check('seam fade: file tail == natural lead-in to the file start (sample-continuous wrap)',
  maxDiff < 0.1, `max sample diff ${maxDiff.toFixed(3)}`);
// and the tail must NOT be faded to silence (the blend replaces the fade-out)
let tailRms = 0;
for (let i = 1; i <= 2205; i++) tailRms += sfPcm[sfPcm.length - i] ** 2;
tailRms = Math.sqrt(tailRms / 2205);
check('seam fade: tail keeps full level (no fade-to-silence at the seam)',
  tailRms > 0.05, `tail RMS ${tailRms.toFixed(3)}`);

// --- 9a3. similarity map: the graph of every start cut × every end cut ---
const mapRun = await findLoopCrop(loopSrc, { withMap: true });
const lMap = mapRun.map;
const mapBytes = Buffer.from(lMap.scores, 'base64');
check('map: dimensions and data length agree',
  mapBytes.length === lMap.nS * lMap.nE && lMap.nS > 5 && lMap.nE > 5,
  `${lMap.nS}x${lMap.nE} vs ${mapBytes.length}`);
// brightest cell must sit in the motif×motif region — the map points at the slice
let bestK = 0;
for (let k = 1; k < mapBytes.length; k++) if (mapBytes[k] > mapBytes[bestK]) bestK = k;
const bI = Math.floor(bestK / lMap.nE), bJ = bestK % lMap.nE;
const bS = lMap.sStartSec + bI * lMap.sStepSec;
const bE = lMap.eStartSec + bJ * lMap.eStepSec;
check('map: brightest cell is the motif pair',
  mapBytes[bestK] / 255 > 0.85 && bS < 2.7 && bE > 7.4,
  `s=${bS.toFixed(2)} e=${bE.toFixed(2)} v=${(mapBytes[bestK] / 255).toFixed(2)}`);
// pairs shorter than the minimum loop are marked not-a-candidate (0)
check('map: too-short corner marked invalid',
  mapBytes[(lMap.nS - 1) * lMap.nE + 0] === 0);

// --- 9a4. adaptive seam fade: stronger blends for weaker seams ---
check('seam fade auto: clean seam gets no blend', autoSeamFade(0.90, 40) === 0);
check('seam fade auto: near-miss gets ~1s', Math.abs(autoSeamFade(0.84, 40) - 1.1) < 0.01,
  `got ${autoSeamFade(0.84, 40)}`);
check('seam fade auto: 65% seam gets ~3s', Math.abs(autoSeamFade(0.65, 40) - 3) < 0.01,
  `got ${autoSeamFade(0.65, 40)}`);
check('seam fade auto: capped at 4s', autoSeamFade(0.30, 40) === 4);
check('seam fade auto: clamped to the trimmed lead-in that exists',
  Math.abs(autoSeamFade(0.65, 1.5) - 1.4) < 0.01, `got ${autoSeamFade(0.65, 1.5)}`);

// --- 9b. pair selection: longest-above-floor, not best-score-with-slack ---
// (best-with-slack degenerates on real music: self-similarity decays with
// distance, so nearby pairs always win and cuts slam into the trim limits)
const selLong = selectLoopPair([{ len: 30, score: 0.97 }, { len: 100, score: 0.87 }]);
check('selection: longest pair above the quality floor wins',
  selLong.pick.len === 100 && !selLong.fellBack, JSON.stringify(selLong));
const selWeak = selectLoopPair([{ len: 30, score: 0.78 }, { len: 100, score: 0.70 }]);
check('selection: nothing clears the floor -> best score + honest flag',
  selWeak.pick.len === 30 && selWeak.fellBack, JSON.stringify(selWeak));

// --- 9c. chroma: "sounds alike" must include pitch, not just texture ---
// A vs A# notes WITH HARMONICS (real notes have them; chroma discriminates on
// the harmonic series — bare low fundamentals are below FFT resolution, where
// a semitone is narrower than the analysis mainlobe). Same spectral bands, so
// texture alone called them a match; pitch classes must tell them apart.
function sinePcm(freq, sec, rate = 22050) {
  const s = new Float32Array(Math.round(sec * rate));
  for (let i = 0; i < s.length; i++) {
    const t = (2 * Math.PI * freq * i) / rate;
    s[i] = 0.4 * Math.sin(t) + 0.25 * Math.sin(2 * t) + 0.18 * Math.sin(3 * t) + 0.12 * Math.sin(4 * t);
  }
  return s;
}
function midFrameDot(Fa, Fb) {
  const fa = Math.floor(Fa.nFrames / 2) * Fa.D, fb = Math.floor(Fb.nFrames / 2) * Fb.D;
  let dot = 0;
  for (let d = 0; d < Fa.D; d++) dot += Fa.feats[fa + d] * Fb.feats[fb + d];
  return dot;
}
const fA = featurize(sinePcm(440, 3)), fAs = featurize(sinePcm(466.16, 3)), fA2 = featurize(sinePcm(440, 3));
check('chroma: semitone-apart tones no longer read as a match',
  midFrameDot(fA, fAs) < 0.75, `dot ${midFrameDot(fA, fAs).toFixed(3)}`);
check('chroma: identical tones still match near-perfectly',
  midFrameDot(fA, fA2) > 0.95, `dot ${midFrameDot(fA, fA2).toFixed(3)}`);

// --- 10. beat detection: synthetic 120 BPM kick track ---
// decaying 170Hz thump every 0.5s for 24s; detector must measure ~120 BPM
const clickSrc = path.join(fix, 'loop', 'click120.wav');
await run(ffmpegPath, ['-hide_banner', '-y', '-f', 'lavfi',
  '-i', "aevalsrc='sin(2*PI*170*t)*exp(-30*mod(t,0.5))*lt(mod(t,0.5),0.2)':d=24:s=44100",
  clickSrc]);
const clickPcm = await decodeMono(clickSrc);
const beat = detectBeats(clickPcm);
check('beats: 120 BPM kick track measured within +/-4 BPM',
  beat.bpm > 116 && beat.bpm < 124, `got ${beat.bpm?.toFixed(1)} BPM`);
check('beats: confident pulse on rhythmic material',
  beat.confidence > 0.5, `got ${(beat.confidence * 100).toFixed(0)}%`);

// loop crop on it must snap to the grid: whole number of beats kept
const blc = await findLoopCrop(clickSrc);
check('beats: loop crop reports beat alignment', blc.beatAligned === true,
  JSON.stringify({ aligned: blc.beatAligned, conf: blc.beatConfidence }));
check('beats: uniform track has no fake section breaks -> beat grid used',
  blc.cutsOn === 'beat grid', blc.cutsOn);
// judge against the fixture's TRUE period (0.5s) — the measured tempo carries
// ~0.5% error, but the sample-level xcorr refine locks cuts to the track's
// real periodicity, so the kept length must be whole TRUE beats
const beatMod = blc.keptSec % 0.5;
const offGrid = Math.min(beatMod, 0.5 - beatMod);
check('beats: kept length is a whole number of true beats (+/-40ms)',
  offGrid < 0.04, `off by ${(offGrid * 1000).toFixed(0)}ms (kept ${blc.keptSec.toFixed(3)}s)`);

// non-rhythmic material must fall back to texture matching, not fake a grid
check('beats: tonal track falls back to texture matching',
  lc.beatAligned === false && lc.beatConfidence < 0.35,
  `aligned=${lc.beatAligned} conf=${(lc.beatConfidence * 100).toFixed(0)}%`);

// --no-beats forces texture mode even on rhythmic material
const noBeatLog = await splice(['loop', clickSrc, '--dry-run', '--no-beats']);
check('beats: --no-beats suppresses the beat grid', !/BPM — loop is exactly/.test(noBeatLog));

// --- error path: nothing fits ---
let threw = false;
try { buildRandomPlan(files, 2, { rng: makeRng(1) }); } catch { threw = true; }
check('target shorter than every file -> clear error', threw);

console.log(failures === 0 ? '\nall tests passed' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
