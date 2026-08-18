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
git clone https://github.com/jameelhalaseh/kan-coffee-house.git
cd kan-coffee-house
npm install                 # once
npm run db:up               # Postgres 16 in Docker on localhost:5435
npm run setup               # migrations + Kan's 44-drink menu + all 50 pictures
npm run build               # production React bundle
npm run server              # http://localhost:3003
```

Open <http://localhost:3003>.

`npm run setup` is four steps: the app migrations, the reporting migrations, the catalogue, and
then the pictures. All four are idempotent, so re-running it on an existing database is safe.

**The artwork is in the repo now**, so a clean clone gets it without a copy of anyone's
database. `server/seed-images/` holds 44 product PNGs named by SKU (`KC-HC-02.png`) plus 6
category PNGs and a `categories.json` mapping their slugs back to the real names — 512x512 with
transparency, ~15MB. `npm run seed:images` loads them into the `product_images` /
`category_images` tables on its own if you only want to refresh the pictures.

Named by SKU rather than by row id on purpose: `product_images.product_id` is a serial that
depends on insert order, so `12.png` would attach the cappuccino's picture to whatever landed on
row 12 in someone else's database. SKUs come from `server/seed-products.sql` and are identical
everywhere, so the filename is the join key. A file whose SKU is not in the catalogue is
reported rather than silently skipped.

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

## Product pictures

Each product can carry its own cut-out image, shown on its sales tile beside the name.

**Where:** Inventory → tap a product → **Product picture**. Admin only, and only for a product
that already exists (a quick-add from the till has no id yet to attach an image to). The
picture saves on its own button, separately from the form, because it is a separate request.

**What to supply:** any image with a **transparent background**. It is normalised
automatically to a 512×512 transparent PNG — trimmed to the subject, scaled and centred — so
a phone photo, a 64px icon and a 4000px render all end up the same size on the shelf. You
never pick a size or a format.

⚠ **The browser cannot remove a background.** If the image still has one, the upload warns you
and the tile will show a rectangular block on its gradient. Generate cut-outs in the first
place: with OpenAI that means `gpt-image-1` with `background: "transparent"` — DALL·E 3 cannot
produce alpha at all — or run any background remover before uploading.

**Where the bytes live:** the `product_images` table (migration 0012), not a column on
`products` and not the filesystem. A bytea column on `products` would drag ~150KB per row into
the catalogue fetch every till makes at login; the filesystem is ephemeral on Heroku, so
uploads would vanish on restart and the shop would find out weeks later. Images are served
individually with a year-long `immutable` cache and an ETag, so each is fetched once per
session. Deleting a product deletes its picture with it.

Categories work the same way and are separate — Settings → Categories, stored in
`category_images` (migration 0009). A product with no picture falls back to its category's
artwork, then to the coloured letter badge.

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

The pictures come from `public/demo-art/` — 44 products and 6 categories at 192px, exported
from the database — because the artwork itself lives in Postgres and the demo has no server.
(The full-resolution set is committed separately under `server/seed-images/`, for the real till.)
`demoApi` answers the manifest calls from that folder, so `productArt.js` and `categoryArt.js`
need no demo awareness.

**Financials is hidden in the demo build** (`FALLBACK_VIEWS` in `src/client.config.js`).
`demoApi` implements the one-segment report endpoints but not the store-scoped ones that screen
calls, so all six of its tabs answered "Failed to load the report" — six red errors in the
build a client is shown. It is hidden rather than stubbed because the demo carries no sales at
all, so a complete implementation would still show six blank ledgers.

## Config

Everything client-specific is environment, read at boot by `server/clientConfig.js` and served
to the browser as `GET /client-config.js` → `window.__CLIENT__`. See `.env`.

The literals in `src/client.config.js` are only the **fallback** for when no server answers
(the Pages demo, the jsdom tests). They hold Kan's identity, and `DEFAULT_VIEWS` there is
load-bearing: it omits `assistant` so the AI button the owner switched off cannot reappear in
the demo build, and `FALLBACK_VIEWS` drops `storereports` in the demo build only.

`reporting/` keeps its OWN migrations and its own ledger, applied by `npm run migrate:reporting`
— `npm run setup` now runs both sets. Skipping it leaves the server booting perfectly while
every Financials tab fails, so `server/index.js` warns at boot when the reporting schema is
absent and names the command that fixes it.

`server/floors.js` (`FLOORS = ['main']` → the `orders_main` table) must agree with
`src/client.config.js`'s store key. The design system lives in `src/theme.js` and is shared
across every client build — do not fork it per shop.

## Outstanding

See `CLIENT_INTAKE.md` for the agreed spec and the full blocker list. The two that stop Kan
going live: **no registered tax number** (so no real receipts) and **no JoFotara credentials**.

## Deploy

`DEPLOY_HEROKU.md` or `DEPLOY_VPS.md`. Note the thermal printer needs a secure context, so a
real host must be HTTPS — `localhost` counts as secure, which is why printing works locally.
