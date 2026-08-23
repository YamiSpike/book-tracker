// Release-Konsistenz: prueft mechanisch, was sonst beim Bump vergessen wird.
// Bei v14.2 blieben die sichtbaren Labels auf v14 und die Icon-Buster im
// SW-Precache auf v14.1 — genau das faengt diese Datei ab.
import fs from 'node:fs';

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i ? '  -> ' + i : '')));

const html = fs.readFileSync('index.html', 'utf8');
const sw = fs.readFileSync('sw.js', 'utf8');
const update = fs.readFileSync('js/update.js', 'utf8');
const manifest = fs.readFileSync('manifest.json', 'utf8');
const version = JSON.parse(fs.readFileSync('version.json', 'utf8'));
const whatsnew = fs.readFileSync('js/whatsnew.js', 'utf8');

console.log('');
console.log('-- Versions-Trias ---------------------------------------');

const appVersion = (update.match(/APP_VERSION\s*=\s*'(v[\d.]+)'/) || [])[1];
pruefe('APP_VERSION in js/update.js gefunden', !!appVersion, appVersion);
const kurz = String(appVersion || '').replace(/^v/, '');       // "3.5"
const cacheKey = (sw.match(/const CACHE = '([^']+)'/) || [])[1];
const bust = (sw.match(/const BUST = '\?v=([^']+)'/) || [])[1];

pruefe('version.json stimmt mit APP_VERSION ueberein', version.v === appVersion, version.v + ' vs ' + appVersion);
pruefe('sw.js BUST stimmt mit APP_VERSION ueberein', bust === kurz, bust + ' vs ' + kurz);
pruefe('sw.js CACHE-Key folgt der Version', cacheKey === 'hon-v' + kurz.replace(/\./g, '-'), cacheKey);

// Alle ?v=-Buster in index.html und manifest.json
const busterHtml = [...html.matchAll(/\?v=([\d.]+)/g)].map((m) => m[1]);
const busterMani = [...manifest.matchAll(/\?v=([\d.]+)/g)].map((m) => m[1]);
const busterSw = [...sw.matchAll(/\?v=([\d.]+)/g)].map((m) => m[1]);
pruefe('alle ?v=-Buster in index.html auf ' + kurz,
  busterHtml.length > 0 && busterHtml.every((v) => v === kurz), [...new Set(busterHtml)].join(', '));
pruefe('alle ?v=-Buster in manifest.json auf ' + kurz,
  busterMani.length > 0 && busterMani.every((v) => v === kurz), [...new Set(busterMani)].join(', '));
pruefe('alle ?v=-Buster in sw.js auf ' + kurz,
  busterSw.length > 0 && busterSw.every((v) => v === kurz), [...new Set(busterSw)].join(', '));

// Sichtbare Labels
const labels = [...html.matchAll(/v(\d+\.\d+|\d+)(?=\s*<|\s*")/g)].map((m) => m[1]);
const sichtbar = [...html.matchAll(/Version (v[\d.]+)|Tracker (v[\d.]+)/g)].map((m) => m[1] || m[2]);
pruefe('sichtbare Versionslabels stimmen (' + sichtbar.join(', ') + ')',
  sichtbar.length >= 2 && sichtbar.every((v) => v === appVersion), sichtbar.join(', '));

// „Was ist neu" braucht einen Eintrag fuer diese Version
pruefe('whatsnew.js hat einen Eintrag fuer ' + appVersion,
  new RegExp('v:\\s*"' + appVersion.replace('.', '\\.') + '"').test(whatsnew));

console.log('');
console.log('-- Service Worker kennt alle Dateien --------------------');

// Jede von index.html geladene Datei mit ?v= muss im SW-SHELL_ASSETS stehen
const geladen = [...html.matchAll(/(?:src|href)="([^"]+?)\?v=[\d.]+"/g)].map((m) => m[1]);
const shellBlock = (sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\]/) || [])[1] || '';
const precacheBlock = (sw.match(/const PRECACHE = \[([\s\S]*?)\]/) || [])[1] || '';
const imSw = shellBlock + precacheBlock;
for (const datei of geladen) {
  const rein = datei.replace(/^\.?\//, '');
  pruefe('sw.js kennt ' + rein, imSw.includes(rein), 'fehlt in SHELL_ASSETS/PRECACHE');
}
pruefe('index.html laedt ueberhaupt versionierte Dateien', geladen.length >= 7, geladen.length + ' Dateien');

console.log('');
console.log('-- Content-Security-Policy ------------------------------');

const meta = (html.match(/<meta http-equiv="Content-Security-Policy" content="([\s\S]*?)"\s*\/?>/) || [])[1];
pruefe('CSP-Meta-Tag vorhanden', !!meta);
if (meta) {
  const hat = (d) => new RegExp('(^|;)\\s*' + d + '\\s').test(meta);
  pruefe("script-src ohne 'unsafe-inline'", hat('script-src') && !/script-src[^;]*unsafe-inline/.test(meta), meta.match(/script-src[^;]*/));
  pruefe("script-src ohne 'unsafe-eval'", !/script-src[^;]*unsafe-eval/.test(meta));
  pruefe("object-src ist 'none'", /object-src\s+'none'/.test(meta));
  pruefe("base-uri ist gesetzt", hat('base-uri'));
  pruefe('default-src ist gesetzt', hat('default-src'));
  // Jeder Host, den der SW fuer APIs kennt, muss in connect-src stehen
  const swApis = (sw.match(/const externalApi = \[([^\]]*)\]/) || [])[1] || '';
  const hosts = [...swApis.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const connect = (meta.match(/connect-src([^;]*)/) || [])[1] || '';
  for (const h of hosts) {
    // googleapis.com steht im SW verkuerzt, in der CSP als www.googleapis.com
    pruefe('connect-src deckt ' + h, connect.includes(h), connect.trim().slice(0, 120));
  }
}

console.log('');
console.log('-- Keine Inline-Event-Handler ---------------------------');

const quellen = ['index.html', 'js/app.js', 'js/cloud.js', 'js/store.js', 'js/update.js', 'js/mascot.js', 'js/whatsnew.js'];
// Kommentare raus, bevor gesucht wird — sonst schlaegt der Test auf Kommentaren an,
// die Inline-Handler nur ERWAEHNEN (z.B. die Begruendung, warum es sie nicht mehr gibt).
// HTML-Kommentare ebenfalls, dort steht die CSP-Begruendung.
const ohneKommentare = (s) => s
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

for (const f of quellen) {
  const s = ohneKommentare(fs.readFileSync(f, 'utf8'));
  // Nur echte HTML-Attribute zaehlen. img.onerror = function(){} in JS ist
  // KEINE CSP-Verletzung — nur das Attribut im Markup ist eine.
  const treffer = [...s.matchAll(/\son(?:error|click|load|change|submit|input)\s*=\s*["']/g)];
  pruefe(f + ' ohne Inline-Handler', treffer.length === 0, treffer.length + ' Fundstellen');
}
pruefe('index.html ohne Inline-<script>', !/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(html));

console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
