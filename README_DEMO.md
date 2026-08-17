# Kan Coffee House POS — running it locally

A counter-service cafe till, forked from the Dukkan/Liquor retail POS: single store, 16% VAT
(tax-inclusive prices), Arabic⇄English, dark-amber UI. **No barcode scanner** — drinks are
rung from category chips. Runs entirely on your machine against a Docker Postgres.

## Ports on this machine

This fork deliberately avoids the template's documented ports, because several of these shops
run side by side here. Changing them back will collide.

| | Kan | Why not the default |
|---|---|---|
| App | **3003** | 3001 is WeRespond-UI, 3002 is the liquor-store fork |
| Postgres | **5435** | 5432 is a host Postgres, 5433 is `clinicos-db`, 5434 is the liquor fork |
| CRA dev server | **3004** | 3000 is in use |

## Run it

```bash
cd "C:\Users\user\OneDrive - RM Network\Dev\7uloultech\kan-coffee-house"
npm install                 # once
npm run db:up               # Postgres 16 in Docker on localhost:5435
npm run setup               # migrate + seed Kan's 44-drink menu
npm run build               # production React bundle
npm run server              # http://localhost:3003
```

Open <http://localhost:3003>.

`npm run setup` does **not** create logins — passwords are never written to a file. Seed them
by passing them on the command line (see the bottom of `.env`), then log in as `owner`.

For frontend hot reload, run `npm run server` in one terminal and `npm start` in another with
`PORT=3004`. `src/setupProxy.js` forwards `/client-config.js`, `/api`, `/healthz` and `/brand`
to the API, so no `REACT_APP_API_URL` and no CORS entry are needed — and do **not** replace it
with a `"proxy"` field in package.json; that loses to CRA's historyApiFallback for
`/client-config.js` and the app silently reverts to compiled defaults.

## What's seeded

**44 products** from Kan's published drinks menu, in six categories matching the printed menu
order: Hot Coffee (13) · Cold Coffee (8) · Tea & Herbs (7) · Hot Kan (3) · Cold Kan (6) ·
Special (7). Prices are tax-inclusive JOD.

Three things about the catalogue are deliberate and documented in `server/seed-products.sql`:

- **`barcode` holds synthetic internal SKUs** (`KC-HC-01`…). Kan has no scanner, but `barcode`
  is the UNIQUE column the seed upserts on, and Postgres NULL never conflicts with NULL — so
  empty barcodes would insert 44 fresh rows on every run.
- **Made-to-order drinks carry `stock = 9999`, `low_at = 0`.** Checkout deducts stock per line
  and there is no non-stock-item flag; seeding 0 would paint a permanent red "Out" pill on
  every tile. The count drifts down as drinks sell and needs an occasional reset in Inventory.
  `Cold Brew Bottle` is the one genuinely stocked line (`stock 24`, `low_at 6`).
- **`cost = 0` everywhere**, because Kan supplied no costs. Financials/P&L therefore reads
  100% margin — an honest gap, not a figure. Load costs before showing the owner that tab.

**No suppliers and no demo sales are seeded.** Inventing vendor records or fabricated revenue
for a real client corrupts every report the owner looks at. Receive is unusable until Kan adds
a real supplier. (`seed:demo-sales-DESTRUCTIVE` exists but is deliberately out of `setup`.)

Reseed prices any time with `npm run seed:products` — it is idempotent and deliberately does
**not** reset `stock`, so a real count is never silently overwritten.

## Tests

```bash
npx react-scripts test --watchAll=false   # frontend (jsdom): 142 tests
npm run test:server                      # API against Postgres: 459 tests, needs `npm run db:up`
npm run test:all                         # both
```

There is no `npm test` script — the template's docs claimed one, but it was never defined.

`test:server` creates and migrates its own throwaway database (`kanpos_test`) on every run, so
it never touches the shop's data. Its default now points at **5435**; the inherited default was
5433, which on this machine is another project's Postgres and failed with a misleading
"password authentication failed for user pos".

## The public demo (GitHub Pages)

`.github/workflows/pages.yml` publishes a **mock** build — `REACT_APP_DEMO=1` swaps the real
API for `src/demoApi.js`, an in-browser stand-in backed by localStorage.

⚠ **It is not a till.** No server, no database. **Any password logs in** (`owner`, `manager`,
`barista1`). Nothing persists past the visitor's own browser. Never point a demo build at a
real API. Receipts it prints are cosmetic — the real shop still has no registered tax number.

The demo catalogue in `demoApi.js` must stay Kan's menu. It previously seeded groceries
(Laban, Pita Bread, Dish Soap) inherited from the Dukkan ancestor, which under Kan's name
reads as the wrong shop's till.

## Config

Everything client-specific is environment, read at boot by `server/clientConfig.js` and served
to the browser as `GET /client-config.js` → `window.__CLIENT__`. See `.env`.

The literals in `src/client.config.js` are only the **fallback** for when no server answers
(the Pages demo, the jsdom tests). They hold Kan's identity, and `DEFAULT_VIEWS` there is
load-bearing: it omits `assistant` so the AI button the owner switched off cannot reappear in
the demo build.

`server/floors.js` (`FLOORS = ['main']` → the `orders_main` table) must agree with
`src/client.config.js`'s store key. The design system lives in `src/theme.js` and is shared
across every client build — do not fork it per shop.

## Outstanding

See `CLIENT_INTAKE.md` for the agreed spec and the full blocker list. The two that stop Kan
going live: **no registered tax number** (so no real receipts) and **no JoFotara credentials**.

## Deploy

`DEPLOY_HEROKU.md` or `DEPLOY_VPS.md`. Note the thermal printer needs a secure context, so a
real host must be HTTPS — `localhost` counts as secure, which is why printing works locally.
