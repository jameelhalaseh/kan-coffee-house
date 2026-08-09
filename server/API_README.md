# CashierPOS API server (Heroku)

> Not to be confused with `server/server.js` — that is the separate **local-WiFi sync**
> WebSocket server. **This** API (`server/index.js`) is the Supabase replacement: browser →
> Express (`/api/*`) → Heroku Postgres, with every request authorized server-side. No anon
> key, no RLS-as-gate.

## What ships in Phase 1
- `0001_schema.sql` — full schema (27 tables, sequences, `pgcrypto`, `app_next_invoice`,
  `app_next_ticket`, non-secret reference seeds). All Supabase-only constructs stripped.
- `server/db.js` — pg pool.
- `server/auth.js` + `routes/auth.js` — **session-token** auth (login / validate / logout /
  change-password / admin reset). Opaque 48-hex token in `app_users.session_token`, 12h TTL,
  bcrypt. **Not** JWT.
- `routes/orders.js` — per-store orders: `GET/POST /api/orders` (UNION both stores, or `?floor=`),
  `DELETE /api/orders/:id` (admin), `GET /api/invoice/next?floor=gg|dealer`.
- `server/index.js` — Express wiring (helmet, gzip, CORS, rate-limited auth), serves the
  static React build when present.

## Phase 3 route groups (added)
All session-gated unless noted; "admin" = `requireSession` + `requireAdmin`.
- **staff** — `GET /api/staff` · `POST`/`DELETE /api/staff/:id` (admin) · `POST /api/staff/:id/pin` (admin) · `POST /api/staff/verify-pin` (no auth, pre-login; bare boolean; 5-fail/15-min lockout)
- **admin-pin** — `POST /api/admin-pin` (admin) · `POST /api/admin-pin/verify` (session; bare boolean; lockout)
- **users** (admin) — `GET`/`POST /api/users` · `PUT`/`DELETE /api/users/:id` · `POST /api/users/:id/reset-password`
- **customers** — `POST` (session) · `GET` (admin, PII) — **admin-log** — `POST` (session) · `GET` (admin) — **reservations** — `GET` · `PUT`/`DELETE /api/reservations/:tableId`
- **inventory** — menu-items, inventory, recipes (per-floor composite key), materials, stock-log
- **ops** — kitchen/hooka/drinks queues, entrance-tickets, staff-free-drinks (1/day), shifts, settings, table-layout, table-orders
- **reports** — expenses, expense-types, partners, partner-draws (deletes + partner PATCH are admin; `?floor=` required on partners/draws) · `GET /api/ticket/next`

The client rewrite (Phase 4, ~93 `supabase.*` call sites) and deploy/cutover (Phase 5) remain.

## Auth contract
- `POST /api/auth/login` `{username,password}` → `{id,username,email,role,allowed_views,token}` or `401`.
- Send the token on every other call as `Authorization: Bearer <token>` (the middleware also
  accepts a legacy `p_token` body/query param to ease testing).
- Data routes require any valid session; `DELETE /api/orders/:id` requires `role:'admin'`.
- Error bodies preserve the original codes: `session` (401), `not_admin` (403), `invalid` (401),
  `wrong_old` / `too_short` / `bad_code` / `no_admin` / `no_email` / `no_user` (400).

## Run locally
```bash
npm install
cp .env.example .env            # set DATABASE_URL (local Postgres), SESSION_TTL_HOURS, etc.
npm run migrate                 # apply server/migrations/*.sql
ADMIN_USERNAME=owner ADMIN_PASSWORD='strong-pass' npm run seed:admin
npm run server                  # API on :3001  (health: GET /healthz)
```

## Deploy to Heroku (owner runs — Claude has no Heroku/DB/browser access)
```bash
heroku create cashierpos-api
heroku addons:create heroku-postgresql:essential-0 -a cashierpos-api   # sets DATABASE_URL
heroku config:set -a cashierpos-api NODE_ENV=production SESSION_TTL_HOURS=12
git push heroku heroku-setup:main
heroku run -a cashierpos-api npm run migrate
heroku run -a cashierpos-api "ADMIN_USERNAME=owner ADMIN_PASSWORD='strong-pass' npm run seed:admin"
```
`heroku-postbuild` builds the React app; the dyno serves it + the API on one origin
(`web: node server/index.js`).

## Smoke test (login + one order) — the Phase 1 acceptance test
```bash
BASE=https://cashierpos-api.herokuapp.com   # or http://localhost:3001

# 1. login → capture token
TOKEN=$(curl -s $BASE/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"strong-pass"}' | python -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# 2. next invoice number for a store (bare JSON number) — floor is REQUIRED
INV=$(curl -s "$BASE/api/invoice/next?floor=gg" -H "Authorization: Bearer $TOKEN"); echo "gg invoice=$INV"

# 3. save one order to that store (floor selects orders_gg / orders_dealer)
curl -s $BASE/api/orders -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"id\":\"test-1\",\"table_id\":1,\"items\":[{\"n\":\"Tea\",\"q\":2}],\"sub\":4,\"tax\":0,\"svc\":0,\"total\":4,\"pay\":\"Cash\",\"status\":\"done\",\"date\":\"2026-06-17\",\"time\":\"12:00\",\"invoice_no\":$INV,\"floor\":\"gg\"}"

# 4. list orders (should include test-1)
curl -s "$BASE/api/orders?limit=10" -H "Authorization: Bearer $TOKEN"

# 5. authz proof — no token → 401, non-admin delete → 403
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/orders                       # 401
curl -s -X DELETE $BASE/api/orders/test-1 -H "Authorization: Bearer $TOKEN"      # 200 if owner is admin; 403 for a non-admin token
```

## Caveats carried over from the original (do not silently change)
- **Per-store invoice numbering.** GG and Dealer keep orders in separate tables (`orders_gg` /
  `orders_dealer`); each numbers from 1 independently via `app_next_invoice(floor)` (gap-reusing,
  per-store advisory lock). A partial `UNIQUE(invoice_no)` per table enforces no duplicate within a
  store: if two terminals on the same store race for a number, the second save returns
  `409 invoice_taken` (fetch a new number and retry) rather than silently duplicating a tax
  invoice. Cross-store collisions are impossible (separate tables). Gap-reuse on delete is retained
  (Article-5 trade-off, `INVOICE_REUSE.sql`).
- The browser client now talks to **`/api/*`** (Phase 4 done): `src/api.js` replaced `src/db.js`,
  auth uses a Bearer session token, and orders/invoice calls pass `floor`. The client needs only
  `REACT_APP_API_URL` (empty = same origin) — **no Supabase keys**. Deploy serves the rewritten
  client + API on one origin; you can now test end-to-end in the browser, not just via curl.
- Run a `pg_dump --schema-only` of the live Supabase DB and diff it against `0001_schema.sql`
  to catch any dashboard-only drift before cutover.
- **Migrating live order data:** route each existing Supabase `orders` row into `orders_gg` /
  `orders_dealer` by its `floor` (`gg`→orders_gg, `dealer`→orders_dealer). A legacy row with a NULL
  floor must be assigned a store first (the floor↔table mapping lives in the client `TL` constant,
  not the DB), or it won't migrate.
