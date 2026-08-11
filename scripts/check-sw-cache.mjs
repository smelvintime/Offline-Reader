#!/usr/bin/env node
// Fail if a precached shell asset changed without bumping the service worker's
// CACHE_NAME.
//
// The shell is served cache-first and `activate` only deletes caches whose name
// differs, so shipping new css/js under an unchanged CACHE_NAME leaves every
// browser that has already opened the app on the old files — permanently. It is
// invisible in review (the diff is correct), invisible in tests (they load from
// disk, not the SW), and only shows up as "you didn't fix it" from a reader.
// That has happened; hence this check.
//
//   node scripts/check-sw-cache.mjs [baseRef]     # default: origin/main
//
// Exit 0 = fine, 1 = a bump is missing.

import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';

const base = process.argv[2] || 'origin/main';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function cacheNameFrom(text) {
  const m = /const\s+CACHE_NAME\s*=\s*['"]([^'"]+)['"]/.exec(text);
  return m ? m[1] : null;
}

/** The precached list, read from the file rather than duplicated here. */
function shellAssetsFrom(text) {
  const block = /const\s+SHELL_ASSETS\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!block) return [];
  return [...block[1].matchAll(/['"]\.\/([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter(Boolean);
}

let changed;
try {
  changed = git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean);
} catch (e) {
  console.error(`check-sw-cache: cannot diff against ${base} — ${e.message.split('\n')[0]}`);
  console.error('check-sw-cache: skipping (nothing to compare against)');
  process.exit(0);
}

if (!changed.length) {
  console.log('check-sw-cache: no changes against ' + base);
  process.exit(0);
}

const head = readFileSync('sw.js', 'utf8');
const assets = shellAssetsFrom(head);
if (!assets.length) {
  console.error('check-sw-cache: could not parse SHELL_ASSETS from sw.js');
  process.exit(1);
}

// index.html and manifest.json are in the list too; './' is not a real path.
const touched = changed.filter((f) => assets.includes(f));
if (!touched.length) {
  console.log(`check-sw-cache: OK — no precached shell asset changed (${changed.length} file(s) in diff)`);
  process.exit(0);
}

let baseSw = '';
try {
  baseSw = git(['show', `${base}:sw.js`]);
} catch (e) {
  console.error('check-sw-cache: cannot read sw.js at ' + base + ' — treating as new file');
}

const headName = cacheNameFrom(head);
const baseName = baseSw ? cacheNameFrom(baseSw) : null;

if (!headName) {
  console.error('check-sw-cache: could not parse CACHE_NAME from sw.js');
  process.exit(1);
}

if (baseName && headName === baseName) {
  console.error('');
  console.error('check-sw-cache: FAILED — precached shell assets changed but CACHE_NAME did not.');
  console.error(`  CACHE_NAME is still ${headName}`);
  console.error('  Changed and precached:');
  for (const f of touched) console.error(`    ${f}`);
  console.error('');
  console.error('  Bump CACHE_NAME in sw.js, or these changes reach nobody who has');
  console.error('  already opened the app — the shell is cache-first.');
  console.error('');
  process.exit(1);
}

console.log(`check-sw-cache: OK — ${touched.length} shell asset(s) changed, CACHE_NAME ${baseName || '(new)'} → ${headName}`);
