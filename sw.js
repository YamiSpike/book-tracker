/* Hon 本 · Bücher Tracker — Service Worker v3.1 */
const CACHE = 'buecher-v3-1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/cloud.js',
  './js/update.js',
  './js/mascot.js',
  './manifest.json',
  './icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(
      ASSETS.map((a) => c.add(a).catch(() => null))
    ))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      // Alle offenen Tabs informieren → App prüft version.json und zeigt ggf. den Update-Banner
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.postMessage({ type: 'SW_ACTIVATED', cache: CACHE }));
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // version.json: IMMER frisch vom Netz, NIE cachen — Grundlage des Update-Banners
  if (url.pathname.endsWith('/version.json')) {
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
    return;
  }

  // API + externe Dienste: Network only (frische Daten, nie cachen)
  if (url.pathname.startsWith('/api/')) return;
  const externalApi = ['googleapis.com', 'books.google.com', 'openlibrary.org', 'covers.openlibrary.org', 'services.dnb.de', 'portal.dnb.de'];
  if (externalApi.some((h) => url.hostname.includes(h))) return;

  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
