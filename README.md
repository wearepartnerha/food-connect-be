# food-connect-be

REST API for **Food Connect**: MongoDB data, Google sign-in, and every read/write the frontend
makes. Built with [Hono](https://hono.dev) on Node.js 22+.

The frontend lives in a separate repository and talks to this service only over HTTP.

## Run locally

```sh
cp .env.example .env   # fill in MONGODB_URI, GOOGLE_*, SESSION_SECRET, ADMIN_EMAILS
npm install
npm run dev            # http://localhost:4000, restarts on change
```

Production:

```sh
npm run build
npm start              # serves dist/index.js on $PORT
```

In Google Cloud Console, add `<API_URL>/api/auth/callback/google` (e.g.
`http://localhost:4000/api/auth/callback/google`) as an Authorized redirect URI.

## Environment

| Variable                                   | Purpose                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `PORT`                                     | Port to listen on (default `4000`).                                                            |
| `API_URL`                                  | Public URL of this API; builds the OAuth redirect URI. Set it behind a proxy.                  |
| `FRONTEND_URL`                             | Comma-separated frontend origins allowed by CORS. The first is where users land after sign-in. |
| `MONGODB_URI`, `MONGODB_DB`                | MongoDB connection string and database name.                                                   |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client ("Web application").                                                       |
| `SESSION_SECRET`                           | 32+ random characters; signs session tokens.                                                   |
| `ADMIN_EMAILS`                             | Comma-separated Google emails granted admin on sign-in.                                        |

## Authentication

1. The frontend sends the browser to `GET /api/auth/google?role=<role>`.
2. After Google consent, `/api/auth/callback/google` redirects to
   `<FRONTEND_URL>/#token=<session token>` (or `<FRONTEND_URL>/auth?error=<message>`).
3. The frontend stores the token and sends `Authorization: Bearer <token>` on every request.
   Tokens are signed (HMAC-SHA256) and expire after 30 days. Signing out means the client drops its token.

## API

All bodies are JSON. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.
**Auth:** — public; **user** — needs a session token; **admin** — needs an admin's token.
"Optional" routes return an empty result (`null` / `[]`) when signed out.

| Method & path                               | Auth     | Body / query                                                                                 | Response                                   |
| ------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `GET /api/auth/google`                      | —        | `?role=`                                                                                     | 302 to Google                              |
| `GET /api/auth/callback/google`             | —        | (from Google)                                                                                | 302 to frontend                            |
| `POST /api/auth/signout`                    | —        |                                                                                              | 204                                        |
| `GET /api/account`                          | optional |                                                                                              | `{ user, profile, isAdmin }` or `null`     |
| `PATCH /api/account/profile`                | user     | any of `full_name, role, organization, phone, email, location_label, latitude, longitude`    | 204                                        |
| `GET /api/notifications`                    | optional |                                                                                              | `NotificationRow[]`                        |
| `POST /api/notifications/read`              | user     |                                                                                              | 204                                        |
| `GET /api/registration`                     | optional |                                                                                              | `NgoRegistration` or `null`                |
| `PUT /api/registration`                     | user     | `organization_name, registration_80g, contact_person, contact_phone, contact_email, pincode` | 204                                        |
| `GET /api/kitchen/stats`                    | —        |                                                                                              | `KitchenStats`                             |
| `GET /api/inventory`                        | —        |                                                                                              | `KitchenInventoryItem[]`                   |
| `POST /api/inventory`                       | admin    | `category, item_name, unit, current_stock, reorder_threshold`                                | 201                                        |
| `PATCH /api/inventory/:id`                  | admin    | `current_stock`                                                                              | 204                                        |
| `GET /api/distribution-centers`             | —        |                                                                                              | `DistributionCenter[]`                     |
| `POST /api/distribution-centers`            | admin    | `name, center_type, address, latitude, longitude, daily_meal_target`                         | 201                                        |
| `POST /api/meal-logs`                       | admin    | `center_id, meals_cooked, children_served`                                                   | 201                                        |
| `GET /api/sponsorships/mine`                | optional |                                                                                              | `Sponsorship[]`                            |
| `POST /api/sponsorships`                    | user     | `sponsor_name, sponsor_email, amount_inr, meals_sponsored, message`                          | 201                                        |
| `POST /api/contact-messages`                | —        | `name, email, message`                                                                       | 201                                        |
| `POST /api/volunteer-signups`               | —        | `name, email, phone, location_label, message`                                                | 201                                        |
| `GET /api/geocode`                          | —        | `?query=&country=`                                                                           | `{ label, latitude, longitude }` or `null` |
| `GET /api/admin/dashboard`                  | admin    |                                                                                              | `AdminDashboard`                           |
| `POST /api/admin/registrations/:id/approve` | admin    |                                                                                              | 204                                        |
| `GET /health`                               | —        |                                                                                              | `{ status: "ok" }`                         |

Row types are in [`src/db/types.ts`](src/db/types.ts).

## Layout

```
src/
  index.ts          Node server entry
  app.ts            Hono app: CORS, routes, error handling
  auth/             session tokens, Google OAuth, access checks
  db/               MongoDB connection, indexes, row types
  routes/           account, admin, kitchen, geocode, auth endpoints
  lib/              config, HTTP helpers, shared constants
```
