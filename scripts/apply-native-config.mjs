#!/usr/bin/env node
// Re-apply the native project edits that `cap add` cannot know about.
//
// `ios/` and `android/` are disposable by design (docs/mobile/NATIVE_BUILD.md):
// delete and regenerate whenever they get strange. The price is a short list of
// hand-edits that regeneration wipes, and forgetting one is silent — nothing
// errors, a feature is just quietly gone. The worst of them is background
// audio: without it the reader voice stops the moment the screen locks, which
// reads like a bug in the voice rather than a missing capability.
//
// So the list stops being a list you remember and becomes this, run from
// `npm run sync`. Idempotent: it adds what is missing, leaves what is there,
// and says nothing when there is nothing to do.
//
//   node scripts/apply-native-config.mjs [--verbose]
//
// Exit 0 = the projects that exist are configured (or none exist yet).
// Exit 1 = a file is present but not in a shape this can safely edit.
//
// Node only, no dependencies: Capacitor 8 already requires Node ≥ 22, so this
// adds nothing to the toolchain. Not PlistBuddy — that is macOS-only, and this
// has to be testable on the machine the repo is developed on.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');

const IOS_PLIST = resolve(root, 'ios/App/App/Info.plist');
const ANDROID_MANIFEST = resolve(root, 'android/app/src/main/AndroidManifest.xml');

const URL_SCHEME = 'offlinereader';

const changes = [];
const notes = [];

function fail(msg) {
  console.error('apply-native-config: ' + msg);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal plist structure reader.
//
// Only one question is ever asked: what are the keys of the ROOT dict, and
// where does each one's value start and end? A regex cannot answer that —
// UIApplicationSceneManifest nests <key> elements several levels down and a
// naive search finds those too — so tags are walked with a depth counter.
// ─────────────────────────────────────────────────────────────────────────────

const CONTAINER_OPEN = /^(dict|array)$/;

/** → Map<keyName, { valueStart, valueEnd }> for the root <dict>'s own keys. */
function rootDictKeys(text) {
  const plistAt = text.indexOf('<plist');
  if (plistAt === -1) return null;
  const rootAt = text.indexOf('<dict>', plistAt);
  if (rootAt === -1) return null;

  const tag = /<(\/?)([A-Za-z]+)([^>]*?)(\/?)>/g;
  tag.lastIndex = rootAt + '<dict>'.length;

  const keys = new Map();
  let depth = 1;          // we are inside the root dict
  let pendingKey = null;  // a <key> at depth 1 awaiting its value element
  let m;

  while ((m = tag.exec(text))) {
    const [full, closing, name, , selfClosing] = m;

    if (closing) {
      depth--;
      if (depth === 0) break;           // root dict closed
      continue;
    }

    // A value element that belongs to a depth-1 key: record its span. This is
    // read BEFORE the depth bump so a <dict>/<array> value is caught too.
    if (depth === 1 && pendingKey && name !== 'key') {
      const start = m.index;
      let end;
      if (selfClosing) {
        end = m.index + full.length;    // <true/>, <false/>
      } else {
        end = matchingClose(text, name, tag.lastIndex);
        if (end === -1) return null;
      }
      keys.set(pendingKey, { valueStart: start, valueEnd: end });
      pendingKey = null;
      if (!selfClosing) tag.lastIndex = end;   // skip the whole value subtree
      continue;
    }

    if (selfClosing) continue;          // depth-neutral

    if (name === 'key') {
      const close = text.indexOf('</key>', tag.lastIndex);
      if (close === -1) return null;
      if (depth === 1) pendingKey = text.slice(tag.lastIndex, close);
      tag.lastIndex = close + '</key>'.length;
      continue;
    }

    if (CONTAINER_OPEN.test(name)) depth++;
  }

  return keys;
}

/** Index just past the `</name>` that closes an element opened before `from`. */
function matchingClose(text, name, from) {
  const tag = new RegExp('<(/?)' + name + '(?:[^>]*?)(/?)>', 'g');
  tag.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = tag.exec(text))) {
    if (m[2]) continue;                 // self-closing: opens and closes
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/** The indent used by the root dict's own keys, so insertions match the file. */
function rootIndent(text) {
  const m = /\n([ \t]+)<key>/.exec(text);
  return m ? m[1] : '\t';
}

function insertIntoRootDict(text, block) {
  const plistAt = text.indexOf('<plist');
  const rootAt = text.indexOf('<dict>', plistAt);
  const after = rootAt + '<dict>'.length;
  return text.slice(0, after) + '\n' + block + text.slice(after);
}

// ─────────────────────────────────────────────────────────────────────────────
// iOS
// ─────────────────────────────────────────────────────────────────────────────

function applyIos() {
  if (!existsSync(IOS_PLIST)) {
    notes.push('ios/ not generated yet — skipped (npx cap add ios)');
    return;
  }

  let text = readFileSync(IOS_PLIST, 'utf8');
  const ind = rootIndent(text);

  let keys = rootDictKeys(text);
  if (!keys) fail(IOS_PLIST + ' could not be parsed as a plist. Not touching it.');

  // ── Background audio (ARCHITECTURE §2.14) ─────────────────────────────────
  // Without this the reader voice pauses on lock. Nothing errors; the feature
  // is just absent, which is the most expensive kind of missing step.
  const bg = keys.get('UIBackgroundModes');
  if (!bg) {
    text = insertIntoRootDict(text, [
      ind + '<key>UIBackgroundModes</key>',
      ind + '<array>',
      ind + '\t<string>audio</string>',
      ind + '</array>',
    ].join('\n'));
    changes.push('iOS: added UIBackgroundModes = [audio] (lock-screen narration)');
  } else {
    const value = text.slice(bg.valueStart, bg.valueEnd);
    // Type before content. A bare <string>audio</string> here CONTAINS the text
    // we search for while being the wrong shape entirely — iOS wants an array,
    // and reporting that as configured would be the exact silent miss this
    // script exists to prevent.
    if (!value.startsWith('<array')) {
      fail('UIBackgroundModes exists in Info.plist but is not an array. Fix it by hand.');
    }
    if (/<string>\s*audio\s*<\/string>/.test(value)) {
      if (verbose) notes.push('iOS: UIBackgroundModes already has audio');
    } else if (/^<array\s*\/>/.test(value)) {
      text = text.slice(0, bg.valueStart)
        + [ '<array>', ind + '\t<string>audio</string>', ind + '</array>' ].join('\n')
        + text.slice(bg.valueEnd);
      changes.push('iOS: added audio to the empty UIBackgroundModes array');
    } else if (value.startsWith('<array>')) {
      const at = bg.valueStart + '<array>'.length;
      text = text.slice(0, at) + '\n' + ind + '\t<string>audio</string>' + text.slice(at);
      changes.push('iOS: added audio to the existing UIBackgroundModes array');
    }
  }

  // ── offlinereader:// URL scheme (PLAN.md §6.2) ────────────────────────────
  // Re-read: every branch above may have inserted text, and a recorded span
  // into the OLD string points somewhere arbitrary in the new one.
  keys = rootDictKeys(text);
  if (!keys) fail(IOS_PLIST + ' stopped parsing after the first edit. Not continuing.');
  const urlTypes = keys.get('CFBundleURLTypes');
  if (!urlTypes) {
    text = insertIntoRootDict(text, [
      ind + '<key>CFBundleURLTypes</key>',
      ind + '<array>',
      ind + '\t<dict>',
      ind + '\t\t<key>CFBundleURLName</key>',
      ind + '\t\t<string>' + appId() + '</string>',
      ind + '\t\t<key>CFBundleURLSchemes</key>',
      ind + '\t\t<array>',
      ind + '\t\t\t<string>' + URL_SCHEME + '</string>',
      ind + '\t\t</array>',
      ind + '\t</dict>',
      ind + '</array>',
    ].join('\n'));
    changes.push('iOS: added the ' + URL_SCHEME + ':// URL scheme (deep-link import)');
  } else {
    const value = text.slice(urlTypes.valueStart, urlTypes.valueEnd);
    if (!value.startsWith('<array')) {
      fail('CFBundleURLTypes exists but is not an array. Add the ' + URL_SCHEME + ' scheme by hand.');
    }
    if (value.includes('<string>' + URL_SCHEME + '</string>')) {
      if (verbose) notes.push('iOS: ' + URL_SCHEME + ':// scheme already registered');
    } else if (/^<array\s*\/>/.test(value)) {
      text = text.slice(0, urlTypes.valueStart) + [
        '<array>',
        ind + '\t<dict>',
        ind + '\t\t<key>CFBundleURLName</key>',
        ind + '\t\t<string>' + appId() + '</string>',
        ind + '\t\t<key>CFBundleURLSchemes</key>',
        ind + '\t\t<array>',
        ind + '\t\t\t<string>' + URL_SCHEME + '</string>',
        ind + '\t\t</array>',
        ind + '\t</dict>',
        ind + '</array>',
      ].join('\n') + text.slice(urlTypes.valueEnd);
      changes.push('iOS: added the ' + URL_SCHEME + ':// scheme to the empty URL types array');
    } else {
      // Someone else's URL types are here. Adding a second entry is safe;
      // rewriting theirs is not.
      const at = urlTypes.valueStart + '<array>'.length;
      text = text.slice(0, at) + '\n' + [
        ind + '\t<dict>',
        ind + '\t\t<key>CFBundleURLName</key>',
        ind + '\t\t<string>' + appId() + '</string>',
        ind + '\t\t<key>CFBundleURLSchemes</key>',
        ind + '\t\t<array>',
        ind + '\t\t\t<string>' + URL_SCHEME + '</string>',
        ind + '\t\t</array>',
        ind + '\t</dict>',
      ].join('\n') + text.slice(at);
      changes.push('iOS: added the ' + URL_SCHEME + ':// scheme alongside the existing URL types');
    }
  }

  writeIfChanged(IOS_PLIST, text);
}

let cachedAppId = null;
function appId() {
  if (cachedAppId) return cachedAppId;
  try {
    const cfg = JSON.parse(readFileSync(resolve(root, 'capacitor.config.json'), 'utf8'));
    cachedAppId = cfg.appId || 'com.offlinereader.app';
  } catch (e) {
    cachedAppId = 'com.offlinereader.app';
  }
  return cachedAppId;
}

// ─────────────────────────────────────────────────────────────────────────────
// Android
// ─────────────────────────────────────────────────────────────────────────────

function applyAndroid() {
  if (!existsSync(ANDROID_MANIFEST)) {
    notes.push('android/ not generated yet — skipped (npx cap add android)');
    return;
  }

  const text = readFileSync(ANDROID_MANIFEST, 'utf8');

  if (text.includes('android:scheme="' + URL_SCHEME + '"')) {
    if (verbose) notes.push('Android: ' + URL_SCHEME + ':// intent-filter already present');
    return;
  }

  // Anchor on the LAUNCHER filter's own </intent-filter>: the new filter is a
  // sibling of it, inside the same <activity>, and matching its indentation
  // keeps the file looking generated rather than patched.
  const launcher = text.indexOf('android.intent.category.LAUNCHER');
  if (launcher === -1) fail(ANDROID_MANIFEST + ' has no LAUNCHER intent-filter. Not touching it.');
  const close = text.indexOf('</intent-filter>', launcher);
  if (close === -1) fail(ANDROID_MANIFEST + ' has an unterminated intent-filter. Not touching it.');
  const after = close + '</intent-filter>'.length;

  const lineStart = text.lastIndexOf('\n', close) + 1;
  const ind = /^[ \t]*/.exec(text.slice(lineStart))[0];

  const block = '\n\n' + [
    ind + '<intent-filter>',
    ind + '    <action android:name="android.intent.action.VIEW" />',
    ind + '    <category android:name="android.intent.category.DEFAULT" />',
    ind + '    <category android:name="android.intent.category.BROWSABLE" />',
    ind + '    <data android:scheme="' + URL_SCHEME + '" />',
    ind + '</intent-filter>',
  ].join('\n');

  writeIfChanged(ANDROID_MANIFEST, text.slice(0, after) + block + text.slice(after));
  changes.push('Android: added the ' + URL_SCHEME + ':// VIEW intent-filter (deep-link import)');
}

function writeIfChanged(path, next) {
  if (readFileSync(path, 'utf8') === next) return;
  writeFileSync(path, next);
}

// ─────────────────────────────────────────────────────────────────────────────

applyIos();
applyAndroid();

if (changes.length) {
  console.log('apply-native-config:');
  for (const c of changes) console.log('  + ' + c);
  console.log('  (rebuild in Xcode / Android Studio for these to take effect)');
} else if (verbose) {
  console.log('apply-native-config: nothing to do');
}
for (const n of notes) console.log('apply-native-config: ' + n);
