import bcrypt from "bcryptjs";
import { getRedis, makeToken, readBody, norm, clientIp, rateLimit, authReady, DUMMY_HASH } from "./_lib.js";

// Anmeldung. Funktioniert mit demselben Konto wie die Nihongo-/Japan-App (geteilte user:<email>).
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const redis = getRedis();
  if (!redis) return res.status(503).json({ error: "Cloud-Sync ist noch nicht eingerichtet." });
  if (!authReady()) return res.status(503).json({ error: "Login ist nicht eingerichtet (JWT_SECRET fehlt)." });
  if (!(await rateLimit(`login:${clientIp(req)}`, 15, 900)))
    return res.status(429).json({ error: "Zu viele Versuche. Bitte später erneut." });

  const { email, password } = readBody(req);
  const e = norm(email);
  const user = await redis.get(`user:${e}`);
  // Konstante Laufzeit: auch bei nicht existentem Konto einen bcrypt-Vergleich
  // ausführen (gegen Dummy-Hash), damit die Antwortzeit keine Existenz verrät.
  const hash = (user && user.hash) ? user.hash : DUMMY_HASH;
  const ok = await bcrypt.compare(password || "", hash);
  if (!user || !user.hash || !ok) return res.status(401).json({ error: "E-Mail oder Passwort falsch." });

  const pv = user.pwdAt || user.createdAt || 0;
  return res.status(200).json({ token: makeToken(e, pv), email: e });
}
