// The Mac graphics service (gpu/mac_voice.py) behind voice-server's --gpu,
// with its fake voice: Node's side and Python's side of the contract meet
// here, which neither side's own tests can show. Skipped where there is no
// python3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gpuEngine, createVoiceServer } from '../server.mjs';
import { createLibrary } from '../library.mjs';

const SERVICE = fileURLToPath(new URL('../gpu/mac_voice.py', import.meta.url));
const have = spawnSync('python3', ['--version']).status === 0;

/** Starts the service on a free port → { base, stop() } */
function startService(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', [SERVICE, '--fake', '--port', '0'].concat(extra || []), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error('the service did not start: ' + out)); }, 15000);
    p.stdout.on('data', d => {
      out += d;
      const m = /listening on (http:\/\/[\d.]+:\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ base: m[1], stop: () => p.kill() }); }
    });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => { clearTimeout(timer); reject(new Error('the service exited ' + code + ': ' + out)); });
  });
}

async function until(check, what) {
  for (let i = 0; i < 600; i++) {
    const v = await check();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for ' + what);
}

test('voice-server reads what the Mac service sends', { skip: have ? false : 'python3 is not installed' }, async () => {
  const svc = await startService();
  try {
    const engine = gpuEngine(svc.base);
    const out = await engine.generate('The lantern guttered.', 'am_michael');
    assert.ok(out.pcm instanceof Float32Array, 'samples');
    assert.equal(out.rate, 24000, 'the rate from x-rate');
    assert.ok(out.pcm.length > 24000 * 0.3, 'a real length: ' + out.pcm.length);
    assert.ok(out.pcm.some(s => Math.abs(s) > 0.1), 'and not silence');
    assert.ok(out.pcm.every(s => s >= -1 && s <= 1));
    await assert.rejects(engine.generate('BOOM', 'af_heart'), /answered 500/, 'a failing voice is an error, with its status');
    assert.equal((await engine.generate('Fine.', 'af_heart')).rate, 24000, 'and the next render still works');
  } finally { svc.stop(); }
});

test('a book renders through the Mac service, a sentence at a time, and arrives with its timings', { skip: have ? false : 'python3 is not installed' }, async () => {
  const svc = await startService(['--fake-ms', '20']);
  const root = await mkdtemp(join(tmpdir(), 'or-macgpu-'));
  const server = createVoiceServer({
    code: '123456', slots: 3,
    engine: gpuEngine(svc.base),
    library: createLibrary({ root, compress: false }),
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const ask = (path, init) => fetch(base + path, Object.assign({ headers: { 'content-type': 'application/json', 'x-voice-code': '123456' } }, init));
  try {
    const parts = Array.from({ length: 6 }, (_, i) => ({ key: 'k' + i, text: 'One thing. Another thing.', cuts: [0, 11] }));
    assert.equal((await ask('/job', { method: 'POST', body: JSON.stringify({ book: 'b', title: 'B', voice: 'af_heart', parts }) })).status, 202);
    const a = await until(async () => {
      const x = await (await ask('/activity')).json();
      return x.books.length && x.books[0].ready ? x : null;
    }, 'the book to finish');
    assert.equal(a.books[0].done, 6);
    assert.equal(a.info.dtype, 'gpu', 'the page says a graphics card is doing it');
    assert.equal(a.load.slots, 3);

    const zip = Buffer.from(await (await ask('/bundle?book=b')).arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a zip');
    const manifestAt = zip.indexOf('"marks"');
    assert.ok(manifestAt > 0, 'the parts carry when each sentence starts');
  } finally {
    await new Promise(r => server.close(r));
    svc.stop();
    await rm(root, { recursive: true, force: true });
  }
});
