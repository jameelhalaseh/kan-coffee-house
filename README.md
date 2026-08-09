# CashierPOS

Restaurant Point of Sale system for a two-store venue (**GG Amman**, 16% tax — and **The Dealer Cafe**, 8% tax). React PWA front-end served by an Express API on Heroku, backed by Heroku Postgres. Arabic/English UI, Article-5 Jordanian tax receipts, USB/LAN thermal-printer + cash-drawer support.

## Architecture

The app is a single Heroku dyno that serves both the static React build **and** the `/api/*` JSON API. The browser never touches the database directly — every request is authorized server-side with a Bearer token. (The old Supabase/anon-key + GitHub Pages model has been fully replaced.)

```
Browser PWA ──Bearer token──> Express API (Heroku) ──pg──> Heroku Postgres
     │
     └─ thermal printer + cash drawer:
          GG     → Web Serial (USB, Epson TM virtual COM)
          Dealer → local print bridge (PowerShell → Windows print queue, LAN/USB)
```

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18 (Create React App), single-file `src/App.jsx` |
| Backend | Express 4 + `pg` (Heroku Postgres) — one dyno serves API + static build |
| Auth | Opaque random Bearer tokens (stored in `app_users`, single active session, TTL'd), bcrypt password hashes, per-user view permissions, PIN gates |
| Hosting | Heroku (`web: node server/index.js`, `release: node server/migrate.js`) |
| Migrations | `server/migrate.js` runs automatically on each release |
| Printing | ESC/POS raster via Web Serial (GG) or local print bridge (Dealer) |
| Error tracking | Sentry (`@sentry/react`), no-op without DSN |
| Excel export | SheetJS (`xlsx`), lazy-loaded |
| Config | `src/client.config.js` — single source of truth for stores/floors/tax/features |

## Repository Layout

| Path | Description |
|------|-------------|
| `src/App.jsx` | Main application (all views + logic) |
| `src/client.config.js` | Client config: stores, floors, tax rates, sellers, feature flags |
| `src/lib/thermalPrinter.js` | ESC/POS printing + drawer kick (Web Serial / bridge, floor-aware) |
| `src/api.js` | REST client (Bearer auth) for the Express API |
| `server/index.js` | Express app: CSP/CORS, static build host, mounts `/api` |
| `server/routes/` | API route groups (auth, orders, staff, accounts, inventory, ops, reports) |
| `server/auth.js` | Session/token + `requireSession` middleware |
| `server/migrate.js`, `server/migrations/` | Schema migrations (run on release) |
| `bridge/print-bridge.ps1` | Dealer local print bridge (Windows, RAW print to queue) |
| `mobile/` | Mobile PWA + Capacitor shell |
| `sql/` | Data/migration helper SQL scripts |

## Stores & Floors

Defined in `src/client.config.js`. Each floor is a rolling counter session with its own tax rate and legal receipt identity:

| Floor | Key | Tax | Seller (Article-5) |
|-------|-----|-----|--------------------|
| GG | `gg` | 16% | GG Amman — Dabouq — taxNo 178069167 |
| Dealer | `dealer` | 8% | The Dealer Cafe — Dabouq — taxNo 178112143 |

Prices are tax-inclusive; net + tax are backed out at checkout per floor. GG's entrance free-drink is fixed to **Mojito** (instant redeem); Dealer lets staff pick any drink.

## Views / Modules

Access per view is gated by each user's `allowed_views` (admin sees all).

| View | Key | Purpose |
|------|-----|---------|
| GG | `tables` | GG counter order session |
| Dealer | `dealer` | Dealer counter order session |
| Order | — | Build order, custom off-menu items, split bill, checkout, multi-payment |
| Hooka | `hooka` | Hooka/shisha queue + reusable-head reservation (sell reserves, return releases) |
| Kitchen (KDS) | `kitchen` | Kitchen display with prep timers + overdue alerts |
| Drinks | `drinks` | Drinks queue + staff free-drink recording |
| Entrance | `entrance` | Sell/redeem entrance tickets granting a free drink |
| Inventory | `inventory` | Per-floor stock, menu items, recipes, materials |
| Staff | `staff` | Staff records, shift clock in/out |
| Dashboard | `dashboard` | Revenue, profit, avg order, top items, waiter/hourly/7-day trends, floor + date filters |
| History | `history` | Past orders, reprint receipts, void, floor filter |
| Admin Log | `adminlog` | Audited admin actions, date-range filter |
| Reports | `reports` | Exports hub + receipts-by-date browsing + admin receipt delete |
| Users | — | Admin user management (create/edit/delete/reset, assign views) |

## Receipts

- Sequential invoice numbers (server-assigned via Postgres sequence)
- Arabic RTL layout compliant with Article 5 of Jordan's نظام تنظيم شؤون الفوترة
- Per-floor seller identity (name / address / tax number), itemized lines
- Subtotal, floor sales tax (16% GG / 8% Dealer), grand total in Western numerals (د.أ)
- Discount line records the authorizing staff; buyer name on deferred/multi-payment sales
- Custom off-menu line items (name/price/qty) print on the receipt

## Printing & Cash Drawer

Receipts are **rasterized** from the on-screen DOM (Arabic fidelity) to an 80mm ESC/POS bitmap, then printed with a drawer-kick. Transport is per-floor:

- **GG** — Web Serial to the Epson TM USB printer (virtual COM via Epson TM Virtual Port Driver). One-time Connect grants browser access.
- **Dealer** — `bridge/print-bridge.ps1`: a localhost-only PowerShell HTTP listener (`:9110`) that RAW-prints base64 ESC/POS to the Windows print queue (LAN/USB printers with no COM port). Auto-starts at logon via Task Scheduler. See `bridge/README.md`.

Drawer pops automatically on order completion and on the "Go Green" drawer-only button. A main-page drawer button is admin-PIN gated.

## API

REST under `/api`, Bearer-authenticated. Route groups (`server/routes/`):

- `auth` — login, session validate, logout, password change, admin reset
- `orders` + `invoice/next` — order save/list, sequential invoice numbers
- `staff` — staff, staff PINs, admin PIN
- `accounts` — customers, admin log, reservations, users (admin)
- `inventory` — menu-items, inventory, recipes, materials, stock-log
- `ops` — queues, entrance-tickets, free-drinks, shifts, settings, table-layout/orders
- `reports` — expenses, expense-types, partners, partner-draws

## Security

- All DB access is server-side behind Bearer auth — no anon key in the bundle
- Sessions are opaque random tokens (not JWTs) stored in `app_users.session_token` with `token_exp` TTL; a new login overwrites the prior token
- bcrypt password hashes; PIN gates with brute-force lockout
- Helmet CSP (script/style/img/font/connect scoped; `localhost` allowed for the Dealer print bridge)
- CORS same-origin by default (`CORS_ORIGINS` env to allowlist)
- Rate limiting on auth endpoints; secrets via env vars (never hardcoded)

## Environment Variables

```
DATABASE_URL=...               # Heroku Postgres (set by addon)
SESSION_TTL_HOURS=12           # optional, session token lifetime (default 12)
REACT_APP_SENTRY_DSN=...       # optional, build-time
CORS_ORIGINS=...               # optional, comma-separated cross-origin allowlist
```

## Quick Start — Local

```bash
npm install
npm run migrate     # apply schema migrations
npm run seed:admin  # create initial admin user
npm run build       # production React build (served by Express)
npm run server      # start Express API + static build on :3001
# or front-end dev server with hot reload:
npm start
```

## Deploy (Heroku)

Push to `main`. Heroku runs `heroku-postbuild` (React build), then on release `node server/migrate.js`, then boots `node server/index.js`. Live: `https://cashpos-519e52621532.herokuapp.com`.

## Quick Start — Mobile PWA

See `mobile/SETUP.md`.

```bash
cd mobile
npm install
npm run build
npx cap add android && npx cap open android   # Android
npx cap add ios && npx cap open ios           # iOS
```
