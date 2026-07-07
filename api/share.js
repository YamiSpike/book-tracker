import crypto from "node:crypto";
import { getRedis, verifyToken, readBody, clientIp, rateLimit } from "./_lib.js";

// Sammlung als Read-only-Link teilen.
//  POST (angemeldet): Snapshot der Bücher speichern → { id }, 30 Tage gültig
//  GET ?id=…        : Snapshot lesen (öffentlich, aber rate-limitiert)
//  DELETE ?id=…     : eigenen Share-Link löschen
const TTL = 60 * 60 * 24 * 30; // 30 Tage
const MAX_BYTES = 900_000;     // Snapshot-Limit gegen Speicher-Missbrauch

function shareKey(id) {
  return "share:books:" + String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}

export default async function handler(req, res) {
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: "Cloud-Sync ist noch nicht eingerichtet." });

  if (req.method === "GET") {
    if (!(await rateLimit(`shareget:${clientIp(req)}`, 60, 600)))
      return res.status(429).json({ error: "Zu viele Anfragen. Bitte später erneut." });
    const id = (req.query && req.query.id) || "";
    if (!id) return res.status(400).json({ error: "Kein Link angegeben." });
    const data = await redis.get(shareKey(id));
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
    await redis.set(shareKey(id), { owner, books: safe, createdAt: Date.now() }, { ex: TTL });
    return res.status(200).json({ id });
  }

  if (req.method === "DELETE") {
    const id = (req.query && req.query.id) || "";
    if (!id) return res.status(400).json({ error: "Kein Link angegeben." });
    await redis.del(shareKey(id));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
