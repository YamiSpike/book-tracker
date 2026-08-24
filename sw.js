/* Hon 本 · Bücher Tracker — Service Worker (Version steht in CACHE/BUST unten)
   Update NUR per Banner-Klick (Japan-Navigator-Muster):
   - SHELL-Cache (buecher-shell) hält index.html + App-Code (?v=-Buster) und
     ÜBERLEBT SW-Updates → die installierte App bleibt auf ihrer Version,
     auch online, auch nach Deploy, auch nach SW-Update.
   - Eine neue Version kommt AUSSCHLIESSLICH über den Update-Banner: dessen
     Klick lädt mit ?_v=… → Netz erzwungen → Shell erneuert.
   - Cover-Cache (buecher-covers-v1) bleibt eigenständig und überlebt Updates. */
const CACHE = 'hon-v3-8';
// Cover-Cache ist EIGENSTÄNDIG versioniert und überlebt App-Updates —
// sonst wären nach jedem Versions-Bump alle Offline-Cover weg
const COVER_CACHE = 'buecher-covers-v1';

// ───── Cover-Cache im Zaum halten ─────────────────────────────────────────
// Der Cover-Cache überlebt bewusst jedes Update — ohne Deckel wächst er dadurch
// unbegrenzt. Reißt der Origin sein Speicher-Kontingent, räumt der Browser unter
// Umständen ALLES für diese Herkunft ab, auch die IndexedDB mit der Sammlung.
// Ein paar Cover neu zu laden ist billig; die Bücher zu verlieren wäre es nicht.
const COVER_MAX = 3000;        // Regelbetrieb: so viele Cover bleiben liegen
const COVER_MAX_ENG = 1200;    // bei Speicherdruck: härter beschneiden
const COVER_PRUEF_ALLE = 60;   // danach erneut nachzählen
let coverNeu = 0, coverPutzt = false;
// Beim ERSTEN neu gecachten Cover jeder Worker-Runde wird immer nachgezählt.
// Ohne das griff der Deckel im Alltag so gut wie nie: coverNeu ist eine ganz normale
// Modulvariable, und der Browser beendet einen untätigen Service Worker nach wenigen
// Sekunden — beim nächsten Start beginnt der Zähler wieder bei 0 und erreichte die 60
// praktisch nur beim Massen-Nachladen. Der Cache wuchs also weiter, obwohl der Deckel
// eingebaut war. Ein Worker-Start ist der natürliche, häufige Prüfzeitpunkt.
let coverErstpruefung = true;

// Nutzt diese Herkunft schon einen Großteil ihres Kontingents?
async function speicherKnapp() {
  try {
    if (!self.navigator || !navigator.storage || !navigator.storage.estimate) return false;
    const { usage, quota } = await navigator.storage.estimate();
    return !!(usage && quota && usage / quota > 0.6);
  } catch (err) { return false; }
}

async function coverBeschneiden() {
  if (coverPutzt) return;
  coverPutzt = true;
  try {
    const grenze = (await speicherKnapp()) ? COVER_MAX_ENG : COVER_MAX;
    const c = await caches.open(COVER_CACHE);
    const keys = await c.keys();
    if (keys.length <= grenze) return;
    // Die Cache-API liefert die Schlüssel in Einfüge-Reihenfolge — die ältesten
    // stehen vorn. Das ist FIFO, kein echtes LRU: ein verdrängtes Cover wird beim
    // nächsten Anzeigen schlicht neu geladen. Echtes LRU würde bei JEDEM Treffer
    // einen Cache-Schreibvorgang kosten — beim Scrollen durch tausende Karten
    // wäre das teurer als der Nutzen.
    const weg = keys.slice(0, keys.length - grenze);
    for (let i = 0; i < weg.length; i += 100) {
      await Promise.all(weg.slice(i, i + 100).map((k) => c.delete(k).catch(() => {})));
    }
  } catch (err) {} finally { coverPutzt = false; }
}
// App-Shell (index.html + versionierte Sub-Assets): Cache-First — Updates
// kommen NUR über den Banner-Klick (?_v=…) in die App. Überlebt SW-Updates,
// sonst würde jeder Deploy still updaten.
const SHELL = 'buecher-shell';
// MUSS mit den ?v=-Bustern in index.html übereinstimmen (Versions-Trias!)
const BUST = '?v=3.8';

// Kosmetische Statik (unkritisch fürs Versions-Pinning) — versionierter Cache
const PRECACHE = [
  './manifest.json',
  './icon.svg?v=3.8',
  './img/fuku.png',
  './icons/icon-180.png?v=3.8',
  './icons/icon-192.png?v=3.8',
  './icons/icon-512.png?v=3.8',
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
  './js/app-quellen.js',
  './js/app-statistik.js',
  './js/app-erfolge.js',
  './js/app-jahr.js',
  './js/mascot.js',
  './js/whatsnew.js',
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

      // Lücken in der Shell schließen. Beim install wird jede Datei einzeln mit
      // .catch(() => null) hinzugefügt — schlägt eine fehl, gilt die Shell trotzdem
      // als befüllt, weil nur auf './' geprüft wird. Die fehlende Datei würde sonst
      // erst beim ersten Zugriff nachgeholt, und weil ?v= kein Inhalts-Hash ist,
      // brächte sie nach einem zwischenzeitlichen Deploy NEUEN Code unter der ALTEN
      // Versionsnummer. Hier ist die Version noch stimmig — der richtige Moment.
      try {
        const s = await caches.open(SHELL);
        if (await s.match('./')) {
          for (const a of SHELL_ASSETS) {
            if (!(await s.match(a))) await s.add(a).catch(() => null);
          }
        }
      } catch (err) {}

      // Zum Schluss den Cover-Cache auf Maß bringen (blockiert den Start nicht)
      await coverBeschneiden();
    })()
  );
});

// Cover werden per <img> geholt, also im Modus no-cors: JEDE Antwort kommt opaque
// zurück — auch 404, 429 und 503. res.ok ist dann immer false, der Status nicht
// auslesbar. Der Cover-Zweig unten muss opaque trotzdem einlagern (sonst gäbe es
// keine Offline-Cover), kann eine Fehlantwort dabei aber nicht erkennen. Da der
// Zweig strikt cache-first ist, bliebe ein kaputtes Bild für immer liegen.
// Lösung: die einzige Stelle, die es WEISS, sagt Bescheid — der Cover-Ausfall-
// Handler in js/app.js meldet die Adresse hierher, und sie fliegt aus dem Cache.
// Beim nächsten Anzeigen wird neu geholt.
self.addEventListener('message', (e) => {
  const d = e.data;
  if (!d || d.type !== 'COVER_KAPUTT' || !d.url) return;
  e.waitUntil(caches.open(COVER_CACHE).then((c) => c.delete(d.url)).catch(() => {}));
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
          if (res && (res.ok || res.type === 'opaque')) {
            c.put(req, res.clone()).catch(() => {});
            // Nur gelegentlich nachzählen — cache.keys() ist O(n) und hat bei
            // tausenden Covern in einem Bild-Request nichts verloren.
            if (coverErstpruefung || ++coverNeu >= COVER_PRUEF_ALLE) {
              coverErstpruefung = false;
              coverNeu = 0;
              try { e.waitUntil(coverBeschneiden()); } catch (err2) {}
            }
          }
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
          // NUR eine direkte, gleicher-Herkunft-Antwort einbrennen. Eine gefolgte
          // Weiterleitung liefert ebenfalls status 200 — der Browser lehnt eine
          // Antwort mit gesetztem redirected-Flag aber ab, wenn sie später aus dem
          // Cache für eine Navigation zurückgegeben wird („a redirected response
          // was used for a request whose redirect mode is not follow"). Die App
          // startete danach gar nicht mehr, auch online nicht.
          if (res && res.status === 200 && res.type === 'basic' && !res.redirected) {
            shell.put('./', res.clone()).catch(() => {});
          }
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
            // ERST die neue Fassung sichern, DANN die alte entsorgen — nie umgekehrt.
            // Vorher stand hier löschen-dann-speichern, und das Speichern war weder
            // abgewartet noch geprüft. Scheiterte es (Kontingent voll, oder der Worker
            // wird zwischen Antwort und Schreibvorgang beendet), lag anschließend
            // WEDER die alte NOCH die neue Fassung im Cache. Offline fand dann auch
            // der ignoreSearch-Notnagel weiter unten nichts mehr — die App startete
            // schlicht nicht. Selbstheilung gäbe es nur online.
            let gesichert = true;
            try { await shell.put(req, res.clone()); } catch (err) { gesichert = false; }
            if (gesichert) {
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
            }
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
