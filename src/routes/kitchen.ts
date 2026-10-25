import { Hono } from "hono";
import { z } from "zod";

import { optionalUser, requireAdmin, requireUser } from "../auth/access.js";
import { getDb } from "../db/db.js";
import type { DistributionCenter, KitchenInventoryItem, Sponsorship } from "../db/types.js";
import { body, notFound } from "../lib/http.js";
import { INVENTORY_CATEGORIES } from "../lib/kitchen.js";

export type KitchenStats = {
  meals_cooked_today: number;
  children_served_today: number;
  active_kitchen_centers: number;
  meals_cooked_this_month: number;
  total_sponsorships_amount: number;
  total_meals_sponsored: number;
  low_stock_items: number;
};

/** YYYY-MM-DD for today in UTC — meal logs are bucketed by UTC calendar day. */
function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export const kitchen = new Hono();

// GET /api/kitchen/stats → live community kitchen totals — public, non-PII headline numbers.
kitchen.get("/kitchen/stats", async (c) => {
  const sql = await getDb();
  const today = utcDay();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [stats] = (await sql`
    WITH meals AS (
      SELECT coalesce(sum(meals_cooked) FILTER (WHERE log_date = ${today}::date), 0) AS today_meals,
             coalesce(sum(children_served) FILTER (WHERE log_date = ${today}::date), 0) AS today_children,
             coalesce(sum(meals_cooked), 0) AS month_meals
      FROM meal_logs WHERE log_date >= ${monthStart}::date
    ), sponsors AS (
      SELECT coalesce(sum(amount_inr), 0) AS amount, coalesce(sum(meals_sponsored), 0) AS meals
      FROM sponsorships
    )
    SELECT meals.today_meals::int AS meals_cooked_today,
           meals.today_children::int AS children_served_today,
           (SELECT count(*) FROM distribution_centers WHERE active)::int AS active_kitchen_centers,
           meals.month_meals::int AS meals_cooked_this_month,
           sponsors.amount::float8 AS total_sponsorships_amount,
           sponsors.meals::int AS total_meals_sponsored,
           (SELECT count(*) FROM kitchen_inventory
            WHERE current_stock <= reorder_threshold)::int AS low_stock_items
    FROM meals, sponsors
  `) as KitchenStats[];
  return c.json(stats);
});

// ---------------------------------------------------------------- Inventory (read public, write admin)

kitchen.get("/inventory", async (c) => {
  const sql = await getDb();
  const rows = await sql`SELECT * FROM kitchen_inventory ORDER BY category, item_name`;
  return c.json(rows as KitchenInventoryItem[]);
});

const stockAmount = z.number().finite().min(0);

kitchen.post("/inventory", async (c) => {
  const data = await body(
    c,
    z.object({
      category: z.enum(INVENTORY_CATEGORIES),
      item_name: z.string().trim().min(1).max(120),
      unit: z.string().trim().min(1).max(20),
      current_stock: stockAmount,
      reorder_threshold: stockAmount,
    }),
  );
  const { userId, sql } = await requireAdmin(c);
  await sql`
    INSERT INTO kitchen_inventory (category, item_name, unit, current_stock, reorder_threshold,
                                   updated_by)
    VALUES (${data.category}, ${data.item_name}, ${data.unit}, ${data.current_stock},
            ${data.reorder_threshold}, ${userId})
  `;
  return c.body(null, 201);
});

kitchen.patch("/inventory/:id", async (c) => {
  const data = await body(c, z.object({ current_stock: stockAmount }));
  const { userId, sql } = await requireAdmin(c);
  const updated = await sql`
    UPDATE kitchen_inventory
    SET current_stock = ${data.current_stock}, updated_at = now(), updated_by = ${userId}
    WHERE id = ${c.req.param("id")}
    RETURNING id
  `;
  if (updated.length === 0) throw notFound("Inventory item not found.");
  return c.body(null, 204);
});

// ---------------------------------------------------------------- Distribution centers & meal logs

kitchen.get("/distribution-centers", async (c) => {
  const sql = await getDb();
  const rows = await sql`SELECT * FROM distribution_centers ORDER BY name`;
  return c.json(rows as DistributionCenter[]);
});

kitchen.post("/distribution-centers", async (c) => {
  const data = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      center_type: z.string().trim().min(1).max(100),
      address: z.string().trim().max(300).nullable(),
      latitude: z.number().min(-90).max(90).nullable(),
      longitude: z.number().min(-180).max(180).nullable(),
      daily_meal_target: z.number().int().min(0),
    }),
  );
  const { sql } = await requireAdmin(c);
  await sql`
    INSERT INTO distribution_centers (name, center_type, address, latitude, longitude,
                                      daily_meal_target)
    VALUES (${data.name}, ${data.center_type}, ${data.address}, ${data.latitude},
            ${data.longitude}, ${data.daily_meal_target})
  `;
  return c.body(null, 201);
});

kitchen.post("/meal-logs", async (c) => {
  const data = await body(
    c,
    z.object({
      center_id: z.string().min(1),
      meals_cooked: z.number().int().min(0),
      children_served: z.number().int().min(0),
    }),
  );
  const { userId, sql } = await requireAdmin(c);
  const inserted = await sql`
    INSERT INTO meal_logs (center_id, log_date, meals_cooked, children_served, logged_by)
    SELECT id, ${utcDay()}::date, ${data.meals_cooked}, ${data.children_served}, ${userId}
    FROM distribution_centers WHERE id = ${data.center_id}
    RETURNING id
  `;
  if (inserted.length === 0) throw notFound("Distribution center not found.");
  return c.body(null, 201);
});

// ---------------------------------------------------------------- Sponsorships (sponsor's own; admins see all)

kitchen.get("/sponsorships/mine", async (c) => {
  const { userId, sql } = await optionalUser(c);
  if (!userId) return c.json([] as Sponsorship[]);
  const rows = await sql`
    SELECT * FROM sponsorships WHERE sponsor_id = ${userId} ORDER BY created_at DESC
  `;
  return c.json(rows as Sponsorship[]);
});

/** Records a pledge (no payment processing) against the signed-in sponsor's account. */
kitchen.post("/sponsorships", async (c) => {
  const data = await body(
    c,
    z.object({
      sponsor_name: z.string().trim().min(1).max(200),
      sponsor_email: z.string().trim().max(200).nullable(),
      amount_inr: z.number().finite().positive(),
      meals_sponsored: z.number().int().positive(),
      message: z.string().trim().max(1000).nullable(),
    }),
  );
  const { userId, sql } = await requireUser(c);
  await sql`
    INSERT INTO sponsorships (sponsor_id, sponsor_name, sponsor_email, amount_inr,
                              meals_sponsored, message)
    VALUES (${userId}, ${data.sponsor_name}, ${data.sponsor_email}, ${data.amount_inr},
            ${data.meals_sponsored}, ${data.message})
  `;
  return c.body(null, 201);
});

// ---------------------------------------------------------------- Contact & volunteer forms (open to visitors)

kitchen.post("/contact-messages", async (c) => {
  const data = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      email: z.string().trim().email().max(200),
      message: z.string().trim().min(1).max(5000),
    }),
  );
  const sql = await getDb();
  await sql`
    INSERT INTO contact_messages (name, email, message)
    VALUES (${data.name}, ${data.email}, ${data.message})
  `;
  return c.body(null, 201);
});

kitchen.post("/volunteer-signups", async (c) => {
  const data = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      email: z.string().trim().email().max(200),
      phone: z.string().trim().max(40).nullable(),
      location_label: z.string().trim().max(200).nullable(),
      message: z.string().trim().max(5000).nullable(),
    }),
  );
  const sql = await getDb();
  await sql`
    INSERT INTO volunteer_signups (name, email, phone, location_label, message)
    VALUES (${data.name}, ${data.email}, ${data.phone}, ${data.location_label}, ${data.message})
  `;
  return c.body(null, 201);
});
