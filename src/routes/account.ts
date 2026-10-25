import { Hono } from "hono";
import { z } from "zod";

import { isAdmin, optionalUser, requireUser } from "../auth/access.js";
import type { AuthUser, NgoRegistration, NotificationRow, Profile } from "../db/types.js";
import { body } from "../lib/http.js";
import { lookupLocation } from "./geocode.js";

export type Account = { user: AuthUser; profile: Profile; isAdmin: boolean };

export const account = new Hono();

// GET /api/account → the signed-in account, or null when signed out (or the session's profile
// no longer exists).
account.get("/account", async (c) => {
  const { userId, sql } = await optionalUser(c);
  if (!userId) return c.json(null);
  const [profile] = (await sql`
    SELECT id, full_name, role, organization, phone, email, location_label, latitude, longitude,
           created_at, updated_at
    FROM profiles WHERE id = ${userId}
  `) as Profile[];
  if (!profile) return c.json(null);
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
  const { userId, sql } = await requireUser(c);
  // Only fields the caller actually sent — absent keys must not overwrite stored values. Column
  // names come from the schema above (zod drops unknown keys), so they're safe to splice into the statement.
  const changes = Object.entries(data).filter(([, value]) => value !== undefined);
  const assignments = changes.map(([column], index) => `${column} = $${index + 2}`);
  await sql.query(
    `UPDATE profiles SET ${[...assignments, "updated_at = now()"].join(", ")} WHERE id = $1`,
    [userId, ...changes.map(([, value]) => value)],
  );
  return c.body(null, 204);
});

// GET /api/notifications → the caller's 30 newest notifications ([] when signed out).
account.get("/notifications", async (c) => {
  const { userId, sql } = await optionalUser(c);
  if (!userId) return c.json([] as NotificationRow[]);
  const rows = (await sql`
    SELECT * FROM notifications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 30
  `) as NotificationRow[];
  return c.json(rows);
});

// POST /api/notifications/read — marks all of the caller's notifications read.
account.post("/notifications/read", async (c) => {
  const { userId, sql } = await requireUser(c);
  await sql`UPDATE notifications SET read = true WHERE user_id = ${userId} AND NOT read`;
  return c.body(null, 204);
});

// GET /api/registration → the caller's distribution-partner registration, or null.
account.get("/registration", async (c) => {
  const { userId, sql } = await optionalUser(c);
  if (!userId) return c.json(null);
  const [registration] = (await sql`
    SELECT * FROM ngo_registrations WHERE user_id = ${userId}
  `) as NgoRegistration[];
  return c.json(registration ?? null);
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
  const { userId, sql } = await requireUser(c);

  let place: { label: string; latitude: number; longitude: number } | null = null;
  try {
    place = await lookupLocation({ query: data.pincode });
  } catch (lookupError) {
    console.error(lookupError);
  }

  const status = place ? "Verified" : "Pending";
  // distribution_center_id and created_at are only set on insert.
  await sql`
    INSERT INTO ngo_registrations (
      user_id, organization_name, registration_80g, contact_person, contact_phone,
      contact_email, pincode, area_label, latitude, longitude, status, verified_at
    ) VALUES (
      ${userId}, ${data.organization_name}, ${data.registration_80g}, ${data.contact_person},
      ${data.contact_phone}, ${data.contact_email || null}, ${data.pincode},
      ${place?.label ?? null}, ${place?.latitude ?? null}, ${place?.longitude ?? null},
      ${status}, ${place ? new Date() : null}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      organization_name = EXCLUDED.organization_name,
      registration_80g = EXCLUDED.registration_80g,
      contact_person = EXCLUDED.contact_person,
      contact_phone = EXCLUDED.contact_phone,
      contact_email = EXCLUDED.contact_email,
      pincode = EXCLUDED.pincode,
      area_label = EXCLUDED.area_label,
      latitude = EXCLUDED.latitude,
      longitude = EXCLUDED.longitude,
      status = EXCLUDED.status,
      verified_at = EXCLUDED.verified_at,
      updated_at = now()
  `;
  return c.body(null, 204);
});
