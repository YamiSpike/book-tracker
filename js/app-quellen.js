/* Manga- und Zeitschriften-Quellen (AniList, Jikan, DNB, Verlage)
   Ausgelagert aus js/app.js. Der Rumpf ist unveraendert uebernommen.

   Bindung an den Kern laeuft ueber window.HonIntern (H). js/app.js startet
   erst bei DOMContentLoaded — also NACH allen Skripten —, deshalb ist die
   Ladereihenfolge unkritisch, solange diese Datei nach app.js steht.
   Funktionen werden ueber Weiterleitungen geholt (spaete Bindung, damit auch
   Verweise auf ANDERE Teilmodule funktionieren), Konstanten direkt kopiert. */
(function (H) {
  'use strict';

  // Konstanten aus dem Kern
  var GB = H.GB;

  // Funktionen aus dem Kern bzw. aus Nachbarmodulen (spaete Bindung)
  function $() { return H.$.apply(null, arguments); }
  function bookKey() { return H.bookKey.apply(null, arguments); }
  function dnbSearch() { return H.dnbSearch.apply(null, arguments); }
  function doSearch() { return H.doSearch.apply(null, arguments); }
  function gbFetch() { return H.gbFetch.apply(null, arguments); }
  function gbSearch() { return H.gbSearch.apply(null, arguments); }
  function normTitleKey() { return H.normTitleKey.apply(null, arguments); }
  function normVolume() { return H.normVolume.apply(null, arguments); }
  function olSearch() { return H.olSearch.apply(null, arguments); }

  // ───── v1.4/v1.5: Manga-Quellen (AniList + Jikan/MAL + deutsche Verlage via Google Books) ─────
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
    return gbFetch(url).then(function (j) {
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

  /* ── v3-G: Verwandte Werke via AniList (keyless) ──
     Titel-Parsing findet nur „Band N" derselben Reihe. Spin-offs, Sequels mit
     anderem Namen und Side Stories übersieht es komplett — genau die gehen einem
     Sammler durch die Lappen. AniList kennt diese Beziehungen (relations) und
     hat community-kuratierte Empfehlungen (recommendations). */
  var REL_LBL = {
    SEQUEL: '➡️ Fortsetzung', PREQUEL: '⬅️ Vorgeschichte', SIDE_STORY: '📎 Nebengeschichte',
    SPIN_OFF: '🌱 Spin-off', PARENT: '📖 Hauptreihe', ALTERNATIVE: '🔀 Alternative Fassung',
    ADAPTATION: '🎬 Adaption', SUMMARY: '📝 Zusammenfassung', CHARACTER: '👤 Gleiche Figuren',
    OTHER: '🔗 Verwandt'
  };
  // Nur Manga-artige Beziehungen — Anime-Adaptionen gehören nicht in einen Bücher-Tracker
  function alRelated(title) {
    var gql = 'query($s:String){Media(search:$s,type:MANGA){id title{english romaji}'
      + ' relations{edges{relationType node{id type title{english romaji} coverImage{large} startDate{year} volumes chapters genres description(asHtml:false) averageScore}}}'
      + ' recommendations(perPage:8,sort:RATING_DESC){nodes{mediaRecommendation{id type title{english romaji} coverImage{large} startDate{year} volumes chapters genres description(asHtml:false) averageScore}}}}}';
    return fetch('https://graphql.anilist.co', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query: gql, variables: { s: title } })
    }).then(function (r) {
      if (!r.ok) throw new Error('AniList nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      var M = (j.data || {}).Media;
      if (!M) return { relations: [], recos: [] };
      function toBook(n) {
        if (!n || n.type !== 'MANGA') return null;
        var t = (n.title && (n.title.english || n.title.romaji)) || '';
        if (!t) return null;
        return normManga({
          id: 'al-' + n.id, title: t, authors: [],
          cover: (n.coverImage && n.coverImage.large) || '',
          year: n.startDate && n.startDate.year ? String(n.startDate.year) : '',
          volumes: n.volumes, chapters: n.chapters, genres: n.genres,
          desc: n.description || '',
          score: n.averageScore ? Math.round(n.averageScore / 20 * 10) / 10 : 0
        });
      }
      // Große Reihen liefern 30+ Relationen — davon ist vieles Rauschen (Cover-Varianten,
      // Cross-Over-Gastauftritte). Nach Relevanz sortieren, entdoppeln, auf 12 kappen.
      var REL_RANK = { SEQUEL: 1, PREQUEL: 2, PARENT: 3, SIDE_STORY: 4, SPIN_OFF: 5, ALTERNATIVE: 6, SUMMARY: 7 };
      var seenRel = Object.create(null);
      var rel = (((M.relations || {}).edges) || [])
        .filter(function (e) { return REL_RANK[e.relationType]; })   // CHARACTER/ADAPTATION raus
        .sort(function (a, b) { return REL_RANK[a.relationType] - REL_RANK[b.relationType]; })
        .map(function (e) {
          var b = toBook(e.node);
          if (!b) return null;
          var k = normTitleKey(b.title);
          if (seenRel[k]) return null;                                // Doppelte Einträge (gleicher Titel) raus
          seenRel[k] = 1;
          return { book: b, label: REL_LBL[e.relationType] || REL_LBL.OTHER };
        }).filter(Boolean).slice(0, 12);
      var rec = (((M.recommendations || {}).nodes) || []).map(function (n) {
        return toBook(n && n.mediaRecommendation);
      }).filter(Boolean);
      return { relations: rel, recos: rec };
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

  // ───── v2.11: Zeitschriften/Magazine (Google-Books-Periodika + deutsche Verlage + DNB/ISSN) ─────
  // Die großen deutschen Zeitschriften-Verlage — Filter analog zu DE_MANGA_VERLAGE.
  var DE_MAGAZIN_VERLAGE = /bauer|heinrich\s*bauer|gruner\s*\+?\s*jahr|g\s*\+\s*j|burda|hubert\s*burda|axel\s*springer|springer|funke|spiegel[- ]?verlag|der\s*spiegel|zeit[- ]?verlag|die\s*zeit|cond[eé]\s*nast|egmont|ehapa|panini|klambt|motor[- ]?presse/i;

  // Normalisiert ein Google-Books-/DNB-Objekt auf das Magazin-Schema (kind=magazin).
  function normMagazine(b) {
    return {
      id: b.id, title: b.title || 'Ohne Titel', authors: b.authors || [], cover: b.cover || '',
      year: b.year || '', pages: b.pages || 0,
      categories: (b.categories && b.categories.length) ? b.categories : ['Zeitschrift'],
      desc: b.desc || '', lang: b.lang || 'de', isbn: b.isbn || '', issn: b.issn || '',
      publisher: b.publisher || '', issue: b.issue || '', gRating: b.gRating || 0, kind: 'magazin'
    };
  }

  // Google Books im Periodika-Modus (printType=magazines) — echte Zeitschriften-Ausgaben.
  function gbMagazineSearch(q, maxResults) {
    var url = GB + '?q=' + encodeURIComponent(q) + '&maxResults=' + (maxResults || 20) + '&printType=magazines';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Google Books nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      return (j.items || []).map(normVolume).filter(function (b) { return b.title; }).map(normMagazine);
    });
  }

  // Zusätzlich: deutsche Verlags-Magazine als Buchausgaben (Sonderhefte, Sammelmagazine),
  // gefiltert über die Zeitschriften-Verlags-Regex (analog zum Manga-Muster).
  function gbMagazinePublisherSearch(q, maxResults) {
    var url = GB + '?q=' + encodeURIComponent(q) + '&maxResults=' + (maxResults || 20) + '&printType=books&langRestrict=de';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Google Books nicht erreichbar (' + r.status + ')');
      return r.json();
    }).then(function (j) {
      return (j.items || []).map(normVolume).filter(function (b) {
        var cat = (b.categories || []).join(' ');
        return b.title && (DE_MAGAZIN_VERLAGE.test(b.publisher || '') || /magazin|zeitschrift|periodical|comic/i.test(cat));
      }).map(normMagazine);
    });
  }

  // DNB für deutsche Zeitschriften/ISSN — MARC21 wiederverwenden, ISSN aus Feld 022.
  // Nur echte Periodika (mit ISSN) werden übernommen; q kann auch ein ISSN sein.
  function dnbMagazineSearch(q, maxResults) {
    var raw = String(q || '').trim();
    if (!raw) return Promise.resolve([]);
    var issnDigits = raw.replace(/[^0-9Xx]/g, '');
    var isIssnQuery = /^\d{7}[\dXx]$/.test(issnDigits);
    var cql = isIssnQuery ? ('NUM=' + issnDigits) : ('WOE="' + raw.replace(/"/g, '') + '"');
    var url = 'https://services.dnb.de/sru/dnb?version=1.1&operation=searchRetrieve'
      + '&query=' + encodeURIComponent(cql)
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
        var issn = (df(rec, '022', 'a')[0] || '').replace(/[^0-9Xx-]/g, '');
        var title = (df(rec, '245', 'a')[0] || '').replace(/\s*[/:;]\s*$/, '');
        if (!title) continue;
        // Nur Serien/Periodika (mit ISSN) — sonst fände die Magazin-Suche auch Bücher
        if (!issn && !isIssnQuery) continue;
        var ctrl = rec.querySelectorAll('controlfield[tag="001"]');
        var id = 'dnb-mag-' + ((ctrl[0] && ctrl[0].textContent.trim()) || (title + i));
        var year = ((df(rec, '264', 'c')[0] || df(rec, '260', 'c')[0] || '').match(/\d{4}/) || [''])[0];
        var publisher = (df(rec, '264', 'b')[0] || df(rec, '260', 'b')[0] || '').replace(/[,;:]\s*$/, '').trim();
        out.push(normMagazine({
          id: id, title: title,
          authors: df(rec, '110', 'a').concat(df(rec, '710', 'a')).slice(0, 2),
          cover: '', year: year, publisher: publisher,
          categories: df(rec, '650', 'a').slice(0, 3), lang: 'de', issn: issn
        }));
      }
      return out;
    });
  }

  // Magazin-Quellen parallel zusammenführen. Sparse ist normal: leere Liste wird NICHT
  // als Fehler geworfen — doSearch zeigt dann einen freundlichen Hinweis + „Manuell erfassen".
  function searchMagazines(q, maxResults) {
    var n = maxResults || 20;
    return Promise.allSettled([gbMagazineSearch(q, n), gbMagazinePublisherSearch(q, 15), dnbMagazineSearch(q, 15)]).then(function (rs) {
      var lists = rs.map(function (r) { return r.status === 'fulfilled' ? r.value : []; });
      var map = Object.create(null), order = [];
      lists.forEach(function (list) {
        list.forEach(function (b) {
          var k = bookKey(b);
          var prev = map[k];
          if (!prev) { map[k] = b; order.push(k); return; }
          if (!prev.cover && b.cover) prev.cover = b.cover;
          if (!prev.issn && b.issn) prev.issn = b.issn;
          if (!prev.publisher && b.publisher) prev.publisher = b.publisher;
          if (!prev.year && b.year) prev.year = b.year;
          if (!prev.desc && b.desc) prev.desc = b.desc;
        });
      });
      var merged = order.map(function (k) { return map[k]; });
      merged.sort(function (a, b) { return (b.cover ? 1 : 0) - (a.cover ? 1 : 0); });
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

  // ── nach aussen geben ──
  H.normManga = normManga;
  H.DE_MANGA_VERLAGE = DE_MANGA_VERLAGE;
  H.gbMangaSearch = gbMangaSearch;
  H.alSearch = alSearch;
  H.REL_LBL = REL_LBL;
  H.alRelated = alRelated;
  H.jikanSearch = jikanSearch;
  H.searchMangas = searchMangas;
  H.DE_MAGAZIN_VERLAGE = DE_MAGAZIN_VERLAGE;
  H.normMagazine = normMagazine;
  H.gbMagazineSearch = gbMagazineSearch;
  H.gbMagazinePublisherSearch = gbMagazinePublisherSearch;
  H.dnbMagazineSearch = dnbMagazineSearch;
  H.searchMagazines = searchMagazines;
  H.searchBooks = searchBooks;
})(window.HonIntern = window.HonIntern || {});
