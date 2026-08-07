// MangaDex — schema v2 adapter.
//
// MangaDex hands us far more metadata than the v1 scraper kept: description,
// tags, author and artist relationships, publication status and alternate
// titles. All of it goes into the Series (§1.1).
//
// Chapters carry `mdChapterId` only. Page URLs are signed and short-lived, so
// they are resolved at read time through the at-home endpoint (§1.1) — we never
// bake them into the catalogue and we never re-host images (§8).

import { getJson, firstWorkingImage } from '../lib/http.js';
import { tidy, isoOrNull, firstOf, sleep, chapterIdFromNum } from '../lib/util.js';

export const id = 'mangadex';
export const label = 'MangaDex';

const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const CONTENT_RATING = ['safe', 'suggestive'];

export function entryId(entry) {
  return `md:${String(entry.id)}`;
}

async function get(path, params, ctx) {
  return getJson(`${API}${path}`, { params, log: ctx?.log, timeout: 25000 });
}

/** Pick the English value of a MangaDex localized string, else anything. */
function localized(map, prefer = 'en') {
  if (!map || typeof map !== 'object') return null;
  return firstOf(map[prefer], ...Object.values(map));
}

/** MangaDex descriptions are markdown-ish and often carry link footers. */
function cleanDescription(raw) {
  if (!raw) return null;
  let s = String(raw)
    .split(/\n\s*-{3,}\s*\n/)[0]            // cut the "---" link footer
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')  // [text](url) -> text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  if (s.length > 1200) s = s.slice(0, 1197).replace(/\s+\S*$/, '') + '…';
  return s || null;
}

/** Reading direction from the original language, unless the config says otherwise. */
function directionFor(entry, originalLanguage) {
  if (entry.readingDirection) return entry.readingDirection;
  switch (originalLanguage) {
    case 'ja': return 'rtl';
    case 'ko': return 'vertical';
    case 'zh':
    case 'zh-hk': return 'vertical';
    default: return 'ltr';
  }
}

// ── Public helpers (also used by the app at read time) ───────────────────────

/** at-home page URLs for one chapter. Called at read time, never stored. */
export async function fetchChapterImages(mdChapterId) {
  const data = await getJson(`${API}/at-home/server/${mdChapterId}`);
  const { baseUrl, chapter } = data;
  return (chapter?.data || []).map(f => `${baseUrl}/data/${chapter.hash}/${f}`);
}

/** Every English chapter of a manga, ascending, one entry per chapter number. */
export async function fetchChapterList(mangaId, lang = 'en', ctx = {}) {
  const seen = new Map();
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await get(`/manga/${mangaId}/feed`, {
      translatedLanguage: [lang],
      contentRating: CONTENT_RATING,
      order: { chapter: 'asc', volume: 'asc' },
      includes: ['scanlation_group'],
      includeExternalUrl: 0,
      limit,
      offset,
    }, ctx);

    for (const ch of data.data || []) {
      const a = ch.attributes || {};
      if (a.externalUrl) continue;                       // not readable in-app
      const num = a.chapter != null && a.chapter !== '' ? Number(a.chapter) : null;
      const key = num != null && Number.isFinite(num) ? `n:${num}` : `u:${ch.id}`;
      const cand = {
        mdChapterId: ch.id,
        num: Number.isFinite(num) ? num : null,
        volume: a.volume != null && a.volume !== '' && Number.isFinite(Number(a.volume)) ? Number(a.volume) : null,
        title: tidy(a.title) || null,
        updatedAt: isoOrNull(a.publishAt || a.updatedAt),
        group: ch.relationships?.find(r => r.type === 'scanlation_group')?.attributes?.name || null,
      };
      // Several groups translate the same chapter; keep the earliest release.
      const prev = seen.get(key);
      if (!prev || (cand.updatedAt && prev.updatedAt && cand.updatedAt < prev.updatedAt)) {
        seen.set(key, cand);
      }
    }

    const total = data.total || 0;
    offset += limit;
    if (offset >= total) break;
    await sleep(250);                                     // be polite
  }

  const out = [...seen.values()];
  out.sort((a, b) => {
    if (a.num == null) return 1;
    if (b.num == null) return -1;
    return a.num - b.num;
  });
  return out;
}

// ── Mapping (pure — unit-testable without the network) ───────────────────────

/**
 * MangaDex manga entity + chapter list -> Series (§1.1).
 * Everything the v1 scraper threw away (description, tags, author/artist,
 * status, altTitles) is kept here.
 */
export function mapSeries({ manga, entry, list, cover, lang, maxChapters }) {
  const mangaId = String(manga.id ?? entry.id);
  const sid = entryId(entry);
  const a = manga.attributes || {};

  const rels = manga.relationships || [];
  const relName = type => firstOf(...rels.filter(r => r.type === type).map(r => r.attributes?.name));

  const title = firstOf(entry.title, localized(a.title), 'Untitled');
  const altTitles = [...new Set(
    (a.altTitles || []).flatMap(o => Object.values(o || {})).map(tidy).filter(t => t && t !== title)
  )].slice(0, 8);

  const tagsAll = (a.tags || []).map(t => ({
    name: localized(t.attributes?.name),
    group: t.attributes?.group,
  })).filter(t => t.name);
  const genres = tagsAll.filter(t => t.group === 'genre').map(t => t.name);
  const otherTags = tagsAll.filter(t => t.group !== 'genre').map(t => t.name);

  const total = list.length;
  const truncated = maxChapters != null && total > maxChapters;
  const kept = truncated ? list.slice(0, maxChapters) : list;

  const usedIds = new Set();
  const chapters = kept.map(c => {
    let cid = chapterIdFromNum(c.num, c.mdChapterId);
    while (usedIds.has(cid)) cid += '-b';
    usedIds.add(cid);
    return {
      id: cid,
      num: c.num,
      volume: c.volume,
      title: c.title,
      updatedAt: c.updatedAt,
      lang,
      mdChapterId: c.mdChapterId,
    };
  });

  let description = cleanDescription(localized(a.description)) || entry.description || null;
  if (truncated) {
    description = [description, `This sample lists the first ${chapters.length} of ${total} chapters.`]
      .filter(Boolean).join('\n\n');
  }

  const series = {
    id: sid,
    type: entry.type,
    title,
    altTitles,
    cover,
    description,
    author: firstOf(entry.author, relName('author')),
    artist: firstOf(entry.artist, relName('artist')),
    status: ['ongoing', 'completed', 'hiatus', 'cancelled'].includes(a.status) ? a.status : 'unknown',
    genres: entry.genres || genres,
    tags: otherTags,
    language: lang,
    source: 'mangadex',
    sourceUrl: `https://mangadex.org/title/${mangaId}`,
    readingDirection: directionFor(entry, a.originalLanguage),
    updatedAt: isoOrNull(a.updatedAt),
    chapterCount: chapters.length,
    chapters,
  };

  return { series, files: [], stats: { words: 0, truncatedFrom: truncated ? total : null } };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export async function build(entry, ctx) {
  const mangaId = String(entry.id);
  const lang = entry.language || ctx.language || 'en';
  const maxChapters = entry.maxChapters ?? ctx.defaults?.maxChapters ?? null;

  const res = await get('/manga/' + mangaId, {
    includes: ['cover_art', 'author', 'artist'],
  }, ctx);
  const manga = res?.data;
  if (!manga?.attributes) throw new Error('manga not found or unexpected API response');

  const coverFile = (manga.relationships || []).find(r => r.type === 'cover_art')?.attributes?.fileName || null;
  const cover = coverFile
    ? await firstWorkingImage([
        `${UPLOADS}/covers/${mangaId}/${coverFile}.512.jpg`,
        `${UPLOADS}/covers/${mangaId}/${coverFile}`,
      ], { log: ctx.log })
    : null;

  const list = await fetchChapterList(mangaId, lang, ctx);
  return mapSeries({ manga, entry, list, cover, lang, maxChapters });
}
