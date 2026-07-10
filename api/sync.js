import { getRedis, verifyPayload, readBody } from "./_lib.js";

// Bücherdaten laden/speichern. Eigener Namespace (data:books:<email>), damit die
// Daten der anderen Apps (Nihongo, Japan) NICHT überschrieben werden.
function dataKey(req, email) {
  const app = String((req.query && req.query.app) || "books").replace(/[^a-z0-9_-]/gi, "").slice(0, 24) || "books";
  return `data:${app}:${email}`;
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
    const data = await redis.get(key);
    return res.status(200).json({ data: data || null });
  }
  if (req.method === "POST") {
    const { data } = readBody(req);
    if (data == null || typeof data !== "object")
      return res.status(400).json({ error: "Keine gültigen Daten." });
    // Größenlimit gegen Speicher-Missbrauch (Redis-Kosten/DoS). 4 MB, damit auch große
    // Sammlungen (mehrere tausend Titel) syncen — bleibt unter Vercels 4.5-MB-Body-Grenze.
    if (JSON.stringify(data).length > 4_000_000)
      return res.status(413).json({ error: "Sammlung zu groß für Cloud-Sync (max. 4 MB). Bitte Duplikate entfernen; ein JSON-Backup funktioniert weiterhin." });
    await redis.set(key, data);
    return res.status(200).json({ ok: true, savedAt: Date.now() });
  }
  return res.status(405).json({ error: "Method not allowed" });
}
