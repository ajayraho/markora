// POST /api/auth/logout → revoke Google access and forget the session cookie
import { readSession, clearSession, send } from "../_session.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const s = readSession(req);
  if (s?.rt) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.rt)}`, { method: "POST" }).catch(() => {});
  send(res, 200, { ok: true }, { "Set-Cookie": clearSession() });
}
