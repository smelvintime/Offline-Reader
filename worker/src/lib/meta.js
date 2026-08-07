// meta.js — Open Graph / JSON-LD / <meta> extraction.
//
// Reader sites almost always emit OG tags and often JSON-LD. Reading them beats
// guessing from the DOM, so every adapter calls this *first* and only falls back
// to heuristics for whatever is still missing.

import { attr, byTag, findFirst, getText, rawText, walk, isElement } from './html.js';

const MAX_JSONLD_BYTES = 512 * 1024;

/** Absolute URL, or '' if the href is unusable / not http(s). */
export function absolutize(href, base) {
  if (!href) return '';
  const s = String(href).trim();
  if (!s || s.startsWith('#')) return '';
  if (/^(javascript|data|mailto|tel|blob|about|file|ftp):/i.test(s)) return '';
  try {
    const u = new URL(s, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    u.hash = '';
    return u.href;
  } catch {
    return '';
  }
}

function metaMap(root) {
  const out = new Map();
  for (const m of byTag(root, 'meta')) {
    const key = (m.attrs.property || m.attrs.name || m.attrs.itemprop || '').toLowerCase();
    const val = m.attrs.content || '';
    if (key && val && !out.has(key)) out.set(key, val);
  }
  return out;
}

/** Flatten JSON-LD: unwrap @graph, arrays, and nested objects one level deep. */
function jsonLdNodes(root) {
  const nodes = [];
  for (const s of byTag(root, 'script')) {
    const type = (s.attrs.type || '').toLowerCase();
    if (!type.includes('ld+json')) continue;
    const body = rawText(s).trim();
    if (!body || body.length > MAX_JSONLD_BYTES) continue;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Some sites emit trailing commas / HTML comments around the JSON.
      try {
        parsed = JSON.parse(body.replace(/^\s*<!--/, '').replace(/-->\s*$/, ''));
      } catch {
        continue;
      }
    }
    const push = (v) => {
      if (!v || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        v.forEach(push);
        return;
      }
      nodes.push(v);
      if (Array.isArray(v['@graph'])) v['@graph'].forEach(push);
    };
    push(parsed);
  }
  return nodes;
}

function ldString(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return ldString(v[0]);
  if (typeof v === 'object') return ldString(v.name || v.url || v['@id'] || v.headline);
  return '';
}

function ldList(v) {
  if (!v) return [];
  if (typeof v === 'string') return v.split(/\s*,\s*/).filter(Boolean);
  if (Array.isArray(v)) return v.map(ldString).filter(Boolean);
  return [ldString(v)].filter(Boolean);
}

const LD_CONTENT_TYPES = new Set([
  'book', 'article', 'newsarticle', 'blogposting', 'creativework', 'creativeworkseries',
  'comicseries', 'comicstory', 'comicissue', 'periodical', 'tvseries', 'webpage', 'chapter',
]);

/**
 * Everything a page will volunteer about itself.
 * @returns {{title,description,cover,author,artist,siteName,canonical,genres,status,lang,type,published,modified,jsonld}}
 */
export function extractMeta(root, baseUrl) {
  const m = metaMap(root);
  const pick = (...keys) => {
    for (const k of keys) {
      const v = m.get(k);
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  const ld = jsonLdNodes(root);
  const contentLd =
    ld.find((n) => LD_CONTENT_TYPES.has(String(n['@type'] || '').toLowerCase())) ||
    ld.find((n) => n.name || n.headline) ||
    {};

  const htmlEl = findFirst(root, (n) => n.tag === 'html');
  const titleEl = findFirst(root, (n) => n.tag === 'title');
  const canonicalEl = findFirst(
    root,
    (n) => n.tag === 'link' && (n.attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical'),
  );

  const rawTitle =
    pick('og:title', 'twitter:title', 'title') ||
    ldString(contentLd.name || contentLd.headline) ||
    (titleEl ? getText(titleEl) : '');

  const siteName = pick('og:site_name', 'application-name') || '';

  const cover = absolutize(
    pick('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image') ||
      ldString(contentLd.image || contentLd.thumbnailUrl),
    baseUrl,
  );

  const author =
    pick('author', 'article:author', 'book:author', 'twitter:creator') ||
    ldString(contentLd.author) ||
    ldString(contentLd.creator) ||
    '';

  const genres = [
    ...new Set([
      ...ldList(contentLd.genre),
      ...ldList(contentLd.keywords).slice(0, 12),
      ...(pick('keywords') ? pick('keywords').split(/\s*,\s*/).slice(0, 12) : []),
    ]),
  ]
    .map((g) => g.trim())
    .filter((g) => g && g.length <= 40)
    .slice(0, 15);

  return {
    title: cleanTitle(rawTitle, siteName),
    rawTitle,
    description:
      pick('og:description', 'twitter:description', 'description') ||
      ldString(contentLd.description) ||
      '',
    cover,
    author,
    artist: ldString(contentLd.illustrator) || '',
    siteName,
    canonical: canonicalEl ? absolutize(attr(canonicalEl, 'href'), baseUrl) : '',
    genres,
    status: normalizeStatus(ldString(contentLd.creativeWorkStatus) || pick('status')),
    lang: (htmlEl ? attr(htmlEl, 'lang') : '').slice(0, 8).toLowerCase() || '',
    type: pick('og:type') || String(contentLd['@type'] || '').toLowerCase(),
    published: ldString(contentLd.datePublished) || pick('article:published_time') || '',
    modified: ldString(contentLd.dateModified) || pick('article:modified_time') || '',
    jsonld: contentLd,
  };
}

/** Strip the "| Site Name" / "- Site Name" suffix reader sites append. */
export function cleanTitle(title, siteName) {
  let t = String(title || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (siteName) {
    const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`\\s*[|·–—\\-–:]\\s*${esc}\\s*$`, 'i'), '').trim();
    t = t.replace(new RegExp(`^\\s*${esc}\\s*[|·–—\\-–:]\\s*`, 'i'), '').trim();
  }
  // Generic tail: " - Read Manga Online", " | NovelSite"
  t = t.replace(
    /\s*[|·–—\-]\s*(read|free|online|manga|manhwa|webtoon|novel|light novel|chapter list)[^|·–—\-]{0,40}$/i,
    '',
  );
  return t.trim() || String(title || '').trim();
}

const STATUS_MAP = [
  [/(ongoing|publishing|releasing|serializ|连载|連載)/i, 'ongoing'],
  [/(completed|finished|complete|end(ed)?|完结|完結)/i, 'completed'],
  [/(hiatus|paused|on hold)/i, 'hiatus'],
  [/(cancel|dropped|abandon)/i, 'cancelled'],
];

export function normalizeStatus(input) {
  const s = String(input || '');
  if (!s) return 'unknown';
  for (const [re, val] of STATUS_MAP) if (re.test(s)) return val;
  return 'unknown';
}

/**
 * Sniff series metadata from the "Author: X / Status: Y / Genres: A, B" info
 * blocks reader sites render. Cheap and surprisingly effective.
 */
export function sniffInfoPairs(root) {
  const out = {};
  const LABELS = {
    author: /^\s*(author|writer|novelist|작가|作者)\s*[::]?\s*$/i,
    artist: /^\s*(artist|illustrator|art)\s*[::]?\s*$/i,
    status: /^\s*(status|state)\s*[::]?\s*$/i,
    genres: /^\s*(genres?|categor(y|ies)|tags?)\s*[::]?\s*$/i,
  };
  walk(root, (n) => {
    if (!isElement(n)) return;
    if (!['dt', 'th', 'strong', 'b', 'span', 'div', 'label', 'h4'].includes(n.tag)) return;
    const label = getText(n);
    if (!label || label.length > 24) return;
    for (const [key, re] of Object.entries(LABELS)) {
      if (out[key] || !re.test(label)) continue;
      // Value is the next element sibling, or the remainder of the parent's text.
      const parent = n.parent;
      if (!parent) continue;
      const idx = parent.children.indexOf(n);
      let value = '';
      for (let i = idx + 1; i < parent.children.length && !value; i++) {
        value = getText(parent.children[i]).trim();
      }
      if (!value) {
        const whole = getText(parent);
        value = whole.slice(whole.toLowerCase().indexOf(label.toLowerCase()) + label.length).trim();
        value = value.replace(/^[::\-–—]\s*/, '');
      }
      value = value.split('\n')[0].trim();
      if (value && value.length <= 300) out[key] = value;
    }
  });
  if (out.genres) {
    out.genres = out.genres
      .split(/\s*[,،、·|/]\s*/)
      .map((g) => g.trim())
      .filter((g) => g && g.length <= 40)
      .slice(0, 15);
  }
  if (out.status) out.status = normalizeStatus(out.status);
  return out;
}
