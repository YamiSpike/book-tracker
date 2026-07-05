import bcrypt from "bcryptjs";
import { getRedis, makeToken, readBody, norm, validEmail, clientIp, rateLimit, canon, genRecovery, genDigits, mailReady, sendMail, authReady } from "./_lib.js";

// Passwort-Wiederherstellung (geteiltes Konto mit den anderen Apps):
//  action "request" → 6-stelligen Code per E-Mail senden (nur wenn Mail-Dienst aktiv)
//  action "email"   → mit E-Mail-Code neues Passwort setzen
//  action "code"    → mit Wiederherstellungs-Code neues Passwort setzen
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: "Cloud-Sync ist noch nicht eingerichtet." });
  if (!authReady()) return res.status(503).json({ error: "Wiederherstellung ist nicht eingerichtet (JWT_SECRET fehlt)." });
  if (!(await rateLimit(`rec:${clientIp(req)}`, 20, 3600)))
    return res.status(429).json({ error: "Zu viele Versuche. Bitte später erneut." });

  const { action, email, code, newPassword } = readBody(req);
  const e = norm(email);
  if (!validEmail(e)) return res.status(400).json({ error: "Ungültige E-Mail-Adresse." });

  // 1) E-Mail-Code anfordern
  if (action === "request") {
    if (!mailReady()) return res.status(200).json({ ok: false, mailReady: false });
    const user = await redis.get(`user:${e}`);
    if (user) {
      const c = genDigits(6);
      await redis.set(`reset:${e}`, await bcrypt.hash(c, 10), { ex: 900 });
      await sendMail(
        e,
        "Hon · Bücher Tracker — Passwort zurücksetzen",
        `<div style="font-family:system-ui,sans-serif;max-width:420px">
           <h2 style="color:#b45309">Hon 本 · Bücher Tracker — Passwort zurücksetzen</h2>
           <p>Dein Bestätigungs-Code lautet:</p>
           <p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#111">${c}</p>
           <p style="color:#666">Der Code ist 15 Minuten gültig. Falls du das nicht warst, ignoriere diese E-Mail einfach.</p>
         </div>`
      );
    }
    // Existenz der E-Mail nicht verraten
    return res.status(200).json({ ok: true, mailReady: true });
  }

  // 2) Neues Passwort setzen (per E-Mail-Code oder Wiederherstellungs-Code)
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: "Das neue Passwort braucht mindestens 6 Zeichen." });
  const user = await redis.get(`user:${e}`);

  if (action === "code") {
    if (!user || !user.recoveryHash) return res.status(401).json({ error: "E-Mail oder Code falsch." });
    const ok = await bcrypt.compare(canon(code), user.recoveryHash);
    if (!ok) return res.status(401).json({ error: "Wiederherstellungs-Code falsch." });
  } else if (action === "email") {
    const stored = await redis.get(`reset:${e}`);
    if (!stored) return res.status(401).json({ error: "Code abgelaufen oder ungültig. Bitte neu anfordern." });
    const ok = await bcrypt.compare(String(code || "").trim(), stored);
    if (!ok) return res.status(401).json({ error: "Code falsch." });
    if (!user) return res.status(401).json({ error: "Konto nicht gefunden." });
    await redis.del(`reset:${e}`);
  } else {
    return res.status(400).json({ error: "Unbekannte Aktion." });
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const recoveryCode = genRecovery();
  const recoveryHash = await bcrypt.hash(canon(recoveryCode), 10);
  await redis.set(`user:${e}`, { ...user, hash, recoveryHash });
  return res.status(200).json({ token: makeToken(e), email: e, recoveryCode });
}
