// The copies of the voice and the tuner that counts them. No model: the
// copies are test/fake-engine-worker.mjs, and the tuner is given a farm made
// of numbers and a clock it can wind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFarm } from '../farm.mjs';
import { createTuner } from '../tuner.mjs';
import { loadKokoro, copyCeiling, createVoiceServer } from '../server.mjs';
import { createLibrary } from '../library.mjs';

const FAKE = new URL('./fake-engine-worker.mjs', import.meta.url);

async function until(check, what) {
  for (let i = 0; i < 600; i++) {
    const v = await check();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for ' + what);
}

test('several copies render several sentences at once', async () => {
  const farm = createFarm({ script: FAKE, size: 4, env: { FAKE_MS: '150' } });
  try {
    await farm.ready;
    await until(() => farm.size() === 4, 'all four copies');
    assert.equal(farm.capacity(), 4);
    const t0 = Date.now();
    const out = await Promise.all(Array.from({ length: 8 }, (_, i) => farm.generate('Sentence ' + i + '.', 'af_heart')));
    const took = Date.now() - t0;
    assert.equal(out.length, 8);
    assert.ok(out.every(r => r.pcm instanceof Float32Array && r.pcm.length === 2400 && r.rate === 24000), 'samples arrive as samples');
    assert.ok(took < 8 * 150 * 0.6, 'eight sentences on four copies took ' + took + ' ms, not eight in a row');
    const w = farm.window();
    assert.equal(w.done, 8);
    assert.ok(Math.abs(w.seconds - 0.8) < 1e-6, 'and the audio made is counted: ' + w.seconds);
    assert.ok(w.busyMs > 0 && w.copies === 4);
  } finally { farm.close(); }
});

test('the first copy loads alone, and the rest follow', async () => {
  const farm = createFarm({ script: FAKE, size: 3, env: { FAKE_LOAD_MS: '120' } });
  try {
    assert.equal(farm.capacity(), 1, 'never less than one, even before anything has loaded');
    await farm.ready;
    assert.equal(farm.size(), 1, 'ready as soon as one copy is');
    await until(() => farm.size() === 3, 'the others');
  } finally { farm.close(); }
});

test('a farm grows and shrinks while it works, losing nothing', async () => {
  const farm = createFarm({ script: FAKE, size: 1, env: { FAKE_MS: '40' } });
  try {
    await farm.ready;
    const jobs = Array.from({ length: 12 }, (_, i) => farm.generate('S' + i, 'af_heart'));
    farm.resize(3);
    await until(() => farm.size() === 3, 'three copies');
    farm.resize(1);
    const out = await Promise.all(jobs);
    assert.equal(out.length, 12, 'every sentence came back');
    await until(() => farm.size() === 1, 'back to one');
    assert.equal(farm.target(), 1);
  } finally { farm.close(); }
});

test('a copy that dies mid-sentence is replaced and its sentence rendered elsewhere', async () => {
  const said = [];
  // FAKE_SECOND is set only for copies started after the first, so the
  // sentence that killed one renders on the next.
  const farm = createFarm({ script: FAKE, size: 1, respawnMs: 10, log: m => said.push(m) });
  try {
    await farm.ready;
    process.env.FAKE_SECOND = '1';
    const r = await farm.generate('CRASH', 'af_heart');
    assert.equal(r.pcm.length, 2400, 'the sentence was rendered after all');
    assert.ok(said.some(m => /stopped/.test(m)), 'and the log says a copy stopped: ' + said.join(' | '));
    await until(() => farm.size() === 1, 'the replacement');
  } finally { delete process.env.FAKE_SECOND; farm.close(); }
});

test('a sentence that kills every copy fails by itself, not the book', async () => {
  const farm = createFarm({ script: FAKE, size: 1, respawnMs: 10, env: { FAKE_CRASH: 'always' } });
  try {
    await farm.ready;
    await assert.rejects(farm.generate('CRASH', 'af_heart'), /stopped while rendering/);
    await until(() => farm.size() === 1, 'a fresh copy');
    assert.equal((await farm.generate('Fine.', 'af_heart')).pcm.length, 2400, 'and the next sentence renders');
    await assert.rejects(farm.generate('BAD', 'af_heart'), /cannot say that/, 'an engine error is passed on as it is');
  } finally { farm.close(); }
});

test('a voice that cannot load says why', async () => {
  const farm = createFarm({ script: FAKE, size: 2, env: { FAKE_LOAD: 'fail' } });
  try { await assert.rejects(farm.ready, /no such model/); }
  finally { farm.close(); }
});

// ── The tuner ───────────────────────────────────────────────────────────────

/** A farm made of numbers: `speed(n)` is what n copies make per second. */
function numbersFarm(start, speed, opts) {
  const o = opts || {};
  const f = {
    n: start, want: start, t: 0, mark: 0, busy: o.busy === undefined ? 1 : o.busy, resizes: [],
    target: () => f.want,
    size: () => f.n,
    resize: (n) => { f.resizes.push(n); f.want = n; if (!o.refuse || n <= o.refuse) f.n = n; else f.want = f.n; },
    peek: () => ({ ms: f.t - f.mark, seconds: speed(f.n) * (f.t - f.mark) / 1000, done: Math.floor((f.t - f.mark) / 500) * f.n }),
    window: () => {
      const ms = f.t - f.mark;
      const w = { ms, seconds: speed(f.n) * ms / 1000, done: Math.floor(ms / 500) * f.n, busyMs: ms * f.n * f.busy, copies: f.n };
      f.mark = f.t;
      return w;
    },
  };
  return f;
}

function run(tuner, farm, seconds) {
  for (let i = 0; i < seconds; i++) { farm.t += 1000; tuner.step(); }
}

test('the tuner adds copies while they make it faster, and stops when they do not', () => {
  // Six fast cores, then slow ones that add almost nothing.
  const farm = numbersFarm(2, n => 1.5 * Math.min(n, 6) + 0.02 * Math.max(0, n - 6));
  const said = [], settled = [];
  const tuner = createTuner({ farm, max: 12, now: () => farm.t, windowMs: 10000, log: m => said.push(m), onSettle: n => settled.push(n) });
  run(tuner, farm, 120);
  assert.equal(tuner.status().copies, 6, said.join(' | '));
  assert.equal(tuner.status().phase, 'settled');
  assert.equal(farm.n, 6, 'the copy that bought nothing was taken away again');
  assert.deepEqual(settled, [6], 'and the answer is handed over to be remembered');
  assert.equal(tuner.status().speed, 9, 'the speed on show is the one it kept');
  assert.ok(said.some(m => /settled on 6/.test(m)));
});

test('the tuner stops at the ceiling it was given', () => {
  const farm = numbersFarm(2, n => 1.5 * n);
  const tuner = createTuner({ farm, max: 4, now: () => farm.t, windowMs: 10000 });
  run(tuner, farm, 120);
  assert.equal(tuner.status().copies, 4);
  assert.equal(tuner.status().phase, 'settled');
  assert.ok(Math.max(...farm.resizes) <= 4, 'never asked for more: ' + farm.resizes.join(','));
});

test('with too little work to go round, the tuner changes nothing', () => {
  const farm = numbersFarm(2, n => 1.5 * n, { busy: 0.3 });
  const tuner = createTuner({ farm, max: 8, now: () => farm.t, windowMs: 10000 });
  run(tuner, farm, 120);
  assert.equal(tuner.status().copies, 2);
  assert.deepEqual(farm.resizes, [], 'idle copies say nothing about the computer');
});

test('a computer with no room for another copy settles where it is', () => {
  const farm = numbersFarm(2, n => 1.5 * n, { refuse: 3 });
  const said = [];
  const tuner = createTuner({ farm, max: 8, now: () => farm.t, windowMs: 10000, log: m => said.push(m) });
  run(tuner, farm, 120);
  assert.equal(tuner.status().copies, 3);
  assert.equal(tuner.status().phase, 'settled');
  assert.ok(said.some(m => /no room for 4/.test(m)), said.join(' | '));
});

test('after a rest the tuner looks again, since the computer may have changed', () => {
  let cores = 3;                       // another program is using the rest
  const farm = numbersFarm(2, n => 1.5 * Math.min(n, cores));
  const tuner = createTuner({ farm, max: 8, now: () => farm.t, windowMs: 10000, restMs: 60000 });
  run(tuner, farm, 60);
  assert.equal(tuner.status().copies, 3);
  cores = 5;                           // it finished
  run(tuner, farm, 200);
  assert.equal(tuner.status().copies, 5);
});

// ── Together ────────────────────────────────────────────────────────────────

test('how many copies to try is bounded by cores and by memory', () => {
  assert.equal(copyCeiling('fp32', 10, 32e9), 10, 'cores are the limit on a big machine');
  assert.equal(copyCeiling('fp32', 10, 8e9), 4, 'memory is the limit on a small one');
  assert.equal(copyCeiling('q8', 10, 8e9), 8, 'a smaller voice fits more often');
  assert.equal(copyCeiling('fp32', 8, 1e9), 1, 'never fewer than one');
});

test('the server renders a book across its copies, and says how many it is using', async () => {
  const root = await mkdtemp(join(tmpdir(), 'or-farm-'));
  const tuningFile = join(root, 'voice-tuning.json');
  const said = [];
  const server = createVoiceServer({
    code: '123456',
    library: createLibrary({ root, compress: false }),
    log: m => said.push(m),
    engine: ctx => loadKokoro({
      script: FAKE, env: { FAKE_MS: '30' }, workers: 3, threads: 1, log: ctx.log, tuningFile,
    }),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ask = (path, init) => fetch(base + path, Object.assign({ headers: { 'content-type': 'application/json', 'x-voice-code': '123456' } }, init));
  try {
    const parts = Array.from({ length: 12 }, (_, i) => ({ key: 'k' + i, text: 'One. Two.', cuts: [0, 5] }));
    await ask('/job', { method: 'POST', body: JSON.stringify({ book: 'b', title: 'B', voice: 'af_heart', parts }) });
    const a = await until(async () => {
      const x = await (await ask('/activity')).json();
      return x.books.length && x.books[0].ready ? x : null;
    }, 'the book to finish');
    assert.equal(a.books[0].done, 12);
    assert.equal(a.info.copies, 3, 'the page is told how many copies are running');
    assert.equal(a.info.threads, 1);
    assert.equal(a.info.tuning, null, 'and that the number was fixed by hand');
    assert.equal(a.load.slots, 3, 'three sentences at a time');
  } finally {
    await new Promise(r => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test('left to itself the server tunes, and remembers the answer for next time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'or-farm-'));
  const tuningFile = join(root, 'voice-tuning.json');
  const said = [];
  // Sleeping copies scale perfectly, so it climbs to its ceiling, which the
  // memory given here puts at three on any machine with three cores or more.
  const engine = await loadKokoro({
    script: FAKE, env: { FAKE_MS: '25' }, threads: 1, memory: 6.2e9, log: m => said.push(m),
    tuningFile, windowMs: 400, tickMs: 40,
  });
  try {
    const top = engine.info.tuning.max;
    assert.ok(top >= 1 && top <= 3, 'the ceiling comes from memory and cores: ' + top);
    let live = true;
    const feed = async () => { while (live) await engine.generate('A sentence.', 'af_heart').catch(() => {}); };
    const feeders = Array.from({ length: 6 }, feed);
    await until(() => engine.info.tuning.phase === 'settled', 'the tuner to settle');
    live = false;
    await Promise.all(feeders);
    assert.equal(engine.info.tuning.copies, top, said.join(' | '));
    assert.equal(engine.info.copies, top, 'and that many are running');
    assert.ok(engine.info.tuning.speed > 0, 'and it knows how fast it is going');
    const kept = JSON.parse(await until(async () => { try { return await readFile(tuningFile, 'utf8'); } catch (e) { return null; } }, 'the tuning file'));
    assert.equal(kept.copies, top);
    assert.equal(kept.threads, 1);

    // Started again, it begins where it left off instead of climbing again.
    const again = await loadKokoro({ script: FAKE, threads: 1, memory: 6.2e9, tuningFile, windowMs: 400, tickMs: 40 });
    try {
      await until(() => again.info.copies === top, 'the remembered number of copies');
      assert.equal(again.info.tuning.copies, top);
    } finally { again.close(); }
  } finally { engine.close(); await rm(root, { recursive: true, force: true }); }
});
