// Offline Reader — reader voice ("Listen") for the novel reader.
// See docs/ARCHITECTURE.md §2.14.
//
// Owns:  window.NovelVoice, js/novel-voice-worker.js, css/voice.css (vc-*),
//        vendor/tts/** (the vendored neural engine — see vendor/tts/README.md)
//
// ─────────────────────────────────────────────────────────────────────────────
// Why this file is shaped the way it is
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. SENTENCES, NOT CHAPTERS.
//    Every TTS engine degrades on long input: browser speechSynthesis engines
//    flatten their prosody (and Chrome's engine simply stops mid-utterance
//    after ~15 s), and neural models drift. So the unit of narration is the
//    sentence. The chapter is segmented ONCE into a flat list of
//    { blockIdx, start, end } ranges over the reader's own block model, and
//    everything else — playback, pause/resume, skip, the highlight, the
//    follow-along page turn, progress — is "move a cursor along that list".
//    A sentence range doubles as a reader anchor ({ chapterId, blockIdx,
//    charInBlock }), which is what lets narration drive the same position
//    machinery as a finger.
//
// 2. TWO ENGINES, ONE CONTRACT.
//    The device engine (speechSynthesis) is instant, free, and sounds exactly
//    as good as the OS voice it picks — which is why picking matters: left to
//    the default, every platform serves its most robotic voice. The neural
//    engine (Kokoro-82M via the vendored kokoro.web.js, in a worker) sounds
//    like a person and costs a one-time ~90 MB download. Both are driven
//    through the same speak/cancel surface so the controller cannot tell them
//    apart, and switching engines mid-sentence is just "cancel, speak again".
//
// 3. THE READER OWNS THE PAGE; WE ASK, NEVER REACH.
//    This module holds no DOM inside .nv-doc and does no geometry of its own
//    beyond reading rects. Moving the view goes through the bridge novel-reader
//    hands us (reveal → settleLayout), so listening writes progress through the
//    exact code path a page turn does. If novel-reader.js is absent or predates
//    the bridge, window.NovelVoice sits inert and costs one function object.
//
// 4. NOTHING IS FETCHED UNTIL ASKED.
//    At boot this file defines one global and returns. The worker, the 2 MB
//    engine bundle, the wasm runtime and the model weights are all behind the
//    reader explicitly enabling the Natural voice — the same "nobody pays for
//    a face they never chose" rule the bundled typefaces follow.

(function () {
  'use strict';

  // Without Workers or WebAssembly there is no narrator at all. Leaving
  // window.NovelVoice undefined makes novel-reader.js skip the Listen button
  // entirely (§2.14) — the honest UI for "this cannot work here".
  if (!window.Worker || typeof WebAssembly === 'undefined') return;

  // ─────────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────────

  // One narrator. The device voice is gone: it was the platform's own
  // speech synthesiser, it sounded like one, and having it as a silent
  // fallback meant a broken natural voice could masquerade as a working app.
  // When the natural voice cannot run, that is now said, not papered over.
  // One path only. The GPU path needed the fp32 weights — four times the size,
  // never bundled, and on a phone a dead process rather than a faster one. It
  // was a 330 MB download sitting behind a toggle that read as an upgrade.
  const NEURAL_DEVICE = 'wasm';

  const RATE_MIN = 0.6, RATE_MAX = 1.6, RATE_STEP = 0.05;
  const PITCH_MIN = 0.8, PITCH_MAX = 1.2, PITCH_STEP = 0.05;

  // Sentences longer than this are split at a clause boundary before speaking.
  // Long single utterances are where device engines go flat and where the
  // neural engine's latency becomes a visible stall; ~300 chars ≈ 20 s spoken.
  const MAX_SPOKEN_CHARS = 300;

  // The neural engine speaks GROUPS of adjacent sentences (same paragraph,
  // merged up to ~target chars), not single sentences. Grouping is what makes
  // slower-than-realtime devices keep up: per-call overhead is paid once per
  // group, the model gets whole-clause context (better prosody), and the
  // playback runway per generation is 2-4× longer. The device engine keeps
  // per-sentence utterances — it has no latency problem and finer pause
  // control there is a feature.
  const NEURAL_GROUP_TARGET = 160;   // stop growing a group past this
  const NEURAL_GROUP_MAX = 300;      // never exceed (long groups delay first audio)
  // …except to finish a sentence splitLong had to cut: a seam inside a clause
  // is worse than a slightly longer generation. Kokoro chunks internally, so
  // this costs latency on one group, not correctness.
  const NEURAL_GROUP_CONT_MAX = 700;
  const NEURAL_LOOKAHEAD = 2;        // groups generated ahead of playback
  const NEURAL_TIMEOUT_MS = 120000;  // one group; the first pays session warm-up
  // Silence from the worker during init. Not a deadline for the whole load —
  // every message resets it — so a slow download and a slow ONNX session
  // compile each get this long with nothing to say before we call it dead.
  const NEURAL_INIT_STALL_MS = 180000;
  const WAV_CACHE_MAX = 10;          // generated groups kept for replay/skip-back

  // The engine's working set is hundreds of MB, so it should not be held
  // while someone browses their shelf — but tearing it down on every chapter
  // close makes each Listen pay a full model re-init ("takes forever to
  // load"). How long it stays warm after the last use is a memory-class
  // decision (§2.3 Platform.tuning philosophy): a desktop can afford minutes,
  // a mid phone seconds, and a low-memory phone none at all — holding half a
  // gigabyte of idle model on a 3 GB phone is how "the reader crashed" bug
  // reports happen.
  const NEURAL_IDLE_BY_CLASS = { high: 120000, mid: 30000, low: 0 };

  // A crash-loop breaker for narration. Some platforms can take the whole
  // page down when speech starts (WebKit has a history of hard-crashing
  // home-screen web apps on speechSynthesis.speak; low-memory phones OOM on
  // the neural engine). A raw localStorage flag (§3.3, key or.voiceGuard) is
  // written just before a session's first utterance and cleared after two
  // utterances complete — so if the app died in between, the NEXT session
  // knows, and declines to auto-play into the same wall.
  const CRASH_GUARD_KEY = 'or.voiceGuard';
  const CRASH_GUARD_FRESH_MS = 10 * 60 * 1000;

  // "Preparing voice…" only appears when the wait is real. Cache hits and
  // fast generations stay visually seamless instead of strobing the bar.
  const PREPARING_DELAY_MS = 350;

  // After this many consecutive per-sentence engine failures we stop instead
  // of narrating silence sentence by sentence.
  const MAX_CONSECUTIVE_ERRORS = 3;

  const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
  // Cache probes for "is the model already on disk". transformers.js keys its
  // Cache API entries by the resolve URL it fetched; these are the two dtypes
  // this module can ask for. A miss only means "show the download button".
  const MODEL_FILE = 'model_quantized.onnx';   // the q8 weights, and the only ones
  const MODEL_URL = 'https://huggingface.co/' + MODEL_ID + '/resolve/main/onnx/' + MODEL_FILE;
  const TRANSFORMERS_CACHE = 'transformers-cache';
  const KOKORO_VOICES_CACHE = 'kokoro-voices';

  // The narrators offered, curated from kokoro-js's graded list: everything
  // B-or-better plus the best male options (the male half of the pack grades
  // lower across the board; Michael/Fenrir/Puck are its strongest).
  // Kokoro-82M's multilingual weights exist, but the vendored kokoro-js web
  // bundle ships only the en-us / en-gb voices and only an English G2P front
  // end (see vendor/tts/README.md). Handing it Japanese or Chinese prose does
  // not fail — it phonemizes the characters as if they were English and reads
  // confident nonsense, which is worse than failing. The engine is offered
  // only for books in a language it actually speaks.
  const NEURAL_LANGS = { en: true };

  // The reservations the worker will try, largest first, in 64 KB wasm pages.
  //
  // 65536 pages is 4 GB, which is what emscripten's glue asks for unprompted
  // and what a desktop browser happily hands over. The smaller rungs exist for
  // phones. Kokoro-82M at q8 peaks a little over 300 MB with its arena, so
  // 16384 (1 GB) is comfortable and 4096 (256 MB) is the floor below which the
  // session would OOM mid-sentence anyway — better to fail the check and say
  // so than to fail on the third paragraph of a chapter.
  //
  // Kept next to the probe that walks them because the probe's answer is only
  // meaningful if the worker attempts the same list. js/novel-voice-worker.js
  // is handed this array in the init message rather than duplicating it.
  const NEURAL_HEAP_PAGES = [65536, 16384, 8192, 4096];

  // emscripten's glue asks for 256 pages (16 MB) of actual memory. The import
  // section demands at least that, so this is a floor, not a preference.
  const WASM_MIN_PAGES = 256;

  // ── Can this runtime run the engine at all? ──────────────────────────────
  //
  // The vendored ONNX Runtime binary imports a SHARED WebAssembly memory —
  // `flags=0x3` in its import section, and linking it against a non-shared
  // memory is a hard LinkError, not a slow path.
  //
  // What matters is not *whether* shared memory is granted but *how much*. A
  // shared memory cannot be moved once handed out, so the engine must reserve
  // its `maximum` as address space up front, and emscripten's glue asks for
  // `{initial: 256, maximum: 65536}` — 16 MB of pages backed by a 4 GB
  // reservation. iOS hands out the first and refuses the second, and it
  // refuses it inside emscripten's init, below the level that reports
  // anything. That is how "Preparing the narrator on this device…" came to sit
  // there forever on a phone whose engine check said "shared wasm memory: yes".
  //
  // It said yes because it asked the wrong question: one page, maximum one.
  // Every device on earth grants that. So the probe now walks the reservations
  // the worker will actually attempt, largest first, and reports the biggest
  // one this device will grant — which is the number the worker then caps the
  // engine to.
  let neuralCapabilityCache = null;
  function neuralCapability() {
    if (neuralCapabilityCache) return neuralCapabilityCache;
    const c = {
      worker: typeof Worker !== 'undefined',
      wasm: typeof WebAssembly !== 'undefined',
      isolated: typeof self !== 'undefined' && !!self.crossOriginIsolated,
      sab: typeof SharedArrayBuffer !== 'undefined',
      sharedMemory: false,
      reason: '',
    };
    if (c.wasm) {
      for (let i = 0; i < NEURAL_HEAP_PAGES.length; i++) {
        const max = NEURAL_HEAP_PAGES[i];
        try {
          // Allocated and dropped. The point is the reservation, not the bytes:
          // if this throws, the worker asking for the same thing will throw too.
          new WebAssembly.Memory({ initial: WASM_MIN_PAGES, maximum: max, shared: true });
          c.sharedMemory = true;
          c.heapPages = max;
          break;
        } catch (e) {
          c.memoryError = e && e.message ? String(e.message).slice(0, 120) : String(e);
        }
      }
      if (c.sharedMemory) c.memoryError = '';
    }
    c.ok = c.worker && c.wasm && c.sharedMemory;
    if (!c.worker) c.reason = 'this browser has no Web Workers';
    else if (!c.wasm) c.reason = 'this browser has no WebAssembly';
    else if (!c.sharedMemory) {
      c.reason = 'this device would not grant the voice engine any shared WebAssembly memory'
        + (c.isolated ? '' : ' (the page is not cross-origin isolated)');
    }
    neuralCapabilityCache = c;
    return c;
  }

  /**
   * Record the heap the worker actually got. The main thread probes the same
   * list, but a worker is a separate realm with its own address space, and on
   * a phone under pressure the two can disagree. The one that ran the engine
   * wins.
   */
  function noteHeapPages(pages) {
    const c = neuralCapability();
    c.heapPages = pages;
  }

  /**
   * One line, safe to show a reader, describing what was found.
   *
   * Every field here was added because its absence cost a rebuild. `native`
   * and `weights` in particular: a screenshot once showed "Download voice
   * (~90 MB)" on a native build, which syncNeuralStatus only renders on the
   * WEB branch, while the line reported no weights failure at all. Those two
   * facts cannot both be true, and neither one alone said which was lying.
   */
  function neuralCapabilityLine() {
    const c = neuralCapability();
    const weights = neuralEngine.bundledWhy ? neuralEngine.bundledWhy
      : neuralEngine.bundledCache === true ? 'weights: in app'
      : neuralEngine.bundledCache === false ? 'weights: absent'
      : 'weights: not probed yet';
    return 'engine check — shared wasm heap: '
      + (c.sharedMemory ? Math.round(c.heapPages / 16) + ' MB' : 'NONE')
      + ' · SharedArrayBuffer: ' + (c.sab ? 'yes' : 'no')
      + ' · native: ' + (isNativeApp() ? 'yes' : 'NO')
      + ' · ' + weights
      + (neuralEngine.stage ? ' · stage: ' + neuralEngine.stage : '')
      + (neuralEngine.speed
          ? ' · last group: ' + neuralEngine.speed.chars + ' chars, '
            + (neuralEngine.speed.ms / 1000).toFixed(1) + 's compute for '
            + neuralEngine.speed.seconds.toFixed(1) + 's audio ('
            + neuralEngine.speed.ratio.toFixed(2) + '× realtime)'
          : '')
      + (c.memoryError ? ' · ' + c.memoryError : '');
  }

  function neuralSpeaks(lang) {
    const base = String(lang || 'en').toLowerCase().split('-')[0];
    return !!NEURAL_LANGS[base];
  }

  const NEURAL_VOICES = [
    { id: 'af_heart',   label: 'Heart',   note: 'American · warm' },
    { id: 'af_bella',   label: 'Bella',   note: 'American · bright' },
    { id: 'af_nicole',  label: 'Nicole',  note: 'American · hushed' },
    { id: 'bf_emma',    label: 'Emma',    note: 'British' },
    { id: 'am_michael', label: 'Michael', note: 'American' },
    { id: 'am_fenrir',  label: 'Fenrir',  note: 'American · deep' },
    { id: 'am_puck',    label: 'Puck',    note: 'American · light' },
    { id: 'bm_george',  label: 'George',  note: 'British' },
  ];

  const PREF = {
    engine:       'voice.engine',
    rate:         'voice.rate',
    pitch:        'voice.pitch',
    neuralVoice:  'voice.neuralVoice',
    follow:       'voice.follow',
    autoNext:     'voice.autoNext',
    highlight:    'voice.highlight',
  };

  const DEFAULTS = {
    engine: 'device',
    rate: 1,
    pitch: 1,
    neuralVoice: 'af_heart',
    follow: true,
    autoNext: true,
    highlight: true,
  };

  const HIGHLIGHT_NAME = 'or-voice-sentence';

  const PREVIEW_TEXT = 'The lantern guttered, and for a moment the whole room listened with her.';

  // ─────────────────────────────────────────────────────────────────────────
  // Small helpers
  // ─────────────────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function num(v, fallback) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function oneOf(v, list, fallback) { return list.indexOf(v) === -1 ? fallback : v; }

  function prefGet(key, fallback) {
    try {
      if (!window.Store) return fallback;
      return window.Store.prefs.get(key, fallback);
    } catch (e) { return fallback; }
  }
  function prefSet(key, value) {
    try { if (window.Store) window.Store.prefs.set(key, value); }
    catch (e) { /* prefs are not worth throwing over */ }
  }

  // Voice settings are global on purpose, unlike the reader's typography: a
  // narrator is chosen once for the app, not per book, and the per-series
  // door stays closed until someone actually asks for it.
  function readPrefs() {
    return {
      rate:         clamp(num(prefGet(PREF.rate, DEFAULTS.rate), DEFAULTS.rate), RATE_MIN, RATE_MAX),
      pitch:        clamp(num(prefGet(PREF.pitch, DEFAULTS.pitch), DEFAULTS.pitch), PITCH_MIN, PITCH_MAX),
      neuralVoice:  validNeuralVoice(prefGet(PREF.neuralVoice, DEFAULTS.neuralVoice)),
      follow:       prefGet(PREF.follow, DEFAULTS.follow) !== false,
      autoNext:     prefGet(PREF.autoNext, DEFAULTS.autoNext) !== false,
      highlight:    prefGet(PREF.highlight, DEFAULTS.highlight) !== false,
    };
  }


  function validNeuralVoice(id) {
    for (let i = 0; i < NEURAL_VOICES.length; i++) if (NEURAL_VOICES[i].id === id) return id;
    return DEFAULTS.neuralVoice;
  }

  // 'low' | 'mid' | 'high' — Platform's synchronous read when the bridge is
  // present (it is, in index.html's load order), a safe middle otherwise.
  function memoryClass() {
    try {
      if (window.Platform && typeof window.Platform.memoryClass === 'function') {
        const c = window.Platform.memoryClass();
        if (c === 'low' || c === 'mid' || c === 'high') return c;
      }
    } catch (e) { /* the default is the answer */ }
    return 'mid';
  }

  // ── Crash-loop breaker plumbing ───────────────────────────────────────────

  // The flag records WHICH phase was in flight, not just that one was. The two
  // phases fail completely differently — loading the model is a half-gigabyte
  // memory spike that the OS answers by killing the web content process,
  // speaking is a platform TTS call — and the recovery differs with them, so
  // the next launch has to be able to tell them apart.
  //
  // Written as JSON; a bare timestamp from an older build still reads as a
  // 'speak' crash, which is what that build could only have meant.
  function guardRead() {
    let raw = null;
    try { raw = localStorage.getItem(CRASH_GUARD_KEY); } catch (e) { return null; }
    if (!raw) return null;
    let rec = null;
    try { rec = JSON.parse(raw); } catch (e) { rec = null; }
    if (!rec || typeof rec !== 'object') {
      const t = parseInt(raw, 10);
      rec = Number.isFinite(t) ? { t: t, phase: 'speak' } : null;
    }
    if (!rec || !Number.isFinite(rec.t)) return null;
    if (Date.now() - rec.t >= CRASH_GUARD_FRESH_MS) return null;
    return { phase: rec.phase === 'model' ? 'model' : 'speak', device: rec.device || null };
  }
  function guardArm(phase, device) {
    try {
      localStorage.setItem(CRASH_GUARD_KEY, JSON.stringify({
        t: Date.now(),
        phase: phase === 'model' ? 'model' : 'speak',
        device: device || null,
      }));
    } catch (e) {}
  }
  function guardClear() {
    try { localStorage.removeItem(CRASH_GUARD_KEY); } catch (e) {}
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sentence segmentation
  //
  // Input is the reader's block list; output is a flat list of sentences whose
  // [start, end) offsets index into blockText(block) — the same canonical
  // string the reader's anchors count, so a sentence start IS an anchor.
  // ─────────────────────────────────────────────────────────────────────────

  const SKIP_BLOCKS = { hr: true, img: true };
  const HEADING_BLOCKS = { h2: true, h3: true, h4: true };

  // One segmenter per language tag. The book's language, not the app's: an
  // imported Japanese light novel must not be sentence-broken by English rules.
  const segmenterCache = new Map();
  function getSegmenter(lang) {
    const tag = lang || 'en';
    if (segmenterCache.has(tag)) return segmenterCache.get(tag);
    let seg = false;
    try {
      if (typeof Intl !== 'undefined' && Intl.Segmenter) {
        seg = new Intl.Segmenter(tag, { granularity: 'sentence' });
      }
    } catch (e) {
      // An unknown or malformed tag throws RangeError; English rules beat none.
      try { seg = new Intl.Segmenter('en', { granularity: 'sentence' }); } catch (e2) { seg = false; }
    }
    segmenterCache.set(tag, seg);
    return seg;
  }

  // Abbreviations that must not end a sentence. Intl.Segmenter follows ICU's
  // SentenceBreak rules, which deliberately ignore abbreviations — "Dr. Harrow
  // spoke." really does come back as two segments — so BOTH paths need this
  // merge, not just the regex fallback.
  const ABBREV = /(?:\b(?:mr|mrs|ms|dr|prof|st|mt|vs|etc|jr|sr|no|vol|ch|pp?))[.]["'”’)\]]*\s*$/i;

  // A range that ends on a real terminator is a whole sentence however short it
  // is — "Ah!", "「はい」", "Mm." Light-novel dialogue is made of these, and the
  // length rule below would otherwise glue them onto the next line.
  const COMPLETE_SHORT = /[.!?…。！？]["'”’)\]」』】〉》]*\s*$/;

  // Merge a range into its successor when it ends in an abbreviation (or is a
  // fragment too short to be a sentence, like an initial). Runs until stable
  // so "Mr. J. Smith arrived." collapses to one sentence.
  function mergeAbbrevRanges(text, ranges) {
    const out = [];
    for (let i = 0; i < ranges.length; i++) {
      const r = { start: ranges[i].start, end: ranges[i].end };
      while (i + 1 < ranges.length) {
        const seg = text.slice(r.start, r.end);
        const trimmed = seg.trim();
        if (!ABBREV.test(seg) && (trimmed.length > 3 || COMPLETE_SHORT.test(trimmed))) break;
        r.end = ranges[i + 1].end;
        i++;
      }
      out.push(r);
    }
    return out;
  }

  function splitIntoSentences(text, lang) {
    // → [{ start, end }] over `text`, untrimmed. Trimming happens in the caller
    // so both paths share it.
    const out = [];
    const seg = getSegmenter(lang);
    if (seg) {
      const it = seg.segment(text);
      let iter = it[Symbol.iterator](), r;
      while (!(r = iter.next()).done) {
        const s = r.value;
        out.push({ start: s.index, end: s.index + s.segment.length });
      }
      return mergeAbbrevRanges(text, out);
    }
    // Fallback (no Intl.Segmenter). Two shapes of prose to serve:
    //
    //   Western — split after . ! ? … followed by whitespace + a capital or an
    //   opening quote, unless the tail looks like a known abbreviation.
    //   CJK — no spaces at all, so the whitespace rule never fires. Full-width
    //   terminators (。！？) end a sentence on their own, after any closing
    //   bracket that trails them.
    let start = 0;
    const re = /(?:[.!?…]+["'”’)\]]*\s+|[。！？]+[」』】〉》"'”’)\]]*)/g;
    let m;
    while ((m = re.exec(text))) {
      const end = m.index + m[0].length;
      const next = text[end];
      // The whitespace-terminated branch still wants a sentence-looking start
      // after it; the full-width branch is unambiguous and always splits.
      if (/\s$/.test(m[0]) && next && !/[A-Z0-9"'“‘]/.test(next)) continue;
      out.push({ start: start, end: end });
      start = end;
    }
    if (start < text.length) out.push({ start: start, end: text.length });
    return mergeAbbrevRanges(text, out);
  }

  // A very long sentence is split at its last clause mark before the cap —
  // falling back to the last space — so no single utterance runs long enough
  // for an engine to lose its footing.
  //
  // Every piece after the first is flagged `cont`: it is a CONTINUATION of one
  // sentence, not a sentence of its own. The device engine still speaks the
  // pieces separately (that cap is what keeps Chrome from cutting out
  // mid-paragraph), but the neural engine rejoins them (groupSentences below) so the
  // model never renders half a clause with nothing after the comma.
  function splitLong(text, start, end, into) {
    let cont = false;
    while (end - start > MAX_SPOKEN_CHARS) {
      const slice = text.slice(start, start + MAX_SPOKEN_CHARS);
      let cut = -1;
      // Latin clause marks want the following space; CJK has none, and its
      // marks (、。；：) are themselves the boundary.
      const clause = /[,;:—–]\s[^,;:—–]*$/.exec(slice);
      if (clause) cut = clause.index + 1;
      if (cut < 40) {
        const cjk = /[、。；：」』][^、。；：」』]*$/.exec(slice);
        if (cjk) cut = cjk.index + 1;
      }
      if (cut < 40) cut = slice.lastIndexOf(' ');
      if (cut < 40) cut = MAX_SPOKEN_CHARS;
      into.push({ start: start, end: start + cut, cont: cont });
      cont = true;
      start += cut;
      while (start < end && /\s/.test(text[start])) start++;
    }
    if (start < end) into.push({ start: start, end: end, cont: cont });
  }

  function pushTrimmed(text, range, blockIdx, kind, out) {
    let s = range.start, e = range.end;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e <= s) return;
    // Punctuation-only fragments ("…", stray quotes) ride along with their
    // neighbour instead of becoming a spoken "beat" of silence.
    if (!/[\p{L}\p{N}]/u.test(text.slice(s, e))) {
      if (out.length && out[out.length - 1].blockIdx === blockIdx) out[out.length - 1].end = e;
      return;
    }
    const parts = [];
    splitLong(text, s, e, parts);
    for (let i = 0; i < parts.length; i++) {
      out.push({ blockIdx: blockIdx, start: parts[i].start, end: parts[i].end,
                 text: text.slice(parts[i].start, parts[i].end), kind: kind,
                 cont: !!parts[i].cont });
    }
  }

  // blockTextFn is novel-reader's own blockText, passed through the bridge so
  // the two modules can never disagree about what a block "says". `lang` is the
  // BOOK's language tag (bridge.seriesInfo().lang), which decides the sentence
  // rules — omit it and English is assumed, as before.
  function segmentBlocks(blocks, blockTextFn, lang) {
    const out = [];
    for (let i = 0; i < (blocks ? blocks.length : 0); i++) {
      const b = blocks[i];
      const t = b && typeof b === 'object' ? b.t : 'p';
      if (SKIP_BLOCKS[t]) continue;
      const text = blockTextFn(b);
      if (!text || !text.trim()) continue;

      if (HEADING_BLOCKS[t]) {
        pushTrimmed(text, { start: 0, end: text.length }, i, 'heading', out);
        continue;
      }

      if (Array.isArray(b.items)) {
        // blockText joins items with no separator, and so does the DOM
        // (adjacent <li> text nodes), so item offsets are cumulative lengths.
        let off = 0;
        for (let k = 0; k < b.items.length; k++) {
          const item = String(b.items[k]);
          const ranges = splitIntoSentences(item, lang);
          for (let r = 0; r < ranges.length; r++) {
            pushTrimmed(text, { start: off + ranges[r].start, end: off + ranges[r].end }, i, 'text', out);
          }
          off += item.length;
        }
        continue;
      }

      const ranges = splitIntoSentences(text, lang);
      for (let r = 0; r < ranges.length; r++) pushTrimmed(text, ranges[r], i, 'text', out);
    }
    return out;
  }

  // The first sentence at-or-after a reader anchor — where Play starts.
  function sentenceIndexAt(sentences, blockIdx, charInBlock) {
    for (let i = 0; i < sentences.length; i++) {
      const s = sentences[i];
      if (s.blockIdx > blockIdx) return i;
      if (s.blockIdx === blockIdx && s.end > charInBlock) return i;
    }
    return sentences.length ? sentences.length - 1 : 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Speech text normalization
  //
  // The HIGHLIGHT always uses the original text via offsets; only the string
  // handed to an engine is transformed, so nothing here can drift an anchor.
  // ─────────────────────────────────────────────────────────────────────────

  // Every dash a translated light novel uses for an interruption. U+2014/2013
  // are the Western pair; U+2015 (horizontal bar) and U+2500/U+2501 (box
  // drawing) are what Japanese typesetting's ―― becomes once it survives a
  // round trip, and they turn up in fan translations constantly.
  //
  // Deliberately NOT here: U+30FC, the katakana prolonged sound mark. It looks
  // like a dash and is a letter — ラーメン is a word, not ラ, a pause, メン.
  const DASH_CHARS = '\u2014\u2013\u2015\u2500\u2501';
  const DASH_RUN = new RegExp('[' + DASH_CHARS + ']+', 'g');            // the marks alone
  const DASH_CLAUSE = new RegExp('\\s*[' + DASH_CHARS + ']+\\s*', 'g');   // and the space around them

  function normalizeForSpeech(text, engine) {
    let s = String(text);
    // Footnote markers are typography, not prose. "[3]" read aloud is noise.
    s = s.replace(/\[\d+\]/g, ' ');

    // Light-novel typography, normalised for BOTH engines — these are not
    // stylistic choices an engine can interpret, they are shapes it chokes on.
    //
    // A run of dots or ellipses ("……", "......") is one pause, not six. Kokoro
    // renders a long run as a long dead stop and some device engines read the
    // dots out; a single ellipsis gets the beat the page is asking for.
    s = s.replace(/(?:…|\.\s*\.\s*\.)(?:\s*(?:…|\.))*/g, '…');
    // Corner brackets are Japanese quotation marks. Left as-is an engine either
    // skips them or names them ("left corner bracket"); as quotes they carry
    // the dialogue the way the rest of the book's quotes do.
    s = s.replace(/[「『〈《｢]/g, '“').replace(/[」』〉》｣]/g, '”');
    // Full-width terminators an English G2P front end does not know.
    s = s.replace(/！/g, '!').replace(/？/g, '?').replace(/，/g, ',').replace(/、/g, ',').replace(/。/g, '.');
    // U+30FB katakana middle dot, used as a name separator.
    s = s.replace(/・/g, ' ');

    s = s.replace(/\s+/g, ' ');
    if (engine === 'device') {
      // Device engines mostly ignore dashes and run the clauses together; a
      // comma buys the pause a narrator would take. The neural engine was
      // trained on real punctuation and does better with the dash kept.
      s = s.replace(DASH_CLAUSE, ', ');
      s = s.replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'");
    } else {
      // Neural: keep the dash and the spacing the page had, but reduce a RUN to
      // one em dash — the shape the model was trained on. "―――" is not a
      // punctuation mark it has ever seen.
      s = s.replace(DASH_RUN, '—');
    }
    return s.trim();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WAV encoding — Float32 PCM from the worker → a Blob an <audio> can play.
  // 16-bit is half the bytes of the raw floats and indistinguishable here.
  // ─────────────────────────────────────────────────────────────────────────

  function encodeWav(f32, sampleRate) {
    const n = f32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const dv = new DataView(buf);
    function str(off, s) { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);              // PCM
    dv.setUint16(22, 1, true);              // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true); // byte rate
    dv.setUint16(32, 2, true);              // block align
    dv.setUint16(34, 16, true);             // bits per sample
    str(36, 'data'); dv.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++, off += 2) {
      const s = clamp(f32[i], -1, 1);
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  // Half a second of silence, generated rather than shipped. Played once on the
  // first tap so the <audio> element is blessed for autoplay while the user
  // gesture is still live — every later clip inherits that permission.
  let silentUrl = null;
  function silentWavUrl() {
    if (!silentUrl) {
      const wav = encodeWav(new Float32Array(11025), 22050);
      silentUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    }
    return silentUrl;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session state
  // ─────────────────────────────────────────────────────────────────────────

  const state = {
    bridge: null,          // handed to us by novel-reader on open
    prefs: Object.assign({}, DEFAULTS),

    active: false,         // the listen bar is up
    playing: false,
    preparing: false,      // engine warm-up / first neural generation
    chapterId: null,
    sentences: [],
    index: 0,
    errors: 0,             // consecutive engine failures
    voiceNav: false,       // the chapter change in flight is ours, not the user's
    emptyHops: 0,          // consecutive auto-advances through speechless chapters
    spokeOk: 0,            // utterances completed this session (crash-loop breaker)

    utterance: null,       // device engine's in-flight utterance
    speakToken: 0,         // invalidates stale onend/async callbacks

    audition: null,        // { wasPlaying } while a preview plays
  };

  const dom = {};          // bar + sheet, built once on first open
  let built = false;
  let sheetOpen = false;
  const sheetSync = [];    // fn() → refresh a control from prefs/session

  // ─────────────────────────────────────────────────────────────────────────
  // Audio channel — one <audio> element for everything that actually plays.
  //
  // Neural sentences, previews and the device engine's silent keep-alive all
  // go through the same element. One element means the user's first tap on
  // Play "blesses" it for autoplay purposes, and every later programmatic
  // .play() — from an onended chain or a worker callback — inherits that.
  // ─────────────────────────────────────────────────────────────────────────

  const channel = {
    audio: null,
    onended: null,
    url: null,             // blob URL to revoke when replaced

    ensure: function () {
      if (this.audio) return this.audio;
      const a = new Audio();
      a.preload = 'auto';
      try { a.preservesPitch = true; } catch (e) {}
      const self = this;
      a.addEventListener('ended', function () {
        const fn = self.onended;
        if (fn) fn();
      });
      this.audio = a;
      return a;
    },

    // Swap in a source and play. Returns the play() promise (may reject on
    // autoplay policy; callers decide whether that is fatal).
    play: function (url, opts) {
      const a = this.ensure();
      const o = opts || {};
      this.onended = o.onended || null;
      if (this.url && this.url !== url) { try { URL.revokeObjectURL(this.url); } catch (e) {} }
      this.url = o.revoke ? url : null;
      a.loop = !!o.loop;
      if (a.src !== url) a.src = url;
      else a.currentTime = 0;
      // AFTER src, not before. Assigning src runs the media load algorithm,
      // which resets playbackRate to defaultPlaybackRate — so a rate set first
      // is thrown away on every clip, and the Speed control silently did
      // nothing for the whole session. Setting the default too keeps it
      // through any later load this element does.
      a.defaultPlaybackRate = o.rate || 1;
      a.playbackRate = o.rate || 1;
      let p;
      try { p = a.play(); } catch (e) { p = Promise.reject(e); }
      return p && typeof p.catch === 'function' ? p : Promise.resolve();
    },

    setRate: function (rate) { if (this.audio) this.audio.playbackRate = rate; },

    stop: function () {
      this.onended = null;
      if (this.audio) {
        try { this.audio.pause(); } catch (e) {}
        try { this.audio.removeAttribute('src'); this.audio.load(); } catch (e) {}
      }
      if (this.url) { try { URL.revokeObjectURL(this.url); } catch (e) {} this.url = null; }
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Media session — lock-screen / hardware-key transport controls.
  // ─────────────────────────────────────────────────────────────────────────

  function mediaSessionUpdate() {
    if (!('mediaSession' in navigator)) return;
    try {
      const ms = navigator.mediaSession;
      if (!state.active) {
        ms.metadata = null;
        ms.playbackState = 'none';
        return;
      }
      const b = state.bridge;
      const series = b && b.seriesInfo ? b.seriesInfo() : null;
      const chapter = b && b.chapterLabel ? b.chapterLabel(state.chapterId) : '';
      ms.metadata = new MediaMetadata({
        title: chapter || 'Listening',
        artist: series && series.title ? series.title : 'Offline Reader',
        artwork: series && series.cover ? [{ src: series.cover }] : [],
      });
      ms.playbackState = state.playing ? 'playing' : 'paused';
    } catch (e) { /* media session is a nicety, never a dependency */ }
  }

  function mediaSessionWire() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = function (action, fn) { try { ms.setActionHandler(action, fn); } catch (e) {} };
    set('play',  function () { resume(); });
    set('pause', function () { pause(); });
    set('stop',  function () { stopSession(); });
    set('previoustrack', function () { skip(-1); });
    set('nexttrack',     function () { skip(1); });
    set('seekbackward',  function () { skip(-1); });
    set('seekforward',   function () { skip(1); });
  }

  function mediaSessionClear() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const actions = ['play', 'pause', 'stop', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward'];
    for (let i = 0; i < actions.length; i++) { try { ms.setActionHandler(actions[i], null); } catch (e) {} }
    try { ms.metadata = null; ms.playbackState = 'none'; } catch (e) {}
  }

  // The language narration should be IN. The open book's own tag wins — an
  // imported Japanese light novel read by an English voice is noise, and the
  // app shell's <html lang> says nothing about what is on the page. Falls back
  // to the shell, then to English.
  function bookLang() {
    try {
      const info = state.bridge && state.bridge.seriesInfo && state.bridge.seriesInfo();
      const l = info && info.lang;
      if (typeof l === 'string' && l.trim()) return l.trim();
    } catch (e) { /* the bridge is an accessory too */ }
    return '';
  }

  // Running inside the Capacitor shell rather than a browser tab. The two have
  // different bargains about downloads: a tab may fetch a model, an installed
  // app should already contain it.
  function isNativeApp() {
    try { return !!(window.Platform && window.Platform.isNative); } catch (e) { return false; }
  }

  function docLang() {
    const l = bookLang() || document.documentElement.getAttribute('lang');
    return l || 'en';
  }

  // A NORMAL departure (navigation, tab close) mid-first-utterance must not
  // trip the crash-loop breaker: pagehide fires on those and clears the
  // guard. A real crash never reaches pagehide — that asymmetry is the whole
  // detector.
  try {
    window.addEventListener('pagehide', function () { guardClear(); });
  } catch (e) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Neural engine — the vendored Kokoro bundle in a module worker.
  //
  // The worker owns the model; this side owns the queue. Sentences are
  // requested by id, results are WAV ArrayBuffers, and anything that comes
  // back for an id we no longer care about is dropped on the floor.
  // ─────────────────────────────────────────────────────────────────────────

  const neuralEngine = {
    worker: null,
    local: null,           // true once a load proved the weights are bundled
    stage: '',             // the worker's last announced init step
    speed: null,           // { ms, seconds, chars, ratio } for the last group
    device: null,          // device the live worker was initialised with
    readyPromise: null,
    ready: false,          // resolved at least once (drives the sheet status)
    nextId: 1,
    pending: new Map(),    // id → { resolve, reject, timer }
    inFlight: new Map(),   // cacheKey → Promise<blob URL> not yet settled
    wavCache: new Map(),   // cacheKey → blob URL (bounded LRU)
    onprogress: null,      // sheet download/init-progress hook
    idleTimer: 0,          // scheduled teardown after release()

    available: function () { return !!window.Worker; },

    ensureReady: function (device) {
      // Any acquisition cancels a scheduled idle teardown — the engine is
      // wanted again.
      clearTimeout(this.idleTimer); this.idleTimer = 0;
      if (this.worker && this.device === device && this.readyPromise) return this.readyPromise;
      this.dispose();
      const self = this;
      this.device = device;
      this.readyPromise = new Promise(function (resolve, reject) {
        let w;
        let settled = false;
        let stall = 0;

        // Loading the model is the memory spike that gets a phone's web
        // content process killed, so the crash-loop breaker is armed HERE
        // rather than by the callers. Three of the four ways in (the Download
        // button, the voice preview, the open-book prewarm) never went through
        // play(), which was the only place that armed it — so a device that
        // died loading the model met the same load again on the next launch,
        // with nothing having noticed.
        guardArm('model', device);

        const finish = function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(stall);
          // Reaching a verdict at all — ready OR a clean error — means the
          // page survived the load. Only a process death leaves it armed.
          guardClear();
          if (err) { reject(err); self.disposeIfNotReady(w); }
          else { self.ready = true; resolve(); }
        };

        // Nothing here settles on its own if the worker dies quietly, and on
        // iOS a worker killed for memory fires no 'error' event at all — the
        // page just waits, which is the "Preparing the narrator…" that never
        // finishes. A silence watchdog turns that into a real failure the
        // fallback can act on. Any message from the worker resets it, so a
        // slow download and a slow session compile both keep their time.
        const bump = function () {
          clearTimeout(stall);
          stall = setTimeout(function () {
            finish(new Error('The voice engine stopped responding at "'
              + (self.stage || 'startup') + '". '
              + 'On a phone this is usually the model running out of memory.'));
          }, NEURAL_INIT_STALL_MS);
        };

        try {
          w = new Worker('./js/novel-voice-worker.js', { type: 'module' });
        } catch (e) { finish(e); return; }
        self.worker = w;
        bump();
        w.onerror = function (e) {
          finish(new Error(e && e.message ? e.message : 'Worker failed to start'));
        };
        w.onmessage = function (ev) {
          const m = ev.data || {};
          if (!settled) bump();
          if (m.type === 'source') { self.local = !!m.local; if (self.onprogress) self.onprogress(m); }
          else if (m.type === 'stage') { self.stage = m.stage; if (self.onprogress) self.onprogress(m); }
          else if (m.type === 'ready') {
            // The worker's realm is the one that had to succeed, so its number
            // supersedes the main thread's guess in the line a reader reads.
            if (m.heapPages) noteHeapPages(m.heapPages);
            self.stage = '';       // init is over; the step it ended on is stale
            finish(null);
            if (self.onprogress) self.onprogress({ type: 'ready' });
          }
          else if (m.type === 'init-error') { finish(new Error(m.message || 'Could not load the voice model')); }
          else if (m.type === 'progress') { if (self.onprogress) self.onprogress(m); }
          else if (m.type === 'audio') { self.noteSpeed(m); self.settle(m.id, null, m); }
          else if (m.type === 'error') self.settle(m.id, new Error(m.message || 'Generation failed'), null);
        };
        w.postMessage({
          type: 'init',
          model: MODEL_ID,
          device: device,
          dtype: 'q8',
          // The worker seeds these into the cache kokoro-js reads, from the
          // copies in the bundle. Only the voices this app offers — the pack
          // has fifty-odd and nobody is served by shipping the rest.
          voices: NEURAL_VOICES.map(function (v) { return v.id; }),
          // The reservations to try, biggest first. The probe already walked
          // this list on the main thread; the worker walks it again because a
          // worker is a separate JS realm with its own address space, and the
          // one that has to succeed is the worker's.
          heapPages: NEURAL_HEAP_PAGES,
        });
      });
      return this.readyPromise;
    },

    // Let go without tearing down: the model stays warm for a couple of
    // minutes so "close chapter, open next, press Listen" does not pay a
    // full re-init — that is the "takes forever to load" complaint. The
    // timer, not the session, is what finally frees the memory.
    release: function () {
      const self = this;
      clearTimeout(this.idleTimer);
      if (!this.worker) return;
      const idle = NEURAL_IDLE_BY_CLASS[memoryClass()] || 0;
      if (idle <= 0) { this.dispose(); return; }   // low memory: free it NOW
      this.idleTimer = setTimeout(function () {
        self.idleTimer = 0;
        self.dispose();
      }, idle);
    },

    disposeIfNotReady: function (w) {
      if (this.worker === w) { this.worker = null; this.readyPromise = null; this.device = null; }
    },

    settle: function (id, err, msg) {
      const p = this.pending.get(id);
      if (!p) return;                      // cancelled long ago
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (err) p.reject(err);
      else p.resolve(msg);
    },

    // → Promise<blob URL for the sentence's WAV>
    generate: function (cacheKey, text, voice) {
      const cached = this.wavCache.get(cacheKey);
      if (cached) {
        // Refresh LRU position.
        this.wavCache.delete(cacheKey); this.wavCache.set(cacheKey, cached);
        return Promise.resolve(cached);
      }
      // wavCache only knows about FINISHED generations. Without this, a group
      // the lookahead is still synthesising is requested a second time the
      // moment the cursor reaches it — and since the worker is a serial queue,
      // the model renders the same audio twice while playback waits behind it.
      // That doubling is what a slower-than-realtime phone hears as stuttering.
      const live = this.inFlight.get(cacheKey);
      if (live) return live;

      const self = this;
      const id = this.nextId++;
      const job = new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          self.pending.delete(id);
          reject(new Error('Timed out generating audio'));
        }, NEURAL_TIMEOUT_MS);
        self.pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        self.worker.postMessage({ type: 'generate', id: id, text: text, voice: voice });
      }).then(function (msg) {
        const url = URL.createObjectURL(new Blob([msg.wav], { type: 'audio/wav' }));
        self.wavCache.set(cacheKey, url);
        while (self.wavCache.size > WAV_CACHE_MAX) {
          const oldest = self.wavCache.keys().next().value;
          const u = self.wavCache.get(oldest);
          self.wavCache.delete(oldest);
          try { URL.revokeObjectURL(u); } catch (e) {}
        }
        return url;
      });
      // Settled either way, this key is no longer in flight: a failed group
      // must be retryable, and a finished one is answered by wavCache above.
      const forget = function () { if (self.inFlight.get(cacheKey) === job) self.inFlight.delete(cacheKey); };
      job.then(forget, forget);
      this.inFlight.set(cacheKey, job);
      return job;
    },

    /**
     * Seconds of audio per second of compute, for the last group.
     *
     * Below 1.0 the engine cannot keep up with its own output: the reader
     * hears a sentence, then a gap, then a sentence. That is not a failure
     * any error path catches, because nothing failed -- and it is why "it
     * read the chapter title and stopped" is ambiguous until this is measured.
     */
    noteSpeed: function (m) {
      if (!m || !m.ms) return;
      this.speed = {
        ms: m.ms,
        seconds: m.seconds || 0,
        chars: m.chars || 0,
        ratio: m.ms > 0 ? (m.seconds || 0) / (m.ms / 1000) : 0,
      };
    },

    cancelPending: function () {
      const self = this;
      this.pending.forEach(function (p) { clearTimeout(p.timer); p.reject(new Error('cancelled')); });
      this.pending.clear();
      this.inFlight.clear();
      if (this.worker) { try { this.worker.postMessage({ type: 'cancel' }); } catch (e) {} }
    },

    dispose: function () {
      clearTimeout(this.idleTimer); this.idleTimer = 0;
      this.cancelPending();
      if (this.worker) { try { this.worker.terminate(); } catch (e) {} }
      this.worker = null;
      this.readyPromise = null;
      this.ready = false;
      this.device = null;
      this.stage = '';       // no worker, no step it is on
      const self = this;
      this.wavCache.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      this.wavCache.clear();
    },

    // "Is the model on this device?" — bundled counts, and is asked first: a
    // build that ships its own weights has nothing to download and must never
    // be offered a download button.
    downloaded: function () {
      return this.bundled().then(function (inApp) {
        if (inApp) return true;
        if (typeof caches === 'undefined') return false;
        return caches.open(TRANSFORMERS_CACHE)
          .then(function (c) { return c.match(MODEL_URL); })
          .then(function (r) { return !!r; })
          .catch(function () { return false; });
      });
    },

    // Weights shipped inside the app (scripts/fetch-voice-model.mjs put them in
    // vendor/tts/models/, sync-www.sh carried them into the bundle).
    //
    // Probed by GETting config.json — 44 bytes, next to the weights, fetched by
    // the same script — rather than HEADing the 88 MB file. A HEAD looks
    // cheaper and is the wrong tool here: the native app is served by a custom
    // URL scheme handler, and a scheme handler only has to answer the requests
    // it chose to implement. GET is the one every one of them implements.
    //
    // Memoised: the answer cannot change without a reinstall.
    bundledCache: null,
    // Why the answer was no, for the engine line. "Download voice (~90 MB)" on
    // a build that bundles its weights means this probe failed, and the useful
    // question is then whether the file 404'd (it never reached the bundle) or
    // the fetch threw (the scheme handler refused it). Guessing between those
    // two costs a rebuild; reporting it costs a string.
    bundledWhy: '',
    bundled: function () {
      if (this.bundledCache !== null) return Promise.resolve(this.bundledCache);
      const self = this;
      const url = './vendor/tts/models/' + MODEL_ID + '/config.json';
      return fetch(url)
        .then(function (r) {
          self.bundledCache = r.ok;
          if (!r.ok) self.bundledWhy = 'weights HTTP ' + r.status;
          return r.ok;
        })
        .catch(function (e) {
          self.bundledCache = false;
          self.bundledWhy = 'weights unreachable: '
            + String((e && e.message) || e).slice(0, 60);
          return false;
        });
    },

    removeDownload: function () {
      this.dispose();
      if (typeof caches === 'undefined') return Promise.resolve();
      return caches.open(TRANSFORMERS_CACHE).then(function (c) {
        return c.keys().then(function (keys) {
          return Promise.all(keys.map(function (req) {
            return req.url.indexOf(MODEL_ID) !== -1 ? c.delete(req) : null;
          }));
        });
      }).then(function () { return caches.delete(KOKORO_VOICES_CACHE); })
        // The engine itself (vendor/tts/**, kept by the service worker) goes
        // too — "Remove download" should mean all of it, not just the model.
        .then(function () { return caches.delete('or-voice-engine-v1'); })
        .catch(function () {});
    },
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Highlight — CSS Custom Highlight API when the browser has it (no DOM
  // mutation at all), a block-level class when it does not.
  // ─────────────────────────────────────────────────────────────────────────

  const highlighter = {
    supported: typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function',
    markedEl: null,

    apply: function (sentence) {
      this.clear();
      if (!state.prefs.highlight || !sentence || !state.bridge) return;
      const els = state.bridge.entryEls(state.chapterId);
      const node = els && els[sentence.blockIdx];
      if (!node || !node.isConnected) return;

      if (this.supported) {
        const range = rangeForOffsets(node, sentence.start, sentence.end);
        if (range) {
          try { CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range)); return; } catch (e) {}
        }
      }
      node.classList.add('vc-speaking-block');
      this.markedEl = node;
    },

    clear: function () {
      if (this.supported) { try { CSS.highlights.delete(HIGHLIGHT_NAME); } catch (e) {} }
      if (this.markedEl) { try { this.markedEl.classList.remove('vc-speaking-block'); } catch (e) {} this.markedEl = null; }
    },
  };

  // A Range over [start, end) character offsets inside an element's text
  // nodes — the same coordinates the reader's anchors use.
  function rangeForOffsets(root, start, end) {
    const range = document.createRange();
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let seen = 0, node, haveStart = false;
    while ((node = w.nextNode())) {
      const len = node.nodeValue.length;
      if (!haveStart && seen + len > start) {
        try { range.setStart(node, start - seen); } catch (e) { return null; }
        haveStart = true;
      }
      if (haveStart && seen + len >= end) {
        try { range.setEnd(node, clamp(end - seen, 0, len)); } catch (e) { return null; }
        return range;
      }
      seen += len;
    }
    if (haveStart) { try { range.setEnd(root, root.childNodes.length); return range; } catch (e) {} }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Controller — the sentence cursor and everything that reacts to it moving.
  // ─────────────────────────────────────────────────────────────────────────

  function currentSentence() { return state.sentences[state.index] || null; }

  function sentenceAnchor(s) {
    return { chapterId: state.chapterId, blockIdx: s.blockIdx, charInBlock: s.start };
  }

  // Re-segment for the reader's current chapter and aim the cursor at the
  // reader's own anchor, so Play always starts "from here".
  function seedFromReader() {
    const b = state.bridge;
    const rs = b.state();
    state.chapterId = rs.chapterId;
    const entry = b.entry(state.chapterId);
    state.sentences = entry ? segmentBlocks(entry.blocks, b.blockText, docLang()) : [];
    const a = rs.anchor && rs.anchor.chapterId === state.chapterId ? rs.anchor : { blockIdx: 0, charInBlock: 0 };
    state.index = sentenceIndexAt(state.sentences, a.blockIdx | 0, a.charInBlock | 0);
  }

  function onSentenceStart(s) {
    highlighter.apply(s);
    if (state.prefs.follow && s) {
      const b = state.bridge;
      const anchor = sentenceAnchor(s);
      // Only move the page when the sentence is not already on it — following
      // should feel like the page keeping up, not the page twitching per line.
      if (b.anchorVisible && !b.anchorVisible(anchor)) b.reveal(anchor);
    }
    updateBar();
  }

  function speakCurrent() {
    const s = currentSentence();
    if (!s) { onChapterExhausted(); return; }
    const token = ++state.speakToken;
    onSentenceStart(s);

    const done = function () {
      if (token !== state.speakToken || !state.playing) return;
      state.errors = 0;
      state.emptyHops = 0;
      // Two utterances survived → this platform does not crash on speech;
      // stand the crash-loop breaker down.
      state.spokeOk = (state.spokeOk | 0) + 1;
      if (state.spokeOk === 2) guardClear();
      advance(1);
    };
    const fail = function () {
      if (token !== state.speakToken || !state.playing) return;
      state.errors++;
      if (state.errors >= MAX_CONSECUTIVE_ERRORS) {
        toast('The voice keeps failing — stopped.');
        stopSession();
        return;
      }
      advance(1);
    };

    speakNeural(s, token, done, fail);
  }

  // A neural group: sentences[from..to] of ONE block, merged for one
  // generation call. Same-block only, so the highlight stays a single range
  // and a group never straddles a paragraph pause. Pure over its inputs —
  // the test page drives it directly.
  function groupSentences(list, from) {
    const first = list[from];
    if (!first) return null;
    let to = from;
    let chars = first.text.length;
    while (to + 1 < list.length) {
      const next = list[to + 1];
      if (next.blockIdx !== first.blockIdx) break;
      if (next.kind !== first.kind) break;
      // A `cont` piece is the back half of ONE sentence that splitLong cut for
      // the device engine's utterance cap. Ending a group there hands Kokoro a
      // clause with no resolution — it renders the trailing comma as a held,
      // rising note and then starts the remainder cold. Keep them together past
      // the normal caps, up to a ceiling that still generates in one go.
      if (next.cont) {
        if (chars + next.text.length > NEURAL_GROUP_CONT_MAX) break;
        chars += next.text.length;
        to++;
        continue;
      }
      if (chars >= NEURAL_GROUP_TARGET) break;
      if (chars + next.text.length > NEURAL_GROUP_MAX) break;
      chars += next.text.length;
      to++;
    }
    const last = list[to];
    const text = list.slice(from, to + 1).map(function (s) { return s.text; }).join(' ');
    return { from: from, to: to, blockIdx: first.blockIdx, start: first.start, end: last.end, text: text };
  }

  function neuralGroupAt(from) { return groupSentences(state.sentences, from); }

  function neuralKey(chapterId, g) {
    return chapterId + ':' + g.blockIdx + ':' + g.start + ':' + g.end + ':' + state.prefs.neuralVoice;
  }

  function speakNeural(s, token, done, fail) {
    const group = neuralGroupAt(state.index) || { from: state.index, to: state.index, blockIdx: s.blockIdx, start: s.start, end: s.end, text: s.text };
    // The highlight covers the whole spoken group, so the mark and the audio
    // always agree on what is being read.
    highlighter.apply(group);
    setPreparingSoon();
    const chapterId = state.chapterId;
    const groupDone = function () {
      if (token !== state.speakToken || !state.playing) return;
      state.index = group.to;      // land on the group's last sentence…
      done();                      // …then done() advances past it as usual
    };
    neuralEngine.generate(neuralKey(chapterId, group), normalizeForSpeech(group.text, 'neural'), state.prefs.neuralVoice)
      .then(function (url) {
        if (token !== state.speakToken || !state.playing) return;
        setPreparing(false);
        prefetchNeural(group);
        return channel.play(url, { rate: state.prefs.rate, onended: groupDone }).catch(function () {
          // Autoplay refusal — the chain lost its blessing (e.g. after a long
          // background stall). Pausing is honest; a tap resumes it.
          pause();
        });
      })
      .catch(function (e) {
        if (token !== state.speakToken || !state.playing) return;
        if (String(e && e.message) === 'cancelled') return;
        setPreparing(false);
        fail();
      });
    mediaSessionUpdate();
  }

  // Keep the next groups in flight while this one plays. The worker is a
  // serial queue, so this is "top the queue up to depth 2", not a stampede.
  function prefetchNeural(currentGroup) {
    if (!neuralEngine.worker) return;
    let from = currentGroup.to + 1;
    for (let k = 0; k < NEURAL_LOOKAHEAD; k++) {
      const g = neuralGroupAt(from);
      if (!g) break;
      const key = neuralKey(state.chapterId, g);
      if (!neuralEngine.wavCache.has(key)) {
        neuralEngine.generate(key, normalizeForSpeech(g.text, 'neural'), state.prefs.neuralVoice)
          .catch(function () { /* the on-cursor attempt will retry and report */ });
      }
      from = g.to + 1;
    }
  }

  function advance(delta) {
    const next = state.index + delta;
    if (next < 0) { state.index = 0; }
    else if (next >= state.sentences.length) { onChapterExhausted(); return; }
    else state.index = next;
    if (state.playing) speakCurrent();
    else {
      const s = currentSentence();
      if (s) onSentenceStart(s);
    }
  }

  function skip(delta) {
    if (!state.active) return;
    cancelSpeech();
    advance(delta);
  }

  function onChapterExhausted() {
    const b = state.bridge;
    if (!state.prefs.autoNext || !b) { finishSession('End of chapter.'); return; }
    const rs = b.state();
    const chapters = b.chapters();
    const idx = b.chapterIndex(state.chapterId);
    if (idx < 0 || idx + 1 >= chapters.length) { finishSession('End of book.'); return; }

    if (state.emptyHops >= 3) { finishSession('Nothing more to read aloud.'); return; }

    const next = chapters[idx + 1];
    const stacked = b.entryEls(next.id);   // already rendered → endless mode, keep the flow
    if (stacked || rs.mode !== 'infinite') {
      if (!stacked) {
        // Paged/scroll: turning the chapter is a real navigation, through the
        // same goChapter a tap uses. `voiceNav` tells our own chapter-change
        // callback apart from the user grabbing the controls.
        state.voiceNav = true;
        b.goChapter(1).then(function (ok) {
          state.voiceNav = false;
          if (!ok) { finishSession(null); return; }
          continueIntoChapter(next);
        });
        return;
      }
      continueIntoChapter(next);
      return;
    }
    // Endless mode but the next section is not in the DOM yet (reader far
    // behind, entry evicted): fall back to real navigation.
    state.voiceNav = true;
    b.goChapter(1).then(function (ok) {
      state.voiceNav = false;
      if (!ok) { finishSession(null); return; }
      continueIntoChapter(next);
    });
  }

  function continueIntoChapter(chapter) {
    const b = state.bridge;
    state.chapterId = chapter.id;
    const entry = b.entry(chapter.id);
    state.sentences = entry ? segmentBlocks(entry.blocks, b.blockText, docLang()) : [];
    state.index = 0;
    mediaSessionUpdate();
    if (!state.sentences.length) { state.emptyHops++; onChapterExhausted(); return; }
    if (!state.playing) { updateBar(); return; }
    speakCurrent();
  }

  function chapterAnnouncement(ch) {
    if (!ch) return '';
    const bits = [];
    if (ch.num != null) bits.push('Chapter ' + ch.num + '.');
    if (ch.title) bits.push(String(ch.title) + '.');
    return bits.join(' ');
  }

  function cancelSpeech() {
    state.speakToken++;
    clearTimeout(preparingTimer); preparingTimer = 0;
    neuralEngine.cancelPending();
    channel.stop();
    setPreparing(false);
  }

  // ── Play / pause / stop ───────────────────────────────────────────────────

  function play() {
    if (!state.bridge) return;
    if (state.playing) return;
    state.playing = true;
    state.errors = 0;
    // Armed until two utterances complete: if speech takes the page down
    // (WebKit home-screen apps have form here; low-memory phones OOM), the
    // flag survives the crash and the next session refuses to auto-play.
    if ((state.spokeOk | 0) < 2) guardArm('speak');

    if (!state.sentences.length || state.chapterId !== state.bridge.state().chapterId) seedFromReader();
    if (!state.sentences.length) { state.playing = false; onChapterExhausted(); return; }

    // First user gesture: bless the audio element while we still have it.
    channel.play(silentWavUrl(), {}).catch(function () {});

    ensureNeuralThenSpeak();
    mediaSessionWire();
    mediaSessionUpdate();
    updateBar();
  }

  function ensureNeuralThenSpeak() {
    // With one engine there is nothing to fall back TO, and that is the point:
    // every exit below ends the session with a sentence saying what is wrong,
    // instead of quietly handing the book to a voice nobody chose.
    const cap = neuralCapability();
    if (!cap.ok) {
      finishSession('The natural voice cannot run here — ' + cap.reason + '.');
      syncSheet();
      return;
    }
    if (!neuralSpeaks(docLang())) {
      finishSession('The natural voice reads English, and this book is not in English.');
      syncSheet();
      return;
    }
    setPreparingSoon();
    const token = state.speakToken;
    neuralEngine.ensureReady()
      .then(function () {
        syncSheet();
        if (!state.playing || token !== state.speakToken) return;
        speakCurrent();
      })
      .catch(function (e) {
        setPreparing(false);
        if (!state.active) return;
        neuralFallbackNote(e);
        stopSession();
      });
  }

  function neuralFallbackNote(e) {
    toast('The natural voice could not start: ' + shortErr(e));
    state.neuralError = shortErr(e);
    syncSheet();
  }

  function shortErr(e) {
    const m = e && e.message ? String(e.message) : 'unknown error';
    return m.length > 120 ? m.slice(0, 117) + '…' : m;
  }

  function pause() {
    if (!state.playing) return;
    state.playing = false;
    guardClear();    // we are demonstrably alive — no crash to guard against
    cancelSpeech();
    const s = currentSentence();
    if (s) highlighter.apply(s);   // keep the place visible while paused
    mediaSessionUpdate();
    updateBar();
  }

  function resume() { if (state.active && !state.playing) play(); }

  function togglePlay() { state.playing ? pause() : play(); }

  function startSession() {
    if (state.active) { openSheet(); return; }
    state.active = true;
    state.spokeOk = 0;
    state.prefs = readPrefs();
    ensureDom();
    seedFromReader();
    dom.bar.hidden = false;
    updateBar();
    updateListenBtn();
    // Crash-loop breaker: a fresh guard flag means the last narration attempt
    // never got two sentences out — on some platforms because it took the
    // whole page down. Starting paused turns a crash loop into a choice.
    const crashed = guardRead();
    if (crashed) {
      if (crashed.phase === 'model') {
        // The app died LOADING the model. Retrying that load on open is
        // retrying the crash, and there is no other voice to hand the book to,
        // so the session comes up paused and waits to be told twice.
        state.neuralBlocked = true;
        toast('Loading the natural voice closed the app last time. Press play to try again.');
        syncSheet();
        updateBar();
        return;
      }
      toast('Narration may have crashed the app last time — not starting by itself. Press play to retry, or pick another voice first.');
      updateBar();
      return;
    }
    state.neuralBlocked = false;
    // Autoplay on open: the tap on Listen IS the gesture, and a player that
    // appears silent makes everyone hunt for a second button.
    play();
  }

  function finishSession(message) {
    if (message) toast(message);
    stopSession();
  }

  function stopSession() {
    if (!state.active) return;
    state.playing = false;
    state.active = false;
    guardClear();    // a clean stop is proof of life, same as pause
    cancelSpeech();
    highlighter.clear();
    // Deliberately NOT closeSheet(): if the stop came from an engine failure
    // while the settings sheet was up, yanking the sheet away also yanks the
    // error message the reader needs. The sheet has its own X and scrim; the
    // reader-close and new-book paths close it explicitly.
    if (dom.bar) dom.bar.hidden = true;
    state.sentences = [];
    state.index = 0;
    state.chapterId = null;
    mediaSessionClear();
    // Let the model idle-out rather than die: the weights stay in the browser
    // cache either way, but a warm session skips the whole re-init.
    neuralEngine.release();
    updateListenBtn();
  }

  let preparingTimer = 0;

  function setPreparing(v) {
    if (!v) { clearTimeout(preparingTimer); preparingTimer = 0; }
    if (state.preparing === !!v) return;
    state.preparing = !!v;
    updateBar();
  }

  // Arm the "Preparing voice…" state only if the wait turns out to be real —
  // cache hits and fast generations must not strobe the bar every sentence.
  function setPreparingSoon() {
    clearTimeout(preparingTimer);
    preparingTimer = setTimeout(function () {
      preparingTimer = 0;
      state.preparing = true;
      updateBar();
    }, PREPARING_DELAY_MS);
  }

  function toast(msg) {
    if (state.bridge && state.bridge.toast) state.bridge.toast(msg);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Reader events — the whole coupling to novel-reader.js.
  // ─────────────────────────────────────────────────────────────────────────

  function readerEvent(kind, info, bridge) {
    if (kind === 'open') {
      // open() also fires when a NEW book replaces the current one without a
      // close in between; narration must never carry across that seam.
      if (state.active) stopSession();
      closeSheet();
      state.bridge = bridge || state.bridge;
      state.prefs = readPrefs();
      prewarmNeural();
      return;
    }
    if (!state.bridge) return;

    if (kind === 'close') {
      stopSession();
      closeSheet();
      state.bridge = null;
      return;
    }

    if (kind === 'chapter') {
      // Our own auto-advance also lands here; that one is already handled.
      if (state.voiceNav || !state.active) return;
      // The user moved to another chapter under us. Following them beats
      // stopping: re-seed at their new position, keep playing if playing.
      const wasPlaying = state.playing;
      cancelSpeech();
      seedFromReader();
      if (wasPlaying) speakCurrent();
      else { const s = currentSentence(); if (s) highlighter.apply(s); updateBar(); }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UI — the listen bar and the voice sheet. All chrome, all ours, mounted
  // inside #novel-screen so the reader's theme tokens cascade for free.
  // ─────────────────────────────────────────────────────────────────────────

  const ICON = {
    play:  'M8 5.5 L18 12 L8 18.5 Z',
    pause: 'M8.5 5.5 V18.5 M15.5 5.5 V18.5',
    prev:  'M11 6 L5.5 12 L11 18 M18 6 L12.5 12 L18 18',
    next:  'M13 6 L18.5 12 L13 18 M6 6 L11.5 12 L6 18',
    close: 'M18 6 L6 18 M6 6 L18 18',
    voice: 'M4 10 v4 M8.5 7 v10 M13 4.5 v15 M17.5 8 v8 M22 11 v2',
  };

  function iconBtn(label, kind, big) {
    const b = el('button', 'vc-btn' + (big ? ' vc-btn-big' : ''));
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const size = big ? '26' : '20';
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON[kind] || ICON.play);
    svg.appendChild(path);
    b.appendChild(svg);
    return b;
  }

  function setIcon(btn, kind) {
    const path = btn.querySelector('path');
    if (path) path.setAttribute('d', ICON[kind] || ICON.play);
  }

  function ensureDom() {
    if (built) return;
    built = true;

    // ── Listen bar ────────────────────────────────────────────────────────
    const bar = el('div', 'vc-bar');
    bar.hidden = true;
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Listening controls');

    const voiceBtn = iconBtn('Voice settings', 'voice');
    const prevBtn = iconBtn('Previous sentence', 'prev');
    const playBtn = iconBtn('Pause', 'pause', true);
    playBtn.classList.add('vc-play');
    const spinner = el('span', 'vc-spinner');
    spinner.setAttribute('aria-hidden', 'true');
    playBtn.appendChild(spinner);
    const nextBtn = iconBtn('Next sentence', 'next');
    const closeBtn = iconBtn('Stop listening', 'close');

    const status = el('div', 'vc-status');
    const statusLine = el('span', 'vc-status-line');
    statusLine.setAttribute('aria-live', 'polite');
    status.appendChild(statusLine);

    bar.append(voiceBtn, prevBtn, playBtn, nextBtn, closeBtn, status);

    voiceBtn.addEventListener('click', function () { sheetOpen ? closeSheet() : openSheet(); });
    prevBtn.addEventListener('click', function () { skip(-1); });
    nextBtn.addEventListener('click', function () { skip(1); });
    playBtn.addEventListener('click', function () { togglePlay(); });
    closeBtn.addEventListener('click', function () { stopSession(); });

    // ── Voice sheet ───────────────────────────────────────────────────────
    const scrim = el('div', 'vc-scrim');
    scrim.hidden = true;
    scrim.addEventListener('click', function () { closeSheet(); });

    const sheet = buildSheet();

    Object.assign(dom, { bar, playBtn, statusLine, scrim, sheet });
    state.bridge.mount(bar);
    state.bridge.mount(scrim);
    state.bridge.mount(sheet);
  }

  function updateBar() {
    if (!dom.bar || dom.bar.hidden) return;
    const playing = state.playing;
    setIcon(dom.playBtn, playing ? 'pause' : 'play');
    dom.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    dom.playBtn.title = playing ? 'Pause' : 'Play';
    dom.playBtn.classList.toggle('vc-preparing', state.preparing);
    const n = state.sentences.length;
    const at = n ? state.index + 1 : 0;
    // "Preparing voice…" alone is why "it read the title and stopped" was
    // unreadable: a gap because the engine is grinding and a gap because it
    // died look the same. The last group's cost says which, in the place a
    // reader is already staring at while waiting.
    const sp = neuralEngine.speed;
    dom.statusLine.textContent = state.preparing
      ? (sp
          ? 'Preparing voice… (last: ' + (sp.ms / 1000).toFixed(1) + 's for '
            + sp.seconds.toFixed(1) + 's of speech)'
          : 'Preparing voice…')
      : (n ? at + ' / ' + n : 'Nothing to read');
  }

  // The Listen button in the reader header mirrors whether a session is up.
  function updateListenBtn() {
    if (state.bridge && state.bridge.listenPressed) state.bridge.listenPressed(state.active);
  }

  // ── Voice sheet ─────────────────────────────────────────────────────────

  function buildSheet() {
    const sheet = el('aside', 'vc-sheet');
    sheet.hidden = true;
    sheet.inert = true;
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Voice settings');

    const head = el('div', 'vc-sheet-head');
    head.appendChild(el('h2', null, 'Voice'));
    const closeBtn = iconBtn('Close voice settings', 'close');
    closeBtn.addEventListener('click', function () { closeSheet(); });
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    const body = el('div', 'vc-sheet-body');
    sheet.appendChild(body);

    // ── Natural voice panel ───────────────────────────────────────────────
    const natRow = el('div', 'vc-row vc-neural-row');
    natRow.appendChild(el('span', 'vc-row-label', 'Natural voice'));

    const natStatus = el('div', 'vc-nat-status');
    const natText = el('div', 'vc-hint');
    // Always on screen, whatever the verdict. Shown only on failure, its
    // absence meant two different things — "the engine is fine" and "this
    // build predates the check" — and telling those apart cost a round trip
    // every time. A line that is always there answers both at a glance.
    const natEngine = el('div', 'vc-hint vc-engine-line');
    const natBar = el('div', 'vc-progress');
    natBar.appendChild(el('i'));
    natBar.hidden = true;
    const natAction = el('button', 'vc-action');
    natAction.type = 'button';
    natAction.textContent = 'Download voice (~90 MB)';
    natStatus.append(natText, natBar, natAction, natEngine);
    natRow.appendChild(natStatus);

    const natVoices = el('div', 'vc-chip-rail');
    natVoices.setAttribute('role', 'radiogroup');
    natVoices.setAttribute('aria-label', 'Narrator');
    for (let i = 0; i < NEURAL_VOICES.length; i++) {
      (function (v) {
        const chip = el('button', 'vc-chip');
        chip.type = 'button';
        chip.dataset.voice = v.id;
        chip.append(el('span', 'vc-chip-name', v.label), el('span', 'vc-chip-note', v.note));
        chip.addEventListener('click', function () {
          state.prefs.neuralVoice = v.id;
          prefSet(PREF.neuralVoice, v.id);
          syncSheet();
          restartCurrentIfPlaying();
        });
        natVoices.appendChild(chip);
      })(NEURAL_VOICES[i]);
    }
    natRow.appendChild(natVoices);

    // Preview is the only tool left here. The GPU toggle is gone (it bought a
    // 330 MB download and a dead process), and so is "Remove download" —
    // there is nothing to remove from a build that carries its own weights,
    // and on a build that does not, removing them helps no one.
    const natTools = el('div', 'vc-nat-tools');
    const preview2 = previewBtn();
    preview2.addEventListener('click', function () { previewVoice(); });
    natTools.append(preview2);
    natRow.appendChild(natTools);
    body.appendChild(natRow);

    natAction.addEventListener('click', function () { downloadNeural(); });

    // ── Speed / pitch ─────────────────────────────────────────────────────
    body.appendChild(stepRow('Speed', {
      get: function () { return state.prefs.rate; },
      fmt: function (v) { return v.toFixed(2).replace(/0$/, '') + '×'; },
      dec: function () { setRate(state.prefs.rate - RATE_STEP); },
      inc: function () { setRate(state.prefs.rate + RATE_STEP); },
    }));

    const pitchRow = stepRow('Pitch', {
      get: function () { return state.prefs.pitch; },
      fmt: function (v) { return v.toFixed(2).replace(/0$/, ''); },
      dec: function () { setPitch(state.prefs.pitch - PITCH_STEP); },
      inc: function () { setPitch(state.prefs.pitch + PITCH_STEP); },
    });
    pitchRow.classList.add('vc-pitch-row');
    body.appendChild(pitchRow);

    // ── Behaviour toggles ─────────────────────────────────────────────────
    body.appendChild(toggleRow('Follow along', 'Turns pages and scrolls with the narration', 'follow', PREF.follow));
    body.appendChild(toggleRow('Auto next chapter', 'Keeps reading into the next chapter', 'autoNext', PREF.autoNext));
    body.appendChild(toggleRow('Highlight sentence', 'Marks the sentence being read', 'highlight', PREF.highlight, function () {
      const s = currentSentence();
      if (state.active && s && state.prefs.highlight) highlighter.apply(s);
      else highlighter.clear();
    }));

    // Focus stays inside while open, same trap the reader's sheet uses.
    // Every key is stopped here: without this, Space/arrows on a focused
    // control ALSO reach the reader's document-level handler and turn the
    // page underneath the open sheet.
    sheet.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
      if (e.key !== 'Tab') return;
      const focusable = sheet.querySelectorAll('button:not([disabled]):not([hidden]), select, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    // Everything the sheet shows that can change from outside it.
    sheetSync.push(function () {
      // Pitch was a speechSynthesis knob; Kokoro has no equivalent.
      pitchRow.hidden = true;
      const chips = natVoices.querySelectorAll('.vc-chip');
      for (let i = 0; i < chips.length; i++) {
        const onV = chips[i].dataset.voice === state.prefs.neuralVoice;
        chips[i].classList.toggle('vc-on', onV);
        chips[i].setAttribute('aria-checked', String(onV));
      }
      natEngine.textContent = neuralCapabilityLine();
      syncNeuralStatus(natText, natBar, natAction, removeBtn);
    });

    return sheet;
  }


  function previewBtn() {
    const b = el('button', 'vc-action');
    b.type = 'button';
    b.textContent = 'Preview';
    return b;
  }

  function stepRow(label, cfg) {
    const row = el('div', 'vc-row');
    row.appendChild(el('span', 'vc-row-label', label));
    const wrap = el('div', 'vc-step');
    const dec = el('button', 'vc-step-btn', '−');
    dec.type = 'button'; dec.setAttribute('aria-label', label + ' down');
    const val = el('span', 'vc-step-val');
    const inc = el('button', 'vc-step-btn', '+');
    inc.type = 'button'; inc.setAttribute('aria-label', label + ' up');
    wrap.append(dec, val, inc);
    row.appendChild(wrap);
    dec.addEventListener('click', cfg.dec);
    inc.addEventListener('click', cfg.inc);
    sheetSync.push(function () { val.textContent = cfg.fmt(cfg.get()); });
    return row;
  }

  function toggleRow(label, note, prefKey, storeKey, after) {
    const row = el('div', 'vc-row');
    const toggle = el('button', 'vc-toggle');
    toggle.type = 'button';
    const labels = el('span', 'vc-toggle-labels');
    labels.append(el('span', null, label), el('span', 'vc-toggle-note', note));
    toggle.append(labels, el('span', 'vc-pill', 'On'));
    toggle.addEventListener('click', function () {
      state.prefs[prefKey] = !state.prefs[prefKey];
      prefSet(storeKey, state.prefs[prefKey]);
      syncSheet();
      if (after) after();
    });
    row.appendChild(toggle);
    sheetSync.push(function () {
      const on = !!state.prefs[prefKey];
      toggle.setAttribute('aria-pressed', String(on));
      toggle.lastChild.textContent = on ? 'On' : 'Off';
    });
    return row;
  }

  function syncNeuralStatus(natText, natBar, natAction, removeBtn) {
    // Before download state, before anything: if the engine cannot run on this
    // runtime, that is the whole story and the rest of the panel is noise.
    const cap = neuralCapability();
    if (!cap.ok) {
      natText.textContent = 'Not available on this device: ' + cap.reason + '.';
      natBar.hidden = true;
      natAction.hidden = true;
      removeBtn.hidden = true;
      return;
    }
    // Said before anything about downloads: offering a 90 MB download for a
    // book the engine cannot read would be the app wasting someone's data.
    if (state.bridge && !neuralSpeaks(docLang())) {
      natText.textContent = 'This narrator reads English, and this book is not in English.';
      natBar.hidden = true;
      natAction.hidden = true;
      removeBtn.hidden = !state.neuralHave;
      return;
    }
    const initInFlight = !!(neuralEngine.readyPromise && !neuralEngine.ready);
    if (state.neuralDownloading || initInFlight) {
      if (state.neuralPhase === 'init') {
        // Naming the step live, rather than only in the stall message three
        // minutes later. "Preparing the narrator" with no step is what made
        // this bug take three rounds: a reader watching it had nothing to
        // report, so every screenshot of it was compatible with every theory.
        natText.textContent = 'Preparing the narrator on this device'
          + (neuralEngine.stage ? ' — ' + neuralEngine.stage : '')
          + ' — the first time can take up to a minute…';
        natBar.hidden = false;
        natBar.firstChild.style.width = '100%';
      } else {
        natText.textContent = state.neuralProgressText || 'Loading narrator…';
        natBar.hidden = false;
        natBar.firstChild.style.width = Math.round((state.neuralProgress || 0) * 100) + '%';
      }
      natAction.hidden = true;
      removeBtn.hidden = true;
      return;
    }
    natBar.hidden = true;
    if (state.neuralError) {
      natText.textContent = 'Could not load: ' + state.neuralError;
      natAction.hidden = false;
      natAction.textContent = 'Try again';
      removeBtn.hidden = true;
      return;
    }
    if (neuralEngine.ready) {
      natText.textContent = 'Ready — running on this device ('
        + ')'
        + (state.neuralBundled ? ', included with the app' : '') + '. Works offline.';
      natAction.hidden = true;
      removeBtn.hidden = false;
      return;
    }
    // Not loaded, nothing in flight: answer from the cached probe. The probe
    // refreshes itself once when unknown — no per-sync cache reads, no
    // "Checking…" flicker on every control tap.
    if (state.neuralHave == null) {
      natText.textContent = '…';
      natAction.hidden = true;
      removeBtn.hidden = true;
      refreshNeuralHave();
      return;
    }
    if (state.neuralBundled) {
      // Shipped in the app. There is nothing to download and nothing to remove
      // — "Remove download" here would delete a file the next launch restores.
      natText.textContent = 'Included with the app — nothing to download, works offline.';
      natAction.hidden = true;
      removeBtn.hidden = true;
    } else if (state.neuralHave) {
      natText.textContent = 'Downloaded — loads when you press play. Works offline.';
      natAction.hidden = true;
      removeBtn.hidden = false;
    } else if (isNativeApp()) {
      // In the app the weights are supposed to BE the app. Missing them is a
      // build that skipped scripts/fetch-voice-model.mjs, and a download button
      // would paper over that instead of surfacing it.
      natText.textContent = 'The narrator is missing from this build. It should ship inside the app — '
        + 'rebuild with scripts/fetch-voice-model.mjs, then npm run sync.';
      natAction.hidden = true;
      removeBtn.hidden = true;
    } else {
      natText.textContent = 'An 82-million-parameter narrator that runs entirely on this device. One download, then it works offline.';
      natAction.hidden = false;
      natAction.textContent = 'Download voice (~90 MB)';
      removeBtn.hidden = true;
    }
  }

  function downloadNeural() {
    state.neuralDownloading = true;
    state.neuralError = null;
    state.neuralPhase = 'download';
    state.neuralProgress = 0;
    state.neuralProgressText = 'Starting download…';
    syncSheet();
    neuralEngine.ensureReady()
      .then(function () {
        state.neuralDownloading = false;
        state.neuralHave = true;
        syncSheet();
        toast('Natural voice ready.');
      })
      .catch(function (e) {
        state.neuralDownloading = false;
        state.neuralPhase = null;
        state.neuralError = shortErr(e);
        syncSheet();
      });
  }

  // ── Engine progress → UI state, one handler for every init path ─────────
  //
  // Whether the engine came up via the Download button, the play button, or
  // the open-book prewarm, the sheet shows the same three phases: loading
  // files (with a byte bar), preparing on-device (the ONNX session compile —
  // previously a silent half-minute that read as a hang), ready. Progress
  // events arrive per network chunk, so sheet syncs are trailing-throttled.

  let sheetSyncTimer = 0;
  function syncSheetSoon() {
    if (sheetSyncTimer) return;
    sheetSyncTimer = setTimeout(function () { sheetSyncTimer = 0; syncSheet(); }, 120);
  }

  function handleNeuralProgress(m) {
    // The worker says which source it is loading from before the first byte
    // moves, which is the only answer that arrives in time to label the
    // progress that follows. refreshNeuralHave's probe may not have run yet.
    if (m.type === 'source') {
      state.neuralBundled = !!m.local;
      syncSheetSoon();
      return;
    }
    // A step announcement carries no bytes, but it is the only thing that
    // changes during a session compile — which is precisely the stretch that
    // used to look like a hang. Repaint so the label tracks it.
    if (m.type === 'stage') {
      syncSheetSoon();
      return;
    }
    if (m.type === 'ready') {
      state.neuralDownloading = false;
      state.neuralPhase = 'ready';
      state.neuralHave = true;
      syncSheetSoon();
      return;
    }
    if (!m.file || !/\.onnx/.test(m.file)) return;   // the model file is the story
    if (m.status === 'done') {
      state.neuralPhase = 'init';
      state.neuralProgress = 1;
      syncSheetSoon();
      return;
    }
    if (m.total) {
      // "Loading", not "Downloading": warm starts stream the same events out
      // of the browser cache, just faster.
      state.neuralPhase = 'download';
      state.neuralProgress = m.loaded / m.total;
      // Bundled weights stream the same progress events as a download does.
      // Showing megabytes for a file that is already on the device reads as a
      // download that should not be happening, so only the network gets numbers.
      state.neuralProgressText = state.neuralBundled
        ? 'Loading the narrator from the app…'
        : 'Downloading narrator — ' + Math.round(m.loaded / 1048576)
          + ' / ' + Math.round(m.total / 1048576) + ' MB';
      if (m.loaded >= m.total) state.neuralPhase = 'init';
      syncSheetSoon();
    }
  }
  neuralEngine.onprogress = handleNeuralProgress;

  let neuralProbeInFlight = false;
  function refreshNeuralHave(cb) {
    if (neuralProbeInFlight) return;
    neuralProbeInFlight = true;
    neuralEngine.bundled().then(function (inApp) {
      state.neuralBundled = inApp;
      return neuralEngine.downloaded();
    }).then(function (have) {
      neuralProbeInFlight = false;
      state.neuralHave = have;
      syncSheetSoon();
      if (cb) cb(have);
    });
  }



  function prewarmNeural() {
    if (!neuralEngine.available()) return;
    if (!neuralSpeaks(docLang())) return;   // this book will use the device voice
    // Opening a book must never be what kills the app. This path has no user
    // action behind it, so after a load-phase crash it is the first thing to
    // stand down — a background half-gigabyte is not worth one warm start.
    if (!neuralCapability().ok) return;
    const crashed = guardRead();
    if (crashed && crashed.phase === 'model') return;

    // Prewarming is a HIGH-memory-class luxury. Loading half a gigabyte of
    // model in the background of every book open is exactly the kind of
    // pressure that gets a phone's tab OOM-killed — there, the engine loads
    // when (and only when) play is pressed.
    if (memoryClass() !== 'high') return;
    refreshNeuralHave(function (have) {
      if (!have) return;
      neuralEngine.ensureReady()
        .then(function () { syncSheetSoon(); })
        .catch(function (e) { state.neuralError = shortErr(e); syncSheetSoon(); });
    });
  }


  function setRate(v) {
    state.prefs.rate = clamp(Math.round(v * 100) / 100, RATE_MIN, RATE_MAX);
    prefSet(PREF.rate, state.prefs.rate);
    syncSheet();
    // The neural channel can change speed mid-sentence; the device engine
    // picks the new rate up on the next utterance.
    channel.setRate(state.prefs.rate);
  }

  function setPitch(v) {
    state.prefs.pitch = clamp(Math.round(v * 100) / 100, PITCH_MIN, PITCH_MAX);
    prefSet(PREF.pitch, state.prefs.pitch);
    syncSheet();
  }

  // Engine/voice switches take effect immediately when narration is running —
  // the current sentence restarts in the new voice, which doubles as the
  // audition for it.
  function restartCurrentIfPlaying() {
    if (!state.active) return;
    if (state.playing) { cancelSpeech(); state.playing = true; speakCurrent(); }
  }

  function previewVoice() {
    const wasPlaying = state.playing;
    if (wasPlaying) pause();
    const done = function () { if (wasPlaying) resume(); };
    const cap = neuralCapability();
    if (!cap.ok) { toast('The natural voice cannot run here — ' + cap.reason + '.'); done(); return; }
    setPreparing(true);
    neuralEngine.ensureReady()
      .then(function () {
        return neuralEngine.generate('preview:' + state.prefs.neuralVoice, PREVIEW_TEXT, state.prefs.neuralVoice);
      })
      .then(function (url) {
        setPreparing(false);
        syncSheet();
        return channel.play(url, { rate: state.prefs.rate, onended: done });
      })
      .catch(function (e) {
        // Preview failing silently is what made it look like a dead button.
        setPreparing(false);
        state.neuralError = shortErr(e);
        toast('Preview failed: ' + state.neuralError);
        syncSheet();
        done();
      });
  }

  // Same animation contract as the reader's own sheet: [hidden] keeps the
  // element displayed but translated off-screen, so toggling `hidden` IS the
  // slide, and `inert` is what actually removes it from the tab order.
  function openSheet() {
    if (!dom.sheet) return;
    // One sheet at a time: ours replaces the reader's Aa sheet rather than
    // stacking on it (both dock right on wide viewports).
    if (state.bridge && state.bridge.closeSettingsSheet) {
      try { state.bridge.closeSettingsSheet(); } catch (e) {}
    }
    sheetOpen = true;
    syncSheet();
    dom.sheet.hidden = false;
    dom.sheet.inert = false;
    dom.scrim.hidden = false;
    const first = dom.sheet.querySelector('button');
    if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }

  function closeSheet() {
    if (!sheetOpen || !dom.sheet) return;
    sheetOpen = false;
    dom.sheet.hidden = true;
    dom.sheet.inert = true;
    dom.scrim.hidden = true;
  }

  function syncSheet() {
    if (!built) return;
    for (let i = 0; i < sheetSync.length; i++) {
      try { sheetSync[i](); } catch (e) { /* one stale control must not break the rest */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — docs/ARCHITECTURE.md §2.14
  // ─────────────────────────────────────────────────────────────────────────

  window.NovelVoice = {
    /** novel-reader.js calls this on open/close/chapter — see §2.14. */
    readerEvent: readerEvent,

    /** The header Listen button lands here. Toggles the session. */
    toggle: function () {
      if (state.active) stopSession();
      else startSession();
    },

    isActive: function () { return !!state.active; },

    /** novel-reader closes our sheet when its own settings sheet opens —
        the mirror of the closeSettingsSheet call we make through the bridge. */
    closeSheet: function () { closeSheet(); },

    /** Read-only diagnostics. Used by test/novel-voice.test.html. */
    state: function () {
      return {
        active: state.active,
        playing: state.playing,
        preparing: state.preparing,
        engine: 'neural',
        chapterId: state.chapterId,
        index: state.index,
        sentenceCount: state.sentences.length,
        follow: state.prefs.follow,
        autoNext: state.prefs.autoNext,
        highlight: state.prefs.highlight,
        rate: state.prefs.rate,
        errors: state.errors,
        sheetOpen: sheetOpen,
        highlightMode: highlighter.supported ? 'range' : 'block',
      };
    },

    /** Pure pieces exposed for the test page; not API for other modules. */
    _test: {
      segmentBlocks: segmentBlocks,
      sentenceIndexAt: sentenceIndexAt,
      groupSentences: groupSentences,
      normalizeForSpeech: normalizeForSpeech,
      encodeWav: encodeWav,
      readPrefs: readPrefs,
      neuralEngine: neuralEngine,
      channel: channel,
      skip: skip,
      pause: pause,
      resume: resume,
      guardRead: guardRead,
      neuralCapability: neuralCapability,
      resetCapability: function () { neuralCapabilityCache = null; },
      neuralCapabilityLine: neuralCapabilityLine,
      guardArm: guardArm,
      NEURAL_INIT_STALL_MS: NEURAL_INIT_STALL_MS,
    },
  };
})();
