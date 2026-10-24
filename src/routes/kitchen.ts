import { Hono } from "hono";
import { z } from "zod";

import { optionalUser, requireAdmin, requireUser } from "../auth/access.js";
import { collections, newId, toRow } from "../db/db.js";
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
  const db = await collections();
  const today = utcDay();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [mealTotals, activeCenters, sponsorTotals, lowStock] = await Promise.all([
    db.mealLogs
      .aggregate<{ today_meals: number; today_children: number; month_meals: number }>([
        { $match: { log_date: { $gte: monthStart } } },
        {
          $group: {
            _id: null,
            today_meals: { $sum: { $cond: [{ $eq: ["$log_date", today] }, "$meals_cooked", 0] } },
            today_children: {
              $sum: { $cond: [{ $eq: ["$log_date", today] }, "$children_served", 0] },
            },
            month_meals: { $sum: "$meals_cooked" },
          },
        },
      ])
      .next(),
    db.distributionCenters.countDocuments({ active: true }),
    db.sponsorships
      .aggregate<{ amount: number; meals: number }>([
        {
          $group: {
            _id: null,
            amount: { $sum: "$amount_inr" },
            meals: { $sum: "$meals_sponsored" },
          },
        },
      ])
      .next(),
    db.kitchenInventory.countDocuments({
      $expr: { $lte: ["$current_stock", "$reorder_threshold"] },
    }),
  ]);

  const stats: KitchenStats = {
    meals_cooked_today: mealTotals?.today_meals ?? 0,
    children_served_today: mealTotals?.today_children ?? 0,
    active_kitchen_centers: activeCenters,
    meals_cooked_this_month: mealTotals?.month_meals ?? 0,
    total_sponsorships_amount: sponsorTotals?.amount ?? 0,
    total_meals_sponsored: sponsorTotals?.meals ?? 0,
    low_stock_items: lowStock,
  };
  return c.json(stats);
});

// ---------------------------------------------------------------- Inventory (read public, write admin)

kitchen.get("/inventory", async (c) => {
  const db = await collections();
  const docs = await db.kitchenInventory.find().sort({ category: 1, item_name: 1 }).toArray();
  return c.json(docs.map((doc) => toRow<KitchenInventoryItem>(doc)));
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
  const { userId, db } = await requireAdmin(c);
  await db.kitchenInventory.insertOne({
    _id: newId(),
    ...data,
    updated_at: new Date(),
    updated_by: userId,
  });
  return c.body(null, 201);
});

kitchen.patch("/inventory/:id", async (c) => {
  const data = await body(c, z.object({ current_stock: stockAmount }));
  const { userId, db } = await requireAdmin(c);
  const result = await db.kitchenInventory.updateOne(
    { _id: c.req.param("id") },
    { $set: { current_stock: data.current_stock, updated_at: new Date(), updated_by: userId } },
  );
  if (result.matchedCount === 0) throw notFound("Inventory item not found.");
  return c.body(null, 204);
});

// ---------------------------------------------------------------- Distribution centers & meal logs

kitchen.get("/distribution-centers", async (c) => {
  const db = await collections();
  const docs = await db.distributionCenters.find().sort({ name: 1 }).toArray();
  return c.json(docs.map((doc) => toRow<DistributionCenter>(doc)));
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
  const { db } = await requireAdmin(c);
  await db.distributionCenters.insertOne({
    _id: newId(),
    ...data,
    active: true,
    created_at: new Date(),
  });
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
  const { userId, db } = await requireAdmin(c);
  if (!(await db.distributionCenters.countDocuments({ _id: data.center_id }, { limit: 1 }))) {
    throw notFound("Distribution center not found.");
  }
  await db.mealLogs.insertOne({
    _id: newId(),
    ...data,
    log_date: utcDay(),
    logged_by: userId,
    created_at: new Date(),
  });
  return c.body(null, 201);
});

// ---------------------------------------------------------------- Sponsorships (sponsor's own; admins see all)

kitchen.get("/sponsorships/mine", async (c) => {
  const { userId, db } = await optionalUser(c);
  if (!userId) return c.json([] as Sponsorship[]);
  const docs = await db.sponsorships
    .find({ sponsor_id: userId })
    .sort({ created_at: -1 })
    .toArray();
  return c.json(docs.map((doc) => toRow<Sponsorship>(doc)));
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
  const { userId, db } = await requireUser(c);
  await db.sponsorships.insertOne({
    _id: newId(),
    ...data,
    sponsor_id: userId,
    created_at: new Date(),
  });
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
  const db = await collections();
  await db.contactMessages.insertOne({ _id: newId(), ...data, created_at: new Date() });
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
  const db = await collections();
  await db.volunteerSignups.insertOne({ _id: newId(), ...data, created_at: new Date() });
  return c.body(null, 201);
});
