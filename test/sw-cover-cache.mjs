// Prueft den Cover-Cache-Deckel aus sw.js: der Service Worker wird in einer
// nachgebauten Worker-Umgebung ausgefuehrt, dann werden echte fetch-/activate-
// Ereignisse ausgeloest. Kein Browser noetig.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i ? '  -> ' + i : '')));

// ── Cache-API nachbauen (Map haelt die Einfuege-Reihenfolge, wie die echte API) ──
function macheCacheStorage() {
  const caches = new Map();                 // name -> Map(url -> body)
  function hole(name) {
    if (!caches.has(name)) caches.set(name, new Map());
    const m = caches.get(name);
    return {
      async match(req, opt) {
        const u = String(req.url || req);
        if (m.has(u)) return { url: u, ok: true, clone: () => ({ url: u }) };
        if (opt && opt.ignoreSearch) {
          const p = u.split('?')[0];
          for (const k of m.keys()) if (k.split('?')[0] === p) return { url: k, ok: true, clone: () => ({ url: k }) };
        }
        return undefined;
      },
      async put(req, res) { m.set(String(req.url || req), res || {}); },
      async add(u) { m.set(String(u), {}); },
      async delete(req) { return m.delete(String(req.url || req)); },
      async keys() { return [...m.keys()].map((u) => ({ url: u })); },
    };
  }
  return {
    _roh: caches,
    async open(name) { return hole(name); },
    async keys() { return [...caches.keys()]; },
    async delete(name) { return caches.delete(name); },
    async match() { return undefined; },
  };
}

function ladeSW({ usage = 0, quota = 0, cacheStorage: vorhanden = null } = {}) {
  const hoerer = {};
  // Ein mitgegebener Cache ueberlebt den "Neustart" des Workers — so laesst sich
  // nachstellen, dass der Browser den Worker beendet und neu hochfaehrt.
  const cacheStorage = vorhanden || macheCacheStorage();
  const ctx = {
    caches: cacheStorage,
    URL, Response: class { static error() { return { fehler: true }; } },
    Promise, JSON, Date, Math, Map, Set, Object, Array, String, Number, console,
    setTimeout, clearTimeout,
    navigator: quota ? { storage: { estimate: async () => ({ usage, quota }) } } : {},
    fetch: async (req) => ({ url: String(req.url || req), ok: true, status: 200, type: 'basic', clone: () => ({}) }),
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.self.location = { origin: 'https://hon.test' };
  ctx.self.addEventListener = (typ, fn) => { hoerer[typ] = fn; };
  ctx.self.skipWaiting = async () => {};
  ctx.self.clients = { claim: async () => {}, matchAll: async () => [] };
  vm.createContext(ctx);
  const datei = path.join(process.cwd(), 'sw.js');
  vm.runInContext(fs.readFileSync(datei, 'utf8'), ctx);
  return { hoerer, cacheStorage, ctx };
}

// Ein fetch-Ereignis ausloesen und auf die Antwort warten
async function hole(hoerer, url) {
  let antwort = null;
  const warte = [];
  const ev = {
    request: { url, method: 'GET', mode: 'no-cors' },
    respondWith: (p) => { antwort = p; },
    waitUntil: (p) => { warte.push(p); },
  };
  hoerer.fetch(ev);
  if (antwort) await antwort;
  await Promise.all(warte);
}

const coverUrl = (i) => 'https://books.google.com/books/content?id=nr' + i;

// sw.js zaehlt erst alle COVER_PRUEF_ALLE Neuzugaenge nach (cache.keys() ist O(n)
// und hat in einem Bild-Request nichts verloren). Der Cache darf den Deckel also
// um bis zu ein Pruefintervall ueberschreiten -- das ist der zugesicherte Vertrag,
// nicht der Wunschwert.
const PRUEF_ALLE = 60;

console.log('');
console.log('-- Cover-Cache: Deckel im Regelbetrieb -----------------');
{
  const { hoerer, cacheStorage } = ladeSW();
  for (let i = 0; i < 3400; i++) await hole(hoerer, coverUrl(i));
  const n = cacheStorage._roh.get('buecher-covers-v1').size;
  pruefe('Cache bleibt beim Deckel 3000 (+1 Pruefintervall)', n <= 3000 + PRUEF_ALLE, 'Eintraege: ' + n);
  pruefe('Cache ist trotzdem gut gefuellt', n > 2800, 'Eintraege: ' + n);

  // FIFO: die zuletzt geholten Cover muessen drin sein, die ersten raus
  const drin = cacheStorage._roh.get('buecher-covers-v1');
  pruefe('juengstes Cover ist noch da', drin.has(coverUrl(3399)));
  pruefe('aeltestes Cover wurde verdraengt', !drin.has(coverUrl(0)));
}

console.log('');
console.log('-- Cover-Cache: bei Speicherdruck haerter --------------');
{
  // 85 % des Kontingents belegt -> engerer Deckel (1200)
  const { hoerer, cacheStorage } = ladeSW({ usage: 85, quota: 100 });
  for (let i = 0; i < 2000; i++) await hole(hoerer, coverUrl(i));
  const n = cacheStorage._roh.get('buecher-covers-v1').size;
  pruefe('bei Speicherdruck greift der enge Deckel 1200', n <= 1200 + PRUEF_ALLE, 'Eintraege: ' + n);
  pruefe('enger Deckel liegt deutlich unter dem Regelbetrieb', n < 2000, 'Eintraege: ' + n);
}

console.log('');
console.log('-- Cover-Cache: activate raeumt Altbestand auf ---------');
{
  const { hoerer, cacheStorage } = ladeSW();
  const c = await cacheStorage.open('buecher-covers-v1');
  for (let i = 0; i < 9000; i++) await c.put({ url: coverUrl(i) }, {});
  pruefe('Ausgangslage: 9000 Alt-Cover', cacheStorage._roh.get('buecher-covers-v1').size === 9000);

  const warte = [];
  hoerer.activate({ waitUntil: (p) => warte.push(p) });
  await Promise.all(warte);

  const n = cacheStorage._roh.get('buecher-covers-v1').size;
  pruefe('activate bringt den Altbestand auf Mass', n <= 3000, 'Eintraege: ' + n);
  pruefe('Cover-Cache wird NICHT komplett geloescht', n > 2800, 'Eintraege: ' + n);
  pruefe('Cover-Cache existiert weiterhin', cacheStorage._roh.has('buecher-covers-v1'));
}

console.log('');
console.log('-- activate loescht die richtigen Caches ---------------');
{
  const { hoerer, cacheStorage } = ladeSW();
  await cacheStorage.open('hon-v3-2');            // alter App-Cache
  await cacheStorage.open('hon-v3-3');            // aktueller App-Cache
  await cacheStorage.open('buecher-covers-v1');   // Cover
  await cacheStorage.open('buecher-shell');       // gepinnte Shell

  const warte = [];
  hoerer.activate({ waitUntil: (p) => warte.push(p) });
  await Promise.all(warte);

  const uebrig = [...cacheStorage._roh.keys()];
  pruefe('alter App-Cache ist weg', !uebrig.includes('hon-v3-2'), uebrig.join(', '));
  pruefe('Cover-Cache ueberlebt', uebrig.includes('buecher-covers-v1'), uebrig.join(', '));
  pruefe('gepinnte Shell ueberlebt', uebrig.includes('buecher-shell'), uebrig.join(', '));
}

console.log('');
console.log('-- Cover-Treffer kommt weiter aus dem Cache ------------');
{
  const { hoerer, cacheStorage, ctx } = ladeSW();
  await hole(hoerer, coverUrl(1));
  let netz = 0;
  ctx.fetch = async () => { netz++; return { ok: true, status: 200, type: 'basic', clone: () => ({}) }; };
  await hole(hoerer, coverUrl(1));
  pruefe('zweiter Abruf geht NICHT ins Netz', netz === 0, 'Netzabrufe: ' + netz);
}

console.log('');
console.log('-- Shell: neue Fassung sichern, DANN die alte werfen ---');
{
  // Beim Versionswechsel holt der SW jede ?v=-Datei neu. Vorher wurde erst geloescht
  // und dann (ohne Abwarten, ohne Fehlerbehandlung) geschrieben. Schlug das Schreiben
  // fehl — Kontingent voll —, lag WEDER die alte NOCH die neue Fassung im Cache, und
  // die App startete offline nicht mehr.
  const { hoerer, cacheStorage, ctx } = ladeSW();
  const shell = await cacheStorage.open('buecher-shell');
  await shell.put({ url: 'https://hon.test/js/app.js?v=3.5' }, {});
  pruefe('Ausgangslage: alte Fassung liegt im Shell-Cache',
    cacheStorage._roh.get('buecher-shell').has('https://hon.test/js/app.js?v=3.5'));

  // Schreiben scheitern lassen, wie bei vollem Speicher
  const echtesOpen = cacheStorage.open.bind(cacheStorage);
  ctx.caches.open = async (name) => {
    const c = await echtesOpen(name);
    if (name === 'buecher-shell') c.put = async () => { throw new Error('QuotaExceededError'); };
    return c;
  };

  await hole(hoerer, 'https://hon.test/js/app.js?v=3.6');

  const drin = cacheStorage._roh.get('buecher-shell');
  pruefe('alte Fassung ueberlebt den gescheiterten Schreibvorgang',
    drin.has('https://hon.test/js/app.js?v=3.5'), [...drin.keys()].join(', ') || '(leer)');
  pruefe('der Cache ist nicht leer zurueckgeblieben', drin.size > 0, drin.size + ' Eintraege');
}

console.log('');
console.log('-- Shell: bei Erfolg wird die alte Fassung entsorgt ----');
{
  const { hoerer, cacheStorage } = ladeSW();
  const shell = await cacheStorage.open('buecher-shell');
  await shell.put({ url: 'https://hon.test/js/app.js?v=3.5' }, {});
  await hole(hoerer, 'https://hon.test/js/app.js?v=3.6');
  const drin = cacheStorage._roh.get('buecher-shell');
  pruefe('neue Fassung ist da', drin.has('https://hon.test/js/app.js?v=3.6'), [...drin.keys()].join(', '));
  pruefe('alte Fassung ist weg', !drin.has('https://hon.test/js/app.js?v=3.5'), [...drin.keys()].join(', '));
  pruefe('pro Datei bleibt genau eine Fassung', drin.size === 1, drin.size + ' Eintraege');
}

console.log('');
console.log('-- Der Deckel greift auch bei kurzen Worker-Runden -----');
{
  // Der Browser beendet einen untaetigen Service Worker nach Sekunden. Haengt das
  // Nachzaehlen allein an einem Modulzaehler, beginnt der bei jedem Start wieder
  // bei 0 und erreicht die Schwelle im Alltag nie — der Deckel waere Zierde.
  // Nachgestellt: viele kurze Runden mit je 5 Covern.
  const gemeinsam = macheCacheStorage();
  const vorbefuellen = await gemeinsam.open('buecher-covers-v1');
  for (let i = 0; i < 3500; i++) await vorbefuellen.put({ url: coverUrl(i) }, {});
  pruefe('Ausgangslage: 3500 Cover liegen ueber dem Deckel', gemeinsam._roh.get('buecher-covers-v1').size === 3500);

  // Eine kurze Runde: neuer Worker, 5 Cover, dann "beendet"
  const { hoerer } = ladeSW({ cacheStorage: gemeinsam });
  for (let i = 4000; i < 4005; i++) await hole(hoerer, coverUrl(i));
  const n = gemeinsam._roh.get('buecher-covers-v1').size;
  pruefe('schon 5 Cover nach dem Start loesen das Beschneiden aus', n <= 3000 + PRUEF_ALLE, 'Eintraege: ' + n);
}

console.log('');
console.log('-- Umgeleitete Antwort nicht als Shell einbrennen ------');
{
  // Eine gefolgte Weiterleitung liefert status 200 mit redirected=true. Wird die
  // spaeter aus dem Cache fuer eine Navigation zurueckgegeben, lehnt der Browser
  // sie ab — die App startet dann gar nicht mehr, auch online nicht.
  const { hoerer, cacheStorage, ctx } = ladeSW();
  ctx.fetch = async () => ({ url: 'https://hon.test/', ok: true, status: 200, type: 'basic', redirected: true, clone: () => ({}) });
  await hole(hoerer, 'https://hon.test/');
  const shell = cacheStorage._roh.get('buecher-shell');
  pruefe('umgeleitete Antwort landet NICHT im Shell-Cache',
    !shell || !shell.has('https://hon.test/'), shell ? [...shell.keys()].join(', ') : '(kein Cache)');

  // Die saubere Antwort dagegen schon
  const zweit = ladeSW();
  zweit.ctx.fetch = async () => ({ url: 'https://hon.test/', ok: true, status: 200, type: 'basic', redirected: false, clone: () => ({}) });
  await hole(zweit.hoerer, 'https://hon.test/');
  pruefe('direkte Antwort wird eingebrannt',
    zweit.cacheStorage._roh.get('buecher-shell').size > 0);
}

console.log('');
console.log('-- Kaputtes Cover fliegt auf Zuruf aus dem Cache -------');
{
  // Cover kommen no-cors, also opaque: der SW kann 404 nicht von einem Bild
  // unterscheiden. Die App meldet den Ausfall deshalb per Nachricht.
  const { hoerer, cacheStorage } = ladeSW();
  const url = coverUrl(42);
  await hole(hoerer, url);
  pruefe('Ausgangslage: Cover liegt im Cache', cacheStorage._roh.get('buecher-covers-v1').has(url));

  pruefe('der Worker hoert auf Nachrichten', typeof hoerer.message === 'function');
  if (hoerer.message) {
    const warte = [];
    hoerer.message({ data: { type: 'COVER_KAPUTT', url }, waitUntil: (p) => warte.push(p) });
    await Promise.all(warte);
    pruefe('gemeldetes Cover ist danach weg', !cacheStorage._roh.get('buecher-covers-v1').has(url),
      [...cacheStorage._roh.get('buecher-covers-v1').keys()].join(', ') || '(leer)');

    // Fremde Nachrichten duerfen nichts anfassen
    await hole(hoerer, coverUrl(43));
    const w2 = [];
    hoerer.message({ data: { type: 'IRGENDWAS' }, waitUntil: (p) => w2.push(p) });
    await Promise.all(w2);
    pruefe('unbekannte Nachricht raeumt nichts weg', cacheStorage._roh.get('buecher-covers-v1').has(coverUrl(43)));
  }
}

console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
