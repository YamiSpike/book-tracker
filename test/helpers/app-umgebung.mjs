// Laedt die echte index.html samt aller App-Skripte in jsdom und gibt das
// fertige Fenster zurueck. Damit laesst sich js/app.js durch das DOM testen —
// die Datei gibt nach aussen fast nichts preis (nur window.HonApp).
//
// Was hier gestubbt wird, fehlt in jsdom und ist fuer die getesteten Pfade
// unerheblich: IntersectionObserver/ResizeObserver (virtualisierte Liste),
// BarcodeDetector (Scanner), Notification (Erinnerung), wakeLock (Timer).
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const WURZEL = process.cwd();

// Welche Skripte laedt index.html? Reihenfolge exakt uebernehmen — sie ist Teil
// des Vertrags (app.js muss vor den Teilmodulen laufen).
export function skripteAusIndex() {
  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');
  return [...html.matchAll(/<script[^>]+src="([^"?]+)(?:\?[^"]*)?"/g)].map((m) => m[1]);
}

export async function ladeApp({ buecher = [], einstellungen = null } = {}) {
  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'https://hon.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;

  // ── Fehlende Browser-APIs nachbilden ──────────────────────────────────
  class BeobachterStub {
    constructor(rueckruf) { this.rueckruf = rueckruf; }
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  }
  win.IntersectionObserver = BeobachterStub;
  win.ResizeObserver = BeobachterStub;
  win.Notification = function () {};
  win.Notification.permission = 'denied';
  win.Notification.requestPermission = () => Promise.resolve('denied');
  if (!win.navigator.wakeLock) {
    Object.defineProperty(win.navigator, 'wakeLock', {
      value: { request: () => Promise.resolve({ release: () => Promise.resolve() }) },
      configurable: true,
    });
  }
  if (!win.matchMedia) {
    win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  }
  // Kein Netz im Test: jeder fetch scheitert kontrolliert. Wer Netz braucht,
  // ueberschreibt win.fetch nach dem Laden.
  win.fetch = () => Promise.reject(new Error('kein Netz im Test'));
  win.scrollTo = () => {};
  // Service Worker gibt es in jsdom nicht — app.js prueft 'serviceWorker' in navigator
  // und ueberspringt den Block dann von selbst.

  // ── Ausgangsdaten setzen, BEVOR die App startet ───────────────────────
  win.localStorage.setItem('bk_books', JSON.stringify(buecher));
  if (einstellungen) win.localStorage.setItem('bk_settings', JSON.stringify(einstellungen));

  // HonStore (IndexedDB) durch einen RAM-Spiegel ersetzen — dieselbe Schnittstelle,
  // die js/store.js nach aussen gibt.
  const spiegel = { roh: JSON.stringify(buecher) };
  win.HonStore = {
    ready: Promise.resolve(),
    getRaw: () => spiegel.roh,
    setRaw: (s) => { spiegel.roh = s; win.localStorage.setItem('bk_books', s); },
    clearBooks: () => { spiegel.roh = '[]'; win.localStorage.removeItem('bk_books'); },
  };

  // ── Skripte in der Reihenfolge aus index.html ausfuehren ──────────────
  const fehler = [];
  for (const rel of skripteAusIndex()) {
    if (rel.includes('store.js')) continue;           // durch den Spiegel ersetzt
    const datei = path.join(WURZEL, rel);
    if (!fs.existsSync(datei)) { fehler.push('fehlt: ' + rel); continue; }
    try {
      win.eval(fs.readFileSync(datei, 'utf8'));
    } catch (e) {
      fehler.push(rel + ': ' + e.message);
    }
  }

  // DOMContentLoaded nachreichen, falls ein Skript darauf wartet
  win.document.dispatchEvent(new win.Event('DOMContentLoaded', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  return {
    dom, win, doc: win.document, spiegel, fehler,
    buecherJetzt: () => JSON.parse(spiegel.roh),
    // app.js und cloud.js legen Intervalle an (Poll, Timer, Maskottchen). Ohne
    // Schliessen haelt jsdom den Node-Prozess offen und der Test endet nie.
    schliessen: () => { try { win.close(); } catch (e) {} },
  };
}

// Kleine Helfer fuer die Tests
export const buch = (o = {}) => ({
  id: o.id || ('id' + Math.round(Math.random() * 1e9)),
  title: o.title || 'Ohne Titel',
  authors: o.authors || ['Unbekannt'],
  status: o.status || 'read',
  rating: o.rating || 0,
  pages: o.pages || 0,
  year: o.year || '',
  categories: o.categories || [],
  cover: o.cover || '',
  isbn: o.isbn || '',
  addedAt: o.addedAt || 1700000000000,
  ...o,
});
