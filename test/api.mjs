// Testet api/share.js und api/sync.js unveraendert gegen einen Upstash-REST-Mock.
import { pathToFileURL } from 'node:url';
import { startMock } from './helpers/upstash-mock.mjs';

const mock = await startMock();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 'testtoken';
process.env.JWT_SECRET = 'test-secret-nur-fuer-diesen-lauf';

const BASE = pathToFileURL(process.cwd() + '/').href;
const share = (await import(BASE + 'api/share.js')).default;
const sync = (await import(BASE + 'api/sync.js')).default;
const { makeToken } = await import(BASE + 'api/_lib.js');

const tokA = makeToken('anna@example.com', 0);
const tokB = makeToken('bert@example.com', 0);

function res() {
  const o = { code: 0, body: null };
  o.status = (c) => { o.code = c; return o; };
  o.json = (b) => { o.body = b; return o; };
  return o;
}
function req(m, opt = {}) {
  const h = { 'x-real-ip': opt.ip || '1.2.3.4' };
  if (opt.tok) h.authorization = 'Bearer ' + opt.tok;
  return { method: m, headers: h, body: opt.body || {}, query: opt.query || {} };
}

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i ? '  -> ' + i : '')));

const buecher = [{ id: 'x1', title: 'Kafka am Strand', authors: ['Murakami'], cover: 'https://x/y.jpg', pages: 620, status: 'read', rating: 5 }];

console.log('');
console.log('-- api/share.js: Besitzpruefung beim Loeschen ----------');

let r = res();
await share(req('POST', { tok: tokA, body: { books: buecher } }), r);
pruefe('POST legt Link an', r.code === 200 && !!r.body.id, JSON.stringify(r.body).slice(0, 120));
const id = r.body.id;
// Muss shareKey() aus api/share.js exakt nachbilden. Seit v3.5 bleiben - und _
// erhalten (base64url); die alte Fassung entfernte sie. Rechnet der Test nach der
// alten Regel, schlaegt er nur bei IDs mit - oder _ fehl -- also sporadisch.
const rkey = (x) => 'share:books:' + String(x).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);

const roh = JSON.parse(mock.db.get(rkey(id)).val);
pruefe('ownerEmail wird gespeichert', roh.ownerEmail === 'anna@example.com', JSON.stringify(roh).slice(0, 90));

r = res();
await share(req('GET', { query: { id } }), r);
pruefe('GET liefert die Buecher', r.code === 200 && r.body.books.length === 1);
pruefe('GET verraet ownerEmail NICHT', !JSON.stringify(r.body).includes('anna@example.com'), JSON.stringify(r.body).slice(0, 140));
pruefe('GET zeigt nur den Anzeigenamen', r.body.owner === 'anna');

r = res();
await share(req('DELETE', { tok: tokB, query: { id } }), r);
pruefe('DELETE durch fremdes Konto -> 403', r.code === 403, 'war ' + r.code + ' ' + JSON.stringify(r.body));
pruefe('Link existiert nach fremdem DELETE noch', mock.db.has(rkey(id)));

r = res();
await share(req('DELETE', { tok: tokA, query: { id } }), r);
pruefe('DELETE durch Besitzer -> 200', r.code === 200, 'war ' + r.code);
pruefe('Link ist danach weg', !mock.db.has(rkey(id)));

// Altbestand ohne ownerEmail
mock.db.set(rkey('altlink'), { typ: 'string', val: JSON.stringify({ owner: 'anna', books: [], createdAt: 1 }) });
r = res();
await share(req('DELETE', { tok: tokB, query: { id: 'altlink' } }), r);
pruefe('Altlink: fremdes Konto -> 403', r.code === 403, 'war ' + r.code);
r = res();
await share(req('DELETE', { tok: tokA, query: { id: 'altlink' } }), r);
pruefe('Altlink: Besitzer -> 200 (abwaertskompatibel)', r.code === 200 && !mock.db.has(rkey('altlink')), 'war ' + r.code);

r = res();
await share(req('DELETE', { tok: tokA, query: { id: 'gibtesnicht' } }), r);
pruefe('DELETE unbekannter ID -> 200 ok', r.code === 200);

r = res();
await share(req('DELETE', { query: { id: 'egal' } }), r);
pruefe('DELETE ohne Anmeldung -> 401', r.code === 401);

console.log('');
console.log('-- api/share.js: base64url-IDs (seit v3.5) ------------');

// Bis v3.4 entfernte shareKey() - und _ aus der ID. Verschiedene IDs landeten
// dadurch auf demselben Redis-Schluessel.

r = res();
await share(req('POST', { tok: tokA, body: { books: buecher } }), r);
const id2 = r.body.id;
pruefe('neue ID wird ungekuerzt als Schluessel benutzt', mock.db.has(rkey(id2)), 'ID ' + id2 + ' -> ' + rkey(id2));

// Zwei IDs, die sich NUR durch - und _ unterscheiden, duerfen nicht kollidieren
mock.db.set('share:books:aa-bb_cc', { typ: 'string', val: JSON.stringify({ owner: 'anna', ownerEmail: 'anna@example.com', books: [{ title: 'Mit Strichen' }], createdAt: 1 }) });
mock.db.set('share:books:aabbcc', { typ: 'string', val: JSON.stringify({ owner: 'bert', ownerEmail: 'bert@example.com', books: [{ title: 'Ohne Striche' }], createdAt: 1 }) });
r = res();
await share(req('GET', { query: { id: 'aa-bb_cc' } }), r);
pruefe('ID mit Strichen liefert ihren eigenen Link', r.code === 200 && r.body.books[0].title === 'Mit Strichen', JSON.stringify(r.body).slice(0, 90));
r = res();
await share(req('GET', { query: { id: 'aabbcc' } }), r);
pruefe('ID ohne Striche liefert ihren eigenen Link', r.code === 200 && r.body.books[0].title === 'Ohne Striche', JSON.stringify(r.body).slice(0, 90));

// Vor v3.5 angelegter Link: liegt unter dem ENTSCHAERFTEN Schluessel
mock.db.delete('share:books:aa-bb_cc');
mock.db.delete('share:books:aabbcc');
mock.db.set('share:books:XyZ123', { typ: 'string', val: JSON.stringify({ owner: 'anna', ownerEmail: 'anna@example.com', books: [{ title: 'Altbestand' }], createdAt: 1 }) });
r = res();
await share(req('GET', { query: { id: 'X-yZ_123' } }), r);
pruefe('Altlink mit Strichen wird ueber den Rueckfall gefunden', r.code === 200 && r.body.books[0].title === 'Altbestand', JSON.stringify(r.body).slice(0, 90));

r = res();
await share(req('DELETE', { tok: tokB, query: { id: 'X-yZ_123' } }), r);
pruefe('Altlink: fremdes Konto scheitert auch ueber den Rueckfall', r.code === 403 && mock.db.has('share:books:XyZ123'), 'war ' + r.code);

r = res();
await share(req('DELETE', { tok: tokA, query: { id: 'X-yZ_123' } }), r);
pruefe('Altlink: Besitzer loescht ihn unter dem alten Schluessel', r.code === 200 && !mock.db.has('share:books:XyZ123'), 'war ' + r.code);

// Ohne - und _ darf gar kein zweiter Redis-Zugriff passieren
const vorRueckfall = mock.log.length;
r = res();
await share(req('GET', { query: { id: 'schlichteid' } }), r);
pruefe('ohne Striche kein zweiter Schluessel-Versuch', mock.log.length - vorRueckfall === 2, 'Befehle: ' + (mock.log.length - vorRueckfall) + ' (1x Rate-Limit + 1x get)');

console.log('');
console.log('-- api/sync.js: Rate-Limit ----------------------------');

r = res();
await sync(req('POST', { tok: tokA, body: { data: { bk_books_lz: 'lz:xyz' } } }), r);
pruefe('POST Voll-Modus funktioniert', r.code === 200 && r.body.mode === 'full', JSON.stringify(r.body).slice(0, 100));

r = res();
await sync(req('GET', { tok: tokA }), r);
// Anmerkung: Upstash parst JSON-faehige Hash-Werte beim Lesen. Der lz:-Blob ist
// kein gueltiges JSON und bleibt daher String -- genau der Fall aus dem Alltag.
pruefe('GET liefert den lz-Blob unveraendert zurueck', r.code === 200 && r.body.data && r.body.data.bk_books_lz === 'lz:xyz', JSON.stringify(r.body).slice(0, 120));

r = res();
await sync(req('POST', { tok: tokA, body: { patch: { bk_books_lz: 'lz:abc' } } }), r);
pruefe('POST Delta-Modus funktioniert', r.code === 200 && r.body.mode === 'delta', JSON.stringify(r.body).slice(0, 100));

const vorher = mock.log.length;
r = res();
await sync(req('GET', {}), r);
pruefe('GET ohne Token -> 401', r.code === 401);
pruefe('401 kostet keinen Redis-Zugriff', mock.log.length === vorher, 'Befehle: ' + (mock.log.length - vorher));

let letzte = null;
for (let i = 0; i < 600; i++) { const rr = res(); await sync(req('GET', { tok: tokB }), rr); letzte = rr; }
pruefe('600 Anfragen gehen durch', letzte.code === 200, 'letzte war ' + letzte.code);

const vorSperre = mock.log.length;
r = res();
await sync(req('GET', { tok: tokB }), r);
pruefe('601. Anfrage -> 429', r.code === 429, 'war ' + r.code + ' ' + JSON.stringify(r.body));
pruefe('429 kostet nur den Zaehler (1 Redis-Befehl)', mock.log.length - vorSperre === 1, 'Befehle: ' + (mock.log.length - vorSperre));
pruefe('429 nennt einen verstaendlichen Grund', /warten/i.test(String(r.body && r.body.error)), JSON.stringify(r.body));

r = res();
await sync(req('GET', { tok: tokA }), r);
pruefe('Sperre gilt pro Konto, nicht global', r.code === 200, 'war ' + r.code);

console.log('');
console.log('-- api/sync.js: ?app= ist nicht frei waehlbar ----------');

// Die Schwester-Apps (Nihongo/Japan) liegen in DERSELBEN Upstash-DB, und das Token
// enthaelt nur {email, pv} — keinen App-Bezug. Waere ?app= frei, koennte ein hier
// ausgestelltes Token deren Datentopf lesen und im Voll-Modus mit leerem data
// komplett leeren (hdel ueber alle Felder).
mock.db.set('data:nihongo:anna@example.com', { typ: 'hash', val: { vokabeln: 'geheim' } });

r = res();
await sync(req('GET', { tok: tokA, query: { app: 'nihongo' } }), r);
pruefe('GET auf fremde App -> 400', r.code === 400, 'war ' + r.code + ' ' + JSON.stringify(r.body));
pruefe('fremde Daten werden nicht ausgeliefert',
  !JSON.stringify(r.body || {}).includes('geheim'), JSON.stringify(r.body).slice(0, 90));

r = res();
await sync(req('POST', { tok: tokA, query: { app: 'nihongo' }, body: { data: {} } }), r);
pruefe('POST auf fremde App -> 400', r.code === 400, 'war ' + r.code);
pruefe('fremder Datentopf bleibt unangetastet',
  JSON.stringify(mock.db.get('data:nihongo:anna@example.com').val).includes('geheim'),
  JSON.stringify(mock.db.get('data:nihongo:anna@example.com')));

r = res();
await sync(req('GET', { tok: tokA, query: { app: 'books' } }), r);
pruefe('die eigene App funktioniert weiter', r.code === 200, 'war ' + r.code);
r = res();
await sync(req('GET', { tok: tokA }), r);
pruefe('ohne app-Parameter ebenfalls (Standard books)', r.code === 200, 'war ' + r.code);

mock.close();
console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
