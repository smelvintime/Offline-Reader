const CACHE_NAME = 'cbz-reader-v5.01';

// The app shell — precached on install so the PWA opens with no network at all.
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './css/catalogue.css',
  './css/novel.css',
  './css/importer.css',
  './js/config.js',
  './js/store.js',
  './js/reader.js',
  './js/novel-reader.js',
  './js/importer.js',
  './js/catalogue.js',
  './manifest.json',
  './icon.svg',
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

  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request))
      .catch(() => new Response('Offline — resource not cached', {
        status: 503, statusText: 'Service Unavailable',
      }))
  );
});
