// App-server self-test: boots app/server.mjs headless (no window), drives the
// HTTP API the UI uses, and verifies scan + both mix modes end-to-end.
// Assumes tools/run-tests.mjs already generated test-fixtures (npm test chains them).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDuration } from '../lib/engine.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fix = path.join(root, 'test-fixtures');
const out = path.join(fix, 'out');
const PORT = 8745;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`);
  if (!ok) failures++;
}

const server = spawn('node', [path.join(root, 'app', 'server.mjs')], {
  env: { ...process.env, SPLICE_PORT: String(PORT), SPLICE_NO_OPEN: '1', SPLICE_NO_TIMEOUT: '1' },
  stdio: 'ignore',
});

async function post(url, body) {
  const res = await fetch(base + url, { method: 'POST', body: JSON.stringify(body || {}) });
  return res;
}

try {
  // wait for the server to come up
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await fetch(base + '/').then(r => r.ok).catch(() => false);
    if (!up) await new Promise(r => setTimeout(r, 100));
  }
  check('app server boots and serves the UI', up);

  const ui = await fetch(base + '/').then(r => r.text());
  check('UI page contains the run button', ui.includes('MAKE THE MIX'));

  const scan = await post('/api/scan', { folder: fix }).then(r => r.json());
  check('scan finds the 4 fixture files', scan.files?.length === 4, JSON.stringify(scan));
  check('scan totals 19s', Math.abs(scan.total - 19) < 0.5, `got ${scan.total}`);

  const badScan = await post('/api/scan', { folder: 'C:\\nope-does-not-exist' });
  check('scan of missing folder errors cleanly', badScan.status === 400);

  // random mix through the API, NDJSON stream
  const mixRes = await post('/api/mix', {
    mode: 'random', inputFolder: fix, outputFolder: out,
    name: 'appmix', format: '.ogg', length: '30', maxGap: '5',
    crossfade: '0', normalize: false, history: true,
  });
  const lines = (await mixRes.text()).trim().split('\n').map(l => JSON.parse(l));
  const done = lines.find(l => l.done)?.done;
  check('random mix streams logs then a result', !!done && lines.some(l => l.log),
    JSON.stringify(lines.at(-1)));
  check('result includes seed + cap + events', !!(done?.seed && done?.cap && done?.events?.length));
  const dur = await probeDuration(done.outPath);
  check('app-rendered mix is exactly 30s', Math.abs(dur - 30) < 0.05, `got ${dur.toFixed(3)}`);

  // rerun must not overwrite: gets a -2 suffix
  const mix2 = await post('/api/mix', {
    mode: 'random', inputFolder: fix, outputFolder: out,
    name: 'appmix', format: '.ogg', length: '30',
  });
  const done2 = (await mix2.text()).trim().split('\n').map(l => JSON.parse(l)).find(l => l.done)?.done;
  check('rerun auto-numbers instead of overwriting', done2?.outName === 'appmix-2.ogg',
    done2?.outName);

  // concat through the API
  const cat = await post('/api/mix', {
    mode: 'concat', inputFolder: fix, outputFolder: out, name: 'appcat', format: '.wav', gap: '0',
  });
  const catDone = (await cat.text()).trim().split('\n').map(l => JSON.parse(l)).find(l => l.done)?.done;
  const catDur = catDone ? await probeDuration(catDone.outPath) : 0;
  check('concat through app == 19s', Math.abs(catDur - 19) < 0.15, `got ${catDur.toFixed(2)}`);

  // blank output folder defaults to a "mixes" subfolder (no source pollution)
  const sub = await post('/api/mix', {
    mode: 'concat', inputFolder: fix, outputFolder: '', name: 'subtest', format: '.ogg',
  });
  const subDone = (await sub.text()).trim().split('\n').map(l => JSON.parse(l)).find(l => l.done)?.done;
  check('blank output folder -> mixes subfolder', subDone?.outPath === path.join(fix, 'mixes', 'subtest.ogg'),
    subDone?.outPath);

  // output INTO the input folder must not be re-ingested by the next run
  await post('/api/mix', { mode: 'concat', inputFolder: fix, outputFolder: fix, name: 'selfmix', format: '.ogg' })
    .then(r => r.text());
  const self2 = await post('/api/mix', {
    mode: 'concat', inputFolder: fix, outputFolder: fix, name: 'selfmix', format: '.ogg',
  });
  const self2Done = (await self2.text()).trim().split('\n').map(l => JSON.parse(l)).find(l => l.done)?.done;
  const self2Dur = self2Done ? await probeDuration(self2Done.outPath) : 0;
  check('mix saved into input folder is excluded from the next mix',
    Math.abs(self2Dur - 19) < 0.15, `got ${self2Dur.toFixed(2)}s (38 would mean pollution)`);

  // loop endpoint: run on the synthetic loop fixture (built by run-tests.mjs)
  const loopSrc = path.join(fix, 'loop', 'loopsrc.wav');
  const loopRes = await post('/api/loop', { file: loopSrc, outputFolder: out, format: '.ogg' });
  const loopDone = (await loopRes.text()).trim().split('\n').map(l => JSON.parse(l)).find(l => l.done)?.done;
  check('loop endpoint returns cuts + quality', !!loopDone &&
    loopDone.kind === 'loop' && loopDone.keptSec > 7 &&
    loopDone.score >= 0.85 && loopDone.weakSeam === false,
    JSON.stringify(loopDone));
  check('loop output named <track>-loop', loopDone?.outName === 'loopsrc-loop.ogg', loopDone?.outName);
  const loopDur = loopDone ? await probeDuration(loopDone.outPath) : 0;
  check('loop render matches the analysis length', Math.abs(loopDur - loopDone.keptSec) < 0.1,
    `got ${loopDur.toFixed(2)} vs ${loopDone?.keptSec?.toFixed(2)}`);

  // bad input surfaces as a streamed error, not a hang
  const bad = await post('/api/mix', { mode: 'random', inputFolder: fix, outputFolder: out, length: '' });
  const badLines = (await bad.text()).trim().split('\n').map(l => JSON.parse(l));
  check('missing length -> streamed error message', badLines.some(l => l.error));

  // audio preview endpoint streams the file
  const audio = await fetch(base + '/api/audio?p=' + encodeURIComponent(done.outPath));
  check('audio preview endpoint serves the mix',
    audio.ok && audio.headers.get('content-type') === 'audio/ogg');
} finally {
  server.kill();
}

console.log(failures === 0 ? '\nall app tests passed' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
