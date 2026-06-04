// Manga Image Proxy — Cloudflare Worker
// Adds correct Referer/Origin headers so CDNs accept requests from the PWA domain.
// All responses include Access-Control-Allow-Origin: * for browser img/fetch use.

const SOURCES = new Map([
  ['cdn.flamecomics.xyz',   'https://flamecomics.xyz/'],
  ['uploads.mangadex.org',  'https://mangadex.org/'],
  ['cmdxd98sb0x3yprd.mangadex.network', 'https://mangadex.org/'],
]);

function refererFor(hostname) {
  if (SOURCES.has(hostname)) return SOURCES.get(hostname);
  if (hostname.endsWith('.mangadex.network')) return 'https://mangadex.org/';
  return null;
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age':       '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { searchParams } = new URL(request.url);
    const raw = searchParams.get('url');
    if (!raw) return new Response('Missing ?url= parameter', { status: 400 });

    let target;
    try { target = new URL(raw); }
    catch { return new Response('Invalid URL', { status: 400 }); }

    const referer = refererFor(target.hostname);
    if (!referer) {
      return new Response('Host not in allowlist: ' + target.hostname, { status: 403 });
    }

    // Serve from Cloudflare cache when possible
    const cache    = caches.default;
    const cacheKey = new Request(raw);
    const cached   = await cache.match(cacheKey);
    if (cached) return addCors(cached);

    let upstream;
    try {
      upstream = await fetch(raw, {
        headers: {
          'Referer':          referer,
          'Origin':           new URL(referer).origin,
          'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':           'image/webp,image/avif,image/*,*/*;q=0.8',
          'Accept-Language':  'en-US,en;q=0.9',
        },
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502 });
    }

    if (!upstream.ok) {
      return new Response('Upstream error: ' + upstream.status, { status: upstream.status });
    }

    const contentType = upstream.headers.get('Content-Type') || 'image/webp';
    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type':  contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function addCors(response) {
  const r = new Response(response.body, response);
  Object.entries(CORS).forEach(([k, v]) => r.headers.set(k, v));
  return r;
}
