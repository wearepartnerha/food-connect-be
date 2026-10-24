import { Hono } from "hono";
import { z } from "zod";

import { isAdmin, optionalUser, requireUser } from "../auth/access.js";
import { newId, toRow } from "../db/db.js";
import type { AuthUser, NgoRegistration, NotificationRow, Profile } from "../db/types.js";
import { body } from "../lib/http.js";
import { lookupLocation } from "./geocode.js";

export type Account = { user: AuthUser; profile: Profile; isAdmin: boolean };

export const account = new Hono();

// GET /api/account → the signed-in account, or null when signed out (or the session's profile
// no longer exists).
account.get("/account", async (c) => {
  const { userId, db } = await optionalUser(c);
  if (!userId) return c.json(null);
  const doc = await db.profiles.findOne({ _id: userId }, { projection: { google_sub: 0 } });
  if (!doc) return c.json(null);
  const profile = toRow<Profile>(doc);
  const result: Account = {
    user: { id: profile.id, email: profile.email },
    profile,
    isAdmin: await isAdmin(userId),
  };
  return c.json(result);
});

const nullableText = z.string().trim().max(200).nullable();

// PATCH /api/account/profile — only fields the caller sends are changed.
account.patch("/account/profile", async (c) => {
  const data = await body(
    c,
    z
      .object({
        full_name: nullableText,
        role: nullableText,
        organization: nullableText,
        phone: nullableText,
        email: nullableText,
        location_label: nullableText,
        latitude: z.number().min(-90).max(90).nullable(),
        longitude: z.number().min(-180).max(180).nullable(),
      })
      .partial(),
  );
  const { userId, db } = await requireUser(c);
  // Only fields the caller actually sent — absent keys must not overwrite stored values.
  const changes = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  ) as Partial<Omit<Profile, "id" | "created_at" | "updated_at">>;
  await db.profiles.updateOne({ _id: userId }, { $set: { ...changes, updated_at: new Date() } });
  return c.body(null, 204);
});

// GET /api/notifications → the caller's 30 newest notifications ([] when signed out).
account.get("/notifications", async (c) => {
  const { userId, db } = await optionalUser(c);
  if (!userId) return c.json([] as NotificationRow[]);
  const docs = await db.notifications
    .find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(30)
    .toArray();
  return c.json(docs.map((doc) => toRow<NotificationRow>(doc)));
});

// POST /api/notifications/read — marks all of the caller's notifications read.
account.post("/notifications/read", async (c) => {
  const { userId, db } = await requireUser(c);
  await db.notifications.updateMany({ user_id: userId, read: false }, { $set: { read: true } });
  return c.body(null, 204);
});

// GET /api/registration → the caller's distribution-partner registration, or null.
account.get("/registration", async (c) => {
  const { userId, db } = await optionalUser(c);
  if (!userId) return c.json(null);
  const doc = await db.ngoRegistrations.findOne({ user_id: userId });
  return c.json(doc ? toRow<NgoRegistration>(doc) : null);
});

/**
 * PUT /api/registration — creates or updates the caller's distribution-partner registration.
 * The PIN code is geocoded here on the server, so "Verified" status can't be claimed by the
 * client.
 */
account.put("/registration", async (c) => {
  const data = await body(
    c,
    z.object({
      organization_name: z.string().trim().min(1).max(200),
      registration_80g: z.string().trim().min(1).max(100),
      contact_person: z.string().trim().min(1).max(200),
      contact_phone: z.string().trim().min(1).max(40),
      contact_email: z.string().trim().max(200),
      pincode: z.string().trim().min(2).max(20),
    }),
  );
  const { userId, db } = await requireUser(c);

  let place: { label: string; latitude: number; longitude: number } | null = null;
  try {
    place = await lookupLocation({ query: data.pincode });
  } catch (lookupError) {
    console.error(lookupError);
  }

  const now = new Date();
  await db.ngoRegistrations.updateOne(
    { user_id: userId },
    {
      $set: {
        ...data,
        contact_email: data.contact_email || null,
        area_label: place?.label ?? null,
        latitude: place?.latitude ?? null,
        longitude: place?.longitude ?? null,
        status: place ? "Verified" : "Pending",
        verified_at: place ? now : null,
        updated_at: now,
      },
      // user_id comes from the filter on insert.
      $setOnInsert: { _id: newId(), distribution_center_id: null, created_at: now },
    },
    { upsert: true },
  );
  return c.body(null, 204);
});
