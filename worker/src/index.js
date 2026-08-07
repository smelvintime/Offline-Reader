// Offline Reader — content gateway (Cloudflare Worker).
//
// The app is a static PWA on GitHub Pages. A browser cannot fetch a third-party
// reader site (CORS) or load hotlink-protected CDN images (Referer checks), so
// this is the one server-side component: it fetches, normalizes, and re-serves.
//
// IT STORES NOTHING. Bytes stream through; the only persistence is the optional
// KV allowlist of image hosts learned from /resolve, and the Cloudflare edge
// cache. See worker/README.md for the honest capability/limitation list.
//
// Routes (ARCHITECTURE.md §6):
//   GET /image?url=      stream image bytes with a plausible Referer/Origin
//   GET /?url=           legacy alias for /image, kept for deployed catalogues
//   GET /resolve?url=    series page  → { ok, adapter, series }
//   GET /chapter?url=&kind=  chapter  → { ok, adapter, chapter }
//   GET /health          → { ok, version, adapters, … }

import { json, fail, preflight, withCors, GatewayError } from './lib/respond.js';
import {
  LIMITS,
  assertSafeTarget,
  safeFetch,
  readTextCapped,
  capStream,
  upstreamHeaders,
} from './lib/security.js';
import { isAllowedHost, hasKv, learnHosts, staticList } from './lib/allowlist.js';
import { checkRateLimit } from './lib/ratelimit.js';
import { parseHtml } from './lib/html.js';
import { absolutize } from './lib/meta.js';
import { VERSION, refererFor } from './lib/gateway.js';
import { selectAdapter, listAdapters, adapterIds } from './adapters/index.js';

// NOTE: this module must export ONLY its default handler. workerd validates
// every named export of the entry module and rejects anything that is not a
// function or an ExportedHandler, so VERSION and refererFor live in
// lib/gateway.js. See the comment at the top of that file.

// ── Environment-derived security options ─────────────────────────────────────

/**
 * `ALLOW_PRIVATE_TARGETS=true` is a DEV-ONLY escape hatch that disables the
 * SSRF host checks so the worker can be pointed at a localhost fixture server.
 * It must never be set on a public deployment; /health reports it loudly.
 */
function securityOpts(env) {
  const allowPrivate = String(env.ALLOW_PRIVATE_TARGETS || '') === 'true';
  const mode = allowPrivate ? 'off' : String(env.DNS_GUARD || 'lenient');
  return { allowPrivate, mode };
}

// ── Adapter context (ARCHITECTURE.md §6.5) ───────────────────────────────────

function makeCtx(request, env, execCtx, { kind } = {}) {
  const sec = securityOpts(env);
  const base = String(env.PUBLIC_BASE || new URL(request.url).origin).replace(/\/+$/, '');

  const doFetch = async (url, { accept, maxBytes, label }) => {
    const host = new URL(url).hostname;
    const { response, finalUrl } = await safeFetch(url, {
      ...sec,
      headers: upstreamHeaders({ accept, referer: refererFor(host) }),
      timeoutMs: LIMITS.timeoutMs,
    });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      throw new GatewayError(
        'upstream_error',
        `Upstream returned ${response.status} for ${label}`,
        response.status === 404 ? 404 : 502,
      );
    }
    const text = await readTextCapped(response, maxBytes);
    return { text, finalUrl, response };
  };

  return {
    env,
    kind,
    workerBase: base,
    absolutize,

    async fetchHtml(url) {
      const { text, finalUrl, response } = await doFetch(url, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        maxBytes: LIMITS.htmlBytes,
        label: 'HTML',
      });
      const ct = response.headers.get('content-type') || '';
      if (ct && !/(text\/html|xhtml|text\/plain|application\/xml|text\/xml)/i.test(ct)) {
        throw new GatewayError('parse_failed', `Expected HTML, upstream sent "${ct}"`);
      }
      return { root: parseHtml(text), html: text, finalUrl };
    },

    async fetchJson(url) {
      const { text, finalUrl } = await doFetch(url, {
        accept: 'application/json,*/*;q=0.8',
        maxBytes: LIMITS.jsonBytes,
        label: 'JSON',
      });
      try {
        return JSON.parse(text);
      } catch {
        throw new GatewayError('parse_failed', `Upstream JSON was unparseable (${finalUrl})`);
      }
    },

    /** Build the worker URL a client should use to fetch this chapter. */
    chapterSrc(url, k) {
      const qs = new URLSearchParams({ url });
      if (k) qs.set('kind', k);
      return `${base}/chapter?${qs.toString()}`;
    },

    /** Build the worker URL a client should use to fetch this image. */
    imageSrc(url) {
      return `${base}/image?${new URLSearchParams({ url }).toString()}`;
    },

    waitUntil: (p) => {
      try {
        execCtx && execCtx.waitUntil && execCtx.waitUntil(p);
      } catch {
        /* ignore */
      }
    },
  };
}

// ── /health ──────────────────────────────────────────────────────────────────

function handleHealth(request, env) {
  const sec = securityOpts(env);
  return json(
    {
      ok: true,
      version: VERSION,
      adapters: adapterIds(),
      adapterDetail: listAdapters(),
      // Operators need to know which tier the allowlist is running on: without
      // KV, /image only serves the compiled-in static hosts.
      kv: hasKv(env),
      allowlist: {
        mode: hasKv(env) ? 'static+learned' : 'static-only',
        staticEntries: staticList(env).length,
      },
      dnsGuard: sec.mode,
      // Loud, because it disables SSRF protection.
      allowPrivateTargets: sec.allowPrivate,
      limits: {
        imageBytes: LIMITS.imageBytes,
        htmlBytes: LIMITS.htmlBytes,
        timeoutMs: LIMITS.timeoutMs,
        maxRedirects: LIMITS.maxRedirects,
      },
    },
    { cacheSeconds: 0 },
  );
}

// ── /image ───────────────────────────────────────────────────────────────────

async function handleImage(request, env, execCtx, raw) {
  const rl = checkRateLimit(request, 'image', env);
  if (!rl.ok) {
    return fail('rate_limited', 'Too many image requests; slow down', {
      headers: { 'Retry-After': String(rl.retryAfter) },
    });
  }

  const sec = securityOpts(env);
  const { url: target, host } = await assertSafeTarget(raw, sec);

  // §7.3 — allowlist-gated so this never becomes an open image proxy.
  if (!sec.allowPrivate) {
    const verdict = await isAllowedHost(host, env);
    if (!verdict.allowed) {
      return fail(
        'blocked_host',
        `Host "${host}" is not in the image allowlist. Hosts are added automatically ` +
          `by a successful /resolve of a page that uses them.`,
      );
    }
  }

  // Normalised cache key so /image?url=X and /?url=X share one edge entry.
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = '/image';
  cacheUrl.search = `?url=${encodeURIComponent(target.href)}`;
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const r = new Response(hit.body, hit);
      for (const [k, v] of Object.entries(withCors({ 'X-Or-Cache': 'hit' }))) r.headers.set(k, v);
      return r;
    }
  }

  const { response } = await safeFetch(target.href, {
    ...sec,
    // The allowlist check above only covers the host the reader asked for.
    // Without this gate an allowlisted host could 302 anywhere and we would
    // happily proxy and edge-cache it — an open image proxy on the operator's
    // account. Re-gate every hop.
    allowHost: sec.allowPrivate
      ? null
      : async (h) => (await isAllowedHost(h, env)).allowed,
    headers: upstreamHeaders({
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      referer: refererFor(host),
    }),
    timeoutMs: LIMITS.timeoutMs,
  });

  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return fail('upstream_error', `Upstream returned ${response.status}`, {
      status: response.status >= 400 && response.status < 600 ? response.status : 502,
    });
  }

  // §6.1 — refuse anything that is not an image, so this cannot be used to
  // launder arbitrary content (HTML, JS) through our origin.
  const ct = response.headers.get('content-type') || '';
  if (!/^image\//i.test(ct.trim())) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return fail('bad_content_type', `Upstream Content-Type "${ct || 'unknown'}" is not image/*`);
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > LIMITS.imageBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return fail('too_large', `Image is ${declared} bytes; limit is ${LIMITS.imageBytes}`);
  }

  const headers = withCors({
    'Content-Type': ct,
    'Cache-Control': 'public, max-age=86400, s-maxage=604800',
    'X-Or-Cache': 'miss',
  });
  const len = response.headers.get('content-length');
  if (len) headers['Content-Length'] = len;

  if (request.method === 'HEAD') {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    return new Response(null, { status: 200, headers });
  }

  // Cap while streaming — we never buffer 20 MB in the isolate.
  const body = response.body ? capStream(response.body, LIMITS.imageBytes) : null;
  const out = new Response(body, { status: 200, headers });

  if (cache && execCtx && execCtx.waitUntil) {
    execCtx.waitUntil(cache.put(cacheKey, out.clone()).catch(() => {}));
  }
  return out;
}

// ── /resolve ─────────────────────────────────────────────────────────────────

async function handleResolve(request, env, execCtx, raw, params) {
  const rl = checkRateLimit(request, 'parse', env);
  if (!rl.ok) {
    return fail('rate_limited', 'Too many parse requests; slow down', {
      headers: { 'Retry-After': String(rl.retryAfter) },
    });
  }

  const sec = securityOpts(env);
  const { url: target } = await assertSafeTarget(raw, sec);

  const adapter = selectAdapter(target.href, { force: params.get('adapter') || undefined });
  if (!adapter) return fail('no_adapter', `No adapter handles ${target.href}`);

  const ctx = makeCtx(request, env, execCtx);
  const result = await adapter.resolveSeries(target.href, ctx);
  const series = result && result.series;
  if (!series) return fail('parse_failed', `${adapter.id} could not parse this series page`);

  // §6.2 — image hosts discovered here become /image-allowlisted.
  const hosts = new Set(result.hosts || []);
  if (hosts.size && execCtx && execCtx.waitUntil) {
    execCtx.waitUntil(learnHosts(hosts, env).catch(() => []));
  } else if (hosts.size) {
    await learnHosts(hosts, env).catch(() => []);
  }

  const confidence = result.confidence || series.confidence || 'low';
  return json(
    { ok: true, adapter: adapter.id, confidence, series },
    {
      headers: { 'X-Or-Adapter': adapter.id, 'X-Or-Confidence': confidence },
      cacheSeconds: 300,
    },
  );
}

// ── /chapter ─────────────────────────────────────────────────────────────────

async function handleChapter(request, env, execCtx, raw, params) {
  const rl = checkRateLimit(request, 'parse', env);
  if (!rl.ok) {
    return fail('rate_limited', 'Too many parse requests; slow down', {
      headers: { 'Retry-After': String(rl.retryAfter) },
    });
  }

  const sec = securityOpts(env);
  const { url: target } = await assertSafeTarget(raw, sec);

  const kindParam = (params.get('kind') || '').toLowerCase();
  const kind = kindParam === 'image' || kindParam === 'text' ? kindParam : undefined;

  const adapter = selectAdapter(target.href, {
    kind,
    force: params.get('adapter') || undefined,
  });
  if (!adapter) return fail('no_adapter', `No adapter handles ${target.href}`);

  const ctx = makeCtx(request, env, execCtx, { kind });
  const result = await adapter.resolveChapter(target.href, ctx);
  const chapter = result && result.chapter;
  if (!chapter) return fail('parse_failed', `${adapter.id} could not parse this chapter`);

  const hosts = new Set(result.hosts || []);
  if (hosts.size && execCtx && execCtx.waitUntil) {
    execCtx.waitUntil(learnHosts(hosts, env).catch(() => []));
  } else if (hosts.size) {
    await learnHosts(hosts, env).catch(() => []);
  }

  const confidence = result.confidence || chapter.confidence || 'low';
  return json(
    { ok: true, adapter: adapter.id, confidence, chapter },
    {
      headers: { 'X-Or-Adapter': adapter.id, 'X-Or-Confidence': confidence },
      cacheSeconds: 300,
    },
  );
}

// ── Router ───────────────────────────────────────────────────────────────────

// Not exported: workerd turns named exports of the entry module into named
// entrypoints. Only the default handler leaves this file.
async function route(request, env = {}, execCtx = null) {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return fail('bad_method', `${request.method} is not supported; use GET`);
  }

  const url = new URL(request.url);
  const params = url.searchParams;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const raw = params.get('url');

  if (path === '/health') return handleHealth(request, env);

  if (path === '/image') {
    if (!raw) return fail('bad_url', 'Missing ?url= parameter');
    return handleImage(request, env, execCtx, raw);
  }

  // Backward compatibility: already-deployed catalogues call `/?url=…`.
  if (path === '/') {
    if (raw) return handleImage(request, env, execCtx, raw);
    return json({
      ok: true,
      service: 'offline-reader-gateway',
      version: VERSION,
      endpoints: ['/image?url=', '/resolve?url=', '/chapter?url=&kind=', '/health'],
    });
  }

  if (path === '/resolve') {
    if (!raw) return fail('bad_url', 'Missing ?url= parameter');
    return handleResolve(request, env, execCtx, raw, params);
  }

  if (path === '/chapter') {
    if (!raw) return fail('bad_url', 'Missing ?url= parameter');
    return handleChapter(request, env, execCtx, raw, params);
  }

  return fail('not_found', `Unknown endpoint "${url.pathname}"`);
}

export default {
  async fetch(request, env, execCtx) {
    try {
      return await route(request, env || {}, execCtx || null);
    } catch (err) {
      if (err instanceof GatewayError) {
        return fail(err.code, err.message, { status: err.status });
      }
      // Never leak a stack trace to the client.
      // eslint-disable-next-line no-console
      console.error('unhandled', err && err.stack ? err.stack : err);
      return fail('internal_error', 'Unexpected gateway error');
    }
  },
};
