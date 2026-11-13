// Phonon (gradium/phonon-31m-en), the second voice this server speaks with.
//
// Kokoro stays for every voice the phone also has. Phonon voices are named
// `pn_…` and exist only here: the phone has no Phonon, so a book in one of
// them is always prepared by a computer and never filled in on the phone.
//
// It runs as the npm package's WebAssembly build, in copies like Kokoro's
// (phonon-worker.mjs), so it needs no Python and runs the same on a Mac and
// on Windows. One copy on one core makes about five times real time.

import { mkdir, readFile, rename, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Pinned, so a book prepared today and a chapter re-rendered next month are
// the same voice: a new upload of either repo changes nothing here.
const MODEL_REPO = 'gradium/phonon-31m-en';
const MODEL_REV = '92741c5b07d085ff840e26fea8ce43110b87852f';
const VOICES_REPO = 'gradium/phonon-voices';
const VOICES_REV = 'da6c9ec0d47be8df5c87c730a3aa97187f3229c3';
const MODEL_FILES = ['config.json', 'tokenizer.json', 'model.q8.gguf'];

export const PHONON_MODEL = MODEL_REPO + '@' + MODEL_REV.slice(0, 8);

// The app's id → the catalog's voice file. Only the voices someone chose.
export const PHONON_VOICES = { pn_trevor: '0zLApsZfVLLNaEGl' };

// Pace is spoken into the audio, not applied at playback, so it is part of
// the voice id: `pn_trevor_13` is Trevor at 1.3x. A book at one pace and the
// same book at another are two voices to the app and to the library, which is
// what keeps a half-prepared book from changing speed partway through.
// Measured over a 90-second passage: -0.2 is 1.19x, -0.4 1.31x, -0.6 1.42x.
// Past -0.6 the model slows down again (1.31x at -0.8), so 1.4x is the top.
export const PHONON_PACES = { 10: 0, 11: -0.1, 12: -0.2, 13: -0.4, 14: -0.6 };

// 0.8 is the model's own temperature, what the voice was chosen on. The seed
// makes the same text come out the same every time.
export const PHONON_TEMPERATURE = 0.8;
export const PHONON_SEED = 7n;

export function isPhononVoice(voice) { return /^pn_/.test(String(voice || '')); }

/** 'pn_trevor_13' → { name: 'pn_trevor', delta: -0.4 }, or null if not a known voice and pace. */
export function phononVoice(voice) {
  const m = /^(pn_[a-z]+)_(\d{2})$/.exec(String(voice || ''));
  if (!m || !PHONON_VOICES[m[1]] || !(m[2] in PHONON_PACES)) return null;
  return { name: m[1], delta: PHONON_PACES[m[2]] };
}

const DEFAULT_DIR = fileURLToPath(new URL('./.cache/phonon/', import.meta.url));

/**
 * The model and the voices on disk, fetched the first time (about 65 MB).
 * The copies only read them, so they never race to download.
 * → the directory holding them
 */
export async function ensurePhononFiles(options) {
  const o = options || {};
  const dir = o.dir || DEFAULT_DIR;
  const log = o.log || function () {};
  const get = o.fetch || fetch;
  const want = MODEL_FILES.map(function (f) {
    return { url: hfUrl(MODEL_REPO, MODEL_REV, f), to: join(dir, f) };
  }).concat(Object.keys(PHONON_VOICES).map(function (id) {
    return { url: hfUrl(VOICES_REPO, VOICES_REV, 'voices/' + PHONON_VOICES[id] + '.safetensors'), to: join(dir, id + '.safetensors') };
  }));
  await mkdir(dir, { recursive: true });
  for (const w of want) {
    if (await exists(w.to)) continue;
    log('downloading the Phonon voice: ' + w.url.split('/').pop());
    const res = await get(w.url);
    if (!res.ok) throw new Error('could not download ' + w.url + ': ' + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    // Written aside then moved, so a download cut short is never taken for a file.
    await writeFile(w.to + '.part', bytes);
    await rename(w.to + '.part', w.to);
  }
  return dir;
}

/** What a copy loads: the three model files and each voice's file. */
export async function readPhononFiles(dir) {
  const read = function (f) { return readFile(join(dir, f)).then(function (b) { return new Uint8Array(b); }); };
  const [config, tokenizer, model] = await Promise.all(MODEL_FILES.map(read));
  const voices = {};
  for (const id of Object.keys(PHONON_VOICES)) voices[id] = await read(id + '.safetensors');
  return { model: model, tokenizer: tokenizer, config: config, voices: voices };
}

function hfUrl(repo, rev, file) {
  return 'https://huggingface.co/' + repo + '/resolve/' + rev + '/' + file;
}

async function exists(p) {
  try { return (await stat(p)).size > 0; } catch (e) { return false; }
}
