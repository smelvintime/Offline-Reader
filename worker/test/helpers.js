// Shared test helpers. No network: every upstream response is a local fixture
// or an inline string.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

export function fixture(name) {
  return readFileSync(join(HERE, 'fixtures', name), 'utf8');
}

/** Minimal in-memory KV namespace with the subset of the API we use. */
export function kvStub() {
  const store = new Map();
  const kv = {
    store,
    puts: 0, // total put() calls — the /list learn-memo tests assert on this
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      kv.puts += 1;
      store.set(key, value);
      return undefined;
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return kv;
}

/** Collects waitUntil promises so tests can await background work. */
export function execCtxStub() {
  const promises = [];
  return {
    promises,
    waitUntil(p) {
      promises.push(p);
    },
    async settle() {
      await Promise.allSettled(promises);
    },
  };
}

/**
 * Build a fetch stub. `routes` maps "host/path" to a handler returning a
 * Response (or a { status, headers, body } literal). Every call is recorded so
 * tests can assert on the outbound headers.
 */
export function fetchStub(routes) {
  const calls = [];
  const fn = async (input, opts = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    const u = new URL(href);
    calls.push({ url: href, headers: opts.headers || {}, opts });
    // Most specific first: host+path+query, then host+path, then the catch-all.
    const key = u.host + u.pathname;
    const handler = routes[key + u.search] || routes[key] || routes['*'];
    if (!handler) {
      return new Response('no fixture route for ' + key, { status: 404 });
    }
    const out = typeof handler === 'function' ? await handler(u, opts) : handler;
    if (out instanceof Response) return out;
    return new Response(out.body === undefined ? null : out.body, {
      status: out.status || 200,
      headers: out.headers || {},
    });
  };
  fn.calls = calls;
  return fn;
}

export function html(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

export function jsonResponse(obj, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function req(url, init = {}) {
  return new Request(url, init);
}
