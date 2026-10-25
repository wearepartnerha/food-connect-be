import { Hono } from "hono";

import { requireAdmin } from "../auth/access.js";
import type {
  ContactMessage,
  NgoRegistration,
  Profile,
  Sponsorship,
  VolunteerSignup,
} from "../db/types.js";
import { HttpError, notFound } from "../lib/http.js";

export type AdminDashboard = {
  stats: {
    total_users: number;
    pending_contact_messages: number;
    pending_volunteer_signups: number;
  };
  profiles: Profile[];
  sponsorships: Sponsorship[];
  messages: ContactMessage[];
  signups: VolunteerSignup[];
  registrations: NgoRegistration[];
};

const LIST_LIMIT = 500;

export const admin = new Hono();

// GET /api/admin/dashboard → AdminDashboard
admin.get("/dashboard", async (c) => {
  const { sql } = await requireAdmin(c);

  const [[stats], profiles, sponsorships, messages, signups, registrations] = await Promise.all([
    sql`
      SELECT (SELECT count(*) FROM profiles)::int AS total_users,
             (SELECT count(*) FROM contact_messages)::int AS pending_contact_messages,
             (SELECT count(*) FROM volunteer_signups)::int AS pending_volunteer_signups
    `,
    sql`
      SELECT id, full_name, role, organization, phone, email, location_label, latitude,
             longitude, created_at, updated_at
      FROM profiles ORDER BY created_at DESC LIMIT ${LIST_LIMIT}
    `,
    sql`SELECT * FROM sponsorships ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
    sql`SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
    sql`SELECT * FROM volunteer_signups ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
    sql`SELECT * FROM ngo_registrations ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`,
  ]);

  const result: AdminDashboard = {
    stats: stats as AdminDashboard["stats"],
    profiles: profiles as Profile[],
    sponsorships: sponsorships as Sponsorship[],
    messages: messages as ContactMessage[],
    signups: signups as VolunteerSignup[],
    registrations: registrations as NgoRegistration[],
  };
  return c.json(result);
});

// POST /api/admin/registrations/:id/approve — approves a partner registration by creating its
// distribution center and linking the two.
admin.post("/registrations/:id/approve", async (c) => {
  const { sql } = await requireAdmin(c);
  const id = c.req.param("id");

  const [registration] = (await sql`
    SELECT * FROM ngo_registrations WHERE id = ${id}
  `) as NgoRegistration[];
  if (!registration) throw notFound("Registration not found.");
  if (registration.distribution_center_id)
    throw new HttpError(409, "This registration is already approved.");
  if (registration.latitude == null || registration.longitude == null) {
    throw new HttpError(409, "This registration has no verified location yet.");
  }

  // One statement, so the center is only created if the registration is still unapproved.
  const approved = await sql`
    WITH center AS (
      INSERT INTO distribution_centers (name, center_type, address, latitude, longitude)
      SELECT organization_name, 'Partner organization', area_label, latitude, longitude
      FROM ngo_registrations
      WHERE id = ${id} AND distribution_center_id IS NULL
      RETURNING id
    )
    UPDATE ngo_registrations
    SET distribution_center_id = (SELECT id FROM center), updated_at = now()
    WHERE id = ${id} AND EXISTS (SELECT 1 FROM center)
    RETURNING id
  `;
  if (approved.length === 0) throw new HttpError(409, "This registration is already approved.");
  return c.body(null, 204);
});
