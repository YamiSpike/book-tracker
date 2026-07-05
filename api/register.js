import bcrypt from "bcryptjs";
import { getRedis, makeToken, readBody, norm, validEmail, clientIp, rateLimit, genRecovery, canon, authReady } from "./_lib.js";

// Registrierung. Konten sind über alle Apps geteilt (user:<email>).
// Existiert die E-Mail schon (z.B. aus der Nihongo-/Japan-App), bitte stattdessen anmelden.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: "Cloud-Sync ist noch nicht eingerichtet." });
  if (!authReady()) return res.status(503).json({ error: "Registrierung ist nicht eingerichtet (JWT_SECRET fehlt)." });
  if (!(await rateLimit(`reg:${clientIp(req)}`, 10, 3600)))
    return res.status(429).json({ error: "Zu viele Versuche. Bitte später erneut." });

  const { email, password } = readBody(req);
  const e = norm(email);
  if (!validEmail(e)) return res.status(400).json({ error: "Ungültige E-Mail-Adresse." });
  if (!password || password.length < 6)
    return res.status(400).json({ error: "Das Passwort braucht mindestens 6 Zeichen." });

  const exists = await redis.get(`user:${e}`);
  if (exists) return res.status(409).json({ error: "Diese E-Mail ist bereits registriert. Bitte anmelden." });

  const hash = await bcrypt.hash(password, 10);
  const recoveryCode = genRecovery();
  const recoveryHash = await bcrypt.hash(canon(recoveryCode), 10);
  await redis.set(`user:${e}`, { email: e, hash, recoveryHash, createdAt: Date.now() });
  return res.status(200).json({ token: makeToken(e), email: e, recoveryCode });
}
