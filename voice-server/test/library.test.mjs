// node --test, no install: the engine is a fake, so kokoro-js is never loaded,
// and every book is written into a temporary folder that the test removes.
//
// Books are stored as WAV here (`compress: false`) so the tests pass on a
// machine without ffmpeg. The one test that does compress skips itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLibrary, bookDir, partName, summary, haveFfmpeg, LIBRARY_VERSION } from '../library.mjs';
import { createJobs } from '../jobs.mjs';
import { writeZip, crc32 } from '../zip.mjs';
import { createVoiceServer, encodeWav } from '../server.mjs';

// ── Scaffolding ─────────────────────────────────────────────────────────────

function tempRoot() { return mkdtemp(join(tmpdir(), 'or-library-')); }

function fakeEngine(calls, ms) {
  return {
    info: { model: 'fake', dtype: 'fp32', cores: 1 },
    generate: async function (text, voice) {
      calls.push({ text, voice });
      if (ms) await new Promise(r => setTimeout(r, ms));
      const pcm = new Float32Array(2400);
      for (let i = 240; i < 2160; i++) pcm[i] = 0.5 * Math.sin(i / 10);
      return { pcm, rate: 24000 };
    },
  };
}

/** A pool like createPool's, without the HTTP or the peers. */
function fakePool(calls, fail) {
  let active = 0, peak = 0;
  return {
    peak: () => peak,
    render: async function (text) {
      active++; peak = Math.max(peak, active);
      try {
        await new Promise(r => setTimeout(r, 5));
        calls.push(text);
        if (fail && fail(text)) throw new Error('rendering ' + text + ' failed');
        return { wav: Buffer.from('wav:' + text), seconds: 1.5, ms: 5 };
      } finally { active--; }
    },
  };
}

function parts(n, book) {
  return Array.from({ length: n }, (_, i) => ({
    key: [1, book || 'test-book', 'ch1', 'af_heart', 0, i, i, 'h' + i].join('|'),
    text: 'Part ' + i + '.',
  }));
}

const job = (over) => Object.assign({
  book: 'test-book', title: 'A Test Book', voice: 'af_heart', parts: parts(4),
}, over);

/** Reads a store-only zip back, checking every CRC. → Map<name, Buffer> */
function readZip(buf) {
  const eocd = buf.length - 22;           // no archive comment, so it is last
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header ' + i);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(off), 0x04034b50, 'local header of ' + name);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const body = buf.subarray(start, start + size);
    assert.equal(crc32(body), crc, 'crc of ' + name);
    out.set(name, Buffer.from(body));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function until(check, what) {
  for (let i = 0; i < 500; i++) {
    const v = await check();
    if (v) return v;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out waiting for ' + what);
}

// ── The zip ─────────────────────────────────────────────────────────────────

test('the bundle is a zip that unpacks to what went in', async () => {
  const chunks = [];
  const out = { write: c => { chunks.push(Buffer.from(c)); return true; }, once: () => {} };
  const files = [
    { name: 'book.json', body: Buffer.from('{"v":1}') },
    { name: 'parts/one.m4a', body: Buffer.from([0, 1, 2, 253, 254, 255]) },
    { name: 'parts/two.m4a', body: Buffer.alloc(0) },
  ];
  const n = await writeZip(out, files);
  assert.equal(n, 3);
  const back = readZip(Buffer.concat(chunks));
  assert.equal(back.size, 3);
  assert.equal(back.get('book.json').toString(), '{"v":1}');
  assert.deepEqual([...back.get('parts/one.m4a')], [0, 1, 2, 253, 254, 255]);
  assert.equal(back.get('parts/two.m4a').length, 0, 'an empty entry is still an entry');
});

// ── The library ─────────────────────────────────────────────────────────────

test('a folder name is readable and unique per book', () => {
  assert.match(bookDir('urn:x:1', 'The Blade Itself'), /^the-blade-itself-[0-9a-f]{8}$/);
  assert.notEqual(bookDir('a', 'Same Title'), bookDir('b', 'Same Title'));
  assert.match(bookDir('urn:x:1', ''), /^urn-x-1-[0-9a-f]{8}$/);
  assert.match(bookDir('', ''), /^book-[0-9a-f]{8}$/);
  // A key is never a path, however it is spelled.
  assert.match(partName('1|../../etc/passwd|x', 'm4a'), /^[0-9a-f]{16}\.m4a$/);
});

test('accepting a book writes it down, and accepting it again resumes', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const first = await lib.accept(job());
    assert.equal(first.pending.length, 4);
    assert.equal(first.manifest.dir, bookDir('test-book', 'A Test Book'));

    const m = first.manifest;
    await lib.put(m, m.parts[0], Buffer.from('audio'), 2.5);
    await lib.put(m, m.parts[1], Buffer.from('audio'), 2.5);
    await lib.release(m);

    const on = JSON.parse(await readFile(join(root, m.dir, 'book.json'), 'utf8'));
    assert.equal(on.v, LIBRARY_VERSION);
    assert.equal(on.parts.length, 4);
    assert.equal(on.parts[0].seconds, 2.5);
    assert.ok(on.parts[0].text, 'the text is kept, so a restart can carry on');

    // Posting the same book again leaves the two rendered parts alone.
    const again = await lib.accept(job());
    assert.equal(again.pending.length, 2);
    assert.deepEqual(again.pending.map(p => p.key), [m.parts[2].key, m.parts[3].key]);
    assert.equal(summary(again.manifest).done, 2);
    assert.equal(summary(again.manifest).ready, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('audio on disk that book.json never recorded is claimed, not rendered again', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const { manifest } = await lib.accept(job());
    await lib.put(manifest, manifest.parts[0], Buffer.from('audio'), 1);
    await lib.put(manifest, manifest.parts[1], Buffer.from('audio'), 1);
    // A kill before the debounced write: the files are there, book.json is
    // the one written when the book arrived and mentions neither of them.
    await writeFile(join(root, manifest.dir, 'book.json'), JSON.stringify({
      v: LIBRARY_VERSION, book: 'test-book', title: 'A Test Book', voice: 'af_heart',
      dir: manifest.dir, created: Date.now(), seq: 0,
      parts: job().parts.map(p => ({ key: p.key, text: p.text, file: null, seconds: 0, bytes: 0, seq: 0 })),
    }));

    const back = await createLibrary({ root, compress: false }).accept(job());
    assert.equal(back.pending.length, 2, 'only the two that were never rendered');
    assert.equal(summary(back.manifest).done, 2, 'the other two were found on disk');
    assert.ok(summary(back.manifest).bytes > 0, 'and measured');
    const seqs = back.manifest.parts.filter(p => p.file).map(p => p.seq);
    assert.equal(new Set(seqs).size, 2, 'each claimed part got its own number');
    assert.ok(seqs.every(s => s > 0), 'so a phone can still collect them: ' + seqs);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a part whose file went missing is pending again', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const { manifest } = await lib.accept(job());
    await lib.put(manifest, manifest.parts[0], Buffer.from('audio'), 1);
    await lib.release(manifest);
    await rm(join(root, manifest.dir, 'parts', manifest.parts[0].file));

    const back = await lib.accept(job());
    assert.equal(back.pending.length, 4, 'the deleted part is wanted again');
    assert.equal(summary(back.manifest).done, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('changing the voice starts the audio over', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const { manifest } = await lib.accept(job());
    await lib.put(manifest, manifest.parts[0], Buffer.from('audio'), 1);
    await lib.release(manifest);

    const other = await lib.accept(job({ voice: 'af_bella' }));
    assert.equal(other.manifest.voice, 'af_bella');
    assert.equal(other.pending.length, 4);
    assert.equal((await readdir(join(root, other.manifest.dir, 'parts'))).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a half-written folder in the library is skipped, not fatal', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const { manifest } = await lib.accept(job());
    await lib.release(manifest);
    await mkdir(join(root, 'not-ours'), { recursive: true });
    await writeFile(join(root, 'not-ours', 'book.json'), 'this is not JSON');
    const books = await lib.list();
    assert.equal(books.length, 1);
    assert.equal(books[0].book, 'test-book');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removing a book takes its folder with it', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const { manifest } = await lib.accept(job());
    await lib.release(manifest);
    assert.equal(await lib.remove('test-book'), true);
    assert.equal(await lib.remove('test-book'), false);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('with ffmpeg, a part is stored compressed', { skip: (await haveFfmpeg()) ? false : 'ffmpeg is not installed' }, async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: true });
    assert.equal(lib.compress, true);
    // Half a second of tone as a real 24 kHz 16-bit WAV.
    const pcm = new Float32Array(12000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = 0.4 * Math.sin(i / 8);
    const wav = encodeWav(pcm, 24000);

    const { manifest } = await lib.accept(job({ parts: parts(1) }));
    await lib.put(manifest, manifest.parts[0], wav, 0.5);
    assert.match(manifest.parts[0].file, /\.m4a$/);
    assert.ok(manifest.parts[0].bytes > 0);
    assert.ok(manifest.parts[0].bytes < wav.length, 'smaller than the WAV it came from');
    const bytes = await lib.readPart(manifest, manifest.parts[0]);
    assert.equal(bytes.toString('ascii', 4, 8), 'ftyp', 'an MP4 container');
    await lib.release(manifest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ── The job queue ───────────────────────────────────────────────────────────

test('a posted book renders every part, several computers at a time', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const rendered = [];
    const pool = fakePool(rendered);
    const jobs = createJobs({ library: lib, pool, width: () => 3 });

    const started = await jobs.start(job({ parts: parts(9) }));
    assert.equal(started.total, 9);
    assert.equal(started.running, true);

    const end = await until(async () => {
      const s = await jobs.state('test-book');
      return s.done === 9 ? s : null;
    }, 'the book to finish');
    assert.equal(end.failed, 0);
    assert.equal(end.ready, true);
    assert.equal(rendered.length, 9, 'each part rendered once');
    assert.ok(pool.peak() > 1, 'more than one at a time: ' + pool.peak());
    assert.ok(pool.peak() <= 3, 'never more than the width: ' + pool.peak());
    assert.ok(end.msPerPart > 0, 'the speed is measured, not guessed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('one part that fails does not cost the rest of the book', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const pool = fakePool([], t => t === 'Part 2.');
    const jobs = createJobs({ library: lib, pool, width: () => 2 });
    await jobs.start(job({ parts: parts(5) }));

    const end = await until(async () => {
      const s = await jobs.state('test-book');
      return s.running ? null : s;
    }, 'the book to stop');
    assert.equal(end.done, 4);
    assert.equal(end.failed, 1);
    assert.equal(end.ready, false);
    assert.match(end.lastError, /Part 2/);

    // Posting it again asks only for the part that failed.
    const retry = await lib.accept(job({ parts: parts(5) }));
    assert.deepEqual(retry.pending.map(p => p.text), ['Part 2.']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stopping keeps what is rendered and leaves the rest pending', async () => {
  const root = await tempRoot();
  try {
    const lib = createLibrary({ root, compress: false });
    const jobs = createJobs({ library: lib, pool: fakePool([]), width: () => 1 });
    await jobs.start(job({ parts: parts(40) }));
    await until(async () => (await jobs.state('test-book')).done > 0, 'the first part');
    assert.equal(jobs.cancel('test-book'), true);

    const end = await until(async () => {
      const s = await jobs.state('test-book');
      return s.running ? null : s;
    }, 'the job to stop');
    assert.ok(end.done > 0 && end.done < 40, 'stopped part way: ' + end.done);
    assert.equal(jobs.cancel('test-book'), false, 'nothing left to stop');
    const after = await lib.accept(job({ parts: parts(40) }));
    assert.equal(after.pending.length, 40 - end.done, 'the rest is still wanted');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unfinished book carries on when the server starts again', async () => {
  const root = await tempRoot();
  try {
    const first = createJobs({ library: createLibrary({ root, compress: false }), pool: fakePool([]), width: () => 1 });
    await first.start(job({ parts: parts(20) }));
    await until(async () => (await first.state('test-book')).done >= 2, 'a couple of parts');
    first.cancel('test-book');
    const stopped = await until(async () => {
      const s = await first.state('test-book');
      return s.running ? null : s;
    }, 'the job to stop');

    // A new server over the same folder, as a restart would be.
    const rendered = [];
    const lib = createLibrary({ root, compress: false });
    const jobs = createJobs({ library: lib, pool: fakePool(rendered), width: () => 2 });
    assert.equal(await jobs.resumeAll(), 1);
    const end = await until(async () => {
      const s = await jobs.state('test-book');
      return s.done === 20 ? s : null;
    }, 'the book to finish');
    assert.equal(end.ready, true);
    assert.equal(rendered.length, 20 - stopped.done, 'only the parts that were left');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ── Over HTTP ───────────────────────────────────────────────────────────────

async function serve(root, engine) {
  const library = createLibrary({ root, compress: false });
  const server = createVoiceServer({ code: '123456', engine: engine || fakeEngine([]), library });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, library, base: 'http://127.0.0.1:' + server.address().port };
}

const ask = (base, path, init) => fetch(base + path,
  Object.assign({ headers: { 'content-type': 'application/json', 'x-voice-code': '123456' } }, init));

const post = (base, path, body) => ask(base, path, { method: 'POST', body: JSON.stringify(body) });

test('post a book, come back later, download it as one zip', async () => {
  const root = await tempRoot();
  const { server, base } = await serve(root);
  try {
    const r = await post(base, '/job', job({ parts: parts(3) }));
    assert.equal(r.status, 202, 'taken at once, and rendering outlives the request');
    const taken = await r.json();
    assert.equal(taken.total, 3);
    assert.equal(taken.book, 'test-book');

    const done = await until(async () => {
      const s = await (await ask(base, '/job?book=test-book')).json();
      return s.ready ? s : null;
    }, 'the book to be ready');
    assert.equal(done.done, 3);
    assert.ok(done.bytes > 0);

    const bundle = await ask(base, '/bundle?book=test-book');
    assert.equal(bundle.status, 200);
    assert.equal(bundle.headers.get('content-type'), 'application/zip');
    assert.equal(bundle.headers.get('x-parts'), '3');
    assert.match(bundle.headers.get('content-disposition'), /a-test-book-[0-9a-f]{8}\.zip/);

    const zip = readZip(Buffer.from(await bundle.arrayBuffer()));
    const manifest = JSON.parse(zip.get('book.json').toString());
    assert.equal(manifest.parts.length, 3);
    assert.equal(manifest.voice, 'af_heart');
    assert.equal(manifest.total, 3);
    assert.ok(!('text' in manifest.parts[0]), 'the text stays on the computer');
    for (const p of manifest.parts) {
      const body = zip.get('parts/' + p.file);
      assert.ok(body, p.file + ' is in the zip');
      assert.equal(body.length, p.bytes);
      assert.equal(body.toString('ascii', 0, 4), 'RIFF');
    }
    // Every key the phone asked for came back.
    assert.deepEqual(manifest.parts.map(p => p.key).sort(), parts(3).map(p => p.key).sort());
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('a second collection brings only what is new', async () => {
  const root = await tempRoot();
  const { server, base } = await serve(root);
  try {
    await post(base, '/job', job({ parts: parts(4) }));
    await until(async () => (await (await ask(base, '/job?book=test-book')).json()).ready, 'the book');

    const rest = await ask(base, '/bundle?book=test-book&from=2');
    assert.equal(rest.status, 200);
    assert.equal(rest.headers.get('x-parts'), '2');
    assert.equal(rest.headers.get('x-ready'), '4');
    const zip = readZip(Buffer.from(await rest.arrayBuffer()));
    assert.equal(JSON.parse(zip.get('book.json').toString()).parts.length, 2);
    assert.equal(zip.size, 3, 'two parts and the manifest');

    assert.equal((await ask(base, '/bundle?book=test-book&from=4')).status, 404);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

const bundleOf = async (base, from) => {
  const r = await ask(base, '/bundle?book=test-book' + (from === undefined ? '' : '&from=' + from));
  if (r.status !== 200) return { status: r.status, keys: [] };
  const zip = readZip(Buffer.from(await r.arrayBuffer()));
  const m = JSON.parse(zip.get('book.json').toString());
  return { status: 200, next: Number(r.headers.get('x-next')), keys: m.parts.map(p => p.key) };
};

/** Stores one part out of the list's order, as a second computer or a retry does. */
async function store(root, which) {
  const lib = createLibrary({ root, compress: false });
  const { manifest } = await lib.accept(job({ parts: parts(3) }));
  await lib.put(manifest, manifest.parts[which], Buffer.from('audio ' + which), 1);
  await lib.release(manifest);
}

test('a part that finishes late is still collected', async () => {
  const root = await tempRoot();
  // Part 1 lands before part 0: what happens whenever two computers render at
  // once, or a part that failed is rendered on a later pass.
  await store(root, 1);
  const { server, base } = await serve(root);
  try {
    const first = await bundleOf(base);
    assert.deepEqual(first.keys, [parts(3)[1].key], 'only the part that is done');

    await store(root, 0);
    await store(root, 2);

    // A position in the list would hand back part 1 again and lose part 0.
    const rest = await bundleOf(base, first.next);
    assert.deepEqual(rest.keys.sort(), [parts(3)[0].key, parts(3)[2].key].sort(),
      'the late part came, and the one already held did not come twice');
    assert.equal((await bundleOf(base, rest.next)).status, 404, 'and then there is nothing new');
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('a book is collected in passes, and the manifest says what is missing', async () => {
  const root = await tempRoot();
  const { server, base } = await serve(root);
  try {
    await post(base, '/job', job({ parts: parts(5) }));
    await until(async () => (await (await ask(base, '/job?book=test-book')).json()).ready, 'the book');

    const man = await (await ask(base, '/manifest?book=test-book')).json();
    assert.equal(man.parts.length, 5);
    assert.deepEqual(man.parts.map(p => p.key).sort(), parts(5).map(p => p.key).sort());
    assert.ok(man.parts.every(p => p.seq > 0), 'every part has landed');
    assert.ok(!('text' in man.parts[0]), 'keys only, no text and no audio');

    const seen = [];
    let from = 0;
    for (let pass = 0; pass < 10; pass++) {
      const r = await ask(base, '/bundle?book=test-book&limit=2&from=' + from);
      if (r.status === 404) break;
      assert.ok(Number(r.headers.get('x-parts')) <= 2, 'a pass is no bigger than asked');
      const m = JSON.parse(readZip(Buffer.from(await r.arrayBuffer())).get('book.json').toString());
      m.parts.forEach(p => seen.push(p.key));
      from = m.next;
    }
    assert.deepEqual(seen.sort(), parts(5).map(p => p.key).sort(), 'three passes brought all five, once each');
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('the book routes say no to a wrong code, a bad book and an unknown one', async () => {
  const root = await tempRoot();
  const { server, base } = await serve(root);
  try {
    const noCode = await fetch(base + '/job', { method: 'POST', body: '{}' });
    assert.equal(noCode.status, 401);
    assert.equal((await post(base, '/job', { book: '', voice: 'af_heart' })).status, 400);
    assert.equal((await post(base, '/job', { book: 'b', voice: '../etc' })).status, 400);
    assert.equal((await post(base, '/job', { book: 'b', voice: 'af_heart', parts: 'no' })).status, 400);
    assert.equal((await post(base, '/job', { book: 'b', voice: 'af_heart', parts: [{ key: 'k', text: '  ' }] })).status, 400);
    assert.equal((await ask(base, '/job?book=nope')).status, 404);
    assert.equal((await ask(base, '/bundle?book=nope')).status, 404);
    assert.deepEqual((await (await ask(base, '/books')).json()).books, []);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('a book that is not ready yet has nothing to collect', async () => {
  const root = await tempRoot();
  // Slow enough that the bundle is asked for mid-render.
  const { server, base } = await serve(root, fakeEngine([], 60));
  try {
    await post(base, '/job', job({ parts: parts(6) }));
    const early = await ask(base, '/bundle?book=test-book');
    assert.equal(early.status, 404);
    assert.match((await early.json()).error, /no part of this book is ready/);

    const mid = await (await ask(base, '/job?book=test-book')).json();
    assert.equal(mid.running, true);
    assert.equal(mid.ready, false);
    assert.equal((await post(base, '/job/stop?book=test-book')).status, 200);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('deleting a book frees the disk and forgets it', async () => {
  const root = await tempRoot();
  const { server, base } = await serve(root);
  try {
    await post(base, '/job', job({ parts: parts(2) }));
    await until(async () => (await (await ask(base, '/job?book=test-book')).json()).ready, 'the book');
    assert.equal((await (await ask(base, '/books')).json()).books.length, 1);

    const gone = await ask(base, '/book?book=test-book', { method: 'DELETE' });
    assert.equal(gone.status, 200);
    assert.deepEqual((await (await ask(base, '/books')).json()).books, []);
    assert.equal((await ask(base, '/book?book=test-book', { method: 'DELETE' })).status, 404);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test('a render-only server keeps books out of it', async () => {
  const server = createVoiceServer({ code: '123456', engine: fakeEngine([]) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await ask(base, '/books')).status, 404);
    assert.equal((await post(base, '/job', job())).status, 404);
    const s = await (await ask(base, '/status')).json();
    assert.equal(s.library, null);
    assert.equal(s.ready, true, 'and it still renders');
  } finally { server.close(); }
});

test('a book posted while the voice is still loading is taken, not dropped', async () => {
  const root = await tempRoot();
  let arrive;
  const library = createLibrary({ root, compress: false });
  const server = createVoiceServer({ code: '123456', engine: new Promise(r => { arrive = r; }), library });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const r = await post(base, '/job', job({ parts: parts(2) }));
    assert.equal(r.status, 202, 'the phone is free whether or not the voice has loaded');
    assert.equal((await (await ask(base, '/job?book=test-book')).json()).done, 0);

    arrive(fakeEngine([]));
    const end = await until(async () => {
      const s = await (await ask(base, '/job?book=test-book')).json();
      return s.ready ? s : null;
    }, 'the book once the voice arrived');
    assert.equal(end.done, 2);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
