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

## Versionierung

Bei jedem Release synchron bumpen: `APP_VERSION` in `js/update.js` · Cache-Key in `sw.js` · `version.json` · Versionsangaben in `index.html`.
