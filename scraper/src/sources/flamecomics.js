import axios from 'axios';
import * as cheerio from 'cheerio';

const BASE = 'https://flamecomics.xyz';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': BASE + '/',
};

async function fetchHtml(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return res.data;
}

function extractNextData(html) {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').text();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// Returns array of { slug, title, cover, latestChapter, updatedAt }
export async function fetchSeriesList() {
  // Flame Comics manga listing page
  const html = await fetchHtml(`${BASE}/manga`);
  const nd = extractNextData(html);
  const series = [];

  if (nd) {
    // Try to pull from __NEXT_DATA__ props
    const posts = nd?.props?.pageProps?.posts
      || nd?.props?.pageProps?.mangas
      || nd?.props?.pageProps?.series
      || [];
    for (const p of posts) {
      series.push({
        slug: p.slug || p.series_slug,
        title: p.title || p.series_title,
        cover: p.thumbnail || p.cover || p.image,
        source: 'flamecomics',
        latestChapter: p.latest_chapter?.chapter_number ?? null,
        updatedAt: p.latest_chapter?.created_at ?? p.updated_at ?? null,
      });
    }
  }

  if (!series.length) {
    // Fallback: parse series cards from HTML
    const $ = cheerio.load(html);
    $('a[href*="/manga/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const slug = href.match(/\/manga\/([^/?#]+)/)?.[1];
      if (!slug || series.some(s => s.slug === slug)) return;
      const title = $(el).find('h3,h2,.title,span').first().text().trim()
        || $(el).attr('title') || slug;
      const cover = $(el).find('img').attr('src') || $(el).find('img').attr('data-src') || null;
      series.push({ slug, title, cover, source: 'flamecomics', latestChapter: null, updatedAt: null });
    });
  }

  return series;
}

// Returns array of { id, number, title, date }
export async function fetchChapterList(slug) {
  const html = await fetchHtml(`${BASE}/manga/${slug}`);
  const nd = extractNextData(html);
  const chapters = [];

  if (nd) {
    const raw = nd?.props?.pageProps?.chapters
      || nd?.props?.pageProps?.data?.chapters
      || [];
    for (const c of raw) {
      chapters.push({
        id: c.chapter_slug || c.slug || String(c.id),
        number: c.chapter_number ?? c.chapter,
        title: c.chapter_title ?? c.title ?? null,
        date: c.created_at ?? c.date ?? null,
      });
    }
  }

  return chapters.sort((a, b) => Number(b.number) - Number(a.number));
}

// Returns array of direct CDN image URLs for a chapter
export async function fetchChapterImages(slug, chapterId) {
  const url = `${BASE}/manga/${slug}/${chapterId}`;
  const html = await fetchHtml(url);
  const nd = extractNextData(html);
  const images = [];

  if (nd) {
    // Look for pages array in various locations
    const pages = nd?.props?.pageProps?.chapter?.chapter_image
      || nd?.props?.pageProps?.images
      || nd?.props?.pageProps?.pages
      || nd?.props?.pageProps?.data?.images
      || [];
    for (const p of pages) {
      const src = typeof p === 'string' ? p : (p.image || p.url || p.src);
      if (src) images.push(src);
    }
  }

  if (!images.length) {
    // Fallback: parse reader area images
    const $ = cheerio.load(html);
    $('#readerarea p img, #readerarea img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.includes('data:')) images.push(src);
    });
  }

  return images;
}
