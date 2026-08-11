// Adapter registry, selection order, and each adapter driven against fixtures
// through a fake ctx (no network).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTERS,
  selectAdapter,
  selectListAdapter,
  listAdapters,
  adapterIds,
  getAdapter,
  isValidAdapter,
} from '../src/adapters/index.js';
import * as genericNovel from '../src/adapters/generic-novel.js';
import * as genericManga from '../src/adapters/generic-manga.js';
import { decideKind } from '../src/adapters/_generic.js';
import { parseHtml } from '../src/lib/html.js';
import { ALLOWED_BLOCK_TYPES } from '../src/lib/blocks.js';
import { fixture } from './helpers.js';

const GW = 'https://gw.test';

/** A ctx that serves fixtures by URL instead of fetching. */
function fakeCtx(pages = {}, jsons = {}) {
  const fetched = [];
  return {
    env: {},
    fetched,
    workerBase: GW,
    async fetchHtml(url) {
      fetched.push(url);
      const body = pages[url];
      if (body === undefined) throw new Error('no fixture for ' + url);
      return { root: parseHtml(body), html: body, finalUrl: url };
    },
    async fetchJson(url) {
      fetched.push(url);
      for (const [pattern, payload] of Object.entries(jsons)) {
        if (url.includes(pattern)) return typeof payload === 'function' ? payload(url) : payload;
      }
      throw new Error('no json fixture for ' + url);
    },
    chapterSrc(url, kind) {
      const qs = new URLSearchParams({ url });
      if (kind) qs.set('kind', kind);
      return `${GW}/chapter?${qs.toString()}`;
    },
    imageSrc(url) {
      return `${GW}/image?url=${encodeURIComponent(url)}`;
    },
  };
}

describe('registry', () => {
  test('adapters are sorted by ascending priority', () => {
    const p = ADAPTERS.map((a) => a.priority);
    assert.deepEqual(p, [...p].sort((a, b) => a - b));
  });

  test('every adapter satisfies the §6.5 interface', () => {
    for (const a of ADAPTERS) {
      assert.equal(typeof a.id, 'string');
      assert.equal(typeof a.label, 'string');
      assert.equal(typeof a.priority, 'number');
      assert.equal(typeof a.matches, 'function');
      assert.equal(typeof a.resolveSeries, 'function');
      assert.equal(typeof a.resolveChapter, 'function');
      // The two OPTIONAL listing members: absent OR a function, nothing else.
      assert.ok(a.listSeries === undefined || typeof a.listSeries === 'function');
      assert.ok(a.listMatches === undefined || typeof a.listMatches === 'function');
    }
  });

  test('a malformed optional listing member is a boot error', () => {
    const base = {
      id: 'x',
      label: 'x',
      priority: 50,
      matches: () => true,
      resolveSeries: async () => ({}),
      resolveChapter: async () => ({}),
    };
    assert.equal(isValidAdapter(base), true);
    assert.equal(isValidAdapter({ ...base, listSeries: async () => ({}) }), true);
    assert.equal(isValidAdapter({ ...base, listMatches: () => true }), true);
    assert.equal(isValidAdapter({ ...base, listSeries: 42 }), false);
    assert.equal(isValidAdapter({ ...base, listSeries: 'yes' }), false);
    assert.equal(isValidAdapter({ ...base, listMatches: {} }), false);
  });

  test('ids are unique', () => {
    const ids = adapterIds();
    assert.equal(new Set(ids).size, ids.length);
  });

  test('listAdapters reports id/label/priority/canList', () => {
    for (const a of listAdapters()) {
      assert.deepEqual(Object.keys(a).sort(), ['canList', 'id', 'label', 'priority']);
      assert.equal(typeof a.canList, 'boolean');
    }
  });

  test('getAdapter looks up by id', () => {
    assert.equal(getAdapter('generic-manga').id, 'generic-manga');
    assert.equal(getAdapter('nope'), null);
  });

  // §8: the registry is general-purpose. A site-specific adapter is a statement
  // about what the gateway is for, and this one is for whatever its operator
  // points it at.
  test('no adapter names a particular site', () => {
    assert.deepEqual(adapterIds().sort(), ['generic-manga', 'generic-novel']);
  });
});

describe('selectAdapter — lowest priority among matches wins', () => {
  test('comic-shaped URLs go to generic-manga', () => {
    assert.equal(selectAdapter('https://scansite.test/manga/tin-quarter/').id, 'generic-manga');
    assert.equal(selectAdapter('https://x.test/webtoon/abc').id, 'generic-manga');
    assert.equal(selectAdapter('https://komiksite.test/read/xyz/').id, 'generic-manga');
  });

  test('everything else falls through to generic-novel', () => {
    assert.equal(selectAdapter('https://wandering-ink.test/salt-road/').id, 'generic-novel');
    assert.equal(selectAdapter('https://someblog.example.com/story/part-3').id, 'generic-novel');
  });

  test('an explicit kind=image lets generic-manga claim a neutral URL', () => {
    assert.equal(selectAdapter('https://neutral.example.com/x/5', { kind: 'image' }).id, 'generic-manga');
    assert.equal(selectAdapter('https://neutral.example.com/x/5', { kind: 'text' }).id, 'generic-novel');
  });

  test('force pins a specific adapter', () => {
    assert.equal(selectAdapter('https://anything.example.com/', { force: 'generic-manga' }).id, 'generic-manga');
    assert.equal(selectAdapter('https://anything.example.com/', { force: 'ghost' }), null);
  });

  test('a throwing matches() does not break selection', () => {
    // generic-novel matches everything, so a bad URL still resolves to it.
    assert.equal(selectAdapter('not a url at all').id, 'generic-novel');
  });

  test('generic-novel is the universal fallback', () => {
    assert.equal(genericNovel.matches('https://anything.example.com/'), true);
    assert.equal(genericNovel.priority > genericManga.priority, true);
  });
});

describe('selectListAdapter — §6.6 listing capability routing', () => {
  test('comic-shaped URLs list through generic-manga, everything else generic-novel', () => {
    assert.equal(selectListAdapter('https://scansite.test/manga/').id, 'generic-manga');
    assert.equal(selectListAdapter('https://wandering-ink.test/browse/').id, 'generic-novel');
  });

  test('force pins by id but never onto a non-listing adapter or a ghost', () => {
    assert.equal(
      selectListAdapter('https://anything.example.com/', { force: 'generic-manga' }).id,
      'generic-manga',
    );
    assert.equal(selectListAdapter('https://anything.example.com/', { force: 'ghost' }), null);
  });
});

describe('generic listSeries against the listing fixture', () => {
  const listUrl = 'https://wandering-ink.test/browse/';

  test('extracts source, items with covers, and the nextUrl', async () => {
    const ctx = fakeCtx({ [listUrl]: fixture('listing-page.html') });
    const out = await genericNovel.listSeries(listUrl, ctx);

    assert.ok(out, 'expected a listing');
    assert.equal(out.source.title, 'Wandering Ink');
    assert.equal(out.source.url, listUrl);
    assert.equal(out.items.length, 20);
    assert.equal(out.nextUrl, 'https://wandering-ink.test/browse/?page=2');

    const first = out.items[0];
    assert.equal(first.title, 'The Salt Road');
    assert.equal(first.url, 'https://wandering-ink.test/series/the-salt-road/');
    assert.equal(first.cover, 'https://cdn1.wi-img.gwfixture.org/thumbs/salt-road.jpg');
    assert.equal(first.type, 'webnovel');
  });

  test('every item keeps its own cover — no shared-grid bleed', async () => {
    const ctx = fakeCtx({ [listUrl]: fixture('listing-page.html') });
    const out = await genericNovel.listSeries(listUrl, ctx);
    const covers = out.items.map((i) => i.cover).filter(Boolean);
    assert.equal(covers.length, 18, 'two fixture cards have no cover');
    assert.equal(new Set(covers).size, covers.length, 'covers must be per-item, not repeated');
  });

  test('the listing never mints ids and never leaks nav/pagination links', async () => {
    const ctx = fakeCtx({ [listUrl]: fixture('listing-page.html') });
    const out = await genericNovel.listSeries(listUrl, ctx);
    for (const it of out.items) {
      assert.equal('id' in it, false, 'listing items must not carry series ids');
      assert.match(it.url, /\/series\//);
    }
  });

  test('generic-manga hints type manga instead', async () => {
    const ctx = fakeCtx({ [listUrl]: fixture('listing-page.html') });
    const out = await genericManga.listSeries(listUrl, ctx);
    assert.equal(out.items[0].type, 'manga');
  });

  test('returns null on a page with no listing (the handler turns it into list_failed)', async () => {
    const url = 'https://thin.example.com/';
    const ctx = fakeCtx({ [url]: '<html><body><p>Nothing to browse.</p></body></html>' });
    assert.equal(await genericNovel.listSeries(url, ctx), null);
  });
});

describe('generic-novel against the fixtures', () => {
  const seriesUrl = 'https://wandering-ink.test/salt-road/';
  const page2 = 'https://wandering-ink.test/salt-road/?page=2';
  const chapterUrl = 'https://wandering-ink.test/salt-road/chapter-12';

  test('resolveSeries normalizes to a §1.1 Series', async () => {
    const ctx = fakeCtx({
      [seriesUrl]: fixture('novel-series.html'),
      [page2]: fixture('novel-series-page2.html'),
    });
    const { series, confidence } = await genericNovel.resolveSeries(seriesUrl, ctx);

    assert.equal(series.title, 'The Salt Road');
    assert.equal(series.type, 'webnovel');
    assert.equal(series.author, 'P. Navarre');
    assert.equal(series.status, 'ongoing');
    assert.equal(series.cover, 'https://img.wandering-ink.test/covers/salt-road.jpg');
    assert.equal(series.source, 'generic-novel');
    assert.ok(series.id.startsWith('user:'), `id was ${series.id}`);
    assert.equal(confidence, 'high');
    assert.ok(series.genres.includes('Fantasy'));
  });

  test('capped rel=next pagination merges page 2', async () => {
    const ctx = fakeCtx({
      [seriesUrl]: fixture('novel-series.html'),
      [page2]: fixture('novel-series-page2.html'),
    });
    const { series } = await genericNovel.resolveSeries(seriesUrl, ctx);
    assert.equal(series.chapters.length, 15, 'expected 8 + 7 chapters');
    assert.equal(series.chapterCount, 15);
  });

  test('chapters are ascending and carry a worker /chapter src', async () => {
    const ctx = fakeCtx({
      [seriesUrl]: fixture('novel-series.html'),
      [page2]: fixture('novel-series-page2.html'),
    });
    const { series } = await genericNovel.resolveSeries(seriesUrl, ctx);
    const nums = series.chapters.map((c) => c.num);
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    for (const ch of series.chapters) {
      assert.ok(ch.src.startsWith(`${GW}/chapter?`), `bad src ${ch.src}`);
      assert.match(ch.src, /kind=text/);
      assert.ok(ch.id, 'chapter needs an id');
    }
    assert.equal(new Set(series.chapters.map((c) => c.id)).size, 15, 'ids must be unique');
    assert.equal(series.chapters[11].title, 'The Salt Road');
  });

  test('a dead pagination page does not fail the whole resolve', async () => {
    const ctx = fakeCtx({ [seriesUrl]: fixture('novel-series.html') }); // page 2 missing
    const { series } = await genericNovel.resolveSeries(seriesUrl, ctx);
    assert.equal(series.chapters.length, 8);
  });

  test('resolveChapter emits typed blocks, never HTML', async () => {
    const ctx = fakeCtx({ [chapterUrl]: fixture('novel-chapter.html') });
    const { chapter, confidence } = await genericNovel.resolveChapter(chapterUrl, ctx);

    assert.equal(chapter.kind, 'text');
    assert.ok(Array.isArray(chapter.blocks));
    assert.ok(chapter.blocks.length > 8, `only ${chapter.blocks.length} blocks`);
    assert.ok(chapter.wordCount > 300, `wordCount ${chapter.wordCount}`);
    assert.equal(confidence, 'high');
    assert.equal(chapter.title, 'The Salt Road');

    for (const b of chapter.blocks) {
      assert.ok(ALLOWED_BLOCK_TYPES.has(b.t), `illegal block type ${b.t}`);
      assert.equal('html' in b, false, 'blocks must never carry HTML');
    }
    const dump = JSON.stringify(chapter.blocks);
    assert.ok(!dump.includes('<script'), 'script tag leaked into blocks');
    assert.ok(!dump.includes('goes so hard'), 'comment text leaked');
  });

  test('honest degradation: a thin page still returns what it found', async () => {
    const url = 'https://thin.example.com/x';
    const ctx = fakeCtx({
      [url]: '<html><body><div id="main"><p>Only one short line of prose.</p></div></body></html>',
    });
    const { chapter, confidence } = await genericNovel.resolveChapter(url, ctx);
    assert.equal(confidence, 'low');
    assert.equal(chapter.confidence, 'low');
    assert.equal(chapter.kind, 'text');
    assert.ok(chapter.blocks.length >= 1, 'should return the little it found');
  });
});

describe('generic-manga against the fixtures', () => {
  const seriesUrl = 'https://scansite.test/manga/tin-quarter/';
  const chapterUrl = 'https://scansite.test/manga/tin-quarter/chapter-42/';

  test('resolveSeries produces a manga Series', async () => {
    const ctx = fakeCtx({ [seriesUrl]: fixture('manga-series.html') });
    const { series } = await genericManga.resolveSeries(seriesUrl, ctx);
    assert.equal(series.title, 'Tin Quarter');
    assert.equal(series.type, 'manga');
    assert.equal(series.readingDirection, 'ltr');
    assert.equal(series.author, 'R. Adeyemi');
    assert.equal(series.chapters.length, 6);
    assert.deepEqual(series.chapters.map((c) => c.num), [40, 41, 42, 43, 44, 45]);
    for (const ch of series.chapters) assert.match(ch.src, /kind=image/);
  });

  test('resolveChapter returns the ordered page list', async () => {
    const ctx = fakeCtx({ [chapterUrl]: fixture('manga-chapter.html') });
    const { chapter, hosts, confidence } = await genericManga.resolveChapter(chapterUrl, ctx);
    assert.equal(chapter.kind, 'image');
    assert.equal(chapter.pages.length, 8);
    assert.equal(confidence, 'high');
    assert.equal(chapter.pages[0], 'https://cdn.scansite.test/uploads/tin-quarter/42/001.webp');
    // The CDN host is reported so /resolve can allowlist it.
    assert.ok([...hosts].includes('cdn.scansite.test'));
  });

  test('the image CDN host is surfaced for the allowlist', async () => {
    const ctx = fakeCtx({ [chapterUrl]: fixture('manga-chapter.html') });
    const { hosts } = await genericManga.resolveChapter(chapterUrl, ctx);
    assert.ok(!([...hosts].includes('ads.scansite.test')), 'must not learn ad hosts');
  });
});

describe('kind is a hint the adapter may override (§6.3)', () => {
  test('a page full of sequential images is an image chapter regardless of the hint', () => {
    const r = decideKind({
      hint: 'text',
      bias: 'text',
      proseChars: 120,
      imageCount: 20,
      imageRun: { confidence: 'high' },
    });
    assert.equal(r, 'image');
  });

  test('a page full of prose is a text chapter regardless of the hint', () => {
    const r = decideKind({ hint: 'image', bias: 'image', proseChars: 9000, imageCount: 1 });
    assert.equal(r, 'text');
  });

  test('an illustrated novel stays text', () => {
    const r = decideKind({
      hint: undefined, bias: 'text', proseChars: 8000, imageCount: 4,
      imageRun: { confidence: 'medium' },
    });
    assert.equal(r, 'text');
  });

  test('ambiguous pages fall back to the hint, then the bias', () => {
    assert.equal(decideKind({ hint: 'image', bias: 'text', proseChars: 50, imageCount: 0 }), 'image');
    assert.equal(decideKind({ hint: undefined, bias: 'image', proseChars: 50, imageCount: 0 }), 'image');
    assert.equal(decideKind({ hint: undefined, bias: 'text', proseChars: 50, imageCount: 0 }), 'text');
  });

  test('generic-novel flips to image when the page is really a manga chapter', async () => {
    const url = 'https://scansite.test/manga/tin-quarter/chapter-42/';
    const ctx = fakeCtx({ [url]: fixture('manga-chapter.html') });
    const { chapter } = await genericNovel.resolveChapter(url, ctx);
    assert.equal(chapter.kind, 'image');
    assert.equal(chapter.pages.length, 8);
  });
});

