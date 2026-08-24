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

## Aufbau des Frontends

`js/app.js` ist der Kern. Vier Bereiche liegen daneben in eigenen Dateien:

| Datei | Inhalt |
|---|---|
| `js/app-quellen.js` | Manga- & Zeitschriften-Quellen (AniList, Jikan, DNB, deutsche Verlage) |
| `js/app-statistik.js` | Statistik, Besitz/Verleih, Lese-Tempo, Tsundoku-Bilanz, Zitat-Export |
| `js/app-erfolge.js` | Abzeichen und ihre Bedingungen |
| `js/app-jahr.js` | Jahresrückblick und Jahres-Duell |

Ohne Build-Schritt und ohne ES-Module: es sind klassische `<script src>`-Dateien, die **nach**
`app.js` geladen werden. Die Bindung läuft über `window.HonIntern` — `app.js` legt dort seine
Werkzeuge ab, die Teilmodule holen sie sich und tragen ihre eigenen Funktionen zurück ein.
Funktionen werden über Weiterleitungen gebunden (spät, damit auch Verweise zwischen den
Teilmodulen funktionieren), Konstanten direkt kopiert. **Veränderliche Variablen gehören nicht
in `HonIntern`** — ein Teilmodul bekäme nur eine Kopie und sähe spätere Änderungen nicht.
Genau daran entscheidet sich, welcher Bereich sich überhaupt herauslösen lässt.

Dass das funktioniert, hängt an einem Detail: `app.js` startet erst bei `DOMContentLoaded`,
also nachdem alle Skripte gelaufen sind. Die Reihenfolge der Teilmodule untereinander ist
deshalb egal — sie müssen nur nach `app.js` stehen.

Jede neue Teildatei braucht drei Einträge: `?v=`-Buster in `index.html`, `SHELL_ASSETS` in
`sw.js`, und sie muss `npm test` überstehen (`test/konsistenz.mjs` prüft die ersten beiden).

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

`test/modul-bindung.mjs` und `test/freie-bezeichner.mjs` sichern die Modul-Architektur ab:
dass jedes Teilmodul aus `HonIntern` bekommt, was es sich holt; dass der Kern dort keine
**Weiterleitung** ablegt (die zeigte sonst auf sich selbst, sobald das Teilmodul fehlt);
dass kein Name doppelt registriert wird; und — per Parser über alle `js/*.js` und `sw.js` —
dass nirgends ein Bezeichner benutzt wird, den niemand deklariert. Letzteres wäre unter
`'use strict'` ein `ReferenceError`, und zwar erst beim Aufruf der betroffenen Funktion.

`test/app-verhalten.mjs` fährt die komplette App in jsdom hoch (echte `index.html`, alle
Skripte in der Reihenfolge aus dem Markup) und steuert sie durch das DOM: Sammlung, Filter,
Sortierung, Statistik, Detailfenster samt gespeichertem Statuswechsel, Serien-Ansicht,
Duplikate, Cover-Ersatz. Diese Datei ist als Charakterisierungsnetz für die Aufteilung von
`app.js` entstanden — sie beschreibt, was die App **tut**, nicht was sie tun sollte, und lief
vor wie nach dem Umbau unverändert durch. Wer an `app.js` oder den Teilmodulen schneidet,
sollte sie vorher grün sehen.

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
