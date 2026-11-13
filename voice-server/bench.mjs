#!/usr/bin/env node
// How fast does this computer render, and with how many copies of the voice?
//
//   node bench.mjs                 # fp32, the default voice
//   node bench.mjs --dtype q8
//   node bench.mjs --gpu http://127.0.0.1:8899   # a graphics service, see gpu/
//
// Renders the same sentences with one copy using every core (how the server
// worked before it ran several) and then with 1, 2, 4… copies on one thread
// each, and prints seconds of audio made per second for each. The server
// finds its own number while it works (tuner.mjs); this is for seeing why,
// and for checking a new computer before leaving a long book on it.

import { cpus, totalmem } from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createFarm } from './farm.mjs';
import { copyCeiling, gpuEngine } from './server.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SENTENCES = [
  'The lantern guttered as the wind came through the broken shutter.',
  'She counted her breaths slowly, the way her mother had taught her.',
  'Nobody in the lower city asked the ledger why, and the ledger never once volunteered.',
  '"You are late," he said, without looking up from the page.',
  'By the time the bells had finished, the square was empty.',
  'It was not the first time the river had lied to him.',
];

/** Resident memory of a process, in bytes, where the system will say. */
async function memoryOf(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(await readFile('/proc/' + pid + '/status', 'utf8'));
    if (m) return Number(m[1]) * 1024;
  } catch (e) { /* not Linux */ }
  // macOS has no /proc; ps reports the same thing, in kilobytes.
  return new Promise(function (resolve) {
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], function (err, out) {
      const kb = err ? 0 : Number(String(out).trim());
      resolve(kb > 0 ? kb * 1024 : 0);
    });
  });
}

async function measure(dtype, copies, threads, rounds) {
  const pids = [];
  const farm = createFarm({
    script: process.env.BENCH_SCRIPT || new URL('./engine-worker.mjs', import.meta.url),
    env: { VOICE_DTYPE: dtype, VOICE_THREADS: String(threads) },
    size: copies,
    log: function (m) { console.log('    ' + m); },
    onStart: function (pid) { pids.push(pid); },
  });
  try {
    await farm.ready;
    while (farm.size() < copies) await new Promise(function (r) { setTimeout(r, 100); });
    // Once through unmeasured: the first pass through a fresh copy is slow.
    await Promise.all(Array.from({ length: copies }, function () { return farm.generate(SENTENCES[0], 'af_heart'); }));
    // Enough sentences that every copy gets several. With a dozen copies and
    // a dozen sentences the run ends when the slowest single sentence does,
    // with most copies already idle, and the speed reads low and noisy.
    const count = Math.max(rounds * SENTENCES.length, copies * 4);
    const work = Array.from({ length: count }, function (_, i) { return SENTENCES[i % SENTENCES.length]; });
    farm.window();
    const t0 = Date.now();
    await Promise.all(work.map(function (s) { return farm.generate(s, 'af_heart'); }));
    const ms = Date.now() - t0;
    const w = farm.window();
    let memory = 0;
    for (const pid of pids) memory = Math.max(memory, await memoryOf(pid));
    return { speed: w.seconds / (ms / 1000), seconds: w.seconds, ms: ms, memory: memory, threads: farm.threads() };
  } finally { farm.close(); }
}

/**
 * The same sentences through a graphics service, with 1, 2, 3… requests in
 * flight. The service renders one sentence at a time, so what more requests
 * buy is only that it is never left waiting for the next one to arrive;
 * where that stops helping is the number for --slots.
 */
async function benchGpu(base, rounds) {
  const engine = gpuEngine(base);
  const status = await fetch(base.replace(/\/+$/, '') + '/status').then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!status) { console.log('\n  Nothing answers at ' + base + '. Start the service first.\n'); return; }
  console.log('');
  console.log('  Graphics service at ' + base + ' (' + (status.backend || 'unknown') + (status.model ? ', ' + status.model : '') + ')');
  console.log('');
  console.log('  Getting it warm…');
  for (let i = 0; i < 3; i++) await engine.generate(SENTENCES[i % SENTENCES.length], 'af_heart');
  let first = 0, best = null;
  for (const slots of [1, 2, 3, 4, 6, 8]) {
    const count = Math.max(rounds * SENTENCES.length, slots * 4);
    let next = 0, seconds = 0;
    const t0 = Date.now();
    await Promise.all(Array.from({ length: slots }, async function () {
      while (next < count) {
        const r = await engine.generate(SENTENCES[next++ % SENTENCES.length], 'af_heart');
        seconds += r.pcm.length / r.rate;
      }
    }));
    const speed = seconds / ((Date.now() - t0) / 1000);
    if (!first) first = speed;
    if (!best || speed > best.speed * 1.03) best = { slots: slots, speed: speed };
    console.log('  ' + (slots + (slots === 1 ? ' request ' : ' requests') + ' at a time').padEnd(26)
      + speed.toFixed(1).padStart(6) + '× as fast as listening   ' + (speed / first).toFixed(2) + '× one at a time');
  }
  console.log('');
  console.log('  Enough: ' + best.slots + ' at a time, ' + best.speed.toFixed(1) + '× as fast as listening.');
  console.log('  Start the server with:   npm start -- --gpu ' + base + ' --slots ' + best.slots);
  console.log('');
}

const dtype = arg('dtype', 'fp32');
if (arg('gpu', '')) {
  await benchGpu(arg('gpu', ''), Number(arg('rounds', 2)) || 2);
  process.exit(0);
}
const cores = cpus().length;
const ceiling = copyCeiling(dtype, cores, totalmem());
const rounds = Number(arg('rounds', 2)) || 2;

console.log('');
console.log('  ' + cores + ' cores, ' + (totalmem() / 1e9).toFixed(0) + ' GB, voice ' + dtype
  + '. Up to ' + ceiling + ' copies fit.');
console.log('');

const rows = [{ label: '1 copy, every core (the old way)', copies: 1, threads: 0 }];
for (let n = 1; n <= ceiling; n = n < 4 ? n + 1 : n + 2) rows.push({ label: n + (n === 1 ? ' copy' : ' copies') + ', 1 thread each', copies: n, threads: 1 });

let first = 0, best = null;
for (const row of rows) {
  const r = await measure(dtype, row.copies, row.threads, rounds);
  if (!first) first = r.speed;
  if (row.threads && (!best || r.speed > best.speed)) best = Object.assign({ copies: row.copies }, r);
  console.log('  ' + row.label.padEnd(36) + r.speed.toFixed(1).padStart(6) + '× as fast as listening'
    + '   ' + (r.speed / first).toFixed(2) + '× the old way'
    + (r.memory ? '   ' + (r.memory / 1e6).toFixed(0) + ' MB a copy' : '')
    + (row.threads && r.threads !== row.threads ? '   (thread count NOT honoured: ' + r.threads + ')' : ''));
}
console.log('');
console.log('  Fastest here: ' + best.copies + ' at once, ' + best.speed.toFixed(1) + '× as fast as listening, '
  + (best.speed / first).toFixed(2) + '× the old way.');
console.log('');
process.exit(0);
