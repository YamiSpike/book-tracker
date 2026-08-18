/* ═══════════════════════════════════════════════════════════════════════════
   „Was ist neu" — Update-Fenster (Muster aus dem Japan Navigator, v65)

   Zeigt nach einem Update genau die Änderungen, die seit dem letzten Besuch
   dazugekommen sind, und merkt sich die gesehene Version in localStorage.

   Einbinden NACH der Stelle, an der APP_VERSION definiert ist.
   Manuell öffnen: WhatsNew.zeigen()
   ═══════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // ── Änderungen, neueste zuerst ──────────────────────────────────────────
  // { v, titel, punkte: [ [Icon, Überschrift, Erklärung], … ] }
  // v muss exakt dem Präfix von APP_VERSION entsprechen (z. B. "v39").
  var CHANGELOG = [
    { v: "v3.3", titel: "Neue Versionszählung", punkte: [
      ["🔢", "Versionsnummer neu gezählt", "Bisher stieg die ganze Zahl fast bei jeder Auslieferung — so kam v14.2 zustande. Ab jetzt zählt die Stelle hinter dem Punkt fortlaufend, die ganze Zahl steigt nur noch bei echten Umbauten. Rückwirkend auf alle 27 Auslieferungen angewendet ergibt das v3.3. Es fehlt nichts, die App ist dieselbe — nur die Nummer ist wieder handlich."]
    ]},
    { v: "v3.1", titel: "Du siehst jetzt, was sich geändert hat", punkte: [
      ["🆕", "Dieses Fenster", "Nach einem Update erscheint eine kurze Übersicht der Neuerungen."]
    ]},
    { v: "v3", titel: "Das Sammler-Paket", punkte: [
      ["📍", "Standort", "Wo im Regal ein Buch steht."],
      ["🤝", "Verleih", "Wer hat was ausgeliehen."],
      ["💶", "Ausgaben", "Was die Sammlung gekostet hat."],
      ["⏱️", "Lese-Tempo", "Wie schnell du durchkommst."],
      ["📉", "Abbruch-Analyse", "Welche Bücher liegen bleiben — und woran es liegt."]
    ]},
    { v: "v2.14", titel: "Mehr Manga-Cover", punkte: [
      ["🖼️", "Serien-basiert nachladen", "Gedrosselt, dafür findet er nahezu alle Titelbilder."]
    ]},
    { v: "v2.13", titel: "Cover mehrsprachig suchen", punkte: [
      ["🌍", "Auch fremdsprachige Ausgaben", "Findet Bilder, die unter deutschem Titel fehlen."]
    ]}
  ];

  var KEY = 'bk_seen_version';          // merkt die zuletzt gesehene Version
  var PREFIX = 'bk_';    // Speicher-Präfix dieser App

  // APP_VERSION kann `const` im globalen Script-Scope sein (dann NICHT auf
  // window) oder eine window-Eigenschaft. Beide Fälle abdecken.
  function version() {
    try {
      var v = (typeof APP_VERSION === 'string') ? APP_VERSION
            : (typeof global.APP_VERSION === 'string') ? global.APP_VERSION : null;
      if (!v) { try { v = localStorage.getItem(PREFIX + 'app_version'); } catch (e) {} }
      return v ? String(v).split('-')[0] : null;
    } catch (e) { return null; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Wurde die App auf diesem Gerät schon wirklich benutzt? Statt einer festen
  // Schlüsselliste (die bei Wrapper-Funktionen leicht veraltet) wird jeder
  // Schlüssel mit dem App-Präfix geprüft. Leere Werte und die Update-Mechanik
  // selbst zählen nicht — sonst gälte schon der allererste Start als "benutzt".
  function schonBenutzt() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(PREFIX) !== 0) continue;
        if (k === KEY || /_app_version$|_upd_|_seen_|_dismissed$/.test(k)) continue;
        var v = String(localStorage.getItem(k) || '').trim();
        if (v === '' || v === '{}' || v === '[]' || v === 'null'
            || v === '0' || v === 'false') continue;
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Alles, was NACH der zuletzt gesehenen Version dazukam.
  function seit(gesehen) {
    if (!gesehen) return [];
    for (var i = 0; i < CHANGELOG.length; i++) {
      if (CHANGELOG[i].v === gesehen) return CHANGELOG.slice(0, i);
    }
    return CHANGELOG.slice(0, 3);   // unbekannter Altstand: die letzten drei
  }

  // ── Aussehen ────────────────────────────────────────────────────────────
  var A1 = '#c9a06a', A2 = '#8a6234', BG1 = '#0e0b07', BG2 = '#1c160f', FG = '#f4ece0';

  function css() {
    return '#whatsnew{position:fixed;inset:0;z-index:100070;display:flex;'
      + 'align-items:center;justify-content:center;padding:16px;'
      + 'padding-bottom:calc(16px + env(safe-area-inset-bottom,0px));'
      + 'background:rgba(4,4,10,.86);backdrop-filter:blur(9px);'
      + '-webkit-backdrop-filter:blur(9px);animation:wn-ein .24s ease-out}'
      + '#whatsnew.zu{opacity:0;transition:opacity .2s ease-out}'
      + '@keyframes wn-ein{from{opacity:0}to{opacity:1}}'
      + '.wn-karte{position:relative;width:min(95vw,480px);max-height:86vh;max-height:86dvh;'
      + 'overflow-y:auto;-webkit-overflow-scrolling:touch;'
      + 'background:linear-gradient(165deg,' + BG2 + ',' + BG1 + ');'
      + 'border:1px solid ' + A2 + '55;border-radius:18px;padding:20px 18px 16px;'
      + 'box-shadow:0 26px 70px rgba(0,0,0,.62);'
      + 'animation:wn-karte .3s cubic-bezier(.16,1,.3,1)}'
      + '@keyframes wn-karte{from{transform:translateY(14px) scale(.97)}to{transform:none}}'
      + '.wn-zu{position:sticky;float:right;top:0;margin:-6px -4px 0 0;width:32px;height:32px;'
      + 'border-radius:50%;border:1px solid ' + A2 + '55;background:rgba(255,255,255,.06);'
      + 'color:' + FG + ';font-size:14px;cursor:pointer;display:flex;align-items:center;'
      + 'justify-content:center;line-height:1;transition:background .18s ease-out,transform .12s ease-out;'
      + 'touch-action:manipulation;-webkit-tap-highlight-color:transparent}'
      + '.wn-zu:hover{background:rgba(255,255,255,.13)}.wn-zu:active{transform:scale(.92)}'
      + '.wn-kopf{display:flex;align-items:center;gap:12px;margin:0 34px 15px 0}'
      + '.wn-sig{width:44px;height:44px;flex-shrink:0;border-radius:12px;'
      + 'background:linear-gradient(140deg,' + A1 + ',' + A2 + ');color:#fff;font-size:21px;'
      + 'font-weight:700;display:flex;align-items:center;justify-content:center;'
      + 'box-shadow:0 4px 14px ' + A2 + '55}'
      + '.wn-titel{font-size:17px;font-weight:800;color:' + FG + ';letter-spacing:-.01em}'
      + '.wn-sub{font-size:11px;opacity:.62;color:' + FG + ';margin-top:2px;line-height:1.4}'
      + '.wn-block{margin:0 0 14px}'
      + '.wn-vers{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:700;'
      + 'color:' + FG + ';margin:0 0 9px;line-height:1.4}'
      + '.wn-vers span{flex-shrink:0;font-size:10px;font-weight:800;letter-spacing:.04em;'
      + 'background:' + A2 + '30;color:' + A1 + ';border:1px solid ' + A2 + '66;'
      + 'border-radius:999px;padding:3px 9px}'
      + '.wn-punkt{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;margin:0 0 5px;'
      + 'background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.075);border-radius:10px}'
      + '.wn-icon{font-size:17px;line-height:1.25;flex-shrink:0;width:22px;text-align:center}'
      + '.wn-name{font-size:12.5px;font-weight:700;color:' + FG + ';line-height:1.35}'
      + '.wn-text{font-size:11px;opacity:.66;color:' + FG + ';line-height:1.5;margin-top:2px}'
      + '.wn-fuss{display:flex;gap:8px;flex-wrap:wrap;position:sticky;bottom:-16px;'
      + 'margin:16px -18px -16px;padding:13px 18px 16px;'
      + 'background:linear-gradient(to bottom,' + BG2 + '00,' + BG2 + ' 22%)}'
      + '@media(max-width:420px){.wn-fuss{margin:14px -14px -14px;padding:12px 14px 14px}}'
      + '.wn-btn{flex:1;min-width:140px;padding:12px;border-radius:11px;font-size:13px;'
      + 'font-weight:700;cursor:pointer;border:1px solid ' + A2 + '66;'
      + 'background:linear-gradient(135deg,' + A1 + ',' + A2 + ');color:#fff;'
      + 'transition:transform .12s ease-out,filter .18s ease-out;'
      + 'touch-action:manipulation;-webkit-tap-highlight-color:transparent}'
      + '.wn-btn:hover{filter:brightness(1.1)}.wn-btn:active{transform:scale(.97)}';
  }

  function stilEinmalig() {
    if (document.getElementById('wn-stil')) return;
    var s = document.createElement('style');
    s.id = 'wn-stil'; s.textContent = css();
    document.head.appendChild(s);
  }

  // ── Fenster ─────────────────────────────────────────────────────────────
  var escHandler = null;

  function zeigen(eintraege, manuell) {
    if (document.getElementById('whatsnew')) return;
    var liste = (eintraege && eintraege.length) ? eintraege : CHANGELOG.slice(0, 2);
    stilEinmalig();

    var ov = document.createElement('div');
    ov.id = 'whatsnew';
    ov.innerHTML =
      '<div class="wn-karte" role="dialog" aria-modal="true" aria-label="Was ist neu">'
      + '<button class="wn-zu" type="button" aria-label="Schließen">✕</button>'
      + '<div class="wn-kopf"><div class="wn-sig">本</div><div>'
      + '<div class="wn-titel">Was ist neu</div>'
      + '<div class="wn-sub">' + (manuell ? 'Die letzten Änderungen' : 'Die App wurde aktualisiert')
      + ' · Version ' + esc(version() || '') + '</div></div></div>'
      + liste.map(function (e) {
          return '<div class="wn-block"><div class="wn-vers"><span>' + esc(e.v) + '</span>'
            + esc(e.titel) + '</div>'
            + e.punkte.map(function (p) {
                return '<div class="wn-punkt"><div class="wn-icon">' + esc(p[0]) + '</div><div>'
                  + '<div class="wn-name">' + esc(p[1]) + '</div>'
                  + '<div class="wn-text">' + esc(p[2]) + '</div></div></div>';
              }).join('')
            + '</div>';
        }).join('')
      + '<div class="wn-fuss"><button class="wn-btn" type="button">Alles klar</button></div>'
      + '</div>';

    document.body.appendChild(ov);
    ov.querySelector('.wn-zu').addEventListener('click', schliessen);
    ov.querySelector('.wn-btn').addEventListener('click', schliessen);
    ov.addEventListener('click', function (e) { if (e.target === ov) schliessen(); });
    escHandler = function (e) { if (e.key === 'Escape') schliessen(); };
    document.addEventListener('keydown', escHandler);
    try { ov.querySelector('.wn-btn').focus(); } catch (e) {}
  }

  function schliessen() {
    var ov = document.getElementById('whatsnew');
    if (!ov) return;
    var v = version();
    if (v) { try { localStorage.setItem(KEY, v); } catch (e) {} }
    if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
    ov.classList.add('zu');
    setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 230);
  }

  // ── Start ───────────────────────────────────────────────────────────────
  function pruefen() {
    var jetzt = version();
    if (!jetzt) return;
    var gesehen = null;
    try { gesehen = localStorage.getItem(KEY); } catch (e) {}

    if (!gesehen) {
      // Kein Merker — zwei sehr verschiedene Fälle:
      // (a) frische Installation → still merken, nichts zeigen
      // (b) App war längst in Benutzung, kannte den Merker aber noch nicht
      //     (dieses Fenster kam erst jetzt dazu) → hier MUSS es erscheinen
      if (schonBenutzt()) {
        setTimeout(function () { zeigen(CHANGELOG.slice(0, 2), false); }, 1400);
        return;
      }
      try { localStorage.setItem(KEY, jetzt); } catch (e) {}
      return;
    }
    if (gesehen === jetzt) return;

    var neu = seit(gesehen);
    if (!neu.length) { try { localStorage.setItem(KEY, jetzt); } catch (e) {} return; }
    setTimeout(function () { zeigen(neu, false); }, 1400);
  }

  global.WhatsNew = {
    zeigen: function () { zeigen(CHANGELOG.slice(0, 2), true); },
    pruefen: pruefen,
    changelog: CHANGELOG
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', pruefen);
  } else { pruefen(); }
})(window);
