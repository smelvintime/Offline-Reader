// mangadex.js — MangaDex via its public JSON API only.
//
// We never scrape mangadex.org's HTML: it is a client-rendered SPA (there is no
// chapter list in the served markup) and the site explicitly publishes an API
// for exactly this. All requests go to api.mangadex.org, unauthenticated.
//
// Endpoints used:
//   GET /manga/<uuid>?includes[]=cover_art&includes[]=author&includes[]=artist
//   GET /manga/<uuid>/feed?translatedLanguage[]=en&order[chapter]=asc&limit&offset
//   GET /chapter/<uuid>
//   GET /at-home/server/<uuid>          → { baseUrl, chapter:{ hash, data[] } }

import { gwError } from '../lib/respond.js';

export const id = 'mangadex';
export const label = 'MangaDex';
export const priority = 10;

const API = 'https://api.mangadex.org';
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const TITLE_RE = new RegExp(`/title/(${UUID})`);
const CHAPTER_RE = new RegExp(`/chapter/(${UUID})`);

/** Cap the feed walk so one 3,000-chapter series cannot hang the worker. */
const FEED_LIMIT = 100;
const MAX_FEED_PAGES = 12; // 1,200 chapters

export function matches(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host !== 'mangadex.org' && host !== 'api.mangadex.org') return false;
    return TITLE_RE.test(u.pathname) || CHAPTER_RE.test(u.pathname);
  } catch {
    return false;
  }
}

function titleId(url) {
  const m = TITLE_RE.exec(new URL(url).pathname);
  return m ? m[1] : null;
}

function chapterId(url) {
  const m = CHAPTER_RE.exec(new URL(url).pathname);
  return m ? m[1] : null;
}

/** MangaDex localises everything; prefer en, then the first key present. */
function pickLocalized(obj, prefer = 'en') {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj[prefer] === 'string' && obj[prefer].trim()) return obj[prefer].trim();
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

const STATUS = {
  ongoing: 'ongoing',
  completed: 'completed',
  hiatus: 'hiatus',
  cancelled: 'cancelled',
};

/** Original language is the only reliable reading-direction signal MD gives. */
function directionFor(originalLanguage) {
  if (originalLanguage === 'ja' || originalLanguage === 'zh' || originalLanguage === 'zh-hk') {
    return 'rtl';
  }
  if (originalLanguage === 'ko') return 'vertical';
  return 'ltr';
}

function relOf(entity, type) {
  return (entity.relationships || []).find((r) => r.type === type) || null;
}

export async function resolveSeries(url, ctx) {
  const uuid = titleId(url);
  if (!uuid) throw gwError('bad_url', 'Not a MangaDex title URL (expected /title/<uuid>)');

  const lang = (ctx.lang || 'en').slice(0, 5);

  const mangaRes = await ctx.fetchJson(
    `${API}/manga/${uuid}?includes[]=cover_art&includes[]=author&includes[]=artist`,
  );
  const manga = mangaRes && mangaRes.data;
  if (!manga || !manga.attributes) throw gwError('parse_failed', 'MangaDex returned no manga data');
  const a = manga.attributes;

  const coverRel = relOf(manga, 'cover_art');
  const coverFile = coverRel && coverRel.attributes && coverRel.attributes.fileName;
  const cover = coverFile
    ? `https://uploads.mangadex.org/covers/${uuid}/${coverFile}.512.jpg`
    : '';

  const authorRel = relOf(manga, 'author');
  const artistRel = relOf(manga, 'artist');

  const altTitles = (a.altTitles || [])
    .map((t) => pickLocalized(t))
    .filter(Boolean)
    .slice(0, 10);

  const genres = (a.tags || [])
    .map((t) => pickLocalized(t.attributes && t.attributes.name))
    .filter(Boolean)
    .slice(0, 15);

  const chapters = await fetchFeed(uuid, lang, ctx);

  const series = {
    id: 'md:' + uuid,
    type: a.originalLanguage === 'ko' ? 'manhwa' : 'manga',
    title: pickLocalized(a.title) || 'Unknown',
    altTitles,
    cover,
    description: (pickLocalized(a.description) || '').slice(0, 4000),
    author: (authorRel && authorRel.attributes && authorRel.attributes.name) || '',
    artist: (artistRel && artistRel.attributes && artistRel.attributes.name) || '',
    status: STATUS[a.status] || 'unknown',
    genres,
    tags: [],
    language: lang,
    source: id,
    sourceUrl: `https://mangadex.org/title/${uuid}`,
    readingDirection: directionFor(a.originalLanguage),
    updatedAt: a.updatedAt || new Date().toISOString(),
    chapterCount: chapters.length,
    chapters,
    confidence: 'high', // a real API, not a guess
  };

  // Page images come from the at-home network; covers from uploads.
  const hosts = new Set(['uploads.mangadex.org']);
  return { series, hosts, confidence: 'high' };
}

async function fetchFeed(uuid, lang, ctx) {
  const out = [];
  const usedIds = new Set();
  let offset = 0;

  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const qs = new URLSearchParams();
    qs.set('translatedLanguage[]', lang);
    qs.set('order[chapter]', 'asc');
    qs.set('limit', String(FEED_LIMIT));
    qs.set('offset', String(offset));
    qs.append('contentRating[]', 'safe');
    qs.append('contentRating[]', 'suggestive');
    qs.append('contentRating[]', 'erotica');
    qs.set('includeExternalUrl', '0');

    // eslint-disable-next-line no-await-in-loop
    const feed = await ctx.fetchJson(`${API}/manga/${uuid}/feed?${qs.toString()}`);
    const rows = (feed && feed.data) || [];
    for (const ch of rows) {
      const at = ch.attributes || {};
      // External chapters live on another site and have no page data.
      if (at.externalUrl) continue;
      const num = at.chapter !== null && at.chapter !== undefined ? Number(at.chapter) : null;
      const base =
        num !== null && Number.isFinite(num)
          ? 'c-' + String(Math.floor(num)).padStart(4, '0') + (num % 1 ? String(num % 1).slice(1) : '')
          : 'c-' + ch.id.slice(0, 8);
      let cid = base;
      let dup = 2;
      while (usedIds.has(cid)) cid = `${base}-${dup++}`;
      usedIds.add(cid);

      out.push({
        id: cid,
        num: num !== null && Number.isFinite(num) ? num : null,
        volume: at.volume !== null && at.volume !== undefined ? Number(at.volume) || null : null,
        title: at.title || null,
        updatedAt: at.publishAt || at.updatedAt || null,
        lang: at.translatedLanguage || lang,
        src: ctx.chapterSrc(`https://mangadex.org/chapter/${ch.id}`, 'image'),
        sourceUrl: `https://mangadex.org/chapter/${ch.id}`,
      });
    }

    const total = Number(feed && feed.total) || 0;
    offset += FEED_LIMIT;
    if (offset >= total || rows.length === 0) break;
  }

  return out;
}

export async function resolveChapter(url, ctx) {
  const uuid = chapterId(url);
  if (!uuid) throw gwError('bad_url', 'Not a MangaDex chapter URL (expected /chapter/<uuid>)');

  // Metadata is best-effort — the pages are what matter.
  let num = null;
  let title = null;
  let volume = null;
  let seriesId = null;
  try {
    const meta = await ctx.fetchJson(`${API}/chapter/${uuid}`);
    const at = (meta && meta.data && meta.data.attributes) || {};
    num = at.chapter !== null && at.chapter !== undefined ? Number(at.chapter) : null;
    if (!Number.isFinite(num)) num = null;
    title = at.title || null;
    volume = at.volume !== null && at.volume !== undefined ? Number(at.volume) || null : null;
    const mangaRel = relOf(meta.data || {}, 'manga');
    if (mangaRel) seriesId = 'md:' + mangaRel.id;
  } catch {
    /* keep nulls */
  }

  const home = await ctx.fetchJson(`${API}/at-home/server/${uuid}`);
  const baseUrl = home && home.baseUrl;
  const hash = home && home.chapter && home.chapter.hash;
  const data = (home && home.chapter && home.chapter.data) || [];
  if (!baseUrl || !hash || !data.length) {
    throw gwError('parse_failed', 'MangaDex at-home returned no page data for this chapter');
  }

  const pages = data.map((f) => `${baseUrl}/data/${hash}/${f}`);

  const hosts = new Set();
  try {
    hosts.add(new URL(baseUrl).hostname);
  } catch {
    /* ignore */
  }

  return {
    chapter: {
      seriesId,
      id: 'c-' + (num !== null ? String(Math.floor(num)).padStart(4, '0') : uuid.slice(0, 8)),
      num,
      volume,
      title,
      kind: 'image',
      pages,
      sourceUrl: `https://mangadex.org/chapter/${uuid}`,
      confidence: 'high',
    },
    hosts,
    confidence: 'high',
  };
}
