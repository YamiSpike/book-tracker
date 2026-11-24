#!/usr/bin/env node
/**
 * glas-mutanten.mjs — Gegenprobe für die Wirkungsprüfung (test/glas-effekte-check.mjs), seit v3.13.
 *
 * Ein grünes „GLAS-EFFEKTE OK“ sagt nur etwas, wenn die Prüfung auch rot werden kann. Dieses Skript lässt glas-effekte-check mit je einer
 * absichtlich kaputten Kopie laufen (GLAS_MUTANT=…) und verlangt, dass JEDE durchfällt:
 *   ip        fehlermeldung.js ohne user={ip_address:null}
 *   vendor    fehlermeldung.js ohne den Frame-Skip für /sentry-sdk.js
 *   suchteil  fehlermeldung.js ohne Kürzung der Seitenwechsel-Spur
 *   blase     glas-licht.js ohne animationcancel und ohne Notanker
 *   update    update.js ohne .catch an r.update() (unbehandelte Ablehnung)
 * Erwartet je Mutant: Exit 1 und „GLAS-EFFEKTE FEHLER“. Exit 2 (Muster nicht gefunden) oder Exit 0 (Mutant überlebt) ist ein Fehler.
 *
 * Aufruf: node test/glas-mutanten.mjs      Erwartet „MUTANTEN OK: 5 von 5 fielen durch“ (Exit 0).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAEUFE = [
  { name: 'ip', env: { GLAS_NUR: 'fehler' }, erwarte: /user soll genau/ },
  { name: 'vendor', env: { GLAS_NUR: 'fehler' }, erwarte: /Frame-Skip für \/sentry-sdk\.js/ },
  { name: 'suchteil', env: { GLAS_NUR: 'fehler' }, erwarte: /Seitenwechsel-Spur mit Suchteil/ },
  { name: 'update', env: { GLAS_NUR: 'fehler' }, erwarte: /r\.update\(\)/ },
  { name: 'blase', env: { GLAS_NUR: 'abbruch' }, erwarte: /Blasen (bleiben|sind auch nach)/ },
];

let ok = 0;
const probleme = [];
for (const l of LAEUFE) {
  const r = spawnSync(process.execPath, [join(W, 'test', 'glas-effekte-check.mjs'), 'chromium'], {
    cwd: W, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, GLAS_NUR: '', GLAS_MUTANT: l.name, ...l.env },
  });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  if (r.status === 2) probleme.push(`${l.name}: Gegenprobe läuft ins Leere (Exit 2) — ${text.split('\n').find((z) => /MUTANT/.test(z)) || 'Muster passt nicht mehr zur Quelle'}`);
  else if (r.status === 0) probleme.push(`${l.name}: Mutant ÜBERLEBT — die Prüfung merkt den Fehler nicht`);
  else if (!/GLAS-EFFEKTE FEHLER/.test(text)) probleme.push(`${l.name}: Exit ${r.status} ohne „GLAS-EFFEKTE FEHLER“ (Lauf abgestürzt?) ${text.slice(-300).replace(/\s+/g, ' ')}`);
  else if (!l.erwarte.test(text)) probleme.push(`${l.name}: fällt durch, aber aus anderem Grund als erwartet (${l.erwarte})`);
  else { ok++; console.log(`  Mutant ${l.name}: erkannt (Exit 1, Meldung passt)`); }
}
for (const p of probleme) console.log('  FEHLER ' + p);
console.log(probleme.length ? `MUTANTEN FEHLER: ${probleme.length}` : `MUTANTEN OK: ${ok} von ${LAEUFE.length} fielen durch`);
process.exit(probleme.length ? 1 : 0);
