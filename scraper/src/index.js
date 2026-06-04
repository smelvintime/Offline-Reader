import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { fetchSeriesList as fcSeries, fetchChapterList as fcChapters } from './sources/flamecomics.js';
import { fetchSeriesList as mdSeries, fetchChapterList as mdChapters } from './sources/mangadex.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '../../..', 'catalog.json');

// ── Configure which titles to track ──────────────────────────────────────────

// Flame Comics: series slugs (from the URL: flamecomics.xyz/manga/<slug>)
const FLAME_SLUGS = [
  'solo-leveling',
  'return-of-the-mount-hua-sect',
  'omniscient-reader',
  'player-who-cant-level-up',
  'volcanic-age',
];

// MangaDex: manga UUIDs
const MANGADEX_IDS = [
  '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0', // Jujutsu Kaisen
  'c52b2ce3-7f95-469c-96b0-479524fb7a1a', // Chainsaw Man
  'a77742b1-befd-49a4-bff5-1ad4e6b0ef7b', // One Punch Man
  'e78a489b-6632-4d61-b00b-5206f5b8b22b', // Boruto
];

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safe(label, fn) {
  try { return await fn(); }
  catch (e) { console.error(`[${label}] Error:`, e.message); return null; }
}

async function buildFlameEntry(slug) {
  const chapters = await safe(`flame:${slug}`, () => fcChapters(slug));
  if (!chapters) return null;
  return {
    id: `flame:${slug}`,
    slug,
    source: 'flamecomics',
    chapters: chapters.slice(0, 50).map(c => ({
      id: c.id,
      num: c.number != null ? Number(c.number) : null,
      title: c.title,
      updatedAt: c.date,
    })),
  };
}

async function buildMangaDexEntry(manga) {
  const chapters = await safe(`md:${manga.id}`, () => mdChapters(manga.id));
  if (!chapters) return null;
  return {
    id: `md:${manga.id}`,
    mdId: manga.id,
    source: 'mangadex',
    title: manga.title,
    cover: manga.cover,
    updatedAt: manga.updatedAt,
    chapters: chapters.slice(0, 50).map(c => ({
      mdChapterId: c.id,
      num: c.number != null ? Number(c.number) : null,
      title: c.title,
      updatedAt: c.date,
      pages: c.pages,
    })),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Fetching Flame Comics series list...');
  const flameAll = await safe('flame:list', () => fcSeries());
  const flameMap = new Map((flameAll || []).map(s => [s.slug, s]));

  console.log('Fetching MangaDex series info...');
  const mdAll = await safe('md:list', () => mdSeries(MANGADEX_IDS));

  const entries = [];

  // Flame Comics
  for (const slug of FLAME_SLUGS) {
    process.stdout.write(`  flame:${slug} ... `);
    const meta = flameMap.get(slug) || { slug, title: slug, cover: null, source: 'flamecomics', updatedAt: null };
    const entry = await buildFlameEntry(slug);
    if (entry) {
      entries.push({ ...meta, ...entry });
      console.log(`${entry.chapters.length} chapters`);
    } else {
      console.log('FAILED');
    }
  }

  // MangaDex
  for (const manga of (mdAll || [])) {
    process.stdout.write(`  md:${manga.id} (${manga.title}) ... `);
    const entry = await buildMangaDexEntry(manga);
    if (entry) {
      entries.push(entry);
      console.log(`${entry.chapters.length} chapters`);
    } else {
      console.log('FAILED');
    }
  }

  const catalog = {
    generatedAt: new Date().toISOString(),
    series: entries,
  };

  writeFileSync(OUT, JSON.stringify(catalog, null, 2));
  console.log(`\nWrote ${entries.length} series to catalog.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
