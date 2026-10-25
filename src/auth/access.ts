// Authorization for API routes. Every route must call one of these before touching data that
// isn't public.
import type { Context } from "hono";

import { getDb } from "../db/db.js";
import { HttpError } from "../lib/http.js";
import { getSessionUserId, requireSessionUserId } from "./session.js";

export async function isAdmin(userId: string) {
  const sql = await getDb();
  const rows = await sql`SELECT 1 FROM admins WHERE id = ${userId} LIMIT 1`;
  return rows.length > 0;
}

export async function requireUser(c: Context) {
  const userId = requireSessionUserId(c);
  const sql = await getDb();
  return { userId, sql };
}

export async function requireAdmin(c: Context) {
  const { userId, sql } = await requireUser(c);
  if (!(await isAdmin(userId))) throw new HttpError(403, "Not authorized");
  return { userId, sql };
}

export async function optionalUser(c: Context) {
  const userId = getSessionUserId(c);
  const sql = await getDb();
  return { userId, sql };
}
