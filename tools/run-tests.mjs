// Self-test: generates tone fixtures (mixed formats), exercises both modes
// end-to-end through the CLI, and verifies the spec rules:
//   1. concat output duration == sum of inputs
//   2. random output duration == target, exactly
//   3. repeat cap == floor(target/totalSource)+1 and never exceeded
//   4. inner gaps <= max-gap; long whitespace only at head/tail
//   5. two unseeded runs -> different sequences (novelty)
//   6. same --seed twice -> identical sequence (reproducibility)
// Run: npm test

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { probeDuration, buildRandomPlan, makeRng } from '../lib/engine.mjs';

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

async function tone(freq, dur, file) {
  await run(ffmpegPath, [
    '-hide_banner', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${freq}:duration=${dur}`,
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

// Mixed-format pool: 3+5+7+4 = 19s of source
await tone(220, 3, 'a220.wav');
await tone(330, 5, 'b330.ogg');
await tone(440, 7, 'c440.mp3');
await tone(550, 4, 'd550.wav');

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

// --- 2-4. random plan math (engine-level, 500 seeded plans) ---
const files = [
  { path: 'a.wav', dur: 3 }, { path: 'b.ogg', dur: 5 },
  { path: 'c.mp3', dur: 7 }, { path: 'd.wav', dur: 4 },
];
const target = 60; // cap = floor(60/19)+1 = 4
let capOk = true, gapOk = true, lenOk = true;
for (let s = 0; s < 500; s++) {
  const plan = buildRandomPlan(files, target, { maxGap: 5, rng: makeRng(s) });
  if (plan.cap !== 4) capOk = false;
  if (Object.values(plan.counts).some(c => c > plan.cap)) capOk = false;
  const segs = plan.segments;
  for (let i = 1; i < segs.length - 1; i++) {
    if (segs[i].type === 'silence' && segs[i].dur > 5.001) gapOk = false;
  }
  const planned = segs.reduce((t, x) => t + x.dur, 0);
  if (Math.abs(planned - target) > 0.01) lenOk = false;
}
check('repeat cap == floor(60/19)+1 == 4, never exceeded (500 plans)', capOk);
check('inner gaps <= 5s, long whitespace only head/tail (500 plans)', gapOk);
check('planned length == target exactly (500 plans)', lenOk);

// --- 2. random render: exact output length, wav output from mixed inputs ---
const rndOut = path.join(out, 'rnd.wav');
const log1 = await splice(['random', fix, '-o', rndOut, '-l', '60']);
const rndDur = await probeDuration(rndOut);
check('random render duration == 60s exactly', Math.abs(rndDur - 60) < 0.05, `got ${rndDur.toFixed(3)}s`);
check('CLI reports cap of 4', /= 4 use\(s\)/.test(log1), log1.match(/repeat cap.*/)?.[0] ?? 'no cap line');

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
  JSON.stringify(seeded1.segments) === JSON.stringify(seeded2.segments));

// --- error path: nothing fits ---
let threw = false;
try { buildRandomPlan(files, 2, { rng: makeRng(1) }); } catch { threw = true; }
check('target shorter than every file -> clear error', threw);

console.log(failures === 0 ? '\nall tests passed' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
