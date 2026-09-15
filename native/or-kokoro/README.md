# or-kokoro

Runs Kokoro's forward pass natively, so the voice a reader actually likes can
keep up with them.

## Why this exists

The first problem was **where it ran**: WebAssembly, single-threaded, inside a
WebView sandbox.

Apple's own Premium voices are the same class of thing executed as native ARM
code, which is most of why theirs sound effortless and ours did not. Measured on
a real iPhone, the wasm path took minutes to speak a paragraph — not because the
phone is slow, but because a browser sandbox is the wrong place to run an
82-million-parameter model.

The second problem was **which weights**. This first shipped loading the same
`model_quantized.onnx` as the web build, on the reasoning that a smaller model
is a faster one. That is true of a download and false of this graph. q8 here is
*dynamic* quantisation: it rewrites the matmuls to int8 and wraps them in
quantise/dequantise pairs, leaves Kokoro's convolutions and its iSTFT decoder's
LSTMs in float, and pays a conversion at every boundary between the two. It
buys an 88 MB download instead of a 326 MB one, which is the right trade in a
browser and no trade at all in an app bundle that ships the file either way.

So `bundledWeights` prefers fp32, then fp16, then q8. A build that only has q8
runs exactly as it did before and says `q8` in the engine line; re-running
`scripts/fetch-voice-model.mjs` is what upgrades it. Only one session is ever
resident: the wasm session kokoro-js builds during `from_pretrained` is
disposed the moment the native one takes over.

Session options are set explicitly rather than left to defaults. Graph
optimisation runs at `.all`, and intra-op threads are pinned to half the
logical cores — the other half are efficiency cores, and handing them matmuls
makes the fast cores wait at every join.

## Why ONNX Runtime and not Core ML

`coremltools` no longer converts ONNX. That route goes through PyTorch and a
re-export, and every step is a chance for the voice to come out subtly wrong.
ONNX Runtime loads the file we already ship.

Its Core ML **execution provider** is a different thing, and this deliberately
does not append one. It was appended unconditionally at first, on the
assumption that a provider which can decline is free to offer. It is not. On
the quantised graph Core ML cannot run int8 nodes at all, so it claims a few
float islands and the partition boundaries cost more than the islands save. On
any graph it specialises per input shape — and every group is a different
number of phoneme tokens, so a chapter becomes a fresh compile per sentence,
which is the opposite of the problem being solved.

Restoring it is three lines before the session is built. What would justify
them is a measurement, and the engine line prints the one to beat: the provider
and the dtype that actually ran, next to the last group's seconds of compute
per second of audio. "Why is this slow" should never need a rebuild to answer.

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

**The SPM product and the Swift module have different names**, and this costs
an afternoon if you assume otherwise. The package declares:

```swift
.library(name: "onnxruntime", type: .static, targets: ["OnnxRuntimeBindings"])
```

So `Package.swift` depends on the **product** `onnxruntime`, while the Swift
source imports the **module** `OnnxRuntimeBindings`. Importing `onnxruntime`
does not work.

The import sits behind `#if canImport` with an `#else` that `#error`s. That
`#else` is not decoration: an unmatched `canImport` compiles to *nothing*, so a
wrong module name produces a wall of `Cannot find type 'ORTEnv' in scope` and
never once mentions a missing module. Failing loudly with the right sentence is
the difference between a one-line fix and a guessing game.

If the error does fire, Xcode may simply not have resolved packages yet:
File → Packages → Resolve Package Versions, after `npm install && npm run sync`.
