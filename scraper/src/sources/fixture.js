// Hand-written sample series — the offline floor of the catalogue.
//
// This "source" never touches the network. It reads a JSON file from
// scraper/fixtures/ that a human wrote by hand and turns it into a Series (§1.1)
// plus one ChapterFile (§1.2) per chapter. If every network source is down, the
// app still has something to open.
//
// A fixture chapter is one of two kinds:
//
//   { "title": "…", "blocks": [ … ] }   text    — typed prose blocks (§1.3)
//   { "title": "…", "pages":  [ … ] }   image   — file names of page images
//
// Image pages are paths relative to scraper/fixtures/ (e.g. "ashfall/c01-p01.svg").
// Like the cover, they are copied beside the chapter files, so a picture series
// written as a fixture is fully self-contained and needs no network and no host.

import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { SCRAPER_ROOT, chapterId, chapterSrc, idToDir, tidy } from '../lib/util.js';
import { BLOCK_TYPES, textChapterFile, imageChapterFile } from '../lib/blocks.js';

export const id = 'fixture';
export const label = 'Hand-written fixture';

export const FIXTURES_DIR = join(SCRAPER_ROOT, 'fixtures');

export function entryId(entry) {
  return `fixture:${String(entry.id)}`;
}

export async function build(entry, ctx) {
  const sid = entryId(entry);
  const path = join(FIXTURES_DIR, `${entry.id}.json`);
  if (!existsSync(path)) throw new Error(`fixture file not found: ${path}`);

  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.chapters) || !raw.chapters.length) {
    throw new Error(`fixture ${entry.id}.json has no chapters`);
  }

  // Assets are files that ship next to the fixture and are copied beside the
  // chapter files, so the whole series is self-contained and offline: the
  // cover, and the page images of any picture chapters.
  const assets = [];
  const files = [];
  let pageCount = 0;

  const chapters = raw.chapters.map((ch, i) => {
    const cid = ch.id || chapterId(i + 1);
    const num = ch.num ?? i + 1;
    const common = {
      id: cid,
      num,
      volume: ch.volume ?? null,
      title: ch.title ?? null,
      updatedAt: null,
      lang: raw.language || entry.language || 'en',
      src: chapterSrc(sid, cid),
    };

    // ── image chapter ────────────────────────────────────────────────────────
    if (Array.isArray(ch.pages) && ch.pages.length) {
      if (ch.blocks) throw new Error(`fixture chapter ${cid} has both pages and blocks`);
      const pages = ch.pages.map((rel, j) => {
        if (typeof rel !== 'string' || !rel.trim()) {
          throw new Error(`fixture chapter ${cid} page ${j + 1} is not a file name`);
        }
        const from = join(FIXTURES_DIR, rel);
        if (!existsSync(from)) throw new Error(`fixture page not found: ${from}`);
        const to = `${cid}-p${String(j + 1).padStart(2, '0')}${extname(rel)}`;
        assets.push({ from, to });
        return `chapters/${idToDir(sid)}/${to}`;
      });
      pageCount += pages.length;
      files.push(imageChapterFile({ seriesId: sid, id: cid, num, title: ch.title ?? null, pages }));
      return common;   // no wordCount: picture chapters have none
    }

    // ── text chapter ─────────────────────────────────────────────────────────
    const blocks = (ch.blocks || []).filter(b => b && BLOCK_TYPES.has(b.t));
    if (blocks.length !== (ch.blocks || []).length) {
      const bad = (ch.blocks || []).filter(b => !b || !BLOCK_TYPES.has(b.t)).map(b => b?.t);
      throw new Error(`fixture chapter ${cid} uses unknown block type(s): ${bad.join(', ')}`);
    }
    if (!blocks.length) throw new Error(`fixture chapter ${cid} has neither blocks nor pages`);

    const file = textChapterFile({ seriesId: sid, id: cid, num, title: ch.title ?? null, blocks });
    files.push(file);
    return { ...common, wordCount: file.wordCount };
  });

  let cover = null;
  if (raw.cover) {
    const from = join(FIXTURES_DIR, raw.cover);
    if (!existsSync(from)) throw new Error(`fixture cover not found: ${from}`);
    const to = `cover${raw.cover.slice(raw.cover.lastIndexOf('.'))}`;
    assets.push({ from, to });
    cover = `chapters/${idToDir(sid)}/${to}`;
  }

  const series = {
    id: sid,
    type: entry.type,
    title: tidy(raw.title || entry.id),
    altTitles: raw.altTitles || [],
    cover,
    description: raw.description || null,
    author: raw.author ?? null,
    artist: raw.artist ?? null,
    status: raw.status || 'completed',
    genres: raw.genres || [],
    tags: raw.tags || [],
    language: raw.language || entry.language || 'en',
    source: 'fixture',
    sourceUrl: null,
    // Picture types require a reading direction (§1.1); prose types leave it null.
    readingDirection: entry.readingDirection || raw.readingDirection || null,
    updatedAt: null,
    chapterCount: chapters.length,
    chapters,
  };

  return {
    series,
    files,
    assets,
    stats: {
      words: files.reduce((n, f) => n + (f.wordCount || 0), 0),
      pages: pageCount,
      truncatedFrom: null,
    },
  };
}
