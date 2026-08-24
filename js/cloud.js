/* ============================================================
   Cloud-Sync für Hon 本 · Bücher Tracker
   Gleiches Backend-Prinzip wie Nihongo-/Japan-App (Vercel Serverless + Upstash):
     - E-Mail/Passwort-Konto (geteilt mit den anderen Apps → ein Login)
     - Bücherdaten getrennt unter data:books:<email>
     - Passwort-Wiederherstellung per Code ODER E-Mail
     - Multi-Device: anmelden → Daten kommen zurück
   Speichert NUR Nutzerdaten (bk_-Keys), keine Caches/Token.
   ============================================================ */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'bk_cloud_token', EMAIL_KEY = 'bk_cloud_email';
  var API = '/api';                 // same-origin (Vercel)
  var APP = 'books';                // Namespace gegen die anderen App-Daten
  var PUSH_DEBOUNCE = 2500, POLL_MS = 8000;

  // Diese Keys NIE in die Cloud (Caches, Token, Versions-Marker)
  // bk_wipe_acct bleibt lokal: der Lösch-Marker bk_wipe SELBST geht in die Cloud
  // (er ist ja die Weitergabe), aber zu welchem Konto er gehört, ist eine reine
  // Gerätefrage — siehe wipe() und mergeApply().
  var BLOCK = new Set([
    TOKEN_KEY, EMAIL_KEY, 'bk_app_version', 'bk_cloud_lastsync', 'bk_search_cache', 'bk_wipe_acct'
  ]);
  var PREFIX = ['bk_'];

  // ───── State ─────
  var pushTimer = null, lastHash = null, lastSyncAt = 0, started = false;
  // Delta-Sync: Snapshot der Feld-Hashes nach dem letzten erfolgreichen Push.
  // Damit erkennt pushDelta(), WELCHE Sammlungen sich geändert haben, und lädt
  // nur diese hoch (statt jedes Mal alles). null = noch kein Voll-Push passiert.
  var lastFields = null;
  // Hat in dieser Sitzung schon EIN erfolgreicher Abgleich mit der Cloud stattgefunden?
  // Vorher darf nicht gepusht werden: sonst wird der lokale Stand maßgeblich, ohne je
  // mit der Cloud verglichen worden zu sein — und ein Voll-Push entfernt serverseitig
  // alles, was lokal fehlt. Genau das passierte, wenn der Start-Sync scheiterte
  // (offline gestartet, 5xx, langsame Verbindung): das Intervall pushte trotzdem.
  var erstSyncOk = false;

  // ───── Helfer ─────
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function getToken() { return lsGet(TOKEN_KEY); }
  function getEmail() { return lsGet(EMAIL_KEY); }
  function isLoggedIn() { return !!getToken(); }
  function store(j) { if (j && j.token) { lsSet(TOKEN_KEY, j.token); lsSet(EMAIL_KEY, j.email || ''); } }
  // lastFields MUSS mit weg: es ist der Feld-Schnappschuss des ABGEMELDETEN Kontos.
  // Bleibt er stehen, bildet pushDelta() beim naechsten Konto ein Delta dagegen —
  // hat sich lokal nichts geaendert, wird gar nichts hochgeladen (die Oberflaeche
  // meldet trotzdem Erfolg), und die remove-Liste kann im neuen Konto Felder
  // loeschen, die nur das alte hatte.
  function logout() { lsDel(TOKEN_KEY); lsDel(EMAIL_KEY); lastHash = null; lastFields = null; erstSyncOk = false; refreshStatusLine(); }

  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return h.toString(16);
  }
  // Feld-für-Feld-Hashes eines Datensatzes (für Delta-Erkennung).
  function fieldHashes(data) {
    var o = {};
    if (data) Object.keys(data).forEach(function (k) { o[k] = fnv(typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])); });
    return o;
  }

  // ───── Datensammlung / -anwendung ─────
  function collectData() {
    var out = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || BLOCK.has(k)) continue;
        var ok = false;
        for (var p = 0; p < PREFIX.length; p++) { if (k.indexOf(PREFIX[p]) === 0) { ok = true; break; } }
        if (!ok) continue;
        out[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    // Bücher liegen seit v2 in IndexedDB (nicht mehr in localStorage) → aus dem Store holen.
    // Seit v2.1 komprimiert übertragen (bk_books_lz): ~16× kleiner → große Sammlungen bleiben unter dem 4-MB-Limit.
    var raw = booksGetRaw();
    if (raw != null) {
      var lz = compressBooks(raw);
      if (lz != null) out['bk_books_lz'] = lz;
      else out['bk_books'] = raw; // Fallback ohne LZString
    }
    return out;
  }
  function booksGetRaw() { return global.HonStore ? global.HonStore.getRaw() : lsGet('bk_books'); }
  function booksSetRaw(str) { if (global.HonStore) global.HonStore.setRaw(str); else lsSet('bk_books', str); }
  function booksClear() { if (global.HonStore && global.HonStore.clearBooks) global.HonStore.clearBooks(); else lsDel('bk_books'); }
  function compressBooks(str) {
    try { if (global.LZString) return 'lz:' + global.LZString.compressToUTF16(str); } catch (e) {}
    return null;
  }
  function decompressBooks(v) {
    try {
      if (typeof v !== 'string') return null;
      if (v.indexOf('lz:') === 0 && global.LZString) return global.LZString.decompressFromUTF16(v.slice(3));
    } catch (e) {}
    return null;
  }

  // Wertweises Mergen ohne Datenverlust:
  //  Arrays → Vereinigung (dedupliziert) · Objekte → remote-Basis, lokal gewinnt · sonst lokal behalten
  function mergeValue(lv, rv) {
    var lj, rj;
    try { lj = JSON.parse(lv); } catch (e) { lj = undefined; }
    try { rj = JSON.parse(rv); } catch (e) { rj = undefined; }
    if (Array.isArray(lj) && Array.isArray(rj)) {
      var seen = Object.create(null), out = [];
      lj.concat(rj).forEach(function (x) { var s = JSON.stringify(x); if (!seen[s]) { seen[s] = 1; out.push(x); } });
      return JSON.stringify(out);
    }
    if (lj && rj && typeof lj === 'object' && typeof rj === 'object') {
      return JSON.stringify(Object.assign({}, rj, lj));
    }
    return lv; // primitive/String: aktuelles Gerät hat Vorrang
  }

  // Bücher-Liste speziell mergen: gleiche Buch-ID → Eintrag mit jüngstem updatedAt gewinnt
  function mergeBooks(lv, rv) {
    var lj, rj;
    try { lj = JSON.parse(lv); } catch (e) { lj = null; }
    try { rj = JSON.parse(rv); } catch (e) { rj = null; }
    if (!Array.isArray(lj) || !Array.isArray(rj)) return mergeValue(lv, rv);
    var map = Object.create(null);
    rj.concat(lj).forEach(function (b) {
      if (!b || !b.id) return;
      var prev = map[b.id];
      if (!prev || (b.updatedAt || 0) >= (prev.updatedAt || 0)) map[b.id] = b;
    });
    // Gelöschte (Tombstones mit deleted:true) bleiben erhalten, damit Löschungen syncen
    return JSON.stringify(Object.keys(map).map(function (k) { return map[k]; }));
  }

  // Datenschlüssel, die ein „Alles löschen" betreffen
  var DATA_KEYS = ['bk_books', 'bk_sessions', 'bk_achievements', 'bk_active_session'];

  // Wert aus der Cloud als Text. Upstash liefert Hash-Werte JSON-geparst zurück,
  // lokal liegt aber alles als String — hier wieder zusammenführen.
  function alsText(v) {
    if (typeof v === 'string') return v;
    if (v == null) return null;
    try { return JSON.stringify(v); } catch (e) { return null; }
  }

  function mergeApply(remote) {
    if (!remote || typeof remote !== 'object') return false;
    var changed = false;

    // Lösch-Marker: Wurde die Sammlung auf EINEM Gerät gelöscht, gilt das überall.
    // Ohne diesen Check holt der Merge die gelöschten Daten sofort wieder zurück.
    var rWipe = parseInt(remote['bk_wipe'] || '0', 10) || 0;
    // Der lokale Marker zählt nur, wenn er zu DIESEM Konto gehört. Sonst würde eine
    // Löschung in Konto A beim Anmelden in Konto B dessen Cloud-Sammlung verwerfen.
    // Marker ohne Kontonotiz stammen aus einer Version vor v3.7 — die wurden damals
    // auch ohne Anmeldung gesetzt und sind deshalb nicht vertrauenswürdig.
    var lWipeAcct = lsGet('bk_wipe_acct');
    var lWipe = (lWipeAcct && lWipeAcct === getEmail())
      ? (parseInt(lsGet('bk_wipe') || '0', 10) || 0)
      : 0;
    var skipData = false;
    if (rWipe > lWipe) {
      // Auf einem anderen Gerät gelöscht → hier ebenfalls löschen
      DATA_KEYS.forEach(function (k) { if (k === 'bk_books') booksClear(); else lsDel(k); });
      lsSet('bk_wipe', String(rWipe));
      // Kontonotiz mitschreiben, sonst gilt der Marker beim nächsten Abgleich wieder
      // als fremd (lWipe = 0), der Zweig greift erneut und meldet bei jedem Poll
      // „Von der Cloud aktualisiert".
      lsSet('bk_wipe_acct', String(getEmail() || ''));
      skipData = true;
      changed = true;
    } else if (lWipe > rWipe) {
      // Hier gelöscht (evtl. offline/abgemeldet) → alte Cloud-Daten NICHT übernehmen.
      // Der anschließende Push überschreibt die Cloud mit dem leeren Stand.
      skipData = true;
    }

    // Bücher separat behandeln (liegen im Store, evtl. komprimiert als bk_books_lz)
    if (!skipData) {
      var remoteBooks = null;
      // alsText(): Upstash parst JSON-fähige Hash-Werte beim Lesen automatisch —
      // der Voll-Blob '[]' kommt als ARRAY zurück, nicht als String. Der lz:-Blob
      // ist kein gültiges JSON und bleibt String, der unkomprimierte Fallback aber
      // nicht: ohne diese Normalisierung landete die Sammlung aus der Cloud dort
      // nie im Store. Die übrigen Schlüssel unten machen das längst genauso.
      var rlz = alsText(remote['bk_books_lz']);
      var rbk = alsText(remote['bk_books']);
      if (rlz != null) {
        remoteBooks = decompressBooks(rlz);
        // Scheitert das Entpacken — LZString fehlt, weil js/vendor/lz-string.min.js
        // nicht geladen wurde —, ist das ein LESEFEHLER, nicht „die Cloud ist leer".
        // Einfach weiterzumachen hieße: den Cloud-Stand verwerfen und ihn gleich
        // darauf per Voll-Push mit dem lokalen zu überschreiben. Die gesamte
        // Sammlung wäre weg. Deshalb hier abbrechen — laut.
        if (remoteBooks == null) {
          leseFehler = true;
          throw new Error('Cloud-Daten konnten nicht entpackt werden. Sync gestoppt, damit nichts überschrieben wird — bitte die App neu laden.');
        }
      } else if (rbk != null) remoteBooks = rbk;
      if (remoteBooks != null) {
        var lvb = booksGetRaw();
        if (lvb == null || lvb === '[]' || lvb === '') { booksSetRaw(remoteBooks); changed = true; }
        else if (lvb !== remoteBooks) {
          var mb = mergeBooks(lvb, remoteBooks);
          if (mb !== lvb) { booksSetRaw(mb); changed = true; }
        }
      }
    }

    Object.keys(remote).forEach(function (k) {
      if (BLOCK.has(k) || k === 'bk_books' || k === 'bk_books_lz') return;
      // Nach einem Wipe die Daten aus der Cloud NICHT zurückholen
      if (skipData && DATA_KEYS.indexOf(k) >= 0) return;
      var rv = alsText(remote[k]); if (rv == null) return;
      var lv = lsGet(k);
      if (lv === null) { if (lsSet(k, rv)) changed = true; return; }
      if (lv === rv) return;
      var m = mergeValue(lv, rv);
      if (m !== lv && lsSet(k, m)) changed = true;
    });
    return changed;
  }

  // Sammlung überall löschen: Marker setzen und den (leeren) Stand hochschieben — OHNE vorher zu pullen,
  // sonst würden die Cloud-Daten sofort wieder hereingemerged.
  function wipe() {
    var now = Date.now();
    DATA_KEYS.forEach(function (k) { if (k === 'bk_books') booksClear(); else lsDel(k); });
    // Der Lösch-Marker existiert AUSSCHLIESSLICH, um die Löschung an die anderen
    // Geräte desselben Kontos weiterzugeben. Ohne Konto gibt es nichts weiterzugeben —
    // und ein gesetzter Marker wäre eine Falle: beim späteren Anmelden gewinnt in
    // mergeApply() der Zweig lWipe > rWipe, die Cloud-Sammlung wird verworfen und
    // gleich darauf mit dem leeren Stand überschrieben. Ein lokales „Alles löschen"
    // hätte damit die Sammlung in der Cloud mitgerissen. Deshalb: erst prüfen, dann setzen.
    if (!isLoggedIn()) return Promise.resolve(true);
    lsSet('bk_wipe', String(now));
    // Zu WELCHEM Konto der Marker gehört. Ohne diese Notiz würde eine Löschung in
    // Konto A beim Anmelden in Konto B dessen Cloud-Sammlung verwerfen.
    lsSet('bk_wipe_acct', String(getEmail() || ''));
    lastHash = lightHash();             // Bücher jetzt leer, aber bk_wipe gesetzt
    return push(collectData());         // redis.set überschreibt den kompletten Datensatz
  }

  // ───── Netz ─────
  function authReq(path, body) {
    return fetch(API + '/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) throw new Error(json.error || 'Verbindungsfehler. Bitte später erneut.');
        return json;
      });
    });
  }

  // Verlangt ein Token in der Antwort — sonst ist es kein gültiger Login (z.B. SPA-Fallback liefert HTML)
  function needToken(j) { if (!j || !j.token) throw new Error('Cloud-Sync nicht erreichbar. Bitte später erneut.'); store(j); return j; }
  function register(email, password) { return authReq('register', { email: email, password: password }).then(needToken); }
  function login(email, password) { return authReq('login', { email: email, password: password }).then(needToken); }
  function recoverWithCode(email, code, newPassword) { return authReq('recover', { action: 'code', email: email, code: code, newPassword: newPassword }).then(needToken); }
  function requestEmailReset(email) { return authReq('recover', { action: 'request', email: email }); }
  function resetWithEmailCode(email, code, newPassword) { return authReq('recover', { action: 'email', email: email, code: code, newPassword: newPassword }).then(needToken); }

  // ───── Antwort-Prüfung & 429-Pause ─────
  // /api/sync ist seit v3.4 rate-limitiert. Ein 429 darf NICHT stillschweigend
  // als Erfolg durchgehen — sonst meldet die Statuszeile „Synchronisiert ✓",
  // obwohl nichts übertragen wurde. Nach einem 429 wird kurz pausiert, statt
  // weiter gegen die Grenze zu laufen (gleiches Muster wie die Google-Books-
  // Schleuse in app.js: ist das Kontingent erschöpft, hilft nur Warten).
  var syncPauseBis = 0;
  var PAUSE_TEXT = 'Zu viele Sync-Anfragen — bitte eine Minute warten.';
  // Gesetzt, wenn der Cloud-Stand nicht LESBAR war. Dann darf auch nicht mehr
  // geschrieben werden: ein Push würde den unlesbaren, aber intakten Stand in der
  // Cloud durch den lokalen ersetzen. Nur ein Neuladen hebt das auf.
  var leseFehler = false;
  var LESE_TEXT = 'Cloud-Daten sind hier nicht lesbar — Sync gestoppt. Bitte die App neu laden.';
  function syncPausiert() { return Date.now() < syncPauseBis; }
  function pruefeAntwort(res) {
    if (res.status === 401) { logout(); throw new Error('Sitzung abgelaufen — bitte neu anmelden.'); }
    if (res.status === 429) { syncPauseBis = Date.now() + 60000; throw new Error(PAUSE_TEXT); }
    // Alles andere ebenfalls melden statt still false zurückzugeben. Vorher liefen
    // genau die Fehler durch, die bei großen Sammlungen auftreten — 413 „zu groß"
    // und 503 „nicht eingerichtet" —, und die Statuszeile schrieb „Synchronisiert ✓".
    // Der Nutzer hielt seine Sammlung für gesichert, während in der Cloud der letzte
    // erfolgreiche Stand lag.
    if (res.status === 413) throw new Error('Sammlung zu groß für den Cloud-Sync. Bitte Duplikate entfernen (⚙️ Mehr).');
    if (res.status === 503) throw new Error('Cloud-Sync ist gerade nicht erreichbar.');
    if (!res.ok) throw new Error('Cloud-Sync fehlgeschlagen (HTTP ' + res.status + ').');
    return res;
  }

  function pull() {
    var t = getToken(); if (!t) return Promise.resolve(null);
    if (leseFehler) return Promise.reject(new Error(LESE_TEXT));
    if (syncPausiert()) return Promise.reject(new Error(PAUSE_TEXT));
    return fetch(API + '/sync?app=' + APP, { headers: { Authorization: 'Bearer ' + t } }).then(function (res) {
      pruefeAntwort(res);
      return res.json().catch(function () { return {}; }).then(function (j) { return j.data || null; });
    });
  }

  // VOLL-Push: kompletter Datensatz. Migriert serverseitig den alten Blob und
  // setzt den Delta-Snapshot (lastFields), damit danach nur noch Deltas gehen.
  function push(data) {
    var t = getToken(); if (!t) return Promise.resolve(false);
    if (leseFehler) return Promise.reject(new Error(LESE_TEXT));
    if (syncPausiert()) return Promise.reject(new Error(PAUSE_TEXT));
    var sent = data || collectData();
    return fetch(API + '/sync?app=' + APP, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ data: sent })
    }).then(function (res) {
      pruefeAntwort(res);
      if (res.ok) { lastFields = fieldHashes(sent); lastSyncAt = Date.now(); lsSet('bk_cloud_lastsync', String(lastSyncAt)); refreshStatusLine(); }
      return res.ok;
    });
  }

  // DELTA-Push: nur geänderte Sammlungen (patch) + entfernte (remove) hochladen.
  // Vor dem ersten erfolgreichen Voll-Push (lastFields==null) wird voll gepusht,
  // damit die Server-Migration + ein vollständiger Ausgangsstand garantiert sind.
  function pushDelta() {
    var t = getToken(); if (!t) return Promise.resolve(false);
    if (leseFehler) return Promise.reject(new Error(LESE_TEXT));
    if (syncPausiert()) return Promise.reject(new Error(PAUSE_TEXT));
    var cur = collectData();
    if (!lastFields) return push(cur);
    var ch = fieldHashes(cur), patch = {}, remove = [], any = false;
    Object.keys(cur).forEach(function (k) { if (lastFields[k] !== ch[k]) { patch[k] = cur[k]; any = true; } });
    Object.keys(lastFields).forEach(function (k) { if (!(k in cur)) { remove.push(k); any = true; } });
    if (!any) return Promise.resolve(true); // nichts geändert
    return fetch(API + '/sync?app=' + APP, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ patch: patch, remove: remove })
    }).then(function (res) {
      pruefeAntwort(res);
      if (res.ok) { lastFields = ch; lastSyncAt = Date.now(); lsSet('bk_cloud_lastsync', String(lastSyncAt)); refreshStatusLine(); }
      return res.ok;
    });
  }

  // Leichter Änderungs-Hash über die ROH-Daten (ohne Kompression) — für die Änderungs-Erkennung.
  // So wird nicht bei jedem 8-Sekunden-Tick die ganze Sammlung komprimiert, sondern nur beim echten Push.
  function lightHash() {
    var parts = booksGetRaw() || '';
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || BLOCK.has(k)) continue;
        for (var p = 0; p < PREFIX.length; p++) { if (k.indexOf(PREFIX[p]) === 0) { keys.push(k); break; } }
      }
      keys.sort();
      for (var j = 0; j < keys.length; j++) parts += '\x00' + keys[j] + '=' + localStorage.getItem(keys[j]);
    } catch (e) {}
    return fnv(parts);
  }

  // Pull + Merge; bei Änderung Push + UI-Refresh über Callback (kein Reload nötig)
  function syncNow(opts) {
    opts = opts || {};
    return pull().then(function (remote) {
      var changed = mergeApply(remote);
      // Ab hier ist der Cloud-Stand nachweislich gelesen und eingearbeitet — erst
      // jetzt darf gepusht werden. mergeApply wirft bei unlesbaren Daten, dann
      // bleibt die Sperre stehen.
      erstSyncOk = true;
      lastHash = lightHash();
      // pushDelta: beim ersten Mal (lastFields==null) voll (Migration/Baseline),
      // danach nur geänderte Sammlungen → Gesamtdaten dürfen die 4-MB-Blob-Grenze
      // überschreiten, solange jede EINZELNE Sammlung darunter bleibt.
      // Der Rückruf MUSS hier stehen, nicht erst nach dem Push: mergeApply() hat die
      // zusammengeführte Sammlung bereits in den Speicher geschrieben, und der Rückruf
      // ist es, der den RAM-Cache von app.js verwirft (invalidateBooks). Bleibt er aus,
      // arbeitet die App mit dem alten Array weiter — und das nächste saveBooks()
      // schreibt die frisch eingemergten Bücher wieder weg, auf diesem Gerät UND beim
      // nächsten erfolgreichen Push auch in der Cloud.
      // Bis v3.3 fiel das kaum auf, weil pushDelta() bei Ablehnung nur false lieferte.
      // Seit der ehrlichen 429-Behandlung in v3.4 wirft es — damit wurde aus einer
      // theoretischen Lücke ein erreichbarer Datenverlust.
      if (changed && typeof global.BKCloudOnChange === 'function') {
        try { global.BKCloudOnChange(); } catch (e) {}
      }
      return pushDelta().then(function () { return { changed: changed }; });
    });
  }

  function scheduledPush() {
    if (!isLoggedIn()) return;
    if (!erstSyncOk) return;          // siehe erstSyncOk — nie vor dem ersten Abgleich
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      var h = lightHash();
      if (h === lastHash) return;               // nichts geändert → nicht komprimieren, nicht pushen
      pushDelta().then(function (ok) { if (ok) lastHash = h; }).catch(function () {});
    }, PUSH_DEBOUNCE);
  }

  // ───── Status-Zeile (im Einstellungen-Panel) ─────
  function statusText() {
    if (!isLoggedIn()) return 'Nicht verbunden — Daten nur auf diesem Gerät.';
    var when = lastSyncAt ? ' · zuletzt ' + new Date(lastSyncAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
    return '☁️ Verbunden als ' + (getEmail() || '') + when;
  }
  function refreshStatusLine() {
    var el = document.getElementById('cloud-status-line');
    if (el) { el.textContent = statusText(); el.style.color = isLoggedIn() ? '#34d399' : '#aaa'; }
    var btn = document.getElementById('cloud-open-btn');
    if (btn) btn.textContent = isLoggedIn() ? '☁️ Cloud-Sync verwalten' : '☁️ Cloud-Sync & Konto einrichten';
  }

  // ───── Modal-UI ─────
  var elModal = null, view = 'auth', authMode = 'login', forgotMode = 'code', emailSent = false, busy = false;

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  function closeModal() { if (elModal) { elModal.remove(); elModal = null; } }

  function openModal() {
    closeModal();
    view = isLoggedIn() ? 'account' : 'auth'; emailSent = false; busy = false; lastMsg = null;
    var card = h('div', { style: cardCss(), onclick: function (e) { e.stopPropagation(); } });
    elModal = h('div', { id: 'cloud-modal', style: overlayCss(), onclick: closeModal }, [card]);
    elModal._card = card;
    document.body.appendChild(elModal);
    renderModal();
  }

  function renderModal() {
    if (!elModal) return;
    var card = elModal._card; card.innerHTML = '';
    card.appendChild(h('button', { style: 'position:absolute;top:10px;right:12px;background:none;border:none;color:#aaa;font-size:20px;cursor:pointer;line-height:1', onclick: closeModal, 'aria-label': 'Schließen' }, ['✕']));
    card.appendChild(h('div', { style: 'font-size:15px;font-weight:800;margin:0 0 4px;color:#f5c96b' }, ['☁️ Cloud-Sync']));
    card.appendChild(h('div', { style: 'font-size:11px;color:#999;margin-bottom:14px' }, ['Bücher sichern & auf mehreren Geräten nutzen. Gleiches Konto wie in der Nihongo- und Japan-App.']));
    if (view === 'account') renderAccount(card);
    else if (view === 'forgot') renderForgot(card);
    else if (view === 'recovery') renderRecovery(card);
    else renderAuth(card);
  }

  function msgBox(m) {
    if (!m) return null;
    return h('div', { style: 'margin-top:10px;padding:8px 10px;border-radius:9px;font-size:11.5px;line-height:1.4;background:' + (m.ok ? 'rgba(52,211,153,.12);color:#34d399;border:1px solid rgba(52,211,153,.3)' : 'rgba(244,63,94,.12);color:#fb7185;border:1px solid rgba(244,63,94,.3)') }, [m.text]);
  }

  var lastMsg = null;
  function setMsg(m) { lastMsg = m; renderModal(); }

  // — Angemeldet —
  function renderAccount(card) {
    card.appendChild(h('div', { style: 'display:flex;align-items:center;gap:9px;padding:11px;border-radius:11px;background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);margin-bottom:12px' }, [
      h('span', { style: 'font-size:20px' }, ['☁️']),
      h('div', { style: 'min-width:0;flex:1' }, [
        h('div', { style: 'font-size:12px;font-weight:800;color:#34d399' }, ['Cloud-Sync aktiv']),
        h('div', { style: 'font-size:10.5px;color:#9bb3ad;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [getEmail() || '']),
        h('div', { style: 'font-size:10px;color:#7f96a0;margin-top:2px' }, [lastSyncAt ? ('Zuletzt synchronisiert: ' + new Date(lastSyncAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) : 'Noch nicht synchronisiert'])
      ])
    ]));
    var row = h('div', { style: 'display:flex;gap:8px' }, [
      h('button', { style: btnCss('rgba(16,185,129,.4)', 'rgba(16,185,129,.12)', '#34d399', busy), onclick: function () {
        if (busy) return; busy = true; setMsg({ ok: true, text: 'Synchronisiere…' });
        syncNow({}).then(function () { busy = false; setMsg({ ok: true, text: 'Synchronisiert ✓' }); }).catch(function (e) { busy = false; setMsg({ ok: false, text: e.message }); });
      } }, [busy ? '…' : '🔄 Jetzt synchronisieren']),
      h('button', { style: btnCss('rgba(255,255,255,.18)', 'transparent', '#ccc', false), onclick: function () { logout(); view = 'auth'; lastMsg = null; renderModal(); } }, ['Abmelden'])
    ]);
    card.appendChild(row);
    card.appendChild(h('div', { style: 'font-size:10px;color:#888;margin-top:10px;line-height:1.5' }, ['Deine Bücher werden automatisch im Hintergrund gesichert. Auf einem neuen Gerät einfach anmelden — die Sammlung kommt zurück.']));
    var mb = msgBox(lastMsg); if (mb) card.appendChild(mb);
  }

  // Passwort-Feld mit Auge zum Ein-/Ausblenden
  function pwField(ph, ac) {
    var input = h('input', { type: 'password', placeholder: ph, autocomplete: ac, style: inputCss() + ';margin-bottom:0;padding-right:42px' });
    var btn = h('button', { type: 'button', 'aria-label': 'Passwort anzeigen', style: 'position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:16px;line-height:1;padding:4px;color:#bbb;-webkit-tap-highlight-color:transparent' }, ['👁']);
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '🙈' : '👁';
      btn.setAttribute('aria-label', show ? 'Passwort verbergen' : 'Passwort anzeigen');
    });
    return { wrap: h('div', { style: 'position:relative;margin-bottom:9px' }, [input, btn]), input: input };
  }

  // — Anmelden / Registrieren —
  function renderAuth(card) {
    var tabs = h('div', { style: 'display:flex;gap:6px;margin-bottom:12px;background:rgba(255,255,255,.05);padding:4px;border-radius:10px' },
      [['login', 'Anmelden'], ['register', 'Registrieren']].map(function (t) {
        var on = authMode === t[0];
        return h('button', { style: 'flex:1;padding:7px;border-radius:7px;border:none;cursor:pointer;font-size:12px;font-weight:700;background:' + (on ? 'linear-gradient(135deg,#d97706,#92400e)' : 'transparent') + ';color:' + (on ? '#fff' : '#999'), onclick: function () { authMode = t[0]; lastMsg = null; renderModal(); } }, [t[1]]);
      }));
    card.appendChild(tabs);
    var email = h('input', { type: 'email', placeholder: 'E-Mail', autocomplete: 'email', style: inputCss() });
    var pwf = pwField('Passwort (mind. 6 Zeichen)', authMode === 'register' ? 'new-password' : 'current-password');
    var pw = pwf.input;
    if (lastVals.email) email.value = lastVals.email;
    card.appendChild(email); card.appendChild(pwf.wrap);
    var submit = h('button', { style: primaryBtnCss(busy), onclick: function () {
      if (busy) return; lastVals.email = email.value;
      var e = email.value.trim(), p = pw.value;
      busy = true; setMsg({ ok: true, text: 'Bitte warten…' });
      var op = authMode === 'register' ? register(e, p) : login(e, p);
      op.then(function (j) {
        return syncNow({}).then(function () {
          busy = false;
          if (authMode === 'register' && j.recoveryCode) { recoveryCodeShown = j.recoveryCode; view = 'recovery'; lastMsg = null; renderModal(); }
          else { view = 'account'; lastMsg = { ok: true, text: 'Angemeldet & synchronisiert ✓' }; renderModal(); refreshStatusLine(); }
        });
      }).catch(function (err) { busy = false; setMsg({ ok: false, text: err.message }); });
    } }, [busy ? 'Bitte warten…' : (authMode === 'login' ? 'Anmelden' : 'Konto erstellen')]);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit.click(); });
    card.appendChild(submit);
    if (authMode === 'login')
      card.appendChild(h('button', { style: 'width:100%;margin-top:9px;background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:#fca5a5', onclick: function () { view = 'forgot'; forgotMode = 'code'; lastMsg = null; emailSent = false; renderModal(); } }, ['Passwort vergessen?']));
    var mb = msgBox(lastMsg); if (mb) card.appendChild(mb);
  }

  // — Recovery-Code nach Registrierung anzeigen —
  var recoveryCodeShown = null;
  function renderRecovery(card) {
    card.appendChild(h('div', { style: 'font-size:12px;color:#34d399;font-weight:700;margin-bottom:6px' }, ['✓ Konto erstellt']));
    card.appendChild(h('div', { style: 'font-size:11.5px;color:#ddd;line-height:1.5;margin-bottom:10px' }, ['Notiere dir diesen Wiederherstellungs-Code GUT. Damit setzt du dein Passwort zurück, falls du es vergisst (auch ohne E-Mail):']));
    card.appendChild(h('div', { style: 'font-family:monospace;font-size:20px;font-weight:800;letter-spacing:3px;text-align:center;padding:14px;border-radius:11px;background:rgba(255,255,255,.06);border:1px dashed rgba(245,201,107,.5);color:#fff;user-select:all' }, [recoveryCodeShown || '']));
    card.appendChild(h('button', { style: primaryBtnCss(false) + ';margin-top:14px', onclick: function () { view = 'account'; lastMsg = { ok: true, text: 'Willkommen! Cloud-Sync ist aktiv ✓' }; renderModal(); refreshStatusLine(); } }, ['Code notiert — weiter']));
  }

  // — Passwort vergessen —
  function renderForgot(card) {
    var tabs = h('div', { style: 'display:flex;gap:6px;margin-bottom:12px;background:rgba(255,255,255,.05);padding:4px;border-radius:10px' },
      [['code', 'Mit Code'], ['email', 'Per E-Mail']].map(function (t) {
        var on = forgotMode === t[0];
        return h('button', { style: 'flex:1;padding:7px;border-radius:7px;border:none;cursor:pointer;font-size:11.5px;font-weight:700;background:' + (on ? 'linear-gradient(135deg,#d97706,#92400e)' : 'transparent') + ';color:' + (on ? '#fff' : '#999'), onclick: function () { forgotMode = t[0]; lastMsg = null; emailSent = false; renderModal(); } }, [t[1]]);
      }));
    card.appendChild(tabs);
    var email = h('input', { type: 'email', placeholder: 'E-Mail', autocomplete: 'email', style: inputCss(), value: lastVals.email || '' });
    card.appendChild(email);

    if (forgotMode === 'code') {
      var code = h('input', { type: 'text', placeholder: 'Wiederherstellungs-Code', autocapitalize: 'characters', style: inputCss() });
      var npwf = pwField('Neues Passwort (mind. 6 Zeichen)', 'new-password'); var npw = npwf.input;
      card.appendChild(code); card.appendChild(npwf.wrap);
      card.appendChild(h('button', { style: primaryBtnCss(busy), onclick: function () {
        if (busy) return; busy = true; setMsg({ ok: true, text: 'Prüfe…' });
        recoverWithCode(email.value.trim(), code.value, npw.value).then(function (j) {
          return syncNow({}).then(function () {
            busy = false;
            if (j.recoveryCode) { recoveryCodeShown = j.recoveryCode; view = 'recovery'; lastMsg = null; renderModal(); }
            else { view = 'account'; lastMsg = { ok: true, text: 'Passwort neu gesetzt ✓' }; renderModal(); refreshStatusLine(); }
          });
        }).catch(function (e) { busy = false; setMsg({ ok: false, text: e.message }); });
      } }, ['Passwort zurücksetzen']));
    } else {
      if (!emailSent) {
        card.appendChild(h('button', { style: primaryBtnCss(busy), onclick: function () {
          if (busy) return; busy = true; setMsg({ ok: true, text: 'Sende Code…' });
          requestEmailReset(email.value.trim()).then(function (r) {
            busy = false; lastVals.email = email.value.trim();
            if (r && r.mailReady === false) setMsg({ ok: false, text: 'E-Mail-Versand ist nicht aktiviert. Bitte nutze den Wiederherstellungs-Code.' });
            else { emailSent = true; setMsg({ ok: true, text: 'Falls die E-Mail existiert, wurde ein 6-stelliger Code gesendet.' }); }
          }).catch(function (e) { busy = false; setMsg({ ok: false, text: e.message }); });
        } }, ['Code per E-Mail senden']));
      } else {
        var ecode = h('input', { type: 'text', inputmode: 'numeric', placeholder: '6-stelliger Code', style: inputCss() });
        var enpwf = pwField('Neues Passwort (mind. 6 Zeichen)', 'new-password'); var enpw = enpwf.input;
        card.appendChild(ecode); card.appendChild(enpwf.wrap);
        card.appendChild(h('button', { style: primaryBtnCss(busy), onclick: function () {
          if (busy) return; busy = true; setMsg({ ok: true, text: 'Prüfe…' });
          resetWithEmailCode(email.value.trim(), ecode.value, enpw.value).then(function () {
            return syncNow({}).then(function () { busy = false; view = 'account'; lastMsg = { ok: true, text: 'Passwort neu gesetzt ✓' }; renderModal(); refreshStatusLine(); });
          }).catch(function (e) { busy = false; setMsg({ ok: false, text: e.message }); });
        } }, ['Passwort zurücksetzen']));
      }
    }
    card.appendChild(h('button', { style: 'width:100%;margin-top:9px;background:none;border:none;color:#fca5a5;cursor:pointer;font-size:11px;font-weight:600', onclick: function () { view = 'auth'; lastMsg = null; renderModal(); } }, ['← Zurück zur Anmeldung']));
    var mb = msgBox(lastMsg); if (mb) card.appendChild(mb);
  }

  var lastVals = {};

  // ───── Styles ─────
  function overlayCss() { return 'position:fixed;inset:0;z-index:100020;background:rgba(10,7,5,.66);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px;-webkit-tap-highlight-color:transparent'; }
  function cardCss() { return 'position:relative;width:100%;max-width:340px;max-height:88vh;overflow:auto;background:rgba(28,21,16,.98);border:1px solid rgba(245,201,107,.28);border-radius:16px;padding:18px;box-shadow:0 24px 64px rgba(0,0,0,.6);font-family:var(--font-ui,system-ui,sans-serif)'; }
  function inputCss() { return 'width:100%;box-sizing:border-box;margin-bottom:9px;padding:11px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.05);color:#fff;font-size:13px;font-family:inherit;outline:none'; }
  function primaryBtnCss(b) { return 'width:100%;padding:11px;border-radius:11px;border:none;background:' + (b ? '#444' : 'linear-gradient(135deg,#d97706,#92400e)') + ';color:#fff;cursor:' + (b ? 'default' : 'pointer') + ';font-size:13px;font-weight:800;font-family:inherit'; }
  function btnCss(bd, bg, col, b) { return 'flex:1;padding:9px;border-radius:10px;border:1px solid ' + bd + ';background:' + bg + ';color:' + col + ';cursor:' + (b ? 'default' : 'pointer') + ';font-size:12px;font-weight:700;font-family:inherit'; }

  // ───── Auto-Sync-Lebenszyklus ─────
  function start() {
    if (started) return; started = true;
    try { lastSyncAt = parseInt(lsGet('bk_cloud_lastsync') || '0', 10) || 0; } catch (e) {}
    refreshStatusLine();
    if (isLoggedIn()) {
      syncNow({}).catch(function () {});
    }
    setInterval(function () {
      // Scheiterte der Start-Abgleich, wird er hier WIEDERHOLT statt einfach zu
      // pushen. Vorher rief das Intervall trotz des Namens POLL_MS nur scheduledPush() —
      // ein offline gestarteter Tab schob seinen ungeprüften Stand in die Cloud,
      // sobald das Netz zurückkam.
      if (isLoggedIn() && !erstSyncOk && !leseFehler) {
        syncNow({}).catch(function () {});
        refreshStatusLine();
        return;
      }
      scheduledPush();
      refreshStatusLine();
    }, POLL_MS);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && isLoggedIn() && erstSyncOk) {
        var hh = lightHash();
        if (hh !== lastHash) pushDelta().then(function (ok) { if (ok) lastHash = hh; }).catch(function () {});
      }
    });
  }

  // ───── Export ─────
  global.BKCloud = {
    openModal: openModal, closeModal: closeModal,
    isLoggedIn: isLoggedIn, getEmail: getEmail, logout: logout,
    wipe: wipe,
    syncNow: syncNow, statusText: statusText, refreshStatusLine: refreshStatusLine,
    start: start
  };

  // Auto-Sync erst starten, wenn der IndexedDB-Speicher geladen ist — sonst würde der erste
  // Push eine noch leere Sammlung hochladen und die Cloud-Daten überschreiben (Datenverlust!).
  function boot() {
    var ready = (global.HonStore && global.HonStore.ready) ? global.HonStore.ready : Promise.resolve();
    ready.then(start, start);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
