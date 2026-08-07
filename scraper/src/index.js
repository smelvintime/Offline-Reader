#!/usr/bin/env node
// Build catalog.json (schema v2, docs/ARCHITECTURE.md §1.1) and the
// chapters/**/*.json ChapterFiles it references.
//
//   node src/index.js                 # full run
//   node src/index.js --dry-run       # fetch and validate, write nothing
//   node src/index.js --only=gutenberg
//   node src/index.js --verbose
//
// What goes in the catalogue is configured in scraper/series.json — no code
// changes required to add a series. See docs/CATALOGUE.md.
//
// Failure policy: one dead source must never take down the run. Every entry is
// fetched inside safe(); when an entry fails (or is skipped by --only) its
// previous catalog.json entry is carried over unchanged, so a bad night at one
// site cannot silently delete series from the app.

import { readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import {
  SCRAPER_ROOT, CATALOG_PATH, CHAPTERS_DIR,
  idToDir, ensureDir, pruneDir, dirSize, humanBytes, safe,
} from './lib/util.js';
import { validateCatalog, printReport } from './validate.js';

import * as fixture from './sources/fixture.js';
import * as gutenberg from './sources/gutenberg.js';
import * as mangadex from './sources/mangadex.js';
import * as flamecomics from './sources/flamecomics.js';

const SOURCES = { fixture, gutenberg, mangadex, flamecomics };
const SERIES_TYPES = new Set(['manga', 'manhwa', 'lightnovel', 'webnovel']);
const CONFIG_PATH = join(SCRAPER_ROOT, 'series.json');

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { dryRun: false, only: null, verbose: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg.startsWith('--only=')) opts.only = arg.slice(7).split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else console.error(`warning: ignoring unknown argument "${arg}"`);
  }
  return opts;
}

const USAGE = `Usage: node src/index.js [options]

  --dry-run, -n      fetch and validate, but do not write any files
  --only=<source>    only rebuild these sources (comma separated);
                     everything else is carried over from catalog.json
  --verbose, -v      per-request detail
  --help, -h         this message

Sources: ${Object.keys(SOURCES).join(', ')}
Config:  scraper/series.json
`;

// ── Config ───────────────────────────────────────────────────────────────────

function loadConfig(log) {
  if (!existsSync(CONFIG_PATH)) throw new Error(`missing config: ${CONFIG_PATH}`);
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`series.json is not valid JSON — ${e.message}`);
  }
  if (!Array.isArray(cfg.series)) throw new Error('series.json needs a "series" array');

  const entries = [];
  cfg.series.forEach((entry, i) => {
    const where = `series.json entry ${i}`;
    if (!entry || typeof entry !== 'object') return log.error(`  ! ${where}: not an object — skipped`);
    if (entry.enabled === false) return;
    const src = SOURCES[entry.source];
    if (!src) return log.error(`  ! ${where}: unknown source "${entry.source}" — skipped`);
    if (!entry.id && !entry.slug) return log.error(`  ! ${where} (${entry.source}): needs an "id" or "slug" — skipped`);
    if (!SERIES_TYPES.has(entry.type)) {
      return log.error(`  ! ${where} (${entry.source}:${entry.id || entry.slug}): type must be one of ${[...SERIES_TYPES].join(', ')} — skipped`);
    }
    entries.push(entry);
  });
  return { defaults: cfg.defaults || {}, entries };
}

function loadPreviousCatalog(log) {
  if (!existsSync(CATALOG_PATH)) return new Map();
  try {
    const prev = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
    return new Map((prev.series || []).map(s => [s.id, s]));
  } catch (e) {
    log.error(`  ! could not read the previous catalog.json (${e.message}) — nothing to carry over`);
    return new Map();
  }
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** Write one series' ChapterFiles + assets, prune anything stale beside them. */
function writeSeriesFiles(seriesId, files, assets, log) {
  const dir = join(CHAPTERS_DIR, idToDir(seriesId));
  ensureDir(dir);
  const keep = new Set();
  for (const file of files) {
    const name = `${file.id}.json`;
    keep.add(name);
    writeFileSync(join(dir, name), JSON.stringify(file));
  }
  for (const asset of assets || []) {
    keep.add(asset.to);
    copyFileSync(asset.from, join(dir, asset.to));
  }
  const removed = pruneDir(dir, keep);
  if (removed) log.debug(`    pruned ${removed} stale file(s) from ${dir}`);
  return dir;
}

/** Delete chapter directories the finished catalogue no longer references. */
function pruneOrphanDirs(catalog, log) {
  const referenced = new Set();
  for (const s of catalog.series) {
    for (const ch of s.chapters || []) {
      const m = /^chapters\/([^/]+)\//.exec(ch.src || '');
      if (m) referenced.add(m[1]);
    }
    const cm = /^chapters\/([^/]+)\//.exec(s.cover || '');
    if (cm) referenced.add(cm[1]);
  }
  let names;
  try { names = readdirSync(CHAPTERS_DIR); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const full = join(CHAPTERS_DIR, name);
    if (!statSync(full).isDirectory() || referenced.has(name)) continue;
    rmSync(full, { recursive: true, force: true });
    log.info(`  - removed unreferenced ${join('chapters', name)}`);
    removed++;
  }
  return removed;
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { process.stdout.write(USAGE); return 0; }

  const log = {
    info: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
    debug: opts.verbose ? (...a) => console.log(...a) : () => {},
  };

  for (const name of opts.only || []) {
    if (!SOURCES[name]) log.error(`warning: --only=${name} is not a known source (${Object.keys(SOURCES).join(', ')})`);
  }

  const { defaults, entries } = loadConfig(log);
  const previous = loadPreviousCatalog(log);

  log.info(`Offline Reader catalogue build — ${entries.length} enabled entr${entries.length === 1 ? 'y' : 'ies'}` +
    (opts.only ? `, --only=${opts.only.join(',')}` : '') + (opts.dryRun ? ', DRY RUN (no files written)' : ''));
  if (previous.size) log.info(`Previous catalog.json has ${previous.size} series available for carry-over.`);
  log.info('');

  const stats = new Map();   // source -> counters
  const bump = (source, key, n = 1) => {
    if (!stats.has(source)) stats.set(source, { entries: 0, ok: 0, failed: 0, skipped: 0, carried: 0, chapters: 0, words: 0, pages: 0 });
    stats.get(source)[key] += n;
  };

  const out = [];
  const failures = [];
  const carried = [];

  for (const entry of entries) {
    const src = SOURCES[entry.source];
    const sid = src.entryId(entry);
    bump(entry.source, 'entries');

    if (opts.only && !opts.only.includes(entry.source)) {
      const prev = previous.get(sid);
      bump(entry.source, 'skipped');
      if (prev) { out.push(prev); bump(entry.source, 'carried'); carried.push(`${sid} (not selected by --only)`); }
      continue;
    }

    process.stdout.write(`  ${sid} … `);
    const ctx = { log, defaults: defaults[entry.source] || {}, language: defaults.language || 'en', dryRun: opts.dryRun };
    const started = Date.now();
    const result = await safe(sid, () => src.build(entry, ctx), {
      error: msg => { process.stdout.write('FAILED\n'); log.error(msg); },
    });

    if (!result) {
      bump(entry.source, 'failed');
      failures.push(sid);
      const prev = previous.get(sid);
      if (prev) {
        out.push(prev);
        bump(entry.source, 'carried');
        carried.push(`${sid} (fetch failed, kept ${prev.chapters?.length ?? 0} chapters from the previous catalogue)`);
        log.info(`    ↳ kept the previous catalogue entry for ${sid}`);
      } else {
        log.info(`    ↳ no previous entry to fall back on — ${sid} is not in this catalogue`);
      }
      continue;
    }

    const { series, files = [], assets = [], stats: st = {} } = result;
    if (!opts.dryRun && (files.length || assets.length)) writeSeriesFiles(series.id, files, assets, log);

    out.push(series);
    bump(entry.source, 'ok');
    bump(entry.source, 'chapters', series.chapters.length);
    bump(entry.source, 'words', st.words || 0);
    bump(entry.source, 'pages', st.pages || 0);

    const extras = [
      `${series.chapters.length} chapters`,
      st.words ? `${st.words.toLocaleString('en-US')} words` : null,
      st.pages ? `${st.pages} pages` : null,
      st.truncatedFrom ? `truncated from ${st.truncatedFrom}` : null,
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
    ].filter(Boolean);
    process.stdout.write(`OK — ${extras.join(', ')}\n`);
  }

  const catalog = {
    version: 2,
    generatedAt: new Date().toISOString(),
    series: out,
  };

  if (!opts.dryRun) {
    ensureDir(CHAPTERS_DIR);
    writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
    pruneOrphanDirs(catalog, log);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  log.info('\n── Run summary ' + '─'.repeat(50));
  const cols = ['source', 'entries', 'ok', 'failed', 'skipped', 'carried', 'chapters', 'words'];
  const rows = [...stats.entries()].map(([source, s]) => [
    source, s.entries, s.ok, s.failed, s.skipped, s.carried, s.chapters, s.words ? s.words.toLocaleString('en-US') : '0',
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => String(r[i]).length)));
  const line = cells => cells.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join('  ');
  log.info(line(cols));
  for (const r of rows) log.info(line(r));

  if (failures.length) {
    log.info(`\nFailed (${failures.length}): ${failures.join(', ')}`);
    log.info('Reasons are printed above, prefixed with "!".');
  }
  if (carried.length) {
    log.info(`\nCarried over from the previous catalog.json (${carried.length}):`);
    for (const c of carried) log.info(`  · ${c}`);
  }

  const totalChapters = out.reduce((n, s) => n + (s.chapters?.length || 0), 0);
  log.info(`\nCatalogue: ${out.length} series, ${totalChapters} chapters` +
    (opts.dryRun ? ' (dry run — nothing written)' : ''));
  if (!opts.dryRun) {
    log.info(`Sizes: catalog.json ${humanBytes(statSync(CATALOG_PATH).size)}, chapters/ ${humanBytes(dirSize(CHAPTERS_DIR))}`);
  }

  // ── Validation (§1) — the last step of every run ────────────────────────────
  log.info('\n── Validation ' + '─'.repeat(51));
  const rep = validateCatalog(catalog, { checkFiles: !opts.dryRun });
  printReport(rep);
  log.info(rep.ok
    ? `validate: OK — ${out.length} series, ${totalChapters} chapters, ${rep.seenFiles.size} chapter files checked, ${rep.warnings.length} warning(s)`
    : `validate: FAILED — ${rep.errors.length} error(s), ${rep.warnings.length} warning(s)`);

  if (!out.length) {
    log.error('\nEvery source failed and there was nothing to carry over: the catalogue is empty.');
    return 1;
  }
  return rep.ok ? 0 : 1;
}

main().then(code => process.exit(code)).catch(e => {
  console.error('\nfatal:', e?.stack || e?.message || e);
  process.exit(1);
});
