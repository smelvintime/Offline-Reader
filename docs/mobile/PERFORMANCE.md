# Mobile performance implementation and device validation

Baseline: PR #63, commit 2443b0e. Reported device: iPhone 15 Pro,
native app installed from Xcode with Command-R. Symptoms occur while starting
and playing Natural voices, including Michael. Apple device speech is a
separate comparison, not a silent replacement for the selected narrator.

## Voice changes

- Native preparation uses Kokoro's public constructor and a schema-checked
  character tokenizer. It never creates the disposable browser ONNX session.
  The browser keeps its existing inference path. The adapter is checked against
  the pinned vendor tokenizer, including truncation and non-vocabulary input.
- Native phones do not prewarm on book open. Pause schedules release after at
  most 30 seconds (15 seconds for mid memory, immediately for low memory).
- Generation is bounded to four pending jobs; audio cache targets 16 MiB and
  32 clips. Current/in-flight audio is protected during eviction.
- Thermal pressure throttles Natural voice; it does not stop it. Serious and
  critical readings disable lookahead and the startup prebuffer, so generation
  runs one group at a time and playback continues. Pausing on heat was removed
  after a device report: a phone that sits at serious while held, hotter still
  on a charger, never reaches the cooled state the resume waited for, so the
  narrator simply stopped working. Low Power Mode and fair thermal state use
  the same next-clip-only scheduling. Memory warnings are a separate signal and
  still release the engine, since the process is about to be killed rather than
  slowed. Intentional locked-screen listening is preserved.
- Disposal invalidates startup and late audio results. Timeouts reset the
  engine instead of leaving retries behind stalled work. The native queue
  rejects invalidated requests before starting another forward pass.
- Voice settings include a bounded diagnostics report: source/build identity,
  actual backend/weights, startup and generation timings, queue/cache size,
  power/thermal signals. No book text or PCM is included. Native sync stamps
  `www/build-info.json` with commit, dirty flag, and build time.
- The application worker is versioned with the shell and explicitly preferred
  over a legacy copy in the persistent vendor cache. Model weights stay cached.

## Automated verification

Run `npm ci`, `npx playwright install chromium`, `npm run test:browser`, and
`npm run test:performance`. Browser suites cover voice lifecycle, the actual
worker preparation path with a fake native PCM bridge, novel reading,
importing, platform behavior and image zoom. They are not native inference or
battery measurements. CI also runs the existing worker/scraper/catalogue checks.

The native adapter test uses the upstream Kokoro tokenizer fixtures from
https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX
(Apache-2.0 model resources). It changes only an in-memory copy of the vendor
exports to compare tokenization; shipped vendor code is unchanged.

## On the Mac and iPhone

1. Record a baseline from PR #63 before replacing the installed build if
   practical. Use the same chapter, Michael, playback rate, brightness,
   connectivity, and ambient conditions. Unplug the phone for battery runs.
2. Check out the PR to test. Run `npm ci`,
   `node scripts/fetch-voice-model.mjs`, then `npm run sync`. Keep the existing
   model packaging until native device validation confirms the new path.
3. Build and run from Xcode. In voice settings, open **Voice diagnostics**.
   Confirm the source commit, native provider and weights. A dirty build is
   labeled; do not compare it as though it were an exact release commit.
4. Use Instruments Time Profiler and Allocations/VM tracking, plus Xcode's
   available energy diagnostics. Capture process termination or memory logs
   if the app closes. Record both native and WebView memory where available.
5. Repeat cold starts; 30-minute Michael playback; another Natural voice;
   Apple device speech; and a longer 60-minute soak. Separately test rapid
   start/stop, voice switching, chapter changes, pause longer than 30 seconds,
   lock/unlock, audio interruptions, Low Power Mode, and offline use.
6. Verify the same sentence resumes, no stale clip plays after switching, and
   memory reaches a plateau across repeated cycles. Severe thermal conditions
   should stop new synthesis and explain the pause. Do not artificially heat
   the phone to trigger a test; use injected signal tests for policy branches.

Record results in this table for baseline and candidate, using at least three
comparable runs for startup and sustained comparisons:

| Measurement | PR #63 | Candidate | Notes |
| --- | --- | --- | --- |
| Installed commit/build | | | |
| Backend / weights / voice / rate | | | |
| Cold time to first audio | | | |
| Startup peak memory (native/WebView) | | | |
| Sustained CPU / generation ratio | | | |
| Thermal transitions and time | | | |
| Battery change over fixed duration | | | |
| Playback gaps / failures | | | |
| Post-pause/release memory plateau | | | |

## Measurement-dependent work, not yet proven

The Windows development host cannot build the iOS target or profile the
iPhone. Native compilation and the table above are release gates, not implied
by passing browser tests. No battery percentage improvement is claimed.

Do not change CPU thread count, model precision or acceleration defaults until
the measurements select a sustainable configuration. Compare a small matrix
of thread counts and group sizes with the current fp32 CPU path; record startup,
energy, memory and audio continuity. Core ML previously had shape-compilation
and graph-partition costs and must not be re-enabled on assumption alone.

Bridge diagnostics record the complete native round trip, which includes
inference and session creation; subtracting inference time is only an estimate
of overhead. If profiling identifies copies as material, compare temporary
WAV-file transfer with native playback. Keep existing playback until the new
path proves lock-screen controls, interruptions, rate changes, highlighting,
offline operation and temporary-file cleanup.
