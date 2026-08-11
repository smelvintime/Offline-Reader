const CACHE_NAME = 'cbz-reader-v5.08';

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
  './js/config.js',
  './js/platform.js',
  './js/store.js',
  './js/covers.js',
  './js/reader.js',
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

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data === 'GET_VERSION') {
    event.source.postMessage({ type: 'VERSION', version: CACHE_NAME });
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

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;  // gateway/CDN traffic is not ours to cache

  if (isData(url)) {
    event.respondWith(
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

  if (isFont(url)) {
    event.respondWith(
      caches.match(request)
        .then(cached => cached || fetch(request).then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, copy)).catch(() => {});
          }
          return res;
        }))
        // A missing font is cosmetic: the stack in css/novel.css falls through
        // to a system face, so failing here costs nothing but the specimen.
        .catch(() => new Response('', { status: 503, statusText: 'Service Unavailable' }))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request))
      .catch(() => new Response('Offline — resource not cached', {
        status: 503, statusText: 'Service Unavailable',
      }))
  );
});
