// The three generic heuristics, against saved fixtures. No network.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseHtml, classId } from '../src/lib/html.js';
import { extractMeta, sniffInfoPairs } from '../src/lib/meta.js';
import {
  prune,
  pickProseContainer,
  findTocCluster,
  findImageRun,
  findNextLink,
  parseChapterNum,
  cleanChapterTitle,
  hashId,
  worstConfidence,
} from '../src/lib/extract.js';
import { fixture } from './helpers.js';

const NOVEL_CHAPTER = 'https://wandering-ink.test/salt-road/chapter-12';
const NOVEL_SERIES = 'https://wandering-ink.test/salt-road/';
const MANGA_CHAPTER = 'https://scansite.test/manga/tin-quarter/chapter-42/';
const MANGA_SERIES = 'https://scansite.test/manga/tin-quarter/';

describe('pickProseContainer — novel chapter', () => {
  const root = parseHtml(fixture('novel-chapter.html'));
  prune(root, 'full');
  const hit = pickProseContainer(root);

  test('picks the entry-content div, not the sidebar or comments', () => {
    assert.ok(hit, 'expected a prose container');
    assert.match(classId(hit.node), /entry-content/);
  });

  test('reports high confidence for a clean chapter page', () => {
    assert.equal(hit.confidence, 'high');
  });

  test('the chosen container has low link density', () => {
    assert.ok(hit.linkDensity < 0.2, `link density was ${hit.linkDensity}`);
  });

  test('degrades to low confidence on a near-empty page', () => {
    const thin = parseHtml('<html><body><div><p>Just a few words here only.</p></div></body></html>');
    prune(thin, 'full');
    const r = pickProseContainer(thin);
    // It may or may not find a container; if it does, it must admit low confidence.
    if (r) assert.equal(r.confidence, 'low');
  });

  test('returns null rather than guessing when there is no prose at all', () => {
    const empty = parseHtml('<html><body><div id="app"></div></body></html>');
    prune(empty, 'full');
    assert.equal(pickProseContainer(empty), null);
  });
});

describe('findTocCluster — novel series page', () => {
  const root = parseHtml(fixture('novel-series.html'));
  prune(root, 'light');
  const toc = findTocCluster(root, NOVEL_SERIES);

  test('finds all eight chapter links', () => {
    assert.ok(toc, 'expected a TOC cluster');
    assert.equal(toc.links.length, 8);
  });

  test('picks the chapter list, not the pagination row or the nav menu', () => {
    for (const l of toc.links) {
      assert.match(l.href, /\/salt-road\/chapter-\d+$/, `unexpected link ${l.href}`);
    }
  });

  test('parses chapter numbers', () => {
    const nums = toc.links.map((l) => l.num);
    assert.deepEqual(nums, [15, 14, 13, 12, 11, 10, 9, 8]);
  });

  test('reports high confidence', () => {
    assert.equal(toc.confidence, 'high');
  });

  test('finds the rel=next pagination link', () => {
    assert.equal(findNextLink(root, NOVEL_SERIES, NOVEL_SERIES), 'https://wandering-ink.test/salt-road/?page=2');
  });
});

describe('findTocCluster — manga series page', () => {
  const root = parseHtml(fixture('manga-series.html'));
  prune(root, 'light');
  const toc = findTocCluster(root, MANGA_SERIES);

  test('finds the six chapter links', () => {
    assert.ok(toc);
    assert.equal(toc.links.length, 6);
    assert.deepEqual(toc.links.map((l) => l.num), [45, 44, 43, 42, 41, 40]);
  });

  test('excludes the header nav and footer legal links', () => {
    const joined = toc.links.map((l) => l.href).join(' ');
    assert.ok(!joined.includes('/privacy'));
    assert.ok(!joined.includes('/browse'));
  });
});

describe('findTocCluster — honest failure', () => {
  test('returns null when there is no link cluster', () => {
    const root = parseHtml('<html><body><p>Nothing here.</p><a href="/x">one link</a></body></html>');
    assert.equal(findTocCluster(root, 'https://x.test/'), null);
  });

  test('marks a weak, unnumbered cluster as low confidence', () => {
    const root = parseHtml(
      '<html><body><ul>' +
        '<li><a href="/a">Alpha</a></li>' +
        '<li><a href="/b">Beta</a></li>' +
        '<li><a href="/c">Gamma</a></li>' +
        '</ul></body></html>',
    );
    const toc = findTocCluster(root, 'https://x.test/');
    assert.ok(toc, 'should still return what it found');
    assert.equal(toc.confidence, 'low');
    assert.equal(toc.links.length, 3);
  });
});

describe('findImageRun — manga chapter', () => {
  const root = parseHtml(fixture('manga-chapter.html'));
  prune(root, 'light');
  const run = findImageRun(root, MANGA_CHAPTER);

  test('finds exactly the eight page images', () => {
    assert.ok(run, 'expected an image run');
    assert.equal(run.urls.length, 8);
  });

  test('resolves data-src past the base64 placeholder', () => {
    assert.equal(run.urls[2], 'https://cdn.scansite.test/uploads/tin-quarter/42/003.webp');
    for (const u of run.urls) assert.ok(!u.startsWith('data:'), `placeholder leaked: ${u}`);
  });

  test('keeps the pages in reading order', () => {
    assert.deepEqual(
      run.urls.map((u) => u.slice(-8)),
      ['001.webp', '002.webp', '003.webp', '004.webp', '005.webp', '006.webp', '007.webp', '008.webp'],
    );
  });

  test('excludes the logo, avatars and the ad banner', () => {
    const joined = run.urls.join(' ');
    assert.ok(!joined.includes('logo'), 'logo leaked');
    assert.ok(!joined.includes('avatar'), 'avatar leaked');
    assert.ok(!joined.includes('ads.scansite'), 'ad leaked');
    assert.ok(!joined.includes('banner'), 'banner leaked');
  });

  test('detects the sequential numbering and reports high confidence', () => {
    assert.ok(run.sequential > 0.9, `sequential ratio was ${run.sequential}`);
    assert.equal(run.confidence, 'high');
  });

  test('returns null when a page has no qualifying images', () => {
    const root2 = parseHtml(
      '<html><body><img src="https://c.test/logo.png" width="100" height="30"></body></html>',
    );
    assert.equal(findImageRun(root2, 'https://c.test/'), null);
  });
});

describe('metadata is preferred over heuristics', () => {
  test('Open Graph + JSON-LD drive the series fields', () => {
    const root = parseHtml(fixture('novel-series.html'));
    const meta = extractMeta(root, NOVEL_SERIES);
    assert.equal(meta.title, 'The Salt Road');
    assert.equal(meta.siteName, 'Wandering Ink');
    assert.equal(meta.cover, 'https://img.wandering-ink.test/covers/salt-road.jpg');
    assert.equal(meta.author, 'P. Navarre');
    assert.equal(meta.status, 'ongoing');
    assert.ok(meta.genres.includes('Fantasy'));
    assert.equal(meta.canonical, 'https://wandering-ink.test/salt-road/');
  });

  test('the "| Site Name" suffix is stripped from the <title>', () => {
    const root = parseHtml(fixture('manga-series.html'));
    const meta = extractMeta(root, MANGA_SERIES);
    assert.equal(meta.title, 'Tin Quarter');
  });

  test('label/value info blocks are sniffed when metadata is missing', () => {
    const root = parseHtml(fixture('manga-series.html'));
    const info = sniffInfoPairs(root);
    assert.equal(info.author, 'R. Adeyemi');
    assert.equal(info.status, 'ongoing');
    assert.ok(info.genres.includes('Action'));
  });
});

describe('small helpers', () => {
  test('parseChapterNum reads text first, href second', () => {
    assert.equal(parseChapterNum('Chapter 42 - The Door', '/x/'), 42);
    assert.equal(parseChapterNum('Ch. 7', '/x/'), 7);
    assert.equal(parseChapterNum('Episode 3', '/x/'), 3);
    assert.equal(parseChapterNum('12', '/x/'), 12);
    assert.equal(parseChapterNum('Chapter 12.5', '/x/'), 12.5);
    assert.equal(parseChapterNum('', 'https://s.test/manga/x/chapter-88/'), 88);
    assert.equal(parseChapterNum('The Door', 'https://s.test/about'), null);
  });

  test('cleanChapterTitle drops the redundant number prefix', () => {
    assert.equal(cleanChapterTitle('Chapter 12 - The Salt Road'), 'The Salt Road');
    assert.equal(cleanChapterTitle('Ch.7: Wet Wool'), 'Wet Wool');
    assert.equal(cleanChapterTitle('Chapter 45'), '');
  });

  test('hashId is stable and URL-derived', () => {
    assert.equal(hashId('https://a.test/x'), hashId('https://a.test/x'));
    assert.notEqual(hashId('https://a.test/x'), hashId('https://a.test/y'));
  });

  test('worstConfidence takes the floor', () => {
    assert.equal(worstConfidence('high', 'low'), 'low');
    assert.equal(worstConfidence('high', 'medium'), 'medium');
    assert.equal(worstConfidence('high', 'high'), 'high');
  });
});
