/* ============================================================
   Hon 本 · Bücher Tracker — App-Logik
   Suche: Google Books API (kein Key nötig)
   Sammlung: localStorage 'bk_books' → Cloud-Sync via js/cloud.js
   Empfehlungen: Profil aus Genres/Autor·innen/Bewertungen der Sammlung
   ============================================================ */
(function () {
  'use strict';

  var LS_BOOKS = 'bk_books', LS_SETTINGS = 'bk_settings';
  var GB = 'https://www.googleapis.com/books/v1/volumes';

  // ───── Storage ─────
  function loadBooks() {
    try { var a = JSON.parse(localStorage.getItem(LS_BOOKS) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveBooks(list) {
    try { localStorage.setItem(LS_BOOKS, JSON.stringify(list)); } catch (e) {}
  }
  // aktive Bücher (ohne Lösch-Tombstones, die nur für den Sync existieren)
  function lib() { return loadBooks().filter(function (b) { return !b.deleted; }); }

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSettings(s) { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (e) {} }

  // ───── Helfer ─────
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }
  function starsTxt(r) {
    r = r || 0; var s = '';
    for (var i = 1; i <= 5; i++) s += i <= r ? '★' : '☆';
    return s;
  }
  var STATUS_LBL = { read: '✓ Gelesen', reading: '📖 Lese gerade', want: '🔖 Will lesen' };

  // ───── Buchreihen-Erkennung (aus dem Titel) ─────
  function seriesOf(b) {
    var t = b.title || '';
    var m = t.match(/^(.*?)[\s:–—-]*(?:Band|Bd\.?|Vol\.?|Volume|Teil|Tome|#)\s*(\d+)/i);
    if (m && m[1].trim().length > 1) return { name: m[1].trim().replace(/[.,:;·–—-]+\s*$/, ''), num: parseInt(m[2], 10) };
    m = t.match(/^(.{3,}?)\s+(\d{1,3})$/); // z.B. "Naruto 12"
    if (m) return { name: m[1].trim(), num: parseInt(m[2], 10) };
    return null;
  }

  function fmtDate(ts) {
    return ts ? new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  }

  // ───── Google-Books-Normalisierung ─────
  function normVolume(v) {
    var vi = v.volumeInfo || {};
    var img = (vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail)) || '';
    if (img) img = img.replace(/^http:/, 'https:');
    var isbn = '';
    (vi.industryIdentifiers || []).forEach(function (x) {
      if (x.type === 'ISBN_13') isbn = x.identifier;
      else if (x.type === 'ISBN_10' && !isbn) isbn = x.identifier;
    });
    return {
      id: v.id,
      title: vi.title || 'Ohne Titel',
      authors: vi.authors || [],
      cover: img,
      year: (vi.publishedDate || '').slice(0, 4),
      pages: vi.pageCount || 0,
      categories: vi.categories || [],
      desc: vi.description || '',
      lang: vi.language || '',
      isbn: isbn,
      gRating: vi.averageRating || 0
    };
  }

  function gbSearch(q, maxResults) {
    var url = GB + '?q=' + encodeURIComponent(q) + '&maxResults=' + (maxResults || 20) + '&printType=books';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Google Books nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      return (j.items || []).map(normVolume).filter(function (b) { return b.title; });
    });
  }

  // Open Library als zweite Quelle (kein Kontingent-Limit, CORS-frei).
  // Query-Syntax übersetzen: inauthor:"X" → author:"X", subject bleibt.
  function olSearch(q, maxResults) {
    var olq = q.replace(/inauthor:/g, 'author:');
    var url = 'https://openlibrary.org/search.json?q=' + encodeURIComponent(olq)
      + '&limit=' + (maxResults || 20)
      + '&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject,language,ratings_average,isbn';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Open Library nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      return (j.docs || []).map(function (d) {
        return {
          id: String(d.key || '').replace('/works/', 'ol-'),
          olKey: d.key || '',
          title: d.title || '',
          authors: d.author_name || [],
          cover: d.cover_i ? ('https://covers.openlibrary.org/b/id/' + d.cover_i + '-M.jpg') : '',
          year: d.first_publish_year ? String(d.first_publish_year) : '',
          pages: d.number_of_pages_median || 0,
          categories: (d.subject || []).slice(0, 4),
          desc: '',
          lang: (d.language || [])[0] || '',
          isbn: (d.isbn || [])[0] || '',
          gRating: d.ratings_average ? Math.round(d.ratings_average * 10) / 10 : 0
        };
      }).filter(function (b) { return b.title; });
    });
  }

  // Deutsche Nationalbibliothek (SRU, MARC21-XML) — Pflichtexemplar: JEDES deutsche Buch.
  // Kein Key, kein Kontingent, CORS offen. Cover über den offiziellen MVB-Cover-Dienst.
  function dnbSearch(q, maxResults) {
    var plain = q.replace(/(inauthor|subject|author):/g, '').replace(/"/g, '').trim();
    if (!plain) return Promise.resolve([]);
    var url = 'https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve'
      + '&query=' + encodeURIComponent('WOE="' + plain + '"')
      + '&recordSchema=MARC21-xml&maximumRecords=' + Math.min(maxResults || 15, 15);
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('DNB nicht erreichbar (' + r.status + ')');
      return r.text();
    }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, 'application/xml');
      var recs = doc.getElementsByTagNameNS('http://www.loc.gov/MARC21/slim', 'record');
      var out = [];
      function df(rec, tag, code) {
        var fields = rec.querySelectorAll('datafield[tag="' + tag + '"]');
        var vals = [];
        for (var i = 0; i < fields.length; i++) {
          var sf = fields[i].querySelectorAll('subfield[code="' + code + '"]');
          for (var k = 0; k < sf.length; k++) vals.push(sf[k].textContent.trim());
        }
        return vals;
      }
      for (var i = 0; i < recs.length; i++) {
        var rec = recs[i];
        var title = (df(rec, '245', 'a')[0] || '').replace(/\s*[/:;]\s*$/, '');
        if (!title) continue;
        var sub = (df(rec, '245', 'b')[0] || '').replace(/\s*[/:;]\s*$/, '');
        var ctrl = rec.querySelectorAll('controlfield[tag="001"]');
        var id = 'dnb-' + ((ctrl[0] && ctrl[0].textContent.trim()) || (title + i));
        var isbn = (df(rec, '020', 'a')[0] || '').replace(/[^0-9Xx]/g, '');
        var year = ((df(rec, '264', 'c')[0] || df(rec, '260', 'c')[0] || '').match(/\d{4}/) || [''])[0];
        var pages = parseInt(((df(rec, '300', 'a')[0] || '').match(/\d+/) || ['0'])[0], 10) || 0;
        var authors = df(rec, '100', 'a').concat(df(rec, '700', 'a')).slice(0, 3)
          .map(function (a) { return a.replace(/,\s*$/, '').split(',').reverse().join(' ').trim(); });
        out.push({
          id: id,
          title: sub ? (title + ' — ' + sub) : title,
          authors: authors,
          cover: isbn ? ('https://portal.dnb.de/opac/mvb/cover?isbn=' + isbn) : '',
          year: year,
          pages: pages,
          categories: df(rec, '650', 'a').slice(0, 3),
          desc: '',
          lang: 'de',
          isbn: isbn,
          gRating: 0
        });
      }
      return out;
    });
  }

  // Alle Quellen PARALLEL abfragen und zusammenführen — beste Trefferquote,
  // und der Ausfall einer Quelle (z.B. Google-Tageskontingent) fällt nicht auf.
  // Duplikate: erster Treffer gewinnt, spätere füllen fehlende Felder (Cover/ISBN/Beschreibung) auf.
  function searchBooks(q, maxResults) {
    var n = maxResults || 20;
    return Promise.allSettled([gbSearch(q, n), dnbSearch(q, 15), olSearch(q, n)]).then(function (rs) {
      var lists = rs.map(function (r) { return r.status === 'fulfilled' ? r.value : []; });
      var map = Object.create(null), order = [];
      lists.forEach(function (list) {
        list.forEach(function (b) {
          var k = bookKey(b);
          var prev = map[k];
          if (!prev) { map[k] = b; order.push(k); return; }
          // Lücken auffüllen statt Duplikat anzeigen
          if (!prev.cover && b.cover) prev.cover = b.cover;
          if (!prev.desc && b.desc) prev.desc = b.desc;
          if (!prev.isbn && b.isbn) prev.isbn = b.isbn;
          if (!prev.pages && b.pages) prev.pages = b.pages;
          if (!prev.year && b.year) prev.year = b.year;
          if ((!prev.categories || !prev.categories.length) && b.categories && b.categories.length) prev.categories = b.categories;
          if (!prev.olKey && b.olKey) prev.olKey = b.olKey;
        });
      });
      var merged = order.map(function (k) { return map[k]; });
      // Einträge mit Cover zuerst (bessere Trefferliste), Reihenfolge sonst stabil
      merged.sort(function (a, b) { return (b.cover ? 1 : 0) - (a.cover ? 1 : 0); });
      if (!merged.length) throw new Error('Keine Quelle erreichbar. Bitte später erneut versuchen.');
      return merged.slice(0, n + 10);
    });
  }

  // Titel+Autor-Schlüssel zum Duplikat-Erkennen (gleiche Bücher haben oft mehrere Volume-IDs)
  function bookKey(b) {
    return (b.title + '|' + (b.authors[0] || '')).toLowerCase().replace(/[^a-zäöüß0-9|]/g, '');
  }
  function inLib(b) {
    var key = bookKey(b);
    return lib().some(function (x) { return x.id === b.id || bookKey(x) === key; });
  }
  function findInLib(id) {
    var all = loadBooks();
    for (var i = 0; i < all.length; i++) if (all[i].id === id && !all[i].deleted) return all[i];
    return null;
  }

  // ───── Sammlung ändern ─────
  // Lese-Tagebuch: Statuswechsel setzt Start-/Enddatum automatisch
  function statusDates(existing, status, now) {
    var p = {};
    if (status === 'reading' && !(existing && existing.startedAt)) p.startedAt = now;
    if (status === 'read') {
      if (!(existing && existing.startedAt)) p.startedAt = now;
      if (!(existing && existing.finishedAt)) p.finishedAt = now;
    }
    return p;
  }
  function upsertBook(b, status) {
    var all = loadBooks();
    var idx = all.findIndex(function (x) { return x.id === b.id; });
    var now = Date.now();
    if (idx >= 0) {
      var st = status || all[idx].status;
      all[idx] = Object.assign({}, all[idx], statusDates(all[idx], st, now), { status: st, deleted: false, updatedAt: now });
    } else {
      var st2 = status || 'read';
      all.push(Object.assign({}, b, statusDates(null, st2, now), { status: st2, rating: 0, note: '', progress: 0, tags: [], quotes: [], addedAt: now, updatedAt: now }));
    }
    saveBooks(all);
    refreshAll();
  }
  function patchBook(id, patch) {
    var all = loadBooks();
    var idx = all.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return;
    all[idx] = Object.assign({}, all[idx], patch, { updatedAt: Date.now() });
    saveBooks(all);
    refreshAll();
  }
  function removeBook(id) {
    // Tombstone statt echtem Löschen → Löschung überlebt den Multi-Device-Merge
    patchBook(id, { deleted: true });
  }

  // ───── Karten-Rendering ─────
  function coverHtml(b) {
    if (b.cover) return '<img class="cover" loading="lazy" src="' + esc(b.cover) + '" alt="" onerror="this.outerHTML=\'&lt;div class=&quot;cover-fallback&quot;&gt;&lt;div class=&quot;big&quot;&gt;📕&lt;/div&gt;&lt;/div&gt;\'" />';
    return '<div class="cover-fallback"><div class="big">📕</div><div class="t">' + esc(b.title.slice(0, 46)) + '</div></div>';
  }
  function cardHtml(b, opts) {
    opts = opts || {};
    var own = findInLib(b.id) || (inLib(b) ? b : null);
    var chip = '';
    if (opts.showStatus && own && own.status) {
      chip = '<span class="status-chip ' + esc(own.status) + '">' + esc(STATUS_LBL[own.status] || '') + '</span>';
    }
    var mark = (!opts.showStatus && own) ? '<span class="in-lib" title="In deiner Sammlung">✓</span>' : '';
    var stars = (own && own.rating) ? '<div class="stars">' + starsTxt(own.rating) + '</div>' : '';
    var reason = opts.reason ? '<span class="reco-reason">' + esc(opts.reason) + '</span>' : '';
    // Lese-Fortschritt als Balken auf der Karte
    var prog = '';
    if (own && own.status === 'reading' && own.progress > 0 && (own.pages || 0) > 0) {
      var pct = Math.min(100, Math.round(own.progress / own.pages * 100));
      prog = '<div class="card-progress" title="Seite ' + own.progress + ' von ' + own.pages + '"><i style="width:' + pct + '%"></i><span>' + pct + '%</span></div>';
    }
    return '<article class="card" data-id="' + esc(b.id) + '" data-src="' + esc(opts.src || 'lib') + '">'
      + chip + mark + coverHtml(b)
      + reason
      + '<div class="meta"><div class="title">' + esc(b.title) + '</div>'
      + '<div class="author">' + esc(b.authors.join(', ') || '–') + '</div>' + stars + prog + '</div></article>';
  }

  // ───── Tabs ─────
  var currentTab = 'home';
  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.tab === name); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    if (name === 'home') renderHome();
    if (name === 'sammlung') renderLib();
    if (name === 'tipps') renderReco(false);
    if (name === 'stats') renderStats();
    try { window.scrollTo({ top: 0 }); } catch (e) {}
  }

  // ───── Start ─────
  function renderHome() {
    var books = lib();
    var read = books.filter(function (b) { return b.status === 'read'; });
    var reading = books.filter(function (b) { return b.status === 'reading'; });
    var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var hero = $('homeHero');
    var hour = new Date().getHours();
    var greet = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Willkommen zurück' : 'Guten Abend';

    // Lese-Challenge: Ring mit Jahresfortschritt
    var goal = parseInt(loadSettings().goal, 10) || 0;
    var yr = new Date().getFullYear();
    var doneThisYear = read.filter(function (b) {
      return new Date(b.finishedAt || b.addedAt || 0).getFullYear() === yr;
    }).length;
    var ringHtml = '';
    if (goal > 0) {
      var pct = Math.min(1, doneThisYear / goal);
      var C = 2 * Math.PI * 34; // Umfang bei r=34
      ringHtml = '<div class="challenge-ring" role="img" aria-label="Lese-Challenge: ' + doneThisYear + ' von ' + goal + ' Büchern">'
        + '<svg viewBox="0 0 80 80"><circle class="ring-bg" cx="40" cy="40" r="34"/>'
        + '<circle class="ring-fg" cx="40" cy="40" r="34" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + (C * (1 - pct)).toFixed(1) + '"/></svg>'
        + '<div class="ring-txt"><b>' + doneThisYear + '</b><span>/' + goal + '</span></div>'
        + '<div class="ring-lbl">🎯 Challenge ' + yr + (doneThisYear >= goal ? ' — geschafft! 🎉' : '') + '</div>'
        + '</div>';
    } else {
      ringHtml = '<button class="btn-ghost ring-set" id="goalSetBtn">🎯 Lese-Ziel für ' + yr + ' setzen</button>';
    }

    hero.innerHTML = '<span class="hero-kanji">本</span>'
      + '<div class="hero-flex"><div class="hero-main">'
      + '<h2>' + greet + ', Leseratte!</h2>'
      + '<p>Deine persönliche Bibliothek — gesichert in der Cloud.</p>'
      + '<div class="hero-stats">'
      + '<div class="hero-stat"><b>' + read.length + '</b><span>gelesen</span></div>'
      + '<div class="hero-stat"><b>' + reading.length + '</b><span>am Lesen</span></div>'
      + '<div class="hero-stat"><b>' + pages.toLocaleString('de-DE') + '</b><span>Seiten</span></div>'
      + '</div></div>'
      + ringHtml + '</div>';
    var gsb = document.getElementById('goalSetBtn');
    if (gsb) gsb.addEventListener('click', function () { switchTab('settings'); var gi = $('setGoal'); if (gi) gi.focus(); });

    // Zitat des Tages (deterministisch pro Tag aus allen gespeicherten Zitaten)
    var allQuotes = [];
    books.forEach(function (b) { (b.quotes || []).forEach(function (q) { allQuotes.push({ q: q.text, from: b.title }); }); });
    var qSec = $('homeQuoteSection');
    if (qSec) {
      if (allQuotes.length) {
        var dayIdx = Math.floor(Date.now() / 86400000) % allQuotes.length;
        var qq = allQuotes[dayIdx];
        qSec.hidden = false;
        $('homeQuote').innerHTML = '<span class="quote-mark">„</span>' + esc(qq.q) + '"'
          + '<div class="quote-src">— aus „' + esc(qq.from) + '"</div>';
      } else qSec.hidden = true;
    }

    $('homeEmpty').hidden = books.length > 0;

    $('homeReadingSection').hidden = reading.length === 0;
    $('homeReading').innerHTML = reading.slice(0, 6).map(function (b) { return cardHtml(b, { showStatus: true }); }).join('');

    var recent = books.slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); }).slice(0, 6);
    $('homeRecentSection').hidden = recent.length === 0;
    $('homeRecent').innerHTML = recent.map(function (b) { return cardHtml(b, { showStatus: true }); }).join('');

    var tipSec = $('homeTipSection');
    if (books.length > 0 && lastReco.length > 0) {
      tipSec.hidden = false;
      $('homeTip').innerHTML = lastReco.slice(0, 3).map(function (r) { return cardHtml(r.book, { src: 'reco', reason: r.reason }); }).join('');
    } else if (books.length > 0) {
      tipSec.hidden = true;
      // Empfehlungen still im Hintergrund vorwärmen
      buildReco().then(function () { if (currentTab === 'home') renderHome(); }).catch(function () {});
    } else {
      tipSec.hidden = true;
    }
  }

  // ───── Suche ─────
  var lastSearch = [];
  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    var grid = $('searchGrid');
    $('searchEmpty').hidden = true;
    grid.innerHTML = '<div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    searchBooks(q, 20).then(function (items) {
      // Duplikate (gleicher Titel+Autor) zusammenfassen
      var seen = {}, out = [];
      items.forEach(function (b) { var k = bookKey(b); if (!seen[k]) { seen[k] = 1; out.push(b); } });
      lastSearch = out;
      if (!out.length) {
        grid.innerHTML = '';
        $('searchEmpty').hidden = false;
        $('searchEmpty').innerHTML = '<div class="big">🤷</div><p>Nichts gefunden für „' + esc(q) + '".</p><p class="muted">Versuche einen anderen Titel oder Autor·in.</p>';
        return;
      }
      grid.innerHTML = out.map(function (b) { return cardHtml(b, { src: 'search' }); }).join('');
    }).catch(function (e) {
      grid.innerHTML = '';
      $('searchEmpty').hidden = false;
      $('searchEmpty').innerHTML = '<div class="big">📡</div><p>Suche fehlgeschlagen.</p><p class="muted">' + esc(e.message) + '</p>';
    });
  }

  // ───── Sammlung ─────
  function renderLib() {
    var books = lib();
    $('libBadge').textContent = books.length;
    var st = $('filterStatus').value, ge = $('filterGenre').value, tg = $('filterTag').value, sort = $('sortLib').value;

    // Genre-Filter-Optionen aktuell halten
    var genres = {};
    books.forEach(function (b) { (b.categories || []).forEach(function (c) { genres[c.split('/')[0].trim()] = 1; }); });
    var sel = $('filterGenre'), cur = sel.value;
    sel.innerHTML = '<option value="">Alle Genres</option>' + Object.keys(genres).sort().map(function (g) {
      return '<option value="' + esc(g) + '"' + (g === cur ? ' selected' : '') + '>' + esc(g) + '</option>';
    }).join('');

    // Regal-/Tag-Filter-Optionen
    var tags = {};
    books.forEach(function (b) { (b.tags || []).forEach(function (t) { tags[t] = 1; }); });
    var tsel = $('filterTag'), tcur = tsel.value;
    tsel.innerHTML = '<option value="">Alle Regale/Tags</option>' + Object.keys(tags).sort().map(function (t) {
      return '<option value="' + esc(t) + '"' + (t === tcur ? ' selected' : '') + '>🏷️ ' + esc(t) + '</option>';
    }).join('');
    tsel.style.display = Object.keys(tags).length ? '' : 'none';

    var out = books.filter(function (b) {
      if (st && b.status !== st) return false;
      if (ge && !(b.categories || []).some(function (c) { return c.split('/')[0].trim() === ge; })) return false;
      if (tg && !(b.tags || []).some(function (t) { return t === tg; })) return false;
      return true;
    });
    out.sort(function (a, b) {
      if (sort === 'title') return a.title.localeCompare(b.title, 'de');
      if (sort === 'author') return (a.authors[0] || '').localeCompare(b.authors[0] || '', 'de');
      if (sort === 'rating') return (b.rating || 0) - (a.rating || 0);
      return (b.addedAt || 0) - (a.addedAt || 0);
    });
    $('libGrid').innerHTML = out.map(function (b) { return cardHtml(b, { showStatus: true }); }).join('');
    $('emptyLib').hidden = books.length > 0;
  }

  // ───── Empfehlungs-Engine ─────
  var lastReco = [];        // [{book, reason, score}]
  var recoBuiltFor = '';    // Hash der Sammlung, für die Empfehlungen gebaut wurden

  function profileOf(books) {
    // Gewicht: Bewertung (1-5, unbewertet = 3) · gelesen zählt voll, "will lesen" halb
    var cats = {}, auths = {};
    books.forEach(function (b) {
      var w = (b.rating || 3) * (b.status === 'want' ? 0.5 : 1);
      (b.categories || []).forEach(function (c) {
        var g = c.split('/')[0].trim(); if (!g) return;
        cats[g] = (cats[g] || 0) + w;
      });
      (b.authors || []).forEach(function (a) { if (a) auths[a] = (auths[a] || 0) + w; });
    });
    function top(o, n) {
      return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n);
    }
    return { cats: top(cats, 3), auths: top(auths, 2), catW: cats, authW: auths };
  }

  function buildReco() {
    var books = lib();
    if (!books.length) { lastReco = []; return Promise.resolve([]); }
    var hash = books.map(function (b) { return b.id + ':' + (b.rating || 0); }).sort().join(',');
    if (hash === recoBuiltFor && lastReco.length) return Promise.resolve(lastReco);

    var p = profileOf(books);
    var queries = [];
    p.auths.forEach(function (a) { queries.push({ q: 'inauthor:"' + a + '"', reason: 'Weil du ' + a + ' liest' }); });
    p.cats.forEach(function (c) { queries.push({ q: 'subject:"' + c + '"', reason: 'Weil du gern „' + c + '" liest' }); });
    if (!queries.length) {
      // Sammlung ohne Genre-/Autor-Daten → Titel-basiert suchen
      var t = books[0].title.split(' ').slice(0, 3).join(' ');
      queries.push({ q: t, reason: 'Ähnlich wie „' + books[0].title + '"' });
    }

    return Promise.all(queries.map(function (Q) {
      return searchBooks(Q.q, 12).then(function (items) {
        return items.map(function (b) { return { book: b, reason: Q.reason }; });
      }).catch(function () { return []; });
    })).then(function (results) {
      var seen = {}, out = [];
      results.forEach(function (list) {
        list.forEach(function (r) {
          var b = r.book, k = bookKey(b);
          if (seen[k] || seen[b.id]) return;
          if (inLib(b)) return;                       // schon in der Sammlung
          if (!b.cover && !b.desc) return;            // zu magere Einträge aussortieren
          seen[k] = 1; seen[b.id] = 1;
          // Score: Genre-/Autor-Übereinstimmung mit Profil + Google-Rating
          var score = b.gRating || 0;
          (b.categories || []).forEach(function (c) { score += (p.catW[c.split('/')[0].trim()] || 0) * 0.4; });
          (b.authors || []).forEach(function (a) { score += (p.authW[a] || 0) * 0.6; });
          out.push({ book: b, reason: r.reason, score: score });
        });
      });
      out.sort(function (a, b) { return b.score - a.score; });
      lastReco = out.slice(0, 18);
      recoBuiltFor = hash;
      return lastReco;
    });
  }

  function renderReco(force) {
    var books = lib();
    var grid = $('recoGrid'), empty = $('recoEmpty'), loading = $('recoLoading');
    if (!books.length) { grid.innerHTML = ''; empty.hidden = false; loading.hidden = true; return; }
    empty.hidden = true;
    if (force) { recoBuiltFor = ''; }
    var p = profileOf(books);
    $('recoSub').textContent = 'Dein Profil: ' + (p.cats.length ? p.cats.join(' · ') : '–')
      + (p.auths.length ? ' — Autor·innen: ' + p.auths.join(', ') : '');
    grid.innerHTML = ''; loading.hidden = false;
    buildReco().then(function (recos) {
      loading.hidden = true;
      if (!recos.length) {
        empty.hidden = false;
        empty.innerHTML = '<div class="big">📡</div><p>Gerade keine Empfehlungen gefunden.</p><p class="muted">Versuche es später erneut.</p>';
        return;
      }
      grid.innerHTML = recos.map(function (r) { return cardHtml(r.book, { src: 'reco', reason: r.reason }); }).join('');
    }).catch(function () {
      loading.hidden = true;
      empty.hidden = false;
      empty.innerHTML = '<div class="big">📡</div><p>Empfehlungen konnten nicht geladen werden.</p>';
    });
  }

  // ───── Statistik ─────
  function renderStats() {
    var books = lib();
    var read = books.filter(function (b) { return b.status === 'read'; });
    var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
    var rated = books.filter(function (b) { return b.rating > 0; });
    var avg = rated.length ? (rated.reduce(function (s, b) { return s + b.rating; }, 0) / rated.length).toFixed(1) : '–';

    $('statsGrid').innerHTML =
      '<div class="stat-card"><b>' + read.length + '</b><span>Bücher gelesen</span></div>'
      + '<div class="stat-card"><b>' + pages.toLocaleString('de-DE') + '</b><span>Seiten gelesen</span></div>'
      + '<div class="stat-card"><b>' + books.filter(function (b) { return b.status === 'reading'; }).length + '</b><span>Lese gerade</span></div>'
      + '<div class="stat-card"><b>' + books.filter(function (b) { return b.status === 'want'; }).length + '</b><span>Will lesen</span></div>'
      + '<div class="stat-card"><b>' + avg + '</b><span>Ø Bewertung</span></div>';

    function barBlock(title, counts) {
      var keys = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 7);
      if (!keys.length) return '';
      var max = counts[keys[0]] || 1;
      return '<h2 style="font-size:16px;margin-top:22px">' + title + '</h2><div class="bar-list">'
        + keys.map(function (k) {
          return '<div class="bar-row"><span class="lbl">' + esc(k) + '</span><span class="bar"><i style="width:' + Math.round(counts[k] / max * 100) + '%"></i></span><span class="val">' + counts[k] + '</span></div>';
        }).join('') + '</div>';
    }
    var gen = {}, aut = {}, yrs = {};
    books.forEach(function (b) {
      (b.categories || []).forEach(function (c) { var g = c.split('/')[0].trim(); if (g) gen[g] = (gen[g] || 0) + 1; });
      (b.authors || []).forEach(function (a) { aut[a] = (aut[a] || 0) + 1; });
      var y = new Date(b.addedAt || Date.now()).getFullYear(); yrs[y] = (yrs[y] || 0) + 1;
    });
    // Lese-Heatmap: letzte 26 Wochen (hinzugefügt = 1 Punkt, beendet = 2 Punkte)
    function heatmapHtml() {
      var days = Object.create(null);
      books.forEach(function (b) {
        if (b.addedAt) { var d1 = new Date(b.addedAt).toISOString().slice(0, 10); days[d1] = (days[d1] || 0) + 1; }
        if (b.finishedAt) { var d2 = new Date(b.finishedAt).toISOString().slice(0, 10); days[d2] = (days[d2] || 0) + 2; }
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

    $('statsBars').innerHTML = books.length
      ? heatmapHtml() + seriesHtml() + barBlock('📚 Top-Genres', gen) + barBlock('✍️ Top-Autor·innen', aut) + barBlock('🗓️ Hinzugefügt pro Jahr', yrs)
      : '<div class="empty"><div class="big">📊</div><p>Noch keine Daten — füge zuerst Bücher hinzu.</p></div>';
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
          + '<button class="quote-del" data-qi="' + i + '" aria-label="Zitat löschen">🗑</button></div>';
      }).join('')
      + '<div class="quote-add"><textarea id="quoteInput" placeholder="Lieblingszitat aus dem Buch…" rows="2"></textarea>'
      + '<button class="btn-ghost" id="quoteAddBtn">+ Zitat speichern</button></div>'
      + '</div>';
  }

  // ───── Detail-Modal ─────
  var modalBook = null;
  function openDetail(b) {
    modalBook = b;
    var own = findInLib(b.id);
    var m = $('modal'), inner = $('modalInner');
    var facts = [];
    if (b.year) facts.push(b.year);
    if (b.pages) facts.push(b.pages + ' Seiten');
    (b.categories || []).slice(0, 3).forEach(function (c) { facts.push(c.split('/')[0].trim()); });
    if (b.gRating) facts.push('★ ' + b.gRating);
    var ser = seriesOf(b);
    if (ser) facts.push('📚 ' + ser.name + ' · Band ' + ser.num);
    if (own && own.startedAt) facts.push('▶ ' + fmtDate(own.startedAt));
    if (own && own.finishedAt) facts.push('✓ ' + fmtDate(own.finishedAt));

    var statusRow = ['read', 'reading', 'want'].map(function (s) {
      var on = own && own.status === s;
      return '<button class="status-btn' + (on ? ' active ' + s : '') + '" data-status="' + s + '">' + STATUS_LBL[s] + '</button>';
    }).join('');

    var stars = '';
    for (var i = 1; i <= 5; i++) {
      stars += '<button class="star' + (own && own.rating >= i ? ' on' : '') + '" data-rate="' + i + '" aria-label="' + i + ' Sterne">' + (own && own.rating >= i ? '★' : '☆') + '</button>';
    }

    inner.innerHTML =
      '<div class="detail-hero">'
      + (b.cover ? '<img src="' + esc(b.cover) + '" alt="" />' : '<div class="cover-fallback">📕</div>')
      + '<div class="titles"><h2>' + esc(b.title) + '</h2>'
      + '<div class="author">' + esc(b.authors.join(', ') || 'Unbekannt') + '</div>'
      + '<div class="facts">' + facts.map(function (f) { return '<span class="fact-pill">' + esc(f) + '</span>'; }).join('') + '</div>'
      + '</div></div>'
      + '<div class="detail-actions"><div class="status-btns">' + statusRow
      + (own ? '<button class="status-btn danger" data-remove="1">🗑️ Entfernen</button>' : '')
      + '</div></div>'
      + (own ? '<div class="rate-row" aria-label="Bewertung">' + stars + '</div>'
        + (own.status === 'reading' && (own.pages || 0) > 0
          ? '<div class="progress-edit"><label for="progInput">📖 Aktuelle Seite:</label>'
            + '<input id="progInput" type="number" min="0" max="' + own.pages + '" value="' + (own.progress || 0) + '" inputmode="numeric" />'
            + '<span class="progress-pct">' + Math.min(100, Math.round((own.progress || 0) / own.pages * 100)) + '% von ' + own.pages + '</span></div>'
          : '')
        + '<div class="tags-edit"><label for="tagsInput">🏷️ Regale/Tags (Komma-getrennt):</label>'
          + '<input id="tagsInput" type="text" placeholder="z. B. Klassiker, Urlaub 2026" value="' + esc((own.tags || []).join(', ')) + '" /></div>'
        + '<div style="padding:8px 18px 0"><textarea class="note-area" id="noteArea" placeholder="Deine Notizen zu diesem Buch…">' + esc(own.note || '') + '</textarea></div>'
        + quotesHtml(own)
        : '')
      + shopLinksHtml(b)
      + '<div class="detail-body">'
      + (b.desc ? '<h3>Beschreibung</h3><div class="desc">' + esc(b.desc.replace(/<[^>]+>/g, ' ')).slice(0, 2200) + '</div>' : '<p class="muted" style="margin-top:14px">Keine Beschreibung verfügbar.</p>')
      + '</div>';

    m.hidden = false;
    document.body.style.overflow = 'hidden';

    // Status-Buttons
    inner.querySelectorAll('.status-btn[data-status]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        upsertBook(b, btn.dataset.status);
        toast(STATUS_LBL[btn.dataset.status] + ' — gespeichert ✓');
        openDetail(b); // neu rendern (zeigt jetzt Sterne/Notiz)
      });
    });
    var rm = inner.querySelector('[data-remove]');
    if (rm) rm.addEventListener('click', function () {
      removeBook(b.id);
      toast('Aus der Sammlung entfernt');
      closeDetail();
    });
    inner.querySelectorAll('.star').forEach(function (st) {
      st.addEventListener('click', function () {
        var r = parseInt(st.dataset.rate, 10);
        var cur = findInLib(b.id);
        patchBook(b.id, { rating: (cur && cur.rating === r) ? 0 : r });
        openDetail(b);
      });
    });
    var na = inner.querySelector('#noteArea');
    if (na) na.addEventListener('change', function () { patchBook(b.id, { note: na.value }); toast('Notiz gespeichert ✓'); });

    // Lese-Fortschritt (Seite)
    var pi = inner.querySelector('#progInput');
    if (pi) pi.addEventListener('change', function () {
      var v = Math.max(0, Math.min(own.pages || 9999, parseInt(pi.value, 10) || 0));
      var patch = { progress: v };
      // Letzte Seite erreicht → als gelesen markieren
      if (own.pages && v >= own.pages) { patch.status = 'read'; patch.finishedAt = Date.now(); toast('🎉 Buch beendet — als „Gelesen" markiert!'); }
      else toast('Fortschritt gespeichert: Seite ' + v + ' ✓');
      patchBook(b.id, patch);
      openDetail(b);
    });

    // Tags/Regale
    var ti = inner.querySelector('#tagsInput');
    if (ti) ti.addEventListener('change', function () {
      var tags = ti.value.split(',').map(function (t) { return t.trim(); }).filter(Boolean).slice(0, 12);
      patchBook(b.id, { tags: tags });
      toast('Tags gespeichert ✓');
    });

    // Zitate
    var qa = inner.querySelector('#quoteAddBtn');
    if (qa) qa.addEventListener('click', function () {
      var inp = inner.querySelector('#quoteInput');
      var txt = (inp.value || '').trim();
      if (!txt) return;
      var cur = findInLib(b.id);
      var qs = (cur && cur.quotes || []).concat([{ text: txt.slice(0, 500), addedAt: Date.now() }]);
      patchBook(b.id, { quotes: qs });
      toast('Zitat gespeichert ✓');
      openDetail(b);
    });
    inner.querySelectorAll('.quote-del').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cur = findInLib(b.id);
        var qs = (cur && cur.quotes || []).slice();
        qs.splice(parseInt(btn.dataset.qi, 10), 1);
        patchBook(b.id, { quotes: qs });
        openDetail(b);
      });
    });

    // Open-Library-Bücher: Beschreibung lazy nachladen (steckt im Works-Endpoint)
    if (!b.desc && b.olKey) {
      fetch('https://openlibrary.org' + b.olKey + '.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (w) {
          if (!w || modalBook !== b) return;
          var d = w.description && (typeof w.description === 'string' ? w.description : w.description.value);
          if (!d) return;
          b.desc = d;
          var body = inner.querySelector('.detail-body');
          if (body) body.innerHTML = '<h3>Beschreibung</h3><div class="desc">' + esc(d.replace(/<[^>]+>/g, ' ')).slice(0, 2200) + '</div>';
          var own2 = findInLib(b.id);
          if (own2) patchBook(b.id, { desc: d });
        }).catch(function () {});
    }
  }
  function closeDetail() {
    $('modal').hidden = true;
    modalBook = null;
    document.body.style.overflow = '';
  }

  // Klick auf Karten (Delegation)
  document.addEventListener('click', function (e) {
    var card = e.target.closest('.card');
    if (!card) return;
    var id = card.dataset.id, src = card.dataset.src;
    var b = null;
    if (src === 'search') b = lastSearch.find(function (x) { return x.id === id; });
    else if (src === 'reco') { var r = lastReco.find(function (x) { return x.book.id === id; }); b = r && r.book; }
    else b = findInLib(id);
    if (b) openDetail(findInLib(id) || b);
  });

  // ───── Alles neu zeichnen ─────
  function refreshAll() {
    $('libBadge').textContent = lib().length;
    if (currentTab === 'home') renderHome();
    if (currentTab === 'sammlung') renderLib();
    if (currentTab === 'stats') renderStats();
  }
  // Cloud hat Daten geändert → UI aktualisieren (statt Reload)
  window.BKCloudOnChange = function () { recoBuiltFor = ''; refreshAll(); toast('☁️ Von der Cloud aktualisiert'); };

  // ───── Schnittstelle fürs Maskottchen (js/mascot.js) ─────
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function getMascotMessage() {
    var books = lib();
    if (!books.length) {
      return pick([
        { text: 'Huhu, ich bin Fuku! 🦉 Füge unter „Entdecken" dein erstes Buch hinzu.' },
        { text: 'Eine leere Bibliothek? Das ändern wir! Such mal nach deinem Lieblingsbuch. 📚' }
      ]);
    }
    var pool = [];
    var reading = books.filter(function (b) { return b.status === 'reading'; });
    if (reading.length) {
      var r = pick(reading);
      pool.push({ text: 'Wie läuft es mit „' + r.title + '"? Schon weitergelesen? 📖', id: r.id, kind: 'lib' });
    }
    var want = books.filter(function (b) { return b.status === 'want'; });
    if (want.length) {
      var w = pick(want);
      pool.push({ text: 'Auf deiner Wunschliste wartet noch „' + w.title + '". Heute anfangen? ✨', id: w.id, kind: 'lib' });
    }
    if (lastReco.length) {
      var rec = pick(lastReco.slice(0, 8));
      pool.push({ text: 'Tipp für dich: „' + rec.book.title + '"' + (rec.book.authors[0] ? ' von ' + rec.book.authors[0] : '') + '. ' + rec.reason + '!', id: rec.book.id, kind: 'reco' });
    }
    var read = books.filter(function (b) { return b.status === 'read'; });
    if (read.length) {
      var pages = read.reduce(function (s, b) { return s + (b.pages || 0); }, 0);
      pool.push({ text: 'Schon ' + read.length + ' Bücher und ' + pages.toLocaleString('de-DE') + ' Seiten gelesen — stark! 🎉' });
      var best = read.filter(function (b) { return (b.rating || 0) >= 4; });
      if (best.length) pool.push({ text: '„' + pick(best).title + '" fandst du klasse — unter „Für dich" gibt es Ähnliches! ⭐' });
    }
    pool.push({ text: pick(['Ein Kapitel am Tag hält den Bücherwurm wach! 🐛', 'Wusstest du? Lesen vor dem Schlafen verbessert den Schlaf. 😴', 'Schau mal in die Statistik — deine Lese-Bilanz wächst! 📊']) });
    return pick(pool);
  }
  function openById(id, kind) {
    var b = null;
    if (kind === 'reco') { var r = lastReco.find(function (x) { return x.book.id === id; }); b = r && r.book; }
    if (!b) b = findInLib(id);
    if (b) openDetail(findInLib(id) || b);
  }
  window.HonApp = { getMascotMessage: getMascotMessage, openById: openById };

  // ───── Export / Import ─────
  function exportJson() {
    var blob = new Blob([JSON.stringify({ app: 'hon-buecher', v: 1, books: lib() }, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hon-buecher-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('Export erstellt ✓');
  }
  function importJson(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var j = JSON.parse(rd.result);
        var arr = Array.isArray(j) ? j : (j.books || []);
        if (!Array.isArray(arr)) throw new Error('Format');
        var all = loadBooks(), added = 0;
        arr.forEach(function (b) {
          if (!b || !b.id || !b.title) return;
          var idx = all.findIndex(function (x) { return x.id === b.id; });
          if (idx >= 0) { if ((b.updatedAt || 0) > (all[idx].updatedAt || 0)) all[idx] = b; }
          else { all.push(b); added++; }
        });
        saveBooks(all);
        refreshAll();
        toast(added + ' Bücher importiert ✓');
      } catch (e) { toast('Import fehlgeschlagen — keine gültige Backup-Datei'); }
    };
    rd.readAsText(file);
  }

  // ───── Goodreads-CSV Import/Export ─────
  function csvParse(text) {
    var rows = [], row = [], cell = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  function importGoodreads(file) {
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var rows = csvParse(String(rd.result));
        if (rows.length < 2) throw new Error('leer');
        var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
        function col(name) { return head.indexOf(name.toLowerCase()); }
        var iT = col('Title'), iA = col('Author'), iI = col('ISBN13'), iR = col('My Rating'),
            iS = col('Exclusive Shelf'), iD = col('Date Read'), iP = col('Number of Pages');
        if (iT < 0) throw new Error('Kein Goodreads-Format (Spalte „Title" fehlt)');
        var all = loadBooks(), added = 0, now = Date.now();
        var shelfMap = { 'read': 'read', 'currently-reading': 'reading', 'to-read': 'want' };
        rows.slice(1).forEach(function (r) {
          var title = (r[iT] || '').trim();
          if (!title) return;
          var isbn = iI >= 0 ? (r[iI] || '').replace(/[^0-9Xx]/g, '') : '';
          var author = iA >= 0 ? (r[iA] || '').trim() : '';
          var id = 'gr-' + (isbn || (title + '|' + author).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40));
          if (all.some(function (x) { return x.id === id; })) return;
          var key = (title + '|' + author).toLowerCase().replace(/[^a-zäöüß0-9|]/g, '');
          if (all.some(function (x) { return !x.deleted && bookKey(x) === key; })) return;
          var dateRead = iD >= 0 && r[iD] ? new Date(r[iD]).getTime() || 0 : 0;
          var status = shelfMap[(iS >= 0 ? r[iS] : 'read').trim()] || 'read';
          all.push({
            id: id, title: title, authors: author ? [author] : [],
            cover: isbn ? ('https://covers.openlibrary.org/b/isbn/' + isbn + '-M.jpg') : '',
            year: '', pages: iP >= 0 ? (parseInt(r[iP], 10) || 0) : 0,
            categories: [], desc: '', lang: '', isbn: isbn, gRating: 0,
            status: status, rating: iR >= 0 ? (parseInt(r[iR], 10) || 0) : 0,
            note: '', progress: 0, tags: ['Goodreads-Import'], quotes: [],
            startedAt: status !== 'want' ? (dateRead || now) : 0,
            finishedAt: status === 'read' ? (dateRead || now) : 0,
            addedAt: dateRead || now, updatedAt: now
          });
          added++;
        });
        saveBooks(all);
        refreshAll();
        toast('📥 ' + added + ' Bücher aus Goodreads importiert ✓');
      } catch (e) { toast('Import fehlgeschlagen: ' + e.message); }
    };
    rd.readAsText(file);
  }

  function csvCell(s) { s = String(s == null ? '' : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function exportGoodreadsCsv() {
    var shelfMap = { read: 'read', reading: 'currently-reading', want: 'to-read' };
    var head = 'Title,Author,ISBN13,My Rating,Exclusive Shelf,Date Read,Number of Pages';
    var lines = lib().map(function (b) {
      var dr = b.finishedAt ? new Date(b.finishedAt).toISOString().slice(0, 10).replace(/-/g, '/') : '';
      return [b.title, (b.authors || [])[0] || '', b.isbn || '', b.rating || 0, shelfMap[b.status] || 'read', dr, b.pages || ''].map(csvCell).join(',');
    });
    var blob = new Blob(['﻿' + head + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hon-goodreads-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    toast('CSV-Export erstellt ✓');
  }

  // ───── ISBN-Barcode-Scanner (BarcodeDetector-API, Chrome/Edge/Android) ─────
  var scanStream = null, scanTimer = null;
  function stopScanner() {
    clearInterval(scanTimer); scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    var m = document.getElementById('scanModal');
    if (m) m.remove();
  }
  function startScanner() {
    if (!('BarcodeDetector' in window)) {
      toast('📷 Dein Browser kann leider keine Barcodes scannen (iOS Safari) — tippe die ISBN einfach ins Suchfeld.');
      $('searchInput').focus();
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Keine Kamera verfügbar — ISBN bitte ins Suchfeld tippen.');
      return;
    }
    var m = document.createElement('div');
    m.id = 'scanModal';
    m.className = 'scan-modal';
    m.innerHTML = '<div class="scan-inner"><video id="scanVideo" playsinline autoplay muted></video>'
      + '<div class="scan-frame"></div>'
      + '<p class="scan-hint">Barcode (ISBN) auf der Buchrückseite in den Rahmen halten</p>'
      + '<button class="btn-ghost" id="scanCancel">Abbrechen</button></div>';
    document.body.appendChild(m);
    document.getElementById('scanCancel').addEventListener('click', stopScanner);
    m.addEventListener('click', function (e) { if (e.target === m) stopScanner(); });

    var detector;
    try { detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8'] }); }
    catch (e) { stopScanner(); toast('Barcode-Scanner konnte nicht starten.'); return; }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      scanStream = stream;
      var video = document.getElementById('scanVideo');
      if (!video) { stopScanner(); return; }
      video.srcObject = stream;
      scanTimer = setInterval(function () {
        if (!video.videoWidth) return;
        detector.detect(video).then(function (codes) {
          if (!codes || !codes.length) return;
          var isbn = (codes[0].rawValue || '').replace(/[^0-9Xx]/g, '');
          if (isbn.length < 10) return;
          stopScanner();
          toast('✓ ISBN erkannt: ' + isbn);
          $('searchInput').value = isbn;
          doSearch(isbn);
        }).catch(function () {});
      }, 350);
    }).catch(function () {
      stopScanner();
      toast('Kamera-Zugriff abgelehnt — ISBN bitte ins Suchfeld tippen.');
    });
  }

  // ───── 🎲 „Was lese ich als Nächstes?" — Cover-Roulette ─────
  function rollNext() {
    var books = lib();
    var pool = books.filter(function (b) { return b.status === 'want'; });
    if (!pool.length) pool = books.filter(function (b) { return b.status !== 'read'; });
    if (!pool.length) { toast('Alles gelesen! Hol dir Nachschub unter „Für dich" ✨'); return; }
    var winner = pool[Math.floor(Math.random() * pool.length)];

    var m = document.createElement('div');
    m.className = 'roll-modal';
    m.innerHTML = '<div class="roll-inner"><div class="roll-title">🎲 Dein nächstes Buch…</div>'
      + '<div class="roll-cover" id="rollCover"></div><div class="roll-name" id="rollName"></div></div>';
    document.body.appendChild(m);
    var cov = document.getElementById('rollCover'), nam = document.getElementById('rollName');
    var i = 0, spins = Math.min(14, pool.length * 3 + 4);
    var iv = setInterval(function () {
      var b = (i < spins - 1) ? pool[Math.floor(Math.random() * pool.length)] : winner;
      cov.innerHTML = b.cover ? '<img src="' + esc(b.cover) + '" alt="" />' : '<div class="cover-fallback" style="width:110px;aspect-ratio:2/3;display:flex;align-items:center;justify-content:center;font-size:30px;">📕</div>';
      nam.textContent = b.title;
      i++;
      if (i >= spins) {
        clearInterval(iv);
        cov.classList.add('winner');
        setTimeout(function () { m.remove(); openDetail(findInLib(winner.id) || winner); }, 1100);
      }
    }, i < 6 ? 120 : 180);
    m.addEventListener('click', function () { clearInterval(iv); m.remove(); });
  }

  // ───── Theme & Einstellungen ─────
  var sysDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function themeMode() {
    var s = loadSettings();
    return s.themeMode || s.theme || 'dark'; // s.theme = Altbestand aus v1/v2
  }
  function applySettings() {
    var s = loadSettings();
    var mode = themeMode();
    var effective = mode === 'auto' ? ((sysDark && sysDark.matches) ? 'dark' : 'light') : mode;
    document.documentElement.dataset.theme = effective;
    $('themeToggle').textContent = mode === 'auto' ? '🌗' : (effective === 'dark' ? '🌙' : '☀️');
    document.documentElement.dataset.reduced = s.reduced ? '1' : '';
    $('setReducedMotion').checked = !!s.reduced;
    var tm = $('setThemeMode'); if (tm) tm.value = mode;
    var gi = $('setGoal'); if (gi) gi.value = parseInt(s.goal, 10) || 0;
  }
  if (sysDark && sysDark.addEventListener) sysDark.addEventListener('change', function () {
    if (themeMode() === 'auto') applySettings();
  });

  // ───── Init ─────
  function init() {
    applySettings();
    refreshAll();
    renderHome();

    // Tabs
    $('mainTabs').addEventListener('click', function (e) {
      var t = e.target.closest('.tab'); if (t) switchTab(t.dataset.tab);
    });
    $('homeStartBtn').addEventListener('click', function () { switchTab('suche'); $('searchInput').focus(); });
    $('homeTipMore').addEventListener('click', function () { switchTab('tipps'); });

    // Suche
    $('searchBtn').addEventListener('click', function () { doSearch($('searchInput').value); });
    $('searchInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(e.target.value); });
    $('quickChips').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c) return;
      document.querySelectorAll('#quickChips .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
      doSearch(c.dataset.q);
    });

    // Sammlung: Filter
    ['filterStatus', 'filterGenre', 'sortLib'].forEach(function (id) {
      $(id).addEventListener('change', renderLib);
    });
    $('exportBtn').addEventListener('click', exportJson);

    // Empfehlungen
    $('recoRefresh').addEventListener('click', function () { renderReco(true); });

    // Modal
    $('modalClose').addEventListener('click', closeDetail);
    $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeDetail(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('modal').hidden) closeDetail(); });

    // Theme: Button wechselt Dunkel → Hell → Auto
    $('themeToggle').addEventListener('click', function () {
      var s = loadSettings();
      var order = ['dark', 'light', 'auto'];
      var next = order[(order.indexOf(themeMode()) + 1) % 3];
      s.themeMode = next; delete s.theme;
      saveSettings(s); applySettings();
      toast(next === 'auto' ? '🌗 Theme: automatisch (System)' : next === 'dark' ? '🌙 Dunkles Theme' : '☀️ Helles Papier-Theme');
    });
    $('setThemeMode').addEventListener('change', function (e) {
      var s = loadSettings(); s.themeMode = e.target.value; delete s.theme; saveSettings(s); applySettings();
    });
    $('setReducedMotion').addEventListener('change', function (e) {
      var s = loadSettings(); s.reduced = e.target.checked; saveSettings(s); applySettings();
    });
    $('setGoal').addEventListener('change', function (e) {
      var s = loadSettings(); s.goal = Math.max(0, parseInt(e.target.value, 10) || 0); saveSettings(s); applySettings();
      toast(s.goal ? '🎯 Lese-Ziel: ' + s.goal + ' Bücher pro Jahr' : 'Lese-Ziel deaktiviert');
      renderHome();
    });

    // Scanner + Zufallsrad + Tag-Filter
    $('scanBtn').addEventListener('click', startScanner);
    $('rollBtn').addEventListener('click', rollNext);
    $('filterTag').addEventListener('change', renderLib);

    // Goodreads CSV
    $('setGrImport').addEventListener('click', function () { $('grImportFile').click(); });
    $('grImportFile').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importGoodreads(e.target.files[0]);
      e.target.value = '';
    });
    $('setGrExport').addEventListener('click', exportGoodreadsCsv);

    // Einstellungen: Cloud + Daten
    $('cloud-open-btn').addEventListener('click', function () { if (window.BKCloud) window.BKCloud.openModal(); });
    $('setExport').addEventListener('click', exportJson);
    $('setImport').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });

    // Topbar-Schatten beim Scrollen
    var topbar = document.querySelector('.topbar');
    window.addEventListener('scroll', function () {
      topbar.classList.toggle('scrolled', window.scrollY > 8);
    }, { passive: true });

    // Service Worker
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
