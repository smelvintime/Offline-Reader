// gateway.js — constants and helpers that belong to the worker entrypoint but
// cannot live in it.
//
// WHY THIS FILE EXISTS: workerd validates every named export of the entry
// module and accepts only functions or ExportedHandlers. A plain
// `export const VERSION = '2.0.0'` in src/index.js makes the runtime refuse to
// start with:
//
//   Uncaught TypeError: Incorrect type for map entry 'VERSION':
//   the provided value is not of type 'function or ExportedHandler'.
//
// So src/index.js exports its default handler and nothing else; anything else
// the tests or other modules need lives here.

import { normalizeHost } from './security.js';

export const VERSION = '2.0.0';

// ── Referer spoofing ─────────────────────────────────────────────────────────
// Hotlink protection checks Referer/Origin. The value a CDN expects is the
// *site* that would normally embed the image, not the CDN host itself.

const KNOWN_REFERERS = new Map([
  ['uploads.mangadex.org', 'https://mangadex.org/'],
  ['cdn.flamecomics.xyz', 'https://flamecomics.xyz/'],
]);

/** Two-part public suffixes, handled crudely but adequately. */
const TWO_PART_SUFFIX = /^(co|com|net|org|gov|edu|ac)\.[a-z]{2}$/;

/**
 * A plausible Referer for a target host. Falls back to the registrable-ish
 * parent domain: `cdn.example.com` → `https://example.com/`.
 */
export function refererFor(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  if (KNOWN_REFERERS.has(host)) return KNOWN_REFERERS.get(host);
  if (host.endsWith('.mangadex.network') || host.endsWith('.mangadex.org')) {
    return 'https://mangadex.org/';
  }
  const labels = host.split('.');
  if (labels.length <= 2) return `https://${host}/`;
  const tail2 = labels.slice(-2).join('.');
  const base = TWO_PART_SUFFIX.test(tail2) ? labels.slice(-3).join('.') : tail2;
  return `https://${base}/`;
}
