// Charakterisierungstests fuer js/app.js.
//
// Zweck: das VERHALTEN der App festnageln, damit die Aufteilung der Datei in
// mehrere Module nichts still veraendert. Getestet wird durch das DOM — app.js
// gibt nach aussen nur window.HonApp preis.
//
// Diese Tests beschreiben, was die App HEUTE tut. Sie sind kein Urteil darueber,
// ob es richtig ist; sie sind das Netz unter dem Refactor.
import { ladeApp, buch } from './helpers/app-umgebung.mjs';

let ok = 0, bad = 0;
const pruefe = (n, b, i) => b ? (ok++, console.log('  [ok] ' + n))
                              : (bad++, console.log('  [FEHLER] ' + n + (i !== undefined ? '  -> ' + i : '')));

const warte = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// Eine Sammlung, die alle getesteten Pfade beruehrt
const SAMMLUNG = [
  buch({ id: 'a1', title: 'Kafka am Strand', authors: ['Haruki Murakami'], status: 'read', rating: 5, pages: 620, year: '2004', categories: ['Roman'], isbn: '9783832179809' }),
  buch({ id: 'a2', title: 'Naokos Lächeln', authors: ['Haruki Murakami'], status: 'read', rating: 4, pages: 400, year: '2001', categories: ['Roman'] }),
  buch({ id: 'a3', title: 'Der Steppenwolf', authors: ['Hermann Hesse'], status: 'reading', rating: 0, pages: 280, year: '1927', categories: ['Klassiker'] }),
  buch({ id: 'a4', title: 'Siddhartha', authors: ['Hermann Hesse'], status: 'want', rating: 0, pages: 150, year: '1922', categories: ['Klassiker'] }),
  buch({ id: 'a5', title: 'One Piece, Band 1', authors: ['Eiichiro Oda'], status: 'read', rating: 5, pages: 200, categories: ['Manga'], kind: 'manga' }),
  buch({ id: 'a6', title: 'One Piece, Band 2', authors: ['Eiichiro Oda'], status: 'read', rating: 5, pages: 200, categories: ['Manga'], kind: 'manga' }),
];

const u = await ladeApp({ buecher: SAMMLUNG });

console.log('');
console.log('-- Laden ------------------------------------------------');
pruefe('alle Skripte laufen ohne Fehler', u.fehler.length === 0, u.fehler.join(' | '));
pruefe('window.HonApp ist da', !!u.win.HonApp && typeof u.win.HonApp.openById === 'function');
pruefe('window.BKCloudOnChange ist da', typeof u.win.BKCloudOnChange === 'function');

console.log('');
console.log('-- Start-Ansicht ----------------------------------------');
pruefe('Badge zaehlt die Sammlung', u.doc.getElementById('libBadge').textContent === '6', u.doc.getElementById('libBadge').textContent);
pruefe('„Du liest gerade" zeigt das laufende Buch',
  u.doc.querySelectorAll('#homeReading .card').length === 1,
  u.doc.querySelectorAll('#homeReading .card').length);
pruefe('„Zuletzt hinzugefuegt" ist gefuellt', u.doc.querySelectorAll('#homeRecent .card').length > 0);

console.log('');
console.log('-- Sammlung: rendern, filtern, sortieren -----------------');
u.doc.querySelector('.tab[data-tab="sammlung"]').click();
await warte();
const karten = () => u.doc.querySelectorAll('#libGrid .card').length;
pruefe('alle 6 Titel erscheinen', karten() === 6, karten());

const fs_ = u.doc.getElementById('filterStatus');
fs_.value = 'read';
fs_.dispatchEvent(new u.win.Event('change', { bubbles: true }));
await warte();
pruefe('Status-Filter „Gelesen" zeigt 4', karten() === 4, karten());

fs_.value = '';
fs_.dispatchEvent(new u.win.Event('change', { bubbles: true }));
await warte();

const fg = u.doc.getElementById('filterGenre');
const genres = [...fg.options].map((o) => o.value);
pruefe('Genre-Filter kennt die Genres der Sammlung',
  genres.includes('Roman') && genres.includes('Klassiker') && genres.includes('Manga'), genres.join(', '));
fg.value = 'Klassiker';
fg.dispatchEvent(new u.win.Event('change', { bubbles: true }));
await warte();
pruefe('Genre-Filter „Klassiker" zeigt 2', karten() === 2, karten());
fg.value = '';
fg.dispatchEvent(new u.win.Event('change', { bubbles: true }));
await warte();

const ls = u.doc.getElementById('libSearch');
ls.value = 'murakami';
ls.dispatchEvent(new u.win.Event('input', { bubbles: true }));
await warte(320);
pruefe('Suche in der Sammlung findet nach Autor·in', karten() === 2, karten());
ls.value = '';
ls.dispatchEvent(new u.win.Event('input', { bubbles: true }));
await warte(320);
pruefe('leere Suche zeigt wieder alle', karten() === 6, karten());

const sl = u.doc.getElementById('sortLib');
const ersterTitel = () => { const c = u.doc.querySelector('#libGrid .card .title'); return c ? c.textContent : null; };
sl.value = 'pages';
sl.dispatchEvent(new u.win.Event('change', { bubbles: true }));
await warte();
pruefe('Sortierung nach Seitenzahl setzt das dickste Buch nach vorn',
  ersterTitel() === 'Kafka am Strand', ersterTitel());

console.log('');
console.log('-- Statistik --------------------------------------------');
u.doc.querySelector('.tab[data-tab="stats"]').click();
await warte(120);
const statsText = u.doc.getElementById('statsGrid').textContent.replace(/\s+/g, ' ');
// Die Kacheln rendern Zahl und Beschriftung ohne Trennzeichen: „4Bücher gelesen"
pruefe('Statistik nennt 4 gelesene Bücher', /4\s*Bücher gelesen/.test(statsText), statsText.slice(0, 120));
pruefe('Statistik summiert die Seiten (620+400+200+200 = 1420)',
  statsText.includes('1420') || statsText.includes('1.420'), statsText.slice(0, 160));
pruefe('Statistik zählt 1 laufendes und 1 gewünschtes Buch',
  /1\s*Lese gerade/.test(statsText) && /1\s*Will lesen/.test(statsText), statsText.slice(0, 160));
pruefe('Statistik mittelt die Bewertung auf 4,8 — (5+4+5+5)/4',
  /4[.,]8/.test(statsText), statsText.slice(0, 160));
const barsText = u.doc.getElementById('statsBars').textContent;
pruefe('Top-Autor·innen nennen Murakami', barsText.includes('Murakami'), barsText.slice(0, 120));

console.log('');
console.log('-- Detail-Modal & Aenderungen ---------------------------');
u.win.HonApp.openById('a1');
await warte(120);
const modal = u.doc.getElementById('modal');
pruefe('Modal oeffnet sich', !modal.hidden);
const modalText = u.doc.getElementById('modalInner').textContent;
pruefe('Modal zeigt den Titel', modalText.includes('Kafka am Strand'), modalText.slice(0, 80));
pruefe('Modal zeigt die Autor·in', modalText.includes('Haruki Murakami'));

// Status im Modal aendern -> muss im Speicher landen
const statusKnopf = [...u.doc.querySelectorAll('#modalInner button')]
  .find((b) => /Will lesen/i.test(b.textContent));
if (statusKnopf) {
  statusKnopf.click();
  await warte(120);
  const nachher = u.buecherJetzt().find((b) => b.id === 'a1');
  pruefe('Statuswechsel im Modal wird gespeichert', nachher && nachher.status === 'want', nachher && nachher.status);
  // zuruecksetzen
  const zurueck = [...u.doc.querySelectorAll('#modalInner button')].find((b) => /Gelesen/i.test(b.textContent));
  if (zurueck) { zurueck.click(); await warte(120); }
} else {
  pruefe('Statuswechsel im Modal wird gespeichert', false, 'Status-Knopf im Modal nicht gefunden');
}
const zu = u.doc.getElementById('modalClose');
if (zu) zu.click();
await warte();

console.log('');
console.log('-- Buchreihen -------------------------------------------');
// „One Piece, Band 1/2" muessen als EINE Reihe erkannt werden
u.doc.querySelector('.tab[data-tab="sammlung"]').click();
await warte();
const reihenSchalter = u.doc.querySelector('.vt-btn[data-view="series"]');
  const listeSchalter = u.doc.querySelector('.vt-btn[data-view="grid"], .vt-btn:not([data-view="series"])');
if (reihenSchalter) {
  reihenSchalter.click();
  await warte(150);
  const serien = u.doc.querySelectorAll('#libGrid .card').length;
  pruefe('Serien-Ansicht fasst „One Piece" zusammen', serien < 6, serien + ' Kacheln statt 6');
  if (listeSchalter) listeSchalter.click();
  await warte(150);
} else {
  console.log('  [übersprungen] Serien-Schalter nicht im DOM gefunden');
}

console.log('');
console.log('-- Duplikate --------------------------------------------');
const u2 = await ladeApp({ buecher: [
  buch({ id: 'd1', title: 'Kafka am Strand', authors: ['Haruki Murakami'], isbn: '9783832179809' }),
  buch({ id: 'd2', title: 'Kafka am Strand', authors: ['Haruki Murakami'], isbn: '9783832179809' }),
  buch({ id: 'd3', title: 'Etwas anderes', authors: ['Wer auch immer'] }),
]});
u2.doc.querySelector('.tab[data-tab="settings"]').click();
await warte();
u2.doc.getElementById('setDup').click();
await warte(200);
const dupText = u2.doc.body.textContent.replace(/\s+/g, ' ');
pruefe('Duplikat-Pruefung meldet einen Fund', /Duplikat/i.test(dupText), dupText.slice(dupText.search(/Duplikat/i) - 20, dupText.search(/Duplikat/i) + 90));
u2.schliessen();

console.log('');
console.log('-- Cover-Ersatz (data-fallback) -------------------------');
// Der zentrale Handler ersetzt fehlgeschlagene Cover — seit v3.5 statt onerror="…"
const probe = u.doc.createElement('div');
probe.innerHTML = '<img data-fallback="buch" src="x"><img data-fallback="rollen" src="x"><img src="x">';
u.doc.body.appendChild(probe);
[...probe.querySelectorAll('img')].forEach((i) => i.dispatchEvent(new u.win.Event('error', { bubbles: false })));
await warte();
pruefe('data-fallback="buch" wird zum Buch-Ersatz',
  probe.children[0].className === 'cover-fallback' && probe.children[0].textContent.includes('📕'),
  probe.children[0].outerHTML.slice(0, 60));
pruefe('data-fallback="rollen" traegt die Rollen-Klasse',
  probe.children[1].className === 'cover-fallback rollen', probe.children[1].outerHTML.slice(0, 60));
pruefe('Bild ohne data-fallback bleibt unangetastet', probe.children[2].tagName === 'IMG');
probe.remove();

console.log('');
console.log('-- Backup-Import ueberstimmt Grabsteine -----------------');
{
  // Der Rettungsweg nach einem versehentlichen Loeschen. Bei aktivem Cloud-Sync
  // hinterlaesst das Loeschen Grabsteine (deleted:true) mit dem LOESCH-Zeitpunkt —
  // also einem juengeren updatedAt als jeder Backup-Eintrag. Ein reiner
  // Zeitstempel-Vergleich verliert damit immer, und der Import bewirkt nichts.
  const geloescht = { id: 'g1', deleted: true, updatedAt: 9_000_000 };
  const u3 = await ladeApp({ buecher: [
    geloescht,
    buch({ id: 'b2', title: 'War immer da', authors: ['B'], updatedAt: 1000 }),
  ]});

  const backup = JSON.stringify([
    { id: 'g1', title: 'Aus Versehen geloescht', authors: ['A'], status: 'read', pages: 300, updatedAt: 1000 },
    { id: 'neu1', title: 'Nur im Backup', authors: ['C'], status: 'want', updatedAt: 1000 },
  ]);

  // FileReader der Umgebung so fuettern, wie es der Datei-Dialog taete
  const datei = new u3.win.Blob([backup], { type: 'application/json' });
  const eingabe = u3.doc.getElementById('setImport');
  pruefe('Import-Schalter ist da', !!eingabe);

  // importJson haengt an einem verborgenen file-input; wir loesen den Weg direkt aus
  const fileInput = u3.doc.querySelector('input[type="file"]');
  pruefe('verborgenes Dateifeld vorhanden', !!fileInput, [...u3.doc.querySelectorAll('input')].map((i) => i.type).join(','));
  if (fileInput) {
    Object.defineProperty(fileInput, 'files', { value: [datei], configurable: true });
    fileInput.dispatchEvent(new u3.win.Event('change', { bubbles: true }));
    await warte(400);
  }

  const nach = u3.buecherJetzt();
  const wieder = nach.find((b) => b.id === 'g1');
  pruefe('geloeschtes Buch kehrt aus dem Backup zurueck',
    !!wieder && !wieder.deleted && wieder.title === 'Aus Versehen geloescht',
    JSON.stringify(wieder));
  pruefe('die Wiederherstellung traegt einen FRISCHEN Zeitstempel',
    !!wieder && (wieder.updatedAt || 0) > geloescht.updatedAt,
    wieder && wieder.updatedAt + ' vs. Grabstein ' + geloescht.updatedAt);
  pruefe('neue Titel aus dem Backup kommen dazu', nach.some((b) => b.id === 'neu1'));
  pruefe('vorhandene Titel bleiben erhalten', nach.some((b) => b.id === 'b2'));

  const meldung = u3.doc.getElementById('toast').textContent;
  pruefe('die Meldung nennt die Wiederherstellung', /wiederhergestellt/i.test(meldung), meldung);
  u3.schliessen();
}

console.log('');
console.log('-- Maskottchen-Schnittstelle ----------------------------');
const nachricht = u.win.HonApp.getMascotMessage();
pruefe('Maskottchen bekommt eine Nachricht', !!nachricht && typeof nachricht === 'object', JSON.stringify(nachricht).slice(0, 100));

u.schliessen();
console.log('');
console.log((bad === 0 ? 'BESTANDEN' : 'FEHLGESCHLAGEN') + ': ' + ok + ' ok, ' + bad + ' fehlerhaft');
console.log('');
process.exit(bad === 0 ? 0 : 1);
