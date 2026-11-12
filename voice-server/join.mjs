// One part of a book is a few sentences. Kokoro reports no timing, so the
// only way to know exactly when each sentence starts inside a clip is to
// render the sentences one at a time and put the clip together here, where
// every length is known to the sample. That is what lets the app light the
// sentence being spoken instead of the whole paragraph around it.
//
// Engine-agnostic on purpose: it works on the WAV every renderer already
// answers with (this computer, a peer, the graphics card), so none of them
// had to learn anything new.

// The pause between two sentences, the same one the app leaves between two
// clips (SENTENCE_GAP_MS in js/novel-voice.js), so a pause inside a clip and
// a pause between clips sound alike.
export const SENTENCE_GAP_MS = 220;
const SENTENCE_END = /[.!?…][")’”»\]]*$/;

/** How long to rest after this piece of text before the next one starts. */
export function gapAfterMs(text) {
  return SENTENCE_END.test(String(text || '').trim()) ? SENTENCE_GAP_MS : 0;
}

/**
 * A part's text cut where its sentences begin. `cuts` are character offsets
 * into `text`, the first of them 0. No cuts, or cuts that make no sense, is
 * one piece: the whole text, as before sentences were timed.
 */
export function unitsOf(text, cuts) {
  const s = String(text || '');
  if (!Array.isArray(cuts) || cuts.length < 2) return [s];
  const out = [];
  for (let i = 0; i < cuts.length; i++) {
    const piece = s.slice(cuts[i], i + 1 < cuts.length ? cuts[i + 1] : s.length).trim();
    if (!piece) return [s];
    out.push(piece);
  }
  return out;
}

/** 16-bit mono PCM out of a WAV → { rate, pcm: Buffer } */
export function wavPcm(wav) {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV');
  }
  let rate = 0, off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      if (wav.readUInt16LE(body) !== 1 || wav.readUInt16LE(body + 2) !== 1 || wav.readUInt16LE(body + 14) !== 16) {
        throw new Error('only 16-bit mono PCM can be joined');
      }
      rate = wav.readUInt32LE(body + 4);
    } else if (id === 'data') {
      if (!rate) throw new Error('WAV has no format before its data');
      return { rate: rate, pcm: wav.subarray(body, Math.min(wav.length, body + size)) };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data');
}

/**
 * Several WAVs end to end, each followed by its rest, as one WAV.
 * → { wav, seconds, marks } where marks[i] is the second piece i starts at.
 */
export function joinWavs(wavs, gapsMs) {
  const pieces = wavs.map(wavPcm);
  const rate = pieces[0].rate;
  const marks = [];
  const chunks = [];
  let samples = 0;
  pieces.forEach(function (p, i) {
    if (p.rate !== rate) throw new Error('pieces at different sample rates');
    marks.push(Math.round((samples / rate) * 1000) / 1000);
    chunks.push(p.pcm);
    samples += p.pcm.length / 2;
    const rest = i + 1 < pieces.length ? Math.round(((gapsMs && gapsMs[i]) || 0) / 1000 * rate) : 0;
    if (rest > 0) { chunks.push(Buffer.alloc(rest * 2)); samples += rest; }
  });
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(36 + samples * 2, 4); head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii'); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii'); head.writeUInt32LE(samples * 2, 40);
  return { wav: Buffer.concat([head].concat(chunks)), seconds: samples / rate, marks: marks };
}
