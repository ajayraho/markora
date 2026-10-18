// GET /api/auth/login → redirect to Google's consent screen
import crypto from "node:crypto";
import { SCOPES, clientCreds, redirectUri, stateCookie, send } from "../_session.js";

export default function handler(req, res) {
  try {
    const { id } = clientCreds();
    const state = crypto.randomBytes(16).toString("base64url");
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri(req),
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",      // ask for a refresh token…
      prompt: "consent",           // …every time, so we always receive one
      include_granted_scopes: "true",
      state,
    });
    send(res, 302, undefined, { Location: url.toString(), "Set-Cookie": stateCookie(state) });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}
