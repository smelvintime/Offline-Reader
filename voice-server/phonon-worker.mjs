// One copy of the Phonon voice, in a process of its own: engine-worker.mjs's
// twin, speaking the same IPC protocol, so farm.mjs and the tuner run it
// unchanged. PHONON_DIR names the files phonon.mjs fetched.
//
// The wasm module is single-threaded, which is what the farm wants anyway:
// one copy per core.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readPhononFiles, phononVoice, PHONON_PACES, PHONON_TEMPERATURE, PHONON_SEED } from './phonon.mjs';

function say(m) { if (process.send) process.send(m); }

async function load() {
  const pkg = dirname(createRequire(import.meta.url).resolve('phonon-tts/package.json'));
  // A URL, not a path: on Windows a path starts C:, which import() refuses.
  const wasm = await import(pathToFileURL(join(pkg, 'wasm/phonon_tts.js')).href);
  await wasm.default({ module_or_path: readFileSync(join(pkg, 'wasm/phonon_tts_simd_bg.wasm')) });
  const files = await readPhononFiles(process.env.PHONON_DIR);
  const engine = { wasm: wasm, files: files, paces: new Map() };
  // Proves the files load before saying ready, at the pace books usually ask for.
  await paced(engine, PHONON_PACES[13]);
  return engine;
}

// Pace is a condition fixed when a model loads, so each pace in use is its
// own loaded model (a quarter of a second and about 65 MB). A book uses one.
function paced(engine, delta) {
  if (!engine.paces.has(delta)) {
    const f = engine.files;
    engine.paces.set(delta, engine.wasm.Model.load(f.model, f.tokenizer, f.config, 'q8', 'en', null,
      ['duration_delta=' + delta], 'cpu').then(function (model) {
      const voices = {};
      for (const id of Object.keys(f.voices)) voices[id] = model.add_voice(f.voices[id]);
      return { model: model, voices: voices };
    }));
  }
  return engine.paces.get(delta);
}

async function generate(engine, text, voice) {
  const want = phononVoice(voice);
  if (!want) throw new Error('unknown Phonon voice ' + voice);
  const p = await paced(engine, want.delta);
  const v = p.voices[want.name];
  const m = p.model;
  const frames = [];
  let length = 0;
  m.start_generation(v, text, PHONON_TEMPERATURE, PHONON_SEED);
  while (m.next_chunk() !== undefined) {
    let f;
    while ((f = await m.generation_step()) !== undefined) { frames.push(f); length += f.length; }
  }
  const pcm = new Float32Array(length);
  let at = 0;
  for (const f of frames) { pcm.set(f, at); at += f.length; }
  return { pcm: pcm, rate: m.sample_rate() };
}

let engine = null;

process.on('message', async function (m) {
  if (!m || m.type !== 'generate') return;
  try {
    const out = await generate(engine, m.text, m.voice);
    say({ type: 'audio', id: m.id, pcm: out.pcm, rate: out.rate });
  } catch (e) {
    say({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
});

process.on('disconnect', function () { process.exit(0); });

load().then(function (e) {
  engine = e;
  say({ type: 'ready', threads: 1 });
}, function (e) {
  say({ type: 'failed', message: String((e && e.message) || e) });
  process.exitCode = 1;
  setTimeout(function () { process.exit(1); }, 50);
});
