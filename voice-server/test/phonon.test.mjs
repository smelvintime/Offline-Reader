import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensurePhononFiles, isPhononVoice, phononVoice, PHONON_VOICES } from '../phonon.mjs';

test('Phonon voices are the pn_ ones', () => {
  assert.equal(isPhononVoice('pn_trevor'), true);
  assert.equal(isPhononVoice('am_michael'), false);
  assert.ok(PHONON_VOICES.pn_trevor);
});

test('the pace is the end of the voice id, from 1.0x to 1.4x', () => {
  assert.deepEqual(phononVoice('pn_trevor_13'), { name: 'pn_trevor', delta: -0.4 });
  assert.deepEqual(phononVoice('pn_trevor_10'), { name: 'pn_trevor', delta: 0 });
  assert.deepEqual(phononVoice('pn_trevor_14'), { name: 'pn_trevor', delta: -0.6 });
  assert.equal(phononVoice('pn_trevor_15'), null, 'past what the model can do');
  assert.equal(phononVoice('pn_trevor'), null, 'a pace is required');
  assert.equal(phononVoice('pn_nobody_13'), null);
});

test('the files are fetched once, from pinned revisions, never left half written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phonon-'));
  const asked = [];
  const fake = async url => { asked.push(url); return new Response('bytes of ' + url.split('/').pop()); };
  await ensurePhononFiles({ dir, fetch: fake });
  assert.equal(asked.length, 4, 'three model files and one voice');
  assert.ok(asked.every(u => /\/resolve\/[0-9a-f]{40}\//.test(u)), 'every URL names a commit');
  const files = (await readdir(dir)).sort();
  assert.deepEqual(files, ['config.json', 'model.q8.gguf', 'pn_trevor.safetensors', 'tokenizer.json']);
  assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), 'bytes of config.json');
  await ensurePhononFiles({ dir, fetch: fake });
  assert.equal(asked.length, 4, 'nothing fetched again');
});

test('a failed download stops with the reason and leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phonon-'));
  await assert.rejects(ensurePhononFiles({ dir, fetch: async () => new Response('no', { status: 404 }) }), /404/);
  assert.deepEqual(await readdir(dir), []);
});
