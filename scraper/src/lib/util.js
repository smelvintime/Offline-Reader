// Shared helpers for the catalogue scraper.
// No dependencies beyond node built-ins.

import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { mkdirSync, rmSync, readdirSync, statSync } from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root (the directory holding index.html). */
export const REPO_ROOT = resolve(__dir, '..', '..', '..');
/** Absolute path of the scraper package directory. */
export const SCRAPER_ROOT = resolve(__dir, '..', '..');
/** Where generated ChapterFiles go. */
export const CHAPTERS_DIR = join(REPO_ROOT, 'chapters');
/** Where the generated catalogue goes. */
export const CATALOG_PATH = join(REPO_ROOT, 'catalog.json');

/**
 * Turn a series id like "gutenberg:84" into something safe for a directory
 * name. Deterministic, so paths are stable across runs.
 */
export function idToDir(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'series';
}

/** Zero-padded chapter id: 3 -> "c-0003". Stable, sorts lexicographically. */
export function chapterId(index) {
  return 'c-' + String(index).padStart(4, '0');
}

/**
 * Chapter id derived from the chapter's own number: 271 -> "c-0271",
 * 271.5 -> "c-0271.5". Stable across rebuilds even when chapters are inserted,
 * which index-based ids are not. Falls back to a hash-ish suffix when the
 * source has no chapter number.
 */
export function chapterIdFromNum(num, fallback = '') {
  if (num == null || !Number.isFinite(Number(num))) {
    return 'c-x' + String(fallback).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  }
  const n = Number(num);
  const int = Math.floor(n);
  const frac = n - int;
  return 'c-' + String(int).padStart(4, '0') + (frac ? String(frac).slice(1) : '');
}

/** Relative (app-root) path used in Chapter.src. Always forward slashes. */
export function chapterSrc(seriesId, chId) {
  return `chapters/${idToDir(seriesId)}/${chId}.json`;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/**
 * Delete files in `dir` that are not in `keep` (a Set of file names).
 * Used to prune chapter files for chapters that no longer exist upstream.
 * Never touches directories other than the one passed in.
 */
export function pruneDir(dir, keep) {
  let removed = 0;
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) continue;
    if (keep.has(name)) continue;
    rmSync(full);
    removed++;
  }
  return removed;
}

/** Recursive byte size of a directory. Returns 0 when it does not exist. */
export function dirSize(dir) {
  let total = 0;
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const full = join(dir, name);
    const st = statSync(full);
    total += st.isDirectory() ? dirSize(full) : st.size;
  }
  return total;
}

export function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** Sleep, for polite rate limiting. */
export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Run `fn`, returning null (never throwing) if it fails. This is the isolation
 * boundary: one dead source must never take down the whole run.
 */
export async function safe(label, fn, log = console) {
  try {
    return await fn();
  } catch (e) {
    const detail = e?.response?.status ? `HTTP ${e.response.status}` : (e?.code || e?.message || String(e));
    log.error(`  ! [${label}] ${detail}`);
    return null;
  }
}

/** ISO-8601 or null. Accepts Date, number, string; rejects nonsense. */
export function isoOrNull(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Collapse runs of whitespace, trim. Returns '' for nullish. */
export function tidy(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** First non-empty string in the list, else null. */
export function firstOf(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
