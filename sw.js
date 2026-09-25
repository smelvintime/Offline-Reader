// BUMP THIS whenever anything in SHELL_ASSETS changes.
//
// The shell is cache-first, and `activate` only clears caches whose name does
// not match, so a stale CACHE_NAME serves the OLD css/js to every browser that
// has already opened the app — forever. Two shipped CSS fixes went out against
// v5.08 without a bump and reached nobody; the code was right and the readers
// still had the bug. If you touched styles.css, css/**, or any js/** file in
// the list below, this line changes too.
const CACHE_NAME = 'cbz-reader-v5.69';

// The app shell — precached on install so the PWA opens with no network at all.
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './css/catalogue.css',
  './css/novel.css',
  './css/importer.css',
  './css/goals.css',
  './css/thoughts.css',
  './css/sources.css',
  './css/settings.css',
  './css/voice.css',
  './js/config.js',
  './js/platform.js',
  './js/store.js',
  './js/covers.js',
  './js/image-zoom.js',
  './js/reader.js',
  './js/novel-voice.js',
  './js/novel-voice-worker.js',
  './js/voice-native-tokenizer.mjs',
  './js/novel-reader.js',
  './js/importer.js',
  './js/goals.js',
  './js/thoughts.js',
  './js/sources.js',
  './js/settings.js',
  './js/catalogue.js',
  './manifest.json',
  './icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './jszip.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // addAll is all-or-nothing: one 404 during a partial deploy would leave
      // the PWA with no cache at all. Cache each asset independently instead.
      .then(cache => Promise.all(
        SHELL_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[sw] skipped', url, err))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// The voice engine (~24 MB) lives in its own cache so a shell bump does not
// evict it — nobody should re-download the narrator because a CSS file
// changed. Bump this only when vendor/tts/** itself changes.
const VOICE_CACHE = 'or-voice-engine-v1';

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        // Only reap our own shell caches. This origin also holds caches that
        // are not ours to clear: VOICE_CACHE above, and the model caches the
        // voice engine's runtime owns ('transformers-cache', 'kokoro-voices'
        // — ~90 MB of downloaded weights). Deleting those on every shell bump
        // would silently re-bill the narrator download each release.
        keys.filter(k => k.startsWith('cbz-reader-') && k !== CACHE_NAME)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_NAME });
  }
  // A page that is not isolated asks whether a reload would make it so. Only a
  // worker that adds the isolation headers (below) knows to answer.
  if (event.data === 'COI_HEADERS?') {
    event.source.postMessage({ type: 'COI_HEADERS' });
  }
});

// Catalogue and chapter data are network-first so a reader online sees fresh
// chapters, with the cached copy as the offline fallback. Everything else is
// cache-first, which is what makes the shell instant.
function isData(url) {
  return url.pathname.endsWith('/catalog.json') || url.pathname.includes('/chapters/');
}

// Typefaces ship with the app but are deliberately left out of SHELL_ASSETS:
// half a megabyte of fonts nobody selected is half a megabyte wasted. They are
// kept the first time one is actually used, so choosing OpenDyslexic once is
// enough for it to still be there with the radio off.
function isFont(url) {
  return url.pathname.includes('/fonts/') && url.pathname.endsWith('.woff2');
}

// The natural-voice engine (vendor/tts/** and its worker) follows the same
// rule at a larger scale: ~24 MB nobody asked for stays out of the shell, and
// enabling the Natural voice once keeps the whole engine for offline. The
// model weights are cross-origin (huggingface.co) and never pass through
// here — transformers.js keeps those in its own Cache API bucket.
function isVoiceEngine(url) {
  return url.pathname.includes('/vendor/tts/');
}

// ── Cross-origin isolation ──────────────────────────────────────────────────
//
// The natural voice runs ONNX Runtime in wasm, and on one core a phone makes
// audio several times slower than it is spoken: every sentence waits on the
// next. ORT can use several cores, but only in a cross-origin isolated page,
// because its threads share memory through SharedArrayBuffer. Static hosts do
// not let us set response headers, so the service worker adds them to the
// documents and workers it serves. The native app has no service worker and
// is untouched; it runs the model natively anyway.
//
// The cost is that an isolated page may only embed cross-origin resources
// that opt in. `credentialless` loads them anyway, without cookies, which is
// all a book cover needs. Safari does not support it, so there the stricter
// `require-corp` applies and covers hot-linked from a source site fall back
// to the generated artwork, which the image error handlers already do.
// Firefox and Chromium report themselves; everything on iOS is WebKit
// whatever its name says (CriOS, FxiOS), so it gets the strict policy.
const COEP = (/(Chrome|Chromium|Firefox)\//.test(self.navigator.userAgent)
  && !/(iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS)/.test(self.navigator.userAgent))
  ? 'credentialless' : 'require-corp';

// Documents and workers carry the policy; subresources do not need it.
function wantsIsolation(request) {
  return request.mode === 'navigate'
    || request.destination === 'document'
    || request.destination === 'worker'
    || request.destination === 'sharedworker';
}

function isolate(res) {
  // An opaque or error response cannot be rewritten, and has nothing to say.
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', COEP);
  // A 304 or 204 has no body, and the constructor refuses one for them.
  const body = (res.status === 204 || res.status === 304) ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;  // gateway/CDN traffic is not ours to cache

  const iso = wantsIsolation(request);
  const respond = p => event.respondWith(iso ? Promise.resolve(p).then(isolate) : p);

  // Application-owned voice code must win over legacy vendor-cache entries.
  if (url.pathname.endsWith('/js/novel-voice-worker.js') || url.pathname.endsWith('/js/voice-native-tokenizer.mjs')) {
    respond(caches.open(CACHE_NAME).then(c => c.match(request)).then(hit => hit || fetch(request)));
    return;
  }

  if (isData(url)) {
    respond(
      fetch(request)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(request).then(cached =>
          cached || new Response('{"error":"offline"}', {
            status: 503, headers: { 'Content-Type': 'application/json' },
          })
        ))
    );
    return;
  }

  if (isFont(url) || isVoiceEngine(url)) {
    const bucket = isFont(url) ? CACHE_NAME : VOICE_CACHE;
    respond(
      caches.match(request)
        .then(cached => cached || fetch(request).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(bucket).then(c => c.put(request, copy)).catch(() => {});
          }
          return res;
        }))
        // A missing font is cosmetic (the CSS stack falls through to a system
        // face) and a missing voice engine is survivable (novel-voice falls
        // back to the device engine), so failing here breaks nothing.
        .catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }))
    );
    return;
  }

  respond(
    caches.match(request)
      .then(cached => cached || fetch(request))
      .catch(() => new Response('Offline — resource not cached', {
        status: 503, statusText: 'Service Unavailable',
      }))
  );
});
