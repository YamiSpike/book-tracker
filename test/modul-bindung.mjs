// Prueft die Bindung zwischen js/app.js und den Teilmodulen js/app-*.js.
//
// Seit v3.6 laeuft sie ueber window.HonIntern. Diese Datei faengt die drei Fehler
// ab, die dabei still passieren koennen:
//   1. Ein Teilmodul holt sich etwas, das niemand bereitstellt -> ReferenceError
//      erst beim Aufruf, unter Umstaenden Monate spaeter.
//   2. Der Kern legt eine WEITERLEITUNG statt der echten Funktion ab -> zeigt auf
//      sich selbst, sobald das Teilmodul nicht laedt: Endlosrekursion.
//   3. Zwei Dateien legen denselben Namen ab -> die spaetere gewinnt, stumm.
import fs from 'node:fs';
import path from 'node:path';

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i ? '  -> ' + i : '')));

const KERN = 'js/app.js';
const lies = (f) => fs.readFileSync(f, 'utf8').split('\r\n').join('\n');
// Kommentare raus, sonst zaehlen Erwaehnungen in Prosa als Codenutzung
const ohneKommentare = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');

const module_ = fs.readdirSync('js').filter((f) => /^app-.*\.js$/.test(f)).map((f) => 'js/' + f);
const kernRoh = lies(KERN);
const kernCode = ohneKommentare(kernRoh);

console.log('');
console.log('-- Wer stellt was bereit? -------------------------------');

const bereit = new Map();          // name -> datei
const doppelt = [];
for (const m of kernCode.matchAll(/^\s*HIntern\.([A-Za-z_$][\w$]*)\s*=/gm)) bereit.set(m[1], KERN);
for (const f of module_) {
  for (const m of ohneKommentare(lies(f)).matchAll(/^\s*H\.([A-Za-z_$][\w$]*)\s*=/gm)) {
    if (bereit.has(m[1])) doppelt.push(m[1] + ' (' + bereit.get(m[1]) + ' + ' + f + ')');
    bereit.set(m[1], f);
  }
}
pruefe('kein Name wird von zwei Dateien abgelegt', doppelt.length === 0, doppelt.join('; '));
pruefe('der Werkzeugkasten ist gefuellt', bereit.size > 20, bereit.size + ' Namen');

console.log('');
console.log('-- Holt sich ein Teilmodul etwas, das es nicht gibt? ----');

for (const f of module_) {
  const t = ohneKommentare(lies(f));
  const geholt = new Set();
  for (const m of t.matchAll(/(?:^|[^\w$])H\.([A-Za-z_$][\w$]*)/g)) geholt.add(m[1]);
  const eigen = new Set([...t.matchAll(/^\s*H\.([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]));
  const offen = [...geholt].filter((n) => !eigen.has(n) && !bereit.has(n));
  pruefe(path.basename(f) + ' bekommt alles (' + geholt.size + ' Zugriffe)', offen.length === 0, offen.join(', '));
}

console.log('');
console.log('-- Legt der Kern nur ECHTE Definitionen ab? -------------');

// Eine Weiterleitung sieht so aus: function x() { return HIntern.x.apply(null, arguments); }
const weitergeleitet = new Set(
  [...kernCode.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\)\s*\{\s*return\s+HIntern\.\1\.apply/g)].map((m) => m[1])
);
const falschAbgelegt = [...kernCode.matchAll(/^\s*HIntern\.([A-Za-z_$][\w$]*)\s*=/gm)]
  .map((m) => m[1]).filter((n) => weitergeleitet.has(n));
pruefe('keine Weiterleitung landet im Werkzeugkasten', falschAbgelegt.length === 0,
  falschAbgelegt.join(', ') + ' — zeigt auf sich selbst, wenn das Teilmodul fehlt');

console.log('');
console.log('-- Benutzt der Kern Ausgewandertes ohne Weiterleitung? --');

// Alles, was der Kern auf Modulebene selbst definiert
const kernDefiniert = new Set();
for (const z of kernCode.split('\n')) {
  let m = /^  function\s+([A-Za-z_$][\w$]*)/.exec(z);
  if (m) { kernDefiniert.add(m[1]); continue; }
  m = /^  var\s+(.+)/.exec(z);
  if (!m) continue;
  for (const teil of m[1].split(/,(?![^(]*\))/)) {
    const n = teil.trim().split(/[\s=;(]/)[0];
    if (n && /^[A-Za-z_$][\w$]*$/.test(n)) kernDefiniert.add(n);
  }
}
// Namen, die nur noch in Teilmodulen leben
const ausgewandert = [...bereit.entries()].filter(([, d]) => d !== KERN).map(([n]) => n);
// HIntern.foo-Zugriffe zaehlen nicht als "blank benutzt"
const kernOhneNamensraum = kernCode.replace(/HIntern\.[A-Za-z_$][\w$]*/g, '');
const luecken = ausgewandert.filter((n) => {
  if (kernDefiniert.has(n)) return false;
  return new RegExp('(?:^|[^\\w$.])' + n.replace(/\$/g, '\\$') + '(?![\\w$])').test(kernOhneNamensraum);
});
pruefe('jeder ausgewanderte Name hat eine Weiterleitung oder wird ueber HIntern. angesprochen',
  luecken.length === 0, luecken.join(', '));
pruefe('es sind ueberhaupt Namen ausgewandert', ausgewandert.length > 10, ausgewandert.length + ' Namen');

console.log('');
console.log('-- Teilmodule stehen nach dem Kern ----------------------');

const html = lies('index.html');
const reihenfolge = [...html.matchAll(/<script[^>]+src="js\/([^"?]+)/g)].map((m) => m[1]);
const posKern = reihenfolge.indexOf('app.js');
pruefe('app.js wird geladen', posKern >= 0);
for (const f of module_) {
  const name = path.basename(f);
  const p = reihenfolge.indexOf(name);
  pruefe(name + ' steht nach app.js', p > posKern, 'Position ' + p + ' vs. ' + posKern);
}

console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
