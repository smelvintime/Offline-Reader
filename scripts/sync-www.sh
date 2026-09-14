#!/usr/bin/env bash
# Native packaging copy — NOT a web build step.
#
# The web app is served from the repo root exactly as committed; Capacitor just
# needs a directory it can bundle into the native shells. This mirrors the app
# files into www/ (generated, gitignored) so `cap sync` has something to copy.
# Plain file copies only: if this script ever grows a transform step, the
# "zero build step" rule has been broken somewhere upstream.
#
# sw.js ships in the bundle even though reader.js never registers it on native
# (Platform.isNative gates registration) — keeping the file list identical to
# the web tree means nothing 404s and nothing forks between the two builds.
set -euo pipefail

cd "$(dirname "$0")/.."

# Start clean every time: a renamed or deleted source file must not linger in
# the bundle, and www/ is cheap to rebuild.
rm -rf www
mkdir www

cp index.html styles.css catalog.json manifest.json icon.svg jszip.min.js sw.js www/
# vendor/ carries the self-hosted natural-voice engine (§2.14) — without it the
# native app's Natural voice would silently fall back to the device engine.
cp -R css js fonts chapters icons vendor www/

echo "www/ refreshed ($(du -sh www | cut -f1))"

# The Natural voice's weights, if this build has them. They are gitignored and
# fetched on purpose (scripts/fetch-voice-model.mjs), and their absence is not
# an error — the runtime falls back to downloading on first use. It IS worth
# saying out loud, because on a phone that fallback is the difference between
# tapping Listen and waiting for 90 MB.
if [ -d www/vendor/tts/models ] && [ -d www/vendor/tts/voices ]; then
  echo "  natural voice: weights bundled ($(du -sh www/vendor/tts/models | cut -f1)) — the app will not download them"
else
  echo "  natural voice: NO weights bundled — the app will download ~90 MB on first use."
  echo "                 node scripts/fetch-voice-model.mjs   (then re-run this)"
fi
