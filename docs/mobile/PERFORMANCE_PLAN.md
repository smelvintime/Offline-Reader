# Mobile performance execution plan

This is the authoritative checklist for the approved performance project.
Start with [PERFORMANCE_HANDOFF.md](PERFORMANCE_HANDOFF.md) for authorization,
device context and the last verified Git/PR state. Use
[PERFORMANCE.md](PERFORMANCE.md) for the physical-device protocol.

## Completion and scope rules

The project is complete only when the applicable code changes are implemented,
regression checks pass, the native app builds, and the iPhone validation gates
pass. A green browser test is not proof of native inference, temperature,
battery improvement or crash elimination.

Three kinds of work are intentionally distinguished:

1. Confirmed defects: implement and regression-test the correction.
2. Measured bottlenecks: profile, make a bounded change, compare results.
3. Possible optimizations: investigate cheaply; retain the existing design
   when measurement does not justify a change. Record the decision as done,
   not as a silently skipped task.

Two scope boundaries, both decided rather than discovered:

- **Desktop is a separate plan.** Every tuning decision here reduces work
  because the device is a phone. A computer browser wants the opposite in
  places (deeper buffers, prewarming, a larger image window, a desktop viewport
  in the test harness). Tracked as P14 and written up separately so the mobile
  tasks below do not have to carry two answers.
- **Android is out of scope.** Both native plugins are iOS-only
  (`native/or-kokoro/ios`, `native/or-speech/ios`); there is no Android
  thermal/low-power signal and no native inference path to tune. An Android
  build falls back to the browser paths, which P02 keeps working.

Do not rewrite unrelated modules, change voice identity, discard user data,
switch acceleration based on speculation, or push directly to main. Do not
merge PRs or publish a device build merely because implementation is authorized.
Use scoped PRs and make unverified native changes visible as draft work.

## Status ledger

`IMPLEMENTED` means source and listed automated checks exist; it does not mean
device validation is complete. Every subsequent agent must update this table.

| ID | Task | Status at handoff | Evidence / next gate |
| --- | --- | --- | --- |
| P01 | Build identity and bounded diagnostics | IMPLEMENTED, partial baseline | PR #64 / a46fa99; collect iPhone baseline and candidate data |
| P02 | Remove redundant native model startup | IMPLEMENTED | PR #64; real tokenizer parity and worker integration pass; Xcode/device gate pending |
| P03 | Voice lifecycle, recovery, resource signals | IMPLEMENTED, validation pending | PR #64; strengthen policy/cancellation edge coverage below; native gate pending |
| P04 | Scheduler, queue and audio memory bounds | PARTIAL | Four-job and byte/count bounds implemented; rolling policy and adversarial cache tests remain |
| P05 | Sustainable native inference tuning | NOT STARTED, device measurements needed | Preserve existing CPU/precision defaults until benchmark selects a change |
| P06 | Shared image-reader teardown | IMPLEMENTED, device gate pending | `test/image-reader.test.html` (new suite, 11 cases); Close/Home/back unified, session token added |
| P07 | Image decoding and memory budgets | PARTIAL | Decoded-byte budget + farthest-first eviction landed; bounded decode queue and downsampling deliberately not built |
| P08 | Novel scrolling and autoscroll efficiency | PARTIAL | Autoscroll idle-spin and per-frame chrome/style work fixed; the anchor-capture split is BLOCKED on a device profile (see handoff) |
| P09 | Large-import allocation/cancellation bounds | PARTIAL | Reader allocation gates landed; importer already had AbortSignal cancellation; reader-side cancel UI does not exist and was not invented |
| P10 | Library/cache/backup maintenance | NOT STARTED, profile first | Existing debounce/protection must be preserved |
| P11 | Browser worker upgrade correctness | IMPLEMENTED | PR #64 / performance contract test; add full SW lifecycle test if upgrading cache policy |
| P12 | Audio transfer/playback experiment | NOT STARTED, measure first | Depends on P01 native timing and P02 validated startup |
| P13 | CI, device acceptance and release | PARTIAL | Browser/Node checks added; `goals`, `thoughts` and `ort-wasm` still absent from the default suite list; final device gates pending |
| P14 | Desktop (computer browser) capability tier | SEPARATE PLAN | Out of scope here by decision (2026-09-16); see `docs/desktop/PLAN.md` when written |

## Restart procedure (do this once)

Read `CLAUDE.md`, available `AGENTS.md`/`RTK.md`, and this handoff. Then run from
the saved repository, using separate commands or a straightforward script:

```powershell
git status --short
git branch --show-current
git log -5 --oneline
git remote -v
git fetch origin
git rev-list --left-right --count HEAD...origin/main
gh pr view 64 --json state,isDraft,headRefName,headRefOid,baseRefName,statusCheckRollup
```

If files are modified, identify their ownership before switching branches.
Do not reset, stash or overwrite unexplained edits. Verify actual hashes;
the ledger is historical evidence. If PR #64 has merged, start new work from
current `origin/main`; if it has not, use a clearly documented dependent PR
when its test runner or fixes are required. Do not reimplement completed work.

Dependency setup, when absent or the lockfile changed:

```powershell
npm ci
npx playwright install chromium
```

Run the smallest relevant tests during development. Run the full gate once
before publishing the final commit, and repeat only for new changes/failures.
For repository scripts, use UTF-8 explicitly when reading/writing source.
On Windows, do not pass paths to another shell for recursive deletion.

## P01: Identify builds and measure the actual workload

Files: `js/novel-voice.js` (`voiceDiagnostics`, `voiceEvent`), `js/platform.js`
(`buildInfo`), `scripts/write-build-info.mjs`, `scripts/sync-www.sh`.

1. Verify the diagnostics panel reports the bundle's source commit, dirty flag,
   build time, app version/build, actual backend, weights, voice and rate.
2. Confirm unavailable fields stay unknown; do not substitute guessed device
   memory, backend or energy values.
3. Keep diagnostics capped at 100 events and omit text/audio. Timings include
   startup, generation and complete native bridge round trip. Separate session
   construction from inference if native profiling needs that distinction.
4. Record PR #63 and candidate measurements using PERFORMANCE.md. Use the same
   chapter/settings, let the phone cool between runs, and repeat comparable
   measurements. Battery runs must be unplugged; Xcode installation may be wired.
5. Classify instability using actual error/termination evidence. Distinguish
   WebView termination, native crash, engine timeout and audio interruption.

6. Everything downstream of this task blocks on a person holding the phone, so
   P01 ends with a checklist short enough to finish in one sitting. Per run
   record: build stamp, backend, weights, voice, rate, chapter id; startup ms,
   first-audio ms, generation ms and audio seconds per group; buffer depth;
   thermal state at start/middle/end; Low Power Mode; battery percentage at
   start and end with the phone unplugged; and whether anything stopped. Three
   comparable 30-minute runs on PR #63 (baseline) and three on the candidate.
   Capture termination evidence from Xcode's device log or a sysdiagnose, not
   from memory of what the screen did.

Tests: diagnostics ring-buffer capacity, absent-plugin behavior, no book text
in the report, dirty/source build stamp. Test the actual native report on Mac.

Done: reproducible baseline and candidate data exist, or the missing physical
measurement is explicitly recorded as a release blocker. No invented percentages.

## P02: Validate the native startup correction

Files: `js/novel-voice-worker.js` (`createNativeEngine`, `init`),
`js/voice-native-tokenizer.mjs`, `test/voice-worker.test.html`.

1. Retain Kokoro's pinned public constructor, phonemizer and voice selection.
   Native initialization must not call browser `from_pretrained`.
2. Fetch bundled tokenizer resources with GET. Reject incompatible schemas
   clearly; do not silently tokenize differently or download inference weights.
3. Keep the browser inference path functional. Do not broaden native-only
   assumptions to browsers or Android builds without the plugin.
4. Verify repeated acquisitions share startup; disposing during initialization
   settles the pending promise, terminates the worker and invalidates late work.
5. Build in Xcode and test Michael and another Natural voice, cold and warm,
   with network disabled after installation. Capture actual native inputs/output
   failures if any; simulated PCM does not prove the model runs on device.
6. Keep q8/fp32 packaging unchanged until native validation succeeds. Any later
   packaging reduction is its own compatibility decision with offline tests.

Commands: `node scripts/test-browser.mjs voice-worker novel-voice` and
`npm run test:performance`.

Done: no browser inference initialization on native; correct speech and resume
on device; lower startup work demonstrated without claiming a universal number.

## P03: Finish voice lifecycle and thermal-policy validation

Files: `js/novel-voice.js` (`pause`, `play`, `stopSession`, `readerEvent`,
`updateResources`, neural engine lifecycle), `js/platform.js` (`kokoro`),
`native/or-kokoro/ios/Sources/OrKokoroPlugin/OrKokoroPlugin.swift`.

1. Review ownership for unloaded/loading/ready/playing/paused/releasing/failed.
   Each worker, native session, pending job, timer, URL and audio element must
   have one owner and an explicit disposal path.
2. Preserve quick pause/resume reuse. After the configured grace period, release
   resources and reload on explicit resume without losing the sentence.
3. Cover close/home/new-book/voice-change while loading or generating. Generation
   epochs must prevent stale callbacks from restoring state or populating caches.
4. Test startup silence and generation timeout. Reject promises and reset the
   engine; do not allow repeated retries to queue behind an abandoned job.
5. Verify native severe thermal pressure blocks new inference; memory pressure
   releases inactive resources. Already-running native inference may finish.
   Native cancellation must invalidate queued work before it starts.
6. Test low-power/fair/serious/critical/nominal transitions, cooldown and explicit
   resume. Do not strand the app blocked after it cools; do not auto-resume when
   the user paused. Cover pressure while initializing and during voice preview.
7. Distinguish intentional background listening from a paused/inactive session.
   Test screen lock, system audio interruptions and returning to the app.
8. Verify observers are not duplicated and shared state is read/written on
   appropriate native queues. Compile against the actual Capacitor/ORT versions.

Tests: extend `test/novel-voice.test.html` with deterministic resource transitions,
long-pause timer behavior, late native replies, voice switches and shutdown.
Existing tests cover startup disposal, queue cap, low-power lookahead, bounded
diagnostics, pause dedupe and worker cancellation; they do not cover all above.

Done: no orphaned work, bounded post-stop memory, no stuck cooldown, preserved
background playback and no native compile errors. Keep PR draft until verified.

## P04: Complete scheduling and audio-cache bounds

Files: `js/novel-voice.js` (`noteSpeed`, `neuralMargin`, `lookaheadSeconds`,
`prefetchNeural`, `generate`, `cancelPending`, `channel`).

1. Preserve implemented four-pending-job limit and conservative unmeasured start.
   Confirm both the main-thread queue and worker queue enforce their bounds.
2. Implement a short rolling generation estimate. Current `speedSamples` records
   samples, but scheduling still uses the last ratio: this is NOT finished.
   Account for playback rate, react quickly to slowdowns, and avoid oscillation
   on one fast sample. Reset samples on relevant engine/voice changes.
3. Bound queued jobs, buffered seconds and cached bytes independently. Protect
   the playing/primed clips. State what happens if a single protected clip alone
   exceeds the target; do not promise an absolute limit while exempting it.
4. Verify eviction never revokes audio about to play or regenerates the same
   pending clip. Revoke cached URLs and clear metadata exactly once on disposal.
5. Prefer refill events at generation/playback boundaries. Remove the periodic
   pump only if continuity/recovery tests prove it unnecessary; otherwise retain
   a bounded watchdog that cannot run for stopped playback.
6. Enforce power policy before prebuffering and steady-state generation. Check
   precedence: an existing startup prebuffer must not bypass Low Power Mode.
7. Ship a kill switch with any new scheduling or thermal policy: one setting,
   visible in the diagnostics panel, that restores the previous behavior on
   device. Only the user can run the phone, and each iteration costs an Xcode
   install; a policy that can only be disabled by rebuilding turns one bad
   guess into a wasted day.

Tests: fast/slow alternating samples, changed rate/voice, four occupied slots,
oversized clips, paused primed clip, skip-back, cancel between settlement and
promise continuation, timeout then immediate restart. Use controlled fake time
where possible. Do not rewrite assertions merely to bless new constants.

Done: tested bounds and a justified estimate, with no audible regression in
device runs. Smooth playback cannot be guaranteed if synthesis is slower than
consumption; expose the limitation instead of chasing unbounded buffering.

## P05: Benchmark native inference configuration

Dependency: P01 baseline and P02 native validation. Windows-only agents should
prepare tests/documentation and continue independent tasks, not invent results.

1. Record current threads, precision, group size and provider.
2. Compare a small thread-count matrix, representative short/long groups and
   supported model formats. Change one factor at a time.
3. Measure cold startup, sustained generation, memory, thermal state, energy and
   audible gaps. Keep existing no-spin settings.
4. Do not re-enable Core ML/WebGPU on assumption. Earlier code records
   shape-compilation and graph-partition costs; acceleration needs end-to-end
   evidence. Verify current official APIs before using unfamiliar native APIs.
5. Choose a configuration only if sustained measurements justify it. Document
   a no-change decision if the existing configuration wins.

Done: recorded benchmark and configuration decision, with device regression pass.

## P06: Unify image-reader exit and async ownership (next coding task)

Files: `js/reader.js` (`teardownAll`, `resetReaderState`, Close/Home handlers,
`ensureChapterExtracted`), `js/catalogue.js` (image progress/exit handlers).

1. Reproduce opening a series image chapter, enabling autoscroll, then Close.
   Compare Home: Close currently clears arrays without equivalent full cleanup.
2. Create a shared exit routine. Flush progress while chapter state still exists,
   then stop autoscroll, cancel timers/frames, disconnect observers, invalidate
   asynchronous work, clear image handlers/sources, revoke owned object URLs,
   and release session-owned native extraction directories.
3. Route both Close and Home through it while preserving their destinations.
   Check back/history navigation and new-content replacement for equivalent exit.
4. Introduce or consistently use a session generation token. Native extraction
   completing after exit must not write into the next session's `pages` array.
   Its obsolete temporary directory must be reclaimed without deleting active
   or imported source archives.
5. Preserve catalogue progress listeners: two independently registered click
   handlers currently cooperate on progress. Consolidate carefully so cleanup
   does not clear the data before its final progress write.

Tests: real page or dedicated image-reader harness; Close vs Home, pending
extraction, pending image decode, rapid reopen, all image sources cleared,
observers/timers stopped, correct progress and destination. Extracting source
text and checking strings is not sufficient evidence of lifecycle behavior.

Done: both exits produce equivalent resource cleanup; late operations cannot
mutate the next session; progress/resume and navigation tests pass.

## P07: Bound image decoding and retained memory

Dependency: P06. Files: `js/reader.js` (`loadPage`, `unloadDistant`, observer
lookahead/windowing), `js/platform.js` (`TUNING`).

1. Measure loaded image count and dimensions in long sessions. Estimate decoded
   bytes from pixel dimensions, not compressed blob size. Treat this as an
   estimate, not an exact GPU/process-memory reading.
2. Add a small bounded decode/extraction queue; prioritize visible pages, then
   a short directional lookahead. Deduplicate by page/session identity.
3. Bound retained decoded bytes and page count. Evict farthest nonvisible pages
   first while keeping current/visible content usable. Document the unavoidable
   exception for a single visible image larger than the nominal budget.
4. Track resident pages rather than scanning an entire huge archive on every
   observer update. Clear tracking and pending work during P06 teardown.
5. Preserve image aspect ratios/placeholders so eviction does not jump scroll.
   Ensure reverse scrolling reloads evicted content and failures remain retryable.
6. Downsample only if profiling justifies it; retain a path to full-resolution
   zoom. Do not silently degrade legibility to satisfy an arbitrary memory cap.

Tests: huge portrait images, many small pages, rapid forward/reverse scroll,
failed image, zoom during eviction, two concurrent sessions racing, native
extraction crossing chapter boundaries. Add bounded-count/byte assertions.

Done: bounded residency over long sessions, correct loading order/zoom, no blank
regions or scroll jumps, lower measured memory on device.

## P08: Reduce scroll/layout and autoscroll work

Files: `js/novel-reader.js` (`onScroll`, `captureScroll`, `prefixChars`,
`syncPosition`, `updateChrome`, `flushProgress`), `js/reader.js` (`autoStep`).

1. Profile a long text chapter. Current scroll callbacks can scan blocks and
   character-range geometry every animation frame.
2. Split coarse visual progress from exact anchor capture. During movement,
   use bounded work near the last known block; capture the precise character
   after settling and before saves, navigation or layout changes.
3. Ensure visibility/pagehide/close flushes capture an outstanding position
   before persisting. Debouncing must not save a stale sentence.
4. Cache text prefix counts. Invalidate geometry hints on typography, resizing,
   image load, chapter/window changes and content replacement.
5. Avoid rebuilding status DOM when displayed values are unchanged. Batch layout
   reads before writes. Preserve accessibility labels and progress semantics.
6. Jump autoscroll should wait on a timer between jumps, using animation frames
   only during movement. Store/cancel frame and timer IDs; repeated starts must
   not create parallel loops. Re-arm correctly when speed/mode changes.
7. Profile blur/compositing. Remove or simplify only measured costly effects;
   persistent `will-change` and broad backdrop blur are candidates, not proven
   explanations for the Natural voice symptom.

Tests: long chapters, flick then immediately close/lock, exact resume, rotate,
font change, late images, narration following, reduced motion, jump speed change,
start twice, stop during wait/jump. Use frame/geometry counters for deterministic
work bounds and real-device profiling for visual smoothness.

Done: less work while scrolling, no loss of precise position, no duplicate idle
animation loops, and existing novel-reader/voice suites pass.

## P09: Bound import allocations and cancellation

Files: `js/reader.js` (`loadArchives`, `extractEntries`, native URI loaders),
`js/importer.js` (`openZip`, import/commit/cancel paths), native ZIP plugin.

1. Check known file sizes before `arrayBuffer`/JSZip allocations. The current
   browser set-size selection happens after archives and nested CBZs are opened.
2. Inspect archive metadata before expanding entries where supported. Bound
   aggregate expanded bytes, entry count, nesting and active extraction work.
   Apply actual-output checks too; do not trust declared sizes exclusively.
3. Process incrementally; release rejected or consumed buffers. A worker may
   improve responsiveness but does not automatically lower memory consumption.
4. Keep native URI/file-based reading in place. Do not move large native files
   into base64/ArrayBuffers for convenience. Audit fallback picker routes.
5. Cancel cooperatively: stop scheduling entries, invalidate late callbacks,
   reclaim temporary output, and either roll back partial library writes or
   expose a well-defined resumable import. Preserve existing imported originals.
6. Show actionable size/failure messages and let the user retry. Do not reset
   the entire library or silently import an unexplained subset.

Tests: under/over limit, multi-file aggregate, nested archives, declared/actual
size mismatch, corrupt input, cancellation mid-extraction/commit, retry, native
URI fallback. Use small synthetic fixtures with small injected test budgets;
do not allocate gigabytes just to test a branch.

Done: memory limits act before the damaging allocation, UI stays usable, no
partial corruption or orphaned temporary files, importer tests pass.

## P10: Profile and bound maintenance work

Files: `js/store.js` (`pruneChapterCache`), `js/catalogue.js` (`runCachePrune`,
library rendering), `js/importer.js` (backup/export), `js/goals.js` (tick).

1. Measure boot and ordinary reading with a large synthetic library. Separate
   catalogue rendering, full-record IDB scans, JSON serialization and backup.
2. Preserve existing debounce and imported-series protections. Backup progress
   is already limited by day; do not misdescribe it as a write on every scroll.
3. For a demonstrated stall, move to metadata-only indexing or bounded batches,
   yielding between transactions. Consider migration cost before adding stores.
4. Avoid duplicate prune/backup runs and avoid competing with voice startup.
   Idle scheduling needs a fallback; it is not permission for unlimited work.
5. Stop unnecessary UI tick updates while hidden/inactive only if measurement
   justifies it. Timers must still use elapsed wall time accurately on resume.

Tests: protected chapters/originals survive; only allowed cache records evict;
aborted transaction does not report deletions; interrupted backup preserves the
last good copy; large-library work is bounded; restore semantics unchanged.

Done: measured bottleneck improved, or documented no-change decision with data.

## P11: Preserve correct browser upgrades

Files: `sw.js`, `scripts/check-sw-cache.mjs`, `test/performance.test.mjs`.

PR #64 moves application voice code into shell precaching and explicitly
prefers it over a legacy vendor-cache entry. The helper is also a shell asset.

1. Retain this separation; changes to vendor/model resources require their own
   deliberate versioning decision.
2. If cache policy changes again, test a real older SW install, populate the
   legacy worker/model cache, then activate the new SW and start narration.
3. Verify the updated worker/helper are used offline, and unchanged models are
   not downloaded again. Test partial/offline update failure behavior.

Done: upgrade behavior is proven; shell and vendor changes are both covered by
appropriate guards. This remains separate from native-app heat diagnosis.

## P12: Measure and decide audio transport architecture

Dependency: P01/P02. Files: native Kokoro `infer`, worker `pcmFromBase64` and
WAV encoding, main-thread bridge and audio channel.

1. Measure base64 construction, bridge round trip, worker conversion, WAV
   encoding and playback preparation separately enough to identify material cost.
2. If material, prototype native temporary WAV-file output first. Compare it
   with native-owned playback only if needed. Keep the simplest validated path.
3. Bound file/cache lifetime and clean up cancelled, failed and completed clips.
   Reject stale generation results without deleting files used by new playback.
4. Check format fidelity, clip seams, speed, seeking, highlights, media controls,
   interruptions, app lock and offline behavior. Preserve original voice output.
5. Ship the experiment only after device evidence supports it; otherwise record
   a no-change decision. Do not replace playback just to mark this task coded.

Done: benchmark-backed decision and regression/device evidence.

## P13: Full verification and publication

Before publishing a scoped change, run applicable browser and contract checks:

```powershell
npm run test:browser
npm run test:performance
npm --prefix worker test
npm --prefix scraper ci
npm --prefix scraper test
node scraper/src/validate.js
node scraper/src/check-welcome.js
git diff --check
```

The scraper scripts may depend on their working directory. If either catalogue
command cannot locate its inputs, run `node src/validate.js` and
`node src/check-welcome.js` from `scraper/`, matching CI. Check JavaScript syntax
for changed scripts. After commit, run the cache guard against the actual PR
base, not blindly main for a dependent PR:

```powershell
node scripts/check-sw-cache.mjs origin/main
```

For a PR based on `codex/mobile-voice-efficiency`, use
`origin/codex/mobile-voice-efficiency` instead. Any shell change needs a new
`CACHE_NAME`. The guard compares committed changes; an uncommitted successful
result does not validate pending edits.

Create a `codex/` branch and PR with a concise problem/behavior description,
test evidence and explicit native limitations. Use `gh pr create --body-file`
for multiline text. Inspect `gh pr view` and `gh pr checks`; do not claim CI
passed before it finishes. Do not hide missing Mac/iPhone validation.

Final physical gate: repeated cold starts, three comparable 30-minute narration
runs, a 60-minute soak, long image sessions, large imports, lock/unlock and audio
interruptions. Require correct progress, bounded memory, no crashes in the
matrix, sustainable thermal behavior and repeatable energy improvement. Set
numerical targets after the baseline is measured, not retrospectively to fit
results. Retain baseline and candidate identifiers with the measurements.

## Handoff update format

At the end of each completed task, append a compact record here and update the
status ledger. Include:

```text
Task ID / date:
Commit and PR:
Behavior changed (or measured no-change decision):
Tests actually run and outcomes:
Device evidence, or explicitly not run:
Remaining risks/dependencies:
Next exact task and starting files:
```

Do not erase earlier evidence. Keep the handoff short and this plan as the
source of detail. No repeated whole-repository audit or speculative multi-agent
work is needed to resume a task with clear evidence and acceptance criteria.
