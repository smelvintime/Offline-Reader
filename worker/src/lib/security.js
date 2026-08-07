// security.js — URL validation, SSRF defence, and the only fetch primitive the
// rest of the worker is allowed to use.
//
// ARCHITECTURE.md §7:
//   2. Worker rejects private-network targets and non-http(s) schemes.
//   4. No credentials, cookies, or auth headers are ever forwarded upstream.
//
// Everything here is pure enough to unit-test in plain Node: the DNS resolver
// and `fetch` are injectable.

import { gwError } from './respond.js';

// ── Limits ───────────────────────────────────────────────────────────────────
export const LIMITS = {
  imageBytes: 20 * 1024 * 1024, //  20 MB — a manga page is ~1 MB; 20 is generous
  htmlBytes: 5 * 1024 * 1024, //   5 MB — reader pages are ~200 KB
  jsonBytes: 8 * 1024 * 1024, //   8 MB — MangaDex feed pages can be chunky
  timeoutMs: 15_000,
  dnsTimeoutMs: 3_000,
  maxRedirects: 3,
};

// A plain desktop-Chrome UA. Some CDNs 403 anything that looks scripted.
export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Host blocklists ──────────────────────────────────────────────────────────
// Names that never point at a public third-party reader site.
const BLOCKED_EXACT = new Set([
  'localhost',
  'local',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'metadata.goog',
  'nsx',
  'kubernetes',
  'kubernetes.default',
]);

const BLOCKED_SUFFIXES = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.intranet',
  '.private',
  '.corp',
  '.home',
  '.home.arpa',
  '.lan',
  '.test',
  '.example',
  '.invalid',
  '.onion',
  '.i2p',
  '.cluster.local',
];

// Ports that are never a web reader and are classic SSRF pivots.
const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 110, 111, 135, 137, 138, 139, 143, 389, 445, 465, 512, 513,
  514, 587, 636, 873, 993, 995, 1433, 1521, 2049, 2375, 2376, 3306, 3389, 4444,
  5432, 5555, 5601, 5900, 5984, 6379, 7001, 8009, 9042, 9160, 9200, 9300, 11211,
  15672, 27017, 27018, 50070,
]);

// ── IP helpers ───────────────────────────────────────────────────────────────

/** True when `host` (a WHATWG `url.hostname`) is a literal IP address. */
export function isIpLiteral(host) {
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) return true; // IPv6 literal
  if (host.includes(':')) return true; // bare IPv6 (shouldn't happen post-parse)
  // WHATWG already canonicalises 0x7f000001 / 2130706433 / 127.1 to dotted quad,
  // but be defensive and treat any all-numeric label set as an IP.
  const parts = host.split('.');
  if (parts.length >= 1 && parts.length <= 4) {
    if (parts.every((p) => p.length > 0 && /^(\d+|0[xX][0-9a-fA-F]+)$/.test(p))) return true;
  }
  return false;
}

function ipv4ToInt(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

/** True when a dotted-quad IPv4 string is private / loopback / link-local / CGNAT / reserved. */
export function isPrivateIpv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // unparseable → treat as unsafe
  for (const [base, bits] of V4_BLOCKS) {
    const b = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

/** Expand an IPv6 string to 8 groups of 16-bit numbers, or null if malformed. */
function parseIpv6(input) {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  s = s.replace(/%.*$/, ''); // strip zone id
  if (!s) return null;
  // IPv4-mapped / -embedded tail (e.g. ::ffff:127.0.0.1)
  let tail = [];
  const v4m = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4m) {
    const n = ipv4ToInt(v4m[1]);
    if (n === null) return null;
    tail = [(n >>> 16) & 0xffff, n & 0xffff];
    s = s.slice(0, s.length - v4m[1].length).replace(/:$/, ':');
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part) =>
    part
      .split(':')
      .filter((x) => x !== '')
      .map((x) => (/^[0-9a-fA-F]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  let head = toGroups(halves[0] || '');
  let rest = halves.length === 2 ? toGroups(halves[1] || '') : [];
  if ([...head, ...rest].some((n) => Number.isNaN(n))) return null;
  let groups;
  if (halves.length === 2) {
    const fill = 8 - (head.length + rest.length + tail.length);
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  if (groups.length !== 8) return null;
  return groups;
}

/** True when an IPv6 literal is loopback / ULA / link-local / unspecified / mapped-private. */
export function isPrivateIpv6(input) {
  const g = parseIpv6(input);
  if (!g) return true; // unparseable → unsafe
  const isZeroPrefix = g.slice(0, 5).every((x) => x === 0);
  if (g.every((x) => x === 0)) return true; // ::
  if (isZeroPrefix && g[5] === 0 && g[6] === 0 && g[7] === 1) return true; // ::1
  if (isZeroPrefix && g[5] === 0xffff) {
    // ::ffff:a.b.c.d — check the embedded v4
    const v4 = `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
    return isPrivateIpv4(v4);
  }
  if (isZeroPrefix && g[5] === 0) return true; // ::a.b.c.d / deprecated compat
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2002) {
    // 6to4 — inspect the embedded v4
    const v4 = `${g[1] >>> 8}.${g[1] & 0xff}.${g[2] >>> 8}.${g[2] & 0xff}`;
    return isPrivateIpv4(v4);
  }
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // NAT64 well-known prefix
  return false;
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/** Normalised hostname: lowercase, trailing dot removed. */
export function normalizeHost(host) {
  return String(host || '')
    .toLowerCase()
    .replace(/\.+$/, '');
}

// ── Static (non-DNS) URL validation ──────────────────────────────────────────

/**
 * Validate a user-supplied target URL. Returns `{ ok, url, host }` or
 * `{ ok:false, error, message }`. Pure and synchronous — no DNS.
 *
 * @param {string} raw
 * @param {{allowPrivate?: boolean}} [opts] `allowPrivate` is a DEV-ONLY escape
 *        hatch driven by the ALLOW_PRIVATE_TARGETS var (see README).
 */
export function validateTargetUrl(raw, opts = {}) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: 'bad_url', message: 'Missing ?url= parameter' };
  }
  if (raw.length > 2048) {
    return { ok: false, error: 'bad_url', message: 'URL is too long' };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: 'bad_url', message: 'Not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'bad_url',
      message: `Unsupported scheme "${url.protocol}" — only http and https are allowed`,
    };
  }
  // Embedded credentials are both an SSRF smell and a way to smuggle secrets.
  if (url.username || url.password) {
    return { ok: false, error: 'bad_url', message: 'URLs with embedded credentials are rejected' };
  }
  const host = normalizeHost(url.hostname);
  if (!host) return { ok: false, error: 'bad_url', message: 'URL has no host' };

  if (opts.allowPrivate) return { ok: true, url, host };

  if (isIpLiteral(host)) {
    return { ok: false, error: 'blocked_host', message: 'IP-literal hosts are not allowed' };
  }
  if (host.startsWith('[')) {
    return { ok: false, error: 'blocked_host', message: 'IP-literal hosts are not allowed' };
  }
  if (BLOCKED_EXACT.has(host)) {
    return { ok: false, error: 'blocked_host', message: `Host "${host}" is not reachable` };
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, error: 'blocked_host', message: `Host suffix "${suffix}" is not allowed` };
    }
  }
  if (!host.includes('.')) {
    // Single-label names only resolve on an internal resolver.
    return { ok: false, error: 'blocked_host', message: 'Single-label hosts are not allowed' };
  }
  if (url.port && BLOCKED_PORTS.has(Number(url.port))) {
    return { ok: false, error: 'blocked_host', message: `Port ${url.port} is not allowed` };
  }
  return { ok: true, url, host };
}

// ── DNS guard (DoH) ──────────────────────────────────────────────────────────
// Workers have no DNS API, so we resolve over Cloudflare's DoH endpoint and
// reject names that answer with a private address. This is a *best-effort*
// control: it cannot stop a DNS-rebind race between our lookup and the socket
// connect. See README "What this does and does not do".

const dnsCache = new Map(); // host -> { at, ips }
const DNS_TTL_MS = 5 * 60 * 1000;
const DNS_CACHE_MAX = 500;

/** Default resolver: Cloudflare DNS-over-HTTPS JSON API. */
export async function dohResolve(host, fetchImpl = fetch) {
  const ips = [];
  for (const type of ['A', 'AAAA']) {
    const u = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
    let res;
    try {
      res = await fetchImpl(u, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(LIMITS.dnsTimeoutMs),
      });
    } catch {
      continue;
    }
    if (!res || !res.ok) continue;
    let body;
    try {
      body = await res.json();
    } catch {
      continue;
    }
    for (const a of body?.Answer || []) {
      // 1 = A, 28 = AAAA. CNAME (5) chains are followed by the resolver itself.
      if ((a.type === 1 || a.type === 28) && typeof a.data === 'string') ips.push(a.data.trim());
    }
  }
  return ips;
}

/**
 * Check that `host` does not resolve into a private range.
 *
 * @param {string} host
 * @param {object} opts
 * @param {'strict'|'lenient'|'off'} opts.mode  what to do when lookup fails
 * @param {(host:string)=>Promise<string[]>} [opts.resolve]  injectable for tests
 * @returns {Promise<{ok:true}|{ok:false,error:string,message:string}>}
 */
export async function assertPublicDns(host, opts = {}) {
  const mode = opts.mode || 'lenient';
  if (mode === 'off') return { ok: true };
  const resolver = opts.resolve || ((h) => dohResolve(h));

  const cached = dnsCache.get(host);
  let ips;
  if (cached && Date.now() - cached.at < DNS_TTL_MS) {
    ips = cached.ips;
  } else {
    try {
      ips = await resolver(host);
    } catch {
      ips = null;
    }
    if (Array.isArray(ips)) {
      if (dnsCache.size > DNS_CACHE_MAX) dnsCache.clear();
      dnsCache.set(host, { at: Date.now(), ips });
    }
  }

  if (!Array.isArray(ips) || ips.length === 0) {
    // Lookup failed or returned nothing useful.
    if (mode === 'strict') {
      return {
        ok: false,
        error: 'blocked_host',
        message: `Could not verify that "${host}" resolves to a public address`,
      };
    }
    return { ok: true };
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      return {
        ok: false,
        error: 'blocked_host',
        message: `"${host}" resolves to a private address (${ip})`,
      };
    }
  }
  return { ok: true };
}

/** Full validation: static rules + DNS guard. Throws GatewayError on failure. */
export async function assertSafeTarget(raw, opts = {}) {
  const v = validateTargetUrl(raw, opts);
  if (!v.ok) throw gwError(v.error, v.message);
  if (!opts.allowPrivate) {
    const dns = await assertPublicDns(v.host, opts);
    if (!dns.ok) throw gwError(dns.error, dns.message);
  }
  return v;
}

// ── Outbound headers ─────────────────────────────────────────────────────────

/**
 * Build the *complete* upstream header set. Nothing from the client request is
 * ever copied in — no Cookie, no Authorization, no custom headers (§7.4).
 */
export function upstreamHeaders({ accept, referer, extra } = {}) {
  const h = {
    'User-Agent': UA,
    Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
  };
  if (referer) {
    h.Referer = referer;
    try {
      h.Origin = new URL(referer).origin;
    } catch {
      /* referer was not absolute — skip Origin */
    }
  }
  return { ...h, ...(extra || {}) };
}

// ── The one fetch primitive ──────────────────────────────────────────────────

/**
 * Fetch with manual redirect following, re-validating the target after every
 * hop (§7.2), capped at LIMITS.maxRedirects, with an AbortSignal timeout.
 *
 * @returns {Promise<{response: Response, finalUrl: string, hops: string[]}>}
 */
export async function safeFetch(raw, opts = {}) {
  const {
    headers = {},
    timeoutMs = LIMITS.timeoutMs,
    maxRedirects = LIMITS.maxRedirects,
    fetchImpl = fetch,
    method = 'GET',
  } = opts;

  let current = (await assertSafeTarget(raw, opts)).url.href;
  const hops = [current];

  for (let i = 0; i <= maxRedirects; i++) {
    let res;
    try {
      res = await fetchImpl(current, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        // Cloudflare-specific hints are ignored elsewhere.
        cf: { cacheEverything: false },
      });
    } catch (err) {
      const isAbort = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw gwError(
        isAbort ? 'timeout' : 'upstream_error',
        isAbort ? `Upstream timed out after ${timeoutMs}ms` : `Upstream fetch failed: ${err.message}`,
      );
    }

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!isRedirect) return { response: res, finalUrl: current, hops };

    if (i === maxRedirects) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      throw gwError('upstream_error', `Too many redirects (>${maxRedirects})`);
    }

    let next;
    try {
      next = new URL(res.headers.get('location'), current).href;
    } catch {
      throw gwError('upstream_error', 'Upstream sent an unparseable Location header');
    }
    try {
      await res.body?.cancel(); // don't leak the redirect body
    } catch {
      /* ignore */
    }
    // Re-validate every hop — this is the redirect-to-169.254.169.254 defence.
    const hop = await assertSafeTarget(next, opts);
    // …and re-apply the caller's host gate, if it has one. SSRF rules alone do
    // not bound *which* public host we end up at, so an allowlisted host that
    // serves a 302 would otherwise turn /image into an open proxy.
    if (typeof opts.allowHost === 'function' && !(await opts.allowHost(hop.host))) {
      throw gwError('blocked_host', `Redirect to "${hop.host}" is not allowed for this endpoint`, 403);
    }
    current = hop.url.href;
    hops.push(current);
  }
  /* c8 ignore next */
  throw gwError('upstream_error', 'Redirect loop');
}

// ── Body reading with hard size caps ─────────────────────────────────────────

/** Read a response body as text, aborting past `maxBytes`. */
export async function readTextCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      /* ignore */
    }
    throw gwError('too_large', `Response is ${declared} bytes, limit is ${maxBytes}`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw gwError('too_large', `Response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const charset = (response.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1];
  let decoder;
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(buf);
}

/**
 * Wrap a body stream so it errors out once `maxBytes` have flowed through.
 * Used by /image so we never buffer 20 MB in the isolate.
 */
export function capStream(body, maxBytes) {
  let seen = 0;
  const ts = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.byteLength ?? chunk.length ?? 0;
      if (seen > maxBytes) {
        controller.error(new Error(`Image exceeded ${maxBytes} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return body.pipeThrough(ts);
}
