// Signed session tokens. The payload is readable base64url JSON; the HMAC-SHA256 suffix (keyed
// by SESSION_SECRET) is what stops a client from forging or editing it.
//
// The frontend is deployed on a different origin, so sessions travel as a bearer token in the
// Authorization header rather than a cookie (third-party cookies are blocked by most browsers).
// Only the short-lived OAuth `state` uses a cookie, and only on this API's own origin.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";

import { HttpError } from "../lib/http.js";

export const OAUTH_STATE_COOKIE = "fwc_oauth";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function secret() {
  const value = process.env["SESSION_SECRET"];
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET must be set to a random string of at least 32 characters.");
  }
  return value;
}

function sign(value: string) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

/** Serializes and signs a payload that expires `maxAgeSeconds` from now. */
export function seal(payload: Record<string, unknown>, maxAgeSeconds: number) {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + maxAgeSeconds * 1000 }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Verifies the signature and expiry; returns null for anything tampered, malformed, or stale. */
export function unseal<T extends Record<string, unknown>>(token: string | undefined): T | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = Buffer.from(sign(body));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & {
      exp?: number;
    };
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionToken(userId: string) {
  return seal({ uid: userId }, SESSION_MAX_AGE_SECONDS);
}

/** The signed-in user's id from `Authorization: Bearer <token>`, or null. */
export function getSessionUserId(c: Context): string | null {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  const payload = unseal<{ uid?: unknown }>(token);
  return typeof payload?.uid === "string" ? payload.uid : null;
}

export function requireSessionUserId(c: Context): string {
  const userId = getSessionUserId(c);
  if (!userId) throw new HttpError(401, "Unauthorized: please sign in.");
  return userId;
}
