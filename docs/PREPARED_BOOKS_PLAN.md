# Prepared books: plan

Status: draft, nothing built yet. Written from the repo docs and code comments,
not from profiling. Every number below marked "estimate" is a guess to be
replaced by a measurement.

## Goal

When a book is imported, prepare it once so that listening is instant, uses
very little CPU while playing, and does not heat the phone. Reading aloud
should be mostly playback of stored audio, not live neural inference.

## Why

Today the chapter is segmented into sentences and grouped at runtime, then each
group runs through Kokoro live. The model run is the expensive step and the
main source of heat. Only a small in-memory clip cache is kept (WAV_CACHE_MAX
in js/novel-voice.js), so replay and relaunch redo the work.

Preparing once moves that work to a time the user chooses (import, charging)
and leaves playback as decoding audio.

## What can be prepared once

1. Extracted, cleaned text (ruby glosses handled, `……` `――` `「」` mapped to
   pauses and quotation marks).
2. Sentence segmentation and grouping, with pause lengths and reader anchors.
3. Phoneme tokens for each group.
4. Rendered audio per group, plus per-sentence time offsets so highlighting
   and page turning still follow the voice.

Steps 1 to 3 are cheap and fast. Step 4 is the model run and cannot be skipped,
only moved earlier.

## Design

### Narration script (per chapter)

Stored with the book, keyed so it is rebuilt only when it must be:

    key = hash(chapter text) + scriptVersion + model id + dtype + voice

Contents: groups (id, sentence range, anchor `{ chapterId, blockIdx, charInBlock }`,
text, phoneme tokens, pause after in ms), and later the audio reference and
offsets. Speed is NOT baked in. Playback rate is applied at playback so each
chapter is rendered once whatever speed is chosen.

### Prepared audio (per chapter)

Compressed audio, one file per chapter, plus offsets. Encoder choice is open
(see risks). Raw WAV for a long novel would be on the order of gigabytes
(estimate), compressed audio on the order of 100 MB (estimate).

### Two preparation modes (user setting, also chosen at import)

- **Quick (default).** Book is locked until the script for the whole book and
  the audio for chapter 1 are ready. Remaining chapters render in the
  background, a few ahead of the reading position.
- **Full.** Book is locked until every chapter's audio is ready.

Rules shared by both:

- Progress saved per chapter. Closing the app, running out of battery or a
  thermal pause resumes where it stopped.
- Rendering pauses when the device is warm or battery is low, and says so
  ("plug in to finish preparing").
- Before Full starts, time a short test render and show an estimate, with a
  warning when it is long.
- Cancelling Full keeps finished chapters and switches the book to Quick.
- A Quick book gets a "Prepare rest of book" button to run Full later.
- Unrendered chapters fall back to today's live narration, so nothing breaks.
- Storage screen shows audio size per book and can delete audio while keeping
  the script.

## Platform notes (iPhone is the target)

- The web/PWA build on iOS has no reliable background processing, so
  background rendering there only runs while the app is open. Full mode is
  realistic in the native (Capacitor) build, where rendering can use the
  existing native Kokoro plugin (native/or-kokoro) and write audio to disk.
- Native can read thermal state and battery state to drive the pause rules.
  Exact APIs to confirm when building.
- Keep the screen awake and show a plug-in prompt during Full mode.
- Device speed is unknown. The docs mention devices slower than real time. If
  the target phone renders faster than real time, Full is minutes to an hour or
  two for a long novel (estimate). If not, Full may take longer than the book
  lasts and should warn loudly.

## Phases

1. **Narration script format and builder.** Move segmentation, grouping and
   phonemization out of playback into an import-time step. Versioned, cached,
   rebuilt by key. Playback reads the script instead of recomputing.
2. **Measurements.** Time each stage on the target iPhone: segmentation,
   phonemization, model run per second of audio, thermal behaviour over a long
   run. Decide from the numbers whether phase 1 alone helps noticeably.
3. **Render pipeline.** Chapter queue, resume, thermal and battery guards,
   audio written to disk (native) or IndexedDB (web).
4. **Playback from prepared audio.** Audio element or native player, offsets
   driving highlight and page turns, live fallback for gaps.
5. **Import UI.** Locked book with progress, Quick/Full choice, estimate,
   cancel, "Prepare rest of book", storage controls.
6. **Tests.** Resume after kill, key invalidation on text or voice change,
   fallback when audio is missing, highlight sync from offsets.

## Open questions

- Which encoder works on the target iPhone in both native and web builds?
- Does phonemization in the script actually save meaningful time, or is the
  model run nearly all of the cost? (Phase 2 answers this.)
- Maximum acceptable storage per book and in total.
- Should bundled books be prepared at first launch, or only imported ones?
- Multiple voices: render per voice on demand, or only the selected voice?

## Reminders from CLAUDE.md

- Changing a precached shell asset means bumping `CACHE_NAME` in `sw.js`.
- Tests are browser pages under `test/`, not a CLI.
- No em dashes anywhere in replies.
