#!/usr/bin/env node
// audio-splicer CLI: concat (sequential merge) and random (fixed-length random splice).

import { parseArgs } from 'node:util';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import {
  AUDIO_EXTENSIONS, probeDuration, makeRng, parseLength, fmtTime, mixArtifactRegex,
  buildConcatPlan, buildRandomPlan, planSequence, pickNovelPlan, renderPlan,
} from '../lib/engine.mjs';
import { findLoopCrop, renderLoopCrop } from '../lib/loop.mjs';

const HISTORY_NAME = '.splice-history.json';
const HISTORY_LIMIT = 200;

function usage() {
  console.log(`audio-splicer — merge audio files (ogg/mp3/wav/flac/m4a/opus/...)

Usage:
  splice concat <files-or-folders...> -o output.ext [options]
      Joins inputs end-to-end in order (folders expand to their audio files,
      sorted by name; explicitly listed files keep the order you gave).
      --gap <sec>         fixed silence between files (default 0)
      --crossfade <sec>   overlap-blend adjacent files instead (excludes --gap)

  splice random <files-or-folders...> -o output.ext -l <length> [options]
      Random-order splice padded/fitted to exactly <length>.
      -l, --length        target length: 540, 9:00, 1:02:03, 9m, 90s, 1h30m
      --max-gap <sec>     max silence between files (default 5); leftover time
                          beyond that goes to the start/end of the mix
      --crossfade <sec>   clips fade in/out and may overlap-blend by up to this
      --seed <s>          reproduce an exact mix (printed on every run)
      --candidates <n>    plans generated per run for novelty selection (default 64)
      --no-history        don't read/write ${HISTORY_NAME} next to the output

  splice loop <track> [-o output.ext] [options]
      Crops a track at the start and end so it loops seamlessly, keeping it as
      long as possible. Finds the cut pair whose surrounding audio matches best
      (texture + loudness), then aligns the cuts to the waveform so the seam
      doesn't click. Default output: <track>-loop.<same ext>.
      When the track has a confident beat (drums, steady pulse), cuts snap to
      the detected beat grid so the loop is a whole number of beats; otherwise
      it falls back to pure texture matching automatically.
      --max-trim <s|%>    most to cut from EACH end (default 30% capped at 90s)
      --window <sec>      seconds of context compared around the seam (default 1.5)
      --no-beats          never snap to beats, texture matching only

Shared options:
  -o, --output <file>     output path; extension picks the format (.ogg .mp3 .wav
                          .flac .m4a .aac .opus)
  --normalize             two-pass loudness normalization: every file is measured
                          and gain-matched to -16 LUFS (true peak capped -1.5 dB)
  --dry-run               print the plan without rendering

Each run of "random" writes its sequence to ${HISTORY_NAME} in the output folder
and future runs pick the candidate mix most dissimilar from that history, so
repeated runs give genuinely different arrangements.`);
}

async function collectInputs(args, outPath) {
  // a scanned folder may be where earlier mixes were saved — never re-ingest
  // this tool's own outputs ("mix.ogg", "mix-2.ogg", ...) as source material
  const outDir = outPath ? path.resolve(path.dirname(outPath)) : null;
  const artifact = outPath
    ? mixArtifactRegex(path.basename(outPath, path.extname(outPath)).replace(/-\d+$/, ''))
    : null;
  const files = [];
  for (const arg of args) {
    const st = await stat(arg).catch(() => null);
    if (!st) throw new Error(`Input not found: ${arg}`);
    if (st.isDirectory()) {
      const isOutDir = outDir && path.resolve(arg) === outDir;
      const entries = (await readdir(arg))
        .filter(e => AUDIO_EXTENSIONS.has(path.extname(e).toLowerCase()))
        .filter(e => !(isOutDir && artifact.test(e)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (entries.length === 0) throw new Error(`No audio files found in folder: ${arg}`);
      files.push(...entries.map(e => path.join(arg, e)));
    } else {
      files.push(arg);
    }
  }
  if (files.length === 0) throw new Error('No input files given.');
  process.stdout.write(`probing ${files.length} file(s)... `);
  const probed = [];
  for (const f of files) {
    probed.push({ path: f, dur: await probeDuration(f) });
  }
  console.log('done');
  return probed;
}

function printPlan(plan) {
  console.log('\n  start    dur     item');
  const evs = plan.events;
  if (evs[0].start > 0.05) {
    console.log(`  ${fmtTime(0).padStart(7)}  ${evs[0].start.toFixed(1).padStart(5)}s  ~ silence ~`);
  }
  evs.forEach((e, i) => {
    let note = '';
    if (i > 0) {
      const joint = e.start - (evs[i - 1].start + evs[i - 1].dur);
      if (joint > 0.05) note = `  (gap ${joint.toFixed(1)}s)`;
      else if (joint < -0.05) note = `  (xfade ${(-joint).toFixed(1)}s)`;
    }
    console.log(
      `  ${fmtTime(e.start).padStart(7)}  ${e.dur.toFixed(1).padStart(5)}s  ${path.basename(e.path)}${note}`
    );
  });
  const last = evs[evs.length - 1];
  const tail = plan.totalDur - (last.start + last.dur);
  if (tail > 0.05) {
    console.log(`  ${fmtTime(last.start + last.dur).padStart(7)}  ${tail.toFixed(1).padStart(5)}s  ~ silence ~`);
  }
  console.log(`  total ${fmtTime(plan.totalDur)}`);
}

async function loadHistory(historyPath) {
  try {
    const data = JSON.parse(await readFile(historyPath, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return;
  }

  const { values: opts, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      output: { type: 'string', short: 'o' },
      length: { type: 'string', short: 'l' },
      gap: { type: 'string', default: '0' },
      'max-gap': { type: 'string', default: '5' },
      crossfade: { type: 'string', default: '0' },
      normalize: { type: 'boolean', default: false },
      seed: { type: 'string' },
      candidates: { type: 'string', default: '64' },
      'no-history': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'max-trim': { type: 'string' },
      window: { type: 'string', default: '1.5' },
      'no-beats': { type: 'boolean', default: false },
    },
  });

  if (command === 'loop') {
    const [track] = positionals;
    if (!track) throw new Error('loop mode needs a track: splice loop <file>');
    const st = await stat(track).catch(() => null);
    if (!st || st.isDirectory()) throw new Error(`Track not found: ${track}`);
    const ext = path.extname(track);
    const outPath = path.resolve(opts.output
      ?? path.join(path.dirname(track), `${path.basename(track, ext)}-loop${ext}`));

    const r = await findLoopCrop(track, {
      maxTrim: opts['max-trim'],
      windowSec: parseFloat(opts.window),
      useBeats: !opts['no-beats'],
      onLog: m => console.log(m),
    });
    console.log(`\ntrack: ${fmtTime(r.durSec)}`);
    console.log(`keep:  ${fmtTime(r.startSec)} -> ${fmtTime(r.endSec)}  (${fmtTime(r.keptSec)}, ${(100 * r.keptSec / r.durSec).toFixed(0)}% of the track)`);
    console.log(`trim:  ${r.startSec.toFixed(2)}s from the start, ${(r.durSec - r.endSec).toFixed(2)}s from the end`);
    console.log(`seam:  ${(r.score * 100).toFixed(0)}% texture match; better cut pair than ${(r.percentile * 100).toFixed(0)}% of the alternatives`);
    if (r.beatAligned) {
      console.log(`beats: ${r.bpm.toFixed(1)} BPM — loop is exactly ${r.beatsKept} beats, cuts on the grid`);
    }
    if (!opts['dry-run']) {
      await renderLoopCrop(track, outPath, r.startSec, r.endSec);
      console.log(`wrote ${outPath}`);
    }
    return;
  }

  if (!opts.output && !opts['dry-run']) throw new Error('Missing -o/--output');
  const outPath = opts.output ? path.resolve(opts.output) : null;
  const crossfade = parseFloat(opts.crossfade);
  if (!(crossfade >= 0)) throw new Error('--crossfade must be a number >= 0');
  const render = async plan => {
    if (opts.normalize) console.log('\nnormalizing to -16 LUFS:');
    await renderPlan(plan, outPath, { normalize: opts.normalize, onLog: m => console.log(m) });
  };

  const files = await collectInputs(positionals, outPath);
  const totalSource = files.reduce((s, f) => s + f.dur, 0);

  if (command === 'concat') {
    const gap = parseFloat(opts.gap);
    if (gap > 0 && crossfade > 0) throw new Error('--gap and --crossfade are mutually exclusive in concat mode');
    const plan = buildConcatPlan(files, { gap, crossfade });
    printPlan(plan);
    if (!opts['dry-run']) await render(plan);
    return;
  }

  if (command === 'random') {
    const target = parseLength(opts.length);
    if (!target) throw new Error('random mode needs a valid -l/--length (e.g. 9:00, 540, 9m)');
    const maxGap = parseFloat(opts['max-gap']);
    const explicitSeed = opts.seed != null;
    const seed = explicitSeed ? opts.seed : String(randomInt(1, 2 ** 31));
    const rng = makeRng(seed);

    const historyPath = outPath
      ? path.join(path.dirname(outPath), HISTORY_NAME)
      : path.join(process.cwd(), HISTORY_NAME);
    const useHistory = !opts['no-history'] && !explicitSeed;
    const history = useHistory ? await loadHistory(historyPath) : [];

    let plan, novelty = null;
    if (explicitSeed) {
      // explicit seed = "give me exactly this mix" — no novelty steering
      plan = buildRandomPlan(files, target, { maxGap, crossfade, rng });
    } else {
      const n = Math.max(1, parseInt(opts.candidates, 10) || 64);
      const candidates = Array.from({ length: n }, () =>
        buildRandomPlan(files, target, { maxGap, crossfade, rng })
      );
      ({ plan, novelty } = pickNovelPlan(candidates, history.map(h => h.sequence)));
    }

    console.log(`\nseed: ${seed}${explicitSeed ? '' : '  (re-run with --seed to reproduce this mix)'}`);
    console.log(`source pool: ${files.length} file(s), ${fmtTime(totalSource)} total`);
    console.log(`repeat cap: floor(${fmtTime(target)} / ${fmtTime(totalSource)}) + 1 = ${plan.cap} use(s) per file`);
    if (novelty != null && history.length > 0) {
      console.log(`novelty: ${(novelty * 100).toFixed(0)}% different from nearest of ${history.length} previous mix(es)`);
    }
    printPlan(plan);
    console.log('  uses: ' + Object.entries(plan.counts)
      .map(([p, c]) => `${path.basename(p)}×${c}`).join('  '));

    if (!opts['dry-run']) {
      await render(plan);
      if (!opts['no-history']) {
        const all = await loadHistory(historyPath);
        all.push({
          when: new Date().toISOString(),
          output: path.basename(outPath),
          target, seed,
          sequence: planSequence(plan),
        });
        await writeFile(historyPath, JSON.stringify(all.slice(-HISTORY_LIMIT), null, 1), 'utf8');
      }
    }
    return;
  }

  throw new Error(`Unknown command "${command}" — run "splice help"`);
}

main().catch(err => {
  console.error(`\nerror: ${err.message}`);
  process.exit(1);
});
