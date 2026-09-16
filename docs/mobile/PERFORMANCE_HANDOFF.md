# Start here: mobile performance handoff

Read this file, then [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md). The plan is
the implementation checklist. [PERFORMANCE.md](PERFORMANCE.md) contains the
device measurement protocol. No conversation history is required.

## User authorization and reported environment

- The user approved executing the complete plan, including implementation and
  scoped PRs. Do not ask again whether to begin ordinary authorized work.
- iPhone 15 Pro, native Capacitor app. Natural TTS startup and playback cause
  heat, battery drain and instability. Michael is the usual voice, but other
  Natural voices also trigger it.
- The installed baseline is PR #63. The user builds from their Mac using
  Xcode Command-R with the phone plugged in. This is not a PWA/TestFlight issue.
- The agent development host is Windows/PowerShell. It cannot establish iOS
  compilation, real-device inference performance, temperature or battery use.
- Preserve selected voices, book text, imports and reading progress. Do not
  silently replace Natural voice with Apple speech or remove model assets.

## Verified checkpoint: 2026-09-16

- Baseline main commit: `2443b0e` (PR #63).
- Implementation commit: `a46fa992dafbd26abf7fa49d53348b36e025010b`.
- Draft [PR #64](https://github.com/smelvintime/Offline-Reader/pull/64), branch
  `codex/mobile-voice-efficiency`, targets `main`.
- PR #64 CI and Vercel checks passed at that implementation commit. Re-check
  current remote state; this is a checkpoint, not a guarantee about newer heads.
- Local browser suites passed: platform, image zoom, novel reader, importer,
  novel voice, and the new real-phonemizer/native-adapter integration test.
  Node performance contracts 2/2, worker tests 221/221, scraper tests 8/8,
  catalogue/welcome validation and cache-version checks passed.
- No iOS build or iPhone energy/thermal run has been performed by the agent.
- Image cleanup/memory, scroll optimization, import bounds, maintenance work,
  rolling scheduler policy, inference tuning and audio-transfer experiments
  have NOT been implemented. Do not infer completion from the voice PR title.
- A local `codex/mobile-reader-efficiency` branch was created at `a46fa99`,
  but no reader edits or commits were made on it. It may lack later handoff
  documentation commits. Inspect before reusing; do not overwrite user edits.

## P06 record: 2026-09-16

```text
Task ID / date: P06 / 2026-09-16
Commit and PR: branch codex/mobile-reader-efficiency, stacked on
  codex/mobile-voice-efficiency (PR #64, still draft)
Behavior changed:
  - One exitReaderSession() now ends every image-reader session. Close used to
    revoke the blob URLs and empty the arrays; Home ran the full teardown; the
    back gesture ran neither. All three are the same exit now, and the
    destination is the caller's.
  - The final image-progress write was being lost on Close: reader.js's click
    listener cleared `pages` before catalogue.js's listener read it, so
    syncImageProgress saw zero pages and returned. The flush is now the first
    thing the exit does, through Catalogue.flushImageProgress().
  - A session generation token invalidates native extractions that land after
    their session ended; the orphaned page directory is released instead of
    being written into the next session's pages array.
  - Extracted page dirs, the IntersectionObserver and the reader's timers are
    released at the END of a session rather than at the start of the next one.
Tests actually run and outcomes: new test/image-reader.test.html (11 cases),
  added to the default browser suite list; full browser + node gate below.
Device evidence: NOT RUN. No Mac, no iPhone from this host. Memory behavior on
  device is unverified; the suite proves the teardown, not the megabytes.
Remaining risks/dependencies: catalogue.js's goBack/goHome wiring is covered by
  inspection and the reader-side contract test, not by a catalogue suite (there
  is none). P07 (decoded-byte budgets) builds on this cleanup.
Next exact task and starting files: P07 — js/reader.js (loadPage,
  unloadDistant, the observer window), js/platform.js (TUNING).
```

## P07 record: 2026-09-16

```text
Task ID / date: P07 / 2026-09-16
Commit and PR: branch codex/mobile-reader-memory, stacked on
  codex/mobile-reader-efficiency (P06)
Behavior changed: retained decoded bitmaps are now bounded by estimated bytes
  (natural dimensions x 4) against a per-memory-class budget — decodedMB
  96/192/320 — and evicted farthest-first inside the existing unloadDistant()
  pass. The count windows stay as they are; they are the cheap first filter.
  Visible and current pages are never evicted, so a single spread larger than
  the budget still renders: the budget is a target, not a guarantee.
Deliberately NOT built (plan items 2, 4 and 6 of P07):
  - A separate bounded decode/extraction queue. loadPage already dedupes on
    p.loading and the observer debounce already bounds a pass to
    LOOK_BEHIND+LOOK_AHEAD pages. Add one when a profile shows decode
    concurrency, not retention, is the cost.
  - Resident-page tracking instead of the pages.forEach scan. The scan is one
    pass over an array on a 100 ms debounce; above 800 pages the scroll window
    already collapses chapters. Add when a profile shows the scan.
  - Downsampling. The plan makes it conditional on profiling, and nothing has
    been profiled on device yet.
Tests actually run and outcomes: 3 new cases in test/image-reader.test.html
  (evict farthest first to budget, visible page survives its own budget,
  nothing evicted under budget); full browser + node gate below.
Device evidence: NOT RUN. The budget numbers are chosen, not measured; P01's
  capture checklist on the phone is what should confirm or move them.
Remaining risks/dependencies: decodedBytes() is an estimate, not the
  compositor's figure. A page that has not decoded yet counts as zero and is
  caught on the next pass.
Next exact task and starting files: P08 — js/novel-reader.js (onScroll,
  captureScroll, prefixChars), js/reader.js (autoStep).
```

## Next actions

1. Follow the plan's restart commands and inspect changes since this checkpoint.
2. On a Mac, start **P02 native validation**. On Windows, start **P06 shared
   image teardown** while native validation remains explicitly pending.
3. Keep PR #64 draft until its native build and device gates are satisfied.
4. Complete one task and its relevant checks before expanding scope. Update
   the plan status table with the commit, evidence and remaining limitations.
5. Use a fresh PR for reader work. If it needs unmerged PR #64, base it on
   `codex/mobile-voice-efficiency` and document the stack. After the parent
   merges, retarget/rebase carefully and re-check the resulting diff.

## Avoid repeating investigation

- Kokoro 1.2.1's public `new KokoroTTS(modelCallable, tokenizerCallable)` works
  without `from_pretrained`. The native adapter already uses this seam.
- The bundle exports only a narrow `env` wrapper with `wasmPaths`. Assigning
  arbitrary Transformers environment options to it does not configure the
  underlying library. Native tokenizer resources now use explicit local GETs.
- The native adapter is tested against the actual pinned tokenizer, including
  its post-processing/truncation behavior. Do not replace this with guessed
  tokenization or a test that only duplicates the adapter implementation.
- The browser worker used to survive shell updates in the vendor cache.
  Merely bumping the shell cache was insufficient because global cache lookup
  could find the stale copy first. PR #64 explicitly prefers the shell copy.
- The existing image-zoom test failed on spaces in CSS serialization. PR #64
  fixes the assertion using DOMMatrix; that was not a zoom implementation bug.
- `RTK.md` referenced by user-provided instructions could not be found in the
  repository or checked ancestors. Read it if it becomes available; do not
  invent its contents or repeatedly search the whole machine.

## Suggested continuation prompt

> Read docs/mobile/PERFORMANCE_HANDOFF.md and PERFORMANCE_PLAN.md. Verify the
> current checkout and PR state, then execute the next unblocked task. The user
> already authorized implementation and scoped PRs. Preserve completed work,
> run the task-specific tests, and update the status/evidence before handing
> off. Do not claim iPhone performance improvements without device measurements.
