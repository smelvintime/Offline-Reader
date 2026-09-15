# Building the native apps (Mac walkthrough)

This doc is the complete recipe for turning the repo into an installable iOS
app (and the Android equivalent). It assumes a Mac, an iPhone, and nothing else
pre-installed. Everything native is **generated** on your machine from what is
committed; if you can clone the repo and follow this page top to bottom, you
can always rebuild the app from scratch.

**The web app is untouched by all of this.** It still runs with zero build
step (`python3 -m http.server` from the repo root). The npm/Capacitor tooling
below exists only to wrap that same tree into native shells.

## What is committed vs. generated

| Committed (in git) | Generated (never committed — gitignored) |
|---|---|
| `package.json` + `package-lock.json` | `node_modules/` |
| `capacitor.config.json` | `www/` (made by `scripts/sync-www.sh`) |
| `scripts/sync-www.sh`, `scripts/apply-native-config.mjs` | `ios/` (made by `npx cap add ios`) |
| `native/or-zip/` — the one committed native plugin | `android/` (made by `npx cap add android`) |
| `assets/icon-1024.png` — icon master | icon/splash sets inside `ios/`/`android/` (made by `@capacitor/assets`) |

`ios/` and `android/` are disposable by design: delete them and regenerate
whenever they get into a weird state. The price of that disposability is a
short list of **manual steps you must re-apply after every regeneration** —
they are collected in [§ Re-apply after regeneration](#re-apply-after-every-regeneration)
and called out inline below.

The lockfile IS committed (reproducible native builds). If you ever change
`package.json`, run `npm install` and commit the updated `package-lock.json`
with it.

## 0. One-time Mac setup

1. **Xcode** from the Mac App Store — a current release (Capacitor 8 tracks
   recent Xcode; 16.4 or newer). Launch it once so it installs its components,
   then accept the license:

   ```bash
   xcode-select --install   # command line tools, if not already present
   sudo xcodebuild -license accept
   ```

2. **Node 22 or newer** (the Capacitor CLI refuses older):

   ```bash
   brew install node    # or use nvm; check with: node --version
   ```

3. **CocoaPods** (Capacitor's default iOS dependency manager — it is what
   fetches ZIPFoundation for the or-zip plugin):

   ```bash
   brew install cocoapods    # or: sudo gem install cocoapods
   ```

4. On the **iPhone**: Settings → Privacy & Security → **Developer Mode** → on
   (iOS 16+; it appears after the first deploy attempt if you don't see it),
   and Settings → Safari → Advanced → **Web Inspector** → on (you will want
   Safari's remote console for the on-device checks in PLAN.md §2.4).

Minimum OS floors: Capacitor 8 builds against a deployment target of iOS 15,
but the app's CSS (`:has()`, `color-mix()`) effectively wants iOS 16+ WebKit;
on Android the same features need Android 10+ with System WebView ≥ 111. Older
devices will run but degrade the theming.

## 1. Install dependencies

From the repo root:

```bash
npm install
```

This installs the Capacitor CLI/plugins and symlinks the committed local
plugin (`"or-zip": "file:native/or-zip"`) into `node_modules/`. No network
fetch happens for or-zip — it is your own checkout.

## 2. Choose the app id (once, before generating)

`capacitor.config.json` ships with the placeholder id `com.offlinereader.app`
(PLAN.md §11.1). If you want your own reverse-DNS id, **edit it now, before
`cap add`** — both generated projects derive their bundle id / application id
from it at generation time. Changing it later is easiest by deleting `ios/`
and `android/` and regenerating (they are disposable; re-apply the manual
steps after).

Free Apple IDs occasionally collide on bundle ids; if signing complains later,
pick something more unique here and regenerate.

## 3. Generate the iOS project

```bash
./scripts/sync-www.sh     # creates www/ — cap add refuses to run without it
npx cap add ios           # generates ios/, runs pod install
```

`pod install` is where the or-zip plugin's iOS dependency
(**ZIPFoundation**, `~> 0.9.19`, declared in `native/or-zip/OrZip.podspec`) is
fetched — the first run needs network. Android needs no equivalent fetch:
the plugin's Android side is `java.util.zip`, platform API.

Then do the first full sync:

```bash
npm run sync              # sync-www.sh && cap sync && apply-native-config.mjs
```

`cap sync` copies `www/` into the native project and wires up every plugin
(including or-zip: the Podfile entry `pod 'OrZip', :path =>
'../../node_modules/or-zip'` points through the symlink at `native/or-zip/`).

## 4. Icons and splash screens

iOS rejects SVG app icons, so the committed master `assets/icon-1024.png`
(rasterized from `icon.svg` on the `#0a0a0a` shell background) feeds
`@capacitor/assets`:

```bash
cp assets/icon-1024.png assets/logo.png
npx @capacitor/assets generate --ios \
  --iconBackgroundColor '#0a0a0a' --iconBackgroundColorDark '#0a0a0a' \
  --splashBackgroundColor '#0a0a0a' --splashBackgroundColorDark '#0a0a0a'
```

(`assets/logo.png` is a scratch copy the tool expects by name; it is
gitignored. Add `--android` — or run it again with just `--android` — once
that project exists.)

The generated icon/splash sets land **inside** `ios/`/`android/`, so this step
is on the re-apply list. The three committed PNGs in `icons/` are the web
PWA's manifest icons and have nothing to do with this step.

## 5. The `offlinereader://` URL scheme (iOS)

> **Applied for you by `npm run sync`.** `cap sync` never touches it, so
> `scripts/apply-native-config.mjs` runs straight after and puts it back. You
> only need the manual version below if you are curious what it wrote, or if
> the script refused because the key was already there in a shape it would not
> overwrite.

The importer's deep-link intake (PLAN.md §6.2, `Platform.onAppUrlOpen`)
needs the custom scheme registered in
`ios/App/App/Info.plist`, inside the top-level `<dict>`:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>com.offlinereader.app</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>offlinereader</string>
    </array>
  </dict>
</array>
```

(Equivalently in Xcode: App target → Info → URL Types → **+** → identifier
`com.offlinereader.app`, URL Schemes `offlinereader`.)

Test later by putting `offlinereader://add?url=https://example.com/some-novel`
in Notes and tapping it — the importer's confirm screen should open prefilled.
This is deliberately NOT an iOS share-sheet target; that needs a native Share
Extension and is an open user decision (PLAN.md §11.8).

## 6. Open, sign with a free Apple ID, run on the iPhone

```bash
npx cap open ios          # opens ios/App/App.xcworkspace in Xcode
```

In Xcode:

1. Xcode → Settings → **Accounts** → **+** → add your Apple ID. No paid
   developer program needed for personal installs.
2. Select the **App** project in the sidebar → **App** target → **Signing &
   Capabilities** → tick **Automatically manage signing** → Team: *Your Name
   (Personal Team)*. If it complains the bundle id is taken, change the id
   (see §2) and regenerate, or edit it in this pane.
3. Plug in the iPhone, pick it as the run destination in the toolbar, **⌘R**.
4. First launch is blocked until you trust yourself: on the iPhone,
   Settings → General → **VPN & Device Management** → your Apple ID → Trust.

Free-account limits, so they don't surprise you: apps signed this way stop
launching after **7 days** (rebuild/redeploy to renew — **reinstalling over
the existing app preserves all data**: the archive files, preferences, and
IndexedDB live in the app container, which survives updates and dies only on
delete), at most 3 sideloaded apps at a time, and a small weekly cap on new
app ids. The paid program removes all three.

## 7. The day-to-day loop

```bash
npm run sync    # after ANY edit to the web files or native/or-zip
```

(That also re-applies the native config edits of §5, §8.3 and §9 if a
regeneration dropped them. It prints a line per change and nothing at all when
there is nothing to do, so a quiet run means the projects were already right.)

then **⌘R** in Xcode. The native app runs a *copy* of the tree (`www/`), so a
stale bundle — not code — is the usual reason an edit "didn't take". Edits to
existing or-zip source files are picked up by the next Xcode build directly
(the pod references `native/or-zip/` in place through the symlink); *adding* a
new native file needs `npm run sync` to re-run `pod install`.

Sanity checks: `npx cap doctor` for the toolchain; in Safari's remote Web
Inspector console on the device, `window.Capacitor.Plugins.OrZip` must be
defined — if it is not, `cap sync` has not run since the plugin was added.

## 8. Android equivalent

1. Install **Android Studio** (current stable; first launch installs the SDK —
   accept SDK Platform 36 when the build asks; the bundled JDK 21 is fine).
2. Generate and sync:

   ```bash
   npx cap add android
   npm run sync
   cp assets/icon-1024.png assets/logo.png && npx @capacitor/assets generate --android \
     --iconBackgroundColor '#0a0a0a' --iconBackgroundColorDark '#0a0a0a' \
     --splashBackgroundColor '#0a0a0a' --splashBackgroundColorDark '#0a0a0a'
   ```

3. **Applied for you by `npm run sync`** (step 2 above already ran it): the
   `offlinereader://` intake needs a `VIEW` intent-filter in
   `android/app/src/main/AndroidManifest.xml`, inside the main `<activity>`
   element, alongside the existing LAUNCHER one. This is what gets written:

   ```xml
   <intent-filter>
       <action android:name="android.intent.action.VIEW" />
       <category android:name="android.intent.category.DEFAULT" />
       <category android:name="android.intent.category.BROWSABLE" />
       <data android:scheme="offlinereader" />
   </intent-filter>
   ```

4. `npx cap open android`, enable USB debugging on the device (Settings →
   About phone → tap Build number 7× → Developer options → USB debugging),
   pick it in the device dropdown, Run. Android needs no signing setup for
   debug builds.

or-zip on Android builds with zero extra dependencies: `cap sync` adds the
module (`include ':or-zip'` pointing at `node_modules/or-zip/android`) and it
compiles against `java.util.zip` from the platform.

## 9. The reader voice on native (ARCHITECTURE §2.14)

Nothing extra to generate — the pieces arrive mechanically — but three things
are worth knowing, and one is a manual iOS step:

- **The natural voice runs natively through `native/or-kokoro`.** A local
  Capacitor plugin over ONNX Runtime, loading the same
  `model_quantized.onnx` that `scripts/fetch-voice-model.mjs` already puts in
  the bundle. No extra download and no model conversion. `npm install` +
  `npm run sync` wires it like any plugin. Without it the natural voice still
  works, in WebAssembly, at a speed a real iPhone measured in minutes per
  paragraph.

- **The iPhone voice is `native/or-speech`.** A local Capacitor plugin over
  `AVSpeechSynthesizer`, wired like any other (`npm install` + `npm run sync`,
  no per-platform config) and carrying no third-party code. It is the default
  narrator on iOS because it starts instantly. Voice quality follows what the
  reader has installed: Settings → Accessibility → Spoken Content → Voices →
  English, then an **Enhanced** or **Premium** voice. With only the compact
  voice installed the app says so in the Voice sheet rather than sounding bad
  silently.

- **There is no `@capacitor-community/text-to-speech`.** Narration is Kokoro or
  The app's own `or-speech` replaced it. If the community plugin reappears in
  `package.json`, Xcode will warn about `AVSpeechSynthesizer` being
  non-`Sendable` in a `Sendable` class — a real warning, from a plugin this app
  does not use.

- **Background narration (applied for you).** For the voice (device or
  Natural) to keep reading with the screen locked, the app needs the audio
  background mode. `npm run sync` adds it via
  `scripts/apply-native-config.mjs`; this is what it writes into
  `ios/App/App/Info.plist`, inside the top-level `<dict>`:

  ```xml
  <key>UIBackgroundModes</key>
  <array>
    <string>audio</string>
  </array>
  ```

  (Equivalently in Xcode: App target → Signing & Capabilities → **+
  Capability** → Background Modes → check **Audio, AirPlay, and Picture in
  Picture**.) Without it, narration simply pauses on lock — nothing breaks,
  and nothing warns, which is why it is scripted rather than remembered.

- **Bundle the weights. This is the one native-only step that matters for the
  voice.** Run this once before your first `npm run sync`:

  ```bash
  node scripts/fetch-voice-model.mjs     # ~90 MB into vendor/tts/ (gitignored)
  ```

  Without it the app downloads the model on the device the first time someone
  enables the Natural voice. On the web that is a reasonable trade; in an
  installed app it is not — the reader who taps Listen on a train gets a
  progress bar, and on iOS that download lands in a WebView cache the OS may
  evict whenever it likes, so it is not a one-time cost either. `npm run sync`
  says which build you have:

  ```
    natural voice: weights bundled (86M) — the app will not download them
    natural voice: NO weights bundled — the app will download ~90 MB on first use.
  ```

- **App size.** `vendor/tts/` (the self-hosted Natural-voice engine, ~24 MB)
  ships inside `www/`, so the installed app grows by that much, plus the
  weights once bundled. The engine is compiled and run in the WebView, and
  reads the weights straight out of the bundle. On-device generation speed is
  the WASM path unless the WebView has WebGPU (recent Android System WebView has it;
  iOS from the first WebKit with WebGPU enabled in WKWebView).

## Re-apply after every regeneration

Deleting/regenerating `ios/` or `android/` (or `cap add` on a fresh clone)
loses the hand-edits those projects carry. Most of that is now automatic.

**`npm run sync` restores these** — it runs
`scripts/apply-native-config.mjs` after `cap sync`, which is idempotent, says
what it changed, and stays quiet when there is nothing to do:

- **iOS background audio** (`UIBackgroundModes`) — without it the reader
  voice pauses the moment the screen locks. Nothing errors and nothing warns,
  so a forgotten step looks exactly like a broken feature. That asymmetry is
  why this list shrank into a script.
- **iOS URL scheme** (`CFBundleURLTypes`) — §5.
- **Android intent-filter** (`VIEW` + `offlinereader`) — §8.3.

It never overwrites a value you put there yourself: an existing
`UIBackgroundModes` gains `audio` alongside whatever else is in it, existing
URL types gain a second entry rather than being replaced, and anything of an
unexpected shape stops the script with a message instead of being rewritten.

**Still yours to redo by hand:**

1. **Icons + splash** — §4 (`@capacitor/assets generate`). Needs the network
   and overwrites generated asset catalogues, so it stays an explicit step.
2. Any bundle-id change made in Xcode/Gradle instead of in
   `capacitor.config.json` (avoid that; see §2).

Everything else — plugins, or-zip, the web bundle, plugin config — is
restored mechanically by `npm install` + `npm run sync`.

## Troubleshooting

- **`cap add ios` says the web assets directory is missing** — run
  `./scripts/sync-www.sh` first; `www/` is generated, not committed.
- **`pod install` fails / ZIPFoundation not found** — CocoaPods missing or
  stale: `brew install cocoapods`, then `cd ios/App && pod install --repo-update`.
- **Node version error from the CLI** — Capacitor 8 requires Node ≥ 22.
- **Signing: "failed to register bundle identifier"** — the id is taken;
  pick another (§2).
- **App won't launch after a week** — the free-account cert expired; ⌘R from
  Xcode again. Data survives (§6).
- **`window.Capacitor.Plugins.OrZip` undefined on device** — `npm run sync`
  was skipped after `npm install`, or the Podfile/settings.gradle entry is
  from a stale generation: regenerate the platform dir.
- **Narration stops when the screen locks** — `UIBackgroundModes` is missing.
  Run `npm run native:config`; if it refuses, the key is there in a shape it
  will not overwrite, and §9 shows what it should look like.
- **Anything structurally weird in `ios/`/`android/`** — delete the directory,
  `npx cap add ios` (or `android`), re-apply the list above. That workflow is
  the design, not a workaround.

## Appendix: back gestures (a deliberate default)

The generated iOS project ships with WKWebView's
`allowsBackForwardNavigationGestures` at its default — **off** — and that
default is deliberate and load-bearing (PLAN7 §2.11-B; the user veto hook is
PLAN7 §12.2). Do not flip it on while poking around a regenerated `ios/`.

Why it stays off. The app is a same-document SPA: screens change via a
`data-screen` attribute, and browser history holds at most a one-entry
sentinel (catalogue.js). WKWebView animates edge-swipes against page
*snapshots*, and on same-document history every such animation is a stale
snapshot that then snaps to the real screen. That leaves two honest options:

- **Gestures on + sentinel routing** — honors "standard edge-swipe outside
  readers", but every swipe navigation in the native app animates a stale
  snapshot, the in-reader cancel becomes a visible slide-and-snap-back
  flicker in the core feel, and the behavior is device-timing-dependent —
  verifiable only on hardware.
- **Gestures off (the shipped default)** — readers are protected by
  construction and no snapshot artifact exists anywhere, but the native iOS
  app has **no edge-swipe back at all**: navigation outside readers is the
  header back/close buttons and the home buttons in both readers. (Safari
  and the installed PWA keep their edge-swipe — the history sentinel serves
  them.)

The shipped decision is the second: a stale-snapshot animation on every
navigation is a worse everyday feel than reaching for the header. Android is
unaffected either way — hardware/gesture back arrives as Capacitor's
`backButton` event and is dispatched per screen by `js/platform.js` (the
unified back table, ARCHITECTURE §2.2).

**Parked as future work, behind on-device verification:** a tiny native
plugin that toggles `allowsBackForwardNavigationGestures` per screen — on
for shell screens, off whenever `data-screen` enters a reader — which would
give the best of both. It only earns its keep if a device check shows the
mid-session toggle takes effect reliably and the shell-screen snapshot
artifact feels acceptable; until someone runs that check, it stays parked.
