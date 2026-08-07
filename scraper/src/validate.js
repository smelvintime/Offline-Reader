#!/usr/bin/env node
// Validates catalog.json and every ChapterFile it references against
// docs/ARCHITECTURE.md §1. Run as the last step of every scrape, and
// standalone via `npm run validate`.
//
//   node src/validate.js                 # validate the committed output
//   node src/validate.js --quiet         # errors only
//
// Exit code 0 = valid, 1 = at least one error.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { REPO_ROOT, CATALOG_PATH, CHAPTERS_DIR, dirSize, humanBytes } from './lib/util.js';
import { BLOCK_TYPES } from './lib/blocks.js';

const SERIES_TYPES = new Set(['manga', 'manhwa', 'lightnovel', 'webnovel']);
const IMAGE_TYPES = new Set(['manga', 'manhwa']);
const STATUSES = new Set(['ongoing', 'completed', 'hiatus', 'cancelled', 'unknown']);
const DIRECTIONS = new Set(['ltr', 'rtl', 'vertical']);
const PAYLOAD_KEYS = ['pages', 'mdChapterId', 'text', 'src'];
const HTML_ISH = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/i;

class Report {
  constructor() { this.errors = []; this.warnings = []; }
  err(where, msg) { this.errors.push(`${where}: ${msg}`); }
  warn(where, msg) { this.warnings.push(`${where}: ${msg}`); }
  get ok() { return this.errors.length === 0; }
}

const isStr = v => typeof v === 'string';
const nonEmpty = v => isStr(v) && v.trim().length > 0;
const isNullOrStr = v => v === null || isStr(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isArrOfStr = v => Array.isArray(v) && v.every(nonEmpty);

function isIso(v) {
  if (!isStr(v)) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime()) && /\d{4}-\d{2}-\d{2}T/.test(v);
}

function isCoverRef(v) {
  if (v === null) return true;
  if (!nonEmpty(v)) return false;
  if (/^https?:\/\//i.test(v)) return true;
  // Relative to the app root, e.g. "covers/xyz.jpg" or "chapters/…/cover.svg".
  return !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('/');
}

// ── Blocks ───────────────────────────────────────────────────────────────────

export function validateBlock(block, where, rep) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    rep.err(where, 'block must be an object');
    return;
  }
  const t = block.t;
  if (!nonEmpty(t)) { rep.err(where, 'block.t is required'); return; }
  if (!BLOCK_TYPES.has(t)) { rep.err(where, `block.t "${t}" is not an allowed type`); return; }

  if (t === 'hr') {
    if ('c' in block || 'items' in block) rep.warn(where, 'hr block carries unused content');
    return;
  }
  if (t === 'ul' || t === 'ol') {
    if (!isArrOfStr(block.items) || block.items.length === 0) {
      rep.err(where, `${t} block needs a non-empty items: string[]`);
    }
    return;
  }
  if (t === 'img') {
    if (!nonEmpty(block.src)) rep.err(where, 'img block needs src');
    else if (!/^https?:\/\//i.test(block.src) && /^[a-z][a-z0-9+.-]*:/i.test(block.src)) {
      rep.err(where, `img block src has a disallowed scheme: ${block.src.slice(0, 40)}`);
    }
    if ('alt' in block && !isStr(block.alt)) rep.err(where, 'img block alt must be a string');
    return;
  }
  // p h2 h3 h4 blockquote pre note
  if (!nonEmpty(block.c)) { rep.err(where, `${t} block needs a non-empty string c`); return; }
  if (HTML_ISH.test(block.c)) {
    rep.warn(where, `${t} block contains HTML-looking markup: ${block.c.slice(0, 60)}`);
  }
}

// ── ChapterFile (§1.2) ───────────────────────────────────────────────────────

export function validateChapterFile(file, where, rep, expect = {}) {
  if (!file || typeof file !== 'object') { rep.err(where, 'ChapterFile must be an object'); return; }
  if (!nonEmpty(file.seriesId)) rep.err(where, 'seriesId is required');
  else if (expect.seriesId && file.seriesId !== expect.seriesId) {
    rep.err(where, `seriesId "${file.seriesId}" does not match catalogue series "${expect.seriesId}"`);
  }
  if (!nonEmpty(file.id)) rep.err(where, 'id is required');
  else if (expect.id && file.id !== expect.id) {
    rep.err(where, `id "${file.id}" does not match catalogue chapter "${expect.id}"`);
  }
  if (!(file.num === null || isNum(file.num))) rep.err(where, 'num must be a number or null');
  if (!isNullOrStr(file.title)) rep.err(where, 'title must be a string or null');
  if (file.kind !== 'text' && file.kind !== 'image') {
    rep.err(where, `kind must be "text" or "image" (got ${JSON.stringify(file.kind)})`);
    return;
  }

  if (file.kind === 'text') {
    if (!Array.isArray(file.blocks) || file.blocks.length === 0) {
      rep.err(where, 'text ChapterFile needs a non-empty blocks array');
    } else {
      file.blocks.forEach((b, i) => validateBlock(b, `${where} blocks[${i}]`, rep));
    }
    if (!isNum(file.wordCount) || file.wordCount < 0) rep.err(where, 'wordCount must be a non-negative number');
    if ('pages' in file) rep.err(where, 'text ChapterFile must not carry pages');
  } else {
    if (!Array.isArray(file.pages) || file.pages.length === 0) {
      rep.err(where, 'image ChapterFile needs a non-empty pages array');
    } else if (!isArrOfStr(file.pages)) {
      rep.err(where, 'pages must be an array of non-empty strings');
    }
    if ('blocks' in file) rep.err(where, 'image ChapterFile must not carry blocks');
  }
}

// ── Chapter (§1.1) ───────────────────────────────────────────────────────────

function validateChapter(ch, where, rep, ctx) {
  if (!ch || typeof ch !== 'object') { rep.err(where, 'chapter must be an object'); return; }
  if (!nonEmpty(ch.id)) rep.err(where, 'id is required');
  if (!(ch.num === null || isNum(ch.num))) rep.err(where, 'num must be a number or null');
  if (!(ch.volume == null || isNum(ch.volume))) rep.err(where, 'volume must be a number or null');
  if (!isNullOrStr(ch.title)) rep.err(where, 'title must be a string or null');
  if (!(ch.updatedAt === null || isIso(ch.updatedAt))) rep.err(where, 'updatedAt must be an ISO date or null');
  if (!(ch.lang == null || nonEmpty(ch.lang))) rep.err(where, 'lang must be a non-empty string when present');
  if ('wordCount' in ch && !(ch.wordCount === null || (isNum(ch.wordCount) && ch.wordCount >= 0))) {
    rep.err(where, 'wordCount must be a non-negative number or null');
  }

  const present = PAYLOAD_KEYS.filter(k => ch[k] != null);
  if (present.length === 0) {
    rep.err(where, `no payload — needs exactly one of ${PAYLOAD_KEYS.join(', ')}`);
  } else if (present.length > 1) {
    rep.err(where, `ambiguous payload — has ${present.join(' + ')}, expected exactly one`);
  }

  if (ch.pages != null && !isArrOfStr(ch.pages)) rep.err(where, 'pages must be an array of non-empty strings');
  if (ch.text != null && !nonEmpty(ch.text)) rep.err(where, 'text must be a non-empty string');
  if (ch.mdChapterId != null && !nonEmpty(ch.mdChapterId)) rep.err(where, 'mdChapterId must be a non-empty string');

  if (ch.src != null) {
    if (!nonEmpty(ch.src)) { rep.err(where, 'src must be a non-empty string'); return; }
    if (/^https?:\/\//i.test(ch.src)) return;                 // remote src is legal (worker /chapter)
    if (!ch.src.startsWith('chapters/')) {
      rep.err(where, `local src must live under chapters/ (got "${ch.src}")`);
      return;
    }
    if (!ctx.checkFiles) return;
    const abs = join(REPO_ROOT, ch.src);
    if (!existsSync(abs)) { rep.err(where, `src file is missing on disk: ${ch.src}`); return; }
    ctx.seenFiles.add(abs);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      rep.err(where, `src file is not valid JSON (${e.message})`);
      return;
    }
    validateChapterFile(parsed, ch.src, rep, { seriesId: ctx.seriesId, id: ch.id });
    if (parsed?.kind === 'text' && isNum(ch.wordCount) && isNum(parsed.wordCount) && ch.wordCount !== parsed.wordCount) {
      rep.warn(where, `catalogue wordCount ${ch.wordCount} != ChapterFile wordCount ${parsed.wordCount}`);
    }
    if (ctx.seriesType && IMAGE_TYPES.has(ctx.seriesType) && parsed?.kind === 'text') {
      rep.warn(where, `series type "${ctx.seriesType}" but ChapterFile kind is text`);
    }
  }
}

// ── Series (§1.1) ────────────────────────────────────────────────────────────

function validateSeries(s, where, rep, ctx) {
  if (!s || typeof s !== 'object') { rep.err(where, 'series must be an object'); return; }

  if (!nonEmpty(s.id)) rep.err(where, 'id is required');
  else if (ctx.ids.has(s.id)) rep.err(where, `duplicate series id "${s.id}"`);
  else ctx.ids.add(s.id);

  if (!SERIES_TYPES.has(s.type)) rep.err(where, `type must be one of ${[...SERIES_TYPES].join(' | ')} (got ${JSON.stringify(s.type)})`);
  if (!nonEmpty(s.title)) rep.err(where, 'title is required');
  if ('altTitles' in s && !(Array.isArray(s.altTitles) && s.altTitles.every(isStr))) rep.err(where, 'altTitles must be a string array');
  if (!isCoverRef(s.cover)) rep.err(where, `cover must be an absolute http(s) URL, an app-root-relative path, or null (got ${JSON.stringify(s.cover)})`);
  if (!isNullOrStr(s.description)) rep.err(where, 'description must be a string or null');
  if (!isNullOrStr(s.author)) rep.err(where, 'author must be a string or null');
  if (!isNullOrStr(s.artist)) rep.err(where, 'artist must be a string or null');
  if (!STATUSES.has(s.status)) rep.err(where, `status must be one of ${[...STATUSES].join(' | ')} (got ${JSON.stringify(s.status)})`);
  if (!(Array.isArray(s.genres) && s.genres.every(isStr))) rep.err(where, 'genres must be a string array');
  if (!(Array.isArray(s.tags) && s.tags.every(isStr))) rep.err(where, 'tags must be a string array');
  if (!nonEmpty(s.language)) rep.err(where, 'language is required');
  if (!nonEmpty(s.source)) rep.err(where, 'source is required');
  if (!(s.sourceUrl === null || (nonEmpty(s.sourceUrl) && /^https?:\/\//i.test(s.sourceUrl)))) {
    rep.err(where, 'sourceUrl must be an absolute http(s) URL or null');
  }
  if (!(s.updatedAt === null || isIso(s.updatedAt))) rep.err(where, 'updatedAt must be an ISO date or null');

  if (s.readingDirection === null) {
    if (IMAGE_TYPES.has(s.type)) rep.err(where, `type "${s.type}" requires a readingDirection`);
  } else if (!DIRECTIONS.has(s.readingDirection)) {
    rep.err(where, `readingDirection must be ${[...DIRECTIONS].join(' | ')} or null (got ${JSON.stringify(s.readingDirection)})`);
  } else if (!IMAGE_TYPES.has(s.type)) {
    rep.warn(where, `readingDirection is only meaningful for image types; "${s.type}" sets ${s.readingDirection}`);
  }

  if (!Array.isArray(s.chapters)) { rep.err(where, 'chapters must be an array'); return; }
  if (!isNum(s.chapterCount)) rep.err(where, 'chapterCount must be a number');
  else if (s.chapterCount !== s.chapters.length) {
    rep.err(where, `chapterCount ${s.chapterCount} does not match chapters.length ${s.chapters.length}`);
  }
  if (s.chapters.length === 0) rep.warn(where, 'series has no chapters');

  const seen = new Set();
  let prev = -Infinity;
  const chCtx = { ...ctx, seriesId: s.id, seriesType: s.type };
  s.chapters.forEach((ch, i) => {
    const chWhere = `${where} chapters[${i}]${ch?.id ? ` (${ch.id})` : ''}`;
    validateChapter(ch, chWhere, rep, chCtx);
    if (ch?.id) {
      if (seen.has(ch.id)) rep.err(chWhere, `duplicate chapter id "${ch.id}" within series`);
      seen.add(ch.id);
    }
    if (isNum(ch?.num)) {
      if (ch.num < prev) rep.err(chWhere, `chapters must be ascending by num (${ch.num} after ${prev})`);
      prev = ch.num;
    }
  });
}

// ── Catalogue (§1.1) ─────────────────────────────────────────────────────────

export function validateCatalog(catalog, opts = {}) {
  const rep = new Report();
  const ctx = {
    ids: new Set(),
    checkFiles: opts.checkFiles !== false,
    seenFiles: new Set(),
  };

  if (!catalog || typeof catalog !== 'object') {
    rep.err('catalog.json', 'must be a JSON object');
    return rep;
  }
  if (catalog.version !== 2) rep.err('catalog.json', `version must be 2 (got ${JSON.stringify(catalog.version)})`);
  if (!isIso(catalog.generatedAt)) rep.err('catalog.json', 'generatedAt must be an ISO date string');
  if (!Array.isArray(catalog.series)) {
    rep.err('catalog.json', 'series must be an array');
    return rep;
  }
  catalog.series.forEach((s, i) => {
    validateSeries(s, `series[${i}]${s?.id ? ` (${s.id})` : ''}`, rep, ctx);
  });
  rep.seenFiles = ctx.seenFiles;
  return rep;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function printReport(rep, log = console) {
  for (const w of rep.warnings) log.warn(`  warn  ${w}`);
  for (const e of rep.errors) log.error(`  ERROR ${e}`);
  return rep.ok;
}

function main() {
  const quiet = process.argv.includes('--quiet');
  if (!existsSync(CATALOG_PATH)) {
    console.error(`validate: ${CATALOG_PATH} does not exist — run the scraper first.`);
    process.exit(1);
  }
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  } catch (e) {
    console.error(`validate: catalog.json is not valid JSON — ${e.message}`);
    process.exit(1);
  }

  const rep = validateCatalog(catalog);
  const nSeries = Array.isArray(catalog.series) ? catalog.series.length : 0;
  const nChapters = Array.isArray(catalog.series)
    ? catalog.series.reduce((n, s) => n + (Array.isArray(s.chapters) ? s.chapters.length : 0), 0)
    : 0;

  if (!quiet) {
    console.log(`validate: schema v2 — ${nSeries} series, ${nChapters} chapters, ${rep.seenFiles.size} chapter files checked`);
  }
  printReport(rep);

  if (!quiet) {
    const catBytes = existsSync(CATALOG_PATH) ? readFileSync(CATALOG_PATH).length : 0;
    console.log(`validate: catalog.json ${humanBytes(catBytes)}, chapters/ ${humanBytes(dirSize(CHAPTERS_DIR))}`);
  }
  console.log(rep.ok
    ? `validate: OK (${rep.warnings.length} warning${rep.warnings.length === 1 ? '' : 's'})`
    : `validate: FAILED — ${rep.errors.length} error(s), ${rep.warnings.length} warning(s)`);
  process.exit(rep.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('validate.js')) main();
