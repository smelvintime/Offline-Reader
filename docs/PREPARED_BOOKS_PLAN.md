# Prepared books: plan

Status: first slice built (see "Built so far"). Numbers marked "estimate" are
guesses to be replaced by a measurement.

## Built so far

The JavaScript slice, which runs in both builds and needs no new native code:

- "Prepare this book" in the voice sheet renders every group into IndexedDB
  (16-bit WAV, about 170 MB per hour of audio). Progress, a stop button,
  resume from the first missing group, and "Delete prepared audio".
- Playback of a prepared chapter plays stored clips and never loads the model.
- Unprepared chapters of a prepared book use the iPhone voice where it exists.
- Preparing pauses at serious heat, stops when listening starts or the book
  closes, and keeps running with the screen locked through a silent audio loop.

Still to do from the phases below: AAC encoding in the native plugin (smaller
files), the overnight `BGProcessingTask`, a charging check before starting,
and the side-by-side battery measurement.

## Requirements, in priority order

1. **No heat while listening.** Playback should warm the phone no more than a
   music app does, which is close to nothing.
2. **Instant playback.** Pressing play starts audio immediately, every time,
   including the first sentence of a chapter never listened to before.
3. **Low battery use while listening.**
4. Storage is the thing we trade away. Larger books on disk are acceptable.

Rendering the audio heats the phone and costs battery no matter when it
happens. The plan does not try to make that cheap. It moves all of it to a time
when heat and battery do not matter: while the phone is charging.

## The rule that follows

**Playback never runs the model.** Listening means playing a stored audio
file, the way a music app does. Everything the model does happens during
preparation.

Consequences:

- A chapter is playable with the natural voice only once its audio is on disk.
- There is no live natural-voice fallback during playback by default. Live
  generation is exactly the heat source being removed. If a reader reaches an
  unprepared chapter, the app offers the iPhone's own voice (which costs nearly
  nothing) or stops with "this chapter isn't prepared yet". Live natural voice
  can remain as an explicit, off-by-default setting.
- The "Quick" mode from the first draft (render ahead while listening) is
  dropped. It renders during playback, which breaks requirement 1.

## Why this works for heat and battery

- iPhones decode AAC in dedicated hardware. Playing a stored AAC file costs a
  tiny fraction of running Kokoro.
- The app already keeps playing with the screen locked
  (`UIBackgroundModes = audio`, applied by `scripts/apply-native-config.mjs`).
  Screen off is most of how a music app saves battery, so listening with the
  phone locked should be the normal case.
- With the screen on, the only extra work is moving the highlight once per
  group, a few times a minute.

## Preparing a book

### When it runs

- **While charging, by default.** Native iOS offers two ways:
  - App open on the charger with the screen kept awake: a "Preparing, keep
    plugged in" screen with progress and an estimate.
  - Overnight: a `BGProcessingTask` with `requiresExternalPower`, which iOS
    runs when the phone is idle and charging. iOS decides when and for how
    long, so it must save progress after every chunk and resume cleanly.
- **Unplugged only if the reader asks**, behind a warning that the phone will
  get warm. It stops on its own if the thermal state reaches `serious`.
- The web/PWA build cannot run in the background on iOS. It can prepare only
  while open. The native build is the target.

### What it stores, per chapter

- The narration script: groups (sentence range, anchor
  `{ chapterId, blockIdx, charInBlock }`, text, pause after), built once at
  import. Groups use the widest caps (`NEURAL_GROUP_TARGET`/`MAX`). The
  adaptive narrowing in `neuralGroupCaps()` and `FAST_START_CAPS` exist to keep
  live generation ahead of the reader, which no longer applies.
- One audio file for the chapter, with pauses baked in, rendered at speed 1.
  Playback speed is applied by the player (pitch preserved), as it is today, so
  every speed uses the same file.
- The start time of each group in that file. Kokoro does not report where each
  sentence falls inside a clip, but each group is rendered separately, so its
  start time is exact. The highlight moves per group, as it does today.

Cache key, so audio is rebuilt only when it must be:

    hash(chapter text) + scriptVersion + model id + dtype + voice

### Format and size

AAC, mono, 24 kHz, about 64 kbps: roughly 29 MB per hour of audio, so about
300 MB for a 10-hour novel (estimate). Storage is the accepted trade, so the
bitrate leans toward quality.

Encoding happens in the native plugin (`native/or-kokoro`): a new
`renderChapter` method takes the token ids for each group, runs the model,
encodes to AAC with AVFoundation and writes the file to disk. The PCM never
crosses back to JavaScript, which today happens for every clip.

### Progress and control

- Progress saved per chapter. A killed app, a dead battery or a thermal pause
  resumes where it stopped.
- The book shows how many chapters are ready. Chapters play in order as soon
  as they are ready, so a reader can start chapter 1 while the rest prepare
  (on the charger).
- Before preparing, a short timed test render gives a whole-book estimate.
- Settings show disk space per book and can delete a book's audio while
  keeping its script.

## Playback

- Native player (AVPlayer or AVAudioPlayer) playing the chapter file, with
  lock-screen controls. Speed uses the player's rate with a pitch-preserving
  time-stretch.
- Group start times drive the highlight and page turns when the screen is on.
- Starting mid-chapter seeks to the start of the group holding the reader's
  position. No wait, because nothing has to be generated.

## Phases

1. **Measure on the target iPhone, native build.** Generation speed
   (the voice sheet's "× realtime"), time to prepare one chapter, and the
   thermal state over a 30-minute render on the charger. That gives the
   whole-book preparation time and decides whether one overnight is enough.
2. **Native `renderChapter`.** Model run, AAC encode, file write, group
   offsets, resumable.
3. **Narration script builder.** Segmentation and grouping moved to import,
   versioned and keyed.
4. **Prepared playback.** Native player, speed, highlight from offsets, lock
   screen, iPhone-voice fallback for unprepared chapters.
5. **Preparation scheduling.** Charging screen, `BGProcessingTask`, thermal
   and battery guards, estimate, storage controls.
6. **Verify the requirements on the phone.** An hour of locked-screen
   playback: battery drop and thermal state compared with a music app playing
   for the same hour. Time from tapping play to audio.
7. **Tests.** Resume after kill, key invalidation on text or voice change,
   fallback for missing audio, highlight sync from offsets.

## Open questions

- How long does a whole book take to prepare on the target iPhone? (Phase 1.)
- Bundled books: prepare on the first charge after install, or only on
  request?
- Voices: prepare only the selected voice. Changing voice means preparing
  again, with a prompt.
- Does the web build get prepared playback too (audio in IndexedDB, prepared
  only while open), or is it native-only?

## Dropped from the first draft

- Quick mode (renders during playback).
- Storing phoneme tokens in the script. The browser path hands plain text to
  kokoro-js, which converts it internally, and the cost is small next to the
  model run. The native `renderChapter` converts text to tokens during
  preparation anyway.
- Per-sentence time offsets. Kokoro gives no alignment, so per-group offsets
  are what can be known exactly.
