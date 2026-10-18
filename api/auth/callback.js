// GET /api/auth/callback?code&state → exchange the code, keep the refresh token in an encrypted cookie
import { clientCreds, redirectUri, readState, clearState, sessionCookie, googleToken, send } from "../_session.js";

const back = (res, q, cookies) => send(res, 302, undefined, { Location: `/?sync=${q}`, "Set-Cookie": cookies });

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") || !code) return back(res, "cancelled", [clearState()]);
  if (!state || state !== readState(req)) return back(res, "error", [clearState()]);
  try {
    const { id, secret } = clientCreds();
    const t = await googleToken({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri(req), grant_type: "authorization_code" });
    if (!t.ok || !t.json.refresh_token) return back(res, "error", [clearState()]);
    let email = null;
    try { email = JSON.parse(Buffer.from(t.json.id_token.split(".")[1], "base64url").toString()).email; } catch {}
    back(res, "connected", [clearState(), sessionCookie({ rt: t.json.refresh_token, email })]);
  } catch {
    back(res, "error", [clearState()]);
  }
}
