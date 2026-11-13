/* Hon 本 · Bücher Tracker — Fehlermeldung mit Sentry (seit v3.12).
 *
 * Zweck: Fehler, die bei echten Nutzern auftreten, kommen mit Version und Fundstelle bei uns an.
 * Nur Fehler: kein Replay, kein Tracing, keine Nutzerdaten, keine Klick-/Konsolen-/Netzspuren. Wichtig bei einer
 * Bücher-App: Titel, Notizen und Cloud-Zugangsdaten dürfen nie in einer Meldung stehen — der Eintritt
 * (js/vendor/sentry-sdk.js) kappt Adressen auf Herkunft + Pfad, löscht Nutzer, Cookies und Suchteil.
 * Das Bündel liegt selbst gehostet (npm @sentry/browser 11.11.0), zur Laufzeit werden keine Fremd-Skripte geladen.
 *
 * Muss VOR allen App-Skripten laden, sonst entgehen ihm Fehler beim Start. Die vorhandene Fehlerbehandlung der App
 * bleibt unverändert; Sentry meldet zusätzlich. Scheitert hier etwas, läuft die App unberührt weiter.
 *
 * Der Projektschlüssel (DSN) ist öffentlich: er erlaubt nur das Senden von Ereignissen, nicht das Lesen.
 */
(function () {
  'use strict';

  var DSN = 'https://86cb272c9a0915baec9bafa635054f9e@o4512403125108736.ingest.de.sentry.io/4512425172992080';

  // Die Version steht schon in der Adresse dieses Skripts (?v=3.12). Sie wird mit dem Versionssprung ohnehin
  // mitgezogen, so gibt es keine weitere Stelle, die man vergessen könnte. Release = APP_VERSION („v3.12").
  function version() {
    try {
      var s = document.currentScript && document.currentScript.src;
      var m = s && s.match(/[?&]v=([^&]+)/);
      if (m) {
        var v = decodeURIComponent(m[1]);
        return /^v/.test(v) ? v : 'v' + v;
      }
    } catch (e) { /* weiter */ }
    return 'unbekannt';
  }

  // Auf dem eigenen Rechner (vercel dev, Prüfläufe) nichts senden, sonst landet jede Probe als „Fehler" in Sentry.
  // Zum Ausprobieren: im Browser localStorage.bk_fehler_test = '1' setzen.
  function lokal() {
    var h = location.hostname;
    var lokalerHost = h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || /\.localhost$/.test(h);
    var test = false;
    try { test = localStorage.getItem('bk_fehler_test') === '1'; } catch (e) { /* gesperrt */ }
    return lokalerHost && !test;
  }

  /* Entscheidet, ob ein Fehler gemeldet wird (true) oder verworfen (false). Der Eintritt hat schon aussortiert:
     Browser-Erweiterungen, „ResizeObserver loop", „Script error", fehlendes Netz („Failed to fetch"), Abbrüche.
     event.exception.values[n].stacktrace.frames[] hat je .filename; das letzte Bild ist die Fundstelle. */
  function istMeldenswert(event) {
    var werte = event && event.exception && event.exception.values;
    var bilder = (werte && werte.length && werte[werte.length - 1].stacktrace && werte[werte.length - 1].stacktrace.frames) || [];
    if (!bilder.length) return true;              // ohne Fundstelle im Zweifel melden
    var fremd = /cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|fonts\.(googleapis|gstatic)\.com/;
    var eigene = 0, fremde = 0;
    for (var i = 0; i < bilder.length; i++) {
      var f = bilder[i].filename || '';
      if (fremd.test(f)) fremde++;
      else if (f && f !== '<anonymous>') eigene++;
    }
    // Nur verwerfen, wenn der ganze Stapel aus Fremdskripten besteht. Läuft ein Fehler über unseren Code,
    // wird er gemeldet — das könnte unser Aufruf sein.
    return !(fremde > 0 && eigene === 0);
  }

  var kopie = version();
  if (typeof window.FehlerSDK === 'undefined' || lokal()) return;

  var sdk = window.FehlerSDK;
  try {
    sdk.start({
      dsn: DSN,
      release: kopie,
      environment: 'produktion',
      beforeSend: function (event) {
        try { return istMeldenswert(event) ? event : null; } catch (e) { return event; }
      }
    });
  } catch (e) { /* Zierde: die App läuft auch ohne */ }

  // Nachweis, dass Meldungen ankommen: im Browser der laufenden App bkFehlerTest() aufrufen, dann in Sentry nachsehen.
  window.bkFehlerTest = function () {
    sdk.meldeText('Testfehler ' + kopie + ' (absichtlich, von bkFehlerTest)');
    return sdk.leeren(3000);
  };
})();
