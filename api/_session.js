// Shared helpers for the auth functions. Files starting with "_" are not deployed as routes.
// Nothing here stores user data: the Google refresh token lives only in an encrypted,
// httpOnly cookie on the user's own device.
import crypto from "node:crypto";

export const SCOPES = "openid email https://www.googleapis.com/auth/drive.file";
const COOKIE = "mk_session";
const STATE = "mk_state";
const PATH = "/api/auth";
const YEAR = 60 * 60 * 24 * 365;

function key() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET env var missing or shorter than 32 chars");
  return crypto.createHash("sha256").update(s).digest();
}

export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64url");
}

export function unseal(str) {
  try {
    const buf = Buffer.from(str, "base64url");
    const d = crypto.createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch { return null; }
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=${PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const sessionCookie = (session) => cookie(COOKIE, seal(session), YEAR);
export const clearSession = () => cookie(COOKIE, "", 0);
export const stateCookie = (v) => cookie(STATE, v, 600);
export const clearState = () => cookie(STATE, "", 0);
export const readSession = (req) => { const c = cookies(req)[COOKIE]; return c ? unseal(c) : null; };
export const readState = (req) => cookies(req)[STATE];

export function origin(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || (host?.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
export const redirectUri = (req) => `${origin(req)}/api/auth/callback`;

export function clientCreds() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars missing");
  return { id, secret };
}

export async function googleToken(params) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries({ "Cache-Control": "no-store", ...headers })) res.setHeader(k, v);
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
