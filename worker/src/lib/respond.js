// respond.js — CORS headers and the JSON envelope every endpoint uses.
//
// Contract (ARCHITECTURE.md §6): every JSON response carries
// `Access-Control-Allow-Origin: *`; errors are
// `{ ok:false, error:"<machine code>", message:"<human text>" }` with a real
// non-2xx status.

/** Machine-readable error codes. Keep in sync with worker/README.md. */
export const ERR = {
  bad_request: 400,
  bad_url: 400,
  bad_method: 405,
  blocked_host: 403,
  not_allowlisted: 403,
  not_found: 404,
  no_adapter: 422,
  parse_failed: 422,
  list_failed: 422,
  bad_content_type: 415,
  too_large: 413,
  rate_limited: 429,
  timeout: 504,
  upstream_error: 502,
  internal_error: 500,
};

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  // We never *read* a client header upstream, but browsers still preflight
  // when the page sets one, so echo a permissive (yet finite) list.
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Type, X-Or-Adapter, X-Or-Confidence',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

/** Headers that make sense on everything we emit. */
const BASE_SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function withCors(headers = {}) {
  return { ...CORS, ...BASE_SECURITY, ...headers };
}

/** JSON success/any-payload response. */
export function json(body, { status = 200, headers = {}, cacheSeconds = 0 } = {}) {
  const h = withCors({
    'Content-Type': 'application/json; charset=utf-8',
    ...(cacheSeconds > 0
      ? { 'Cache-Control': `public, max-age=${cacheSeconds}` }
      : { 'Cache-Control': 'no-store' }),
    ...headers,
  });
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * Error envelope. `code` must be a key of ERR; anything unknown degrades to
 * internal_error so we can never leak an undefined status.
 */
export function fail(code, message, { status, headers = {} } = {}) {
  const known = Object.prototype.hasOwnProperty.call(ERR, code);
  const finalCode = known ? code : 'internal_error';
  return json(
    { ok: false, error: finalCode, message: String(message || finalCode) },
    { status: status || ERR[finalCode], headers },
  );
}

/** Thrown by lib code; the router turns it into `fail()`. */
export class GatewayError extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

export function gwError(code, message, status) {
  return new GatewayError(code, message, status);
}

export function preflight() {
  return new Response(null, { status: 204, headers: withCors() });
}
