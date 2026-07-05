// Geteilte Helfer für die Cloud-Sync-Endpoints (Vercel Serverless, Node-Runtime).
// Backend ist API-kompatibel mit der Nihongo-/Japan-App und nutzt DIESELBE Upstash-Redis-DB:
//   user:<email>        → Konto (geteilt über alle Apps, gleicher Login)
//   data:books:<email>  → Bücherdaten dieser App (getrennt von den anderen Apps)
//   reset:<email>       → kurzlebiger E-Mail-Reset-Code
import { Redis } from "@upstash/redis";
import jwt from "jsonwebtoken";
import { randomInt } from "node:crypto";

// Lazy-Init: stürzt nicht ab, wenn die DB noch nicht eingerichtet ist.
// Erkennt mehrere Namensschemata (Vercel-Upstash-Integration benennt die Vars unterschiedlich).
let _redis = null;
// Findet Upstash-REST-Zugangsdaten unter den verschiedenen Namen, die die
// Vercel-/Upstash-Integrationen vergeben — inkl. datenbankspezifischer Präfixe.
function resolveRedisEnv() {
  const e = process.env;
  // 1) Bekannte Namen zuerst (eindeutig)
  let url = e.UPSTASH_REDIS_REST_URL || e.KV_REST_API_URL || e.REDIS_REST_URL || e.STORAGE_REST_URL;
  let token = e.UPSTASH_REDIS_REST_TOKEN || e.KV_REST_API_TOKEN || e.REDIS_REST_TOKEN || e.STORAGE_REST_TOKEN;
  if (url && token) return { url, token };
  // 2) Generisch: irgendeine REST-URL + passendes (Schreib-)Token, egal welches Präfix
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (!v) continue;
    if (!url && /REST.*URL/i.test(k) && /^https?:\/\//.test(v)) url = v;
    if (!token && /REST.*TOKEN/i.test(k) && !/READ_?ONLY/i.test(k)) token = v;
  }
  return { url, token };
}
export function getRedis() {
  if (_redis) return _redis;
  const { url, token } = resolveRedisEnv();
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}
// Kein Fallback-Secret: ohne gesetztes JWT_SECRET wäre der Signatur-Schlüssel
// öffentlich (steht im Repo) und jeder könnte Tokens fälschen. Dann lieber 503.
const SECRET = process.env.JWT_SECRET || null;
export const authReady = () => !!SECRET;

export const makeToken = (email) => {
  if (!SECRET) throw new Error("JWT_SECRET ist nicht gesetzt");
  return jwt.sign({ email }, SECRET, { expiresIn: "365d" });
};

export function verifyToken(req) {
  if (!SECRET) return null;
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return null;
  try { return jwt.verify(t, SECRET).email; } catch { return null; }
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

export const norm = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
export const clientIp = (req) =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";

// Einfaches Rate-Limit (Redis-Counter pro Fenster) gegen Brute-Force.
export async function rateLimit(key, max, windowSec) {
  const redis = getRedis();
  if (!redis) return true;
  const k = `rl:${key}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, windowSec);
  return n <= max;
}

// ── Passwort-Wiederherstellung ────────────────────────────────────────────────
// Codes normalisieren (Groß-/Kleinschreibung + Bindestriche egal)
export const canon = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Wiederherstellungs-Code (ohne mehrdeutige Zeichen O/0/I/1), Anzeige in 4er-Gruppen
const RC_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
// crypto.randomInt statt Math.random: Reset-/Recovery-Codes müssen unvorhersagbar sein.
export function genRecovery() {
  let s = "";
  for (let i = 0; i < 12; i++) { if (i && i % 4 === 0) s += "-"; s += RC_CHARS[randomInt(RC_CHARS.length)]; }
  return s;
}
export function genDigits(n) { let s = ""; for (let i = 0; i < n; i++) s += randomInt(10); return s; }

// E-Mail-Versand via Resend (nur aktiv, wenn RESEND_API_KEY gesetzt ist).
export const mailReady = () => !!process.env.RESEND_API_KEY;
export async function sendMail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log("[mail] kein RESEND_API_KEY gesetzt"); return false; }
  const from = process.env.RESEND_FROM || "Hon <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    const body = await r.text();
    console.log(`[mail] resend status=${r.status} from="${from}" to="${to}" resp=${body.slice(0, 300)}`);
    return r.ok;
  } catch (e) { console.log("[mail] resend fehler:", String(e).slice(0, 200)); return false; }
}
