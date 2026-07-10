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

// pv = "password version" (Zeitstempel des letzten Passwort-Setzens). Ins Token
// eingebettet; nach einem Passwort-Reset werden ältere Tokens dadurch ungültig.
export const makeToken = (email, pv = 0) => {
  if (!SECRET) throw new Error("JWT_SECRET ist nicht gesetzt");
  return jwt.sign({ email, pv }, SECRET, { expiresIn: "365d" });
};

// Nur E-Mail (für einfache Endpunkte). Keine Revoke-Prüfung.
export function verifyToken(req) {
  const p = verifyPayload(req);
  return p ? p.email : null;
}
// Vollständige Payload {email, pv} — für Endpunkte, die gegen user.pwdAt prüfen.
export function verifyPayload(req) {
  if (!SECRET) return null;
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return null;
  try { const d = jwt.verify(t, SECRET); return { email: d.email, pv: d.pv || 0 }; } catch { return null; }
}
// Konstanter Dummy-Hash: bcrypt.compare gegen diesen, wenn kein User existiert,
// damit die Antwortzeit nicht verrät, ob die E-Mail registriert ist (Timing-Leak).
export const DUMMY_HASH = "$2b$10$C6UzMDM.H6dfI/f/IKcEeO3f3fV3zJ0m1kO8xq9m3nQ4p5r6s7t8u";

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

export const norm = (e) => String(e || "").trim().toLowerCase();
export const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
// Vertrauenswürdige Client-IP: Vercels x-real-ip wird vom Edge-Proxy gesetzt und
// ist NICHT client-fälschbar. Der linke x-forwarded-for-Wert dagegen ist spoofbar
// (Rate-Limit-Bypass). Fallback aufs RECHTE XFF-Ende (letzter Hop = vertrauenswürdig),
// dann linkes Ende (nur lokale Dev-Umgebung ohne Proxy).
export const clientIp = (req) => {
  const real = (req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(s => s.trim()).filter(Boolean);
  return xff[xff.length - 1] || xff[0] || "unknown";
};
// E-Mail für Logs maskieren (nur erster Buchstabe + Domain) — keine PII im Klartext.
export const maskEmail = (e) => { const s = String(e || ""); const i = s.indexOf("@"); return i < 1 ? "***" : s[0] + "***" + s.slice(i); };

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
    console.log(`[mail] resend status=${r.status} to=${maskEmail(to)}`);
    return r.ok;
  } catch (e) { console.log("[mail] resend fehler:", String(e).slice(0, 120)); return false; }
}
