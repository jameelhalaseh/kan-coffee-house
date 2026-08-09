# Liquor Store POS — local demo

A per-client clone of the Dukkan retail POS: single store, barcode scan-to-cart, 16% VAT,
Arabic⇄English, dark-amber UI. Runs entirely on your machine against a Docker Postgres.

## Run it

```bash
cd "C:\Users\basel\liqure store"
npm install                 # once
npm run db:up               # Postgres 16 in Docker on localhost:5433
npm run demo:setup          # migrate + admin + staff + catalogue + 14 days of sales
npm run build               # production React bundle
npm run server              # http://localhost:3001
```

Open <http://localhost:3001>.

For frontend hot-reload during development, run `npm run server` in one terminal and
`npm start` (CRA dev server, port 3000) in another — CRA proxies nothing, so set
`REACT_APP_API_URL=http://localhost:3001` in `.env` first.

## Demo logins

| User      | Password      | Role  | Sees                                                  |
|-----------|---------------|-------|-------------------------------------------------------|
| `owner`   | `liquor1234`  | admin | everything, including the AI assistant                |
| `manager` | `manager1234` | user  | sales, inventory, receive, history, reports, settings |
| `cashier` | `cashier1234` | user  | sales, history only — reports/timeclock return 403    |

Demo credentials only. They live in `.env` (gitignored) and were applied by `seed:admin` /
`seed:users`. Change them before showing this to anyone outside the room.

## Barcode scanning

A USB scanner is a keyboard wedge: it types the digits fast and presses Enter. The Sales
screen listens for that burst globally — no need to focus the search box.

1. Known barcode → line added to the cart, one short high beep.
2. Unknown barcode → two low buzzes + the quick-add product modal, prefilled with the code.

No scanner? Type the barcode into the search field and press Enter — identical path.
Codes to try:

| Barcode         | Product                           | Price   |
|-----------------|-----------------------------------|---------|
| `5000267023656` | Johnnie Walker Black Label 750ml  | 38.00   |
| `5452000032102` | Absolut Vodka 700ml               | 22.00   |
| `8712000030001` | Heineken 330ml can                | 1.60    |
| `3049614088001` | Moët & Chandon Impérial 750ml     | 72.00   |
| `5281000010012` | Arak Touma 750ml                  | 23.00   |
| `9999999999999` | (nothing — triggers quick-add)    | —       |

## Loading a real catalogue (CSV import)

The demo catalogue is seeded SQL, but a client can load their own without touching the
repo. Inventory → **⬆ Import CSV** (admin only — the import rewrites prices across the
whole catalogue, so it is gated exactly like every other pricing path).

Columns: `barcode, name, price, cost, stock, cat, unit, active`. Only `name` is required,
and common spreadsheet header spellings are accepted (`SKU`, `Product Name`, `Qty`,
`Department`…). The modal has a **Download template** link.

The file is parsed and checked in the browser first, so bad rows are listed with their
line numbers before anything is written; the valid rows can still be imported. Rows whose
barcode already exists either update that product or reject the whole file, your choice.
The import runs as ONE transaction — a failure part-way through leaves the catalogue
untouched — and every product created or repriced gets a `stock_log` row naming the admin
who did it.

## What's seeded

- **57 products** across Whiskey, Vodka, Gin, Rum, Tequila, Brandy, Arak, Liqueur, Wine,
  Beer, Champagne, Mixers, Accessories. Several are deliberately below the low-stock
  threshold (Belvedere, Jameson, Veuve Clicquot…) so alerts and AI insights have signal.
- **4 suppliers** for the Receive flow.
- **~135 sales over 14 days** (Thu/Fri busier) so History, Reports and the Z-report look real.

Reseed anytime: `npm run seed:products`, `npm run seed:sales` (idempotent),
`DEMO_DAYS=30 npm run seed:sales` for a longer window.
Wipe sales but keep catalogue + users: `CONFIRM_WIPE=YES npm run reset:data`.
Nuke everything: `npm run db:reset` then `npm run demo:setup`.

## Verified working

Checked end-to-end against the local database:

- login + Bearer session for all three users
- barcode lookup (`/api/products/barcode/:code`) and full catalogue load
- checkout: order written to `orders_main`, stock deducted, `stock_log` rows appended —
  all in one transaction; invoice numbering (`app_next_invoice`) hands out 1, 2, 3…
- 16% VAT applied on the receipt totals
- receive stock: batch recorded against a supplier, product stock increased
- reports: summary, top products, low stock
- time clock in/out
- permissions: `cashier` gets 403 on `/api/timeclock`, `/api/ai/insights`,
  `/api/reports/*` and `/api/products/import`; no token → 401
- AI assistant insights (deterministic path — chat needs `NVIDIA_API_KEY`)
- `CI=true npm run build` compiles clean
- CSV import: upsert on barcode, per-row validation, all-or-nothing rollback, audit rows

## Tests

```bash
npm test              # frontend (jsdom): pure helpers + CSV parsing — 46 tests
npm run test:server   # API against Postgres: 333 tests, needs `npm run db:up`
npm run test:all      # both
npm run test:server:coverage
```

`test:server` creates and migrates its own throwaway database (`liquorpos_test`) on every
run, so it never touches the demo data. Point `TEST_DATABASE_URL` elsewhere for CI.

Server coverage is 80% of statements (89% across the route modules). The gaps are
`email.js` (EmailJS forgot-password) and the `migrate`/`reset-data` CLI scripts.

## Config

Everything client-specific is in **`src/client.config.js`** (store name, currency, 16% VAT,
seller identity for the receipt header, `LQ` invoice prefix, language, nav views) plus
**`server/floors.js`** (`FLOORS = ['main']` → the `orders_main` table). Those two must
agree. Nothing else is per-client — do not edit `App.jsx` to change branding.

The design system lives in `src/theme.js` and is shared across every client build. Only
`C.accent` should ever change per client.

## Optional bits

- **AI chat** — set `NVIDIA_API_KEY` in `.env` (free tier at build.nvidia.com) and restart.
  Insights/alerts work without it.
- **Thermal printing** — ESC/POS over Web Serial (`src/lib/thermalPrinter.js`), Chrome/Edge
  only, plus cash-drawer kick. Paperless checkout works with no printer.
- **Forgot password** — needs the four `EMAILJS_*` server vars; without them that endpoint
  returns 503 and normal login is unaffected.

## Deploy

See `DEPLOY_HEROKU.md`.
