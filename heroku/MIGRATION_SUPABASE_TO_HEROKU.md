# Migration Runbook: Supabase → Heroku + Postgres + Own API

> ⚠️ **SUPERSEDED PLANNING DOC — read `server/API_README.md` for the as-built deploy guide.**
> The system was built differently from this initial plan in three ways: (1) auth is a
> **server-side session-token** model, **not JWT** — ignore every `JWT_SECRET` instruction below;
> (2) there is **no `0002_seed.sql`** — schema is `0001_schema.sql` applied via `npm run migrate`,
> and data migration is a manual one-time import; (3) orders are **per-store** (`orders_gg` /
> `orders_dealer`). Cutover model: serve the API + build from one Heroku dyno (same origin).

**Audience:** a Claude Code session executing this migration end-to-end.
**Owner-in-the-loop:** the user runs anything that touches Heroku, the live DB, or a browser
(Claude has no access to those). Claude writes code, the user runs/tests, Claude fixes from reports.

---

## 0. Read first — why this migration

Today the app is a static React (CRA) frontend talking **directly** to Supabase via `supabase-js`.
Every `supabase.from(...)` / `supabase.rpc(...)` is an HTTPS call to Supabase's hosted REST layer
(PostgREST + GoTrue auth), authenticated by the **anon key that ships in the public JS bundle**.
Security therefore depends entirely on Row Level Security being configured correctly per table.

Heroku Postgres is **bare Postgres** — no REST layer, no anon key, no RLS-as-API-gate. So the move
is not "repoint the DB". It requires inserting **our own API server** between browser and database:

```
React build ──fetch('/api/...', Bearer <token>)──► Express API ──pg──► Heroku Postgres
```

This is also the security fix: the anon key disappears, DB credentials live only in server env, and
every endpoint authorizes the session token server-side before touching a table. The whole
`allow_all` / RLS-misconfig risk class is gone.

**Do not run this under launch pressure.** Build on a branch, test against a DB copy in parallel to
the live Supabase app, cut over only when green.

---

## 1. Ground truth to gather before coding

Claude: run these to build an exact inventory (do not assume from this doc).

```bash
# Every distinct table the client touches + count
grep -oE "\.from\(['\"][a-z_]+['\"]\)" src/App.jsx | sort | uniq -c | sort -rn

# Every RPC name the client calls
grep -oE "\.rpc\(['\"][a-z_]+['\"]" src/App.jsx | sort -u

# All auth/helper wrappers (top of App.jsx + db.js)
grep -nE "supabase\.(from|rpc|auth)|createClient" src/App.jsx src/db.js
```

Also collect from the repo's SQL files the authoritative schema + the existing RPC bodies (they are
the spec for server logic): `supabase-schema.sql`, `AUTH_SETUP.sql`, `SECURITY_HARDENING.sql`,
`sql/security/*.sql`, `sql/REPORTS.sql` (if porting reports), and `INVOICE_SEQUENCE.sql`.

Produce a checklist file `docs/_migration_inventory.md` with: table list, RPC list, call-site count
per table. This is the definition of done — every item must be replaced.

---

## 2. Schema migration (user runs against DBs)

1. **Dump schema from current Supabase project** (user, Supabase → Database → connection string):
   ```bash
   pg_dump --schema-only --no-owner --no-privileges "$SUPABASE_DB_URL" > server/migrations/0001_schema.sql
   pg_dump --data-only --no-owner --table=menu_items --table=staff --table=app_settings \
     "$SUPABASE_DB_URL" > server/migrations/0002_seed.sql   # seed/config rows only, NOT sales data
   ```
2. **Strip Supabase-only constructs** from `0001_schema.sql` (Claude edits):
   - Remove `CREATE POLICY`, `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
   - Remove `GRANT ... TO anon|authenticated` and `anon`/`authenticated` role refs.
   - Remove `auth.*` schema references; keep `create extension pgcrypto` (bcrypt is used).
   - Keep all tables, PKs, FKs, indexes, sequences (invoice sequence!).
3. User applies to Heroku Postgres after the addon exists (§6):
   ```bash
   psql "$DATABASE_URL" -f server/migrations/0001_schema.sql
   psql "$DATABASE_URL" -f server/migrations/0002_seed.sql
   ```

Why strip RLS/grants: the API is the only DB client now and connects as the DB owner. Authorization
moves into Express middleware, so RLS/policies are dead weight (and a false sense of safety).

---

## 3. Server skeleton (`server/`)

Add deps: `express pg jsonwebtoken bcryptjs helmet express-rate-limit zod cors compression`.

```
server/
  index.js            # app wiring, static serve, error handler
  db.js               # pg Pool from DATABASE_URL
  auth.js             # login, token issue/verify middleware, role guards
  validate.js         # zod helper -> 400 on bad input
  routes/
    auth.js orders.js tableOrders.js reservations.js staff.js shifts.js
    menu.js inventory.js recipes.js materials.js queues.js tickets.js
    customers.js adminLog.js settings.js invoice.js reports.js   # reports optional
  migrations/0001_schema.sql 0002_seed.sql
Procfile              # web: node server/index.js
```

**`server/db.js`**
```js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
module.exports = { query: (t, p) => pool.query(t, p), pool };
```

**`server/auth.js`** — port the existing token model (App.jsx `authLogin/authValidate` + bcrypt
from `SECURITY_HARDENING.sql`). Login verifies `app_users` bcrypt, issues a JWT
(`jwt.sign({ id, role, allowed_views }, JWT_SECRET, { expiresIn: '12h' })`). Middleware
`requireAuth` verifies the Bearer token and sets `req.user`; `requireAdmin` checks
`req.user.role === 'admin'`. Reuse `staff_passwords` bcrypt for `verify-pin`.

**`server/index.js`**
```js
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 30 }));
app.use('/api', require('./routes')); // mounts all route files
app.use(express.static(path.join(__dirname, '..', 'build')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, '..', 'build', 'index.html')));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'server' }); });
app.listen(process.env.PORT || 3001);
```

**Route pattern (every resource follows this)** — `server/routes/orders.js`:
```js
const r = require('express').Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../auth');

r.get('/', requireAuth, async (req, res) => {
  const { rows } = await db.query(
    'select * from orders order by created_at desc limit $1', [req.query.limit || 200]);
  res.json(rows);
});
r.post('/', requireAuth, async (req, res) => {
  const o = req.body; // validate with zod
  await db.query(`insert into orders (id,table_id,items,sub,tax,svc,disc,disc_pct,disc_staff,
    total,pay,waiter,status,split_data,date,time,invoice_no,floor,buyer)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    on conflict (id) do update set table_id=excluded.table_id, items=excluded.items, /*...*/ buyer=excluded.buyer`,
    [o.id,o.table_id,JSON.stringify(o.items),o.sub,o.tax,o.svc,o.disc,o.disc_pct,o.disc_staff,
     o.total,o.pay,o.waiter,o.status,JSON.stringify(o.split_data),o.date,o.time,o.invoice_no,o.floor,o.buyer]);
  res.json({ ok: true });
});
r.delete('/:id', requireAdmin, async (req, res) => {
  await db.query('delete from orders where id=$1', [req.params.id]); res.json({ ok: true });
});
module.exports = r;
```

The existing RPC bodies in the SQL files are the exact spec — translate each `app_*` function into
the matching route (same auth check: `requireAuth` for session-level, `requireAdmin` for admin-only).
Invoice number: port `INVOICE_SEQUENCE.sql` logic into `GET /api/invoice/next` (a transaction that
reuses gaps as the current RPC does).

---

## 4. Endpoint ↔ current-call map (definition of done)

| Resource | Routes | Replaces |
|--|--|--|
| auth | POST login, GET validate, POST logout, POST change-password | `authLogin/Validate/Logout`, ChangePw |
| users | GET, POST, PATCH (admin) | UsersView RPCs |
| orders | GET, POST, DELETE(admin) | `app_list/save/delete_order` |
| table-orders | GET/PUT `/:tableId` | `from('table_orders')` |
| invoice | GET /next | `nextInvoiceRpc` |
| reservations | GET, POST, DELETE `/:tableId` | `app_*_reservation` |
| staff | GET, POST(admin), DELETE(admin), POST `/:id/pin`(admin), POST /verify-pin | `app_*_staff`, `verify_staff_pin` |
| shifts | GET, POST | `from('shifts')` |
| menu-items | GET, POST, DELETE | `from('menu_items')` |
| inventory | GET, PUT | `from('inventory')` |
| recipes | GET, POST, DELETE | `from('recipes')` |
| materials | GET, POST, DELETE | `from('materials')` |
| kitchen/hooka/drinks-queue | GET, POST, PATCH, DELETE each | the 3 queue tables |
| entrance-tickets | GET, POST | `from('entrance_tickets')` |
| staff-free-drinks | GET, POST | `staff_free_drinks` |
| customers | GET(admin), POST | `app_save/list_customers` |
| admin-log | GET(admin), POST | `app_log/list_admin_log` |
| admin-pin | POST set(admin), POST verify | `app_set/verify_admin_pin` |
| settings | GET, PUT | `from('app_settings')` |
| reports (optional) | expenses, expense-types, partners, partner-draws | `sql/REPORTS.sql` feature |

Every row must be done and smoke-tested before cutover.

---

## 5. Client rewrite (`src/`)

**`src/api.js`** (new) — replace the Supabase client:
```js
const BASE = process.env.REACT_APP_API_URL || '';
let token = null;
export const setToken = t => { token = t; };
async function req(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.status === 204 ? null : res.json();
}
export const api = {
  get: p => req('GET', p), post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b), patch: (p, b) => req('PATCH', p, b), del: p => req('DELETE', p),
};
```

**Rewrite every call site** in `App.jsx` (~59). Mechanical mapping:
- `supabase.from('orders').select(...)` → `api.get('/orders')`
- `supabase.rpc('app_save_order',{p_token,p_row})` → `api.post('/orders', row)` (token now implicit via header)
- `supabase.from('x').delete().eq('id',id)` → `api.del('/x/' + id)`
- auth helpers → `api.post('/auth/login', {...})` etc.; on login call `setToken(token)`.

Response shapes are the same JSON the RPCs returned, so the existing `.map(...)` blocks stay.
`loadData` is already gated on a session token — keep that, just swap the calls. Set the token into
`api` on login and on session restore.

Delete `src/db.js` (Supabase client) and the `_app_session`/RPC helper wrappers once nothing imports them.

---

## 6. Deploy (user runs)

```bash
heroku create cashierpos-api
heroku addons:create heroku-postgresql:mini -a cashierpos-api   # DATABASE_URL auto-set
heroku config:set -a cashierpos-api NODE_ENV=production JWT_SECRET="$(openssl rand -hex 32)" \
  REACT_APP_EMAILJS_SERVICE_ID=... REACT_APP_EMAILJS_TEMPLATE_ID=... REACT_APP_EMAILJS_PUBLIC_KEY=...
# build the React app so the dyno can serve it
npm run build
git push heroku <branch>:main
psql "$(heroku config:get DATABASE_URL -a cashierpos-api)" -f server/migrations/0001_schema.sql
psql "$(heroku config:get DATABASE_URL -a cashierpos-api)" -f server/migrations/0002_seed.sql
```

`package.json`: add `"start": "node server/index.js"` and a `"heroku-postbuild": "react-scripts build"`
so Heroku builds the frontend. `Procfile`: `web: node server/index.js`. `REACT_APP_API_URL` can be
empty (same origin) since the API serves the build.

Security headers: `helmet` adds most; confirm HSTS on. Keep `express-rate-limit` on login + sensitive
POSTs. Validate every request body with `zod` before SQL.

---

## 7. Testing (user-driven, Claude fixes)

Build on a branch, point at a **copy** of the data (apply schema + seed to the Heroku DB; optionally
load a sanitized snapshot). Run the full matrix before cutover:

1. Login (admin + non-admin), session restore on reload, logout.
2. Take order (numbered table + GG/Dealer counter) → reload → persists. Void, delete (admin only).
3. Reservation add/cancel; staff add + set PIN + clock in/out (wrong PIN rejected).
4. Menu/inventory/recipe/material CRUD; queues (kitchen/hooka/drinks) status flow.
5. Entrance tickets + free drinks; all Excel exports; reports (if ported) per store.
6. **Authz proof:** hit `/api/customers` and `/api/orders DELETE` with a non-admin token → 403.
   Hit any `/api/*` with no token → 401.
7. **No-key proof:** confirm the built bundle contains no DB URL / service key (only `REACT_APP_API_URL`).

A failing order save = check the route's column list / JSON.stringify on jsonb columns first.

---

## 8. Cutover & rollback

- Keep Supabase live until the Heroku app passes §7 fully.
- Cutover = point users at the Heroku URL (or switch DNS). Optionally migrate real sales data with a
  one-time `pg_dump --data-only` from Supabase → `psql` into Heroku during a quiet window.
- **Rollback:** Supabase project untouched and still deployed; revert the frontend to the Supabase
  build. Because cutover is a URL/DNS switch, rollback is immediate.

---

## 9. Phase order for the executing session

1. §1 inventory + §2 schema dump/strip.
2. §3 server skeleton + auth + **orders** route E2E. User deploys, tests login + 1 order.
3. Remaining routes (§4) in batches; user smoke-tests each batch.
4. §5 client rewrite (do per-resource, keep app runnable).
5. §6 deploy, §7 full test matrix, §8 cutover.

Commit per phase on a `feat/heroku-api` branch. Never touch `main`'s Supabase build until cutover.

---

## 10. Cost & ops note

Heroku dyno (Basic ~$7/mo) + Postgres (Mini/Basic ~$5–9/mo) ≈ **$12–16/mo**. Cheaper than Supabase
Pro ($25), but you now own: DB backups (`heroku pg:backups:schedule`), patching, monitoring, uptime.
Set up automated backups day one — it's a money system.
```
