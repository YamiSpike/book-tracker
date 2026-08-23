# Hon 本 · Bücher Tracker

Statische PWA zum Sammeln, Bewerten und Wiederfinden gelesener Bücher — mit personalisierten
Buch-Empfehlungen aus der eigenen Sammlung und Cloud-Sync über alle Geräte.

## Funktionen

- 🔍 **Entdecken** — Live-Suche über Google Books (Titel, Autor·in, ISBN)
- 📚 **Sammlung** — Lesestatus (Gelesen / Lese gerade / Will lesen), 5-Sterne-Bewertung, Notizen, Filter & Sortierung
- ✨ **Für dich** — Empfehlungen aus Lieblings-Genres, -Autor·innen und Bewertungen, mit Begründung
- 📊 **Statistik** — gelesene Bücher & Seiten, Ø-Bewertung, Top-Genres/-Autor·innen
- ☁️ **Cloud-Sync** — E-Mail-Konto (geteilt mit Nihongo- & Japan-App), Multi-Device-Merge ohne Datenverlust, Passwort-Wiederherstellung per Code oder E-Mail
- 📱 **PWA** — offline-fähig, installierbar, Update-Banner statt Auto-Reload

## Stack

- Frontend: Vanilla JS + CSS (kein Build-Schritt)
- Backend: Vercel Serverless Functions (`api/`) + Upstash Redis
- Buchdaten: Google Books API (kein Key nötig)

## Deployment (Vercel)

Benötigte Environment-Variablen für den Cloud-Sync:

| Variable | Zweck |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash-Redis REST-URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash-Redis REST-Token |
| `JWT_SECRET` | Signatur-Schlüssel für Login-Tokens (Pflicht) |
| `RESEND_API_KEY` | optional: Passwort-Reset per E-Mail |
| `RESEND_FROM` | optional: Absender-Adresse |

Ohne diese Variablen läuft die App vollständig lokal (localStorage); der Cloud-Login meldet dann sauber „noch nicht eingerichtet".

## Tests

```bash
npm install && npm test
```

Ohne Browser und ohne echte Datenbank. `test/helpers/upstash-mock.mjs` spricht das Upstash-REST-Protokoll
nach, sodass die Handler in `api/` unverändert laufen; `js/cloud.js` und `sw.js` laufen in einer
nachgebauten Browser- bzw. Worker-Umgebung. Abgedeckt sind die Stellen, an denen ein Fehler Daten kostet:
Cloud-Merge, Rate-Limits, Besitzprüfung der Teilen-Links und der Cover-Cache-Deckel.

`test/konsistenz.mjs` prüft zusätzlich die Release-Mechanik: dass `APP_VERSION`, der
SW-Cache-Key, `version.json`, alle `?v=`-Buster, die sichtbaren Labels und der
„Was ist neu"-Eintrag dieselbe Version tragen, dass jede von `index.html` geladene
Datei im SW-Precache steht, und dass keine Inline-Event-Handler zurückkommen.

## Sicherheit

Die Content-Security-Policy steht als `<meta>` in `index.html`, nicht als Header in
`vercel.json`: ein Header über `/(.*)` träfe auch `sw.js`, und im Service Worker gilt
dessen eigene CSP für seine `fetch()`-Aufrufe — der Cover-Cache wäre unter einer strengen
`connect-src` sofort tot. `frame-ancestors` wirkt nur als Header und steht deshalb dort.

`img-src` ist bewusst offen für `https:`: Cover kommen aus offenen Buch-APIs und über
JSON-/Goodreads-Import auch von beliebigen Fremdadressen — eine Positivliste würde
importierte Sammlungen still zerlegen. Der eigentliche Schutz sitzt bei `script-src 'self'`.

## Versionierung

Bei jedem Release synchron bumpen: `APP_VERSION` in `js/update.js` · Cache-Key in `sw.js` · `version.json` · Versionsangaben in `index.html`.
