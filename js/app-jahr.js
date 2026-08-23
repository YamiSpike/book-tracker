/* v1.4: Jahresrueckblick + Jahres-Duell
   Ausgelagert aus js/app.js. Der Rumpf ist unveraendert uebernommen.

   Bindung an den Kern laeuft ueber window.HonIntern (H). js/app.js startet
   erst bei DOMContentLoaded — also NACH allen Skripten —, deshalb ist die
   Ladereihenfolge unkritisch, solange diese Datei nach app.js steht.
   Funktionen werden ueber Weiterleitungen geholt (spaete Bindung, damit auch
   Verweise auf ANDERE Teilmodule funktionieren), Konstanten direkt kopiert. */
(function (H) {
  'use strict';

  // Funktionen aus dem Kern bzw. aus Nachbarmodulen (spaete Bindung)
  function achStats() { return H.achStats.apply(null, arguments); }
  function esc() { return H.esc.apply(null, arguments); }
  function lib() { return H.lib.apply(null, arguments); }
  function loadSessions() { return H.loadSessions.apply(null, arguments); }
  function money() { return H.money.apply(null, arguments); }
  function readDatesOf() { return H.readDatesOf.apply(null, arguments); }
  function toast() { return H.toast.apply(null, arguments); }

  // ───── v1.4: Jahresrückblick ─────
  /* ── v3-F: Jahres-Duell — zwei Jahre direkt nebeneinander ──
     Der Jahresrückblick ist ein Dezember-Erlebnis; der Vergleich ist ganzjährig
     interessant („bin ich schneller als letztes Jahr?"). Nutzt nur readDates. */
  function yearFacts(yr) {
    var books = lib();
    var read = books.filter(function (b) {
      return readDatesOf(b).some(function (ts) { return new Date(ts).getFullYear() === yr; });
    });
    var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var rated = read.filter(function (b) { return b.rating > 0; });
    var gen = {};
    read.forEach(function (b) { (b.categories || []).forEach(function (c) { var g = c.split('/')[0].trim(); if (g) gen[g] = (gen[g] || 0) + 1; }); });
    var minutes = loadSessions().filter(function (s) { return new Date(s.start).getFullYear() === yr; })
      .reduce(function (s, x) { return s + (x.minutes || 0); }, 0);
    var dnf = books.filter(function (b) {
      return b.status === 'dnf' && b.updatedAt && new Date(b.updatedAt).getFullYear() === yr;
    }).length;
    var spent = books.filter(function (b) {
      return b.price > 0 && b.boughtAt && new Date(b.boughtAt).getFullYear() === yr;
    }).reduce(function (s, b) { return s + b.price; }, 0);
    return {
      year: yr, count: read.length, pages: pages,
      avgRating: rated.length ? (rated.reduce(function (s, b) { return s + b.rating; }, 0) / rated.length) : 0,
      avgPages: read.length ? Math.round(pages / read.length) : 0,
      topGenre: Object.keys(gen).sort(function (a, b) { return gen[b] - gen[a]; })[0] || '–',
      minutes: minutes, dnf: dnf, spent: spent, books: read
    };
  }
  // Kumulierte Seiten je Kalendertag → „zum selben Datum" vergleichbar
  function cumPages(yr) {
    var arr = new Array(366).fill(0);
    lib().forEach(function (b) {
      readDatesOf(b).forEach(function (ts) {
        var d = new Date(ts);
        if (d.getFullYear() !== yr) return;
        var doy = Math.floor((d - new Date(yr, 0, 0)) / 86400000);
        if (doy >= 0 && doy < 366) arr[doy] += (b.pages || 0);
      });
    });
    var out = [], run = 0;
    for (var i = 0; i < 366; i++) { run += arr[i]; out.push(run); }
    return out;
  }
  function openYearDuel() {
    var years = {};
    lib().forEach(function (b) { readDatesOf(b).forEach(function (ts) { years[new Date(ts).getFullYear()] = 1; }); });
    var list = Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
    var nowY = new Date().getFullYear();
    if (list.indexOf(nowY) < 0) list.unshift(nowY);
    if (list.length < 2) { toast('📈 Dafür brauchst du Lese-Daten aus mindestens 2 Jahren.'); return; }

    var m = document.createElement('div');
    m.className = 'year-modal';
    m.innerHTML = '<div class="year-card duel-card">'
      + '<div class="year-head">📈 Jahre vergleichen</div>'
      + '<div class="duel-picks">'
      + '<select id="duelA" class="select-mini">' + list.map(function (y) { return '<option value="' + y + '"' + (y === list[0] ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>'
      + '<span class="duel-vs">vs.</span>'
      + '<select id="duelB" class="select-mini">' + list.map(function (y) { return '<option value="' + y + '"' + (y === list[1] ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>'
      + '</div>'
      + '<div id="duelBody"></div>'
      + '<div class="year-btns"><button class="btn-ghost" id="duelClose">Schließen</button></div></div>';
    document.body.appendChild(m);

    function cmp(a, b, higherBetter) {
      if (!a && !b) return '';
      if (a === b) return '<span class="duel-eq">=</span>';
      var better = higherBetter === false ? (a < b) : (a > b);
      return '<span class="duel-' + (better ? 'up' : 'down') + '">' + (better ? '▲' : '▼') + '</span>';
    }
    function drawDuel() {
      var yA = parseInt(m.querySelector('#duelA').value, 10);
      var yB = parseInt(m.querySelector('#duelB').value, 10);
      var A = yearFacts(yA), B = yearFacts(yB);
      function row(lbl, va, vb, fa, fb, higherBetter) {
        return '<div class="duel-row"><span class="duel-a">' + (fa || va) + ' ' + cmp(va, vb, higherBetter) + '</span>'
          + '<span class="duel-lbl">' + lbl + '</span>'
          + '<span class="duel-b">' + (fb || vb) + '</span></div>';
      }
      // Pace-Kurve: kumulierte Seiten, beide Jahre übereinander
      var cA = cumPages(yA), cB = cumPages(yB);
      var maxV = Math.max(cA[365], cB[365], 1);
      // Das laufende Jahr nur bis heute zeichnen (sonst flacher Strich bis Silvester)
      var endA = yA === nowY ? Math.floor((Date.now() - new Date(yA, 0, 0)) / 86400000) : 365;
      var endB = yB === nowY ? Math.floor((Date.now() - new Date(yB, 0, 0)) / 86400000) : 365;
      function poly(c, end) {
        var pts = [];
        for (var i = 0; i <= Math.min(end, 365); i += 3) {
          pts.push(Math.round(i / 365 * 300) + ',' + Math.round(90 - c[i] / maxV * 82));
        }
        return pts.join(' ');
      }
      var chart = maxV > 1
        ? '<svg class="duel-chart" viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Kumulierte Seiten im Jahresverlauf">'
          + '<polyline class="duel-line-b" points="' + poly(cB, endB) + '" />'
          + '<polyline class="duel-line-a" points="' + poly(cA, endA) + '" />'
          + '</svg>'
          + '<div class="duel-legend"><span class="dl-a">■ ' + yA + '</span><span class="dl-b">■ ' + yB + '</span>'
          + '<span class="muted">kumulierte Seiten · Jan → Dez</span></div>'
        : '';
      // Direkter Stand-heute-Vergleich (fair: gleicher Kalendertag)
      var today = Math.min(365, Math.floor((Date.now() - new Date(nowY, 0, 0)) / 86400000));
      var atA = cA[Math.min(today, endA)], atB = cB[Math.min(today, endB)];
      var verdict = (atA || atB)
        ? '<p class="duel-verdict">' + (atA > atB
            ? '🚀 ' + yA + ' liegt zum ' + today + '. Tag mit <b>' + (atA - atB).toLocaleString('de-DE') + ' Seiten</b> vorn.'
            : atA < atB ? '🐢 ' + yA + ' liegt zum ' + today + '. Tag <b>' + (atB - atA).toLocaleString('de-DE') + ' Seiten</b> zurück.'
            : '⚖️ Gleichstand zum ' + today + '. Tag.') + '</p>'
        : '';
      m.querySelector('#duelBody').innerHTML =
        '<div class="duel-table">'
        + row('Bücher', A.count, B.count)
        + row('Seiten', A.pages, B.pages, A.pages.toLocaleString('de-DE'), B.pages.toLocaleString('de-DE'))
        + row('Ø Länge', A.avgPages, B.avgPages, A.avgPages + ' S.', B.avgPages + ' S.')
        + (A.avgRating || B.avgRating ? row('Ø Bewertung', A.avgRating, B.avgRating, A.avgRating ? A.avgRating.toFixed(1) + '★' : '–', B.avgRating ? B.avgRating.toFixed(1) + '★' : '–') : '')
        + (A.minutes || B.minutes ? row('Lesezeit', A.minutes, B.minutes, Math.round(A.minutes / 60) + ' h', Math.round(B.minutes / 60) + ' h') : '')
        + (A.dnf || B.dnf ? row('Abgebrochen', A.dnf, B.dnf, A.dnf, B.dnf, false) : '')
        + (A.spent || B.spent ? row('Ausgaben', A.spent, B.spent, money(A.spent), money(B.spent), false) : '')
        + '<div class="duel-row"><span class="duel-a">' + esc(A.topGenre.slice(0, 16)) + '</span><span class="duel-lbl">Top-Genre</span><span class="duel-b">' + esc(B.topGenre.slice(0, 16)) + '</span></div>'
        + '</div>' + chart + verdict;
    }
    m.querySelector('#duelA').addEventListener('change', drawDuel);
    m.querySelector('#duelB').addEventListener('change', drawDuel);
    m.querySelector('#duelClose').addEventListener('click', function () { m.remove(); });
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    drawDuel();
  }

  function openYearReview() {
    var yr = new Date().getFullYear();
    var books = lib(), read = books.filter(function (b) {
      return b.status === 'read' && readDatesOf(b).some(function (ts) { return new Date(ts).getFullYear() === yr; });
    });
    var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var minutes = loadSessions().filter(function (s) { return new Date(s.start).getFullYear() === yr; })
      .reduce(function (s, x) { return s + x.minutes; }, 0);
    var best = read.slice().sort(function (a, b) { return (b.rating || 0) - (a.rating || 0); })[0];
    var gen = {};
    read.forEach(function (b) { (b.categories || []).forEach(function (c) { var g = c.split('/')[0].trim(); if (g) gen[g] = (gen[g] || 0) + 1; }); });
    var topGenre = Object.keys(gen).sort(function (a, b) { return gen[b] - gen[a]; })[0] || '–';
    var streak = achStats().streak;

    var m = document.createElement('div');
    m.className = 'year-modal';
    m.innerHTML = '<div class="year-card" id="yearCard">'
      + '<div class="year-head">📚 Dein Lesejahr ' + yr + '</div>'
      + '<div class="year-rows">'
      + '<div class="year-row"><b>' + read.length + '</b><span>Bücher gelesen</span></div>'
      + '<div class="year-row"><b>' + pages.toLocaleString('de-DE') + '</b><span>Seiten</span></div>'
      + (minutes ? '<div class="year-row"><b>' + Math.round(minutes / 60) + ' h</b><span>Lesezeit (Timer)</span></div>' : '')
      + '<div class="year-row"><b>' + esc(topGenre) + '</b><span>Top-Genre</span></div>'
      + (streak > 1 ? '<div class="year-row"><b>' + streak + ' Tage</b><span>aktueller Streak</span></div>' : '')
      + (best ? '<div class="year-best">⭐ Dein Highlight: <b>„' + esc(best.title) + '"</b>' + (best.authors[0] ? ' von ' + esc(best.authors[0]) : '') + '</div>' : '')
      + '</div>'
      + '<div class="year-foot">Hon 本 · Bücher Tracker</div>'
      + '<div class="year-btns"><button class="btn-primary" id="yearImgBtn">🖼️ Als Bild speichern</button>'
      + '<button class="btn-ghost" id="yearCloseBtn">Schließen</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target === m) m.remove(); });
    m.querySelector('#yearCloseBtn').addEventListener('click', function () { m.remove(); });
    m.querySelector('#yearImgBtn').addEventListener('click', function () {
      var c = document.createElement('canvas');
      c.width = 800; c.height = 1000;
      var x = c.getContext('2d');
      var grad = x.createLinearGradient(0, 0, 800, 1000);
      grad.addColorStop(0, '#2a1f16'); grad.addColorStop(1, '#120c08');
      x.fillStyle = grad; x.fillRect(0, 0, 800, 1000);
      x.strokeStyle = 'rgba(245,201,107,.4)'; x.lineWidth = 3; x.strokeRect(24, 24, 752, 952);
      x.fillStyle = '#f5c96b'; x.font = 'bold 52px Georgia, serif'; x.textAlign = 'center';
      x.fillText('📚 Mein Lesejahr ' + yr, 400, 130);
      x.font = 'bold 84px Georgia, serif'; x.fillStyle = '#fdf6e3';
      x.fillText(String(read.length), 400, 300);
      x.font = '26px system-ui, sans-serif'; x.fillStyle = '#b8a892';
      x.fillText('Bücher gelesen', 400, 345);
      x.font = 'bold 56px Georgia, serif'; x.fillStyle = '#f5c96b';
      x.fillText(pages.toLocaleString('de-DE') + ' Seiten', 400, 470);
      if (minutes) { x.font = '30px system-ui, sans-serif'; x.fillStyle = '#b8a892'; x.fillText('⏱️ ' + Math.round(minutes / 60) + ' Stunden Lesezeit', 400, 540); }
      x.font = '30px system-ui, sans-serif'; x.fillStyle = '#b8a892';
      x.fillText('Top-Genre: ' + topGenre, 400, 610);
      if (best) {
        x.fillStyle = '#f5c96b'; x.font = 'bold 30px Georgia, serif';
        var t = '⭐ „' + best.title + '"';
        if (t.length > 42) t = t.slice(0, 40) + '…"';
        x.fillText(t, 400, 720);
      }
      x.font = '22px system-ui, sans-serif'; x.fillStyle = '#82715c';
      x.fillText('Hon 本 · Bücher Tracker', 400, 930);
      var a = document.createElement('a');
      a.href = c.toDataURL('image/png');
      a.download = 'lesejahr-' + yr + '.png';
      a.click();
      toast('Bild gespeichert 🖼️');
    });
  }

  // ── nach aussen geben ──
  H.yearFacts = yearFacts;
  H.cumPages = cumPages;
  H.openYearDuel = openYearDuel;
  H.openYearReview = openYearReview;
})(window.HonIntern = window.HonIntern || {});
