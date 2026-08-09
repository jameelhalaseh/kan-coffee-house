# Backend API migration scope (v2) — Heroku + Postgres

> ⚠️ **SUPERSEDED PLANNING DOC — see `server/API_README.md` for the as-built API.** Deviations from
> this scope: auth is a **session-token** model (no `JWT_SECRET`); orders are split per store
> (`orders_gg` / `orders_dealer`); served from one Heroku dyno (same origin, no separate static host).

Goal: replace the Supabase REST/anon-key model with **own API server + Heroku Postgres**.
Browser → API (session token) → Postgres. No public key, no RLS, every endpoint gated server-side.

> This is a v2 rewrite, NOT a launch-week change. Launch on Supabase with the existing
> `sql/security/` lockdown first.

## Architecture

```
React build (static)  ──fetch('/api/...', Bearer token)──►  API server (Node/Express)  ──pg──►  Heroku Postgres
```

- API holds `DATABASE_URL` + a JWT/secret in Heroku config vars. Nothing secret in the bundle.
- Auth: port the existing token + bcrypt logic server-side. Issue token on login, validate per request via middleware.
- Authz: middleware checks role / `allowed_views` per route. Admin-only routes flagged.
- One Heroku dyno runs the API and serves the static React build (or split: API dyno + static host).

## Endpoint list (mirrors current tables + RPCs)

Auth & session
- `POST /api/auth/login` ← `authLogin`
- `GET  /api/auth/validate` ← `authValidate`
- `POST /api/auth/logout` ← `authLogout`
- `POST /api/auth/change-password`
- `POST /api/users` / `GET /api/users` / `PATCH /api/users/:id` (admin) ← UsersView

Orders & checkout
- `GET  /api/orders?limit=200` ← `app_list_orders`
- `POST /api/orders` (create/update) ← `app_save_order`
- `DELETE /api/orders/:id` (admin) ← `app_delete_order`
- `GET/PUT /api/table-orders/:tableId` ← `table_orders` cart state
- `GET  /api/invoice/next` ← `nextInvoiceRpc`

Floor / reservations
- `GET/POST /api/reservations` + `DELETE /api/reservations/:tableId` ← `app_*_reservation`

Staff & shifts
- `GET  /api/staff` / `POST /api/staff` (admin) / `DELETE /api/staff/:id` (admin) ← `app_*_staff`
- `POST /api/staff/:id/pin` (admin) + `POST /api/staff/verify-pin` ← bcrypt `verify_staff_pin`
- `GET/POST /api/shifts` (clock in/out)

Menu / inventory
- `GET/POST/DELETE /api/menu-items`
- `GET/PUT /api/inventory`
- `GET/POST/DELETE /api/recipes`
- `GET/POST/DELETE /api/materials`

Queues
- `GET/POST/PATCH/DELETE /api/kitchen-queue`
- `GET/POST/PATCH/DELETE /api/hooka-queue`
- `GET/POST/PATCH/DELETE /api/drinks-queue`

Tickets / misc
- `GET/POST /api/entrance-tickets`
- `POST /api/staff-free-drinks` + `GET` (report)
- `GET/PUT /api/settings` ← `app_settings`
- `POST /api/stock-log`

PII / audit (admin-gated)
- `GET/POST /api/customers` ← `app_save_customer` / `app_list_customers`
- `GET/POST /api/admin-log` ← `app_log_action` / `app_list_admin_log`
- `GET/POST /api/admin-pin` ← `app_set/verify_admin_pin`

Reports (per-store) — if porting the feature/per-store-reports work
- `GET/POST/DELETE /api/expenses` (floor-scoped, delete=admin)
- `GET/POST /api/expense-types`
- `GET/PATCH /api/partners`
- `GET/POST/DELETE /api/partner-draws`

~40 routes, ~12 resource groups.

## Client changes (`src/App.jsx` + `src/db.js`)

- Replace `src/db.js` Supabase client with a tiny `api.js` fetch wrapper:
  `api.get(path)`, `api.post(path, body)` — attaches `Authorization: Bearer <token>`, base URL from env.
- Rewrite ~59 `supabase.from(...)` / `supabase.rpc(...)` call sites → `api.*`. Response shapes already
  JSON; map the same fields.
- Drop the `_app_session` / RPC helpers; auth helpers call `/api/auth/*`.
- `loadData` already gated on token — keep, just swap calls.

## Server (new `server/`)

- `server/index.js` — Express app, static serve of `build/`.
- `server/db.js` — `pg` Pool from `DATABASE_URL`.
- `server/auth.js` — login, token issue/validate middleware, bcrypt (port `hashPin`→bcrypt).
- `server/routes/*.js` — one file per resource group.
- `server/migrations/` — schema from a Supabase `pg_dump --schema-only` (tables/indexes; drop RLS/policies/grants — not needed, API enforces).
- `Procfile` — `web: node server/index.js`.

## Schema migration

1. `pg_dump --schema-only` from current Supabase project.
2. Strip Supabase-specific: RLS, policies, `anon`/`authenticated` grants, `auth` schema refs.
3. Keep tables, PKs, indexes, sequences, `pgcrypto` (bcrypt).
4. Apply to Heroku Postgres. `--data-only` for menu/staff seed if needed.

## Deploy

- Heroku app + Heroku Postgres addon.
- Config vars: `DATABASE_URL` (auto), `JWT_SECRET`, EmailJS keys, `NODE_ENV=production`.
- `npm run build` (React) → `build/`; API serves it.
- TLS via Heroku. Add HSTS + security headers (helmet).

## Effort (rough)

| Phase | Work | Est |
|--|--|--|
| 1 | Server skeleton + auth + DB pool + 1 resource (orders) E2E | 2-3 d |
| 2 | Remaining resource routes | 4-6 d |
| 3 | Client data-layer rewrite (~59 calls) | 3-4 d |
| 4 | Schema migrate + deploy + smoke test | 1-2 d |
| 5 | Harden: helmet, rate-limit, input validation (zod), logging | 1-2 d |

~2-3 weeks one dev. Money system → test hard before cutover.

## Security wins vs current

- No anon key in bundle → the entire `allow_all` class of risk gone.
- Every table gated by server authz, not RLS config you can forget.
- DB creds server-side only; customer-data privacy enforced by the server boundary.
- Add real rate-limiting + input validation at the API edge.

## Cost

- Heroku dyno (Basic ~$7/mo) + Heroku Postgres (Mini/Basic ~$5-9/mo) ≈ **$12-16/mo**.
- vs Supabase Pro $25/mo. Cheaper, but you own ops (patching, backups config, monitoring).
