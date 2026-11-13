#!/usr/bin/env node
/**
 * glas-effekte-check.mjs — Wirkungsprüfung für Hon 本 (seit v3.12): Spotlight, Blasen, Schalter „trotzdem zeigen“
 * und die stille Fehlermeldung (Sentry). Gemessen an echten Pixeln und echten Aufrufen, nicht nach Augenmaß:
 *  - Spotlight: Ebene geht beim Berühren einer Glasfläche an, ist auf sie zugeschnitten, der Fleck liegt unter dem Zeiger,
 *    das Bild ändert sich messbar, der Text darunter wird durch den Fleck nicht schlechter als 4,5 : 1, beim Verlassen geht er aus
 *  - Blasen: steigen beim Eintragen eines Buches auf (sichtbar, im Fenster), räumen sich selbst auf (höchstens 24 gleichzeitig)
 *  - Schalter: bei „Bewegung reduzieren“, „Mehr Kontrast“ und „Animationen reduzieren“ (App) ohne Schalter keine Effekte; mit Klick
 *    auf den echten Schalter an (Blasen mit echter Dauer, nicht 0,01 ms), bleibt nach dem Neuladen; bei erzwungenen Farben nie
 *  - Fehlermeldung: der Bericht verlässt die Seite (CSP lässt den Sentry-Host zu), trägt die Version aus der Skript-Adresse, hat
 *    keinen Nutzer, keine Adresse mit Suchteil, keine Klick-/Netz-/Konsolenspur; Browser-Rauschen wird nicht gesendet.
 *    Gesendet wird nichts wirklich: die Anfrage wird abgefangen.
 *
 * Aufruf: node test/glas-effekte-check.mjs [chromium,webkit]      Erwartet: „GLAS-EFFEKTE OK“
 * Playwright liegt nicht im Projekt, sondern unter C:/Users/yami_/node_modules (wie bei der QA, ~/.claude/scripts/qa).
 * WebKit unter Windows zeichnet kein backdrop-filter und klickt kein Touch → dort nur Funktion (synthetische Zeigerereignisse).
 */
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { warte, kontrast, diffMittel, blurProbe } from './helpers/glas-lib.mjs';

const require = createRequire(path.join(os.homedir(), 'x.js'));
const { chromium, webkit, devices } = require('playwright');

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(WURZEL, 'version.json'), 'utf8')).v;   // z. B. v3.12
const TYPEN = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };

function server() {
  return new Promise(fertig => {
    const s = http.createServer((q, a) => {
      let p; try { p = decodeURIComponent(new URL(q.url, 'http://x').pathname); } catch (e) { a.writeHead(400); return a.end(); }
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(WURZEL, p);
      if (!f.startsWith(WURZEL)) { a.writeHead(403); return a.end(); }
      fs.stat(f, (e, st) => {
        if (e || !st.isFile()) { a.writeHead(404); return a.end('404'); }
        a.writeHead(200, { 'content-type': TYPEN[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
        fs.createReadStream(f).pipe(a);
      });
    });
    s.listen(0, '127.0.0.1', () => fertig({ s, url: 'http://127.0.0.1:' + s.address().port + '/' }));
  });
}

const FEHLER = [], OK = [], ALTLAST = [];
const fehl = (wo, t) => FEHLER.push('[' + wo + '] ' + t);
const gut = (wo, t) => OK.push('[' + wo + '] ' + t);

/** App öffnen: frisches Profil, Service Worker aus, Theme und App-Einstellungen vorab setzen, Fehler mitschreiben. */
async function starten(browser, url, optionen, { thema = 'dark', appRuhig = false, extra = null, sentryFang = null } = {}) {
  const ctx = await browser.newContext({ locale: 'de-DE', serviceWorkers: 'block', ...optionen });
  await ctx.addInitScript(([t, ruhig, v]) => {
    try {
      if (!localStorage.getItem('bk_settings')) localStorage.setItem('bk_settings', JSON.stringify({ themeMode: t, reduced: !!ruhig }));
      // Prüfaufbau: ein gesetzter Schlüssel gälte als „schon benutzt“ und öffnete „Was ist neu“ über der Seite → Version als gesehen merken
      if (!localStorage.getItem('bk_seen_version')) localStorage.setItem('bk_seen_version', v);
    } catch (e) {}
  }, [thema, appRuhig, VERSION]);
  if (extra) await ctx.addInitScript(extra);
  if (sentryFang) await ctx.route(/ingest\.de\.sentry\.io/, async route => {
    const q = route.request();
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    sentryFang.push({ url: q.url(), body: q.postData() || '' });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  const p = await ctx.newPage();
  p.fehler = [];
  p.on('pageerror', e => p.fehler.push('pageerror: ' + (e.message || e)));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForSelector('#mainTabs', { state: 'visible', timeout: 25000 });
  await warte(900);
  return { ctx, p };
}

// Glasfläche, auf der geprüft wird: Tab-Leiste (unten bei Handy/Tablet, oben ab 900 px) und Kopfleiste
const FLAECHEN = {
  tabs: () => {
    const r = document.querySelector('.tabs').getBoundingClientRect();
    return { name: 'Tab-Leiste', x: r.left, y: r.top, w: r.width, h: r.height, px: r.left + r.width / 2, py: r.top + r.height / 2, text: '.tabs .tab-lbl' };
  },
  kopf: () => {
    const r = document.querySelector('.topbar').getBoundingClientRect();
    return { name: 'Kopfleiste', x: r.left, y: r.top, w: r.width, h: r.height, px: r.left + Math.min(r.width * 0.45, 420), py: r.top + r.height / 2, text: '.topbar .brand-name, .topbar .brand-sub' };
  }
};

async function textKlemmen(p, sel) {
  return p.evaluate(s => [...document.querySelectorAll(s)].filter(e => (e.innerText || '').trim() && e.getBoundingClientRect().width > 8 && e.getBoundingClientRect().height > 4)
    .map(e => { const r = e.getBoundingClientRect(); return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.ceil(r.width), height: Math.ceil(r.height) }; }), sel);
}

// Zeiger auf die Fläche legen: Maus, bei Touch echtes Berühren über CDP (Chromium), sonst synthetische Zeigerereignisse
async function beruehren(p, ctx, fl, art) {
  if (art === 'touch-cdp') {
    const c = await ctx.newCDPSession(p);
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fl.px, y: fl.py }] });
    return async () => { await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
  }
  if (art === 'synthetisch') {
    await p.evaluate(([x, y]) => { const t = document.elementFromPoint(x, y) || document.body;
      for (const typ of ['pointerdown', 'pointermove']) t.dispatchEvent(new PointerEvent(typ, { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true })); }, [fl.px, fl.py]);
    return async () => { await p.evaluate(() => document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }))); };
  }
  await p.mouse.move(Math.max(2, fl.px - 40), fl.py);
  await p.mouse.move(fl.px, fl.py, { steps: 6 });
  return async () => { await p.mouse.move(5, Math.min(700, fl.py + 300), { steps: 4 }); };
}

async function spotlight(browser, url, wo, optionen, opt = {}) {
  const { ctx, p } = await starten(browser, url, optionen, { thema: opt.thema });
  try {
    if (!(await p.evaluate(() => !!window.Glas))) return fehl(wo, 'window.Glas fehlt (js/glas-licht.js nicht geladen?)');
    const thema = await p.evaluate(() => document.documentElement.dataset.theme);
    if (thema !== opt.thema) return fehl(wo, 'Theme ist «' + thema + '», erwartet «' + opt.thema + '» (Vorbelegung wirkt nicht)');
    for (const schluessel of opt.flaechen || ['tabs', 'kopf']) {
      const w = wo + ' · ' + (schluessel === 'tabs' ? 'Tab-Leiste' : 'Kopfleiste');
      await p.mouse.move(5, 300); await warte(200);
      const fl = await p.evaluate(FLAECHEN[schluessel]);
      if (!fl || !fl.w) { fehl(w, 'Fläche nicht sichtbar'); continue; }
      const klemmen = await textKlemmen(p, fl.text);
      const ohne = await p.screenshot({ clip: { x: fl.x, y: fl.y, width: fl.w, height: fl.h } });
      const cOhne = [];
      for (const k of klemmen) cOhne.push(kontrast(await p.screenshot({ clip: k })));
      const loslassen = await beruehren(p, ctx, fl, opt.art || 'maus');
      await warte(700);
      const lage = await p.evaluate(() => { const l = document.getElementById('glas-licht'); if (!l) return null;
        const i = l.querySelector('i'), r = i.getBoundingClientRect();
        return { an: l.classList.contains('an'), clip: l.style.clipPath, cx: r.left + r.width / 2, cy: r.top + r.height / 2, op: parseFloat(getComputedStyle(l).opacity) }; });
      if (!lage) { fehl(w, 'Ebene #glas-licht wurde nicht gebaut'); await loslassen(); continue; }
      if (!lage.an || lage.op < .9) { fehl(w, 'Spotlight geht beim Berühren nicht an (an=' + lage.an + ', Deckkraft ' + lage.op + ')'); await loslassen(); continue; }
      if (!/inset\(/.test(lage.clip)) fehl(w, 'nicht auf die Fläche zugeschnitten (clip-path: ' + lage.clip + ')');
      if (Math.abs(lage.cx - fl.px) > 6 || Math.abs(lage.cy - fl.py) > 6) fehl(w, 'Fleck liegt nicht unter dem Zeiger (Fleck ' + lage.cx.toFixed(0) + '/' + lage.cy.toFixed(0) + ', Zeiger ' + fl.px.toFixed(0) + '/' + fl.py.toFixed(0) + ')');
      const mit = await p.screenshot({ clip: { x: fl.x, y: fl.y, width: fl.w, height: fl.h } });
      if (process.env.GLAS_DUMP) { const n = process.env.GLAS_DUMP + w.replace(/\W+/g, '_'); fs.writeFileSync(n + '-ohne.png', ohne); fs.writeFileSync(n + '-mit.png', mit); }
      const d = diffMittel(ohne, mit);
      if (opt.strenge !== false && d < 0.3) fehl(w, 'Spotlight kaum sichtbar: mittlere Pixelabweichung ' + d.toFixed(2) + ' von 255 (erwartet >= 0.3)');
      let schlecht = 0, altlast = 0, minC = 99, minOhne = 99;
      for (let i = 0; i < klemmen.length; i++) {
        const c = kontrast(await p.screenshot({ clip: klemmen[i] }));
        if (c > 0) minC = Math.min(minC, c);
        if (cOhne[i] > 0) minOhne = Math.min(minOhne, cOhne[i]);
        if (c < 4.5) { if (cOhne[i] < 4.5 && c >= cOhne[i] - 0.3) altlast++; else schlecht++; }   // schlecht = erst durch den Fleck schlechter
      }
      if (klemmen.length && schlecht && opt.strenge !== false) fehl(w, schlecht + ' von ' + klemmen.length + ' Beschriftungen werden durch den Fleck schlechter und liegen < 4.5 : 1 (schlechtester Wert ' + minC.toFixed(2) + ', ohne Fleck ' + minOhne.toFixed(2) + ')');
      if (altlast) ALTLAST.push('[' + w + '] ' + altlast + ' von ' + klemmen.length + ' Beschriftungen liegen schon ohne Spotlight < 4.5 : 1 (ohne Fleck ' + minOhne.toFixed(2) + ', mit Fleck ' + minC.toFixed(2) + ')');
      await loslassen(); await warte(500);
      if (await p.evaluate(() => document.getElementById('glas-licht')?.classList.contains('an'))) fehl(w, 'Spotlight geht nach dem Loslassen/Verlassen nicht aus');
      gut(w, 'Fleck unter dem Zeiger, Abweichung ' + d.toFixed(2) + ', Kontrast >= ' + (minC === 99 ? '-' : minC.toFixed(2)) + ', geht wieder aus');
    }
    if (p.fehler.length) fehl(wo, p.fehler.join(' | '));
  } finally { await ctx.close(); }
}

/** Buch über das echte Formular eintragen (löst upsertBook aus). */
async function buchEintragen(p, titel) {
  await p.click('#mainTabs .tab[data-tab="suche"]'); await warte(500);
  await p.click('#manualBtn'); await warte(400);
  await p.fill('#mfTitle', titel);
  await p.click('#mfSave');
}

async function blasen(browser, url, wo, optionen, thema) {
  const { ctx, p } = await starten(browser, url, optionen, { thema });
  try {
    await buchEintragen(p, 'Blasen-Probe');
    await warte(450);
    const m = await p.evaluate(() => { const l = [...document.querySelectorAll('#glas-blasen i')];
      return { n: l.length, imFenster: l.filter(e => { const r = e.getBoundingClientRect(); return r.width > 4 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; }).length,
        op: l.map(e => parseFloat(getComputedStyle(e).opacity)), dauer: l[0] ? getComputedStyle(l[0]).animationDuration : '' }; });
    if (m.n < 3) fehl(wo, 'nach dem Eintragen nur ' + m.n + ' Blasen (erwartet >= 3)');
    else if (!m.imFenster) fehl(wo, 'Blasen liegen außerhalb des Fensters');
    else if (Math.max(...m.op) < .3) fehl(wo, 'Blasen unsichtbar (höchste Deckkraft ' + Math.max(...m.op).toFixed(2) + ')');
    if (m.n > 24) fehl(wo, m.n + ' Blasen gleichzeitig (Grenze 24)');
    // Der Speicher ist komprimiert (lz-string): gezählt wird, was die App selbst anzeigt (Zahl am Reiter „Sammlung“)
    const gespeichert = await p.evaluate(() => parseInt((document.getElementById('libBadge') || {}).textContent, 10));
    if (!(gespeichert >= 1)) fehl(wo, 'das Buch wurde nicht eingetragen (Zähler am Reiter: ' + gespeichert + ')');
    await warte(3600);
    const rest = await p.evaluate(() => document.querySelectorAll('#glas-blasen i').length);
    if (rest) fehl(wo, rest + ' Blasen räumen sich nicht auf');
    if (p.fehler.length) fehl(wo, p.fehler.join(' | '));
    gut(wo, 'Blasen: ' + m.n + ' aufgestiegen (Dauer ' + m.dauer + '), danach aufgeräumt, Buch gespeichert');
  } finally { await ctx.close(); }
}

const SICHTBAR = id => `(() => { const l = document.getElementById('${id}'); return !!l && getComputedStyle(l).display !== 'none'; })()`;

// Schalter: Gerät/App meldet „reduzieren“ → aus; Klick auf den echten Schalter → an, auch nach dem Neuladen
async function schalter(browser, url, wo, optionen, opt = {}) {
  const { ctx, p } = await starten(browser, url, optionen, { appRuhig: !!opt.appRuhig });
  try {
    const a = await p.evaluate(() => ({ licht: !!document.getElementById('glas-licht'), imm: Glas.immer(), lage: Glas.lage(), erlaubt: (() => { Glas.blasen(); return !!document.querySelector('#glas-blasen i'); })() }));
    if (a.erlaubt) fehl(wo, 'Blasen steigen trotz Meldung (' + JSON.stringify(a.lage) + ') ohne Schalter auf');
    if (await p.evaluate(SICHTBAR('glas-licht'))) fehl(wo, 'Spotlight-Ebene ist trotz Meldung (' + JSON.stringify(a.lage) + ') ohne Schalter sichtbar');
    await p.click('#mainTabs .tab[data-tab="settings"]'); await warte(500);
    const satz = await p.evaluate(() => document.getElementById('glasLage')?.textContent || '');
    if (!/Dein Gerät meldet/.test(satz)) fehl(wo, 'Satz „Dein Gerät meldet …“ fehlt oder falsch: «' + satz + '»');
    const schalterEl = p.locator('label.switch:has(#setGlasImmer)');
    await schalterEl.scrollIntoViewIfNeeded().catch(() => {});
    await schalterEl.click();
    await warte(500);
    const b = await p.evaluate(() => ({ imm: Glas.immer(), klasse: document.documentElement.classList.contains('glas-immer'), ls: localStorage.getItem('bk_glas_immer'), haken: document.getElementById('setGlasImmer').checked, satz: document.getElementById('glasLage').textContent }));
    if (!b.imm || !b.klasse || b.ls !== '1' || !b.haken) fehl(wo, 'Schalter wirkt nicht (' + JSON.stringify(b) + ')');
    // Spotlight wieder auf die Tab-Leiste, dann Blasen mit echter Dauer
    const fl = await p.evaluate(FLAECHEN.tabs);
    await beruehren(p, ctx, fl, 'maus'); await warte(700);
    if (!(await p.evaluate(() => document.getElementById('glas-licht')?.classList.contains('an') && getComputedStyle(document.getElementById('glas-licht')).display !== 'none'))) fehl(wo, 'Spotlight geht auch mit eingeschaltetem Schalter nicht an');
    await p.mouse.move(5, 300);
    await p.evaluate(() => Glas.blasen());
    await warte(500);
    const dau = await p.evaluate(() => { const i = document.querySelector('#glas-blasen i'); if (!i) return -1; const d = getComputedStyle(i).animationDuration; return parseFloat(d) * (/ms$/.test(d) ? 1 : 1000); });
    if (dau < 500) fehl(wo, 'Blasen mit Schalter: Dauer ' + dau + ' ms (erwartet >= 500 ms) — die globale Kürzung greift noch');
    // Neuladen: bleibt an (Schalter nur im Gerät)
    await p.reload({ waitUntil: 'load' }); await p.waitForSelector('#mainTabs', { state: 'visible' }); await warte(900);
    const nach = await p.evaluate(() => ({ imm: Glas.immer(), klasse: document.documentElement.classList.contains('glas-immer') }));
    if (!nach.imm || !nach.klasse) fehl(wo, 'Schalter bleibt nach dem Neuladen nicht an');
    // wieder aus
    await p.click('#mainTabs .tab[data-tab="settings"]'); await warte(400);
    await p.locator('label.switch:has(#setGlasImmer)').click(); await warte(400);
    const aus = await p.evaluate(() => ({ klasse: document.documentElement.classList.contains('glas-immer'), ls: localStorage.getItem('bk_glas_immer'), licht: (() => { const l = document.getElementById('glas-licht'); return !!l && getComputedStyle(l).display !== 'none'; })() }));
    if (aus.klasse || aus.ls !== null || aus.licht) fehl(wo, 'Schalter aus wirkt nicht (' + JSON.stringify(aus) + ')');
    if (p.fehler.length) fehl(wo, p.fehler.join(' | '));
    gut(wo, 'Schalter: ohne = aus, Klick = Spotlight und Blasen (' + dau.toFixed(0) + ' ms), bleibt nach Neuladen, aus wirkt');
  } finally { await ctx.close(); }
}

// Erzwungene Farben: auch mit gesetztem Schalter bleiben die Effekte aus
async function farben(browser, url, wo) {
  const { ctx, p } = await starten(browser, url, { viewport: { width: 1280, height: 800 }, forcedColors: 'active' }, { extra: () => { try { localStorage.setItem('bk_glas_immer', '1'); } catch (e) {} } });
  try {
    const r = await p.evaluate(() => { Glas.blasen(); return { farben: Glas.lage().farben, blasen: document.querySelectorAll('#glas-blasen i').length, licht: !!document.getElementById('glas-licht') && getComputedStyle(document.getElementById('glas-licht')).display !== 'none' }; });
    if (!r.farben) return ALTLAST.push('[' + wo + '] Engine meldet forced-colors nicht — Fall nicht prüfbar');
    if (r.blasen || r.licht) fehl(wo, 'bei erzwungenen Farben laufen Effekte trotz Schalter (' + JSON.stringify(r) + ')');
    else gut(wo, 'erzwungene Farben: Effekte bleiben auch mit Schalter aus');
  } finally { await ctx.close(); }
}

async function fehlermeldung(browser, url, wo) {
  const fang = [];
  const { ctx, p } = await starten(browser, url, { viewport: { width: 1280, height: 800 } }, { extra: () => { try { localStorage.setItem('bk_fehler_test', '1'); } catch (e) {} }, sentryFang: fang });
  try {
    const sdk = await p.evaluate(() => ({ da: typeof FehlerSDK !== 'undefined', test: typeof bkFehlerTest }));
    if (!sdk.da) return fehl(wo, 'FehlerSDK nicht geladen (js/vendor/sentry-sdk.js)');
    if (sdk.test !== 'function') return fehl(wo, 'bkFehlerTest fehlt (fehlermeldung.js hat nicht gestartet)');
    // Klick-, Netz- und Konsolenspur würde Breadcrumbs füllen: erst etwas tun, dann den Fehler auslösen
    await p.evaluate(() => { document.body.click(); console.log('Spur-Probe'); return fetch('/version.json?geheim=1').then(r => r.text()); });
    await p.evaluate(() => { setTimeout(() => { throw new Error('Probefehler glas-effekte-check'); }, 0); });
    await p.evaluate(() => { Promise.reject(new TypeError('Failed to fetch')); });   // Rauschen: darf NICHT gesendet werden
    await p.evaluate(() => bkFehlerTest());
    await warte(2500);
    const roh = fang.map(f => f.body).join('\n');
    if (!roh) return fehl(wo, 'es wurde nichts an Sentry gesendet (CSP connect-src? Transport?)');
    const ereignisse = [];
    for (const f of fang) for (const z of f.body.split('\n')) { try { const j = JSON.parse(z); if (j && (j.exception || j.message || j.logentry)) ereignisse.push(j); } catch (e) {} }
    if (!ereignisse.length) return fehl(wo, 'Sentry-Anfrage ohne lesbares Ereignis');
    if (!ereignisse.some(e => JSON.stringify(e).includes('Probefehler glas-effekte-check'))) fehl(wo, 'der echte Fehler (throw) kam nicht an');
    if (!ereignisse.some(e => JSON.stringify(e).includes('Testfehler'))) fehl(wo, 'bkFehlerTest-Meldung kam nicht an');
    if (/Failed to fetch/.test(roh)) fehl(wo, '„Failed to fetch“ wurde gesendet — Rauschfilter wirkt nicht');
    for (const f of fang) if (/[?#]/.test(f.url.replace(/\?sentry_[^#]*$/, ''))) fehl(wo, 'Sentry-Adresse mit unerwartetem Suchteil: ' + f.url);
    for (const e of ereignisse) {
      if (e.release !== VERSION) fehl(wo, 'release ist «' + e.release + '», erwartet ' + VERSION + ' (Version aus der ?v= der Skript-Adresse)');
      if (e.environment !== 'produktion') fehl(wo, 'environment ist «' + e.environment + '»');
      if (e.user) fehl(wo, 'Ereignis trägt einen Nutzer: ' + JSON.stringify(e.user));
      if (e.request && /[?#]/.test(e.request.url || '')) fehl(wo, 'request.url mit Suchteil/Anker: ' + e.request.url);
      if (e.request && (e.request.cookies || (e.request.headers && (e.request.headers.Referer || e.request.headers.referer)))) fehl(wo, 'request trägt Cookies/Referer');
      const spur = (e.breadcrumbs || []).map(b => b.category + ':' + (b.data && (b.data.url || b.data.from || '')));
      if ((e.breadcrumbs || []).some(b => /^(ui\.|xhr|fetch|console|navigation)/.test(b.category || ''))) fehl(wo, 'Klick-/Netz-/Konsolenspur im Ereignis: ' + spur.join(', '));
      if (/geheim=1|Spur-Probe/.test(JSON.stringify(e))) fehl(wo, 'Adresse mit Suchteil oder Konsolentext im Ereignis');
    }
    // Prüfaufbau: die zwei absichtlich ausgelösten Fehler (throw, Promise.reject) meldet Playwright selbst als pageerror
    if (p.fehler.some(x => !/Probefehler|Failed to fetch/.test(x))) fehl(wo, p.fehler.join(' | '));
    gut(wo, 'Fehlermeldung: ' + ereignisse.length + ' Ereignis(se) abgefangen, release ' + VERSION + ', ohne Nutzer/Suchteil/Klick-, Netz- und Konsolenspur, Rauschen gefiltert');
  } finally { await ctx.close(); }
}

const motoren = (process.argv[2] || 'chromium,webkit').split(',');
const { s, url } = await server();
try {
  if (motoren.includes('chromium')) {
    const b = await chromium.launch();
    try {
      for (const [w, h] of [[375, 667], [768, 1024], [1280, 800]])
        for (const thema of ['dark', 'light']) {
          const mobil = w < 768;
          await spotlight(b, url, `chromium ${w}px ${thema}`, { viewport: { width: w, height: h }, hasTouch: mobil, isMobile: false }, { thema, art: mobil ? 'touch-cdp' : 'maus' });
        }
      await spotlight(b, url, 'chromium Pixel 7 Touch', { ...devices['Pixel 7'] }, { thema: 'dark', art: 'touch-cdp' });
      for (const [w, h, t] of [[375, 667, 'dark'], [1280, 800, 'light']]) await blasen(b, url, `chromium ${w}px ${t}`, { viewport: { width: w, height: h }, hasTouch: w < 768 }, t);
      await schalter(b, url, 'chromium 375px Bewegung reduzieren', { viewport: { width: 375, height: 667 }, hasTouch: true, reducedMotion: 'reduce' });
      await schalter(b, url, 'chromium 1280px Bewegung reduzieren', { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      await schalter(b, url, 'chromium 1280px Mehr Kontrast', { viewport: { width: 1280, height: 800 }, contrast: 'more' });
      await schalter(b, url, 'chromium 1280px App „Animationen reduzieren“', { viewport: { width: 1280, height: 800 } }, { appRuhig: true });
      await farben(b, url, 'chromium Erzwungene Farben');
      await fehlermeldung(b, url, 'chromium Fehlermeldung');
    } finally { await b.close(); }
  }
  if (motoren.includes('webkit')) {
    const b = await webkit.launch();
    try {
      await spotlight(b, url, 'webkit Safari-Desktop 1280px', { viewport: { width: 1280, height: 800 } }, { thema: 'dark', strenge: false });
      await spotlight(b, url, 'webkit iPhone 13 (synthetisch)', { ...devices['iPhone 13'] }, { thema: 'dark', art: 'synthetisch', strenge: false });
      await spotlight(b, url, 'webkit iPad (synthetisch)', { ...devices['iPad (gen 7)'] }, { thema: 'light', art: 'synthetisch', strenge: false });
      await blasen(b, url, 'webkit 1280px', { viewport: { width: 1280, height: 800 } }, 'dark');
      await schalter(b, url, 'webkit 1280px Bewegung reduzieren', { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      await fehlermeldung(b, url, 'webkit Fehlermeldung');
    } finally { await b.close(); }
  }
} catch (e) { FEHLER.push('Abbruch: ' + (e.stack || e)); }
finally { s.close(); }

for (const z of OK) console.log('OK   ' + z);
for (const z of ALTLAST) console.log('ALTLAST ' + z);
for (const z of FEHLER) console.log('FEHLER ' + z);
console.log('Firefox: ungeprüft (auf diesem Rechner nicht startbar); echte Geräte: ungeprüft');
console.log(FEHLER.length ? 'GLAS-EFFEKTE FEHLER: ' + FEHLER.length : 'GLAS-EFFEKTE OK');
process.exit(FEHLER.length ? 1 : 0);
