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

The **model weights are not in this repository** (~90 MB is a download, not
a commit). The worker fetches Kokoro-82M from
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
