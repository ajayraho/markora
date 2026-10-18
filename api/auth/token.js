// POST /api/auth/token → short-lived Google access token, refreshed from the session cookie
import { clientCreds, readSession, clearSession, googleToken, send } from "../_session.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST only" });
  const s = readSession(req);
  if (!s?.rt) return send(res, 401, { error: "signed_out" });
  try {
    const { id, secret } = clientCreds();
    const t = await googleToken({ refresh_token: s.rt, client_id: id, client_secret: secret, grant_type: "refresh_token" });
    if (t.json.error === "invalid_grant") return send(res, 401, { error: "signed_out" }, { "Set-Cookie": clearSession() });
    if (!t.ok) return send(res, 502, { error: t.json.error || "google_error" });
    send(res, 200, { access_token: t.json.access_token, expires_in: t.json.expires_in, email: s.email });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}
