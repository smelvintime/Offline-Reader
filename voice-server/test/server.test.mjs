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

function timedEngine(ms, calls) {
  return {
    info: {},
    generate: async function (text) {
      calls.push(text);
      await new Promise(r => setTimeout(r, ms));
      return { pcm: new Float32Array(240).fill(0.5), rate: 24000 };
    },
  };
}

async function startWithPeers(engine, peers) {
  const server = createVoiceServer({ code: '123456', engine, peers });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, base: 'http://127.0.0.1:' + server.address().port };
}

const render = (base, t) => fetch(base + '/render', {
  method: 'POST', headers: { 'x-voice-code': '123456' }, body: JSON.stringify({ text: t, voice: 'af_heart' }),
});

test('parts go to whichever computer is free, the faster one taking more', async () => {
  const mine = [], theirs = [];
  const peer = await start(timedEngine(60, theirs));
  const { server, base } = await startWithPeers(timedEngine(20, mine), [peer.base.replace('http://', '')]);
  try {
    const texts = Array.from({ length: 12 }, (_, i) => 'part ' + i);
    const rs = await Promise.all(texts.map(t => render(base, t)));
    assert.deepEqual(rs.map(r => r.status), texts.map(() => 200));
    assert.equal(mine.length + theirs.length, 12, 'each part rendered once');
    assert.ok(theirs.length >= 1, 'the peer did some: ' + theirs.length);
    assert.ok(mine.length > theirs.length, 'the faster one did more: ' + mine.length + ' vs ' + theirs.length);
    const s = await (await fetch(base + '/status', { headers: { 'x-voice-code': '123456' } })).json();
    assert.equal(s.workers, 2);
    assert.deepEqual(s.shares.map(x => x.rendered), [mine.length, theirs.length]);
  } finally { server.close(); peer.server.close(); }
});

test('a peer that can take several at once is given several, as a GPU needs', async () => {
  let now = 0, most = 0;
  const wide = {
    info: {},
    generate: async function () {
      most = Math.max(most, ++now);
      await new Promise(r => setTimeout(r, 40));
      now--;
      return { pcm: new Float32Array(240).fill(0.5), rate: 24000 };
    },
  };
  const peerServer = createVoiceServer({ code: '123456', engine: wide, slots: 4 });
  await new Promise(r => peerServer.listen(0, '127.0.0.1', r));
  const peerAddr = '127.0.0.1:' + peerServer.address().port;
  const { server, base } = await startWithPeers(timedEngine(1000, []), [peerAddr]);
  try {
    // The first answer says how many it takes; after that it is kept that busy.
    // Two, so one reaches the peer while this computer holds the other.
    await Promise.all([render(base, 'warm 1'), render(base, 'warm 2')]);
    most = 0;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => render(base, 'part ' + i)));
    assert.deepEqual(rs.map(r => r.status), rs.map(() => 200));
    assert.equal(most, 4, 'the peer rendered 4 at once, not 1');
  } finally { server.close(); peerServer.close(); }
});

test('one computer renders on its GPU and its processor at once', async () => {
  const cpu = [], card = [];
  const server = createVoiceServer({ code: '123456', engine: timedEngine(30, cpu), gpu: timedEngine(30, card), gpuSlots: 3 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => render(base, 'part ' + i)));
    assert.deepEqual(rs.map(r => r.status), rs.map(() => 200));
    assert.equal(cpu.length + card.length, 12, 'each part rendered once');
    assert.ok(card.length > cpu.length, 'the GPU, taking 3 at once, did more: ' + card.length + ' vs ' + cpu.length);
    assert.ok(cpu.length >= 1, 'the processor did some too');
    assert.equal(rs[0].headers.get('x-slots'), '4', 'tells a main computer it takes 3 + 1');
  } finally { server.close(); }
});

test('a GPU service that stops leaves the processor rendering', async () => {
  const cpu = [];
  const broken = { info: {}, generate: async () => { throw new Error('connection refused'); } };
  const server = createVoiceServer({ code: '123456', engine: timedEngine(5, cpu), gpu: broken });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const rs = await Promise.all(Array.from({ length: 4 }, (_, i) => render(base, 'part ' + i)));
    assert.deepEqual(rs.map(r => r.status), [200, 200, 200, 200]);
    assert.equal(cpu.length, 4);
  } finally { server.close(); }
});

test('Phonon voices go to Phonon, started only when first asked for', async () => {
  const kokoro = [], card = [], pn = [];
  let started = 0;
  const server = createVoiceServer({
    code: '123456', engine: timedEngine(5, kokoro), gpu: timedEngine(5, card), gpuSlots: 4,
    phonon: function () { started++; return timedEngine(5, pn); },
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const say = (t, voice) => fetch(base + '/render', {
    method: 'POST', headers: { 'x-voice-code': '123456' }, body: JSON.stringify({ text: t, voice }),
  });
  try {
    await Promise.all(Array.from({ length: 4 }, (_, i) => say('k ' + i, 'am_michael')));
    assert.equal(started, 0, 'a Kokoro book never starts Phonon');
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => say('p ' + i, 'pn_trevor_13')));
    assert.deepEqual(rs.map(r => r.status), rs.map(() => 200));
    assert.equal(started, 1, 'started once');
    assert.equal(pn.length, 6, 'every Phonon part rendered by Phonon');
    assert.ok([...kokoro, ...card].every(t => t.startsWith('k ')), 'neither Kokoro nor the GPU took a Phonon part');
  } finally { server.close(); }
});

test('a computer without Phonon says so instead of rendering it in Kokoro', async () => {
  const kokoro = [];
  const { server, base } = await start(timedEngine(5, kokoro));
  try {
    const r = await render(base, 'hello');            // a Kokoro voice still works
    assert.equal(r.status, 200);
    const p = await fetch(base + '/render', {
      method: 'POST', headers: { 'x-voice-code': '123456' }, body: JSON.stringify({ text: 'hi', voice: 'pn_trevor_13' }),
    });
    assert.equal(p.status, 500);
    assert.match(await p.text(), /no Phonon/);
    assert.equal(kokoro.length, 1);
  } finally { server.close(); }
});

test('a peer that is gone or has another code never stops the book', async () => {
  const mine = [], theirs = [];
  const wrongCode = await start(timedEngine(5, theirs), '999999');
  const { server, base } = await startWithPeers(timedEngine(5, mine), ['127.0.0.1:1', wrongCode.base]);
  try {
    const rs = await Promise.all(['a', 'b', 'c', 'd'].map(t => render(base, t)));
    assert.deepEqual(rs.map(r => r.status), [200, 200, 200, 200]);
    assert.equal(mine.length, 4, 'this computer covered every part');
    assert.equal(theirs.length, 0);
    const s = await (await fetch(base + '/status', { headers: { 'x-voice-code': '123456' } })).json();
    assert.deepEqual(s.shares.map(x => x.resting), [false, true, true]);
  } finally { server.close(); wrongCode.server.close(); }
});
