// Authorization for API routes. Every route must call one of these before touching data that
// isn't public.
import type { Context } from "hono";

import { collections } from "../db/db.js";
import { HttpError } from "../lib/http.js";
import { getSessionUserId, requireSessionUserId } from "./session.js";

export async function isAdmin(userId: string) {
  const { admins } = await collections();
  return (await admins.countDocuments({ _id: userId }, { limit: 1 })) > 0;
}

export async function requireUser(c: Context) {
  const userId = requireSessionUserId(c);
  const db = await collections();
  return { userId, db };
}

export async function requireAdmin(c: Context) {
  const { userId, db } = await requireUser(c);
  if (!(await isAdmin(userId))) throw new HttpError(403, "Not authorized");
  return { userId, db };
}

export async function optionalUser(c: Context) {
  const userId = getSessionUserId(c);
  const db = await collections();
  return { userId, db };
}
