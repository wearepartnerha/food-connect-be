import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { frontendOrigins } from "./lib/config.js";
import { HttpError } from "./lib/http.js";
import { account } from "./routes/account.js";
import { admin } from "./routes/admin.js";
import { auth } from "./routes/auth.js";
import { geocode } from "./routes/geocode.js";
import { kitchen } from "./routes/kitchen.js";

export const app = new Hono();

app.use(logger());

// Auth is a bearer token, not a cookie, so cross-origin requests carry no ambient credentials
// and need no CSRF token — CORS only decides which frontends may read responses.
app.use(
  "/api/*",
  cors({
    origin: (origin) => (frontendOrigins().includes(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 600,
  }),
);

app.get("/", (c) => c.json({ name: "food-connect-be", status: "ok" }));
app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", auth);
app.route("/api", account);
app.route("/api", kitchen);
app.route("/api/admin", admin);
app.route("/api/geocode", geocode);

app.notFound((c) => c.json({ error: "Not found." }, 404));

// Every error response is `{ "error": "<message>" }`. Only HttpError messages are shown to the
// client; anything else is logged and reported as a generic 500.
app.onError((error, c) => {
  if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
  console.error(error);
  return c.json({ error: "Something went wrong. Please try again." }, 500);
});
