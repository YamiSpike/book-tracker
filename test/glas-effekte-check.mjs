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

const NUR = process.env.GLAS_NUR || '';   // 'fehler' = nur Fehlermeldung (Chromium), 'abbruch' = nur Blasen-Abbruch (Chromium)
const FREMD_SKRIPT = 'https://cdnjs.cloudflare.com/ajax/libs/fremd-probe/1.0.0/fremd.js';   // anderer Ursprung, vom Rauschfilter als Fremdskript erkannt

// Gegenproben: absichtlich kaputte Kopien. Jede ersetzt Muster der Quelle; findet sie keins, ist die Gegenprobe wertlos → Exit 2.
// Ein grünes „GLAS-EFFEKTE OK“ sagt nur etwas, wenn die Prüfung auch rot werden kann (test/glas-mutanten.mjs lässt sie alle laufen).
const MUT = process.env.GLAS_MUTANT || '';
const MUTANTEN = {
  ip: { datei: '/js/fehlermeldung.js', ersetze: [[/event\.user\s*=\s*\{\s*ip_address:\s*null\s*\};?/, '/* MUTANT */']] },
  vendor: { datei: '/js/fehlermeldung.js', ersetze: [[/^.*sentry-sdk\\\.js.*$/m, '/* MUTANT */']] },
  suchteil: { datei: '/js/fehlermeldung.js', ersetze: [[/b\.data\.from = ohneSuchteil\(b\.data\.from\); b\.data\.to = ohneSuchteil\(b\.data\.to\);/, '/* MUTANT */']] },
  blase: { datei: '/js/glas-licht.js', ersetze: [[/^.*addEventListener\('animationcancel'.*$/m, '/* MUTANT */'], [/^.*setTimeout\(weg, 4000\);.*$/m, '/* MUTANT */']] },
  // SW-Update: Ablehnung von r.update() wieder unbehandelt
  update: { datei: '/js/update.js', ersetze: [[/if \(up && up\.catch\) up\.catch\(function \(\) \{\}\);/, '/* MUTANT */']] },
};
if (MUT && !MUTANTEN[MUT]) { console.error(`GLAS_MUTANT=${MUT} ist unbekannt (${Object.keys(MUTANTEN).join(', ')})`); process.exit(2); }
function mutiere(text) {
  let t = text;
  for (const [re, neu] of MUTANTEN[MUT].ersetze) {
    if (!re.test(t)) { console.error(`MUTANT ${MUT}: Muster ${re} nicht gefunden in ${MUTANTEN[MUT].datei} — Quelle hat sich geändert, Gegenprobe anpassen`); process.exit(2); }
    t = t.replace(re, neu);
  }
  return t;
}

function server() {
  return new Promise(fertig => {
    const s = http.createServer((q, a) => {
      let p; try { p = decodeURIComponent(new URL(q.url, 'http://x').pathname); } catch (e) { a.writeHead(400); return a.end(); }
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(WURZEL, p);
      if (!f.startsWith(WURZEL)) { a.writeHead(403); return a.end(); }
      fs.stat(f, (e, st) => {
        if (e || !st.isFile()) { a.writeHead(404); return a.end('404'); }
        const kopf = { 'content-type': TYPEN[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' };
        // Gegenprobe: diese eine Datei wird absichtlich kaputt ausgeliefert
        if (MUT && MUTANTEN[MUT].datei === p) { a.writeHead(200, kopf); return a.end(mutiere(fs.readFileSync(f, 'utf8'))); }
        // Testaufbau: die App sperrt per CSP (<meta>, script-src 'self') jedes Fremdskript, ein Skript von „cdnjs“ liefe nie und die
        // Fremdfehler-Probe bliebe wirkungslos. Nur die ausgelieferte Kopie erlaubt dem Fake-Host das Skript; die Quelle bleibt unverändert.
        if (p === '/index.html') {
          // Mit Semikolon verankert: derselbe Wortlaut steht auch im HTML-Kommentar darüber, ein ungenaues Muster träfe den Kommentar
          const roh = fs.readFileSync(f, 'utf8');
          const html = roh.replace(/^(\s*)script-src 'self';/m, "$1script-src 'self' https://cdnjs.cloudflare.com;");
          if (html === roh) { console.error("Testaufbau: script-src 'self'; in index.html nicht gefunden — Fremdskript-Probe anpassen"); process.exit(2); }
          a.writeHead(200, kopf); return a.end(html);
        }
        a.writeHead(200, kopf);
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
async function starten(browser, url, optionen, { thema = 'dark', appRuhig = false, extra = null, sentryFang = null, vorStart = null } = {}) {
  const ctx = await browser.newContext({ locale: 'de-DE', serviceWorkers: 'block', ...optionen });
  await ctx.addInitScript(([t, ruhig, v]) => {
    try {
      if (!localStorage.getItem('bk_settings')) localStorage.setItem('bk_settings', JSON.stringify({ themeMode: t, reduced: !!ruhig }));
      // Prüfaufbau: ein gesetzter Schlüssel gälte als „schon benutzt“ und öffnete „Was ist neu“ über der Seite → Version als gesehen merken
      if (!localStorage.getItem('bk_seen_version')) localStorage.setItem('bk_seen_version', v);
    } catch (e) {}
  }, [thema, appRuhig, VERSION]);
  // Schriften kommen von Google Fonts. Hängt dieser Host (23.11.: Timeout auf goto), wartet „load“ ewig und die Prüfung scheitert am
  // Netz statt an der App. Die Prüfung hängt darum nicht am Netz: Fonts werden abgebrochen, die App fällt auf ihre Ersatzschrift zurück.
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  if (extra) await ctx.addInitScript(extra);
  if (sentryFang) await ctx.route(/ingest\.de\.sentry\.io/, async route => {
    const q = route.request();
    if (q.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    sentryFang.push({ url: q.url(), body: q.postData() || '' });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  if (vorStart) await vorStart(ctx);
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
  // Probe „SW-Update“: update.js ruft r.update() je Registrierung auf. Eine Registrierung, deren update() ablehnt („Not found“ bei gerade
  // getauschtem sw.js), darf keine unbehandelte Ablehnung (und damit kein Sentry-Ereignis) erzeugen. Der Service Worker ist im Prüfaufbau
  // gesperrt, darum ein vollständiger Stub samt Zähler; fehlt der Aufruf später, schlägt der Testaufbau selbst an.
  const extra = () => {
    try { localStorage.setItem('bk_fehler_test', '1'); } catch (e) {}
    window.__swUpdates = 0;
    const reg = { update: () => { window.__swUpdates++; return Promise.reject(new TypeError('Not found probe')); }, unregister: () => Promise.resolve(true) };
    const stub = { getRegistrations: () => Promise.resolve([reg]), getRegistration: () => Promise.resolve(reg), register: () => Promise.resolve(reg), ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
    try { Object.defineProperty(navigator, 'serviceWorker', { value: stub, configurable: true }); } catch (e) { /* nicht überschreibbar */ }
  };
  const { ctx, p } = await starten(browser, url, { viewport: { width: 1280, height: 800 } }, { extra, sentryFang: fang, vorStart: async c => {
    // Fremdskript von einem ANDEREN Ursprung (cdnjs-Adresse, vom Rauschfilter als Fremdskript erkannt), das in einem Klick-Rückruf wirft
    await c.route(FREMD_SKRIPT, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: "window.__fremdGeladen = true; document.addEventListener('click', function () { throw new Error('Fremdfehler glas-effekte-check'); });" }));
    // Ein Skript von DIESER Seite, das wirft: ein Wurf aus page.evaluate hätte keine eigene Fundstelle und bewiese nichts
    await c.route('**/__probe-eigen.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: "setTimeout(function () { throw new Error('Probefehler glas-effekte-check'); }, 0);" }));
  } });
  try {
    const sdk = await p.evaluate(() => ({ da: typeof FehlerSDK !== 'undefined', test: typeof bkFehlerTest }));
    if (!sdk.da) return fehl(wo, 'FehlerSDK nicht geladen (js/vendor/sentry-sdk.js)');
    if (sdk.test !== 'function') return fehl(wo, 'bkFehlerTest fehlt (fehlermeldung.js hat nicht gestartet)');
    // Klick- und Netzspur würde Breadcrumbs füllen: erst etwas tun, dann den Fehler auslösen
    await p.evaluate(() => { document.body.click(); console.log('Spur-Probe'); return fetch('/version.json?geheim=1').then(r => r.text()); });
    // Seitenwechsel-Spur mit Suchteil: das gebündelte SDK kürzt nur request.url, from/to der Breadcrumbs kürzt fehlermeldung.js
    await p.evaluate(() => { history.pushState({}, '', '/?geheim=2'); history.pushState({}, '', '/?geheim=3#x'); });
    const laden = src => p.evaluate(s => new Promise(ok => { const e = document.createElement('script'); e.src = s; e.onload = ok; e.onerror = ok; document.head.appendChild(e); }), src);
    await laden('/__probe-eigen.js');
    await laden(FREMD_SKRIPT);
    await warte(300);
    // Testaufbau: eine Probe, die nie lief, darf kein „sauber“ vortäuschen
    if (!(await p.evaluate(() => window.__fremdGeladen === true))) fehl(wo, 'Testaufbau: das Fremdskript wurde nicht ausgeführt — die Fremdfehler-Probe bliebe wirkungslos');
    await p.evaluate(() => { document.body.click(); });   // löst den Fremdfehler im Klick-Rückruf aus
    await p.evaluate(() => { Promise.reject(new TypeError('Failed to fetch')); });   // Rauschen: darf NICHT gesendet werden
    await p.evaluate(() => bkFehlerTest());
    await warte(3000);   // update.js stößt die SW-Aktualisierung nach 1,5 s an
    if (!(await p.evaluate(() => window.__swUpdates >= 1))) fehl(wo, 'Testaufbau: r.update() wurde nie aufgerufen — die SW-Update-Probe bliebe wirkungslos');
    const roh = fang.map(f => f.body).join('\n');
    if (!roh) return fehl(wo, 'es wurde nichts an Sentry gesendet (CSP connect-src? Transport?)');
    const ereignisse = [];
    for (const f of fang) for (const z of f.body.split('\n')) { try { const j = JSON.parse(z); if (j && (j.exception || j.message || j.logentry)) ereignisse.push(j); } catch (e) {} }
    if (!ereignisse.length) return fehl(wo, 'Sentry-Anfrage ohne lesbares Ereignis');
    if (!ereignisse.some(e => JSON.stringify(e).includes('Probefehler glas-effekte-check'))) fehl(wo, 'der echte Fehler (throw aus eigenem Skript) kam nicht an');
    if (!ereignisse.some(e => JSON.stringify(e).includes('Testfehler'))) fehl(wo, 'bkFehlerTest-Meldung kam nicht an');
    if (/Failed to fetch/.test(roh)) fehl(wo, '„Failed to fetch“ wurde gesendet — Rauschfilter wirkt nicht');
    if (process.env.GLAS_DEBUG) for (const e of ereignisse) console.log('DEBUG Ereignis:', JSON.stringify({ msg: (e.exception && e.exception.values || []).map(v => v.type + ': ' + v.value), frames: (e.exception && e.exception.values || []).map(v => ((v.stacktrace && v.stacktrace.frames) || []).map(f => (f.filename || '') + ':' + (f.function || ''))) }));
    if (/Fremdfehler glas-effekte-check/.test(roh)) fehl(wo, 'ein Fehler aus Fremdskript + SDK-Wrapper-Frame wurde gesendet — der Frame-Skip für /sentry-sdk.js in istMeldenswert wirkt nicht');
    if (/Not found probe/.test(roh) || p.fehler.some(x => /Not found probe/.test(x))) fehl(wo, 'die Ablehnung von r.update() (SW-Update, „Not found“) bleibt unbehandelt — .catch in js/update.js fehlt');
    for (const f of fang) if (/[?#]/.test(f.url.replace(/\?sentry_[^#]*$/, ''))) fehl(wo, 'Sentry-Adresse mit unerwartetem Suchteil: ' + f.url);
    // Die Suchteil-Prüfung ist nur etwas wert, wenn die Spur überhaupt Seitenwechsel enthält
    const nav = ereignisse.flatMap(e => (e.breadcrumbs || []).filter(b => b.category === 'navigation'));
    if (!nav.length) fehl(wo, 'Testaufbau: keine Seitenwechsel-Spur im Ereignis — die Suchteil-Prüfung bliebe wirkungslos');
    for (const b of nav) if (/\?/.test((b.data || {}).from + ' ' + (b.data || {}).to)) fehl(wo, 'Seitenwechsel-Spur mit Suchteil: ' + JSON.stringify(b.data));
    for (const e of ereignisse) {
      if (e.release !== VERSION) fehl(wo, 'release ist «' + e.release + '», erwartet ' + VERSION + ' (Version aus der ?v= der Skript-Adresse)');
      if (e.environment !== 'produktion') fehl(wo, 'environment ist «' + e.environment + '»');
      // Erlaubt ist genau {ip_address: null}: das verbietet Sentry, die IP aus der Verbindung abzuleiten.
      if (!e.user || e.user.ip_address !== null || Object.keys(e.user).length !== 1) fehl(wo, 'user soll genau {ip_address:null} sein, ist: ' + JSON.stringify(e.user));
      if (e.request && /[?#]/.test(e.request.url || '')) fehl(wo, 'request.url mit Suchteil/Anker: ' + e.request.url);
      if (e.request && (e.request.cookies || (e.request.headers && (e.request.headers.Referer || e.request.headers.referer)))) fehl(wo, 'request trägt Cookies/Referer');
      const spur = (e.breadcrumbs || []).filter(b => /^(ui\.|xhr|fetch|console)/.test(b.category || ''));
      if (spur.length) fehl(wo, 'Klick-/Netz-/Konsolenspur im Ereignis: ' + spur.map(b => b.category).join(', '));
      if (/geheim=\d|Spur-Probe/.test(JSON.stringify(e))) fehl(wo, 'Adresse mit Suchteil oder Konsolentext im Ereignis');
    }
    // Prüfaufbau: die absichtlich ausgelösten Fehler (Probefehler, Fremdfehler, Promise.reject, SW-Stub) meldet Playwright selbst als pageerror
    const unerwartet = p.fehler.filter(x => !/Probefehler|Fremdfehler|Failed to fetch|Not found probe/.test(x));
    if (unerwartet.length) fehl(wo, unerwartet.join(' | '));
    gut(wo, 'Fehlermeldung: ' + ereignisse.length + ' Ereignis(se) abgefangen, release ' + VERSION + ', user {ip_address:null}, ohne Suchteil (auch in der Seitenwechsel-Spur)/Klick-/Netz-/Konsolenspur, Rauschen und Fremdfehler gefiltert, SW-Update-Ablehnung abgefangen, eigener Fehler kommt an');
  } finally { await ctx.close(); }
}

// Blasen räumen sich auch auf, wenn die Animation abgebrochen wird (Container ausgeblendet = display:none) — dann feuert animationend
// nie. Chromium meldet animationcancel (strikt: nach 0,7 s leer); WebKit verlässt sich u. U. auf den Notanker (nach 4 s weg).
// Beides zusammen: nach knapp 5 s ist in jeder Engine nichts mehr da.
async function blasenAbbruch(browser, url, wo, strikt) {
  const name = wo + ' Blasen-Abbruch';
  const { ctx, p } = await starten(browser, url, { viewport: { width: 1280, height: 800 } }, {});
  try {
    await p.evaluate(() => Glas.blasen());
    await warte(350);
    const n0 = await p.evaluate(() => document.querySelectorAll('#glas-blasen i').length);
    if (n0 < 4) return fehl(name, 'Testaufbau: nur ' + n0 + ' Blasen vor dem Abbruch');
    await p.evaluate(() => { document.getElementById('glas-blasen').style.display = 'none'; });   // bricht alle Animationen ab
    await warte(700);
    const n1 = await p.evaluate(() => document.querySelectorAll('#glas-blasen i').length);
    if (strikt && n1) fehl(name, n1 + ' von ' + n0 + ' Blasen bleiben nach abgebrochener Animation stehen (animationcancel räumt nicht auf)');
    await warte(4000);
    const n2 = await p.evaluate(() => document.querySelectorAll('#glas-blasen i').length);
    if (n2) fehl(name, n2 + ' von ' + n0 + ' Blasen sind auch nach 5 s noch da (weder animationcancel noch Notanker räumen auf)');
    if (!FEHLER.some(x => x.startsWith('[' + name + ']'))) gut(name, n0 + ' Blasen → nach Abbruch ' + n1 + ' (nach 0,7 s), ' + n2 + ' (nach 5 s)');
  } finally { await ctx.close(); }
}

const motoren = (process.argv[2] || 'chromium,webkit').split(',');
const { s, url } = await server();
try {
  if (motoren.includes('chromium')) {
    const b = await chromium.launch();
    try {
     if (NUR === 'fehler') await fehlermeldung(b, url, 'chromium Fehlermeldung');
     else if (NUR === 'abbruch') await blasenAbbruch(b, url, 'chromium', true);
     else {
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
      await blasenAbbruch(b, url, 'chromium', true);
     }
    } finally { await b.close(); }
  }
  if (motoren.includes('webkit') && !NUR) {
    const b = await webkit.launch();
    try {
      await spotlight(b, url, 'webkit Safari-Desktop 1280px', { viewport: { width: 1280, height: 800 } }, { thema: 'dark', strenge: false });
      await spotlight(b, url, 'webkit iPhone 13 (synthetisch)', { ...devices['iPhone 13'] }, { thema: 'dark', art: 'synthetisch', strenge: false });
      await spotlight(b, url, 'webkit iPad (synthetisch)', { ...devices['iPad (gen 7)'] }, { thema: 'light', art: 'synthetisch', strenge: false });
      await blasen(b, url, 'webkit 1280px', { viewport: { width: 1280, height: 800 } }, 'dark');
      await schalter(b, url, 'webkit 1280px Bewegung reduzieren', { viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      await fehlermeldung(b, url, 'webkit Fehlermeldung');
      await blasenAbbruch(b, url, 'webkit', false);
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
