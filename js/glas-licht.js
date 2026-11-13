/* Hon 本 · Bücher Tracker — Glas-Effekte (seit v3.12): Spotlight und Blasen.
 *
 * Spotlight: ein weicher Lichtfleck folgt Maus oder Finger auf den Glasflächen (Kopfleiste, Tab-Leiste, Blätter,
 * Karten, Meldungen). Es gibt nur EINE feste Ebene (#glas-licht); der Fleck wandert per transform, die Ebene
 * wird per clip-path auf die berührte Fläche zugeschnitten und blendet per opacity ein und aus. Bei Touch
 * leuchtet er nur, solange man drückt — beim Scrollen kommt pointercancel und er geht aus.
 * Blasen: beim Eintragen oder Speichern eines Buches steigen ein paar Glasblasen aus der unteren Leiste auf.
 *
 * Aus bei reduzierter Bewegung/Transparenz, mehr Kontrast, erzwungenen Farben, ohne backdrop-filter und wenn in
 * der App „Animationen reduzieren" an ist — dieselben Fälle, in denen css/glas.css die Flächen deckend macht.
 * Dafür gibt es einen Schalter (Einstellungen → Darstellung): „Spotlight und Blasen trotzdem zeigen". Er hebt
 * Bewegung/Transparenz/Kontrast/„Animationen reduzieren" auf, nie erzwungene Farben und nie das fehlende
 * backdrop-filter, und gilt nur für dieses Gerät (localStorage, steht in der Sperrliste von js/cloud.js),
 * weil auch die Systemeinstellung nur dieses Gerät betrifft.
 *
 * Klassisches Skript (kein Modul), gibt window.Glas frei. Scheitert hier etwas, läuft die App unberührt weiter.
 */
(function (global) {
  'use strict';

  var FLAECHEN = '.topbar, .tabs, .modal-inner, .admin-card, .toast, .home-hero, .stat-card, .card';
  var RADIUS = 150;          // halbe Breite des Flecks, passt zu css/glas.css (#glas-licht i)
  var NACHLAUF = 500;        // so lange nach einem Wechsel die Fläche weiter nachmessen (Blätter gleiten ein)
  var MAX_BLASEN = 24;
  var SCHLUESSEL = 'bk_glas_immer';
  var WURZEL = document.documentElement;

  function mq(q) { try { return !!(global.matchMedia && global.matchMedia(q).matches); } catch (e) { return false; } }

  /** Was das Gerät meldet und ob Glas überhaupt möglich ist — für die Einstellungen (und zur Fehlersuche am Handy). */
  function lage() {
    var blur = false;
    try {
      var sup = global.CSS && global.CSS.supports ? global.CSS : null;
      blur = !!(sup && (sup.supports('backdrop-filter', 'blur(1px)') || sup.supports('-webkit-backdrop-filter', 'blur(1px)')));
    } catch (e) { /* kein Blur */ }
    return {
      bewegung: mq('(prefers-reduced-motion: reduce)'),
      transparenz: mq('(prefers-reduced-transparency: reduce)'),
      kontrast: mq('(prefers-contrast: more)'),
      farben: mq('(forced-colors: active)'),
      appRuhig: WURZEL.dataset.reduced === '1',   // App-Einstellung „Animationen reduzieren"
      blur: blur
    };
  }

  var merk = null;   // null = noch nicht gesetzt; sonst der Wert aus dem Schalter dieser Sitzung
  function immer() {
    if (merk !== null) return merk;
    try { return localStorage.getItem(SCHLUESSEL) === '1'; } catch (e) { return false; }
  }

  function erlaubt() {
    var l = lage();
    if (l.farben || !l.blur) return false;
    return immer() || !(l.bewegung || l.transparenz || l.kontrast || l.appRuhig);
  }

  /** Ein Satz für die Einstellungen: was das Gerät meldet und was daraus folgt. */
  function lageText() {
    var l = lage(), g = [];
    if (l.bewegung) g.push('Bewegung reduzieren');
    if (l.transparenz) g.push('Transparenz reduzieren');
    if (l.kontrast) g.push('Mehr Kontrast');
    if (l.farben) g.push('Erzwungene Farben');
    if (!l.blur) g.push('kein Glas-Effekt möglich');
    if (l.appRuhig) g.push('„Animationen reduzieren" in dieser App');
    if (!g.length) return 'Dein Gerät meldet keine Einschränkung. Die Effekte sind an.';
    var gemeldet = 'Dein Gerät meldet: ' + g.join(', ') + '. ';
    if (l.farben || !l.blur) return gemeldet + 'Darum sind die Effekte aus, auch mit diesem Schalter.';
    return gemeldet + (immer() ? 'Der Schalter zeigt die Effekte trotzdem.' : 'Darum sind die Effekte aus.');
  }

  var schicht = null, fleck = null, flaeche = null, schluessel = '', x = 0, y = 0;
  var gedrueckt = false, rahmen = 0, bis = 0;
  var frei = false, gebunden = false;   // frei: Spotlight darf gerade leuchten

  function bauen() {
    schicht = document.createElement('div');
    schicht.id = 'glas-licht';
    schicht.setAttribute('aria-hidden', 'true');
    fleck = document.createElement('i');
    schicht.appendChild(fleck);
    document.body.appendChild(schicht);
  }

  function aus() {
    flaeche = null; schluessel = '';
    if (schicht) schicht.classList.remove('an');
  }

  function zeichnen() {
    rahmen = 0;
    if (!flaeche) return;
    if (!flaeche.isConnected) { aus(); return; }
    var r = flaeche.getBoundingClientRect();
    if (!r.width || !r.height) { aus(); return; }
    var k = [r.left, r.top, r.right, r.bottom].map(Math.round).join();
    if (k !== schluessel) {
      var rad = parseFloat(getComputedStyle(flaeche).borderTopLeftRadius) || 0;
      schicht.style.clipPath = 'inset(' + r.top + 'px ' + (global.innerWidth - r.right) + 'px ' + (global.innerHeight - r.bottom) + 'px ' + r.left + 'px round ' + rad + 'px)';
      schluessel = k;
    }
    fleck.style.transform = 'translate3d(' + (x - RADIUS) + 'px, ' + (y - RADIUS) + 'px, 0)';
    schicht.classList.add('an');
    if (performance.now() < bis) planen();
  }

  function planen() { if (!rahmen) rahmen = requestAnimationFrame(zeichnen); }

  function ziel(e) {
    var t = e.target;
    var f = t && t.closest ? t.closest(FLAECHEN) : null;
    if (!f) { aus(); return; }
    if (f !== flaeche) { flaeche = f; schluessel = ''; bis = performance.now() + NACHLAUF; }
    x = e.clientX; y = e.clientY;
    planen();
  }

  /** Neu entscheiden, ob die Effekte laufen (Start, Schalter, Systemeinstellung oder „Animationen reduzieren" geändert). */
  function bewerten() {
    try {
      frei = erlaubt();
      WURZEL.classList.toggle('glas-immer', immer());
      if (!frei) { aus(); return; }
      if (!schicht) bauen();
      if (!gebunden) binden();
    } catch (e) { /* Zierde: die App läuft auch ohne */ }
  }

  /** Der Schalter in den Einstellungen. Wirkt sofort, ohne Neuladen. */
  function immerSetzen(an) {
    merk = !!an;   // gilt auch dann bis zum Neuladen, wenn der Speicher gesperrt ist (privates Fenster)
    try { if (an) localStorage.setItem(SCHLUESSEL, '1'); else localStorage.removeItem(SCHLUESSEL); } catch (e) { /* gesperrt */ }
    bewerten();
  }

  function binden() {
    gebunden = true;
    var opt = { passive: true };
    document.addEventListener('pointerdown', function (e) { if (!frei) return; gedrueckt = true; ziel(e); }, opt);
    document.addEventListener('pointermove', function (e) { if (!frei) return; if (e.pointerType === 'touch' && !gedrueckt) return; ziel(e); }, opt);
    var ende = function (e) { gedrueckt = false; if (e.pointerType === 'touch' || e.type === 'pointercancel') aus(); };
    document.addEventListener('pointerup', ende, opt);
    document.addEventListener('pointercancel', ende, opt);
    document.documentElement.addEventListener('pointerleave', aus, opt);
    global.addEventListener('blur', aus);
    // Blätter gleiten, Listen scrollen: die Fläche unter dem Zeiger ändert sich ohne Zeigerbewegung
    global.addEventListener('scroll', function () { if (flaeche) { bis = performance.now() + 200; planen(); } }, { passive: true, capture: true });
    global.addEventListener('resize', function () { schluessel = ''; planen(); }, opt);
  }

  /** Ein paar Blasen steigen aus der unteren Leiste auf (nach dem Eintragen). Liegt die Tab-Leiste oben (ab 900 px)
   *  oder ist sie nicht da, steigen sie vom unteren Rand in der Mitte auf, wo die Meldung erscheint. */
  function blasen(anzahl) {
    try {
      if (!erlaubt()) return;
      anzahl = anzahl || 7;
      var leiste = document.querySelector('.tabs');
      var t = leiste && leiste.getBoundingClientRect();
      var r = (t && t.width && t.top > global.innerHeight / 2)
        ? { left: global.innerWidth / 2 - 60, width: 120, top: t.top, height: 30 }
        : { left: global.innerWidth / 2 - 60, width: 120, top: global.innerHeight - 80, height: 60 };
      var land = document.getElementById('glas-blasen');
      if (!land) {
        land = document.createElement('div');
        land.id = 'glas-blasen';
        land.setAttribute('aria-hidden', 'true');
        document.body.appendChild(land);
      }
      var cx = r.left + r.width / 2, cy = r.top + r.height * 0.3;
      for (var i = 0; i < anzahl; i++) {
        if (land.childElementCount >= MAX_BLASEN) break;
        var b = document.createElement('i');
        var gr = 9 + Math.random() * 15;
        var s = b.style;
        s.left = (cx - gr / 2 + (Math.random() - 0.5) * r.width * 0.6).toFixed(1) + 'px';
        s.top = (cy - gr / 2).toFixed(1) + 'px';
        s.width = s.height = gr.toFixed(1) + 'px';
        s.setProperty('--dx', ((Math.random() - 0.5) * 70).toFixed(0) + 'px');
        s.setProperty('--hoch', (110 + Math.random() * 90).toFixed(0) + 'px');
        // über eine Variable: bei „Animationen reduzieren" kürzt styles.css jede Dauer auf .01 ms, glas.css hebt das für den Schalter auf
        s.setProperty('--glas-dauer', (900 + Math.random() * 700).toFixed(0) + 'ms');
        s.animationDelay = (i * 70 + Math.random() * 60).toFixed(0) + 'ms';
        b.addEventListener('animationend', function (ev) { ev.target.remove(); }, { once: true });
        land.appendChild(b);
      }
    } catch (e) { /* Zierde */ }
  }

  function einrichten() {
    bewerten();
    // Stellt der Nutzer „Bewegung reduzieren" & Co. im Betrieb um, zieht die Seite mit
    ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)'].forEach(function (q) {
      try { var m = global.matchMedia(q); if (m.addEventListener) m.addEventListener('change', bewerten); else if (m.addListener) m.addListener(bewerten); } catch (e) { /* ältere Browser */ }
    });
  }

  global.Glas = { lage: lage, lageText: lageText, immer: immer, immerSetzen: immerSetzen, bewerten: bewerten, einrichten: einrichten, blasen: blasen };

  if (document.body) einrichten();
  else document.addEventListener('DOMContentLoaded', einrichten);
})(window);
