// Thin HTTP layer: sane defaults, retries with backoff, and a URL probe used
// to verify cover images actually exist before we put them in the catalogue.

import axios from 'axios';
import { sleep } from './util.js';

const UA = 'offline-reader-scraper/2.0 (+https://github.com/; contact via repo issues)';

const DEFAULT_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9',
};

function describe(err) {
  if (err?.response?.status) return `HTTP ${err.response.status}`;
  return err?.code || err?.message || String(err);
}

function retryable(err) {
  const s = err?.response?.status;
  if (s == null) return true;                 // network / DNS / proxy error
  if (s === 429) return true;
  return s >= 500 && s < 600;
}

async function request(url, config, { retries = 2, backoffMs = 800, log } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !retryable(e)) break;
      const wait = backoffMs * Math.pow(2, attempt);
      log?.debug?.(`    retry ${attempt + 1}/${retries} after ${describe(e)} (${wait}ms) ${url}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** GET a URL as UTF-8 text. Throws on failure (callers use safe()). */
export async function getText(url, opts = {}) {
  const res = await request(url, {
    headers: { Accept: 'text/plain,*/*;q=0.8', ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    timeout: opts.timeout ?? 45000,
    responseType: 'text',
    transformResponse: [d => d],
    maxContentLength: opts.maxBytes ?? 32 * 1024 * 1024,
    maxRedirects: 5,
  }, opts);
  return String(res.data);
}

/** GET a URL as parsed JSON. Throws on failure. */
export async function getJson(url, opts = {}) {
  const res = await request(url, {
    headers: { Accept: 'application/json', ...DEFAULT_HEADERS, ...(opts.headers || {}) },
    params: opts.params,
    timeout: opts.timeout ?? 20000,
    maxRedirects: 5,
  }, opts);
  return res.data;
}

/** GET a URL as HTML text. Throws on failure. */
export async function getHtml(url, opts = {}) {
  const res = await request(url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...DEFAULT_HEADERS,
      ...(opts.headers || {}),
    },
    timeout: opts.timeout ?? 25000,
    responseType: 'text',
    transformResponse: [d => d],
    maxRedirects: 5,
  }, opts);
  return String(res.data);
}

/**
 * Does this URL exist and serve an image? Used for covers.
 *
 * We never put a URL in the catalogue that we have not confirmed resolves —
 * "do not invent URLs". Returns true/false and never throws.
 */
export async function probeImage(url, opts = {}) {
  try {
    const res = await axios.get(url, {
      headers: { Accept: 'image/*', Range: 'bytes=0-1023', ...DEFAULT_HEADERS },
      timeout: opts.timeout ?? 15000,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });
    const ct = String(res.headers?.['content-type'] || '');
    return /^image\//i.test(ct);
  } catch {
    return false;
  }
}

/**
 * Try each candidate URL in order, return { url, text } for the first that
 * works. Throws with a combined message if every candidate fails.
 */
export async function getTextFromFirst(urls, opts = {}) {
  const failures = [];
  for (const url of urls) {
    try {
      const text = await getText(url, opts);
      if (text && text.length > 500) return { url, text };
      failures.push(`${url}: suspiciously short (${text?.length ?? 0} bytes)`);
    } catch (e) {
      failures.push(`${url}: ${describe(e)}`);
      opts.log?.debug?.(`    candidate failed — ${url}: ${describe(e)}`);
    }
  }
  const err = new Error(`all ${urls.length} candidate URLs failed:\n      ` + failures.join('\n      '));
  err.failures = failures;
  throw err;
}

/** First candidate URL that serves an image, else null. */
export async function firstWorkingImage(urls, opts = {}) {
  for (const url of urls) {
    if (await probeImage(url, opts)) return url;
  }
  return null;
}

export { describe as describeError };
