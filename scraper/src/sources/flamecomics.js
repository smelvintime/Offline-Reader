// Flame Comics — schema v2 adapter.
//
// Flame is a Next.js site, so the useful data is in the __NEXT_DATA__ blob
// rather than the markup; we fall back to parsing the DOM when the blob moves.
// Page URLs point straight at Flame's own CDN — we reference them, we never
// re-host the bytes (§8); the worker proxies them at read time.

import * as cheerio from 'cheerio';
import { getHtml, probeImage } from '../lib/http.js';
import { tidy, isoOrNull, firstOf, sleep, chapterIdFromNum, chapterSrc } from '../lib/util.js';
import { imageChapterFile } from '../lib/blocks.js';

export const id = 'flamecomics';
export const label = 'Flame Comics';

const BASE = 'https://flamecomics.xyz';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: BASE + '/',
};

export function entryId(entry) {
  return `flame:${String(entry.slug || entry.id)}`;
}

function slugOf(entry) {
  const s = entry.slug || entry.id;
  if (!s) throw new Error('flamecomics entry needs a "slug"');
  return String(s);
}

async function fetchHtml(url, ctx) {
  return getHtml(url, { headers: HEADERS, log: ctx?.log, timeout: 30000 });
}

function extractNextData(html) {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function absolutize(u) {
  if (!u) return null;
  const s = String(u).trim();
  if (!s || s.startsWith('data:')) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  return BASE + (s.startsWith('/') ? s : '/' + s);
}

const STATUS_MAP = {
  ongoing: 'ongoing', releasing: 'ongoing', publishing: 'ongoing',
  completed: 'completed', complete: 'completed', finished: 'completed',
  hiatus: 'hiatus', paused: 'hiatus',
  dropped: 'cancelled', cancelled: 'cancelled', canceled: 'cancelled',
};

// ── Listing / metadata ───────────────────────────────────────────────────────

/** The whole Flame catalogue: [{ slug, title, cover, updatedAt }]. */
export async function fetchSeriesList(ctx = {}) {
  const html = await fetchHtml(`${BASE}/manga`, ctx);
  const nd = extractNextData(html);
  const series = [];

  const posts = nd?.props?.pageProps?.posts
    || nd?.props?.pageProps?.mangas
    || nd?.props?.pageProps?.series
    || [];
  for (const p of posts) {
    if (!p) continue;
    series.push({
      slug: p.slug || p.series_slug,
      title: tidy(p.title || p.series_title),
      cover: absolutize(p.thumbnail || p.cover || p.image),
      updatedAt: isoOrNull(p.latest_chapter?.created_at ?? p.updated_at),
    });
  }

  if (!series.length) {
    const $ = cheerio.load(html);
    $('a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = href.match(/\/manga\/([^/?#]+)/)?.[1];
      if (!slug || series.some(s => s.slug === slug)) return;
      series.push({
        slug,
        title: tidy($(el).find('h3,h2,.title,span').first().text()) || tidy($(el).attr('title')) || slug,
        cover: absolutize($(el).find('img').attr('src') || $(el).find('img').attr('data-src')),
        updatedAt: null,
      });
    });
  }
  return series.filter(s => s.slug);
}

/** Series page: metadata plus the chapter list, ascending. */
export async function fetchSeriesPage(slug, ctx = {}) {
  return parseSeriesPage(await fetchHtml(`${BASE}/manga/${slug}`, ctx), slug);
}

/** Pure: series-page HTML -> { meta, chapters }. Unit-testable without a network. */
export function parseSeriesPage(html, slug) {
  const nd = extractNextData(html);
  const pp = nd?.props?.pageProps || {};
  const info = pp.series || pp.manga || pp.data?.series || pp.data || {};

  const rawChapters = pp.chapters || pp.data?.chapters || info.chapters || [];
  const chapters = [];
  for (const c of rawChapters) {
    if (!c) continue;
    const num = c.chapter_number ?? c.chapter ?? c.number ?? null;
    chapters.push({
      key: String(c.token ?? c.chapter_slug ?? c.slug ?? c.id ?? num),
      num: num != null && Number.isFinite(Number(num)) ? Number(num) : null,
      title: tidy(c.chapter_title ?? c.title) || null,
      updatedAt: isoOrNull(c.release_date ?? c.created_at ?? c.date),
    });
  }
  chapters.sort((a, b) => (a.num ?? Infinity) - (b.num ?? Infinity));

  const $ = cheerio.load(html);
  const meta = {
    title: firstOf(info.title, info.series_name, tidy($('h1').first().text()), slug),
    description: firstOf(
      info.description, info.synopsis, info.summary,
      tidy($('meta[name="description"]').attr('content')),
    ),
    author: firstOf(info.author, info.authors),
    artist: firstOf(info.artist, info.artists),
    cover: absolutize(firstOf(info.cover, info.thumbnail, info.image, $('meta[property="og:image"]').attr('content'))),
    status: STATUS_MAP[String(info.status || '').toLowerCase().trim()] || 'unknown',
    genres: []
      .concat(info.genres || info.tags || [])
      .map(g => tidy(typeof g === 'string' ? g : g?.name))
      .filter(Boolean),
    updatedAt: isoOrNull(info.updated_at ?? info.last_updated),
  };
  return { meta, chapters };
}

/** Direct CDN image URLs for one chapter. */
export async function fetchChapterImages(slug, chapterKey, ctx = {}) {
  return parseChapterImages(await fetchHtml(`${BASE}/manga/${slug}/${chapterKey}`, ctx));
}

/** Pure: reader-page HTML -> ordered page URLs. */
export function parseChapterImages(html) {
  const nd = extractNextData(html);
  const images = [];

  const pp = nd?.props?.pageProps || {};
  let pages = pp.chapter?.chapter_image || pp.images || pp.pages || pp.data?.images || [];
  if (pages && !Array.isArray(pages) && typeof pages === 'object') pages = Object.values(pages);
  for (const p of pages || []) {
    const src = absolutize(typeof p === 'string' ? p : (p?.image || p?.url || p?.src || p?.name));
    if (src) images.push(src);
  }

  if (!images.length) {
    const $ = cheerio.load(html);
    $('#readerarea img, .reading-content img, main img').each((_, el) => {
      const src = absolutize($(el).attr('src') || $(el).attr('data-src'));
      if (src) images.push(src);
    });
  }
  return [...new Set(images)];
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export async function build(entry, ctx) {
  const slug = slugOf(entry);
  const sid = entryId(entry);
  const log = ctx.log;
  const maxChapters = entry.maxChapters ?? ctx.defaults?.maxChapters ?? 24;
  const maxFetches = entry.maxPageFetches ?? ctx.defaults?.maxPageFetches ?? maxChapters;

  const { meta, chapters: list } = await fetchSeriesPage(slug, ctx);
  if (!list.length) throw new Error('no chapters found on the series page');

  const total = list.length;
  const wanted = list.slice(0, Math.min(maxChapters, maxFetches));

  const cover = meta.cover && await probeImage(meta.cover, { log }) ? meta.cover : null;
  if (meta.cover && !cover) log.debug(`    cover did not resolve, dropping: ${meta.cover}`);

  const files = [];
  const chapters = [];
  const usedIds = new Set();
  let pageTotal = 0;

  for (const c of wanted) {
    let pages;
    try {
      pages = await fetchChapterImages(slug, c.key, ctx);
    } catch (e) {
      log.debug(`    chapter ${c.num ?? c.key} pages failed: ${e.message}`);
      continue;
    }
    if (!pages.length) {
      log.debug(`    chapter ${c.num ?? c.key} has no pages — skipped`);
      continue;
    }
    let cid = chapterIdFromNum(c.num, c.key);
    while (usedIds.has(cid)) cid += '-b';
    usedIds.add(cid);

    files.push(imageChapterFile({ seriesId: sid, id: cid, num: c.num, title: c.title, pages }));
    chapters.push({
      id: cid,
      num: c.num,
      volume: null,
      title: c.title,
      updatedAt: c.updatedAt,
      lang: entry.language || ctx.language || 'en',
      src: chapterSrc(sid, cid),
    });
    pageTotal += pages.length;
    await sleep(400);
  }

  if (!chapters.length) throw new Error(`no chapter pages could be resolved (${total} chapters listed)`);

  const truncated = total > chapters.length;
  const description = [
    firstOf(entry.description, meta.description),
    truncated ? `This sample lists the first ${chapters.length} of ${total} chapters.` : null,
  ].filter(Boolean).join('\n\n') || null;

  const series = {
    id: sid,
    type: entry.type,
    title: firstOf(entry.title, meta.title, slug),
    altTitles: entry.altTitles || [],
    cover,
    description,
    author: firstOf(entry.author, meta.author),
    artist: firstOf(entry.artist, meta.artist),
    status: entry.status || meta.status || 'unknown',
    genres: entry.genres || meta.genres || [],
    tags: [],
    language: entry.language || ctx.language || 'en',
    source: 'flamecomics',
    sourceUrl: `${BASE}/manga/${slug}`,
    readingDirection: entry.readingDirection || 'vertical',
    updatedAt: meta.updatedAt,
    chapterCount: chapters.length,
    chapters,
  };

  return { series, files, stats: { words: 0, pages: pageTotal, truncatedFrom: truncated ? total : null } };
}
