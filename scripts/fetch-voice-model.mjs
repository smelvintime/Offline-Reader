#!/usr/bin/env node
// Put the Natural voice's weights INSIDE the app, so the phone never downloads
// them.
//
// The web build can afford to fetch the model on first use — a browser has a
// disk and a cache and a user who can wait. An installed app cannot: a reader
// who taps Listen on a train expects a voice, not a 90 MB progress bar, and on
// iOS that download lands in a WebView cache the OS may evict whenever it likes.
// So for the native build the weights ship in the bundle, and this is what puts
// them there.
//
//   node scripts/fetch-voice-model.mjs             # q8 (~88 MB) — what the app loads
//   node scripts/fetch-voice-model.mjs --list      # what the repo offers, with sizes
//
// q8 is the only dtype the app loads. --dtype still takes the others so their
// sizes can be compared against a phone's budget, but fetching one does not
// make the app use it.
//
// Output lands in vendor/tts/models/ and vendor/tts/voices/, both gitignored:
// ~90 MB is a download, not a commit (vendor/tts/README.md). scripts/sync-www.sh
// carries whatever is there into www/, and `cap sync` into the app.
//
// Nothing here is needed to serve the web app. Skip it and the runtime falls
// back to downloading on first use, exactly as before — js/novel-voice-worker.js
// tries local first and remote second, so one code path serves both builds.

import { createWriteStream, existsSync, mkdirSync, statSync, renameSync, rmSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { pipeline } from 'stream/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const HOST = 'https://huggingface.co';

// Mirrors js/novel-voice.js NEURAL_VOICES. Only the voices the app offers: the
// pack ships fifty-odd and half a megabyte each, and nobody is served by
// carrying the ones that are not in the picker.
const VOICES = [
  'af_heart', 'af_bella', 'af_nicole', 'bf_emma',
  'am_michael', 'am_fenrir', 'am_puck', 'bm_george',
];

// transformers.js's dtype → filename suffix mapping, which decides the ONNX
// file name. Keep in step with vendor/tts/kokoro.web.js if the engine is bumped.
const DTYPE_FILE = {
  fp32: 'model.onnx',
  fp16: 'model_fp16.onnx',
  q8: 'model_quantized.onnx',
  q4: 'model_q4.onnx',
  q4f16: 'model_q4f16.onnx',
};

// Everything from_pretrained() reads besides the weights. Small, but the model
// does not load without them.
const SUPPORT_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json'];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i === -1 ? fallback : (args[i + 1] || fallback);
};
const dtype = flag('dtype', 'q8');
const listOnly = args.includes('--list');

function die(msg) {
  console.error('fetch-voice-model: ' + msg);
  process.exit(1);
}

function human(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

async function head(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!r.ok) return null;
    const len = Number(r.headers.get('content-length'));
    return Number.isFinite(len) ? len : 0;
  } catch (e) { return null; }
}

/** Sizes straight from the repo, so this never hardcodes a number that rots. */
async function list() {
  console.log('fetch-voice-model: ' + MODEL_ID + '\n');
  const rows = [];
  for (const [name, file] of Object.entries(DTYPE_FILE)) {
    const size = await head(`${HOST}/${MODEL_ID}/resolve/main/onnx/${file}`);
    rows.push([name, file, size === null ? 'not published' : human(size)]);
  }
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [name, file, size] of rows) {
    console.log('  ' + name.padEnd(w) + '  ' + size.padStart(10) + '  ' + file);
  }
  console.log('\n  q8 is the default and the only one the app loads.');
  console.log('  A bigger file is a bigger memory footprint on the phone, not just a bigger download.');
}

/** Stream to a .part file and rename on success: a killed run leaves no half-file. */
async function download(url, dest, label) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log('  have  ' + label + '  (' + human(statSync(dest).size) + ')');
    return;
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die('HTTP ' + res.status + ' for ' + url);
  const total = Number(res.headers.get('content-length'));
  const part = dest + '.part';
  process.stdout.write('  get   ' + label + (total ? '  (' + human(total) + ')' : '') + ' … ');
  try {
    await pipeline(res.body, createWriteStream(part));
  } catch (e) {
    rmSync(part, { force: true });
    die('download failed for ' + label + ': ' + (e && e.message));
  }
  renameSync(part, dest);
  console.log('done');
}

if (listOnly) {
  await list();
  process.exit(0);
}

const file = DTYPE_FILE[dtype];
if (!file) die('unknown --dtype "' + dtype + '". One of: ' + Object.keys(DTYPE_FILE).join(', '));

const modelDir = join(root, 'vendor/tts/models', MODEL_ID);
const voiceDir = join(root, 'vendor/tts/voices');

console.log('fetch-voice-model: ' + MODEL_ID + ' (' + dtype + ') → vendor/tts/');

for (const name of SUPPORT_FILES) {
  await download(`${HOST}/${MODEL_ID}/resolve/main/${name}`, join(modelDir, name), name);
}
await download(
  `${HOST}/${MODEL_ID}/resolve/main/onnx/${file}`,
  join(modelDir, 'onnx', file),
  'onnx/' + file,
);
for (const voice of VOICES) {
  await download(
    `${HOST}/${MODEL_ID}/resolve/main/voices/${voice}.bin`,
    join(voiceDir, voice + '.bin'),
    'voices/' + voice + '.bin',
  );
}

console.log('\nfetch-voice-model: done. Run `npm run sync` to carry these into the app.');
console.log('The reader will now find them locally and never reach the network for a voice.');
