# Prepare on my computer: plan

Status: groundwork done on branch `claude/mac-prepare` (see "Already done").
The app side is not built. This page is written to be handed to a fresh
session: it says what exists, what to build, in what order, and how to know
it works.

Read first: `CLAUDE.md` (repo rules, including the CACHE_NAME rule and that
tests are browser pages), `docs/PREPARED_BOOKS_PLAN.md` (why prepared books
exist), and the "Prepared books" paragraphs of `docs/ARCHITECTURE.md` §2.14.

## Goal

Preparing a book on the iPhone takes about 10 minutes per chapter and heats
the phone. The owner's Mac is an M4. Let the app hand the rendering to the
Mac over home Wi-Fi: the phone sends text, the Mac renders it with the same
Kokoro model and voice, the phone stores the result exactly as if it had made
it. Listening does not change at all.

Hard requirements, unchanged from the prepared-books work:

- Playback never runs the model, and never uses the iPhone voice.
- A book plays only once every chapter is prepared (`bookFullyPrepared`).
- Same voice and same audio quality as preparing on the phone.

## How it fits the existing code

Preparing is `preparer.run()` in `js/novel-voice.js`. Per chapter it builds
the group plan (`preparedPlan`), and per group it:

1. computes the key (`preparedClipKey`), skips the group if
   `preparedStore.getClip(key)` already has it (this is what makes resume work);
2. renders: `neuralEngine.ensureReady()` then `neuralEngine.generate(...)`
   returns a blob URL of a 16-bit 24 kHz WAV, read back with `fetch(url)`;
3. stores: through `nativeClips()` (`Platform.kokoro.clips.save`, AAC on disk)
   when the native plugin has it, else the WAV blob in IndexedDB;
4. records `seconds`/`bytes`, and writes a chapter record when every group is in.

**Only step 2 changes.** The Mac returns the same WAV bytes, so steps 1, 3
and 4, playback, the Settings "Prepared audio" list and deletion all work
unchanged. The phone then does almost nothing: send text, receive a file,
compress it with the hardware AAC encoder (`saveClip`), write it.

## Already done (branch `claude/mac-prepare`)

- **`voice-server/`**, a standalone Node package (own `package.json`, own
  lockfile, `kokoro-js@1.2.1`, the version vendored in `vendor/tts/`):
  - `server.mjs`: `createVoiceServer({ code, engine, log })` and a CLI
    (`npm start`, flags `--port` (default 8787), `--code`, `--dtype` (default fp32)).
  - `GET /status` returns `{ ok, version: 1, ready, error, info, rendered }`.
  - `POST /render` takes JSON `{ text, voice }` and returns `audio/wav`,
    with headers `x-seconds` and `x-render-ms`.
  - Every request needs header `x-voice-code` (six digits, printed at
    start); a wrong code gets 401.
  - Input limits: voice must match `/^[a-z]{2}_[a-z]+$/`; text 1 to 4000
    characters; body at most 64 KB.
  - Renders run one at a time in arrival order. 503 while the model is still
    loading, or if it failed to load (the reason is in `/status`).
  - CORS `*`, `Access-Control-Allow-Private-Network`, CORP `cross-origin`.
  - `trimSilence` and `encodeWav` are copies of the ones in
    `js/novel-voice-worker.js`, so clips match the phone's.
  - `test/server.test.mjs`: 6 node:test cases on a fake engine, no install
    needed. CI runs them (`.github/workflows/ci.yml`, "Voice server tests").
  - NOT yet verified against the real model. The sandbox it was written in
    could not reach Hugging Face. See step 6.
- **`scripts/apply-native-config.mjs`**: adds `NSLocalNetworkUsageDescription`
  and `NSAppTransportSecurity → NSAllowsLocalNetworking = true` to the iOS
  Info.plist. These are needed for http to a LAN address and for iOS's
  local-network permission prompt. Idempotent; it keeps existing ATS keys.
  Checked against synthetic plists, not yet on a real `ios/` project.
- **`Platform.localHttp(url, { method, headers, json, binary, timeoutMs })`**
  in `js/platform.js` resolves to `{ status, headers (lower-cased), data }`.
  - Native goes through `Capacitor.Plugins.CapacitorHttp.request`. A fetch
    from `capacitor://localhost` to `http://192.168…` can be blocked as mixed
    content; the native request only answers to ATS.
  - In a browser it falls back to `fetch` with a timeout.
  - When `binary`, `data` is an ArrayBuffer: native returns base64, which is
    decoded. Unused so far.
- `sw.js` `CACHE_NAME` bumped to v5.73 (platform.js is a shell asset). Open
  PRs #101 and #102 also bump to v5.73. Before merging, re-bump to one above
  whatever `main` has (`node scripts/check-sw-cache.mjs` checks).

## To build

### 1. Talking to the Mac (`js/novel-voice.js`)

- Prefs `voice.remoteUrl` and `voice.remoteCode`, read/written with the
  existing `prefGet`/`prefSet`.
- `remoteBase(input)`: trim; add `http://` if there is no scheme; add
  `:8787` if there is no port; drop a trailing `/`. So "192.168.1.20" becomes
  "http://192.168.1.20:8787".
- `remoteStatus(remote)`: `Platform.localHttp(base + '/status', { headers: { 'x-voice-code': code }, timeoutMs: 8000 })`.
- `remoteRender(remote, text, voice)`: POST `/render` with `json: { text, voice }`,
  `binary: true` and a long timeout (120 s). Returns
  `{ blob: new Blob([data], { type: 'audio/wav' }), seconds: Number(headers['x-seconds']) }`.
- Map failures to sentences people can act on:
  - network error or timeout → "Could not reach your computer at ADDRESS.
    Check that voice-server is running and both are on the same Wi-Fi.";
  - 401 → "The code does not match. Use the one voice-server printed.";
  - 503 → the server's `error` text;
  - anything else → status and `error`.

### 2. The preparer (`preparer` in `js/novel-voice.js`)

- `request({ remote })` and `start({ remote })`; keep `this.remote`
  (`null` means on the phone).
- For remote: skip the unplugged "are you sure?" confirm (the phone is not
  working hard) and skip `neuralCapability()`. Keep the `neuralSpeaks(docLang())`
  English check. Keep `channel.bless` inside the tap and the silent
  keep-alive loop, because the app must stay alive to receive files.
- In `run()`, for remote:
  - call `remoteStatus` first and throw the mapped error if unreachable;
  - if `ready: false`, poll every 3 s (stop if the run is cancelled),
    showing "Your computer is loading the voice (the first time downloads
    about 330 MB)…";
  - never call `neuralEngine.ensureReady()`;
  - skip `waitCool()`, since phone heat is irrelevant here.
- Factor step 2 into `renderPart(text)`. Local mode is today's
  generate → fetch → cache cleanup; remote mode is `remoteRender`. Both
  return `{ blob, seconds }`, and the existing store code takes it from there.
- Keep the Mac busy: in remote mode, when starting part `gi`, also start
  part `gi + 1` (check `getClip` first, so a resume does not re-render a
  stored part). At most 2 requests in flight. Attach `.catch(() => {})` to
  the look-ahead promise so a failure there is not an unhandled rejection;
  the real await surfaces it. Don't look ahead across chapters.
- Errors mid-run: stop with the mapped message (`this.message`). Stored
  parts stay, and Prepare again resumes. No automatic fall back to the
  phone: the owner chose the Mac because the phone runs hot.
- `rendered` / `renderMs` already drive the time-left estimate (PR #102).
  Keep counting the same way; for remote it includes network time, which
  is what the person waits on.

### 3. UI (`buildSheet` → "Listen without heat" row)

- Under **Prepare this book**, a second button **Prepare on my computer**,
  and a small form with **Computer address** and **Code** inputs (plain
  `<input>`s built with `el()`, saved on `change`).
- Show the form only where it can work: `isNativeApp()` or
  `location.protocol === 'http:'`. The https web build cannot call http on the LAN.
- While preparing remotely, start the progress line with
  "On your computer:" (`preparerLine()`, added in PR #102; if #102 is
  not merged yet, merge it into this branch first).
- Errors show in the same status line the phone path uses.

### 4. Diagnostics

`preparedDiagnostics()` gains `source: 'phone' | 'computer'` and the remote
address (not the code). `msPerPart` (PR #102) then shows the speed difference
directly.

### 5. Tests (`test/novel-voice.test.html`)

A new `testPreparedOnComputer` in `T.all()`. Stub `window.Platform.localHttp`
with a fake server: `/status` ready, and `/render` returns a small WAV made
with `VT().encodeWav`. Assert:

- the whole fixture book gets prepared;
- the local engine is never loaded: wrap `neuralEngine.ensureReady` and
  count calls, as `testPreparedBook` does;
- `neuralStub.spoken` stays empty;
- no charging confirm is asked;
- each render request carries `x-voice-code` and the expected voice;
- never more than 2 renders in flight, and at least once 2 overlap;
- a second run renders nothing (resume);
- 401 → the "code does not match" message;
- a rejected request → the "could not reach" message;
- `ready: false` then `true` → waits, then prepares.

Follow the file's existing pattern: `freshOpen({ preparedOnly: true })`,
restore `window.Platform` in `finally`. Run everything with
`npm run test:browser`. Chromium may need `executablePath` pointed at an
installed browser if Playwright's own is missing.

Also add a `test/platform.test.html` case for `localHttp`'s fetch fallback,
if that page's harness makes it easy.

### 6. The real model, in CI

Add a job (in `ci.yml` or its own workflow) that runs when `voice-server/**`
changes:

- `npm ci` in `voice-server`;
- cache transformers.js's model cache directory;
- start `node server.mjs --port 8787 --code 123456 --dtype q8`;
- poll `/status` until ready (timeout about 10 minutes);
- POST one English sentence and assert a WAV of 0.5 to 10 seconds.

This is the first time the server meets the real model; fix whatever it
finds. Expect to check `kokoro-js` in Node: the `device: 'cpu'` option,
the shape of `RawAudio` (`.audio` vs `.data`), and the voice names.

### 7. Docs

- `voice-server/README.md`, for the Mac:
  - install Node 22 or newer (`brew install node`);
  - `cd voice-server && npm install` once;
  - `caffeinate -i npm start` each time (keeps the Mac awake);
  - allow incoming connections when macOS asks;
  - type the printed address and code into the app;
  - the first start downloads about 330 MB to a cache.
- `docs/ARCHITECTURE.md` §2.14: a paragraph on preparing on a computer.
- `docs/PREPARED_BOOKS_PLAN.md` "Built so far": a bullet.
- `docs/mobile/NATIVE_BUILD.md`: mention the two new Info.plist keys under
  "Re-apply after every regeneration" (applied by `npm run sync`).
- Bump `CACHE_NAME` (see "Already done").

### 8. On the phone (needs the owner)

1. Rebuild with Xcode (`npm run sync` applies the new plist keys).
2. On the Mac: `cd voice-server && caffeinate -i npm start`.
3. In the app: open a book, voice sheet, **Prepare on my computer**, then
   enter the address and code.
4. iOS asks to find devices on the local network: **Allow**. If it was
   refused: Settings → Privacy & Security → Local Network → Offline Reader.
5. Watch `msPerPart` in Voice diagnostics, and listen: it should sound the
   same as phone-prepared audio.

## Risks to check early

- **`CapacitorHttp` availability.** It should be callable as
  `window.Capacitor.Plugins.CapacitorHttp` without setting
  `plugins.CapacitorHttp.enabled` (which would patch every fetch; do not
  set it). Confirm on the device first. If it is missing, `localHttp` falls
  back to fetch, which may hit mixed-content blocking.
- **Binary responses.** Confirm `responseType: 'arraybuffer'` comes back as
  base64 on iOS in Capacitor 8.
- **Sound parity.** The phone's native path uses fp32 with its own
  tokenizer (`js/voice-native-tokenizer.mjs`); the server uses kokoro-js
  fp32 end to end. Both are the same model and voices, so they should match,
  but verify by ear. The clip key does not include the renderer, so a book
  can mix phone and Mac parts.
- The Mac sleeping, or its address changing (DHCP), mid-book: the error
  message plus resume cover both.

## Out of scope here (still open from the prepared-books plan)

Resuming preparation by itself after the app is closed, a prompt when the
voice changes, a native audio player, and the overnight `BGProcessingTask`.
