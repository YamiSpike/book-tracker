import crypto from "node:crypto";
import { getRedis, verifyToken, readBody, clientIp, rateLimit } from "./_lib.js";

// Sammlung als Read-only-Link teilen.
//  POST (angemeldet): Snapshot der Bücher speichern → { id }, 30 Tage gültig
//  GET ?id=…        : Snapshot lesen (öffentlich, aber rate-limitiert)
//  DELETE ?id=…     : eigenen Share-Link löschen
const TTL = 60 * 60 * 24 * 30; // 30 Tage
const MAX_BYTES = 900_000;     // Snapshot-Limit gegen Speicher-Missbrauch

// IDs sind base64url (A-Za-z0-9-_). Bis v3.4 entfernte der Schlüssel - und _ und
// warf damit verschiedene IDs auf denselben Redis-Schlüssel. Jetzt bleiben sie
// erhalten; alles andere fliegt weiterhin raus, damit von außen kein fremder
// Schlüssel adressierbar wird.
function shareKey(id) {
  return "share:books:" + String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
}
// Vor v3.5 angelegte Links liegen unter dem alten, entschärften Schlüssel.
function shareKeyAlt(id) {
  return "share:books:" + String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}
// Link laden und dabei sagen, unter WELCHEM Schlüssel er lag (fürs Löschen).
// Der Rückfall greift nur, wenn die ID überhaupt - oder _ enthält — sonst sind
// beide Schlüssel ohnehin identisch und ein zweiter Zugriff wäre verschwendet.
async function ladeShare(redis, id) {
  const key = shareKey(id);
  const data = await redis.get(key);
  if (data) return { key, data };
  if (!/[-_]/.test(String(id || ""))) return { key, data: null };
  const alt = shareKeyAlt(id);
  return { key: alt, data: await redis.get(alt) };
}

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: "Cloud-Sync ist noch nicht eingerichtet." });

  if (req.method === "GET") {
    if (!(await rateLimit(`shareget:${clientIp(req)}`, 60, 600)))
      return res.status(429).json({ error: "Zu viele Anfragen. Bitte später erneut." });
    const id = (req.query && req.query.id) || "";
    if (!id) return res.status(400).json({ error: "Kein Link angegeben." });
    const { data } = await ladeShare(redis, id);
    if (!data) return res.status(404).json({ error: "Dieser Teilen-Link existiert nicht mehr (Links gelten 30 Tage)." });
    return res.status(200).json({ books: data.books || [], owner: data.owner || "", createdAt: data.createdAt || 0 });
  }

  const email = verifyToken(req);
  if (!email) return res.status(401).json({ error: "Nicht angemeldet." });

  if (req.method === "POST") {
    if (!(await rateLimit(`sharepost:${email}`, 10, 3600)))
      return res.status(429).json({ error: "Zu viele Links erstellt. Bitte später erneut." });
    const { books } = readBody(req);
    if (!Array.isArray(books) || !books.length)
      return res.status(400).json({ error: "Keine Bücher zum Teilen." });
    if (JSON.stringify(books).length > MAX_BYTES)
      return res.status(413).json({ error: "Sammlung zu groß zum Teilen." });
    // Nur unbedenkliche Felder übernehmen (keine Notizen — die sind privat)
    const safe = books.slice(0, 1000).map((b) => ({
      id: String(b.id || "").slice(0, 60),
      title: String(b.title || "").slice(0, 200),
      authors: (b.authors || []).slice(0, 4).map((a) => String(a).slice(0, 80)),
      cover: /^https:\/\//.test(b.cover || "") ? String(b.cover).slice(0, 300) : "",
      year: String(b.year || "").slice(0, 4),
      pages: Number(b.pages) || 0,
      categories: (b.categories || []).slice(0, 4).map((c) => String(c).slice(0, 60)),
      status: ["read", "reading", "want"].includes(b.status) ? b.status : "read",
      rating: Math.min(5, Math.max(0, Number(b.rating) || 0)),
    }));
    // Nutzername vor dem @ reicht als Anzeige — volle E-Mail nicht veröffentlichen
    const owner = email.split("@")[0];
    const id = crypto.randomBytes(8).toString("base64url");
    // ownerEmail ist die verlässliche Besitzangabe für die Lösch-Prüfung. Sie wird
    // NIE ausgeliefert — der GET-Zweig gibt nur owner/books/createdAt zurück.
    // Der Anzeigename `owner` allein reicht nicht: max@gmx.de und max@gmail.com
    // ergeben beide "max".
    await redis.set(shareKey(id), { owner, ownerEmail: email, books: safe, createdAt: Date.now() }, { ex: TTL });
    return res.status(200).json({ id });
  }

  if (req.method === "DELETE") {
    if (!(await rateLimit(`sharedel:${email}`, 30, 3600)))
      return res.status(429).json({ error: "Zu viele Anfragen. Bitte später erneut." });
    const id = (req.query && req.query.id) || "";
    if (!id) return res.status(400).json({ error: "Kein Link angegeben." });
    const { key, data } = await ladeShare(redis, id);
    if (!data) return res.status(200).json({ ok: true });   // schon weg oder abgelaufen
    // Besitz prüfen — angemeldet zu sein reicht NICHT, sonst löscht jedes Konto
    // jeden fremden Link, dessen ID es kennt. Ältere Links (vor v3.4) haben kein
    // ownerEmail; für die auf den Anzeigenamen zurückfallen, damit sie löschbar bleiben.
    const passt = data.ownerEmail
      ? data.ownerEmail === email
      : data.owner === email.split("@")[0];
    if (!passt) return res.status(403).json({ error: "Dieser Link gehört zu einem anderen Konto." });
    await redis.del(key);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
