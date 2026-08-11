// End-to-end through the worker's default export, with global fetch stubbed by
// fixtures. No live network anywhere in this file.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { VERSION, refererFor, _resetListLearnMemo } from '../src/lib/gateway.js';
import { _resetRateLimit } from '../src/lib/ratelimit.js';
import { fixture, kvStub, execCtxStub, fetchStub, html, req } from './helpers.js';

// Fixture hosts must be real-looking TLDs: security.js correctly refuses the
// RFC 6761 reserved suffixes (.test/.local/.invalid), which the fixture files
// themselves use for their hard-coded asset URLs.
const NOVEL = 'novelsite.gwfixture.org';
const MANGA = 'mangasite.gwfixture.org';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const baseEnv = () => ({ DNS_GUARD: 'off' });

let realFetch;
let ctx;

function install(routes) {
  const stub = fetchStub(routes);
  globalThis.fetch = stub;
  return stub;
}

const ROUTES = {
  [`${NOVEL}/salt-road/`]: () => html(fixture('novel-series.html')),
  [`${NOVEL}/salt-road/?page=2`]: () => html(fixture('novel-series-page2.html')),
  [`${NOVEL}/salt-road/chapter-12`]: () => html(fixture('novel-chapter.html')),
  [`${NOVEL}/browse/`]: () => html(fixture('listing-page.html')),
  [`${NOVEL}/nothing-here/`]: () =>
    html('<html><body><p>Just a paragraph, no listing.</p></body></html>'),
  [`${MANGA}/manga/tin-quarter/`]: () => html(fixture('manga-series.html')),
  [`${MANGA}/manga/tin-quarter/chapter-42/`]: () => html(fixture('manga-chapter.html')),
  'upload.wikimedia.org/covers/a.png': () =>
    new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
  'upload.wikimedia.org/covers/lies.png': () =>
    new Response('<html>not an image</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  'upload.wikimedia.org/covers/gone.png': () => new Response('nope', { status: 404 }),
  'cdn.learned.org/p/1.webp': () =>
    new Response(PNG, { status: 200, headers: { 'content-type': 'image/webp' } }),
};

beforeEach(() => {
  realFetch = globalThis.fetch;
  ctx = execCtxStub();
  _resetRateLimit();
  _resetListLearnMemo();
  install(ROUTES);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const call = (url, env = baseEnv(), init) => worker.fetch(req(url, init), env, ctx);

describe('/health', () => {
  test('reports version and adapters', async () => {
    const res = await call('https://gw.example.com/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.version, VERSION);
    assert.deepEqual(body.adapters, ['generic-manga', 'generic-novel']);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('adapterDetail reports the §6.5 listing capability', async () => {
    const body = await (await call('https://gw.example.com/health')).json();
    for (const row of body.adapterDetail) {
      assert.equal(typeof row.canList, 'boolean', `${row.id} must report canList`);
    }
    // Both shipped adapters can list (generic-novel lists everything).
    assert.ok(body.adapterDetail.every((r) => r.canList === true));
  });

  test('says kv:false and static-only when no namespace is bound', async () => {
    const body = await (await call('https://gw.example.com/health')).json();
    assert.equal(body.kv, false);
    assert.equal(body.allowlist.mode, 'static-only');
  });

  test('says kv:true when the namespace is bound', async () => {
    const env = { ...baseEnv(), OR_ALLOWLIST: kvStub() };
    const body = await (await call('https://gw.example.com/health', env)).json();
    assert.equal(body.kv, true);
    assert.equal(body.allowlist.mode, 'static+learned');
  });

  test('flags the dev SSRF escape hatch loudly', async () => {
    const env = { ...baseEnv(), ALLOW_PRIVATE_TARGETS: 'true' };
    const body = await (await call('https://gw.example.com/health', env)).json();
    assert.equal(body.allowPrivateTargets, true);
  });
});

describe('protocol basics', () => {
  test('OPTIONS preflight', async () => {
    const res = await call('https://gw.example.com/image', baseEnv(), { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
  });

  test('POST is rejected', async () => {
    const res = await call('https://gw.example.com/health', baseEnv(), { method: 'POST' });
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'bad_method');
  });

  test('unknown path 404s with the error envelope', async () => {
    const res = await call('https://gw.example.com/nope');
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message', 'ok']);
    assert.equal(body.error, 'not_found');
  });

  test('bare / describes the service', async () => {
    const body = await (await call('https://gw.example.com/')).json();
    assert.equal(body.ok, true);
    assert.ok(body.endpoints.includes('/health'));
  });

  test('every error carries CORS headers', async () => {
    const res = await call('https://gw.example.com/image');
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal((await res.json()).error, 'bad_url');
  });
});

describe('/image', () => {
  test('streams an allowlisted image with CORS', async () => {
    const res = await call(
      'https://gw.example.com/image?url=' +
        encodeURIComponent('https://upload.wikimedia.org/covers/a.png'),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...buf], [...PNG]);
  });

  test('sends a plausible Referer and never a cookie', async () => {
    const stub = install(ROUTES);
    await call(
      'https://gw.example.com/image?url=' +
        encodeURIComponent('https://upload.wikimedia.org/covers/a.png'),
      baseEnv(),
      { headers: { cookie: 'session=secret', authorization: 'Bearer hunter2' } },
    );
    const sent = stub.calls[0].headers;
    assert.equal(sent.Referer, 'https://wikimedia.org/');
    assert.equal(sent.Origin, 'https://wikimedia.org');
    const lower = Object.keys(sent).map((k) => k.toLowerCase());
    assert.equal(lower.includes('cookie'), false);
    assert.equal(lower.includes('authorization'), false);
  });

  test('the legacy /?url= alias still works', async () => {
    const res = await call(
      'https://gw.example.com/?url=' +
        encodeURIComponent('https://upload.wikimedia.org/covers/a.png'),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  test('rejects a non-allowlisted host', async () => {
    const res = await call(
      'https://gw.example.com/image?url=' + encodeURIComponent('https://evil.example.org/x.png'),
    );
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error, 'blocked_host');
    assert.match(body.message, /allowlist/);
  });

  test('rejects private and IP-literal targets before the allowlist', async () => {
    for (const bad of ['http://127.0.0.1/x.png', 'http://169.254.169.254/x', 'http://10.0.0.1/x']) {
      const res = await call('https://gw.example.com/image?url=' + encodeURIComponent(bad));
      assert.equal(res.status, 403, bad);
      assert.equal((await res.json()).error, 'blocked_host', bad);
    }
  });

  test('rejects non-http schemes', async () => {
    const res = await call(
      'https://gw.example.com/image?url=' + encodeURIComponent('file:///etc/passwd'),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_url');
  });

  test('rejects a response whose Content-Type is not image/*', async () => {
    const res = await call(
      'https://gw.example.com/image?url=' +
        encodeURIComponent('https://upload.wikimedia.org/covers/lies.png'),
    );
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error, 'bad_content_type');
  });

  test('propagates an upstream failure as upstream_error', async () => {
    const res = await call(
      'https://gw.example.com/image?url=' +
        encodeURIComponent('https://upload.wikimedia.org/covers/gone.png'),
    );
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'upstream_error');
  });

  test('a KV-learned host is served', async () => {
    const kv = kvStub();
    await kv.put('allow:host:cdn.learned.org', String(Date.now()));
    const env = { ...baseEnv(), OR_ALLOWLIST: kv };
    const res = await call(
      'https://gw.example.com/image?url=' +
        encodeURIComponent('https://cdn.learned.org/p/1.webp'),
      env,
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/webp');
  });
});

describe('/resolve', () => {
  test('normalizes a novel series page', async () => {
    const res = await call(
      'https://gw.example.com/resolve?url=' +
        encodeURIComponent(`https://${NOVEL}/salt-road/`),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-or-adapter'), 'generic-novel');
    assert.equal(res.headers.get('x-or-confidence'), 'high');

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.adapter, 'generic-novel');
    assert.equal(body.series.title, 'The Salt Road');
    assert.equal(body.series.type, 'webnovel');
    assert.equal(body.series.chapters.length, 15);
  });

  test('chapter src points back at this worker origin', async () => {
    const body = await (
      await call(
        'https://gw.example.com/resolve?url=' + encodeURIComponent(`https://${NOVEL}/salt-road/`),
      )
    ).json();
    for (const ch of body.series.chapters) {
      assert.ok(
        ch.src.startsWith('https://gw.example.com/chapter?'),
        `src was ${ch.src}`,
      );
    }
  });

  test('PUBLIC_BASE overrides the inferred origin', async () => {
    const env = { ...baseEnv(), PUBLIC_BASE: 'https://cdn.mysite.org/gw' };
    const body = await (
      await call(
        'https://gw.example.com/resolve?url=' + encodeURIComponent(`https://${NOVEL}/salt-road/`),
        env,
      )
    ).json();
    assert.ok(body.series.chapters[0].src.startsWith('https://cdn.mysite.org/gw/chapter?'));
  });

  test('discovered image hosts are written to the KV allowlist', async () => {
    const kv = kvStub();
    const env = { ...baseEnv(), OR_ALLOWLIST: kv };
    await call(
      'https://gw.example.com/resolve?url=' + encodeURIComponent(`https://${NOVEL}/salt-road/`),
      env,
    );
    await ctx.settle();
    const keys = [...kv.store.keys()];
    assert.ok(
      keys.some((k) => k.includes('img.wandering-ink')),
      `expected the cover host to be learned; got ${JSON.stringify(keys)}`,
    );
  });

  test('resolves a manga series through generic-manga', async () => {
    const body = await (
      await call(
        'https://gw.example.com/resolve?url=' +
          encodeURIComponent(`https://${MANGA}/manga/tin-quarter/`),
      )
    ).json();
    assert.equal(body.adapter, 'generic-manga');
    assert.equal(body.series.type, 'manga');
    assert.equal(body.series.chapters.length, 6);
  });

  test('missing ?url= is a bad_url', async () => {
    const res = await call('https://gw.example.com/resolve');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_url');
  });

  test('an upstream 404 surfaces as upstream_error, not a crash', async () => {
    const res = await call(
      'https://gw.example.com/resolve?url=' +
        encodeURIComponent(`https://${NOVEL}/does-not-exist`),
    );
    assert.equal((await res.json()).error, 'upstream_error');
  });
});

describe('/chapter', () => {
  test('text chapter reduces to typed blocks', async () => {
    const res = await call(
      'https://gw.example.com/chapter?kind=text&url=' +
        encodeURIComponent(`https://${NOVEL}/salt-road/chapter-12`),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.adapter, 'generic-novel');
    assert.equal(body.chapter.kind, 'text');
    assert.ok(body.chapter.blocks.length > 8);
    assert.ok(body.chapter.wordCount > 300);
    // The §1.3 XSS boundary: no markup field anywhere in the payload.
    const dump = JSON.stringify(body.chapter);
    assert.ok(!dump.includes('<script'));
    assert.ok(!dump.includes('"html"'));
  });

  test('image chapter returns an ordered page list', async () => {
    const res = await call(
      'https://gw.example.com/chapter?kind=image&url=' +
        encodeURIComponent(`https://${MANGA}/manga/tin-quarter/chapter-42/`),
    );
    const body = await res.json();
    assert.equal(body.chapter.kind, 'image');
    assert.equal(body.chapter.pages.length, 8);
    assert.equal(body.chapter.pages[0], 'https://cdn.scansite.test/uploads/tin-quarter/42/001.webp');
  });

  test('kind is only a hint — content wins', async () => {
    // Ask for text, hand it a manga reader page.
    const body = await (
      await call(
        'https://gw.example.com/chapter?kind=text&url=' +
          encodeURIComponent(`https://${MANGA}/manga/tin-quarter/chapter-42/`),
      )
    ).json();
    assert.equal(body.chapter.kind, 'image');
  });

  test('confidence is reported in the body and the header', async () => {
    const res = await call(
      'https://gw.example.com/chapter?url=' +
        encodeURIComponent(`https://${NOVEL}/salt-road/chapter-12`),
    );
    const body = await res.json();
    assert.ok(['high', 'medium', 'low'].includes(body.confidence));
    assert.equal(res.headers.get('x-or-confidence'), body.confidence);
  });
});

describe('/list', () => {
  const LIST_URL =
    'https://gw.example.com/list?url=' + encodeURIComponent(`https://${NOVEL}/browse/`);

  test('the / descriptor advertises /list', async () => {
    const body = await (await call('https://gw.example.com/')).json();
    assert.ok(body.endpoints.includes('/list?url='), JSON.stringify(body.endpoints));
  });

  test('missing ?url= is a bad_url', async () => {
    const res = await call('https://gw.example.com/list');
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'bad_url');
  });

  test('rejects private and IP-literal targets (SSRF)', async () => {
    for (const bad of ['http://127.0.0.1/x', 'http://169.254.169.254/x', 'http://10.0.0.1/x']) {
      const res = await call('https://gw.example.com/list?url=' + encodeURIComponent(bad));
      assert.equal(res.status, 403, bad);
      assert.equal((await res.json()).error, 'blocked_host', bad);
    }
  });

  test('normalizes a listing page into source + items + nextUrl', async () => {
    const res = await call(LIST_URL);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-or-adapter'), 'generic-novel');
    assert.match(res.headers.get('cache-control') || '', /max-age=300/);

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.adapter, 'generic-novel');
    assert.equal(body.source.title, 'Wandering Ink');
    assert.equal(body.source.url, `https://${NOVEL}/browse/`);
    assert.equal(body.items.length, 20);

    const first = body.items[0];
    assert.equal(first.title, 'The Salt Road');
    assert.equal(first.url, `https://${NOVEL}/series/the-salt-road/`);
    assert.equal(first.cover, 'https://cdn1.wi-img.gwfixture.org/thumbs/salt-road.jpg');
    assert.equal(first.type, 'webnovel');

    // Every item is an absolute http(s) URL the client can feed to /resolve,
    // and no item carries a series id — /resolve owns id minting.
    for (const it of body.items) {
      assert.match(it.url, /^https:\/\//);
      assert.equal('id' in it, false);
    }
    // Nav chrome and pagination never leak into the items.
    const joined = body.items.map((i) => i.url).join(' ');
    assert.ok(!joined.includes('/login'));
    assert.ok(!joined.includes('page='));

    assert.equal(body.nextUrl, `https://${NOVEL}/browse/?page=2`);
  });

  test('items are capped at 60', async () => {
    const cards = Array.from({ length: 75 }, (_, i) =>
      `<div class="card"><a href="/series/s-${i}/"><img src="https://cdn9.wi-img.gwfixture.org/t/${i}.jpg" width="220" height="330"><span>Series ${i}</span></a></div>`,
    ).join('');
    install({
      ...ROUTES,
      [`${NOVEL}/huge/`]: () =>
        html(`<html><body><div class="grid">${cards}</div></body></html>`),
    });
    const body = await (
      await call('https://gw.example.com/list?url=' + encodeURIComponent(`https://${NOVEL}/huge/`))
    ).json();
    assert.equal(body.ok, true);
    assert.equal(body.items.length, 60);
  });

  test('a page with no listing is list_failed 422 (the ERR entry, not internal_error)', async () => {
    const res = await call(
      'https://gw.example.com/list?url=' + encodeURIComponent(`https://${NOVEL}/nothing-here/`),
    );
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'list_failed');
  });

  test('forcing an unknown adapter is no_adapter', async () => {
    const res = await call(LIST_URL + '&adapter=ghost');
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error, 'no_adapter');
  });

  test('cover-host learning is capped at 4 hosts per request', async () => {
    const kv = kvStub();
    const env = { ...baseEnv(), OR_ALLOWLIST: kv };
    const res = await call(LIST_URL, env);
    assert.equal(res.status, 200);
    await ctx.settle();
    const learned = [...kv.store.keys()].filter((k) => k.startsWith('allow:host:'));
    // The fixture spreads covers over five CDN hosts; only the first four land.
    assert.equal(learned.length, 4, JSON.stringify(learned));
    assert.ok(learned.includes('allow:host:cdn1.wi-img.gwfixture.org'));
    assert.ok(!learned.includes('allow:host:cdn5.wi-img.gwfixture.org'));
  });

  test('repeat /list calls in one isolate do not re-put memoized hosts', async () => {
    const kv = kvStub();
    const env = { ...baseEnv(), OR_ALLOWLIST: kv };
    await call(LIST_URL, env);
    await ctx.settle();
    assert.equal(kv.puts, 4, 'first browse learns up to the cap');

    // The second call may pick up ONLY the host the cap left behind (cdn5) —
    // the four memoized hosts are not re-put.
    await call(LIST_URL, env);
    await ctx.settle();
    assert.equal(kv.puts, 5, 'repeat writes only the capped-out host, never re-puts');
    assert.ok([...kv.store.keys()].includes('allow:host:cdn5.wi-img.gwfixture.org'));

    // Once everything is memoized, a warm-isolate browse loop writes nothing.
    await call(LIST_URL, env);
    await ctx.settle();
    assert.equal(kv.puts, 5, 'fully-memoized repeat must write nothing');
  });

  test('without KV, learning is a silent no-op and the listing still works', async () => {
    const res = await call(LIST_URL); // baseEnv has no OR_ALLOWLIST binding
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test('uses the parse rate bucket and 429s past the budget', async () => {
    const env = { ...baseEnv(), RATE_LIMIT_PARSE: '2' };
    const headers = { 'cf-connecting-ip': '203.0.113.44' };
    assert.equal((await call(LIST_URL, env, { headers })).status, 200);
    assert.equal((await call(LIST_URL, env, { headers })).status, 200);
    const third = await call(LIST_URL, env, { headers });
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) >= 0);
  });
});

describe('rate limiting', () => {
  test('returns 429 with Retry-After past the budget', async () => {
    const env = { ...baseEnv(), RATE_LIMIT_PARSE: '2' };
    const url =
      'https://gw.example.com/resolve?url=' + encodeURIComponent(`https://${NOVEL}/salt-road/`);
    const headers = { 'cf-connecting-ip': '203.0.113.9' };

    assert.equal((await call(url, env, { headers })).status, 200);
    assert.equal((await call(url, env, { headers })).status, 200);
    const third = await call(url, env, { headers });
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.error, 'rate_limited');
    assert.ok(Number(third.headers.get('retry-after')) >= 0);
  });

  test('buckets are per client IP', async () => {
    const env = { ...baseEnv(), RATE_LIMIT_PARSE: '1' };
    const url =
      'https://gw.example.com/resolve?url=' + encodeURIComponent(`https://${NOVEL}/salt-road/`);
    assert.equal((await call(url, env, { headers: { 'cf-connecting-ip': '198.51.100.1' } })).status, 200);
    assert.equal((await call(url, env, { headers: { 'cf-connecting-ip': '198.51.100.2' } })).status, 200);
    assert.equal((await call(url, env, { headers: { 'cf-connecting-ip': '198.51.100.1' } })).status, 429);
  });

  test('can be disabled for load testing', async () => {
    const env = { ...baseEnv(), RATE_LIMIT_PARSE: '1', DISABLE_RATE_LIMIT: 'true' };
    const url =
      'https://gw.example.com/resolve?url=' + encodeURIComponent(`https://${NOVEL}/salt-road/`);
    const headers = { 'cf-connecting-ip': '198.51.100.7' };
    assert.equal((await call(url, env, { headers })).status, 200);
    assert.equal((await call(url, env, { headers })).status, 200);
  });
});

describe('refererFor', () => {
  // §8: the Referer is derived from the target host, with no per-site table.
  test('is derived uniformly — no host is special-cased', () => {
    assert.equal(refererFor('uploads.example.org'), 'https://example.org/');
    assert.equal(refererFor('cmdxd98sb0x3yprd.example.network'), 'https://example.network/');
  });

  test('falls back to the parent domain of a CDN host', () => {
    assert.equal(refererFor('cdn.example.com'), 'https://example.com/');
    assert.equal(refererFor('example.com'), 'https://example.com/');
    assert.equal(refererFor('img.site.co.uk'), 'https://site.co.uk/');
  });
});
