/* Hon 本 — Update-Banner (Muster aus Japan Navigator v39)
   KEIN Auto-Reload bei Versions-Mismatch: Auto-Reload + SW-Cache können einen
   Endlos-Loop bilden (alte HTML ↔ frische version.json). Stattdessen entscheidet
   der NUTZER über einen dezenten Banner — ein Loop ist per Konstruktion unmöglich. */
(function () {
  'use strict';
  var APP_VERSION = 'v6'; // bei jedem Release zusammen mit sw.js-CACHE + version.json bumpen

  function showUpdateBanner(newV) {
    try {
      if (document.getElementById('bk-update-banner')) return;
      if (sessionStorage.getItem('bk_upd_dismissed') === String(newV)) return;
      var mk = function () {
        if (document.getElementById('bk-update-banner')) return;
        var b = document.createElement('div');
        b.id = 'bk-update-banner';
        b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(70px + env(safe-area-inset-bottom,0px));z-index:100060;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:14px;background:rgba(26,19,15,.97);border:1px solid rgba(217,119,6,.45);box-shadow:0 10px 34px rgba(0,0,0,.55);font-family:inherit;max-width:min(92vw,420px);';
        b.innerHTML = '<span style="font-size:16px;">🔄</span>'
          + '<span style="font-size:12px;color:#eee;line-height:1.35;flex:1;">Neue Version verfügbar' + (newV ? ' · ' + String(String(newV).match(/^v[\d.]+/) || newV) : '') + '</span>'
          + '<button id="bk-upd-go" style="padding:8px 12px;border-radius:9px;border:none;background:linear-gradient(135deg,#d97706,#92400e);color:#fff;font-weight:800;font-size:12px;cursor:pointer;-webkit-tap-highlight-color:transparent;">Jetzt aktualisieren</button>'
          + '<button id="bk-upd-x" aria-label="Später" style="background:none;border:none;color:#999;font-size:16px;cursor:pointer;padding:4px;line-height:1;">✕</button>';
        document.body.appendChild(b);
        document.getElementById('bk-upd-go').addEventListener('click', function () {
          var u = new URL(location.href); u.searchParams.set('_v', Date.now().toString(36));
          location.replace(u.toString());
        });
        document.getElementById('bk-upd-x').addEventListener('click', function () {
          try { sessionStorage.setItem('bk_upd_dismissed', String(newV)); } catch (e) {}
          b.remove();
        });
      };
      if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
    } catch (e) {}
  }

  function checkVersion() {
    try {
      fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (d && d.v && d.v !== APP_VERSION) showUpdateBanner(d.v);
        })
        .catch(function () {});
    } catch (e) {}
  }

  // Lokaler Check: Version geändert = Update ist BEREITS geladen → nichts erzwingen
  try {
    localStorage.setItem('bk_app_version', APP_VERSION);
  } catch (e) {}

  // Online-Check beim Start (async, blockt nichts)
  setTimeout(checkVersion, 50);

  // Tab wird wieder sichtbar → erneut prüfen (lange offene Tabs)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') checkVersion();
  });

  // Neuer SW aktiv → prüfen; SW-Update im Hintergrund anstoßen
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'SW_ACTIVATED') setTimeout(checkVersion, 500);
    });
    setTimeout(function () {
      navigator.serviceWorker.getRegistrations()
        .then(function (regs) { regs.forEach(function (r) { try { r.update(); } catch (e) {} }); })
        .catch(function () {});
    }, 1500);
  }
})();
