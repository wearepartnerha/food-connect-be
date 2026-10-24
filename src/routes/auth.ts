import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import { authorizationUrl, exchangeCode, newOAuthState, upsertProfile } from "../auth/google.js";
import { OAUTH_STATE_COOKIE, seal, sessionToken, unseal } from "../auth/session.js";
import { frontendUrl } from "../lib/config.js";

export const auth = new Hono();

const OAUTH_STATE_MAX_AGE_SECONDS = 600;

// GET /api/auth/google?role=… — starts Google sign-in. The CSRF `state` (plus the role picked
// on the sign-in page) rides in a short-lived signed cookie and is checked on the callback.
auth.get("/google", (c) => {
  const role = c.req.query("role");
  const state = newOAuthState();
  setCookie(
    c,
    OAUTH_STATE_COOKIE,
    seal({ state, role: role?.slice(0, 40) ?? null }, OAUTH_STATE_MAX_AGE_SECONDS),
    {
      path: "/api/auth",
      httpOnly: true,
      sameSite: "Lax",
      secure: new URL(c.req.url).protocol === "https:",
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    },
  );
  return c.redirect(authorizationUrl(c.req.raw, state), 302);
});

// GET /api/auth/callback/google — Google redirects here after the user consents. Register this
// exact URL as an "Authorized redirect URI" on the OAuth client in Google Cloud Console.
//
// On success the browser is sent back to the frontend with the session token in the URL
// fragment (fragments never reach any server or access log); the frontend stores it and sends
// it as `Authorization: Bearer <token>`.
auth.get("/callback/google", async (c) => {
  const fail = (reason: string) => {
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/api/auth" });
    return c.redirect(`${frontendUrl()}/auth?error=${encodeURIComponent(reason)}`, 302);
  };

  const saved = unseal<{ state?: string; role?: string | null }>(getCookie(c, OAUTH_STATE_COOKIE));
  const code = c.req.query("code");

  if (c.req.query("error")) return fail("Google sign-in was cancelled.");
  if (!saved?.state || saved.state !== c.req.query("state") || !code) {
    return fail("Sign-in expired or was tampered with. Please try again.");
  }

  try {
    const identity = await exchangeCode(c.req.raw, code);
    const userId = await upsertProfile(identity, saved.role ?? null);
    deleteCookie(c, OAUTH_STATE_COOKIE, { path: "/api/auth" });
    return c.redirect(`${frontendUrl()}/#token=${encodeURIComponent(sessionToken(userId))}`, 302);
  } catch (error) {
    console.error(error);
    return fail("Could not complete Google sign-in. Please try again.");
  }
});

// POST /api/auth/signout — sessions are stateless tokens, so signing out is the client
// discarding its token. Kept as an endpoint so clients have one place to call.
auth.post("/signout", (c) => c.body(null, 204));
