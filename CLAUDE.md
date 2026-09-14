# Working in this repo

## How to write replies

**Anything the user has to do goes under its own heading.** If a reply contains
a step for them (run a command, tap something on the phone, check a console,
make a decision), it gets a clearly marked section of its own, near the end,
so it is findable at a glance instead of buried in prose. A reply with nothing
for them to do should say so rather than leave them hunting.

Use `## What you need to do` (or `## Your turn`, `## Decision needed` when
that fits better). One heading per reply, not one per step.

No em dashes anywhere in replies.

## Things that bite

Learned the hard way; each of these has cost a cycle at least once.

- **Changing a precached shell asset means bumping `CACHE_NAME` in `sw.js`.**
  The shell is served cache-first, so without the bump the change reaches
  nobody who has already opened the app. CI enforces it
  (`scripts/check-sw-cache.mjs`), and the failure is late and confusing.

- **The natural voice needs `node scripts/fetch-voice-model.mjs` before
  `npm run sync`.** The weights are gitignored, so it is per-machine, not
  per-clone. `npm run sync` prints which build you have.

- **`ios/` and `android/` are disposable.** Delete and regenerate freely;
  `npm run sync` re-applies the Info.plist and manifest edits through
  `scripts/apply-native-config.mjs`. Icons are the one step still manual.

- **The tests are browser pages, not a CLI.** `test/*.test.html` are driven
  with Playwright against a local static server. There is no `npm test` at the
  repo root; the worker and scraper have their own.

- **Capacitor serves the native app over a custom URL scheme.** A scheme
  handler only answers the request types it implements, so prefer `GET` over
  `HEAD` for anything the app probes for. The WebView is also **not**
  cross-origin isolated, which is why `SharedArrayBuffer` is unavailable there.
