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
import * as mangadex from '../src/adapters/mangadex.js';
import * as genericNovel from '../src/adapters/generic-novel.js';
import * as genericManga from '../src/adapters/generic-manga.js';
import { decideKind } from '../src/adapters/_generic.js';
import { parseHtml } from '../src/lib/html.js';
import { ALLOWED_BLOCK_TYPES } from '../src/lib/blocks.js';
import { fixture } from './helpers.js';

const MD_UUID = '32d76d19-8a05-4db0-9fc2-e0b0648fe9d0';
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
    assert.equal(getAdapter('mangadex').id, 'mangadex');
    assert.equal(getAdapter('nope'), null);
  });
});

describe('selectAdapter — lowest priority among matches wins', () => {
  test('MangaDex title and chapter URLs go to the mangadex adapter', () => {
    assert.equal(selectAdapter(`https://mangadex.org/title/${MD_UUID}`).id, 'mangadex');
    assert.equal(selectAdapter(`https://mangadex.org/chapter/${MD_UUID}`).id, 'mangadex');
    assert.equal(selectAdapter(`https://www.mangadex.org/title/${MD_UUID}/some-slug`).id, 'mangadex');
  });

  test('a MangaDex URL that is not a title/chapter falls through', () => {
    assert.notEqual(selectAdapter('https://mangadex.org/titles/latest').id, 'mangadex');
  });

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

  test('mangadex.matches is strict about host and path', () => {
    assert.equal(mangadex.matches('https://mangadex.org.evil.test/title/' + MD_UUID), false);
    assert.equal(mangadex.matches('https://mangadex.org/title/not-a-uuid'), false);
    assert.equal(mangadex.matches('https://example.com/title/' + MD_UUID), false);
  });

  test('generic-novel is the universal fallback', () => {
    assert.equal(genericNovel.matches('https://anything.example.com/'), true);
    assert.equal(genericNovel.priority > genericManga.priority, true);
    assert.equal(genericManga.priority > mangadex.priority, true);
  });
});

describe('selectListAdapter — §6.6 listing capability routing', () => {
  test('MangaDex browse/search/root URLs list through the mangadex adapter', () => {
    assert.equal(selectListAdapter('https://mangadex.org/').id, 'mangadex');
    assert.equal(selectListAdapter('https://mangadex.org/titles/latest').id, 'mangadex');
    assert.equal(selectListAdapter('https://www.mangadex.org/search?q=leveling').id, 'mangadex');
  });

  test('a MangaDex title URL does NOT list through mangadex (listMatches gates it)', () => {
    // It falls through the ladder — the hostname is comic-shaped, so
    // generic-manga claims it (the priority rule, documented fall-through).
    assert.equal(selectListAdapter(`https://mangadex.org/title/${MD_UUID}`).id, 'generic-manga');
  });

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

  test('mangadex.listMatches is strict about the host', () => {
    assert.equal(mangadex.listMatches('https://mangadex.org/titles'), true);
    assert.equal(mangadex.listMatches('https://mangadex.org.evil.test/titles'), false);
    assert.equal(mangadex.listMatches('https://api.mangadex.org/manga'), false);
    assert.equal(mangadex.listMatches(`https://mangadex.org/chapter/${MD_UUID}`), false);
    assert.equal(mangadex.listMatches('not a url'), false);
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

describe('mangadex listSeries — search API', () => {
  const ID_A = 'bbbbbbbb-0000-4000-8000-000000000001';
  const ID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

  const listPayload = {
    total: 100,
    data: [
      {
        id: ID_A,
        attributes: { title: { en: 'Solo Leveling' } },
        relationships: [{ type: 'cover_art', attributes: { fileName: 'cover-a.jpg' } }],
      },
      {
        id: ID_B,
        attributes: { title: { ja: '呪術廻戦' } },
        relationships: [], // no cover_art — cover omitted, item kept
      },
    ],
  };

  test('maps the API response onto listing items', async () => {
    const ctx = fakeCtx({}, { 'api.mangadex.org/manga?': listPayload });
    const out = await mangadex.listSeries('https://mangadex.org/titles', ctx);

    assert.equal(out.source.title, 'MangaDex');
    assert.equal(out.items.length, 2);
    assert.deepEqual(out.items[0], {
      title: 'Solo Leveling',
      url: `https://mangadex.org/title/${ID_A}`,
      type: 'manga',
      cover: `https://uploads.mangadex.org/covers/${ID_A}/cover-a.jpg.256.jpg`,
    });
    assert.equal(out.items[1].cover, undefined);
    assert.equal(out.items[1].title, '呪術廻戦');
  });

  test('maps the q param onto the API title filter', async () => {
    const ctx = fakeCtx({}, { 'api.mangadex.org/manga?': listPayload });
    const out = await mangadex.listSeries('https://mangadex.org/search?q=solo%20leveling', ctx);
    assert.equal(ctx.fetched.length, 1);
    const called = new URL(ctx.fetched[0]);
    assert.equal(called.searchParams.get('title'), 'solo leveling');
    assert.equal(called.searchParams.get('limit'), '32');
    assert.equal(called.searchParams.get('order[followedCount]'), 'desc');
    assert.equal(called.searchParams.get('availableTranslatedLanguage[]'), 'en');
    assert.equal(out.source.title, 'MangaDex — solo leveling');
  });

  test('pages by offset while total remains, on a URL /list accepts back', async () => {
    const ctx = fakeCtx({}, { 'api.mangadex.org/manga?': listPayload });
    const out = await mangadex.listSeries('https://mangadex.org/titles?offset=32', ctx);
    const called = new URL(ctx.fetched[0]);
    assert.equal(called.searchParams.get('offset'), '32');
    assert.equal(out.nextUrl, 'https://mangadex.org/titles?offset=64');
    assert.equal(mangadex.listMatches(out.nextUrl), true, 'nextUrl must round-trip /list');
  });

  test('the last page carries no nextUrl', async () => {
    const lastPage = { ...listPayload, total: 34 };
    const ctx = fakeCtx({}, { 'api.mangadex.org/manga?': lastPage });
    const out = await mangadex.listSeries('https://mangadex.org/titles?offset=32', ctx);
    assert.equal(out.nextUrl, undefined);
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

describe('mangadex adapter — JSON API only', () => {
  const mangaPayload = {
    data: {
      id: MD_UUID,
      attributes: {
        title: { en: 'Jujutsu Kaisen' },
        altTitles: [{ ja: '呪術廻戦' }],
        description: { en: 'A boy swallows a cursed finger.' },
        originalLanguage: 'ja',
        status: 'ongoing',
        updatedAt: '2026-08-01T00:00:00+00:00',
        tags: [
          { attributes: { name: { en: 'Action' } } },
          { attributes: { name: { en: 'Supernatural' } } },
        ],
      },
      relationships: [
        { type: 'cover_art', attributes: { fileName: 'cover.jpg' } },
        { type: 'author', attributes: { name: 'Gege Akutami' } },
        { type: 'artist', attributes: { name: 'Gege Akutami' } },
      ],
    },
  };

  const feedPayload = {
    total: 2,
    data: [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000001',
        attributes: { chapter: '1', title: 'Ryomen Sukuna', volume: '1', translatedLanguage: 'en', publishAt: '2026-01-01T00:00:00+00:00' },
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        attributes: { chapter: '2', title: 'For Myself', volume: '1', translatedLanguage: 'en', publishAt: '2026-01-08T00:00:00+00:00' },
      },
    ],
  };

  test('resolveSeries maps the API onto a §1.1 Series', async () => {
    const ctx = fakeCtx({}, { ['/manga/' + MD_UUID + '?']: mangaPayload, '/feed?': feedPayload });
    const { series, hosts } = await mangadex.resolveSeries(`https://mangadex.org/title/${MD_UUID}`, ctx);

    assert.equal(series.id, 'md:' + MD_UUID);
    assert.equal(series.title, 'Jujutsu Kaisen');
    assert.equal(series.type, 'manga');
    assert.equal(series.author, 'Gege Akutami');
    assert.equal(series.status, 'ongoing');
    assert.equal(series.readingDirection, 'rtl', 'ja originals read right-to-left');
    assert.deepEqual(series.genres, ['Action', 'Supernatural']);
    assert.deepEqual(series.altTitles, ['呪術廻戦']);
    assert.equal(series.cover, `https://uploads.mangadex.org/covers/${MD_UUID}/cover.jpg.512.jpg`);
    assert.equal(series.chapters.length, 2);
    assert.equal(series.chapters[0].id, 'c-0001');
    assert.match(series.chapters[0].src, /^https:\/\/gw\.test\/chapter\?/);
    assert.ok([...hosts].includes('uploads.mangadex.org'));
  });

  test('only api.mangadex.org is contacted — no HTML scraping', async () => {
    const ctx = fakeCtx({}, { ['/manga/' + MD_UUID + '?']: mangaPayload, '/feed?': feedPayload });
    await mangadex.resolveSeries(`https://mangadex.org/title/${MD_UUID}`, ctx);
    assert.ok(ctx.fetched.length > 0);
    for (const u of ctx.fetched) {
      assert.ok(u.startsWith('https://api.mangadex.org/'), `unexpected fetch: ${u}`);
    }
  });

  test('resolveChapter builds page URLs from at-home', async () => {
    const chUuid = 'aaaaaaaa-0000-4000-8000-000000000001';
    const ctx = fakeCtx({}, {
      [`/chapter/${chUuid}`]: {
        data: {
          id: chUuid,
          attributes: { chapter: '1', title: 'Ryomen Sukuna', volume: '1' },
          relationships: [{ type: 'manga', id: MD_UUID }],
        },
      },
      '/at-home/server/': {
        baseUrl: 'https://cmdxd98sb0x3yprd.mangadex.network',
        chapter: { hash: 'abc123', data: ['1-x.png', '2-y.png', '3-z.png'] },
      },
    });

    const { chapter, hosts } = await mangadex.resolveChapter(`https://mangadex.org/chapter/${chUuid}`, ctx);
    assert.equal(chapter.kind, 'image');
    assert.equal(chapter.num, 1);
    assert.equal(chapter.title, 'Ryomen Sukuna');
    assert.equal(chapter.seriesId, 'md:' + MD_UUID);
    assert.deepEqual(chapter.pages, [
      'https://cmdxd98sb0x3yprd.mangadex.network/data/abc123/1-x.png',
      'https://cmdxd98sb0x3yprd.mangadex.network/data/abc123/2-y.png',
      'https://cmdxd98sb0x3yprd.mangadex.network/data/abc123/3-z.png',
    ]);
    assert.ok([...hosts].includes('cmdxd98sb0x3yprd.mangadex.network'));
  });

  test('a non-title URL is rejected with bad_url', async () => {
    const ctx = fakeCtx();
    await assert.rejects(
      () => mangadex.resolveSeries('https://mangadex.org/titles/latest', ctx),
      (e) => e.code === 'bad_url',
    );
  });

  test('an at-home response with no pages fails as parse_failed', async () => {
    const chUuid = 'aaaaaaaa-0000-4000-8000-000000000009';
    const ctx = fakeCtx({}, {
      [`/chapter/${chUuid}`]: { data: { id: chUuid, attributes: {}, relationships: [] } },
      '/at-home/server/': { baseUrl: 'https://x.mangadex.network', chapter: { hash: 'h', data: [] } },
    });
    await assert.rejects(
      () => mangadex.resolveChapter(`https://mangadex.org/chapter/${chUuid}`, ctx),
      (e) => e.code === 'parse_failed',
    );
  });
});
