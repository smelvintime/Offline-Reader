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
cp -R css js fonts chapters icons www/

echo "www/ refreshed ($(du -sh www | cut -f1))"
