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
  // How far ahead of the reader the generator tries to stay, counted in
  // SECONDS OF PLAYBACK rather than in groups. Groups shrink on a slow device
  // (neuralGroupCaps), so a fixed group count buys the least runway on exactly
  // the devices that need the most: two 90-character groups is a third of the
  // cushion two 300-character ones gave, and the shrink is triggered by the
  // device being slow. Seconds are the quantity that actually has to cover the
  // next generation, so seconds are what the lookahead counts.
  const NEURAL_LOOKAHEAD_MIN = 1;    // groups, however long they are
  const NEURAL_LOOKAHEAD_MAX = 30;   // groups; bounded by WAV_CACHE_MAX
  // …and how many of those seconds are worth chasing depends entirely on
  // whether this device can ever get ahead. See lookaheadSeconds().
  const NEURAL_LOOKAHEAD_SEC = 40;   // playback seconds of cushion, to absorb wobble
  // Below break-even there is no idle to protect and depth is free, so the
  // only real bound is the cache. See lookaheadSeconds().
  const NEURAL_LOOKAHEAD_DEEP = 240;

  // The first group after a tap on Play is the one a reader is actually
  // waiting through, and the only one with nothing already generated behind
  // it. It gets its own caps: one sentence, as short as the prose allows, so
  // the voice starts speaking while the normal-sized groups behind it are
  // still rendering. Applies to the cursor's group only — the lookahead keeps
  // the real caps, so nothing generated during the fast start is thrown away
  // when the boundaries go back to normal.
  const FAST_START_CAPS = { target: 1, max: 40, contMax: 140 };
  // The queue is topped up on this interval as well as at group boundaries.
  // A boundary top-up looks at the queue once per clip and then not again for
  // as long as that clip plays, which is precisely the window there was spare
  // time to generate in.
  const NEURAL_PUMP_MS = 2000;
  // Characters of prose per second of audio, until this voice has produced a
  // group and the real figure is known. Only used to size the buffer; being
  // wrong makes the cushion the wrong length, not the playback wrong.
  const NEURAL_CHARS_PER_SEC = 15;
  const NEURAL_TIMEOUT_MS = 120000;  // one group; the first pays session warm-up
  // Silence from the worker during init. Not a deadline for the whole load —
  // every message resets it — so a slow download and a slow ONNX session
  // compile each get this long with nothing to say before we call it dead.
  const NEURAL_INIT_STALL_MS = 180000;
  // Big enough to hold a whole pre-buffer, not just a lookahead. Forty clips
  // of seven seconds is about thirteen megabytes of PCM, which is nothing set
  // against the model already resident.
  const WAV_CACHE_MAX = 64;          // generated groups kept for replay/skip-back

  // ── Pre-buffering ────────────────────────────────────────────────────────
  //
  // Below break-even the arithmetic is not a matter of scheduling. Over a
  // chapter of D seconds the engine produces margin×D and the reader consumes
  // D, so it ends the chapter (1 − margin)×D short however cleverly the work
  // is ordered. There is no policy that makes 0.92 into 1.0.
  //
  // But that deficit is a fixed quantity, and it can be paid before the first
  // word instead of a second at a time in the middle of sentences. A 0.92×
  // engine on a ten-minute chapter is 48 seconds short; buy those 48 seconds
  // up front and the rest plays through without a gap. One wait a reader can
  // see the end of beats a stutter every few seconds, which is the actual
  // complaint.
  const NEURAL_PREBUFFER_MAX_SEC = 60;    // wall seconds anyone is asked to wait
  const NEURAL_PREBUFFER_SAFETY = 1.35;   // the margin drifts, and phones throttle
  const NEURAL_PREBUFFER_FLOOR = 1.05;    // above this there is no deficit to pay
  const NEURAL_PREBUFFER_TICK_MS = 400;

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
  const PREWARM_DELAY_MS = 1500;

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
   * Every field here was added because its absence cost a rebuild. `app` and
   * `weights` in particular: a screenshot once showed "Download voice
   * (~90 MB)" on a native build, which syncNeuralStatus only renders on the
   * WEB branch, while the line reported no weights failure at all. Those two
   * facts cannot both be true, and neither one alone said which was lying.
   *
   * `app` rather than `native` because `inference` is also native or not, and
   * a line carrying the same word for two unrelated things answers neither.
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
      + ' · app: ' + (isNativeApp() ? 'native' : 'web')
      + ' · ' + weights
      + (neuralEngine.stage ? ' · stage: ' + neuralEngine.stage : '')
      + (neuralEngine.note ? ' · note: ' + neuralEngine.note : '')
      + ' · inference: ' + (neuralEngine.native
          ? 'native' + (neuralEngine.provider ? '/' + neuralEngine.provider : '')
            + (neuralEngine.nativeWeights ? ' ' + neuralEngine.nativeWeights : '')
          : 'wasm')
      + (neuralEngine.speed
          ? ' · last group: ' + neuralEngine.speed.chars + ' chars, '
            + (neuralEngine.speed.ms / 1000).toFixed(1) + 's compute for '
            + neuralEngine.speed.seconds.toFixed(1) + 's audio ('
            + neuralEngine.speed.ratio.toFixed(2) + '× realtime, '
            + neuralMargin().toFixed(2) + '× at this speed)'
          : '')
      + (syncError ? ' · sheet: ' + syncError : '')
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
    narrator:     'voice.narrator',
    rate:         'voice.rate',
    pitch:        'voice.pitch',
    neuralVoice:  'voice.neuralVoice',
    systemVoice:  'voice.systemVoice',
    follow:       'voice.follow',
    autoNext:     'voice.autoNext',
    highlight:    'voice.highlight',
  };

  // 'natural' is Kokoro in a worker; 'iphone' is the OS through Platform.speech.
  const NARRATORS = ['natural', 'iphone'];

  const DEFAULTS = {
    rate: 1,
    pitch: 1,
    neuralVoice: 'af_heart',
    systemVoice: '',        // '' = whatever iOS picks for the language
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
      narrator:     defaultNarrator(),
      neuralVoice:  validNeuralVoice(prefGet(PREF.neuralVoice, DEFAULTS.neuralVoice)),
      systemVoice:  String(prefGet(PREF.systemVoice, DEFAULTS.systemVoice) || ''),
      follow:       prefGet(PREF.follow, DEFAULTS.follow) !== false,
      autoNext:     prefGet(PREF.autoNext, DEFAULTS.autoNext) !== false,
      highlight:    prefGet(PREF.highlight, DEFAULTS.highlight) !== false,
    };
  }


  /**
   * Which narrator to start on.
   *
   * On a device with the OS narrator available, that one — because it works.
   * The natural voice is better and the reader can have it in one tap, but it
   * generates slower than it speaks on real hardware, and an app whose default
   * setting is "silence for ten minutes" is not offering a choice, it is
   * broken with an escape hatch. A stored preference always wins; this only
   * decides what happens before anyone has expressed one.
   */
  function defaultNarrator() {
    const stored = prefGet(PREF.narrator, null);
    if (NARRATORS.indexOf(stored) !== -1) return stored;
    return systemSpeech().available() ? 'iphone' : 'natural';
  }

  /** Platform.kokoro, or a web-shaped stand-in so callers need no guards. */
  function nativeKokoro() {
    try {
      if (window.Platform && window.Platform.kokoro) return window.Platform.kokoro;
    } catch (e) { /* fall through */ }
    return {
      available: function () { return false; },
      probe: function () { return Promise.resolve(null); },
      infer: function () { return Promise.resolve(null); },
      release: function () { return Promise.resolve(); },
    };
  }

  /** Platform.speech, or a web-shaped stand-in so callers need no guards. */
  function systemSpeech() {
    try {
      if (window.Platform && window.Platform.speech) return window.Platform.speech;
    } catch (e) { /* fall through */ }
    return {
      available: function () { return false; },
      voices: function () { return Promise.resolve([]); },
      speak: function () { return Promise.resolve(false); },
      stop: function () { return Promise.resolve(); },
      pause: function () { return Promise.resolve(); },
      resume: function () { return Promise.resolve(); },
    };
  }

  // Best first. iOS's own tier is the sort key, so a reader opening the picker
  // sees the voices worth using at the top rather than hunting for them among
  // a dozen compact ones.
  const SYSTEM_QUALITY_RANK = { premium: 0, enhanced: 1, default: 2 };

  function rankSystemVoices(list) {
    return (list || []).slice().sort(function (a, b) {
      const qa = SYSTEM_QUALITY_RANK[a.quality];
      const qb = SYSTEM_QUALITY_RANK[b.quality];
      if (qa !== qb) return (qa == null ? 3 : qa) - (qb == null ? 3 : qb);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function systemVoiceNote(v) {
    if (v.personal) return 'Personal Voice';
    if (v.quality === 'premium') return 'Premium';
    if (v.quality === 'enhanced') return 'Enhanced';
    return 'Compact';
  }

  /**
   * What to say above the voice list.
   *
   * When every installed voice is the compact one, that is the whole story and
   * the reader can fix it in a minute. Saying "this is the robot voice, here is
   * where the good ones live" is worth more than any amount of tuning on our
   * side, and it is the thing nobody told them the first time round.
   */
  function systemVoiceHint() {
    const list = state.systemVoices || [];
    if (!list.length) return 'No voices installed for this language.';
    const good = list.filter(function (v) {
      return v.quality === 'premium' || v.quality === 'enhanced' || v.personal;
    });
    if (!good.length) {
      return 'Only the compact voice is installed — that is the robotic one. '
        + 'Settings → Accessibility → Spoken Content → Voices → English, then '
        + 'download an Enhanced or Premium voice and it will appear here.';
    }
    return good.length + (good.length === 1 ? ' higher-quality voice' : ' higher-quality voices')
      + ' installed. More under Settings → Accessibility → Spoken Content → Voices.';
  }

  let systemVoicesInFlight = false;
  function refreshSystemVoices() {
    if (systemVoicesInFlight) return;
    systemVoicesInFlight = true;
    systemSpeech().voices(docLang()).then(function (list) {
      systemVoicesInFlight = false;
      state.systemVoices = rankSystemVoices(list);
      syncSheetSoon();
    }).catch(function () {
      systemVoicesInFlight = false;
      state.systemVoices = [];
      syncSheetSoon();
    });
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
      // No comma is added after an ellipsis, though it was tried.
      //
      // The theory was sound — "…" reaches the tokens but carries almost no
      // learned duration, where a comma carries the most certain one there is
      // — and the result was a beat that landed on some ellipses and not
      // others, because the duration a comma gets is itself contextual. An
      // inconsistent pause reads as a stumble, which is worse than no pause at
      // all: a reader stops hearing the prose and starts hearing the engine.
      // Kokoro's own rendering of "…" is at least always the same.
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
    systemVoices: null,    // null = not asked yet; [] = asked, none installed
    chapterId: null,
    sentences: [],
    index: 0,
    errors: 0,             // consecutive engine failures
    voiceNav: false,       // the chapter change in flight is ours, not the user's
    emptyHops: 0,          // consecutive auto-advances through speechless chapters
    spokeOk: 0,            // utterances completed this session (crash-loop breaker)

    group: null,           // neural group currently playing (the pump's cursor)
    groupCaps: null,       // fixed for a session so queued clip boundaries stay valid
    fastStart: false,      // next neural group is the one someone is waiting on
    prebuffer: null,       // { target, got } while paying a chapter's deficit up front
    utterance: null,       // device engine's in-flight utterance
    speakToken: 0,         // invalidates stale onend/async callbacks

    audition: null,        // { wasPlaying } while a preview plays
  };

  const dom = {};          // bar + sheet, built once on first open
  let built = false;
  // The last error a sheet control threw while syncing. See syncSheet().
  let syncError = '';
  let sheetOpen = false;
  let prewarmTimer = 0;
  let prewarmIdle = 0;
  const sheetSync = [];    // fn() → refresh a control from prefs/session

  // ─────────────────────────────────────────────────────────────────────────
  // Audio channel — one <audio> element for everything that actually plays.
  //
  // Neural sentences, previews and the device engine's silent keep-alive all
  // go through the same element. One element means the user's first tap on
  // Play "blesses" it for autoplay purposes, and every later programmatic
  // .play() — from an onended chain or a worker callback — inherits that.
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Playback for generated clips, double-buffered.
   *
   * One <audio> element reused for every clip is why the voice took a breath
   * between groups. Assigning `src` runs the media load algorithm — fetch,
   * parse, decode, buffer — and every millisecond of that happens AFTER the
   * previous clip has already gone silent. At roughly three sentences per
   * group that is a gasp every three sentences, for a whole chapter.
   *
   * So there are two elements. While one plays, the next clip is loaded into
   * the other and left primed. When the current one ends, the spare is already
   * decoded and `play()` is the only thing left to do, which is an event-loop
   * hop rather than a media load.
   *
   * Still <audio> rather than Web Audio: these elements are what keeps
   * narration alive with the screen off and wired to the lock-screen
   * transport. Sample-accurate scheduling would be smoother still and would
   * put all of that at risk, which is a bad trade for a reader on a train.
   */
  const channel = {
    pool: [],              // two elements, alternating
    slot: 0,
    onended: null,
    primed: null,          // url sitting decoded in the spare
    revokeUrl: null,

    ensure: function () {
      if (this.pool.length) return this.pool[this.slot];
      const self = this;
      for (let i = 0; i < 2; i++) {
        const a = new Audio();
        a.preload = 'auto';
        try { a.preservesPitch = true; } catch (e) {}
        a.addEventListener('ended', function () {
          // Only the element actually playing ends a clip. The spare can fire
          // this too — it is primed with real audio and a stray play() or a
          // torn-down session would otherwise advance the reader twice.
          if (self.pool[self.slot] !== a) return;
          const fn = self.onended;
          if (fn) fn();
        });
        this.pool.push(a);
      }
      return this.pool[this.slot];
    },

    /** The element actually playing. Callers should not index the pool. */
    current: function () { return this.pool[this.slot] || null; },

    /**
     * iOS blesses ELEMENTS, not the page: audio may only start from a user
     * gesture, and that permission attaches to the element it was granted on.
     * Two elements means two blessings, and missing the second one shows up
     * as every other clip refusing to play.
     */
    bless: function (silentUrl) {
      this.ensure();
      for (let i = 0; i < this.pool.length; i++) {
        const a = this.pool[i];
        try {
          a.src = silentUrl;
          const p = a.play();
          if (p && p.catch) p.catch(function () {});
        } catch (e) { /* the gesture may already be spent; the other may take */ }
      }
    },

    /** Load the next clip into the spare so its decode is already paid for. */
    prime: function (url) {
      if (!url || this.primed === url) return;
      this.ensure();
      const spare = this.pool[1 - this.slot];
      try {
        spare.src = url;
        spare.load();
        this.primed = url;
      } catch (e) { this.primed = null; }
    },

    // Swap in a source and play. Returns the play() promise (may reject on
    // autoplay policy; callers decide whether that is fatal).
    play: function (url, opts) {
      this.ensure();
      const o = opts || {};
      this.onended = o.onended || null;

      // The spare already holds this clip, decoded. Taking it is the whole
      // reason for keeping two elements.
      if (this.primed === url && this.pool[1 - this.slot].src === url) {
        try { this.pool[this.slot].pause(); } catch (e) {}
        this.slot = 1 - this.slot;
        this.primed = null;
      }

      const a = this.pool[this.slot];
      if (this.revokeUrl && this.revokeUrl !== url) {
        try { URL.revokeObjectURL(this.revokeUrl); } catch (e) {}
      }
      this.revokeUrl = o.revoke ? url : null;
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

    setRate: function (rate) {
      for (let i = 0; i < this.pool.length; i++) {
        // Both, so a primed clip does not start at last chapter's speed.
        this.pool[i].defaultPlaybackRate = rate;
        this.pool[i].playbackRate = rate;
      }
    },

    stop: function () {
      this.onended = null;
      this.primed = null;
      for (let i = 0; i < this.pool.length; i++) {
        const a = this.pool[i];
        try { a.pause(); } catch (e) {}
        try { a.removeAttribute('src'); a.load(); } catch (e) {}
      }
      if (this.revokeUrl) {
        try { URL.revokeObjectURL(this.revokeUrl); } catch (e) {}
        this.revokeUrl = null;
      }
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
    note: '',              // something the worker saw escape; diagnostic only
    speed: null,           // { ms, seconds, chars, ratio } for the last group
    native: false,         // true once a load proved the forward pass is native
    provider: '',          // e.g. 'cpu ×3', as the plugin reported it
    device: null,          // device the live worker was initialised with
    nativeWeights: '',     // dtype the native session actually opened
    readyPromise: null,
    ready: false,          // resolved at least once (drives the sheet status)
    nextId: 1,
    pending: new Map(),    // id → { resolve, reject, timer }
    inFlight: new Map(),   // cacheKey → Promise<blob URL> not yet settled
    wavCache: new Map(),   // cacheKey → blob URL (bounded LRU)
    clipSeconds: new Map(),// cacheKey → audio seconds (same lifetime as wavCache)
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
              + (self.note ? 'It reported: ' + self.note + '. '
                           : 'On a phone this is usually the model running out of memory.')));
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
          // The worker cannot reach a Capacitor plugin, so its forward pass
          // comes here and goes back. One bridge hop against an inference
          // measured in seconds.
          else if (m.type === 'infer') {
            nativeKokoro().infer(m.ids, m.style, m.speed).then(function (r) {
              if (!r || !r.pcm) throw new Error('native inference returned nothing');
              self.provider = r.provider || '';
              self.nativeWeights = r.weights || '';
              w.postMessage({ type: 'infer-result', id: m.id, pcm: r.pcm });
            }).catch(function (e) {
              w.postMessage({ type: 'infer-error', id: m.id,
                              message: (e && e.message) || 'native inference failed' });
            });
          }
          // Recorded, never acted on. See the worker's note() for why an
          // escaped rejection is not allowed to end a session that is working.
          else if (m.type === 'note') { self.note = m.message + ' (during ' + m.stage + ')'; }
          else if (m.type === 'ready') {
            // The worker's realm is the one that had to succeed, so its number
            // supersedes the main thread's guess in the line a reader reads.
            if (m.heapPages) noteHeapPages(m.heapPages);
            self.native = !!m.native;
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
          // Whether to swap the forward pass for the native plugin. Asked here
          // rather than in the worker because a worker cannot see Capacitor.
          native: nativeKokoro().available(),
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
        // Deliberately NOT refreshed to the front.
        //
        // Insertion order is generation order, which for a reader going
        // forwards is exactly "furthest behind first" — the right thing to
        // drop. Refreshing on a hit inverted that: playing a group moved it to
        // the newest end, which left the group about to play as the OLDEST
        // entry and therefore first out. With a shallow queue that never came
        // up; with a deep one it evicts the next clip and the reader hears a
        // stall in the middle of audio that had already been generated.
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
        self.clipSeconds.set(cacheKey, msg.seconds || 0);
        while (self.wavCache.size > WAV_CACHE_MAX) {
          const oldest = self.wavCache.keys().next().value;
          const u = self.wavCache.get(oldest);
          self.wavCache.delete(oldest);
          self.clipSeconds.delete(oldest);
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
      this.note = '';
      this.native = false;
      this.provider = '';
      const self = this;
      this.wavCache.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      this.wavCache.clear();
      this.clipSeconds.clear();
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

    /**
     * Whether to paint the exact range, or tint the whole paragraph.
     *
     * The Custom Highlight API paints into the same tiles as the text, and the
     * native WebView does not reliably invalidate those tiles when the registry
     * entry is replaced — in a columnated, hyphenated reader it leaves the
     * previous ranges painted where they were. What a reader sees is several
     * disconnected patches lit at once, some of them ahead of the voice, which
     * looks less like a highlight than like a bug in the text. It is not that
     * the range is wrong: `apply` clears before it sets, and a Highlight holds
     * one range. The paint is simply stale.
     *
     * A class on the block is an ordinary background on an ordinary element, so
     * it invalidates the way everything else does. Coarser, and right every
     * time, which for something a reader watches for a whole chapter is the
     * better trade. The web keeps the precise range, where it repaints.
     */
    rangeOk: function () {
      return this.supported && !isNativeApp();
    },

    apply: function (sentence) {
      this.clear();
      if (!state.prefs.highlight || !sentence || !state.bridge) return;
      const els = state.bridge.entryEls(state.chapterId);
      const node = els && els[sentence.blockIdx];
      if (!node || !node.isConnected) return;

      if (this.rangeOk()) {
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

    if (state.prefs.narrator === 'iphone' && systemSpeech().available()) {
      speakSystem(s, token, done, fail);
      return;
    }
    speakNeural(s, token, done, fail);
  }

  /**
   * One sentence through the OS narrator.
   *
   * Sentence at a time, not the neural engine's merged groups: grouping exists
   * to amortise a per-generation cost this path does not pay, and finer units
   * mean a finer highlight and a faster response to a tap. There is nothing to
   * prepare and nothing to cache, so the whole of speakNeural's machinery —
   * lookahead, wav cache, stall watchdog — is simply absent here.
   */
  /**
   * Whole paragraphs, not sentences.
   *
   * Every utterance costs a round trip across the Capacitor bridge and a fresh
   * AVSpeechUtterance, and the reader cannot ask for the next one until the
   * last has finished — so the unit of speech is also the unit of silence. A
   * sentence at a time meant a gap after every sentence for a whole chapter.
   *
   * The neural engine's caps exist to bound generation cost. This path has no
   * generation cost, so the only reason to stop growing a group is the one
   * groupSentences enforces for free: it never crosses a paragraph. These caps
   * are set high enough that a paragraph is what comes back, which puts the
   * remaining gaps exactly where prose already pauses.
   */
  const SYSTEM_GROUP_CAPS = { target: 900, max: 1400, contMax: 1600 };

  function speakSystem(s, token, done, fail) {
    const group = groupSentences(state.sentences, state.index, SYSTEM_GROUP_CAPS)
      || { from: state.index, to: state.index, blockIdx: s.blockIdx, start: s.start, end: s.end, text: s.text };
    highlighter.apply(group);
    setPreparing(false);
    const groupDone = function () {
      if (token !== state.speakToken || !state.playing) return;
      state.index = group.to;      // land on the group's last sentence…
      done();                      // …then done() advances past it as usual
    };
    systemSpeech().speak(normalizeForSpeech(group.text, 'device'), {
      voiceId: state.prefs.systemVoice,
      lang: docLang(),
      rate: state.prefs.rate,
      pitch: state.prefs.pitch,
    }).then(function (spoken) {
      // A stop or a chapter change bumps the token and clears `playing`; the
      // utterance resolving false afterwards is that cancellation arriving, not
      // a failure, and must not be counted as one.
      if (token !== state.speakToken || !state.playing) return;
      if (spoken) groupDone(); else fail();
    }).catch(function () {
      if (token !== state.speakToken || !state.playing) return;
      fail();
    });
    mediaSessionUpdate();
  }

  // A neural group: sentences[from..to] of ONE block, merged for one
  // generation call. Same-block only, so the highlight stays a single range
  // and a group never straddles a paragraph pause. Pure over its inputs —
  // the test page drives it directly.
  /**
   * How big a group may get, given how fast this device actually generates.
   *
   * The fixed caps assume the engine outruns the reader. On a device where it
   * does not, they are the worst possible choice: a 300-character group is
   * eight times the wait of a chapter title, and the reader sits in silence
   * for all of it. Shrinking does not make the device faster — nothing here
   * can — but it turns one long stall into audio that starts sooner.
   *
   * Measured, not assumed: neuralEngine.speed comes from the worker timing its
   * own generations. Until a group has been generated there is no reading, and
   * the original caps stand.
   */
  /**
   * Generation speed measured against the speed the reader actually drains it.
   *
   * neuralEngine.speed.ratio is audio-seconds per compute-second at speed 1,
   * because the worker always generates at 1 and the <audio> element does the
   * stretching. A reader at 1.5× empties that audio half again as fast, so a
   * 1.3× generator is really a 0.87× one and falls behind for the whole
   * chapter. Comparing the raw ratio against a fixed threshold gets this
   * wrong, and gets it wrong in the direction that stutters — the faster the
   * reader asks to go, the more confident the check becomes.
   *
   * 0 means not measured yet: no group has finished, so there is nothing to
   * compare and the callers keep their optimistic defaults.
   */
  function neuralMargin() {
    const sp = neuralEngine.speed;
    if (!sp || !sp.ratio) return 0;
    return sp.ratio / (state.prefs.rate || 1);
  }

  /**
   * Audio seconds a group will take, before it has been generated.
   *
   * From what this voice actually produced for the last group: prose is
   * uniform enough that characters per second holds across a chapter, and the
   * only exact alternative is generating the clip, which is the thing the
   * estimate exists to schedule.
   */
  function estimateSeconds(text) { return secondsForChars((text || '').length); }

  function secondsForChars(chars) {
    const sp = neuralEngine.speed;
    const cps = (sp && sp.chars > 0 && sp.seconds > 0)
      ? sp.chars / sp.seconds
      : NEURAL_CHARS_PER_SEC;
    return (chars || 0) / cps;
  }

  /**
   * How much audio to keep in hand, given whether this device can get ahead.
   *
   * A deep buffer is only reachable when the engine generates faster than the
   * reader speaks. Below that it is not merely useless, it is harmful: there
   * is no spare capacity to fill it with, so the queue never gets deeper, and
   * all the attempt does is hold the CPU at a hundred per cent for the whole
   * chapter. On a phone that means heat, and heat means thermal throttling,
   * which makes the very generation it was trying to get ahead of slower. The
   * first version of this chased forty seconds unconditionally and did exactly
   * that.
   *
   * So: chase a real cushion where one is achievable, and where it is not,
   * generate the next group and nothing more. One group ahead is all that is
   * needed to overlap generation with playback, which is the only part of the
   * benefit a slow device was ever going to get.
   */
  function lookaheadSeconds() {
    // While the deficit is being paid up front, the target IS the lookahead.
    if (state.prebuffer) return state.prebuffer.target;
    const margin = neuralMargin();
    if (!margin) return NEURAL_LOOKAHEAD_SEC;   // unmeasured: assume the good case

    // Below break-even, bank everything.
    //
    // This used to return zero here, on the reasoning that a queue the device
    // can never fill is just heat. That was backwards. Below break-even the
    // generator has no idle moments to protect: there is always a next group
    // and it is always needed, so the CPU is at a hundred per cent whatever
    // the depth. Lookahead does not change how much work gets done, only WHICH
    // clips are ready when — and the depth costs nothing.
    //
    // What it buys is the fluctuation. This engine measures 0.92x and 1.28x
    // minutes apart on the same phone; shallow, the good stretches are thrown
    // away and the bad ones are heard as a stall. Deep, the good stretches are
    // banked against the bad, which is the whole of the difference between
    // "occasionally buffers mid-chapter" and not.
    if (margin < 1.05) return NEURAL_LOOKAHEAD_DEEP;

    // Above it the generator really will go idle, and idle is worth
    // protecting: it is most of the difference between a warm phone and a hot
    // one. A cushion only has to absorb the wobble, so the further ahead the
    // engine is, the less of one it needs.
    if (margin >= 1.5) return NEURAL_LOOKAHEAD_SEC / 2;
    return NEURAL_LOOKAHEAD_SEC;
  }

  /**
   * Playback seconds of prose left in this chapter from `from`, at this rate.
   *
   * An estimate over unread text, so it is characters-per-second again. Good
   * enough: it sizes a wait, and being ten per cent out makes the wait ten per
   * cent wrong rather than the playback wrong.
   */
  function chapterSecondsLeft(from) {
    const rate = state.prefs.rate || 1;
    let chars = 0;
    for (let i = Math.max(0, from); i < state.sentences.length; i++) chars += state.sentences[i].text.length;
    return secondsForChars(chars) / rate;
  }

  /**
   * Seconds of audio to have in hand before starting, so the chapter plays
   * through without a gap.
   *
   * Zero whenever the engine can keep up — there is no deficit to pay, and
   * making someone wait for a buffer they do not need is its own bug. Below
   * that, (1 − margin) × what is left, which is exactly how far behind the
   * engine will be by the last sentence, plus a margin of safety because the
   * ratio drifts and a warm phone throttles.
   *
   * Capped by what a reader will actually sit through. A cap does not make the
   * chapter gapless — the deficit is what it is — but it front-loads as much
   * of it as the cap allows, and the gaps that remain come later and fewer.
   */
  function prebufferTargetSeconds() {
    const margin = neuralMargin();
    if (!margin || margin >= NEURAL_PREBUFFER_FLOOR) return 0;
    const deficit = (1 - margin) * chapterSecondsLeft(state.index) * NEURAL_PREBUFFER_SAFETY;
    const affordable = NEURAL_PREBUFFER_MAX_SEC * margin;   // what the cap buys
    return Math.min(deficit, affordable);
  }

  /**
   * Playback seconds sitting generated in an unbroken run after `group`.
   *
   * Unbroken is the point: a hole is a gap, however much audio is cached past
   * it, so the count stops at the first group that is not ready.
   */
  function bufferedAhead(group) {
    if (!group) return 0;
    const rate = state.prefs.rate || 1;
    let from = group.to + 1;
    let got = 0;
    for (let k = 0; k < NEURAL_LOOKAHEAD_MAX; k++) {
      const g = neuralGroupAt(from);
      if (!g) break;
      const secs = neuralEngine.clipSeconds.get(neuralKey(state.chapterId, g));
      if (!secs) break;
      got += secs / rate;
      from = g.to + 1;
    }
    return got;
  }

  function neuralGroupCaps() {
    const margin = neuralMargin();
    const wide = { target: NEURAL_GROUP_TARGET, max: NEURAL_GROUP_MAX, contMax: NEURAL_GROUP_CONT_MAX };
    if (!margin) return wide;
    // Comfortably ahead of the reader: leave prosody alone, it is why groups
    // exist. The threshold is above 1.0 because lookahead needs slack to stay
    // ahead, not merely to break even.
    if (margin >= 1.5) return wide;
    if (margin >= 0.7) return { target: 90, max: 160, contMax: 400 };
    return { target: 45, max: 90, contMax: 220 };
  }

  function groupSentences(list, from, caps) {
    const first = list[from];
    if (!first) return null;
    const cap = caps || neuralGroupCaps();
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
        if (chars + next.text.length > cap.contMax) break;
        chars += next.text.length;
        to++;
        continue;
      }
      if (chars >= cap.target) break;
      if (chars + next.text.length > cap.max) break;
      chars += next.text.length;
      to++;
    }
    const last = list[to];
    const text = list.slice(from, to + 1).map(function (s) { return s.text; }).join(' ');
    return { from: from, to: to, blockIdx: first.blockIdx, start: first.start, end: last.end, text: text };
  }

  function activeNeuralCaps() { return state.groupCaps || neuralGroupCaps(); }

  function neuralGroupAt(from, caps) {
    return groupSentences(state.sentences, from, caps || activeNeuralCaps());
  }

  function neuralKey(chapterId, g) {
    return chapterId + ':' + g.blockIdx + ':' + g.start + ':' + g.end + ':' + state.prefs.neuralVoice;
  }

  /**
   * Hold the first clip until enough of the chapter is generated behind it.
   *
   * Resolves true to go ahead and play, false when the session moved on under
   * it. Only ever runs once per session: `state.fastStart` marks the group a
   * reader is waiting on, and by the time the second group plays the buffer is
   * either built or was never needed.
   *
   * It gives up rather than hanging. A stalled worker, a chapter with nothing
   * left to generate, or simply a device slower than the estimate all end the
   * wait and start the audio: a short buffer is worse than no buffer only in
   * theory, and a reader staring at a stuck progress number is worse than both.
   */
  function awaitPrebuffer(group, token) {
    const target = prebufferTargetSeconds();
    if (target <= 0) return Promise.resolve(true);
    const deadline = Date.now() + NEURAL_PREBUFFER_MAX_SEC * 1500;
    state.prebuffer = { target: target, got: 0 };
    updateBar();
    return new Promise(function (resolve) {
      const done = function (ok) { state.prebuffer = null; updateBar(); resolve(ok); };
      const tick = function () {
        if (token !== state.speakToken || !state.playing) { done(false); return; }
        const got = bufferedAhead(group);
        state.prebuffer.got = got;
        updateBar();
        if (got >= target || Date.now() > deadline) { done(true); return; }
        // Nothing further in the chapter to wait for.
        if (!neuralGroupAt(group.to + 1)) { done(true); return; }
        prefetchNeural(group);
        setTimeout(tick, NEURAL_PREBUFFER_TICK_MS);
      };
      tick();
    });
  }

  function speakNeural(s, token, done, fail) {
    const group = neuralGroupAt(state.index, state.fastStart ? FAST_START_CAPS : null)
      || { from: state.index, to: state.index, blockIdx: s.blockIdx, start: s.start, end: s.end, text: s.text };
    // The highlight covers the whole spoken group, so the mark and the audio
    // always agree on what is being read.
    highlighter.apply(group);
    setPreparingSoon();
    state.group = group;         // the pump tops up from here while this plays
    startPrefetchPump();
    const chapterId = state.chapterId;
    const groupDone = function () {
      if (token !== state.speakToken || !state.playing) return;
      state.index = group.to;      // land on the group's last sentence…
      done();                      // …then done() advances past it as usual
    };
    neuralEngine.generate(neuralKey(chapterId, group), normalizeForSpeech(group.text, 'neural'), state.prefs.neuralVoice)
      .then(function (url) {
        if (token !== state.speakToken || !state.playing) return;
        const first = state.fastStart;
        state.fastStart = false;     // the wait someone sat through is over
        // Pin the boundaries used by lookahead and playback. Generation speed
        // is noisy and is updated for every queued clip. Letting it resize the
        // groups mid-queue changes their cache keys, so playback misses audio
        // that is already prepared and starts generating it again.
        if (!state.groupCaps) state.groupCaps = neuralGroupCaps();
        prefetchNeural(group);
        // Only the group a reader tapped for pays the deficit up front. Every
        // group after it is playing off a buffer that is already built, or off
        // one that was never needed.
        return (first ? awaitPrebuffer(group, token) : Promise.resolve(true)).then(function (go) {
          if (!go || token !== state.speakToken || !state.playing) return;
          setPreparing(false);
          primeNextClip(group);
          return channel.play(url, { rate: state.prefs.rate, onended: groupDone }).catch(function () {
            // Autoplay refusal — the chain lost its blessing (e.g. after a long
            // background stall). Pausing is honest; a tap resumes it.
            pause();
          });
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

  /**
   * Keep enough generated audio in hand to cover the next generation.
   *
   * The worker is a serial queue, so this tops the queue up — it is not a
   * stampede. What counts as "enough" is NEURAL_LOOKAHEAD_SEC of playback,
   * measured at the rate the reader is actually running: clips already
   * generated contribute their true length, clips in flight their estimate.
   * Groups that are already cached or already queued are counted and skipped,
   * never re-requested.
   *
   * Safe to call repeatedly, and the pump does.
   */
  function prefetchNeural(currentGroup) {
    if (!neuralEngine.worker || !currentGroup) return;
    const rate = state.prefs.rate || 1;
    const want = lookaheadSeconds();
    let from = currentGroup.to + 1;
    let ahead = 0;               // playback seconds already in hand or coming
    for (let k = 0; k < NEURAL_LOOKAHEAD_MAX; k++) {
      if (k >= NEURAL_LOOKAHEAD_MIN && ahead >= want) break;
      const g = neuralGroupAt(from);
      if (!g) break;
      const key = neuralKey(state.chapterId, g);
      const known = neuralEngine.clipSeconds.get(key);
      if (!neuralEngine.wavCache.has(key) && !neuralEngine.inFlight.has(key)) {
        neuralEngine.generate(key, normalizeForSpeech(g.text, 'neural'), state.prefs.neuralVoice)
          // Generated is not the same as ready to play. The clip still has to
          // be decoded, and paying for that while the current one plays is the
          // difference between a seam and a breath.
          .then(function () { primeNextClip(state.group || currentGroup); })
          .catch(function () { /* the on-cursor attempt will retry and report */ });
      }
      ahead += (known || estimateSeconds(g.text)) / rate;
      from = g.to + 1;
    }
  }

  // Boundary top-ups leave the queue unattended for the length of a clip, and
  // that is the only time there is spare capacity to generate in. The pump
  // checks it on a timer instead, so a buffer that drains mid-clip is refilled
  // mid-clip rather than after the gap the reader would otherwise hear.
  let prefetchTimer = 0;

  function startPrefetchPump() {
    if (prefetchTimer) return;
    prefetchTimer = setInterval(function () {
      if (!state.playing || !state.group || state.prefs.narrator !== 'natural') return;
      prefetchNeural(state.group);
      primeNextClip(state.group);
    }, NEURAL_PUMP_MS);
  }

  function stopPrefetchPump() {
    if (!prefetchTimer) return;
    clearInterval(prefetchTimer);
    prefetchTimer = 0;
  }

  /**
   * Load the clip after this one into the spare audio element.
   *
   * Only the immediate next group: priming further ahead would just overwrite
   * itself, since there is one spare and the one that matters is the one about
   * to play.
   */
  function primeNextClip(currentGroup) {
    if (!currentGroup) return;
    const g = neuralGroupAt(currentGroup.to + 1);
    if (!g) return;
    const url = neuralEngine.wavCache.get(neuralKey(state.chapterId, g));
    if (url) channel.prime(url);
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
    // A skip lands somewhere nothing has been generated for, so this is a wait
    // someone is sitting through, same as a tap on Play.
    state.fastStart = true;
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
    // The pump generates from state.group, so a cursor left behind here would
    // keep synthesising for a chapter nobody is listening to any more.
    stopPrefetchPump();
    state.group = null;
    state.prebuffer = null;
    neuralEngine.cancelPending();
    systemSpeech().stop();
    channel.stop();
    setPreparing(false);
  }

  // ── Play / pause / stop ───────────────────────────────────────────────────

  function play() {
    if (!state.bridge) return;
    if (state.playing) return;
    state.playing = true;
    syncBarWithReaderChrome();
    state.errors = 0;
    // Whatever is about to be spoken, someone is waiting on it right now.
    state.fastStart = true;
    // Armed until two utterances complete: if speech takes the page down
    // (WebKit home-screen apps have form here; low-memory phones OOM), the
    // flag survives the crash and the next session refuses to auto-play.
    if ((state.spokeOk | 0) < 2) guardArm('speak');

    if (!state.sentences.length || state.chapterId !== state.bridge.state().chapterId) seedFromReader();
    if (!state.sentences.length) { state.playing = false; onChapterExhausted(); return; }

    // First user gesture: bless the audio element while we still have it.
    channel.bless(silentWavUrl());

    ensureEngineThenSpeak();
    mediaSessionWire();
    mediaSessionUpdate();
    updateBar();
  }

  /**
   * Get whichever narrator was chosen ready, then speak.
   *
   * The OS narrator has nothing to get ready, and routing it through the
   * neural path would have been the whole point of having it thrown away: that
   * path blocks on 88 MB of weights loading and ends the session outright when
   * the natural voice cannot run here. A reader who picked the instant voice
   * would have waited for the slow one to load before hearing a word, and been
   * told the natural voice was broken when they were not using it.
   */
  function ensureEngineThenSpeak() {
    if (state.prefs.narrator === 'iphone' && systemSpeech().available()) {
      speakCurrent();
      return;
    }
    ensureNeuralThenSpeak();
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
    syncBarWithReaderChrome();
    guardClear();    // we are demonstrably alive — no crash to guard against
    cancelSpeech();
    const s = currentSentence();
    if (s) highlighter.apply(s);   // keep the place visible while paused
    mediaSessionUpdate();
    updateBar();
  }

  function resume() { if (state.active && !state.playing) play(); }

  function togglePlay() { state.playing ? pause() : play(); }

  function setBarHidden(hidden) {
    if (!dom.bar || dom.bar.hidden) return;
    const on = !!hidden;
    dom.bar.classList.toggle('vc-bar-hidden', on);
    if (on) {
      dom.bar.setAttribute('aria-hidden', 'true');
      dom.bar.inert = true;
      const active = document.activeElement;
      if (active && dom.bar.contains(active) && typeof active.blur === 'function') active.blur();
    } else {
      dom.bar.removeAttribute('aria-hidden');
      dom.bar.inert = false;
    }
  }

  function syncBarWithReaderChrome() {
    if (!dom.bar || dom.bar.hidden) return;
    const root = dom.bar.closest('#novel-screen');
    setBarHidden(!!(root && root.classList.contains('nv-chrome-hidden')));
  }

  function startSession() {
    if (state.active) { openSheet(); return; }
    state.active = true;
    state.spokeOk = 0;
    state.prefs = readPrefs();
    ensureDom();
    seedFromReader();
    state.groupCaps = neuralEngine.speed ? neuralGroupCaps() : null;
    dom.bar.hidden = false;
    syncBarWithReaderChrome();
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
    if (dom.bar) {
      setBarHidden(false);
      dom.bar.hidden = true;
    }
    state.sentences = [];
    state.index = 0;
    state.chapterId = null;
    state.groupCaps = null;
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
      scheduleNeuralPrewarm();
      return;
    }
    if (!state.bridge) return;

    if (kind === 'close') {
      cancelNeuralPrewarm();
      stopSession();
      closeSheet();
      state.bridge = null;
      return;
    }

    if (kind === 'chrome') {
      syncBarWithReaderChrome();
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
    voiceBtn.addEventListener('click', function () {
      if (voiceSheetVisible() && !readerSheetVisible()) closeSheet();
      else openSheet();
    });
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
    // The bar says what a reader can act on, and nothing else.
    //
    // The passage counter, the dtype and the margin were instrumentation. They
    // earned their place when a stutter had to be diagnosable from a
    // photograph, and they did that job — the margin is what finally settled
    // that this was arithmetic rather than scheduling. But the job is done,
    // and what is left is three numbers moving on a page someone is trying to
    // listen to. The engine line still carries all of it, on the one screen
    // where it is wanted: a build that is failing.
    //
    // The percentage stays. "Preparing" with no end in sight is the thing a
    // reader gives up on; this one has an end and can be watched approaching it.
    const pb = state.prebuffer;
    dom.statusLine.textContent = pb
      ? 'Buffering chapter… ' + Math.min(99, Math.round((pb.got / pb.target) * 100)) + '%'
      : state.preparing ? 'Preparing voice…'
      : n ? ''
      : 'Nothing to read';
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

    // ── Narrator ──────────────────────────────────────────────────────────
    //
    // Two genuinely different trades, so the choice is named rather than
    // hidden behind a quality slider. The iPhone voice starts instantly and
    // costs nothing to run; the natural voice sounds better and has to build
    // every sentence before it can say it. Only shown when the device
    // actually has an OS narrator, which on the web it never does.
    const narRow = el('div', 'vc-row vc-narrator-row');
    narRow.appendChild(el('span', 'vc-row-label', 'Narrator'));
    const narPick = el('div', 'vc-chip-rail');
    narPick.setAttribute('role', 'radiogroup');
    narPick.setAttribute('aria-label', 'Narrator');
    const NARRATOR_CHIPS = [
      { id: 'iphone',  label: 'iPhone voice',  note: 'Starts instantly' },
      { id: 'natural', label: 'Natural voice', note: 'Better, but slower to start' },
    ];
    for (let i = 0; i < NARRATOR_CHIPS.length; i++) {
      (function (n) {
        const chip = el('button', 'vc-chip');
        chip.type = 'button';
        chip.dataset.narrator = n.id;
        chip.append(el('span', 'vc-chip-name', n.label), el('span', 'vc-chip-note', n.note));
        chip.addEventListener('click', function () {
          if (state.prefs.narrator === n.id) return;
          state.prefs.narrator = n.id;
          prefSet(PREF.narrator, n.id);
          syncSheet();
          restartCurrentIfPlaying();
        });
        narPick.appendChild(chip);
      })(NARRATOR_CHIPS[i]);
    }
    narRow.appendChild(narPick);
    body.appendChild(narRow);

    // ── iPhone voice panel ────────────────────────────────────────────────
    //
    // The whole reason the old device narrator was written off. iOS speaks
    // through a small "compact" voice unless told otherwise, and that is what
    // a reader hears if nobody asks for better. The Enhanced and Premium
    // voices are downloads, sitting one screen away in Settings, and this
    // panel's job is to make that visible: lead with the good ones, label the
    // tier, and say plainly when the only thing installed is the compact one.
    const sysRow = el('div', 'vc-row vc-system-row');
    sysRow.appendChild(el('span', 'vc-row-label', 'iPhone voice'));
    const sysHint = el('div', 'vc-hint');
    sysRow.appendChild(sysHint);
    const sysVoices = el('div', 'vc-chip-rail');
    sysVoices.setAttribute('role', 'radiogroup');
    sysVoices.setAttribute('aria-label', 'iPhone voice');
    sysRow.appendChild(sysVoices);
    const sysTools = el('div', 'vc-nat-tools');
    const sysPreview = previewBtn();
    sysPreview.addEventListener('click', function () { previewVoice(); });
    sysTools.append(sysPreview);
    sysRow.appendChild(sysTools);
    body.appendChild(sysRow);

    let sysBuiltFor = null;
    function buildSystemChips() {
      const list = state.systemVoices || [];
      const key = list.map(function (v) { return v.id; }).join('|');
      if (sysBuiltFor === key) return;
      sysBuiltFor = key;
      sysVoices.textContent = '';
      for (let i = 0; i < list.length; i++) {
        (function (v) {
          const chip = el('button', 'vc-chip');
          chip.type = 'button';
          chip.dataset.systemVoice = v.id;
          chip.append(el('span', 'vc-chip-name', v.name),
                      el('span', 'vc-chip-note', systemVoiceNote(v)));
          chip.addEventListener('click', function () {
            state.prefs.systemVoice = v.id;
            prefSet(PREF.systemVoice, v.id);
            syncSheet();
            restartCurrentIfPlaying();
          });
          sysVoices.appendChild(chip);
        })(list[i]);
      }
    }

    sheetSync.push(function () {
      const hasSystem = systemSpeech().available();
      narRow.hidden = !hasSystem;
      const onSystem = hasSystem && state.prefs.narrator === 'iphone';
      sysRow.hidden = !onSystem;
      natRow.hidden = hasSystem && onSystem;

      const chips = narPick.querySelectorAll('.vc-chip');
      for (let i = 0; i < chips.length; i++) {
        const on = chips[i].dataset.narrator === state.prefs.narrator;
        chips[i].classList.toggle('vc-on', on);
        chips[i].setAttribute('role', 'radio');
        chips[i].setAttribute('aria-checked', on ? 'true' : 'false');
      }
      if (!onSystem) return;

      if (state.systemVoices == null) {
        sysHint.textContent = 'Looking for installed voices…';
        refreshSystemVoices();
        return;
      }
      buildSystemChips();
      sysHint.textContent = systemVoiceHint();
      const vchips = sysVoices.querySelectorAll('.vc-chip');
      // No stored choice means iOS picks, which is the compact voice. Show
      // that as the first chip being selected rather than as nothing selected.
      const chosen = state.prefs.systemVoice
        || (state.systemVoices[0] && state.systemVoices[0].id) || '';
      for (let i = 0; i < vchips.length; i++) {
        const on = vchips[i].dataset.systemVoice === chosen;
        vchips[i].classList.toggle('vc-on', on);
        vchips[i].setAttribute('role', 'radio');
        vchips[i].setAttribute('aria-checked', on ? 'true' : 'false');
      }
    });

    // ── Natural voice panel ───────────────────────────────────────────────
    const natRow = el('div', 'vc-row vc-neural-row');
    natRow.appendChild(el('span', 'vc-row-label', 'Natural voice'));

    const natStatus = el('div', 'vc-nat-status');
    const natText = el('div', 'vc-hint');
    // Shown only when something is actually wrong.
    //
    // It was always on screen for a while, because its absence used to be
    // ambiguous: "the engine is fine" and "this build predates the check"
    // looked identical, and telling them apart cost a round trip every time.
    // That ambiguity belonged to a period when the engine failed every other
    // run. On a build that works it is a wall of numbers over the top of a
    // settings panel, and the numbers it carries are only ever read when the
    // voice is misbehaving — which is exactly when this still appears.
    const natEngine = el('div', 'vc-hint vc-engine-line');
    natEngine.hidden = true;
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
      const trouble = !neuralCapability().ok || !!state.neuralError || !!syncError;
      natEngine.hidden = !trouble;
      natEngine.textContent = trouble ? neuralCapabilityLine() : '';
      syncNeuralStatus(natText, natBar, natAction);
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

  /**
   * `removeBtn` used to be a fourth argument here and was never declared.
   *
   * "Remove download" was deleted from the sheet on purpose — there is nothing
   * to remove from a build that carries its own weights — but every reference
   * to it stayed. Evaluating the argument threw a ReferenceError before this
   * function ran at all, which syncSheet's per-control catch then swallowed. So
   * the natural-voice panel never synced once: no "Ready", no error text, and a
   * download button frozen at the label it was built with, in an app that ships
   * the weights inside itself. Two rounds of fixing the branch logic could not
   * have worked, because no branch was ever reached.
   */
  function syncNeuralStatus(natText, natBar, natAction) {
    // Before download state, before anything: if the engine cannot run on this
    // runtime, that is the whole story and the rest of the panel is noise.
    const cap = neuralCapability();
    if (!cap.ok) {
      natText.textContent = 'Not available on this device: ' + cap.reason + '.';
      natBar.hidden = true;
      natAction.hidden = true;
      return;
    }
    // Said before anything about downloads: offering a 90 MB download for a
    // book the engine cannot read would be the app wasting someone's data.
    if (state.bridge && !neuralSpeaks(docLang())) {
      natText.textContent = 'This narrator reads English, and this book is not in English.';
      natBar.hidden = true;
      natAction.hidden = true;
      inAppHasNoFileToManage(natAction);
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
      return;
    }
    natBar.hidden = true;
    if (state.neuralError) {
      natText.textContent = 'Could not load: ' + state.neuralError;
      natAction.hidden = false;
      natAction.textContent = 'Try again';
      return;
    }
    if (neuralEngine.ready) {
      // The empty parentheses here used to hold the execution device, removed
      // when the engine line took that over. Nobody reads their own UI strings.
      natText.textContent = state.neuralBundled
        ? 'Ready — included with the app. Works offline.'
        : 'Ready — running on this device. Works offline.';
      natAction.hidden = true;
      inAppHasNoFileToManage(natAction);
      return;
    }
    // Not loaded, nothing in flight: answer from the cached probe. The probe
    // refreshes itself once when unknown — no per-sync cache reads, no
    // "Checking…" flicker on every control tap.
    if (state.neuralHave == null) {
      natText.textContent = '…';
      natAction.hidden = true;
      refreshNeuralHave();
      return;
    }
    if (state.neuralBundled) {
      // Shipped in the app. There is nothing to download and nothing to remove
      // — "Remove download" here would delete a file the next launch restores.
      natText.textContent = 'Included with the app — nothing to download, works offline.';
      natAction.hidden = true;
    } else if (state.neuralHave) {
      natText.textContent = 'Downloaded — loads when you press play. Works offline.';
      natAction.hidden = true;
    } else if (isNativeApp()) {
      // In the app the weights are supposed to BE the app. Missing them is a
      // build that skipped scripts/fetch-voice-model.mjs, and a download button
      // would paper over that instead of surfacing it.
      natText.textContent = 'The narrator is missing from this build. It should ship inside the app — '
        + 'rebuild with scripts/fetch-voice-model.mjs, then npm run sync.';
      natAction.hidden = true;
    } else {
      natText.textContent = 'An 82-million-parameter narrator that runs entirely on this device. One download, then it works offline.';
      natAction.hidden = false;
      natAction.textContent = 'Download voice (~90 MB)';
    }
    inAppHasNoFileToManage(natAction);
  }

  /**
   * In the app, the weights ARE the app.
   *
   * There is nothing to download and nothing to remove that the next launch
   * would not restore, so both buttons are web-only. Applied as a last pass
   * over every branch above rather than repeated inside each of them: the
   * branch that let "Remove download" through was the one where the engine had
   * already loaded, which is to say the state a reader is actually in, and a
   * rule stated once cannot be forgotten in a branch added later.
   */
  function inAppHasNoFileToManage(natAction) {
    if (!isNativeApp()) return;
    natAction.hidden = true;
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
    if (state.prefs.narrator === 'iphone' && systemSpeech().available()) return;
    if (!neuralSpeaks(docLang())) return;   // nothing here reads this language
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

  function cancelNeuralPrewarm() {
    clearTimeout(prewarmTimer); prewarmTimer = 0;
    if (prewarmIdle && typeof cancelIdleCallback === 'function') cancelIdleCallback(prewarmIdle);
    prewarmIdle = 0;
  }

  // The book gets first claim on the main thread. Starting the worker while
  // pagination and fonts are settling makes opening a chapter feel like voice
  // startup even when the reader never presses Listen.
  function scheduleNeuralPrewarm() {
    cancelNeuralPrewarm();
    prewarmTimer = setTimeout(function () {
      prewarmTimer = 0;
      const run = function () { prewarmIdle = 0; if (state.bridge) prewarmNeural(); };
      if (typeof requestIdleCallback === 'function') prewarmIdle = requestIdleCallback(run, { timeout: 3000 });
      else run();
    }, PREWARM_DELAY_MS);
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

    // Preview the narrator that is actually selected. Previewing Kokoro while
    // the reader is set to the iPhone voice would demo a voice they are not
    // about to hear, which is worse than no preview at all.
    if (state.prefs.narrator === 'iphone' && systemSpeech().available()) {
      systemSpeech().speak(PREVIEW_TEXT, {
        voiceId: state.prefs.systemVoice,
        lang: docLang(),
        rate: state.prefs.rate,
        pitch: state.prefs.pitch,
      }).then(done, done);
      return;
    }

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
    // …and then check the screen rather than trusting that call, which can
    // fail in ways nothing here can see: no bridge yet, an exception swallowed
    // above, a flag over there that says closed about a sheet that is not.
    // Our sheet layers above the reader's and its sheet makes the header
    // inert, so two of them open at once can between them leave nothing on
    // screen that answers a tap.
    hideStrandedReaderSheet();
    sheetOpen = true;
    syncSheet();
    dom.sheet.hidden = false;
    dom.sheet.inert = false;
    dom.scrim.hidden = false;
    const first = dom.sheet.querySelector('button');
    if (first) { try { first.focus({ preventScroll: true }); } catch (e) {} }
  }

  /**
   * Closes when EITHER the flag or the DOM says open.
   *
   * `if (!sheetOpen) return` trusted a boolean to describe the screen. The two
   * sheets keep out of each other's way by calling each other's close, so one
   * stale flag anywhere leaves a sheet on screen that nothing will take off
   * again — which is exactly "both settings popped up and I can't close the
   * voice one". Hiding something already hidden costs nothing; refusing to
   * hide something visible costs the reader their app.
   */
  function closeSheet() {
    if (!dom.sheet) return;
    if (!sheetOpen && dom.sheet.hidden) return;
    sheetOpen = false;
    dom.sheet.hidden = true;
    dom.sheet.inert = true;
    dom.scrim.hidden = true;
    // Whatever the reader made inert to show a sheet of its own has to come
    // back now that no sheet is up. It derives that from what is visible, so
    // all this has to do is ask at the right moment.
    if (state.bridge && state.bridge.syncBackdrop) {
      try { state.bridge.syncBackdrop(); } catch (e) {}
    }
  }

  function voiceSheetVisible() { return !!(dom.sheet && !dom.sheet.hidden); }

  function readerSheetVisible() {
    return !!document.querySelector('#novel-screen .nv-sheet:not([hidden])');
  }

  /**
   * Hide a reader settings sheet that is still on screen after being asked to
   * leave. By class, because the point is to be the check that does not depend
   * on the other module answering; its own close is what restores focus and
   * the backdrop, and has already been called.
   */
  function hideStrandedReaderSheet() {
    const readerSheet = document.querySelector('#novel-screen .nv-sheet');
    const readerScrim = document.querySelector('#novel-screen .nv-scrim');
    if (readerSheet) { readerSheet.hidden = true; readerSheet.inert = true; }
    if (readerScrim) readerScrim.hidden = true;
    const readerBtn = document.querySelector('#novel-screen [aria-label="Reading settings"]');
    if (readerBtn) readerBtn.setAttribute('aria-expanded', 'false');
    document.querySelectorAll('#novel-screen .nv-viewport, #novel-screen .nv-zones, #novel-screen .nv-header, #novel-screen .nv-footer')
      .forEach(function (node) { node.inert = false; });
  }

  function syncSheet() {
    if (!built) return;
    for (let i = 0; i < sheetSync.length; i++) {
      try {
        sheetSync[i]();
      } catch (e) {
        // One stale control must not break the rest — but it must not vanish
        // either. A ReferenceError in here kept the whole natural-voice panel
        // from ever running, and the only symptom was a button that never
        // changed: nothing logged, nothing shown, nothing to report. Recorded
        // on the engine line, which is already the screen for "something is
        // wrong and I need to know what".
        syncError = (e && e.message) ? String(e.message) : 'a control failed to sync';
      }
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
        highlightMode: highlighter.rangeOk() ? 'range' : 'block',
      };
    },

    /** Pure pieces exposed for the test page; not API for other modules. */
    _test: {
      segmentBlocks: segmentBlocks,
      sentenceIndexAt: sentenceIndexAt,
      groupSentences: groupSentences,
      neuralGroupCaps: neuralGroupCaps,
      activeNeuralCaps: activeNeuralCaps,
      neuralGroupAt: neuralGroupAt,
      neuralMargin: neuralMargin,
      lookaheadSeconds: lookaheadSeconds,
      estimateSeconds: estimateSeconds,
      chapterSecondsLeft: chapterSecondsLeft,
      prebufferTargetSeconds: prebufferTargetSeconds,
      bufferedAhead: bufferedAhead,
      NEURAL_PREBUFFER_MAX_SEC: NEURAL_PREBUFFER_MAX_SEC,
      PREWARM_DELAY_MS: PREWARM_DELAY_MS,
      highlighter: highlighter,
      FAST_START_CAPS: FAST_START_CAPS,
      prefetchNeural: prefetchNeural,
      state: state,
      normalizeForSpeech: normalizeForSpeech,
      encodeWav: encodeWav,
      readPrefs: readPrefs,
      neuralEngine: neuralEngine,
      channel: channel,
      forceSheetFlag: function (v) { sheetOpen = !!v; },
      skip: skip,
      pause: pause,
      resume: resume,
      guardRead: guardRead,
      neuralCapability: neuralCapability,
      resetCapability: function () { neuralCapabilityCache = null; },
      neuralCapabilityLine: neuralCapabilityLine,
      syncError: function () { return syncError; },
      syncSheet: function () { syncSheet(); },
      nativeKokoro: nativeKokoro,
      channel: channel,
      silentWavUrl: silentWavUrl,
      rankSystemVoices: rankSystemVoices,
      systemVoiceHint: systemVoiceHint,
      setSystemVoices: function (list) { state.systemVoices = list; },
      guardArm: guardArm,
      NEURAL_INIT_STALL_MS: NEURAL_INIT_STALL_MS,
      NEURAL_LOOKAHEAD_SEC: NEURAL_LOOKAHEAD_SEC,
      NEURAL_LOOKAHEAD_DEEP: NEURAL_LOOKAHEAD_DEEP,
      NEURAL_LOOKAHEAD_MAX: NEURAL_LOOKAHEAD_MAX,
    },
  };
})();
