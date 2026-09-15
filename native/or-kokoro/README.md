# or-kokoro

Runs Kokoro's forward pass natively, so the voice a reader actually likes can
keep up with them.

## Why this exists

The model was never the problem. Kokoro-82M at q8 is 88 MB and already sits in
the app bundle; making it bigger would make it slower, not faster. What was slow
is **where it ran**: WebAssembly, single-threaded, inside a WebView sandbox.

Apple's own Premium voices are the same class of thing executed as native ARM
code, which is most of why theirs sound effortless and ours did not. Measured on
a real iPhone, the wasm path took minutes to speak a paragraph — not because the
phone is slow, but because a browser sandbox is the wrong place to run an
82-million-parameter model.

So this changes the execution path and nothing else. Same weights, same voices,
the same `model_quantized.onnx` the web build loads.

## Why ONNX Runtime and not Core ML directly

`coremltools` no longer converts ONNX. That route goes through PyTorch and a
re-export, and every step is a chance for the voice to come out subtly wrong.
ONNX Runtime loads the file we already ship, and its Core ML execution provider
hands over whatever the graph allows. A quantised model often falls back to CPU,
and that is fine — native ARM with NEON is already a different universe from
single-threaded wasm, which is the gap that mattered.

Which provider actually ran is reported back and shown on the app's engine line,
because "why is this slow" should never need a rebuild to answer.

## The seam

`js/novel-voice-worker.js` swaps one property:

```js
const { waveform } = await this.model({ input_ids, style, speed });
```

`tts.model` is a plain function property on the vendored engine, so everything
before it — phonemisation, tokenisation, the voice style slice, the text
splitter — stays exactly as the vendored code wrote it. Only the tensor maths
crosses the bridge. A worker cannot reach a Capacitor plugin, so the call goes
out to the main thread and comes back: one hop against an inference measured in
seconds.

## API

All methods degrade to `null` off-device, per ARCHITECTURE §2.3.

| Method | Returns |
| --- | --- |
| `available()` | `{ available, provider, loaded }` |
| `infer({ ids, style, speed })` | `{ pcm, sampleRate, provider, ms }` |
| `release()` | `void` |

`available: false` from a *present* plugin means the build shipped no weights —
a different problem from the plugin missing, with a different fix, so it gets a
different answer rather than a shared falsy one.

`pcm` is base64 little-endian **Int16** at 24 kHz. Int16 rather than float32
because the app encodes a 16-bit WAV from this anyway; sending floats would
double the bridge traffic to be truncated at the other end. Samples are clamped
to [-1, 1] and **rounded**, not truncated — `Int16(x)` truncates toward zero,
which biases every sample in the same direction rather than leaving the
symmetric error quantisation is supposed to have.

Inference runs on its own queue. Never the main thread: the reader has to stay
scrollable while the next paragraph renders.

## Dependencies

`onnxruntime-objc` (CocoaPods) / `onnxruntime-swift-package-manager` (SPM).
