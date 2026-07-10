import { getRedis, verifyPayload, readBody } from "./_lib.js";

// Bücherdaten laden/speichern — DELTA-SYNC pro Sammlung als Redis-Hash.
// Jede Top-Level-Sammlung (bk_*-Key bzw. bk_books_lz) liegt als eigenes Hash-Feld,
// sodass nur GEÄNDERTE Sammlungen hochgeladen werden und das 4-MB-Limit pro
// Sammlung statt für alles zusammen gilt → deutlich mehr Daten möglich.
// Abwärtskompatibel: der alte Einzel-Blob (String) wird beim ersten Schreiben
// verlustfrei in einen Hash migriert; der Voll-Modus funktioniert weiterhin.
function dataKey(req, email) {
  const app = String((req.query && req.query.app) || "books").replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "books";
  return `data:${app}:${email}`;
}

const FIELD_MAX = 4_000_000; // je Sammlung max. 4 MB (unter Vercels 4.5-MB-Body-Grenze)
const FIELDS_MAX = 200;      // Schutz gegen Feld-Flut

const sizeOf = (v) => (typeof v === "string" ? v : JSON.stringify(v)).length;

// Alten String-Blob (falls vorhanden) verlustfrei in einen Hash umwandeln.
// Danach ist der Key ein Hash und hset/hdel/hkeys funktionieren.
async function migrateIfLegacy(redis, key) {
  const t = await redis.type(key);
  if (t !== "string") return;
  const legacy = await redis.get(key); // Upstash liefert das Objekt zurück
  await redis.del(key);
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy) && Object.keys(legacy).length) {
    await redis.hset(key, legacy);
  }
}

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: "Cloud-Sync ist noch nicht eingerichtet." });
  const p = verifyPayload(req);
  if (!p) return res.status(401).json({ error: "Nicht angemeldet." });
  const email = p.email;
  // Revoke-Prüfung: nach einem Passwort-Reset ausgestellte Tokens haben pv >= user.pwdAt;
  // ältere Tokens werden dadurch ungültig (Token-Diebstahl-/Reset-Schutz).
  const user = await redis.get(`user:${email}`);
  if (user && (user.pwdAt || 0) > (p.pv || 0)) return res.status(401).json({ error: "Sitzung abgelaufen. Bitte neu anmelden." });

  const key = dataKey(req, email);

  if (req.method === "GET") {
    const t = await redis.type(key);
    if (t === "hash") {
      const data = await redis.hgetall(key);
      return res.status(200).json({ data: data && Object.keys(data).length ? data : null });
    }
    if (t === "string") {
      const data = await redis.get(key); // alter Voll-Blob
      return res.status(200).json({ data: data || null });
    }
    return res.status(200).json({ data: null });
  }

  if (req.method === "POST") {
    const body = readBody(req);

    // ── Delta-Modus: nur geänderte Felder (patch) + gelöschte (remove) ──
    if (body && (body.patch || body.remove)) {
      const patch = body.patch;
      const remove = Array.isArray(body.remove) ? body.remove.map(String).slice(0, FIELDS_MAX) : [];
      if (patch != null && (typeof patch !== "object" || Array.isArray(patch)))
        return res.status(400).json({ error: "Ungültiges Delta." });
      const fields = patch && typeof patch === "object" ? patch : {};
      const fk = Object.keys(fields);
      if (fk.length > FIELDS_MAX) return res.status(413).json({ error: "Zu viele Sammlungen im Delta." });
      for (const k of fk) if (sizeOf(fields[k]) > FIELD_MAX)
        return res.status(413).json({ error: `Sammlung „${k}" zu groß für Cloud-Sync (max. 4 MB).` });
      await migrateIfLegacy(redis, key);
      if (fk.length) await redis.hset(key, fields);
      if (remove.length) await redis.hdel(key, ...remove);
      return res.status(200).json({ ok: true, savedAt: Date.now(), mode: "delta" });
    }

    // ── Voll-Modus (Erstsync / Migration / Fallback): kompletter Datensatz ──
    const { data } = body || {};
    if (data == null || typeof data !== "object" || Array.isArray(data))
      return res.status(400).json({ error: "Keine gültigen Daten." });
    const keys = Object.keys(data);
    if (keys.length > FIELDS_MAX) return res.status(413).json({ error: "Zu viele Sammlungen." });
    for (const k of keys) if (sizeOf(data[k]) > FIELD_MAX)
      return res.status(413).json({ error: `Sammlung „${k}" zu groß für Cloud-Sync (max. 4 MB).` });
    // Ohne Lösch-Fenster: erst migrieren/als-Hash sicherstellen, dann neue Felder setzen
    // und nur die nicht mehr vorhandenen entfernen (Datensatz bleibt jederzeit lesbar).
    await migrateIfLegacy(redis, key);
    const existing = (await redis.type(key)) === "hash" ? await redis.hkeys(key) : [];
    if (keys.length) await redis.hset(key, data);
    const toRemove = existing.filter((k) => !keys.includes(k));
    if (toRemove.length) await redis.hdel(key, ...toRemove);
    return res.status(200).json({ ok: true, savedAt: Date.now(), mode: "full" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
