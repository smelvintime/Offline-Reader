// Stands in for engine-worker.mjs in the tests: the same messages, no model.
// FAKE_MS is how long a sentence takes; FAKE_LOAD=fail makes it refuse to
// load; the text "CRASH" kills it mid-sentence, once per process tree unless
// FAKE_CRASH=always.
const ms = Number(process.env.FAKE_MS) || 20;
const say = (m) => { if (process.send) process.send(m); };

process.on('disconnect', () => process.exit(0));
process.on('message', (m) => {
  if (!m || m.type !== 'generate') return;
  if (m.text === 'CRASH' && (process.env.FAKE_CRASH === 'always' || !process.env.FAKE_SECOND)) process.exit(7);
  if (m.text === 'BAD') { say({ type: 'error', id: m.id, message: 'cannot say that' }); return; }
  setTimeout(() => {
    const pcm = new Float32Array(2400);            // a tenth of a second
    for (let i = 240; i < 2160; i++) pcm[i] = 0.5 * Math.sin(i / 10);
    say({ type: 'audio', id: m.id, pcm, rate: 24000 });
  }, ms);
});

if (process.env.FAKE_LOAD === 'fail') {
  say({ type: 'failed', message: 'no such model' });
  setTimeout(() => process.exit(1), 20);
} else {
  setTimeout(() => say({ type: 'ready', threads: Number(process.env.VOICE_THREADS) || 0 }), Number(process.env.FAKE_LOAD_MS) || 10);
}
