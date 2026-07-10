/* ============================================================
   Hon 本 · Bücher Tracker — Persistenz-Speicher (v8)
   Bücher liegen in IndexedDB statt localStorage:
     - localStorage ist auf ~5 MB begrenzt → bei ~10.000 Titeln voll.
     - IndexedDB fasst Hunderte MB → große Sammlungen laufen stabil.
   Ein RAM-Spiegel (mem) erlaubt der App weiterhin SYNCHRONEN Zugriff;
   IndexedDB wird nur beim Start (laden) und beim Speichern (persistieren) berührt.
   Uralt-Browser ohne IndexedDB fallen automatisch auf localStorage zurück.
   ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'hon-store', STORE = 'kv', DB_VER = 1;
  var KEY = 'bk_books';
  var db = null, mem = null, useIDB = false, persistTimer = null;

  function openDB() {
    return new Promise(function (resolve) {
      if (!global.indexedDB) { resolve(null); return; }
      var req;
      try { req = global.indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { resolve(null); return; }
      req.onupgradeneeded = function () {
        try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); } catch (e) {}
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }

  function idbGet(key) {
    return new Promise(function (resolve) {
      if (!db) { resolve(null); return; }
      try {
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).get(key);
        rq.onsuccess = function () { resolve(rq.result != null ? rq.result : null); };
        rq.onerror = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }

  function idbSet(key, val) {
    return new Promise(function (resolve) {
      if (!db) { resolve(false); return; }
      try {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
        tx.onabort = function () { resolve(false); };
      } catch (e) { resolve(false); }
    });
  }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // Beim Start: DB öffnen, Bücher laden, ggf. aus localStorage migrieren
  var ready = (function () {
    return openDB().then(function (opened) {
      db = opened; useIDB = !!db;
      if (useIDB) {
        return idbGet(KEY).then(function (val) {
          if (val != null) { mem = val; return; }
          // Migration: bestehende localStorage-Sammlung nach IndexedDB übernehmen
          var ls = lsGet(KEY);
          if (ls != null) {
            mem = ls;
            return idbSet(KEY, ls).then(function (ok) { if (ok) lsDel(KEY); });
          }
          mem = '[]';
        });
      }
      // Fallback ohne IndexedDB
      mem = lsGet(KEY);
      if (mem == null) mem = '[]';
    }).catch(function () {
      mem = lsGet(KEY); if (mem == null) mem = '[]';
    });
  })();

  // Synchroner RAM-Zugriff (App-Cache-Ebene)
  function getRaw() { return mem == null ? '[]' : mem; }

  // Synchron im RAM setzen, Persistenz gedrosselt async
  function setRaw(str) {
    mem = str;
    if (useIDB) {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(function () { idbSet(KEY, str); }, 250);
    } else {
      return lsSet(KEY, str);
    }
    return true;
  }

  // Sofort persistieren (z.B. vor dem Schließen des Tabs) — gibt Promise zurück
  function flush() {
    clearTimeout(persistTimer);
    if (useIDB) return idbSet(KEY, mem == null ? '[]' : mem);
    lsSet(KEY, mem == null ? '[]' : mem);
    return Promise.resolve(true);
  }

  // Bücher komplett entfernen (für „Alles löschen")
  function clearBooks() {
    mem = '[]';
    if (useIDB) { clearTimeout(persistTimer); return idbSet(KEY, '[]'); }
    lsDel(KEY);
    return Promise.resolve(true);
  }

  function backend() { return useIDB ? 'indexeddb' : 'localstorage'; }

  global.HonStore = {
    ready: ready,
    getRaw: getRaw,
    setRaw: setRaw,
    flush: flush,
    clearBooks: clearBooks,
    backend: backend
  };
})(window);
