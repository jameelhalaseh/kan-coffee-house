# Supabase → Heroku migration — inventory (definition of done)

Branch: `heroku-setup` (off `main`, CRA / react-scripts). Auth model: **port the existing
server-side session-token** (app_users + sessions + bcrypt), NOT stateless JWT. Reports: **in scope**.

Every item below must be replaced by an API route (server) + an `api.*` call (client) before cutover.
Source of truth for server logic = the RPC bodies in the repo SQL files (see bottom).

## Client coupling (src/App.jsx on `main`)
- **93** `supabase.(from|rpc|auth)` call sites total.
- `src/db.js` = the Supabase client (`createClient`, REACT_APP_SUPABASE_URL/ANON_KEY) → DELETE at end.
- Auth/helper wrappers to re-point: `authLogin` `authValidate` `authLogout` `verifyStaffPinRpc`
  `nextInvoiceRpc` `nextTicketRpc` (`hashPin` is a legacy local hash — PINs verify via bcrypt RPC).
- Env (browser) after migration: only `REACT_APP_API_URL` (+ EmailJS keys). NO db url / anon key.

## Tables touched via `.from()` (19)
<!-- Validated against src/App.jsx: 19 distinct tables, 62 literal `.from()` sites (+1 dead dynamic).
     Per-table counts below are the doc's originals; the high-traffic ones are undercounts
     (real: inventory 6, menu_items 5, recipes 5, hooka/drinks/entrance 4 each). -->

| Table | call sites | Endpoint group |
|---|---|---|
| orders | (via rpc; see below) | orders |
| table_orders | 1 | table-orders |
| reservations | 2 | reservations | <!-- WAS MISSING: raw upsert/delete, not just app_list_reservations -->
| stock_log | 1 | stock-log | <!-- WAS MISSING: inventory audit insert -->

| menu_items | 1 | menu-items |
| inventory | 1 | inventory |
| recipes | 1 | recipes |
| materials | 1 | materials |
| kitchen_queue | 2 | kitchen-queue |
| hooka_queue | 2 | hooka-queue |
| drinks_queue | 2 | drinks-queue |
| entrance_tickets | 1 | entrance-tickets |
| staff_free_drinks | 2 | staff-free-drinks |
| shifts | 1 | shifts |
| app_settings | 2 | settings |
| table_layout | 2 | table-layout |
| expenses | 3 | reports/expenses |
| expense_types | 3 | reports/expense-types |
| partners | 3 | reports/partners |
| partner_draws | 3 | reports/partner-draws |

## RPCs called (28) → routes
Auth/session: `app_login` `app_validate` `app_logout` `app_change_password`
`app_request_admin_reset` `app_confirm_reset` → `/api/auth/*`
Admin users: `app_admin_list_users` `app_admin_create_user` `app_admin_update_user`
`app_admin_delete_user` `app_admin_reset_password` → `/api/users/*` (admin)
Orders: `app_list_orders` (x3) `app_save_order` `app_delete_order` → `/api/orders`
Staff/PIN: `app_list_staff` `app_save_staff` `app_deactivate_staff` `app_set_staff_pin`
`verify_staff_pin` → `/api/staff/*`
Reservations: `app_list_reservations` (+ save/delete elsewhere) → `/api/reservations`
Customers (admin): `app_save_customer` `app_list_customers` → `/api/customers`
Admin log (admin): `app_log_action` `app_list_admin_log` → `/api/admin-log`
Admin PIN: `app_set_admin_pin` `app_verify_admin_pin` → `/api/admin-pin`
Numbering: `app_next_invoice` `app_next_ticket` → `/api/invoice/next`, `/api/ticket/next`

## Deltas vs the heroku/ docs' endpoint map (don't forget these)
- `table_layout` (floor layout positions) — add a route group.
- Full admin **user CRUD** + **password-reset** flow (`app_request_admin_reset`/`app_confirm_reset`).
- `app_next_ticket` (entrance ticket numbering) — separate from invoice.
- Per-store **reports** routes (expenses/expense_types/partners/partner_draws), floor-scoped,
  delete=admin — confirmed in scope.

## Server-logic spec (RPC bodies live here — translate faithfully)
`supabase-schema.sql` (tables/PK/FK/indexes/sequences), `AUTH_SETUP.sql` + `SECURITY_HARDENING.sql`
(login/session/bcrypt), `sql/security/0[1-3]_*.sql` (orders/reservations/staff RPCs + lockdown),
`INVOICE_SEQUENCE.sql` + `INVOICE_REUSE.sql` (gap-reusing invoice/ticket numbering),
`sql/REPORTS.sql` + `sql/INVENTORY_PER_FLOOR.sql` (reports + per-floor inventory),
`MATERIALS_TABLE.sql`, `PIN_LOCKOUT.sql`.

## Build / deploy facts
CRA: `react-scripts build` → `build/`. Heroku: one dyno serves API + static `build/`.
Add `"start":"node server/index.js"` + `"heroku-postbuild":"react-scripts build"` + `Procfile`.
Config vars: `DATABASE_URL` (addon), `SESSION_TTL_HOURS`, `NODE_ENV=production`, EmailJS keys. (No `JWT_SECRET` — server-side session-token model, not JWT.)

## Phase status
- [x] Phase 0 — branch + this inventory
- [x] Phase 1 — `server/migrations/0001_schema.sql` (greenfield, Supabase-isms stripped, app_next_invoice kept). Owner still diffs vs a live `pg_dump --schema-only` for drift.
- [x] Phase 2 — server skeleton + auth (session model) + orders E2E (`server/index.js`, `db.js`, `auth.js`, `routes/auth.js`, `routes/orders.js`, `migrate.js`, `seed-admin.js`, `Procfile`).
- [x] Phase 3 — all remaining route groups: staff/PINs/admin-pin, users (admin), customers, admin-log, reservations, inventory (menu/inventory/recipes/materials/stock-log), ops (queues/tickets/free-drinks/shifts/settings/table-layout/table-orders), reports (expenses/types/partners/draws) + ticket/next. **Orders split per store** — `orders_gg` / `orders_dealer`, each numbered independently from 1 by `app_next_invoice(floor)`. Owner deploys + smoke-tests (`server/API_README.md`).
- [x] Phase 4 — `src/api.js` (Bearer-token fetch client) + all 93 `supabase.*` call sites rewritten to `/api/*`; `src/db.js` deleted; orders/invoice pass `floor`. CRA build compiles.
- [ ] Phase 5 — deploy config + full test matrix + cutover (Supabase kept for rollback)
