// node --test, no install: the engine is a fake, so kokoro-js is never loaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceServer, encodeWav, trimSilence } from '../server.mjs';

function fakeEngine(calls) {
  return {
    info: { model: 'fake', dtype: 'fp32', cores: 1 },
    generate: async function (text, voice) {
      calls.push({ text, voice });
      // 50 ms of padding, 100 ms of tone, 50 ms of padding at 24 kHz.
      const pcm = new Float32Array(4800);
      for (let i = 1200; i < 3600; i++) pcm[i] = 0.5 * Math.sin(i / 10);
      return { pcm, rate: 24000 };
    },
  };
}

async function start(engine, code) {
  const server = createVoiceServer({ code: code || '123456', engine });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  return { server, base };
}

test('status needs the code and reports readiness', async () => {
  const { server, base } = await start(fakeEngine([]));
  try {
    assert.equal((await fetch(base + '/status')).status, 401);
    const r = await fetch(base + '/status', { headers: { 'x-voice-code': '123456' } });
    assert.equal(r.status, 200);
    const s = await r.json();
    assert.equal(s.ok, true);
    assert.equal(s.ready, true);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
  } finally { server.close(); }
});

test('render returns a trimmed 16-bit WAV with its length', async () => {
  const calls = [];
  const { server, base } = await start(fakeEngine(calls));
  try {
    const r = await fetch(base + '/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voice-code': '123456' },
      body: JSON.stringify({ text: 'The lantern guttered.', voice: 'af_heart' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/wav');
    const wav = Buffer.from(await r.arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt16LE(34), 16, '16-bit');
    const seconds = Number(r.headers.get('x-seconds'));
    // 100 ms of tone plus 20 ms kept at each end: the padding is trimmed.
    assert.ok(seconds > 0.1 && seconds < 0.16, 'trimmed length ' + seconds);
    assert.deepEqual(calls, [{ text: 'The lantern guttered.', voice: 'af_heart' }]);
  } finally { server.close(); }
});

test('render refuses a wrong code, bad voices and empty text', async () => {
  const calls = [];
  const { server, base } = await start(fakeEngine(calls));
  const post = (body, code) => fetch(base + '/render', {
    method: 'POST', headers: { 'x-voice-code': code || '123456' }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await post({ text: 'Hi.', voice: 'af_heart' }, '000000')).status, 401);
    assert.equal((await post({ text: 'Hi.', voice: '../../etc' })).status, 400);
    assert.equal((await post({ text: '   ', voice: 'af_heart' })).status, 400);
    assert.equal(calls.length, 0, 'nothing rendered');
  } finally { server.close(); }
});

test('renders run one at a time, in order', async () => {
  const order = [];
  let active = 0, maxActive = 0;
  const engine = {
    info: {},
    generate: async function (text) {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      order.push(text);
      active--;
      return { pcm: new Float32Array(240).fill(0.5), rate: 24000 };
    },
  };
  const { server, base } = await start(engine);
  try {
    const req = t => fetch(base + '/render', {
      method: 'POST', headers: { 'x-voice-code': '123456' }, body: JSON.stringify({ text: t, voice: 'af_heart' }),
    });
    const rs = await Promise.all([req('one'), req('two'), req('three')]);
    assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ['one', 'two', 'three']);
  } finally { server.close(); }
});

test('while the voice loads, render says so instead of hanging', async () => {
  let resolve;
  const { server, base } = await start(new Promise(r => { resolve = r; }));
  try {
    const s = await (await fetch(base + '/status', { headers: { 'x-voice-code': '123456' } })).json();
    assert.equal(s.ready, false);
    const r = await fetch(base + '/render', {
      method: 'POST', headers: { 'x-voice-code': '123456' }, body: JSON.stringify({ text: 'Hi.', voice: 'af_heart' }),
    });
    assert.equal(r.status, 503);
    resolve(fakeEngine([]));
  } finally { server.close(); }
});

test('wav helpers match the app', () => {
  const pcm = new Float32Array([0, 0, 0.5, -0.5, 0, 0]);
  const t = trimSilence(pcm, 1000);
  assert.ok(t.length <= pcm.length);
  const wav = encodeWav(new Float32Array([1, -1]), 24000);
  assert.equal(wav.readInt16LE(44), 0x7fff);
  assert.equal(wav.readInt16LE(46), -0x8000);
});
