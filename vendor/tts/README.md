# vendor/tts — the natural-voice engine, self-hosted

These files are the on-device neural text-to-speech engine behind the novel
reader's **Natural voice** (see `js/novel-voice.js` and
`docs/ARCHITECTURE.md` §2.14). They are vendored, exactly like
`jszip.min.js`, because this app self-hosts every line of code it runs: no
CDN is consulted at runtime, and the service worker can keep the engine for
offline use the first time someone enables it.

| file | what it is | licence |
| --- | --- | --- |
| `kokoro.web.js` | [kokoro-js](https://www.npmjs.com/package/kokoro-js) **1.2.1** web bundle — inlines @huggingface/transformers 3.8.1 and phonemizer 1.2.1 | Apache-2.0 (`LICENSE-kokoro-js`) |
| `ort-wasm-simd-threaded.jsep.mjs` / `.wasm` | ONNX Runtime Web 1.21 runtime, as shipped inside @huggingface/transformers 3.8.1 `dist/` — the exact pair `kokoro.web.js` asks for | MIT (© Microsoft, see the ONNX Runtime repository) |

None of this is loaded at app boot. `js/novel-voice.js` spawns
`js/novel-voice-worker.js` only when a reader enables the Natural voice, and
the worker imports `kokoro.web.js` from here, pointing ONNX Runtime's
`wasmPaths` at this directory instead of its default CDN.

The **model weights are not in this repository** (a download, not a commit),
but they can be in the BUILD, and for the native app they should be:

```bash
node scripts/fetch-voice-model.mjs      # → vendor/tts/models/, vendor/tts/voices/
npm run sync                            # carries them into www/ and the app
```

The fetch script still bundles q8 and fp32 for compatibility. Browser inference
uses q8; native inference prefers fp32. Native startup now uses the public
KokoroTTS constructor with the application tokenizer adapter and native model
callable, so it does not create or dispose a browser ONNX session first.
Phonemization, voice embedding selection and WAV preparation remain in the
worker. See docs/mobile/PERFORMANCE.md for validation and packaging follow-up.

Both directories are gitignored. `js/novel-voice-worker.js` points
transformers.js's `localModelPath` at `vendor/tts/models/`, and transformers.js
tries a local file **before** the network, so one code path serves both builds:
a bundle with the weights never reaches huggingface.co, and a bundle without
them 404s locally and downloads exactly as it always did.

Voice embeddings need a second trick. kokoro-js hardcodes its voice URL with no
env hook, but it checks the Cache API first — so the worker writes the bundled
`.bin` files into the `kokoro-voices` cache under the URL kokoro-js will ask
for, and the unmodified bundle finds them there. Patching `vendor/` would have
been the other way to do it, and vendored code is not ours to edit.

Without a bundle, the download path stands: the worker fetches Kokoro-82M from
`huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX` the first time the
voice is enabled; transformers.js stores it in the browser's Cache API
(`transformers-cache`, voice embeddings in `kokoro-voices`), so every later
session — including fully offline ones — reads it from disk. Kokoro-82M's
weights are Apache-2.0.

## Regenerating

There is no build step, matching the rest of the repository. To bump the
engine:

```bash
npm install kokoro-js@<version>
cp node_modules/kokoro-js/dist/kokoro.web.js                              vendor/tts/
cp node_modules/kokoro-js/LICENSE                                         vendor/tts/LICENSE-kokoro-js
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs  vendor/tts/
cp node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm vendor/tts/
```

The `.mjs`/`.wasm` pair MUST come from the same `@huggingface/transformers`
version the new `kokoro.web.js` inlines (check `dependencies` in
kokoro-js's package.json) — ONNX Runtime's JS glue and its wasm binary are
matched artifacts, and mixing versions fails at init, not at review. Then
update the version numbers in the table above and in `COPYRIGHT.md`.
