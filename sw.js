/* Hon 本 · Bücher Tracker — Service Worker v11.1 */
const CACHE = 'buecher-v11-1';
const ASSETS = [
  './',
  './index.html',
  './css/styles.css',
  './js/vendor/lz-string.min.js',
  './js/store.js',
  './js/app.js',
  './js/cloud.js',
  './js/update.js',
  './js/mascot.js',
  './manifest.json',
  './icon.svg',
  './img/fuku.png',
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

  // Offline-Cover: Buchcover cache-first in eigenem Cache → Sammlung sieht offline komplett aus
  const coverHosts = ['books.google.com', 'covers.openlibrary.org', 'portal.dnb.de', 's4.anilist.co', 'cdn.myanimelist.net'];
  if (coverHosts.some((h) => url.hostname.includes(h))) {
    e.respondWith(
      caches.open('buecher-covers-v1').then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).catch(() => {});
          return res;
        } catch (err) {
          return hit || Response.error();
        }
      })
    );
    return;
  }

  const externalApi = ['googleapis.com', 'openlibrary.org', 'services.dnb.de', 'graphql.anilist.co', 'api.jikan.moe'];
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
