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
