/* v1.4: Erfolge / Abzeichen
   Ausgelagert aus js/app.js. Der Rumpf ist unveraendert uebernommen.

   Bindung an den Kern laeuft ueber window.HonIntern (H). js/app.js startet
   erst bei DOMContentLoaded — also NACH allen Skripten —, deshalb ist die
   Ladereihenfolge unkritisch, solange diese Datei nach app.js steht.
   Funktionen werden ueber Weiterleitungen geholt (spaete Bindung, damit auch
   Verweise auf ANDERE Teilmodule funktionieren), Konstanten direkt kopiert. */
(function (H) {
  'use strict';

  // Konstanten aus dem Kern
  var LS_ACH = H.LS_ACH;

  // Funktionen aus dem Kern bzw. aus Nachbarmodulen (spaete Bindung)
  function lib() { return H.lib.apply(null, arguments); }
  function loadSessions() { return H.loadSessions.apply(null, arguments); }
  function loadSettings() { return H.loadSettings.apply(null, arguments); }
  function readDatesOf() { return H.readDatesOf.apply(null, arguments); }
  function seriesOf() { return H.seriesOf.apply(null, arguments); }
  function toast() { return H.toast.apply(null, arguments); }

  // ───── v1.4: Erfolge / Abzeichen ─────
  var ACH_DEFS = [
    { id: 'b1', icon: '📕', name: 'Erstes Buch', desc: 'Dein erstes Buch gelesen' },
    { id: 'b10', icon: '📗', name: 'Bücherwurm', desc: '10 Bücher gelesen' },
    { id: 'b25', icon: '📘', name: 'Leseratte', desc: '25 Bücher gelesen' },
    { id: 'b50', icon: '📚', name: 'Bibliothekar·in', desc: '50 Bücher gelesen' },
    { id: 'p1k', icon: '📄', name: 'Seitenzähler', desc: '1.000 Seiten gelesen' },
    { id: 'p5k', icon: '🗞️', name: 'Vielleser·in', desc: '5.000 Seiten gelesen' },
    { id: 'p10k', icon: '📜', name: 'Seiten-Marathon', desc: '10.000 Seiten gelesen' },
    { id: 'g5', icon: '🎭', name: 'Genre-Entdecker·in', desc: '5 verschiedene Genres' },
    { id: 'serie', icon: '🏅', name: 'Serien-Meister·in', desc: 'Eine Reihe (ab 3 Bänden) lückenlos' },
    { id: 'q10', icon: '✍️', name: 'Zitate-Sammler·in', desc: '10 Zitate gespeichert' },
    { id: 'streak7', icon: '🔥', name: '7-Tage-Streak', desc: '7 Tage in Folge Lese-Aktivität' },
    { id: 'goal', icon: '🎯', name: 'Challenge geschafft', desc: 'Jahres-Leseziel erreicht' }
  ];
  function achStats() {
    var books = lib();
    var read = books.filter(function (b) { return b.status === 'read'; });
    var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var genres = {};
    read.forEach(function (b) { (b.categories || []).forEach(function (c) { genres[c.split('/')[0].trim()] = 1; }); });
    var quotes = books.reduce(function (s, b) { return s + (b.quotes || []).length; }, 0);
    // lückenlose Reihe ab 3 Bänden?
    var groups = {};
    books.forEach(function (b) {
      var s = seriesOf(b); if (!s) return;
      var k = s.name.toLowerCase();
      (groups[k] = groups[k] || []).push(s.num);
    });
    var fullSeries = Object.keys(groups).some(function (k) {
      var nums = groups[k]; var max = Math.max.apply(null, nums);
      if (max < 3) return false;
      for (var n = 1; n <= max; n++) if (nums.indexOf(n) < 0) return false;
      return true;
    });
    // Streak: aufeinanderfolgende Tage mit Aktivität (Session, Lese-Abschluss oder Hinzufügen)
    var daySet = {};
    loadSessions().forEach(function (s) { daySet[new Date(s.start).toDateString()] = 1; });
    books.forEach(function (b) {
      if (b.addedAt) daySet[new Date(b.addedAt).toDateString()] = 1;
      readDatesOf(b).forEach(function (ts) { daySet[new Date(ts).toDateString()] = 1; });
    });
    var streak = 0, d = new Date();
    if (!daySet[d.toDateString()]) d = new Date(d.getTime() - 86400000); // gestern zählt als Start
    while (daySet[d.toDateString()]) { streak++; d = new Date(d.getTime() - 86400000); }
    var goal = parseInt(loadSettings().goal, 10) || 0;
    var yr = new Date().getFullYear(), done = 0;
    read.forEach(function (b) { readDatesOf(b).forEach(function (ts) { if (new Date(ts).getFullYear() === yr) done++; }); });
    return { readCount: read.length, pages: pages, genres: Object.keys(genres).length, quotes: quotes, fullSeries: fullSeries, streak: streak, goalDone: goal > 0 && done >= goal };
  }
  function achCheck(id, s) {
    switch (id) {
      case 'b1': return s.readCount >= 1;   case 'b10': return s.readCount >= 10;
      case 'b25': return s.readCount >= 25; case 'b50': return s.readCount >= 50;
      case 'p1k': return s.pages >= 1000;   case 'p5k': return s.pages >= 5000;
      case 'p10k': return s.pages >= 10000; case 'g5': return s.genres >= 5;
      case 'serie': return s.fullSeries;    case 'q10': return s.quotes >= 10;
      case 'streak7': return s.streak >= 7; case 'goal': return s.goalDone;
      default: return false;
    }
  }
  function loadAch() { try { return JSON.parse(localStorage.getItem(LS_ACH) || '{}') || {}; } catch (e) { return {}; } }
  function checkAchievements() {
    var unlocked = loadAch(), s = achStats(), fresh = [];
    ACH_DEFS.forEach(function (d) {
      if (!unlocked[d.id] && achCheck(d.id, s)) { unlocked[d.id] = Date.now(); fresh.push(d); }
    });
    if (fresh.length) {
      try { localStorage.setItem(LS_ACH, JSON.stringify(unlocked)); } catch (e) {}
      toast('🏆 Abzeichen freigeschaltet: ' + fresh.map(function (d) { return d.icon + ' ' + d.name; }).join(' · '));
    }
    return unlocked;
  }

  // ── nach aussen geben ──
  H.ACH_DEFS = ACH_DEFS;
  H.achStats = achStats;
  H.achCheck = achCheck;
  H.loadAch = loadAch;
  H.checkAchievements = checkAchievements;
})(window.HonIntern = window.HonIntern || {});
