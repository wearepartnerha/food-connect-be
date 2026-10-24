import { Hono } from "hono";

import { requireAdmin } from "../auth/access.js";
import { newId, toRow } from "../db/db.js";
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
  const { db } = await requireAdmin(c);
  const newestFirst = { created_at: -1 } as const;

  const [
    totalUsers,
    totalMessages,
    totalSignups,
    profiles,
    sponsorships,
    messages,
    signups,
    registrations,
  ] = await Promise.all([
    db.profiles.countDocuments(),
    db.contactMessages.countDocuments(),
    db.volunteerSignups.countDocuments(),
    db.profiles
      .find({}, { projection: { google_sub: 0 } })
      .sort(newestFirst)
      .limit(LIST_LIMIT)
      .toArray(),
    db.sponsorships.find().sort(newestFirst).limit(LIST_LIMIT).toArray(),
    db.contactMessages.find().sort(newestFirst).limit(LIST_LIMIT).toArray(),
    db.volunteerSignups.find().sort(newestFirst).limit(LIST_LIMIT).toArray(),
    db.ngoRegistrations.find().sort(newestFirst).limit(LIST_LIMIT).toArray(),
  ]);

  const result: AdminDashboard = {
    stats: {
      total_users: totalUsers,
      pending_contact_messages: totalMessages,
      pending_volunteer_signups: totalSignups,
    },
    profiles: profiles.map((doc) => toRow<Profile>(doc)),
    sponsorships: sponsorships.map((doc) => toRow<Sponsorship>(doc)),
    messages: messages.map((doc) => toRow<ContactMessage>(doc)),
    signups: signups.map((doc) => toRow<VolunteerSignup>(doc)),
    registrations: registrations.map((doc) => toRow<NgoRegistration>(doc)),
  };
  return c.json(result);
});

// POST /api/admin/registrations/:id/approve — approves a partner registration by creating its
// distribution center and linking the two.
admin.post("/registrations/:id/approve", async (c) => {
  const { db } = await requireAdmin(c);
  const id = c.req.param("id");

  const registration = await db.ngoRegistrations.findOne({ _id: id });
  if (!registration) throw notFound("Registration not found.");
  if (registration.distribution_center_id)
    throw new HttpError(409, "This registration is already approved.");
  if (registration.latitude == null || registration.longitude == null) {
    throw new HttpError(409, "This registration has no verified location yet.");
  }

  const centerId = newId();
  await db.distributionCenters.insertOne({
    _id: centerId,
    name: registration.organization_name,
    center_type: "Partner organization",
    address: registration.area_label,
    latitude: registration.latitude,
    longitude: registration.longitude,
    daily_meal_target: 0,
    active: true,
    created_at: new Date(),
  });
  await db.ngoRegistrations.updateOne(
    { _id: registration._id },
    { $set: { distribution_center_id: centerId, updated_at: new Date() } },
  );
  return c.body(null, 204);
});
