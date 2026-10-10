# HandOff — Hon 本 (book-tracker)

Kurzer Stand für die nächste Session. Aufbau und Bedienung stehen in [README.md](README.md).
Vor jedem Release `node test/konsistenz.mjs` (prüft Versions-Trias, Buster, Inline-Handler).

## Versionen

Bei jedem Release gemeinsam ändern: `APP_VERSION` in `js/update.js`, `CACHE` und `BUST` in `sw.js`
(`hon-v3-11`, Punkt wird Bindestrich), `version.json`, alle `?v=` in `index.html`, `manifest.json` und
`sw.js`, dazu die sichtbaren Labels („Version v3.10“, „Bücher Tracker v3.10“) in `index.html`. Außerdem
oben in `js/whatsnew.js` einen Eintrag in `CHANGELOG` ergänzen — mit exakt dem Wert von `APP_VERSION`.

## „Was ist neu“ als Dropdown (seit v3.11)

`js/whatsnew.js`: `reiterAufbauen(ov, liste)` zeigt alle Versionen in einem Dropdown (`<select class="wn-select">`, neueste zuerst; bei nur einer Version ohne Auswahl). Nach einem Update erscheinen nur die neuen Versionen.
Einstellungen → Über → „🆕 Was ist neu“ (`#wn-oeffnen` in `index.html`, in `whatsnew.js` gebunden — kein
Inline-Handler wegen der CSP) öffnet die gesamte Historie.
