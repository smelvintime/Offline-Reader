# or-zip

The only committed native code in this repo: a minimal Capacitor plugin that
lets the app index and read zip archives (CBZ sets) without ever pulling
archive bytes into the webview. Referenced from the root `package.json` as
`"or-zip": "file:native/or-zip"` and copied into the generated `ios/` /
`android/` projects by `cap sync` — the generated projects themselves stay
uncommitted (see `docs/mobile/NATIVE_BUILD.md`).

## API

Reached from app JS as `window.Capacitor.Plugins.OrZip` (only `js/platform.js`
may do so). Exactly two methods:

```js
OrZip.list({ path })
// → { entries: [{ name, size }] }
//   Central-directory read only — zero entry bytes enter the webview.

OrZip.extract({ path, entryNames, destDir })
// → { paths: [absolute paths, one per entry, in entryNames order] }
//   Streamed native extraction of just those entries into destDir.
```

`path` and `destDir` are absolute paths inside the app container (`file://`
URLs, as returned by `Filesystem.getUri`, are also accepted). The plugin
returns names, sizes and paths — never entry bytes.

## Guarantees

- **Containment.** Both path arguments are canonicalized and refused unless
  they resolve inside the app's own container.
- **Zip-slip.** Entry names come from arbitrary downloaded archives; every
  extraction target is canonicalized and prefix-checked against `destDir`
  before a byte is written. Entries that resolve outside it — and, on iOS,
  symlink entries — reject the call.
- **No other capabilities.** No permissions, no network, no reads outside the
  archive, no writes outside `destDir`.

## Implementation

- iOS: Swift, via [ZIPFoundation](https://github.com/weichsel/ZIPFoundation)
  (declared in `OrZip.podspec` for the default CocoaPods flow and in
  `Package.swift` for SPM projects). Per-entry random access + streaming
  extraction.
- Android: Java, via `java.util.zip.ZipFile` — platform API, no third-party
  dependency.
- `index.js` is a formality: the no-bundler app never imports it (see the
  comment in the file).
