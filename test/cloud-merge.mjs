// End-to-End: js/cloud.js (echter Client) -> api/sync.js (echter Handler) -> Upstash-Mock
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { startMock } from './helpers/upstash-mock.mjs';

const mock = await startMock();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'testtoken';
process.env.JWT_SECRET = 'test-secret-nur-fuer-diesen-lauf';
const BASE = pathToFileURL(process.cwd() + '/').href;
const sync = (await import(BASE + 'api/sync.js')).default;
const { makeToken } = await import(BASE + 'api/_lib.js');

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i ? '  -> ' + i : '')));

// -- Browser-Umgebung nachbauen -------------------------------------------
function umgebung() {
  const ls = new Map();
  const store = {
    _raw: '[]', ready: Promise.resolve(),
    getRaw: () => store._raw, setRaw: (s) => { store._raw = s; }, clearBooks: () => { store._raw = '[]'; }
  };
  const localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, String(v)),
    removeItem: (k) => ls.delete(k),
    get length() { return ls.size; },
    key: (i) => [...ls.keys()][i],
  };
  const doc = {
    readyState: 'complete', visibilityState: 'visible',
    addEventListener() {}, getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {}, setAttribute() {} }),
    createTextNode: () => ({}), body: { appendChild() {} }
  };
  const ctx = {
    localStorage, document: doc, HonStore: store,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
    Promise, JSON, Date, Math, Set, Map, Object, Array, String, Number, console,
    fetch: null
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('js/vendor/lz-string.min.js', 'utf8'), ctx);
  return { ctx, store, localStorage };
}

// fetch -> echter sync.js-Handler
function machFetch() {
  return async (url, opt = {}) => {
    const u = new URL(url, 'http://test.local');
    const hdr = {};
    for (const [k, v] of Object.entries(opt.headers || {})) hdr[k.toLowerCase()] = v;
    hdr['x-real-ip'] = '9.9.9.9';
    const req = {
      method: opt.method || 'GET', headers: hdr,
      query: Object.fromEntries(u.searchParams),
      body: opt.body ? JSON.parse(opt.body) : {}
    };
    const r = { code: 200, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    await sync(req, r);
    return { status: r.code, ok: r.code >= 200 && r.code < 300, json: async () => r.body };
  };
}

const tok = makeToken('clara@example.com', 0);
const KEY = 'data:books:clara@example.com';
const buch = (id, t) => ({ id, title: t, authors: ['A'], status: 'read', updatedAt: 1000 });

// WICHTIG: cloud.js OHNE Token laden. start() startet sonst sofort einen eigenen
// syncNow(), der mit dem Testaufbau um dieselbe Mock-DB wettrennt. Erst anmelden,
// wenn der Ausgangszustand steht -- dann treibt der Test den Sync selbst.
async function client() {
  const env = umgebung();
  env.ctx.fetch = machFetch();
  vm.runInContext(fs.readFileSync('js/cloud.js', 'utf8'), env.ctx);
  await new Promise((r) => setTimeout(r, 0));   // boot() durchlaufen lassen
  env.localStorage.setItem('bk_cloud_token', tok);
  env.localStorage.setItem('bk_cloud_email', 'clara@example.com');
  return { env, cl: env.ctx.BKCloud };
}

console.log('');
console.log('-- Merge: Cloud -> leeres Geraet -----------------------');

// A) Cloud haelt den komprimierten Blob (Regelfall)
{
  const { env, cl } = await client();
  const LZ = env.ctx.LZString;
  mock.db.set(KEY, { typ: 'hash', val: { bk_books_lz: 'lz:' + LZ.compressToUTF16(JSON.stringify([buch('a', 'Norwegian Wood')])) } });
  await cl.syncNow({});
  const lokal = JSON.parse(env.store.getRaw());
  pruefe('komprimierter Blob landet im Store', lokal.length === 1 && lokal[0].title === 'Norwegian Wood', env.store.getRaw().slice(0, 80));
}

// B) Cloud haelt den UNKOMPRIMIERTEN Blob -- hier lag der Bug
{
  const { env, cl } = await client();
  mock.db.set(KEY, { typ: 'hash', val: { bk_books: JSON.stringify([buch('b', 'Die Blechtrommel')]) } });
  await cl.syncNow({});
  const lokal = JSON.parse(env.store.getRaw());
  pruefe('unkomprimierter Blob landet im Store (war der Bug)', lokal.length === 1 && lokal[0].title === 'Die Blechtrommel', env.store.getRaw().slice(0, 80));
}

console.log('');
console.log('-- Merge: beide Seiten haben Daten ---------------------');
{
  const { env, cl } = await client();
  env.store.setRaw(JSON.stringify([buch('lokal1', 'Nur hier')]));
  mock.db.set(KEY, { typ: 'hash', val: { bk_books: JSON.stringify([buch('cloud1', 'Nur dort')]) } });
  await cl.syncNow({});
  const t = JSON.parse(env.store.getRaw()).map((b) => b.title).sort();
  pruefe('kein Titel geht beim Merge verloren', t.length === 2 && t[0] === 'Nur dort' && t[1] === 'Nur hier', JSON.stringify(t));
}

console.log('');
console.log('-- 429: ehrlich melden, nichts anfassen ----------------');
{
  const { env, cl } = await client();
  env.store.setRaw(JSON.stringify([buch('x', 'Bleibt erhalten')]));
  env.ctx.fetch = async () => ({ status: 429, ok: false, json: async () => ({ error: 'Zu viele Sync-Anfragen.' }) });
  let fehler = null;
  await cl.syncNow({}).catch((e) => { fehler = e; });
  pruefe('429 wird als Fehler gemeldet, nicht als Erfolg', !!fehler, 'Fehler: ' + fehler);
  pruefe('429 nennt eine wartbare Ursache', !!(fehler && /warten/i.test(fehler.message)), fehler && fehler.message);
  pruefe('lokale Sammlung bleibt bei 429 unangetastet', JSON.parse(env.store.getRaw())[0].title === 'Bleibt erhalten');

  let angefragt = false;
  env.ctx.fetch = async () => { angefragt = true; return { status: 200, ok: true, json: async () => ({ data: null }) }; };
  await cl.syncNow({}).catch(() => {});
  pruefe('nach 429 wird pausiert statt weiter angefragt', angefragt === false);
}

console.log('');
console.log('-- Der lokale Stand wird nicht zu leicht massgeblich ---');

// 1) Unlesbare Cloud-Daten (LZString fehlt) duerfen NICHT als "Cloud ist leer" gelten
{
  const env = umgebung();
  delete env.ctx.LZString;                    // Entpacker fehlt, wie bei luecken-
  env.ctx.fetch = machFetch();                // haftem Shell-Cache
  vm.runInContext(fs.readFileSync('js/cloud.js', 'utf8'), env.ctx);
  await new Promise((r) => setTimeout(r, 0));
  env.localStorage.setItem('bk_cloud_token', tok);
  env.localStorage.setItem('bk_cloud_email', 'clara@example.com');
  // Cloud haelt einen komprimierten Blob, den dieses Geraet nicht lesen kann
  mock.db.set(KEY, { typ: 'hash', val: { bk_books_lz: 'lz:UNLESBAR' } });

  let fehler = null;
  await env.ctx.BKCloud.syncNow({}).catch((e) => { fehler = e; });
  pruefe('unlesbare Cloud-Daten brechen den Sync ab', !!fehler, String(fehler).slice(0, 90));
  pruefe('die Meldung nennt das Neuladen', !!fehler && /neu laden/i.test(fehler.message), fehler && fehler.message);

  const cloud = mock.db.get(KEY);
  pruefe('die Cloud-Sammlung bleibt unangetastet',
    !!cloud && cloud.val.bk_books_lz === 'lz:UNLESBAR', JSON.stringify(cloud).slice(0, 90));

  // Und ab jetzt darf gar nichts mehr geschrieben werden
  let zweiter = null;
  await env.ctx.BKCloud.syncNow({}).catch((e) => { zweiter = e; });
  pruefe('danach ist der Sync gesperrt', !!zweiter && /nicht lesbar/i.test(zweiter.message), zweiter && zweiter.message);
}

// 2) Vor dem ersten erfolgreichen Abgleich wird NICHT gepusht
{
  const env = umgebung();
  env.ctx.fetch = machFetch();
  vm.runInContext(fs.readFileSync('js/cloud.js', 'utf8'), env.ctx);
  await new Promise((r) => setTimeout(r, 0));
  env.localStorage.setItem('bk_cloud_token', tok);
  env.localStorage.setItem('bk_cloud_email', 'clara@example.com');
  env.store.setRaw(JSON.stringify([buch('nur-lokal', 'Nie abgeglichen')]));
  mock.db.set(KEY, { typ: 'hash', val: { bk_books: JSON.stringify([buch('cloud', 'In der Cloud')]) } });

  // Start-Abgleich ist nie gelaufen (kein syncNow) — scheduledPush darf schweigen
  let geschrieben = 0;
  const echt = env.ctx.fetch;
  env.ctx.fetch = async (u, o = {}) => { if ((o.method || 'GET') === 'POST') geschrieben++; return echt(u, o); };
  env.ctx.BKCloud.scheduledPush && env.ctx.BKCloud.scheduledPush();
  await new Promise((r) => setTimeout(r, 3200));   // ueber PUSH_DEBOUNCE hinaus
  pruefe('ohne ersten Abgleich wird nichts hochgeladen', geschrieben === 0, 'POSTs: ' + geschrieben);
  pruefe('die Cloud-Sammlung ist noch da',
    JSON.stringify(mock.db.get(KEY).val).includes('In der Cloud'), JSON.stringify(mock.db.get(KEY)).slice(0, 80));
}

// 3) Abmelden vergisst den Delta-Schnappschuss des alten Kontos
{
  const { env, cl } = await client();
  mock.db.set(KEY, { typ: 'hash', val: {} });
  env.store.setRaw(JSON.stringify([buch('a', 'Konto A')]));
  await cl.syncNow({});                      // fuellt lastFields
  cl.logout();
  // Neues Konto, lokal unveraendert: es MUSS trotzdem voll hochgeladen werden
  const tokB = makeToken('bert@example.com', 0);
  env.localStorage.setItem('bk_cloud_token', tokB);
  env.localStorage.setItem('bk_cloud_email', 'bert@example.com');
  await cl.syncNow({});
  // Der Blob liegt komprimiert (bk_books_lz) — zum Pruefen entpacken.
  const bKey = 'data:books:bert@example.com';
  const roh = mock.db.has(bKey) ? mock.db.get(bKey).val : null;
  const blob = roh && (roh.bk_books_lz || roh.bk_books);
  const klartext = blob && blob.indexOf('lz:') === 0
    ? env.ctx.LZString.decompressFromUTF16(blob.slice(3))
    : blob;
  pruefe('nach Kontowechsel landet die Sammlung im NEUEN Konto',
    !!klartext && klartext.includes('Konto A'), String(klartext).slice(0, 90));
}

// 4) Serverfehler jenseits von 401/429 werden gemeldet, nicht verschwiegen
{
  const { env, cl } = await client();
  env.store.setRaw(JSON.stringify([buch('x', 'Grosse Sammlung')]));
  env.ctx.fetch = async (u, o = {}) => (o.method || 'GET') === 'GET'
    ? { status: 200, ok: true, json: async () => ({ data: null }) }
    : { status: 413, ok: false, json: async () => ({ error: 'zu gross' }) };
  let fehler = null;
  await cl.syncNow({}).catch((e) => { fehler = e; });
  pruefe('413 wird als Fehler gemeldet, nicht als Erfolg', !!fehler, String(fehler));
  pruefe('die Meldung nennt die Groesse', !!fehler && /zu groß/i.test(fehler.message), fehler && fehler.message);
}

console.log('');
console.log('-- Gescheiterter Push darf den Merge nicht verwerfen ---');
{
  // mergeApply() schreibt die zusammengefuehrte Sammlung SOFORT in den Speicher.
  // Der Rueckruf BKCloudOnChange verwirft danach den RAM-Cache von app.js. Lief er
  // nur im Erfolgsfall des Pushes, arbeitete die App nach einem 429 mit dem alten
  // Array weiter — und das naechste Speichern warf die eingemergten Buecher weg.
  const { env, cl } = await client();
  let rueckrufe = 0;
  env.ctx.BKCloudOnChange = () => { rueckrufe++; };
  env.store.setRaw(JSON.stringify([buch('lokal', 'Schon hier')]));

  // Pull gelingt, Push wird abgelehnt
  let anfrage = 0;
  env.ctx.fetch = async (url, opt = {}) => {
    anfrage++;
    if ((opt.method || 'GET') === 'GET') {
      return { status: 200, ok: true, json: async () => ({ data: { bk_books: JSON.stringify([buch('neu', 'Von Geraet B')]) } }) };
    }
    return { status: 429, ok: false, json: async () => ({ error: 'Zu viele Sync-Anfragen.' }) };
  };

  let fehler = null;
  await cl.syncNow({}).catch((e) => { fehler = e; });

  const titel = JSON.parse(env.store.getRaw()).map((b) => b.title).sort();
  pruefe('der Merge landet trotz abgelehntem Push im Speicher',
    titel.length === 2 && titel.includes('Von Geraet B'), JSON.stringify(titel));
  pruefe('der Rueckruf feuert trotzdem (verwirft den RAM-Cache)', rueckrufe === 1, 'Aufrufe: ' + rueckrufe);
  pruefe('der abgelehnte Push wird weiterhin als Fehler gemeldet', !!fehler, String(fehler));
}

console.log('');
console.log('-- Loesch-Marker: gehoert er zu DIESEM Konto? ----------');

// Der gefaehrlichste Pfad der ganzen App. Der Marker bk_wipe gibt eine Loeschung an
// die anderen Geraete weiter. Wird er zur falschen Zeit gesetzt oder falsch gelesen,
// verwirft mergeApply die Cloud-Sammlung UND ueberschreibt sie mit dem leeren Stand.

// 1) Loeschen OHNE Konto darf keinen Marker hinterlassen
{
  const env = umgebung();
  env.ctx.fetch = machFetch();
  vm.runInContext(fs.readFileSync('js/cloud.js', 'utf8'), env.ctx);
  await new Promise((r) => setTimeout(r, 0));
  // bewusst NICHT anmelden
  env.store.setRaw(JSON.stringify([buch('x', 'Nur lokal')]));
  await env.ctx.BKCloud.wipe();
  pruefe('Loeschen ohne Konto setzt keinen Marker',
    env.localStorage.getItem('bk_wipe') === null, 'bk_wipe = ' + env.localStorage.getItem('bk_wipe'));
  pruefe('Loeschen ohne Konto leert trotzdem die Sammlung',
    JSON.parse(env.store.getRaw()).length === 0, env.store.getRaw().slice(0, 40));

  // ... und die Cloud-Sammlung kommt beim spaeteren Anmelden vollstaendig an
  env.localStorage.setItem('bk_cloud_token', tok);
  env.localStorage.setItem('bk_cloud_email', 'clara@example.com');
  mock.db.set(KEY, { typ: 'hash', val: { bk_books: JSON.stringify([buch('c1', 'Aus der Cloud')]) } });
  await env.ctx.BKCloud.syncNow({});
  const nach = JSON.parse(env.store.getRaw());
  pruefe('spaeteres Anmelden holt die Cloud-Sammlung (war der Datenverlust)',
    nach.length === 1 && nach[0].title === 'Aus der Cloud', env.store.getRaw().slice(0, 80));
}

// 2) Loeschen MIT Konto setzt den Marker samt Kontonotiz
{
  const { env, cl } = await client();
  mock.db.set(KEY, { typ: 'hash', val: {} });
  env.store.setRaw(JSON.stringify([buch('y', 'Weg damit')]));
  await cl.wipe();
  pruefe('Loeschen mit Konto setzt den Marker', !!env.localStorage.getItem('bk_wipe'));
  pruefe('Marker traegt die Kontonotiz',
    env.localStorage.getItem('bk_wipe_acct') === 'clara@example.com', env.localStorage.getItem('bk_wipe_acct'));
}

// 3) Marker eines FREMDEN Kontos darf die eigene Cloud-Sammlung nicht verwerfen
{
  const { env, cl } = await client();
  env.localStorage.setItem('bk_wipe', String(Date.now()));
  env.localStorage.setItem('bk_wipe_acct', 'jemand.anderes@example.com');
  mock.db.set(KEY, { typ: 'hash', val: { bk_books: JSON.stringify([buch('c2', 'Fremdes Konto, meine Buecher')]) } });
  await cl.syncNow({});
  const nach = JSON.parse(env.store.getRaw());
  pruefe('Marker eines anderen Kontos wird ignoriert',
    nach.length === 1 && nach[0].title === 'Fremdes Konto, meine Buecher', env.store.getRaw().slice(0, 80));
}

// 4) Eigener Marker MUSS weiterhin wirken — sonst kaeme das Geloeschte zurueck
{
  const { env, cl } = await client();
  env.localStorage.setItem('bk_wipe', String(Date.now() + 5000));
  env.localStorage.setItem('bk_wipe_acct', 'clara@example.com');
  mock.db.set(KEY, { typ: 'hash', val: { bk_books: JSON.stringify([buch('alt', 'Sollte NICHT zurueckkommen')]) } });
  await cl.syncNow({});
  pruefe('eigener Marker haelt die Loeschung durch',
    JSON.parse(env.store.getRaw()).length === 0, env.store.getRaw().slice(0, 60));
}

console.log('');
console.log('-- Loesch-Marker aus der Cloud -------------------------');
{
  const { env, cl } = await client();
  env.store.setRaw(JSON.stringify([buch('alt', 'Sollte weg')]));
  mock.db.set(KEY, { typ: 'hash', val: { bk_wipe: String(Date.now() + 5000), bk_books: JSON.stringify([buch('alt', 'Sollte weg')]) } });
  await cl.syncNow({});
  pruefe('Wipe von anderem Geraet loescht auch hier', JSON.parse(env.store.getRaw()).length === 0, env.store.getRaw().slice(0, 60));
}

mock.close();
console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
