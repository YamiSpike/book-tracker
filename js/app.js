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

  // ───── Google-Books-Normalisierung ─────
  function normVolume(v) {
    var vi = v.volumeInfo || {};
    var img = (vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail)) || '';
    if (img) img = img.replace(/^http:/, 'https:');
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
      + '&fields=key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject,language,ratings_average';
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
          gRating: d.ratings_average ? Math.round(d.ratings_average * 10) / 10 : 0
        };
      }).filter(function (b) { return b.title; });
    });
  }

  // Erst Google Books (bessere Beschreibungen), bei Fehler/Quota automatisch Open Library
  function searchBooks(q, maxResults) {
    return gbSearch(q, maxResults).then(function (items) {
      if (items.length) return items;
      return olSearch(q, maxResults);
    }).catch(function () {
      return olSearch(q, maxResults);
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
  function upsertBook(b, status) {
    var all = loadBooks();
    var idx = all.findIndex(function (x) { return x.id === b.id; });
    var now = Date.now();
    if (idx >= 0) {
      all[idx] = Object.assign({}, all[idx], { status: status || all[idx].status, deleted: false, updatedAt: now });
    } else {
      all.push(Object.assign({}, b, { status: status || 'read', rating: 0, note: '', addedAt: now, updatedAt: now }));
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
    return '<article class="card" data-id="' + esc(b.id) + '" data-src="' + esc(opts.src || 'lib') + '">'
      + chip + mark + coverHtml(b)
      + reason
      + '<div class="meta"><div class="title">' + esc(b.title) + '</div>'
      + '<div class="author">' + esc(b.authors.join(', ') || '–') + '</div>' + stars + '</div></article>';
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
    hero.innerHTML = '<span class="hero-kanji">本</span>'
      + '<h2>' + greet + ', Leseratte!</h2>'
      + '<p>Deine persönliche Bibliothek — gesichert in der Cloud.</p>'
      + '<div class="hero-stats">'
      + '<div class="hero-stat"><b>' + read.length + '</b><span>gelesen</span></div>'
      + '<div class="hero-stat"><b>' + reading.length + '</b><span>am Lesen</span></div>'
      + '<div class="hero-stat"><b>' + pages.toLocaleString('de-DE') + '</b><span>Seiten</span></div>'
      + '</div>';

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
    var st = $('filterStatus').value, ge = $('filterGenre').value, sort = $('sortLib').value;

    // Genre-Filter-Optionen aktuell halten
    var genres = {};
    books.forEach(function (b) { (b.categories || []).forEach(function (c) { genres[c.split('/')[0].trim()] = 1; }); });
    var sel = $('filterGenre'), cur = sel.value;
    sel.innerHTML = '<option value="">Alle Genres</option>' + Object.keys(genres).sort().map(function (g) {
      return '<option value="' + esc(g) + '"' + (g === cur ? ' selected' : '') + '>' + esc(g) + '</option>';
    }).join('');

    var out = books.filter(function (b) {
      if (st && b.status !== st) return false;
      if (ge && !(b.categories || []).some(function (c) { return c.split('/')[0].trim() === ge; })) return false;
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
    $('statsBars').innerHTML = books.length
      ? barBlock('📚 Top-Genres', gen) + barBlock('✍️ Top-Autor·innen', aut) + barBlock('🗓️ Hinzugefügt pro Jahr', yrs)
      : '<div class="empty"><div class="big">📊</div><p>Noch keine Daten — füge zuerst Bücher hinzu.</p></div>';
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
    if (b.gRating) facts.push('★ ' + b.gRating + ' (Google)');

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
        + '<div style="padding:8px 18px 0"><textarea class="note-area" id="noteArea" placeholder="Deine Notizen zu diesem Buch…">' + esc(own.note || '') + '</textarea></div>'
        : '')
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

  // ───── Theme & Einstellungen ─────
  function applySettings() {
    var s = loadSettings();
    document.documentElement.dataset.theme = s.theme || 'dark';
    $('themeToggle').textContent = (s.theme || 'dark') === 'dark' ? '🌙' : '☀️';
    document.documentElement.dataset.reduced = s.reduced ? '1' : '';
    $('setReducedMotion').checked = !!s.reduced;
  }

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

    // Theme
    $('themeToggle').addEventListener('click', function () {
      var s = loadSettings();
      s.theme = (s.theme || 'dark') === 'dark' ? 'light' : 'dark';
      saveSettings(s); applySettings();
    });
    $('setReducedMotion').addEventListener('change', function (e) {
      var s = loadSettings(); s.reduced = e.target.checked; saveSettings(s); applySettings();
    });

    // Einstellungen: Cloud + Daten
    $('cloud-open-btn').addEventListener('click', function () { if (window.BKCloud) window.BKCloud.openModal(); });
    $('setExport').addEventListener('click', exportJson);
    $('setImport').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = '';
    });

    // Service Worker
    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
