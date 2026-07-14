/* Hon 本 · Bücher Tracker — Service Worker v13
   Update NUR per Banner-Klick (Japan-Navigator-Muster):
   - SHELL-Cache (buecher-shell) hält index.html + App-Code (?v=-Buster) und
     ÜBERLEBT SW-Updates → die installierte App bleibt auf ihrer Version,
     auch online, auch nach Deploy, auch nach SW-Update.
   - Eine neue Version kommt AUSSCHLIESSLICH über den Update-Banner: dessen
     Klick lädt mit ?_v=… → Netz erzwungen → Shell erneuert.
   - Cover-Cache (buecher-covers-v1) bleibt eigenständig und überlebt Updates. */
const CACHE = 'buecher-v13';
// Cover-Cache ist EIGENSTÄNDIG versioniert und überlebt App-Updates —
// sonst wären nach jedem Versions-Bump alle Offline-Cover weg
const COVER_CACHE = 'buecher-covers-v1';
// App-Shell (index.html + versionierte Sub-Assets): Cache-First — Updates
// kommen NUR über den Banner-Klick (?_v=…) in die App. Überlebt SW-Updates,
// sonst würde jeder Deploy still updaten.
const SHELL = 'buecher-shell';
// MUSS mit den ?v=-Bustern in index.html übereinstimmen (Versions-Trias!)
const BUST = '?v=13';

// Kosmetische Statik (unkritisch fürs Versions-Pinning) — versionierter Cache
const PRECACHE = [
  './manifest.json',
  './icon.svg',
  './img/fuku.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// App-Code: gehört zur gepinnten Shell-Version → persistenter SHELL-Cache.
// Exakt die Dateien, die index.html mit ?v=-Buster referenziert.
const SHELL_ASSETS = [
  './css/styles.css',
  './js/vendor/lz-string.min.js',
  './js/store.js',
  './js/update.js',
  './js/cloud.js',
  './js/app.js',
  './js/mascot.js',
].map((p) => p + BUST);

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await Promise.all(PRECACHE.map((a) => c.add(a).catch(() => null)));
      // Shell + App-Code NUR befüllen wenn LEER (Erstinstallation) — ein
      // SW-Update darf die gepinnte App-Version NICHT still überschreiben
      // (der Update-Banner entscheidet)
      try {
        const s = await caches.open(SHELL);
        if (!(await s.match('./'))) {
          await Promise.all(
            ['./'].concat(SHELL_ASSETS).map((a) => s.add(a).catch(() => null))
          );
        }
      } catch (err) {}
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Alte App-Caches löschen — aber Offline-Cover (buecher-covers-v1) und
      // die App-Shell (buecher-shell) NICHT: Cover + Update-per-Banner überleben
      await Promise.all(
        keys
          .filter((k) => k !== CACHE && k !== COVER_CACHE && k !== SHELL)
          .map((k) => caches.delete(k))
      );
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
  const sameOrigin = url.origin === self.location.origin;

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
      caches.open(COVER_CACHE).then(async (c) => {
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

  // HTML/Navigation (App-Shell) — CACHE-FIRST: die App startet immer aus dem
  // lokalen Speicher (schnell + offline). Eine NEUE Version kommt AUSSCHLIESSLICH
  // über den Update-Banner: dessen Klick lädt mit ?_v=… → Netz erzwungen →
  // Shell erneuert. Kein stilles Selbst-Updaten mehr.
  if (sameOrigin && (req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/')) {
    e.respondWith(
      (async () => {
        const shell = await caches.open(SHELL);
        const forceFresh = url.searchParams.has('_v');
        if (!forceFresh) {
          const hit = await shell.match('./');
          if (hit) return hit;
        }
        try {
          const res = await fetch(req);
          if (res && res.status === 200) shell.put('./', res.clone()).catch(() => {});
          return res;
        } catch (err) {
          const hit = await shell.match('./');
          if (hit) return hit;
          throw err;
        }
      })()
    );
    return;
  }

  // Versionierte Sub-Assets (?v=…) — CACHE-FIRST im persistenten SHELL-Cache:
  // sie ändern sich nur zusammen mit der neuen Shell (neue index.html
  // referenziert neue ?v=-URLs). Pro Datei bleibt genau EINE Version im Cache.
  if (sameOrigin && url.searchParams.has('v')) {
    e.respondWith(
      (async () => {
        const shell = await caches.open(SHELL);
        const hit = await shell.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            // Alte Version(en) derselben Datei entsorgen, dann neu speichern
            try {
              const keys = await shell.keys();
              await Promise.all(
                keys
                  .filter((k) => {
                    const ku = new URL(k.url);
                    return ku.pathname === url.pathname && ku.search !== url.search;
                  })
                  .map((k) => shell.delete(k))
              );
            } catch (err) {}
            shell.put(req, res.clone()).catch(() => {});
          }
          return res;
        } catch (err) {
          // Offline-Notnagel: gleiche Datei in anderer Version ist besser als nichts
          const loose = await shell.match(req, { ignoreSearch: true });
          if (loose) return loose;
          throw err;
        }
      })()
    );
    return;
  }

  // Rest (Manifest, Icons, Maskottchen-Bild, Fonts): Stale-While-Revalidate
  // im versionierten Cache — kosmetisch, unkritisch fürs Versions-Pinning
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
