// One copy of the voice, in a process of its own. farm.mjs starts several.
//
// Why a process and not a call: onnxruntime-node runs a forward pass
// synchronously on the thread that asked for it. Inside the server that was
// the only thread there is, so nothing else happened while a sentence
// rendered (no reply to the phone, no monitor page), and asking for two
// sentences at once rendered them one after the other. A copy per process is
// what lets a computer with ten cores render ten sentences at a time.
//
// Each copy is given a fixed, small number of threads (one, by default). The
// model's graph is mostly a chain, so one forward pass spread over every core
// leaves most of them waiting; many passes on one core each waste none.
//
// Talks to its parent over Node's IPC channel:
//   ← { type: 'generate', id, text, voice }
//   → { type: 'ready', threads }            once the model is loaded
//   → { type: 'failed', message }           if it cannot load, then exits
//   → { type: 'audio', id, pcm, rate }      Float32Array, untrimmed
//   → { type: 'error', id, message }

const MODEL_ID = process.env.VOICE_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX';
const dtype = process.env.VOICE_DTYPE || 'fp32';
const threads = Math.max(0, Math.floor(Number(process.env.VOICE_THREADS) || 0));

function say(m) { if (process.send) process.send(m); }

async function load() {
  const { KokoroTTS } = await import('kokoro-js');
  if (threads > 0) {
    // kokoro-js's own from_pretrained passes no session options, and ONNX
    // Runtime's default is a thread per core for every copy. Built by hand,
    // the same two pieces take the thread count.
    try {
      const { StyleTextToSpeech2Model, AutoTokenizer } = await import('@huggingface/transformers');
      const [model, tokenizer] = await Promise.all([
        StyleTextToSpeech2Model.from_pretrained(MODEL_ID, {
          dtype: dtype, device: 'cpu',
          session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
        }),
        AutoTokenizer.from_pretrained(MODEL_ID),
      ]);
      return { tts: new KokoroTTS(model, tokenizer), threads: threads };
    } catch (e) {
      // A kokoro-js that is put together differently one day: still a voice,
      // on the library's own terms, and the parent is told the thread count
      // was not honoured.
      console.error('engine-worker: could not set the thread count (' + (e && e.message) + '); using the default');
    }
  }
  return { tts: await KokoroTTS.from_pretrained(MODEL_ID, { dtype: dtype, device: 'cpu' }), threads: 0 };
}

let engine = null;

process.on('message', async function (m) {
  if (!m || m.type !== 'generate') return;
  try {
    const audio = await engine.tts.generate(m.text, { voice: m.voice, speed: 1 });
    say({ type: 'audio', id: m.id, pcm: audio.audio || audio.data, rate: audio.sampling_rate || 24000 });
  } catch (e) {
    say({ type: 'error', id: m.id, message: String((e && e.message) || e) });
  }
});

// The server has gone, however it went: do not outlive it.
process.on('disconnect', function () { process.exit(0); });

load().then(function (e) {
  engine = e;
  say({ type: 'ready', threads: e.threads });
}, function (e) {
  say({ type: 'failed', message: String((e && e.message) || e) });
  process.exitCode = 1;
  setTimeout(function () { process.exit(1); }, 50);
});
