// Neon Postgres access over HTTP. `getDb()` connects lazily on first use and creates the schema
// once per process (every statement is idempotent, so restarts and multiple instances are safe).
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type Sql = NeonQueryFunction<false, false>;

// Cached on globalThis so `tsx watch` reloads reuse one client and skip re-running the schema.
const globalCache = globalThis as typeof globalThis & { __fwcDb?: Promise<Sql> };

// Ids are text UUIDs (not the uuid type) so a malformed id in a URL is simply "not found".
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS profiles (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    google_sub text NOT NULL UNIQUE,
    full_name text,
    role text,
    organization text,
    phone text,
    email text,
    location_label text,
    latitude double precision,
    longitude double precision,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS profiles_created_at_idx ON profiles (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS admins (
    id text PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    title text NOT NULL,
    body text,
    read boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS distribution_centers (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name text NOT NULL,
    center_type text NOT NULL,
    address text,
    latitude double precision,
    longitude double precision,
    daily_meal_target integer NOT NULL DEFAULT 0,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS distribution_centers_name_idx ON distribution_centers (name)`,
  `CREATE TABLE IF NOT EXISTS ngo_registrations (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    user_id text NOT NULL UNIQUE REFERENCES profiles (id) ON DELETE CASCADE,
    organization_name text NOT NULL,
    registration_80g text NOT NULL,
    contact_person text NOT NULL,
    contact_phone text NOT NULL,
    contact_email text,
    pincode text NOT NULL,
    area_label text,
    latitude double precision,
    longitude double precision,
    status text NOT NULL DEFAULT 'Pending',
    verified_at timestamptz,
    distribution_center_id text REFERENCES distribution_centers (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS ngo_registrations_created_at_idx ON ngo_registrations (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS kitchen_inventory (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    category text NOT NULL,
    item_name text NOT NULL,
    unit text NOT NULL,
    current_stock double precision NOT NULL,
    reorder_threshold double precision NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text REFERENCES profiles (id) ON DELETE SET NULL
  )`,
  `CREATE INDEX IF NOT EXISTS kitchen_inventory_order_idx ON kitchen_inventory (category, item_name)`,
  `CREATE TABLE IF NOT EXISTS meal_logs (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    center_id text NOT NULL REFERENCES distribution_centers (id) ON DELETE CASCADE,
    log_date date NOT NULL,
    meals_cooked integer NOT NULL,
    children_served integer NOT NULL,
    logged_by text REFERENCES profiles (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS meal_logs_log_date_idx ON meal_logs (log_date)`,
  `CREATE TABLE IF NOT EXISTS sponsorships (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    sponsor_id text REFERENCES profiles (id) ON DELETE SET NULL,
    sponsor_name text NOT NULL,
    sponsor_email text,
    amount_inr double precision NOT NULL,
    meals_sponsored integer NOT NULL,
    message text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS sponsorships_sponsor_idx ON sponsorships (sponsor_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS sponsorships_created_at_idx ON sponsorships (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS contact_messages (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name text NOT NULL,
    email text NOT NULL,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS contact_messages_created_at_idx ON contact_messages (created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS volunteer_signups (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name text NOT NULL,
    email text NOT NULL,
    phone text,
    location_label text,
    message text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS volunteer_signups_created_at_idx ON volunteer_signups (created_at DESC)`,
];

async function connect(): Promise<Sql> {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    const message =
      "Missing environment variable DATABASE_URL. Add your Neon connection string to .env.";
    console.error(`[Neon] ${message}`);
    throw new Error(message);
  }
  const sql = neon(url);
  // In order: tables must exist before the indexes and foreign keys that reference them.
  for (const statement of SCHEMA) await sql.query(statement);
  return sql;
}

export function getDb(): Promise<Sql> {
  if (!globalCache.__fwcDb) {
    const db = connect();
    // Don't cache a failed connection — the next request retries.
    db.catch(() => {
      if (globalCache.__fwcDb === db) delete globalCache.__fwcDb;
    });
    globalCache.__fwcDb = db;
  }
  return globalCache.__fwcDb;
}
