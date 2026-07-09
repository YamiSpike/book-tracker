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
  // v4: Read-only-Modus für geteilte Sammlungen (?share=…)
  var sharedData = null;

  // aktive Bücher (ohne Lösch-Tombstones, die nur für den Sync existieren)
  function lib() {
    if (sharedData) return sharedData;
    return loadBooks().filter(function (b) { return !b.deleted; });
  }

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSettings(s) { try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch (e) {} }

  // ───── v4: Lese-Sessions (Timer) ─────
  var LS_SESSIONS = 'bk_sessions', LS_ACTIVE = 'bk_active_session', LS_ACH = 'bk_achievements';
  function loadSessions() {
    try { var a = JSON.parse(localStorage.getItem(LS_SESSIONS) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function saveSessions(a) { try { localStorage.setItem(LS_SESSIONS, JSON.stringify(a)); } catch (e) {} }

  // Lese-Termine je Buch (für Challenge + Re-Read): readDates = [ts, ...]
  function readDatesOf(b) {
    if (Array.isArray(b.readDates) && b.readDates.length) return b.readDates;
    return b.finishedAt ? [b.finishedAt] : [];
  }

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
  var STATUS_LBL = { read: '✓ Gelesen', reading: '📖 Lese gerade', want: '🔖 Will lesen', dnf: '🚫 Abgebrochen' };
  var FORMAT_LBL = { print: '📕 Print', ebook: '📱 E-Book', audio: '🎧 Hörbuch' };

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
      publisher: vi.publisher || '',
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

  // ───── v4/v5: Manga-Quellen (AniList + Jikan/MAL + deutsche Verlage via Google Books) ─────
  function normManga(o) {
    return {
      id: o.id, title: o.title, authors: o.authors, cover: o.cover,
      year: o.year, pages: 0, volumes: o.volumes || 0, chapters: o.chapters || 0,
      categories: (o.genres || []).map(function (g) { return 'Manga / ' + g; }),
      desc: o.desc || '', lang: o.lang || '', isbn: o.isbn || '', publisher: o.publisher || '',
      gRating: o.score || 0, kind: 'manga'
    };
  }

  // Deutsche Manga-Verlagsausgaben über Google Books: liefern ISBN (→ scannbar), Verlag & Cover.
  // Genau die „Verlagssammlung": Carlsen, Egmont, KAZÉ/Crunchyroll, altraverse, TOKYOPOP, Panini …
  var DE_MANGA_VERLAGE = /carlsen|egmont|kaz[eé]|crunchyroll|altraverse|tokyopop|panini|manga\s*cult|hayabusa|reprodukt|dani ?books|planet\s*manga/i;
  function gbMangaSearch(q, maxResults) {
    var url = GB + '?q=' + encodeURIComponent(q + ' manga') + '&maxResults=' + (maxResults || 20)
      + '&printType=books&langRestrict=de';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Google Books nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      return (j.items || []).map(normVolume).filter(function (b) {
        // Nur echte Manga-Verlagsausgaben (Verlag passt ODER Kategorie „Comics")
        var cat = (b.categories || []).join(' ');
        return b.title && (DE_MANGA_VERLAGE.test(b.publisher || '') || /comic|graphic novel|manga/i.test(cat));
      }).map(function (b) {
        return normManga({
          id: b.id, title: b.title, authors: b.authors, cover: b.cover,
          year: b.year, isbn: b.isbn, publisher: b.publisher,
          genres: (b.categories || []).map(function (c) { return c.split('/')[0].trim(); }),
          desc: b.desc, lang: 'de', score: b.gRating
        });
      });
    });
  }

  function alSearch(q, maxResults) {
    var gql = 'query($s:String,$n:Int){Page(perPage:$n){media(search:$s,type:MANGA,sort:SEARCH_MATCH){' +
      'id title{romaji english} coverImage{large} description(asHtml:false) genres chapters volumes ' +
      'startDate{year} averageScore staff(perPage:4){edges{role node{name{full}}}}}}}';
    return fetch('https://graphql.anilist.co', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { s: q, n: Math.min(maxResults || 15, 20) } })
    }).then(function (r) {
      if (!r.ok) throw new Error('AniList nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      return (((j.data || {}).Page || {}).media || []).map(function (m) {
        var authors = ((m.staff || {}).edges || [])
          .filter(function (e) { return /story|art/i.test(e.role || ''); })
          .map(function (e) { return e.node.name.full; }).slice(0, 2);
        return normManga({
          id: 'al-' + m.id,
          title: (m.title && (m.title.english || m.title.romaji)) || '',
          authors: authors,
          cover: (m.coverImage && m.coverImage.large) || '',
          year: m.startDate && m.startDate.year ? String(m.startDate.year) : '',
          volumes: m.volumes, chapters: m.chapters,
          genres: m.genres, desc: m.description || '',
          score: m.averageScore ? Math.round(m.averageScore / 20 * 10) / 10 : 0
        });
      }).filter(function (b) { return b.title; });
    });
  }

  function jikanSearch(q, maxResults) {
    return fetch('https://api.jikan.moe/v4/manga?q=' + encodeURIComponent(q) + '&limit=' + Math.min(maxResults || 15, 20) + '&sfw=true')
      .then(function (r) {
        if (!r.ok) throw new Error('Jikan nicht erreichbar (' + r.status + ')');
        return r.json();
      }).then(function (j) {
        return (j.data || []).map(function (m) {
          return normManga({
            id: 'mal-' + m.mal_id,
            title: m.title || '',
            authors: (m.authors || []).map(function (a) { return a.name.split(', ').reverse().join(' '); }).slice(0, 2),
            cover: (m.images && m.images.jpg && m.images.jpg.image_url) || '',
            year: m.published && m.published.from ? String(m.published.from).slice(0, 4) : '',
            volumes: m.volumes, chapters: m.chapters,
            genres: (m.genres || []).map(function (g) { return g.name; }),
            desc: m.synopsis || '',
            score: m.score ? Math.round(m.score) / 2 : 0
          });
        }).filter(function (b) { return b.title; });
      });
  }

  function searchMangas(q, maxResults) {
    // AniList + Jikan (Metadaten/Genres/Score) + Google Books DE (Verlag + ISBN der deutschen Ausgabe)
    return Promise.allSettled([alSearch(q, maxResults), jikanSearch(q, maxResults), gbMangaSearch(q, 15)]).then(function (rs) {
      var lists = rs.map(function (r) { return r.status === 'fulfilled' ? r.value : []; });
      var map = Object.create(null), order = [];
      lists.forEach(function (list) {
        list.forEach(function (b) {
          var k = bookKey(b);
          if (!map[k]) { map[k] = b; order.push(k); return; }
          var prev = map[k];
          if (!prev.cover && b.cover) prev.cover = b.cover;
          if (!prev.desc && b.desc) prev.desc = b.desc;
          if (!prev.volumes && b.volumes) prev.volumes = b.volumes;
          // Verlag + ISBN der deutschen Ausgabe in den Haupttreffer übernehmen
          if (!prev.isbn && b.isbn) prev.isbn = b.isbn;
          if (!prev.publisher && b.publisher) prev.publisher = b.publisher;
        });
      });
      var merged = order.map(function (k) { return map[k]; });
      // Einträge mit Cover zuerst
      merged.sort(function (a, b) { return (b.cover ? 1 : 0) - (a.cover ? 1 : 0); });
      if (!merged.length) throw new Error('Keine Manga-Quelle erreichbar. Bitte später erneut versuchen.');
      return merged;
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
      var rd = existing ? readDatesOf(existing).slice() : [];
      if (!rd.length) rd.push((existing && existing.finishedAt) || now);
      p.readDates = rd;
    }
    return p;
  }
  function upsertBook(b, status) {
    if (sharedData) { toast('👀 Nur-Lese-Ansicht — Änderungen sind hier deaktiviert.'); return; }
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
    if (sharedData) { toast('👀 Nur-Lese-Ansicht — Änderungen sind hier deaktiviert.'); return; }
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
    var kind = b.kind === 'manga' ? '<span class="kind-chip" title="Manga">🎌</span>' : '';
    return '<article class="card" data-id="' + esc(b.id) + '" data-src="' + esc(opts.src || 'lib') + '">'
      + chip + mark + kind + coverHtml(b)
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
    // Zählt auch Re-Reads: jeder Lese-Abschluss im laufenden Jahr = 1 Punkt
    var doneThisYear = 0;
    read.forEach(function (b) {
      var rd = readDatesOf(b);
      if (!rd.length && b.addedAt) rd = [b.addedAt];
      rd.forEach(function (ts) { if (new Date(ts).getFullYear() === yr) doneThisYear++; });
    });
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

    // v4: Erscheinungs-Radar — Wunschbücher, die erst in der Zukunft erscheinen
    var radarSec = $('homeRadarSection');
    if (radarSec) {
      var upcoming = books.filter(function (b) {
        return b.status === 'want' && parseInt(b.year, 10) > yr;
      });
      radarSec.hidden = upcoming.length === 0;
      $('homeRadar').innerHTML = upcoming.slice(0, 6).map(function (b) {
        return cardHtml(b, { showStatus: false, reason: '📅 erscheint ' + esc(b.year), src: 'lib' });
      }).join('');
    }

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
  var lastSimilar = [];    // v6: „Ähnliche finden"-Ergebnisse im Detail
  var searchMode = 'buch'; // 'buch' | 'manga'
  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    var grid = $('searchGrid');
    $('searchEmpty').hidden = true;
    grid.innerHTML = '<div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    (searchMode === 'manga' ? searchMangas(q, 20) : searchBooks(q, 20)).then(function (items) {
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
    var kd = $('filterKind') ? $('filterKind').value : '';
    var vl = $('filterPublisher') ? $('filterPublisher').value : '';

    // Verlags-Filter-Optionen (v5)
    var pubs = {};
    books.forEach(function (b) { if (b.publisher) pubs[b.publisher] = 1; });
    var psel = $('filterPublisher'), pcur = psel ? psel.value : '';
    if (psel) {
      psel.innerHTML = '<option value="">Alle Verlage</option>' + Object.keys(pubs).sort().map(function (p) {
        return '<option value="' + esc(p) + '"' + (p === pcur ? ' selected' : '') + '>🏢 ' + esc(p) + '</option>';
      }).join('');
      psel.style.display = Object.keys(pubs).length ? '' : 'none';
    }
    // Typ-Filter nur zeigen, wenn Mangas dabei sind
    var hasManga = books.some(function (b) { return b.kind === 'manga'; });
    if ($('filterKind')) $('filterKind').style.display = hasManga ? '' : 'none';

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

    // v4: Live-Suche in der eigenen Sammlung (Titel, Autor·in, Notizen, Zitate, Tags)
    var q = ($('libSearch') ? $('libSearch').value : '').trim().toLowerCase();
    var out = books.filter(function (b) {
      if (st && b.status !== st) return false;
      if (ge && !(b.categories || []).some(function (c) { return c.split('/')[0].trim() === ge; })) return false;
      if (tg && !(b.tags || []).some(function (t) { return t === tg; })) return false;
      if (kd === 'manga' && b.kind !== 'manga') return false;
      if (kd === 'buch' && b.kind === 'manga') return false;
      if (vl && b.publisher !== vl) return false;
      if (q) {
        var hay = (b.title + ' ' + (b.authors || []).join(' ') + ' ' + (b.note || '') + ' '
          + (b.publisher || '') + ' '
          + (b.tags || []).join(' ') + ' ' + (b.quotes || []).map(function (x) { return x.text; }).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
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
    // Manga-Profil: Lieblings-Genres deiner Mangas → AniList-Empfehlungen
    var mangas = books.filter(function (b) { return b.kind === 'manga'; });
    if (mangas.length) {
      var mg = {};
      mangas.forEach(function (b) {
        var w = (b.rating || 3);
        (b.categories || []).forEach(function (c) {
          var g = (c.split('/')[1] || '').trim();
          if (g) mg[g] = (mg[g] || 0) + w;
        });
      });
      Object.keys(mg).sort(function (a, b2) { return mg[b2] - mg[a]; }).slice(0, 2).forEach(function (g) {
        queries.push({ q: g, reason: 'Weil du Mangas („' + g + '") liest', manga: true });
      });
    }
    if (!queries.length) {
      // Sammlung ohne Genre-/Autor-Daten → Titel-basiert suchen
      var t = books[0].title.split(' ').slice(0, 3).join(' ');
      queries.push({ q: t, reason: 'Ähnlich wie „' + books[0].title + '"' });
    }

    return Promise.all(queries.map(function (Q) {
      return (Q.manga ? searchMangas(Q.q, 10) : searchBooks(Q.q, 12)).then(function (items) {
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

    // v4: Lesezeit (Timer-Sessions) + geschätzter Bibliotheks-Wert + Streak
    var mins = loadSessions().reduce(function (s, x) { return s + (x.minutes || 0); }, 0);
    var aStats = achStats();
    var worth = books.length * 12; // Spielerei: Ø ~12 € pro Buch
    $('statsGrid').innerHTML =
      '<div class="stat-card"><b>' + read.length + '</b><span>Bücher gelesen</span></div>'
      + '<div class="stat-card"><b>' + pages.toLocaleString('de-DE') + '</b><span>Seiten gelesen</span></div>'
      + '<div class="stat-card"><b>' + books.filter(function (b) { return b.status === 'reading'; }).length + '</b><span>Lese gerade</span></div>'
      + '<div class="stat-card"><b>' + books.filter(function (b) { return b.status === 'want'; }).length + '</b><span>Will lesen</span></div>'
      + '<div class="stat-card"><b>' + avg + '</b><span>Ø Bewertung</span></div>'
      + (mins ? '<div class="stat-card"><b>' + (mins >= 120 ? Math.round(mins / 60) + ' h' : mins + ' min') + '</b><span>Lesezeit (Timer)</span></div>' : '')
      + (aStats.streak > 1 ? '<div class="stat-card"><b>' + aStats.streak + ' 🔥</b><span>Tage-Streak</span></div>' : '')
      + '<div class="stat-card"><b>~' + worth.toLocaleString('de-DE') + ' €</b><span>Bibliotheks-Wert</span></div>';

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

    // v4: Erfolge-Galerie
    function achHtml() {
      var unlocked = loadAch();
      var cells = ACH_DEFS.map(function (d) {
        var on = !!unlocked[d.id];
        return '<div class="ach' + (on ? ' on' : '') + '" title="' + esc(d.desc) + '">'
          + '<span class="ach-ico">' + (on ? d.icon : '🔒') + '</span>'
          + '<span class="ach-name">' + esc(d.name) + '</span>'
          + (on ? '<span class="ach-date">' + fmtDate(unlocked[d.id]) + '</span>' : '<span class="ach-date">' + esc(d.desc) + '</span>')
          + '</div>';
      }).join('');
      return '<h2 style="font-size:16px;margin-top:22px">🏆 Erfolge</h2><div class="ach-grid">' + cells + '</div>';
    }

    $('statsBars').innerHTML = books.length
      ? '<div style="margin-top:14px"><button class="btn-primary" id="yearReviewBtn">📚 Dein Lesejahr ' + new Date().getFullYear() + '</button></div>'
        + heatmapHtml() + achHtml() + seriesHtml() + barBlock('📚 Top-Genres', gen) + barBlock('✍️ Top-Autor·innen', aut) + barBlock('🗓️ Hinzugefügt pro Jahr', yrs)
      : '<div class="empty"><div class="big">📊</div><p>Noch keine Daten — füge zuerst Bücher hinzu.</p></div>';
    var yb = document.getElementById('yearReviewBtn');
    if (yb) yb.addEventListener('click', openYearReview);
  }

  // v6: Fertig-Prognose für „Lese gerade" — aus Timer-Tempo oder Seiten/Tag seit Start
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
    if (b.kind === 'manga') {
      facts.push('🎌 Manga');
      if (b.volumes) facts.push(b.volumes + ' Bände');
      if (b.chapters) facts.push(b.chapters + ' Kapitel');
    }
    if (b.publisher) facts.push('🏢 ' + b.publisher);
    if (own && own.format && FORMAT_LBL[own.format]) facts.push(FORMAT_LBL[own.format]);
    if (b.year) facts.push(b.year);
    if (b.pages) facts.push(b.pages + ' Seiten');
    // Manga-Kategorien heißen „Manga / Genre" → Genre zeigen, nicht dreimal „Manga"
    (b.categories || []).slice(0, 3).forEach(function (c) {
      var parts = c.split('/');
      facts.push((b.kind === 'manga' ? parts[parts.length - 1] : parts[0]).trim());
    });
    if (b.gRating) facts.push('★ ' + b.gRating);
    var ser = seriesOf(b);
    if (ser) facts.push('📚 ' + ser.name + ' · Band ' + ser.num);
    if (own && own.startedAt) facts.push('▶ ' + fmtDate(own.startedAt));
    if (own && own.finishedAt) facts.push('✓ ' + fmtDate(own.finishedAt));
    if (own && own.status === 'dnf' && own.dnfReason) facts.push('🚫 ' + own.dnfReason);

    var statusRow = sharedData ? '' : ['read', 'reading', 'want', 'dnf'].map(function (s) {
      var on = own && own.status === s;
      // „Abgebrochen" nur zeigen, wenn schon in Sammlung (kein Erst-Status)
      if (s === 'dnf' && !own) return '';
      return '<button class="status-btn' + (on ? ' active ' + s : '') + '" data-status="' + s + '">' + STATUS_LBL[s] + '</button>';
    }).join('');
    // v4: kontextabhängige Aktionen
    if (own && own.status === 'reading') {
      var act = activeSess();
      statusRow += (act && act.bookId === b.id)
        ? '<button class="status-btn active read" data-timer="stop">■ Session beenden</button>'
        : '<button class="status-btn" data-timer="start">▶ Jetzt lesen</button>';
    }
    if (own && own.status === 'read') {
      var n = readDatesOf(own).length;
      statusRow += '<button class="status-btn" data-reread="1">🔁 Nochmal gelesen' + (n > 1 ? ' (×' + n + ')' : '') + '</button>';
    }
    if (own && own.status === 'want') {
      statusRow += '<button class="status-btn' + (own.wishPrio ? ' active' : '') + '" data-prio="1">' + (own.wishPrio ? '⭐ Hohe Priorität' : '☆ Priorität setzen') + '</button>';
    }

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
        + forecastHtml(own)
        + formatRowHtml(own)
        + '<div class="tags-edit"><label for="tagsInput">🏷️ Regale/Tags (Komma-getrennt):</label>'
          + '<input id="tagsInput" type="text" placeholder="z. B. Klassiker, Urlaub 2026" value="' + esc((own.tags || []).join(', ')) + '" /></div>'
        + '<div style="padding:8px 18px 0"><textarea class="note-area" id="noteArea" placeholder="Deine Notizen zu diesem Buch…">' + esc(own.note || '') + '</textarea></div>'
        + quotesHtml(own)
        : '')
      + shopLinksHtml(b)
      + '<div class="detail-body">'
      + (b.desc ? '<h3>Beschreibung</h3><div class="desc">' + esc(b.desc.replace(/<[^>]+>/g, ' ')).slice(0, 2200) + '</div>' : '<p class="muted" style="margin-top:14px">Keine Beschreibung verfügbar.</p>')
      + '<div class="similar-block"><button class="btn-ghost" id="similarBtn">🔗 Ähnliche ' + (b.kind === 'manga' ? 'Mangas' : 'Bücher') + ' finden</button><div id="similarGrid" class="grid" style="margin-top:12px"></div></div>'
      + '</div>';

    m.hidden = false;
    document.body.style.overflow = 'hidden';

    // Status-Buttons
    inner.querySelectorAll('.status-btn[data-status]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var s = btn.dataset.status;
        upsertBook(b, s);
        if (s === 'dnf') {
          var reason = window.prompt('Warum abgebrochen? (optional — z. B. „zu langatmig")', (findInLib(b.id) || {}).dnfReason || '');
          if (reason !== null) patchBook(b.id, { dnfReason: reason.slice(0, 200) });
          toast('🚫 Als abgebrochen markiert');
        } else {
          toast(STATUS_LBL[s] + ' — gespeichert ✓');
        }
        openDetail(b); // neu rendern (zeigt jetzt Sterne/Notiz)
      });
    });
    // v6: Format
    inner.querySelectorAll('.format-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cur = findInLib(b.id);
        var f = (cur && cur.format === btn.dataset.format) ? '' : btn.dataset.format;
        patchBook(b.id, { format: f });
        openDetail(b);
      });
    });
    var rm = inner.querySelector('[data-remove]');
    if (rm) rm.addEventListener('click', function () {
      removeBook(b.id);
      toast('Aus der Sammlung entfernt');
      closeDetail();
    });
    // v4: Timer / Re-Read / Priorität
    var ts = inner.querySelector('[data-timer]');
    if (ts) ts.addEventListener('click', function () {
      if (ts.dataset.timer === 'stop') stopSession(); else startSession(b.id);
      openDetail(b);
    });
    var rr = inner.querySelector('[data-reread]');
    if (rr) rr.addEventListener('click', function () {
      var cur = findInLib(b.id);
      var rd = readDatesOf(cur).concat([Date.now()]);
      patchBook(b.id, { readDates: rd, finishedAt: Date.now(), progress: 0 });
      toast('🔁 Nochmal gelesen — zählt für die Challenge!');
      checkAchievements();
      openDetail(b);
    });
    var pr = inner.querySelector('[data-prio]');
    if (pr) pr.addEventListener('click', function () {
      var cur = findInLib(b.id);
      patchBook(b.id, { wishPrio: !(cur && cur.wishPrio) });
      toast(cur && cur.wishPrio ? 'Priorität entfernt' : '⭐ Hohe Priorität — das Zufallsrad bevorzugt dieses Buch');
      openDetail(b);
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

    // v6: „Ähnliche finden" — quellenbasiert per Autor·in bzw. Genre
    var simBtn = inner.querySelector('#similarBtn');
    if (simBtn) simBtn.addEventListener('click', function () {
      var grid = inner.querySelector('#similarGrid');
      simBtn.disabled = true; simBtn.textContent = 'Suche…';
      var isManga = b.kind === 'manga';
      var author = (b.authors || [])[0];
      var genre = (b.categories || [])[0];
      var q, reasonKind;
      if (isManga) { q = genre ? (genre.split('/').pop().trim()) : b.title.split(' ')[0]; reasonKind = 'manga'; }
      else if (author) { q = 'inauthor:"' + author + '"'; }
      else if (genre) { q = 'subject:"' + genre.split('/')[0].trim() + '"'; }
      else { q = b.title.split(' ').slice(0, 3).join(' '); }
      var run = isManga ? searchMangas(q, 12) : searchBooks(q, 12);
      run.then(function (items) {
        simBtn.style.display = 'none';
        var out = items.filter(function (x) { return bookKey(x) !== bookKey(b) && !inLib(x); }).slice(0, 6);
        lastSimilar = out;
        if (!out.length) { grid.innerHTML = '<p class="muted" style="grid-column:1/-1">Keine ähnlichen Titel gefunden.</p>'; return; }
        grid.innerHTML = out.map(function (x) { return cardHtml(x, { src: 'similar' }); }).join('');
      }).catch(function () {
        simBtn.disabled = false; simBtn.textContent = '🔗 Erneut versuchen';
      });
    });

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
    else if (src === 'similar') b = lastSimilar.find(function (x) { return x.id === id; });
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

  // ───── ISBN-Barcode-Scanner ─────
  // Kette: nativer BarcodeDetector (Android/Chrome, schnell) → ZXing-Fallback (iPhone/iPad/Safari) → manuell.
  var scanStream = null, scanTimer = null, zxingReader = null, zxingLoading = null;
  function stopScanner() {
    clearInterval(scanTimer); scanTimer = null;
    if (zxingReader) { try { zxingReader.reset(); } catch (e) {} zxingReader = null; }
    if (scanStream) { scanStream.getTracks().forEach(function (t) { t.stop(); }); scanStream = null; }
    var m = document.getElementById('scanModal');
    if (m) m.remove();
  }

  // Gescannte ISBN weiterverarbeiten. ISBN funktioniert über Google Books —
  // findet sowohl Bücher als auch deutsche Manga-Verlagsausgaben. Ergebnis in den aktiven Modus einsortieren.
  function onIsbnScanned(isbn) {
    stopScanner();
    toast('✓ ISBN erkannt: ' + isbn);
    if (searchMode === 'manga') {
      // Im Manga-Modus: ISBN via Google Books (deutsche Verlagsausgabe) direkt auflösen und als Manga zeigen
      $('searchInput').value = isbn;
      $('searchEmpty').hidden = true;
      $('searchGrid').innerHTML = '<div class="skeleton-grid"><div class="skeleton"></div><div class="skeleton"></div></div>';
      gbSearch('isbn:' + isbn, 5).then(function (items) {
        var out = items.map(function (b) { return Object.assign({}, b, { kind: 'manga', volumes: 0, chapters: 0 }); });
        if (!out.length) throw new Error('nichts');
        lastSearch = out;
        $('searchGrid').innerHTML = out.map(function (b) { return cardHtml(b, { src: 'search' }); }).join('');
        openDetail(out[0]);
      }).catch(function () { doSearch(isbn); });
    } else {
      $('searchInput').value = isbn;
      doSearch(isbn);
    }
  }

  function buildScanUi(hintExtra) {
    var m = document.createElement('div');
    m.id = 'scanModal';
    m.className = 'scan-modal';
    m.innerHTML = '<div class="scan-inner"><video id="scanVideo" playsinline autoplay muted></video>'
      + '<div class="scan-frame"></div>'
      + '<p class="scan-hint">Barcode (ISBN) auf der Rückseite in den Rahmen halten' + (hintExtra || '') + '</p>'
      + '<div class="scan-manual"><input id="scanManualInput" type="text" inputmode="numeric" placeholder="…oder ISBN eintippen" />'
      + '<button class="btn-primary" id="scanManualGo">OK</button></div>'
      + '<button class="btn-ghost" id="scanCancel">Abbrechen</button></div>';
    document.body.appendChild(m);
    document.getElementById('scanCancel').addEventListener('click', stopScanner);
    m.addEventListener('click', function (e) { if (e.target === m) stopScanner(); });
    document.getElementById('scanManualGo').addEventListener('click', function () {
      var v = (document.getElementById('scanManualInput').value || '').replace(/[^0-9Xx]/g, '');
      if (v.length >= 10) onIsbnScanned(v); else toast('Bitte eine gültige ISBN eingeben (10 oder 13 Stellen).');
    });
    return m;
  }

  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (zxingLoading) return zxingLoading;
    zxingLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'js/vendor/zxing.min.js';
      s.onload = function () { window.ZXing ? resolve(window.ZXing) : reject(new Error('ZXing nicht geladen')); };
      s.onerror = function () { reject(new Error('ZXing nicht geladen')); };
      document.head.appendChild(s);
    });
    return zxingLoading;
  }

  function startScanner() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Keine Kamera verfügbar — ISBN bitte ins Suchfeld tippen.');
      $('searchInput').focus();
      return;
    }

    // Weg 1: nativer BarcodeDetector (Android/Chrome/Edge)
    if ('BarcodeDetector' in window) {
      var detector;
      try { detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8'] }); }
      catch (e) { detector = null; }
      if (detector) {
        buildScanUi('');
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
              onIsbnScanned(isbn);
            }).catch(function () {});
          }, 350);
        }).catch(function () { stopScanner(); toast('Kamera-Zugriff abgelehnt — ISBN bitte eintippen.'); });
        return;
      }
    }

    // Weg 2: ZXing-Fallback (iPhone/iPad/Safari & alle ohne BarcodeDetector)
    buildScanUi(' · Scanner wird geladen…');
    loadZxing().then(function (ZX) {
      var hint = document.querySelector('#scanModal .scan-hint');
      if (hint) hint.textContent = 'Barcode (ISBN) auf der Rückseite in den Rahmen halten';
      var video = document.getElementById('scanVideo');
      if (!video) return;
      zxingReader = new ZX.BrowserMultiFormatReader();
      zxingReader.decodeFromConstraints(
        { video: { facingMode: 'environment' } }, video,
        function (result) {
          if (!result) return;
          var isbn = (result.getText ? result.getText() : String(result)).replace(/[^0-9Xx]/g, '');
          if (isbn.length >= 10) onIsbnScanned(isbn);
        }
      ).catch(function () { toast('Kamera-Zugriff abgelehnt — ISBN bitte eintippen.'); });
    }).catch(function () {
      var hint = document.querySelector('#scanModal .scan-hint');
      if (hint) hint.textContent = 'Scanner nicht verfügbar — bitte ISBN unten eintippen.';
    });
  }

  // ───── v6: Stimmungs-Picker „Worauf hast du Lust?" ─────
  // Ordnet Genres/Seitenzahl einer Stimmung zu und schlägt passende Bücher aus der Sammlung vor
  // (bevorzugt ungelesene: „will lesen"/„lese gerade").
  var MOOD_GENRES = {
    spannend: ['thriller', 'krimi', 'crime', 'mystery', 'suspense', 'action', 'horror'],
    entspannt: ['slice of life', 'feel-good', 'romance', 'children', 'poetry', 'cozy'],
    lustig: ['comedy', 'humor', 'humour', 'satire'],
    romantisch: ['romance', 'liebe', 'love'],
    fantasy: ['fantasy', 'science fiction', 'sci-fi', 'adventure', 'supernatural']
  };
  function pickByMood(mood) {
    var books = lib();
    var res = $('moodResult');
    if (!books.length) { res.innerHTML = '<p class="muted" style="grid-column:1/-1">Deine Sammlung ist noch leer.</p>'; return; }
    var scored = books.map(function (b) {
      var score = 0;
      var text = ((b.categories || []).join(' ') + ' ' + (b.tags || []).join(' ')).toLowerCase();
      if (mood === 'kurz') score += (b.pages && b.pages <= 250) ? 3 : (b.pages ? -1 : 0);
      else if (mood === 'episch') score += (b.pages && b.pages >= 500) ? 3 : (b.pages ? -1 : 0);
      else {
        (MOOD_GENRES[mood] || [mood]).forEach(function (g) { if (text.indexOf(g) >= 0) score += 2; });
      }
      if (b.status === 'want') score += 1.5;         // ungelesene bevorzugen
      if (b.status === 'reading') score += 1;
      if (b.status === 'read') score -= 0.5;
      if (b.status === 'dnf') score -= 2;
      score += (b.rating || 0) * 0.2;
      return { b: b, score: score };
    }).filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; });
    if (!scored.length) {
      res.innerHTML = '<p class="muted" style="grid-column:1/-1">Kein passendes Buch für diese Stimmung in deiner Sammlung — schau mal unter „Entdecken". 🔍</p>';
      return;
    }
    res.innerHTML = scored.slice(0, 6).map(function (x) { return cardHtml(x.b, { showStatus: true }); }).join('');
  }

  // ───── v6: Buch/Manga manuell erfassen (wenn in keiner Quelle) ─────
  function openManualForm() {
    var m = document.createElement('div');
    m.className = 'manual-modal';
    m.innerHTML = '<div class="manual-card"><button class="manual-close" aria-label="Schließen">✕</button>'
      + '<h3>✍️ Eigenes Buch erfassen</h3>'
      + '<p class="muted" style="margin:0 0 12px">Für Titel, die in keiner Quelle stehen. * = Pflichtfeld.</p>'
      + '<input class="mf" id="mfTitle" placeholder="Titel *" />'
      + '<input class="mf" id="mfAuthor" placeholder="Autor·in" />'
      + '<div class="mf-row"><select class="mf" id="mfKind"><option value="buch">📚 Buch</option><option value="manga">🎌 Manga</option></select>'
      + '<select class="mf" id="mfStatus"><option value="read">✓ Gelesen</option><option value="reading">📖 Lese gerade</option><option value="want">🔖 Will lesen</option></select></div>'
      + '<div class="mf-row"><input class="mf" id="mfPages" type="number" inputmode="numeric" placeholder="Seiten" />'
      + '<input class="mf" id="mfYear" type="number" inputmode="numeric" placeholder="Jahr" /></div>'
      + '<input class="mf" id="mfPublisher" placeholder="Verlag" />'
      + '<input class="mf" id="mfGenre" placeholder="Genre (z. B. Fantasy)" />'
      + '<input class="mf" id="mfCover" placeholder="Cover-Bild-URL (optional)" />'
      + '<button class="btn-primary" id="mfSave" style="width:100%;margin-top:6px">Zur Sammlung hinzufügen</button></div>';
    document.body.appendChild(m);
    var close = function () { m.remove(); };
    m.querySelector('.manual-close').addEventListener('click', close);
    m.addEventListener('click', function (e) { if (e.target === m) close(); });
    m.querySelector('#mfSave').addEventListener('click', function () {
      var title = (m.querySelector('#mfTitle').value || '').trim();
      if (!title) { toast('Bitte einen Titel eingeben.'); m.querySelector('#mfTitle').focus(); return; }
      var author = (m.querySelector('#mfAuthor').value || '').trim();
      var kind = m.querySelector('#mfKind').value;
      var genre = (m.querySelector('#mfGenre').value || '').trim();
      var cover = (m.querySelector('#mfCover').value || '').trim();
      if (cover && !/^https:\/\//.test(cover)) cover = '';
      var book = {
        id: 'manual-' + Date.now(),
        title: title, authors: author ? [author] : [],
        cover: cover, year: (m.querySelector('#mfYear').value || '').slice(0, 4),
        pages: parseInt(m.querySelector('#mfPages').value, 10) || 0,
        categories: genre ? [(kind === 'manga' ? 'Manga / ' : '') + genre] : [],
        desc: '', lang: 'de', isbn: '', publisher: (m.querySelector('#mfPublisher').value || '').trim(),
        gRating: 0
      };
      if (kind === 'manga') book.kind = 'manga';
      // Dubletten-Check
      if (inLib(book)) { toast('„' + title + '" ist bereits in deiner Sammlung.'); return; }
      upsertBook(book, m.querySelector('#mfStatus').value);
      close();
      toast('✓ „' + title + '" hinzugefügt');
      openDetail(findInLib(book.id) || book);
    });
    setTimeout(function () { m.querySelector('#mfTitle').focus(); }, 50);
  }

  // ───── 🎲 „Was lese ich als Nächstes?" — Cover-Roulette ─────
  function rollNext() {
    var books = lib();
    var pool = books.filter(function (b) { return b.status === 'want'; });
    if (!pool.length) pool = books.filter(function (b) { return b.status !== 'read'; });
    if (!pool.length) { toast('Alles gelesen! Hol dir Nachschub unter „Für dich" ✨'); return; }
    // ⭐ Priorisierte Wunschbücher bekommen 3 Lose statt 1
    var tickets = [];
    pool.forEach(function (b) { for (var i = 0; i < (b.wishPrio ? 3 : 1); i++) tickets.push(b); });
    var winner = tickets[Math.floor(Math.random() * tickets.length)];

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

  // ───── v4: Lese-Timer ─────
  var timerTick = null, wakeLock = null;
  // v6: Bildschirm während der Lese-Session anlassen (Screen Wake Lock, wo verfügbar)
  function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      navigator.wakeLock.request('screen').then(function (wl) {
        wakeLock = wl;
        wl.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () {});
    } catch (e) {}
  }
  function releaseWakeLock() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }
  // Bei Tab-Rückkehr Wake Lock erneuern (Browser gibt ihn beim Wegblenden frei)
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && activeSess() && !wakeLock) acquireWakeLock();
  });
  function activeSess() {
    try { return JSON.parse(localStorage.getItem(LS_ACTIVE) || 'null'); } catch (e) { return null; }
  }
  function startSession(bookId) {
    try { localStorage.setItem(LS_ACTIVE, JSON.stringify({ bookId: bookId, start: Date.now() })); } catch (e) {}
    acquireWakeLock();
    renderTimerBar();
    toast('⏱️ Lese-Session gestartet — viel Spaß!');
  }
  function stopSession() {
    var s = activeSess();
    if (!s) return;
    releaseWakeLock();
    try { localStorage.removeItem(LS_ACTIVE); } catch (e) {}
    var mins = Math.round((Date.now() - s.start) / 60000);
    if (mins >= 1) {
      var ss = loadSessions();
      ss.push({ bookId: s.bookId, start: s.start, end: Date.now(), minutes: mins });
      saveSessions(ss);
      var b = findInLib(s.bookId);
      toast('📖 ' + mins + ' Minuten' + (b ? ' in „' + b.title + '"' : '') + ' gelesen — stark! 🦉');
      checkAchievements();
    } else {
      toast('Session unter 1 Minute — nicht gezählt.');
    }
    renderTimerBar();
    refreshAll();
  }
  function fmtElapsed(ms) {
    var t = Math.floor(ms / 1000), m = Math.floor(t / 60), s2 = t % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s2 < 10 ? '0' : '') + s2;
  }
  function renderTimerBar() {
    var s = activeSess();
    var bar = document.getElementById('timerBar');
    clearInterval(timerTick); timerTick = null;
    if (!s) { if (bar) bar.remove(); return; }
    var b = findInLib(s.bookId);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'timerBar';
      bar.className = 'timer-bar';
      document.body.appendChild(bar);
    }
    function draw() {
      bar.innerHTML = '<span class="timer-ico">📖</span>'
        + '<span class="timer-title">' + esc(b ? b.title : 'Lesen') + '</span>'
        + '<span class="timer-time" id="timerTime">' + fmtElapsed(Date.now() - s.start) + '</span>'
        + '<button class="timer-stop" id="timerStop">■ Beenden</button>';
      bar.querySelector('#timerStop').addEventListener('click', stopSession);
    }
    draw();
    timerTick = setInterval(function () {
      var el = document.getElementById('timerTime');
      if (el) el.textContent = fmtElapsed(Date.now() - s.start);
    }, 1000);
  }

  // ───── v4: Erfolge / Abzeichen ─────
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

  // ───── v4: Jahresrückblick ─────
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

  // ───── v4: Sammlung teilen (Read-only-Link) ─────
  function createShareLink() {
    var t = null;
    try { t = localStorage.getItem('bk_cloud_token'); } catch (e) {}
    if (!t) { toast('Bitte zuerst beim Cloud-Sync anmelden (☁️ unter Einstellungen).'); return; }
    var books = lib();
    if (!books.length) { toast('Deine Sammlung ist noch leer.'); return; }
    toast('Erstelle Teilen-Link…');
    fetch('/api/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ books: books })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Teilen fehlgeschlagen.');
        return j;
      });
    }).then(function (j) {
      var url = location.origin + location.pathname + '?share=' + j.id;
      function fallback() { window.prompt('Dein Teilen-Link (30 Tage gültig) — kopieren mit Strg/Cmd+C:', url); }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('🔗 Link kopiert! 30 Tage gültig, ohne deine Notizen.'); }, fallback);
      } else fallback();
    }).catch(function (e) { toast(e.message); });
  }

  function enterSharedMode(id) {
    fetch('/api/share?id=' + encodeURIComponent(id)).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Link ungültig.');
        return j;
      });
    }).then(function (j) {
      sharedData = (j.books || []).map(function (b) { return Object.assign({}, b, { note: '', quotes: [], tags: [] }); });
      var banner = document.createElement('div');
      banner.className = 'share-banner';
      banner.innerHTML = '👀 Geteilte Sammlung von <b>' + esc(j.owner || 'unbekannt') + '</b> — schreibgeschützt · '
        + '<a href="' + location.pathname + '">Zu meiner eigenen Bibliothek</a>';
      document.querySelector('.topbar').insertAdjacentElement('afterend', banner);
      switchTab('sammlung');
      refreshAll();
    }).catch(function (e) {
      toast(e.message);
      try { history.replaceState(null, '', location.pathname); } catch (er) {}
    });
  }

  // ───── v4: Lese-Erinnerung (lokale Benachrichtigung) ─────
  function reminderDue() {
    var s = loadSettings();
    if (!s.reminder || !('Notification' in window) || Notification.permission !== 'granted') return false;
    var hhmm = s.reminderTime || '19:00';
    var now = new Date();
    var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(hhmm.slice(0, 2), 10) || 19, parseInt(hhmm.slice(3), 10) || 0);
    var last = '';
    try { last = localStorage.getItem('bk_last_reminder') || ''; } catch (e) {}
    return now >= target && last !== now.toDateString();
  }
  function fireReminder() {
    if (!reminderDue()) return;
    try { localStorage.setItem('bk_last_reminder', new Date().toDateString()); } catch (e) {}
    var reading = lib().filter(function (b) { return b.status === 'reading'; })[0];
    try {
      new Notification('Hon 本 · Bücher Tracker', {
        body: reading ? ('Zeit für ein Kapitel in „' + reading.title + '"! 📖') : 'Zeit für dein tägliches Kapitel! 📖',
        icon: 'icons/icon-192.png'
      });
    } catch (e) {}
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

    // v4: Suchmodus Bücher ↔ Mangas (Quellen + Schnellfilter wechseln mit)
    var CHIP_SETS = {
      buch: [['subject:fiction bestseller', 'Romane'], ['subject:fantasy', 'Fantasy'], ['subject:thriller', 'Thriller'],
        ['subject:science fiction', 'Sci-Fi'], ['subject:biography', 'Biografien'], ['subject:history', 'Geschichte'], ['subject:self-help', 'Ratgeber']],
      manga: [['One Piece', 'One Piece'], ['action', 'Action'], ['romance', 'Romance'], ['fantasy', 'Fantasy'],
        ['comedy', 'Comedy'], ['slice of life', 'Slice of Life'], ['horror', 'Horror']]
    };
    $('searchModeRow').addEventListener('click', function (e) {
      var mc = e.target.closest('.mode-chip'); if (!mc || mc.dataset.mode === searchMode) return;
      searchMode = mc.dataset.mode;
      document.querySelectorAll('#searchModeRow .mode-chip').forEach(function (x) { x.classList.toggle('active', x === mc); });
      $('searchSub').textContent = searchMode === 'manga'
        ? 'Titel oder Genre — 2 Quellen parallel: AniList · MyAnimeList (Jikan)'
        : 'Titel, Autor·in oder ISBN — 3 Quellen parallel: Google Books · Open Library · Deutsche Nationalbibliothek';
      $('searchInput').placeholder = searchMode === 'manga' ? 'z. B. „One Piece" oder „Junji Ito"…' : 'z. B. „Der Herr der Ringe" oder „Haruki Murakami"…';
      // Scannen bleibt auch im Manga-Modus möglich: deutsche Manga-Ausgaben haben eine ISBN
      $('scanBtn').style.display = '';
      $('quickChips').innerHTML = CHIP_SETS[searchMode].map(function (c) {
        return '<button class="chip" data-q="' + esc(c[0]) + '">' + esc(c[1]) + '</button>';
      }).join('');
      $('searchGrid').innerHTML = '';
      $('searchEmpty').hidden = false;
      if ($('searchInput').value.trim()) doSearch($('searchInput').value);
    });

    // Sammlung: Filter
    ['filterStatus', 'filterGenre', 'sortLib', 'filterKind', 'filterPublisher'].forEach(function (id) {
      $(id).addEventListener('change', renderLib);
    });
    $('exportBtn').addEventListener('click', exportJson);

    // Empfehlungen
    $('recoRefresh').addEventListener('click', function () { renderReco(true); });

    // v6: Stimmungs-Picker
    $('moodChips').addEventListener('click', function (e) {
      var c = e.target.closest('.chip'); if (!c) return;
      document.querySelectorAll('#moodChips .chip').forEach(function (x) { x.classList.toggle('active', x === c); });
      pickByMood(c.dataset.mood);
    });

    // v6: Manuell erfassen
    $('manualEmptyBtn').addEventListener('click', openManualForm);
    $('manualBtn').addEventListener('click', openManualForm);

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

    // Scanner + Zufallsrad + Tag-Filter + Sammlungs-Suche
    $('scanBtn').addEventListener('click', startScanner);
    $('rollBtn').addEventListener('click', rollNext);
    $('filterTag').addEventListener('change', renderLib);
    $('libSearch').addEventListener('input', renderLib);

    // v4: laufende Lese-Session wiederherstellen + Erfolge prüfen
    renderTimerBar();
    setTimeout(checkAchievements, 1500);

    // v4: Sammlung teilen
    $('setShare').addEventListener('click', createShareLink);

    // v4: Lese-Erinnerung
    var sR = loadSettings();
    $('setReminder').checked = !!sR.reminder;
    if (sR.reminderTime) $('setReminderTime').value = sR.reminderTime;
    $('setReminder').addEventListener('change', function (e) {
      var s = loadSettings();
      if (e.target.checked && 'Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().then(function (p) {
          if (p !== 'granted') { e.target.checked = false; toast('Benachrichtigungen wurden nicht erlaubt.'); return; }
          s.reminder = true; saveSettings(s); toast('🔔 Lese-Erinnerung aktiv (' + ($('setReminderTime').value || '19:00') + ' Uhr)');
        });
      } else {
        s.reminder = e.target.checked; saveSettings(s);
        toast(s.reminder ? '🔔 Lese-Erinnerung aktiv' : 'Erinnerung aus');
      }
    });
    $('setReminderTime').addEventListener('change', function (e) {
      var s = loadSettings(); s.reminderTime = e.target.value || '19:00'; saveSettings(s);
    });
    setInterval(fireReminder, 60000);
    setTimeout(fireReminder, 4000);

    // v4: Geteilte Sammlung öffnen (?share=…)
    var shareId = null;
    try { shareId = new URLSearchParams(location.search).get('share'); } catch (e) {}
    if (shareId) enterSharedMode(shareId);

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
