// Hand-written sample series — the offline floor of the catalogue.
//
// This "source" never touches the network. It reads a JSON file from
// scraper/fixtures/ that a human wrote by hand and turns it into a Series (§1.1)
// plus one ChapterFile (§1.2) per chapter. If every network source is down, the
// app still has something to open.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { SCRAPER_ROOT, chapterId, chapterSrc, idToDir, tidy } from '../lib/util.js';
import { BLOCK_TYPES, textChapterFile } from '../lib/blocks.js';

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

  const files = [];
  const chapters = raw.chapters.map((ch, i) => {
    const cid = ch.id || chapterId(i + 1);
    const blocks = (ch.blocks || []).filter(b => b && BLOCK_TYPES.has(b.t));
    if (blocks.length !== (ch.blocks || []).length) {
      const bad = (ch.blocks || []).filter(b => !b || !BLOCK_TYPES.has(b.t)).map(b => b?.t);
      throw new Error(`fixture chapter ${cid} uses unknown block type(s): ${bad.join(', ')}`);
    }
    if (!blocks.length) throw new Error(`fixture chapter ${cid} has no blocks`);

    const file = textChapterFile({
      seriesId: sid,
      id: cid,
      num: ch.num ?? i + 1,
      title: ch.title ?? null,
      blocks,
    });
    files.push(file);
    return {
      id: cid,
      num: ch.num ?? i + 1,
      volume: ch.volume ?? null,
      title: ch.title ?? null,
      updatedAt: null,
      lang: raw.language || entry.language || 'en',
      wordCount: file.wordCount,
      src: chapterSrc(sid, cid),
    };
  });

  // The cover ships in the repo next to the fixture; we copy it beside the
  // chapter files so the whole series is self-contained and offline.
  const assets = [];
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
    readingDirection: null,
    updatedAt: null,
    chapterCount: chapters.length,
    chapters,
  };

  return {
    series,
    files,
    assets,
    stats: { words: files.reduce((n, f) => n + f.wordCount, 0), truncatedFrom: null },
  };
}
