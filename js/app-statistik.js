/* Statistik, Besitz, Lese-Tempo, Tsundoku
   Ausgelagert aus js/app.js. Der Rumpf ist unveraendert uebernommen.

   Bindung an den Kern laeuft ueber window.HonIntern (H). js/app.js startet
   erst bei DOMContentLoaded — also NACH allen Skripten —, deshalb ist die
   Ladereihenfolge unkritisch, solange diese Datei nach app.js steht.
   Funktionen werden ueber Weiterleitungen geholt (spaete Bindung, damit auch
   Verweise auf ANDERE Teilmodule funktionieren), Konstanten direkt kopiert. */
(function (H) {
  'use strict';

  // Konstanten aus dem Kern
  var FORMAT_LBL = H.FORMAT_LBL;

  // Funktionen aus dem Kern bzw. aus Nachbarmodulen (spaete Bindung)
  function $() { return H.$.apply(null, arguments); }
  function achStats() { return H.achStats.apply(null, arguments); }
  function bookIndex() { return H.bookIndex.apply(null, arguments); }
  function esc() { return H.esc.apply(null, arguments); }
  function fmtDate() { return H.fmtDate.apply(null, arguments); }
  function lib() { return H.lib.apply(null, arguments); }
  function loadAch() { return H.loadAch.apply(null, arguments); }
  function loadSessions() { return H.loadSessions.apply(null, arguments); }
  function openYearDuel() { return H.openYearDuel.apply(null, arguments); }
  function openYearReview() { return H.openYearReview.apply(null, arguments); }
  function readDatesOf() { return H.readDatesOf.apply(null, arguments); }
  function seriesOf() { return H.seriesOf.apply(null, arguments); }
  function toast() { return H.toast.apply(null, arguments); }

  // ───── Statistik ─────
  function renderStats() {
    var books = lib();
    var read = books.filter(function (b) { return b.status === 'read'; });
    var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var rated = books.filter(function (b) { return b.rating > 0; });
    var avg = rated.length ? (rated.reduce(function (s, b) { return s + b.rating; }, 0) / rated.length).toFixed(1) : '–';

    // v1.4: Lesezeit (Timer-Sessions) + geschätzter Bibliotheks-Wert + Streak
    var mins = loadSessions().reduce(function (s, x) { return s + (x.minutes || 0); }, 0);
    var aStats = achStats();
    // v3: Bibliotheks-Wert aus ECHTEN Preisen, wo erfasst — der Rest wird geschätzt.
    // Der Schätzwert richtet sich nach dem eigenen Ø-Preis (Manga ≠ Hardcover), sonst 12 €.
    var priced = books.filter(function (b) { return b.price > 0; });
    var realSum = priced.reduce(function (s, b) { return s + b.price; }, 0);
    var estUnit = priced.length >= 3 ? (realSum / priced.length) : 12;
    var worth = Math.round(realSum + (books.length - priced.length) * estUnit);
    var worthLbl = priced.length ? (priced.length === books.length ? 'Bibliotheks-Wert' : 'Wert (' + priced.length + ' echt)') : 'Bibliotheks-Wert';
    $('statsGrid').innerHTML =
      '<div class="stat-card"><b>' + read.length + '</b><span>Bücher gelesen</span></div>'
      + '<div class="stat-card"><b>' + pages.toLocaleString('de-DE') + '</b><span>Seiten gelesen</span></div>'
      + '<div class="stat-card"><b>' + books.filter(function (b) { return b.status === 'reading'; }).length + '</b><span>Lese gerade</span></div>'
      + '<div class="stat-card"><b>' + books.filter(function (b) { return b.status === 'want'; }).length + '</b><span>Will lesen</span></div>'
      + '<div class="stat-card"><b>' + avg + '</b><span>Ø Bewertung</span></div>'
      + (mins ? '<div class="stat-card"><b>' + (mins >= 120 ? Math.round(mins / 60) + ' h' : mins + ' min') + '</b><span>Lesezeit (Timer)</span></div>' : '')
      + (aStats.streak > 1 ? '<div class="stat-card"><b>' + aStats.streak + ' 🔥</b><span>Tage-Streak</span></div>' : '')
      + '<div class="stat-card"><b>' + (priced.length === books.length ? '' : '~') + worth.toLocaleString('de-DE') + ' €</b><span>' + worthLbl + '</span></div>';

    function barBlock(title, counts) {
      var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 7);
      if (!keys.length) return '';
      var max = counts[keys[0]] || 1;
      // Ohne Titel keine leere Überschrift rendern (v3: Balken unter einer eigenen h2)
      return (title ? '<h2 style="font-size:16px;margin-top:22px">' + title + '</h2>' : '') + '<div class="bar-list">'
        + keys.map(function (k) {
          return '<div class="bar-row"><span class="lbl">' + esc(k) + '</span><span class="bar"><i style="width:' + Math.round(counts[k] / max * 100) + '%"></i></span><span class="val">' + counts[k] + '</span></div>';
        }).join('') + '</div>';
    }
    var gen = {}, aut = {}, yrs = {}, pub = {}, mon = {};
    var MONTHS_DE = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    books.forEach(function (b) {
      (b.categories || []).forEach(function (c) { var g = c.split('/')[0].trim(); if (g) gen[g] = (gen[g] || 0) + 1; });
      (b.authors || []).forEach(function (a) { aut[a] = (aut[a] || 0) + 1; });
      var y = new Date(b.addedAt || Date.now()).getFullYear(); yrs[y] = (yrs[y] || 0) + 1;
      if (b.publisher) pub[b.publisher] = (pub[b.publisher] || 0) + 1;
      // gelesen pro Monat (letzte 12 Monate)
      readDatesOf(b).forEach(function (ts) {
        var dt = new Date(ts);
        var diff = (new Date().getFullYear() - dt.getFullYear()) * 12 + (new Date().getMonth() - dt.getMonth());
        if (diff >= 0 && diff < 12) { var lbl = MONTHS_DE[dt.getMonth()] + ' ' + String(dt.getFullYear()).slice(2); mon[lbl] = (mon[lbl] || 0) + 1; }
      });
    });
    // Lese-Heatmap: letzte 26 Wochen (hinzugefügt = 1 Punkt, beendet = 2 Punkte)
    function heatmapHtml() {
      var days = Object.create(null);
      books.forEach(function (b) {
        if (b.addedAt) { var d1 = new Date(b.addedAt).toISOString().slice(0, 10); days[d1] = (days[d1] || 0) + 1; }
        readDatesOf(b).forEach(function (ts) { var d2 = new Date(ts).toISOString().slice(0, 10); days[d2] = (days[d2] || 0) + 2; });
      });
      // Timer-Sessions zählen mit: je angefangene 30 Minuten ein Punkt
      loadSessions().forEach(function (s) {
        var dk = new Date(s.start).toISOString().slice(0, 10);
        days[dk] = (days[dk] || 0) + Math.max(1, Math.ceil((s.minutes || 0) / 30));
      });
      var today = new Date(); today.setHours(12, 0, 0, 0);
      var start = new Date(today.getTime() - (26 * 7 - 1) * 86400000);
      // auf Montag zurückdrehen
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
      var cells = '', d = new Date(start), mons = [];
      while (d <= today) {
        var key = d.toISOString().slice(0, 10);
        var n = days[key] || 0;
        var lvl = n === 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : 3;
        cells += '<i class="hm-' + lvl + '" title="' + fmtDate(d.getTime()) + (n ? ' · Aktivität: ' + n : '') + '"></i>';
        d = new Date(d.getTime() + 86400000);
      }
      return '<h2 style="font-size:16px;margin-top:22px">🔥 Lese-Aktivität (26 Wochen)</h2>'
        + '<div class="heatmap-wrap"><div class="heatmap">' + cells + '</div>'
        + '<div class="hm-legend"><span>wenig</span><i class="hm-0"></i><i class="hm-1"></i><i class="hm-2"></i><i class="hm-3"></i><span>viel</span></div></div>';
    }

    // Buchreihen: gruppieren + fehlende Bände zeigen
    function seriesHtml() {
      var groups = Object.create(null);
      books.forEach(function (b) {
        var s = seriesOf(b);
        if (!s) return;
        var k = s.name.toLowerCase();
        if (!groups[k]) groups[k] = { name: s.name, nums: [] };
        if (groups[k].nums.indexOf(s.num) < 0) groups[k].nums.push(s.num);
      });
      var keys = Object.keys(groups).filter(function (k) { return groups[k].nums.length >= 2; });
      if (!keys.length) return '';
      var rows = keys.sort().map(function (k) {
        var g = groups[k]; g.nums.sort(function (a, b) { return a - b; });
        var max = g.nums[g.nums.length - 1], missing = [];
        for (var n = 1; n <= max; n++) if (g.nums.indexOf(n) < 0) missing.push(n);
        return '<div class="series-row"><strong>📚 ' + esc(g.name) + '</strong>'
          + '<span class="muted">Bände: ' + g.nums.join(', ') + '</span>'
          + (missing.length ? '<span class="series-missing">Fehlt: Band ' + missing.join(', ') + '</span>' : '<span class="series-full">✓ lückenlos</span>')
          + '</div>';
      }).join('');
      return '<h2 style="font-size:16px;margin-top:22px">📚 Deine Buchreihen</h2>' + rows;
    }

    // v1.4: Erfolge-Galerie
    function achHtml() {
      var unlocked = loadAch();
      var cells = H.ACH_DEFS.map(function (d) {
        var on = !!unlocked[d.id];
        return '<div class="ach' + (on ? ' on' : '') + '" title="' + esc(d.desc) + '">'
          + '<span class="ach-ico">' + (on ? d.icon : '🔒') + '</span>'
          + '<span class="ach-name">' + esc(d.name) + '</span>'
          + (on ? '<span class="ach-date">' + fmtDate(unlocked[d.id]) + '</span>' : '<span class="ach-date">' + esc(d.desc) + '</span>')
          + '</div>';
      }).join('');
      return '<h2 style="font-size:16px;margin-top:22px">🏆 Erfolge</h2><div class="ach-grid">' + cells + '</div>';
    }

    // ── v3-D: Lese-Tempo aus den Timer-Sessions ──
    function paceHtml() {
      var p = paceStats();
      if (!p.sessions) return '';
      var rows = '';
      function line(lbl, o) {
        var v = p.pphOf(o);
        if (!v) return '';
        return '<div class="bar-row"><span class="lbl">' + esc(lbl) + '</span>'
          + '<span class="bar"><i style="width:' + Math.min(100, Math.round(v / 2)) + '%"></i></span>'
          + '<span class="val">' + Math.round(v) + '</span></div>';
      }
      rows += line('📕 Print', p.byFormat.print) + line('📱 E-Book', p.byFormat.ebook) + line('🎧 Hörbuch', p.byFormat.audio);
      rows += line('🎌 Manga', p.byKind.manga) + line('📚 Bücher', p.byKind.buch) + line('📰 Zeitschriften', p.byKind.magazin);

      // Wann liest du? — Stunden-Histogramm aus den Session-Startzeiten
      var maxH = Math.max.apply(null, p.hours) || 1;
      var bestH = p.hours.indexOf(maxH);
      var bars = p.hours.map(function (n, h) {
        return '<i class="ph-bar' + (n === maxH && n > 0 ? ' peak' : '') + '" style="height:' + Math.max(3, Math.round(n / maxH * 100)) + '%"'
          + ' title="' + h + ':00 Uhr · ' + n + ' Sitzungen"></i>';
      }).join('');

      return '<h2 style="font-size:16px;margin-top:22px">⏱️ Dein Lese-Tempo</h2>'
        + '<div class="stats-grid">'
        + (p.pagesPerHour ? '<div class="stat-card"><b>' + Math.round(p.pagesPerHour) + '</b><span>Seiten / Stunde</span></div>' : '')
        + '<div class="stat-card"><b>' + p.sessions + '</b><span>Lese-Sitzungen</span></div>'
        + '<div class="stat-card"><b>' + p.avgSession + ' min</b><span>Ø Sitzung</span></div>'
        + '<div class="stat-card"><b>' + (p.longest >= 60 ? Math.round(p.longest / 60 * 10) / 10 + ' h' : p.longest + ' min') + '</b><span>Längste Sitzung</span></div>'
        + '</div>'
        + (rows ? '<p class="section-sub" style="margin-top:14px">Seiten pro Stunde je Format &amp; Typ</p><div class="bar-list">' + rows + '</div>' : '')
        + '<p class="section-sub" style="margin-top:14px">🕐 Wann du liest' + (maxH > 0 ? ' — am liebsten gegen <b>' + bestH + ' Uhr</b>' : '') + '</p>'
        + '<div class="pace-hours">' + bars + '</div>'
        + '<div class="pace-hours-lbl"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>';
    }

    // ── v3-B: Ausgaben (echte Preise statt Schätzung) ──
    function moneyHtml() {
      var withPrice = books.filter(function (b) { return b.price > 0; });
      if (!withPrice.length) {
        return '<h2 style="font-size:16px;margin-top:22px">💰 Ausgaben</h2>'
          + '<p class="muted" style="font-size:13px">Noch keine Preise erfasst. Tipp: In der Sammlung auf <b>☑️ Auswählen</b> tippen, eine ganze Reihe markieren und mit <b>💰 Preis</b> den Bandpreis für alle auf einmal setzen.</p>';
      }
      var sum = withPrice.reduce(function (s, b) { return s + b.price; }, 0);
      var avg = sum / withPrice.length;
      // pro Jahr (nach Kaufdatum, sonst Hinzufüge-Datum)
      var perYear = {}, perSeries = {};
      withPrice.forEach(function (b) {
        var t = b.boughtAt || b.addedAt;
        if (t) perYear[new Date(t).getFullYear()] = (perYear[new Date(t).getFullYear()] || 0) + b.price;
        var s = seriesOf(b);
        var nm = s ? s.name : b.title;
        perSeries[nm] = (perSeries[nm] || 0) + b.price;
      });
      var topSeries = Object.keys(perSeries).sort(function (a, b) { return perSeries[b] - perSeries[a]; })[0];
      // Kosten pro Lesestunde — überraschend aussagekräftig
      var totalMin = loadSessions().reduce(function (s, x) { return s + (x.minutes || 0); }, 0);
      var perHour = totalMin >= 60 ? sum / (totalMin / 60) : 0;
      var yearRows = {};
      Object.keys(perYear).forEach(function (y) { yearRows[y] = Math.round(perYear[y]); });
      return '<h2 style="font-size:16px;margin-top:22px">💰 Ausgaben</h2>'
        + '<div class="stats-grid">'
        + '<div class="stat-card"><b>' + money(sum) + '</b><span>Erfasst gesamt</span></div>'
        + '<div class="stat-card"><b>' + money(avg) + '</b><span>Ø pro Band</span></div>'
        + '<div class="stat-card"><b>' + withPrice.length + ' / ' + books.length + '</b><span>Titel mit Preis</span></div>'
        + (perHour ? '<div class="stat-card"><b>' + money(perHour) + '</b><span>pro Lesestunde</span></div>' : '')
        + (topSeries ? '<div class="stat-card"><b>' + money(perSeries[topSeries]) + '</b><span>Teuerste Reihe: ' + esc(topSeries.slice(0, 22)) + '</span></div>' : '')
        + '</div>'
        + barBlock('🗓️ Ausgaben pro Jahr (€)', yearRows);
    }

    // ── v3-A: Regal-Plan — wo steht was, was ist verliehen ──
    function locHtml() {
      var locs = {}, lent = [];
      books.forEach(function (b) {
        if (b.loc) locs[b.loc] = (locs[b.loc] || 0) + 1;
        if (b.lentTo) lent.push(b);
      });
      if (!Object.keys(locs).length && !lent.length) {
        return '<h2 style="font-size:16px;margin-top:22px">📍 Standorte</h2>'
          + '<p class="muted" style="font-size:13px">Noch keine Standorte vergeben. Tipp: Reihe in der Sammlung auswählen → <b>📍 Standort</b> — danach findest du jeden Band über den Standort-Filter wieder.</p>';
      }
      var lentRows = lent.sort(function (a, b) { return (a.lentAt || 0) - (b.lentAt || 0); }).map(function (b) {
        var days = b.lentAt ? Math.floor((Date.now() - b.lentAt) / 86400000) : 0;
        return '<div class="series-row"><strong>🤝 ' + esc(b.title.slice(0, 44)) + '</strong>'
          + '<span class="muted">bei ' + esc(b.lentTo) + (b.lentAt ? ' seit ' + fmtDate(b.lentAt) : '') + '</span>'
          + (days > 90 ? '<span class="series-missing">seit ' + days + ' Tagen!</span>' : (days ? '<span class="series-full">' + days + ' Tage</span>' : ''))
          + '</div>';
      }).join('');
      return '<h2 style="font-size:16px;margin-top:22px">📍 Standorte</h2>'
        + (Object.keys(locs).length ? barBlock('', locs) : '')
        + (lent.length ? '<p class="section-sub" style="margin-top:12px">🤝 Verliehen (' + lent.length + ')</p>' + lentRows : '');
    }

    // ── v3-E: DNF-Auswertung — halbfertiges Feature endlich ausgewertet ──
    function dnfStatsHtml() {
      var dnf = books.filter(function (b) { return b.status === 'dnf'; });
      var finished = books.filter(function (b) { return b.status === 'read'; }).length;
      if (!dnf.length) return '';
      var quote = (finished + dnf.length) ? Math.round(dnf.length / (finished + dnf.length) * 100) : 0;
      var pagesArr = dnf.filter(function (b) { return b.dnfPage > 0; }).map(function (b) { return b.dnfPage; });
      var avgPage = pagesArr.length ? Math.round(pagesArr.reduce(function (a, c) { return a + c; }, 0) / pagesArr.length) : 0;
      var reasons = {};
      dnf.forEach(function (b) { (b.dnfTags || []).forEach(function (t) { reasons[t] = (reasons[t] || 0) + 1; }); });
      return '<h2 style="font-size:16px;margin-top:22px">🚫 Abgebrochene Bücher</h2>'
        + '<div class="stats-grid">'
        + '<div class="stat-card"><b>' + dnf.length + '</b><span>Abgebrochen</span></div>'
        + '<div class="stat-card"><b>' + quote + '%</b><span>Abbruch-Quote</span></div>'
        + (avgPage ? '<div class="stat-card"><b>S. ' + avgPage + '</b><span>Ø Abbruch-Seite</span></div>' : '')
        + '</div>'
        + (Object.keys(reasons).length ? barBlock('Häufigste Gründe', reasons)
            : '<p class="muted" style="font-size:13px;margin-top:8px">Tipp: Grund im Detail eines abgebrochenen Buchs antippen — dann siehst du hier dein Muster.</p>');
    }

    $('statsBars').innerHTML = books.length
      ? '<div style="margin-top:14px"><button class="btn-primary" id="yearReviewBtn">📚 Dein Lesejahr ' + new Date().getFullYear() + '</button>'
          + '<button class="btn-ghost" id="yearDuelBtn" style="margin-left:8px">📈 Jahre vergleichen</button></div>'
        + heatmapHtml() + paceHtml() + moneyHtml() + locHtml() + dnfStatsHtml()
        + achHtml() + seriesHtml() + barBlock('📖 Gelesen pro Monat', mon) + barBlock('📚 Top-Genres', gen) + barBlock('✍️ Top-Autor·innen', aut) + barBlock('🏢 Top-Verlage', pub) + barBlock('🗓️ Hinzugefügt pro Jahr', yrs)
      : '<div class="empty"><div class="big">📊</div><p>Noch keine Daten — füge zuerst Bücher hinzu.</p></div>';
    var yb = document.getElementById('yearReviewBtn');
    if (yb) yb.addEventListener('click', openYearReview);
    var ydb = document.getElementById('yearDuelBtn');
    if (ydb) ydb.addEventListener('click', openYearDuel);
  }

  // v1.6: Fertig-Prognose für „Lese gerade" — aus Timer-Tempo oder Seiten/Tag seit Start
  function forecastHtml(own) {
    if (!own || own.status !== 'reading' || !(own.pages > 0)) return '';
    var page = own.progress || 0;
    var left = own.pages - page;
    if (left <= 0) return '';
    // 1) Genauestes Signal: Timer-Sessions für dieses Buch → Minuten pro Seite
    var mins = loadSessions().filter(function (s) { return s.bookId === own.id; })
      .reduce(function (a, s) { return a + (s.minutes || 0); }, 0);
    if (mins >= 5 && page >= 3) {
      var perPage = mins / page;               // Minuten pro Seite
      var restMin = Math.round(perPage * left);
      var txt = restMin >= 90 ? (Math.round(restMin / 60 * 10) / 10 + ' Std') : (restMin + ' Min');
      return '<div class="forecast">🎯 Bei deinem Tempo noch etwa <b>' + txt + '</b> Lesezeit (' + left + ' Seiten)</div>';
    }
    // 2) Fallback: Seiten pro Tag seit Startdatum → voraussichtliches Enddatum
    if (own.startedAt && page >= 5) {
      var days = Math.max(1, (Date.now() - own.startedAt) / 86400000);
      var perDay = page / days;
      if (perDay >= 0.5) {
        var restDays = Math.ceil(left / perDay);
        var done = new Date(Date.now() + restDays * 86400000);
        return '<div class="forecast">🎯 Bei ~' + Math.round(perDay) + ' Seiten/Tag fertig um den <b>' + fmtDate(done.getTime()) + '</b> (' + left + ' Seiten)</div>';
      }
    }
    return '';
  }

  function formatRowHtml(own) {
    if (!own) return '';
    return '<div class="format-row"><span class="format-lbl">Format:</span>'
      + ['print', 'ebook', 'audio'].map(function (f) {
        return '<button class="format-btn' + (own.format === f ? ' active' : '') + '" data-format="' + f + '">' + FORMAT_LBL[f] + '</button>';
      }).join('') + '</div>';
  }

  // Shop-Suchlinks (Amazon/Thalia haben keine öffentliche API — Suche per ISBN/Titel im Shop)
  function shopLinksHtml(b) {
    var q = b.isbn || (b.title + ' ' + (b.authors[0] || ''));
    var enc = encodeURIComponent(q.trim());
    return '<div class="shop-row">'
      + '<span class="shop-lbl">Kaufen / ansehen:</span>'
      + '<a class="shop-link amazon" href="https://www.amazon.de/s?k=' + enc + '&i=stripbooks" target="_blank" rel="noopener noreferrer">🛒 Amazon</a>'
      + '<a class="shop-link thalia" href="https://www.thalia.de/suche?sq=' + enc + '" target="_blank" rel="noopener noreferrer">📖 Thalia</a>'
      + (b.isbn ? '<span class="shop-isbn">ISBN ' + esc(b.isbn) + '</span>' : '')
      + '</div>';
  }

  // Zitate-Bereich im Detail
  function quotesHtml(own) {
    var qs = own.quotes || [];
    return '<div class="quotes-block">'
      + '<div class="quotes-head">✍️ Zitate <span class="muted">(' + qs.length + ')</span></div>'
      + qs.map(function (q, i) {
        return '<div class="quote-item"><span class="quote-mark">„</span><span class="quote-text">' + esc(q.text) + '"</span>'
          + '<button class="quote-img" data-qimg="' + i + '" aria-label="Als Bild teilen" title="Als Bild speichern">🖼️</button>'
          + '<button class="quote-del" data-qi="' + i + '" aria-label="Zitat löschen">🗑</button></div>';
      }).join('')
      + '<div class="quote-add"><textarea id="quoteInput" placeholder="Lieblingszitat aus dem Buch…" rows="2"></textarea>'
      + '<button class="btn-ghost" id="quoteAddBtn">+ Zitat speichern</button></div>'
      + '</div>';
  }

  // v1.7: Lesetagebuch — datierte Fortschritts-/Gedanken-Einträge pro Buch
  function journalHtml(own) {
    var js = (own.journal || []).slice().sort(function (a, b) { return b.date - a.date; });
    return '<div class="journal-block">'
      + '<div class="quotes-head">📓 Lesetagebuch <span class="muted">(' + js.length + ')</span></div>'
      + (js.length ? '<div class="journal-timeline">' + js.map(function (e, i) {
          return '<div class="journal-item"><div class="journal-dot"></div>'
            + '<div class="journal-body"><div class="journal-meta">' + fmtDate(e.date)
            + (e.page ? ' · Seite ' + e.page : '') + '</div>'
            + (e.text ? '<div class="journal-text">' + esc(e.text) + '</div>' : '')
            + '<button class="journal-del" data-ji="' + (own.journal.length - 1 - i) + '" aria-label="Eintrag löschen">🗑</button></div></div>';
        }).join('') + '</div>' : '')
      + '<div class="journal-add">'
      + '<input id="journalPage" type="number" inputmode="numeric" placeholder="Seite" value="' + (own.progress || '') + '" />'
      + '<textarea id="journalText" placeholder="Gedanke zum Leseverlauf…" rows="2"></textarea>'
      + '<button class="btn-ghost" id="journalAddBtn">+ Eintrag</button></div>'
      + '</div>';
  }

  // v1.7: Zitat als schöne Bild-Karte exportieren (Canvas)
  function exportQuoteImage(text, title, author) {
    var W = 1080, H = 1080;
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#2a1f16'); g.addColorStop(1, '#120c08');
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(245,201,107,.35)'; x.lineWidth = 4; x.strokeRect(40, 40, W - 80, H - 80);
    x.fillStyle = '#f5c96b'; x.font = '140px Georgia, serif'; x.textAlign = 'left';
    x.fillText('„', 80, 230);
    // Zitat umbrechen
    x.fillStyle = '#fdf6e3'; x.textAlign = 'center';
    var size = text.length > 220 ? 40 : text.length > 120 ? 50 : 62;
    x.font = size + 'px Georgia, serif';
    var words = text.split(' '), lines = [], line = '';
    words.forEach(function (w) {
      if (x.measureText(line + w + ' ').width > W - 200 && line) { lines.push(line.trim()); line = ''; }
      line += w + ' ';
    });
    if (line.trim()) lines.push(line.trim());
    lines = lines.slice(0, 10);
    var lh = size + 18, startY = H / 2 - (lines.length - 1) * lh / 2;
    lines.forEach(function (ln, i) { x.fillText(ln, W / 2, startY + i * lh); });
    x.fillStyle = '#f5c96b'; x.font = '34px Georgia, serif';
    x.fillText('— ' + (title || ''), W / 2, H - 170);
    if (author) { x.fillStyle = '#b8a892'; x.font = '28px system-ui, sans-serif'; x.fillText(author, W / 2, H - 125); }
    x.fillStyle = '#82715c'; x.font = '24px system-ui, sans-serif'; x.fillText('Hon 本 · Bücher Tracker', W / 2, H - 60);
    var a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = 'zitat-' + (title || 'buch').replace(/[^a-z0-9]/gi, '-').slice(0, 30).toLowerCase() + '.png';
    a.click();
    toast('Zitat-Bild gespeichert 🖼️');
  }

  /* ══════════════════════════════════════════════════════════════
     v3: Sammler-Funktionen — Besitz, Verleih, Ausgaben, DNF, Tempo
     Alle neuen Felder hängen am Buch-Objekt → landen automatisch in
     bk_books und damit im Delta-Sync (collectData nimmt alle bk_-Keys).
     ══════════════════════════════════════════════════════════════ */

  // Abbruch-Gründe als feste Kategorien (statt nur Freitext) → auswertbar
  var DNF_TAGS = ['Tempo zäh', 'Schreibstil', 'Thema', 'Übersetzung', 'Zeichnung', 'Interesse verloren', 'Zu lang', 'Sonstiges'];

  function money(n) {
    return (Math.round(n * 100) / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }
  // Preis-Eingabe tolerant lesen: „12,90", „12.90", „12,90 €", „  9 " → Zahl (0 wenn ungültig)
  function parsePrice(s) {
    var t = String(s == null ? '' : s).replace(/[^0-9.,]/g, '').trim();
    if (!t) return 0;
    // Letztes Komma/Punkt ist das Dezimaltrennzeichen (1.234,50 wie auch 1,234.50)
    var lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    var sep = Math.max(lastComma, lastDot);
    var num = sep >= 0
      ? t.slice(0, sep).replace(/[.,]/g, '') + '.' + t.slice(sep + 1).replace(/[.,]/g, '')
      : t;
    var v = parseFloat(num);
    return (isFinite(v) && v >= 0) ? Math.round(v * 100) / 100 : 0;
  }
  // Datum als YYYY-MM-DD für <input type="date">
  function isoDay(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    return isNaN(d) ? '' : d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Alle vergebenen Standorte (für Filter + Vorschlagsliste)
  function allLocations() {
    var m = {};
    lib().forEach(function (b) { if (b.loc) m[b.loc] = (m[b.loc] || 0) + 1; });
    return m;
  }

  // ── Besitz-Block im Detail: Standort · Verleih · Preis · Kaufdatum ──
  function ownershipHtml(own) {
    if (!own) return '';
    var locs = Object.keys(allLocations()).sort();
    var lent = own.lentTo ? String(own.lentTo) : '';
    return '<details class="own-block"' + ((own.loc || lent || own.price) ? ' open' : '') + '>'
      + '<summary>📦 Besitz &amp; Standort' + (own.loc ? ' <span class="own-badge">' + esc(own.loc) + '</span>' : '')
      + (lent ? ' <span class="own-badge lent">verliehen</span>' : '') + '</summary>'
      + '<div class="own-grid">'
      + '<label for="ownLoc">📍 Standort</label>'
      + '<input id="ownLoc" list="locList" type="text" placeholder="z. B. Regal Wohnzimmer" value="' + esc(own.loc || '') + '" />'
      + '<datalist id="locList">' + locs.map(function (l) { return '<option value="' + esc(l) + '"></option>'; }).join('') + '</datalist>'
      + '<label for="ownLent">🤝 Verliehen an</label>'
      + '<input id="ownLent" type="text" placeholder="Name (leer = bei mir)" value="' + esc(lent) + '" />'
      + '<label for="ownPrice">💰 Preis</label>'
      // type="text" statt "number": bei type=number liefert .value LEER, sobald der Browser
      // den Wert für ungültig hält — „12,90" mit Komma ist genau das. Auf deutscher Tastatur
      // tippt man aber Komma, der Preis ginge sonst still verloren.
      + '<input id="ownPrice" type="text" inputmode="decimal" placeholder="z. B. 7,50" value="' + (own.price > 0 ? String(own.price).replace('.', ',') : '') + '" />'
      + '<label for="ownBought">🗓️ Gekauft am</label>'
      + '<input id="ownBought" type="date" value="' + isoDay(own.boughtAt) + '" />'
      + '</div>'
      + (lent && own.lentAt ? '<p class="own-hint">🤝 Seit ' + fmtDate(own.lentAt) + ' bei <b>' + esc(lent) + '</b>'
          + ((Date.now() - own.lentAt) > 90 * 86400000 ? ' — das ist schon eine Weile her!' : '') + '</p>' : '')
      + '</details>';
  }

  // ── DNF-Block: Gründe als Chips + Seite beim Abbruch ──
  function dnfHtml(own) {
    if (!own || own.status !== 'dnf') return '';
    var tags = own.dnfTags || [];
    return '<div class="dnf-block">'
      + '<div class="quotes-head">🚫 Warum abgebrochen?</div>'
      + '<div class="quick-chips dnf-chips">'
      + DNF_TAGS.map(function (t) {
          return '<button class="chip' + (tags.indexOf(t) >= 0 ? ' active' : '') + '" data-dnftag="' + esc(t) + '">' + esc(t) + '</button>';
        }).join('')
      + '</div>'
      + '<div class="dnf-row"><label for="dnfPageIn">Abgebrochen auf Seite</label>'
      + '<input id="dnfPageIn" type="number" min="0" inputmode="numeric" placeholder="Seite" value="' + (own.dnfPage || '') + '" />'
      + (own.pages ? '<span class="muted">von ' + own.pages + '</span>' : '') + '</div>'
      + '<input id="dnfReasonIn" class="dnf-free" type="text" placeholder="Eigener Grund (optional)" value="' + esc(own.dnfReason || '') + '" />'
      + '</div>';
  }

  // ── Lese-Tempo aus den Timer-Sessions (v3-D) ──
  // Liefert Seiten/Stunde gesamt und je Schnitt (Format, Typ) + Sitzungs-Kennzahlen.
  function paceStats() {
    var sess = loadSessions();
    var byId = bookIndex();
    var tot = { min: 0, pages: 0 }, byFormat = {}, byKind = {}, hours = new Array(24).fill(0);
    var longest = 0, count = 0;
    // Seiten je Session sind nicht erfasst → über das Buch schätzen:
    // gelesene Seiten des Buchs anteilig auf seine Session-Minuten verteilen.
    var minsPerBook = {};
    sess.forEach(function (s) { if (s.bookId) minsPerBook[s.bookId] = (minsPerBook[s.bookId] || 0) + (s.minutes || 0); });
    sess.forEach(function (s) {
      var mn = s.minutes || 0;
      if (mn <= 0) return;
      count++;
      if (mn > longest) longest = mn;
      tot.min += mn;
      try { hours[new Date(s.start).getHours()]++; } catch (e) {}
      var b = s.bookId && byId[s.bookId];
      if (!b) return;
      var readPages = b.status === 'read' ? (b.pages || 0) : (b.progress || 0);
      if (!readPages || !minsPerBook[b.id]) return;
      var share = readPages * (mn / minsPerBook[b.id]);
      tot.pages += share;
      var f = b.format || 'print';
      byFormat[f] = byFormat[f] || { min: 0, pages: 0 };
      byFormat[f].min += mn; byFormat[f].pages += share;
      var k = b.kind === 'manga' ? 'manga' : b.kind === 'magazin' ? 'magazin' : 'buch';
      byKind[k] = byKind[k] || { min: 0, pages: 0 };
      byKind[k].min += mn; byKind[k].pages += share;
    });
    function pph(o) { return (o && o.min >= 10 && o.pages > 0) ? (o.pages / (o.min / 60)) : 0; }
    return {
      sessions: count, totalMin: tot.min, longest: longest,
      avgSession: count ? Math.round(tot.min / count) : 0,
      pagesPerHour: pph(tot), byFormat: byFormat, byKind: byKind, hours: hours,
      pphOf: pph
    };
  }

  // ── Tsundoku-Bilanz: ungelesener Stapel in Seiten/Zeit/Geld (v3-C) ──
  function tsundoku() {
    var want = lib().filter(function (b) { return b.status === 'want'; });
    var pages = want.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var spent = want.reduce(function (s, b) { return s + (b.price > 0 ? b.price : 0); }, 0);
    var pph = paceStats().pagesPerHour;
    // Ohne Timer-Daten: gängiger Schnitt (Manga liest sich deutlich schneller als Prosa)
    if (!pph) {
      var mangaShare = want.length ? want.filter(function (b) { return b.kind === 'manga'; }).length / want.length : 0;
      pph = 40 + mangaShare * 70;
    }
    var hours = pages > 0 ? pages / pph : 0;
    // Älteste Karteileiche: liegt am längsten auf „Will lesen"
    var oldest = null;
    want.forEach(function (b) { if (b.addedAt && (!oldest || b.addedAt < oldest.addedAt)) oldest = b; });
    return { count: want.length, pages: pages, hours: hours, spent: spent, oldest: oldest, pph: pph };
  }

  // ── nach aussen geben ──
  H.renderStats = renderStats;
  H.forecastHtml = forecastHtml;
  H.formatRowHtml = formatRowHtml;
  H.shopLinksHtml = shopLinksHtml;
  H.quotesHtml = quotesHtml;
  H.journalHtml = journalHtml;
  H.exportQuoteImage = exportQuoteImage;
  H.DNF_TAGS = DNF_TAGS;
  H.money = money;
  H.parsePrice = parsePrice;
  H.isoDay = isoDay;
  H.allLocations = allLocations;
  H.ownershipHtml = ownershipHtml;
  H.dnfHtml = dnfHtml;
  H.paceStats = paceStats;
  H.tsundoku = tsundoku;
})(window.HonIntern = window.HonIntern || {});
