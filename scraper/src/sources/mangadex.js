import axios from 'axios';

const API = 'https://api.mangadex.org';
const HEADERS = { 'User-Agent': 'offline-reader-scraper/1.0' };

async function get(path, params = {}) {
  const res = await axios.get(`${API}${path}`, { params, headers: HEADERS, timeout: 15000 });
  return res.data;
}

function getAttr(entity, key) {
  return entity?.attributes?.[key] ?? null;
}

function getTitle(attributes) {
  const t = attributes.title || {};
  return t.en || Object.values(t)[0] || 'Unknown';
}

function getCoverUrl(mangaId, filename) {
  return `https://uploads.mangadex.org/covers/${mangaId}/${filename}`;
}

// Returns array of { id, title, cover, source, latestChapter, updatedAt }
export async function fetchSeriesList(mangaIds) {
  if (!mangaIds?.length) return [];

  const data = await get('/manga', {
    ids: mangaIds,
    includes: ['cover_art'],
    limit: mangaIds.length,
    contentRating: ['safe', 'suggestive'],
  });

  return (data.data || []).map(manga => {
    const attrs = manga.attributes;
    const coverRel = manga.relationships?.find(r => r.type === 'cover_art');
    const coverFile = coverRel?.attributes?.fileName;
    const cover = coverFile ? getCoverUrl(manga.id, coverFile) : null;

    return {
      id: manga.id,
      title: getTitle(attrs),
      cover,
      source: 'mangadex',
      latestChapter: null,
      updatedAt: attrs.updatedAt ?? null,
    };
  });
}

// Returns array of { id, number, title, date } — stores chapter IDs only (images fetched at read time)
export async function fetchChapterList(mangaId, lang = 'en') {
  const chapters = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const data = await get('/manga/' + mangaId + '/feed', {
      translatedLanguage: [lang],
      order: { chapter: 'desc' },
      limit,
      offset,
      includes: ['scanlation_group'],
    });

    for (const ch of data.data || []) {
      chapters.push({
        id: ch.id,
        number: ch.attributes.chapter ?? null,
        title: ch.attributes.title ?? null,
        date: ch.attributes.publishAt ?? null,
        pages: ch.attributes.pages ?? 0,
      });
    }

    if (offset + limit >= (data.total || 0)) break;
    offset += limit;
  }

  return chapters;
}

// Fetches at-home server image URLs for a chapter (called at read time, not stored in catalog)
export async function fetchChapterImages(chapterId) {
  const data = await get('/at-home/server/' + chapterId);
  const { baseUrl, chapter } = data;
  return (chapter.data || []).map(f => `${baseUrl}/data/${chapter.hash}/${f}`);
}
