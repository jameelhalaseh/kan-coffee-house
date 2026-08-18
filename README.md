# Kan Coffee House — POS

[![CI](https://github.com/jameelhalaseh/kan-coffee-house/actions/workflows/ci.yml/badge.svg)](https://github.com/jameelhalaseh/kan-coffee-house/actions/workflows/ci.yml)

Counter-service till for a coffee house in Amman: 44 drinks across six shelves, tax-inclusive
JOD pricing, Arabic/English UI, ESC/POS receipt printing, and an owner's reporting suite.

A React PWA served by an Express API from one container, backed by Postgres. No scanner and no
table service — the cashier taps a category, taps a drink, and takes payment. Forked from the
`liquor-store-pos` template (kept as the `template` remote) and rebranded for Kan; see
[CLIENT_INTAKE.md](CLIENT_INTAKE.md) for what was agreed and why.

**Live demo:** <https://jameelhalaseh.github.io/kan-coffee-house/> — a browser-only mock with no
server. Any password logs in, nothing persists. It is for showing the shop, not for selling.

---

## Quick start

```bash
git clone https://github.com/jameelhalaseh/kan-coffee-house.git
cd kan-coffee-house
npm install
npm run db:up     # Postgres 16 in Docker, bound to 127.0.0.1:5435
npm run setup     # migrations + the 44-drink menu + all 50 pictures
npm run build
npm run server    # http://localhost:3003
```

`npm run setup` is four idempotent steps — app migrations, reporting migrations, catalogue,
artwork — so re-running it on an existing database is safe.

It deliberately creates **no logins**: a password written to a file outlives the moment it was
needed. Seed them on the command line instead:

```bash
ADMIN_USERNAME=owner ADMIN_PASSWORD='<8+ chars>' npm run seed:admin
USERS_JSON='[{"username":"barista1","password":"...","role":"user","allowed_views":["sales","history"]}]' npm run seed:users
```

For frontend hot reload, run `npm run server` in one terminal and `PORT=3004 npm start` in
another. `src/setupProxy.js` forwards `/client-config.js`, `/api` and `/healthz` to the API, so
no `REACT_APP_API_URL` and no CORS entry are needed — and do not replace it with the `"proxy"`
shorthand, which mounts too late and lets CRA's history fallback swallow `/client-config.js`.

### Ports

This machine runs several of these shops, so nothing here uses a default. Kan is **3003** (API),
**3004** (CRA dev server) and **5435** (Postgres). 5432/5433/5434 belong to other projects — a
shared port is one shop silently reading another's database.

---

## Architecture

One process serves the static React build **and** the `/api/*` JSON API. The browser never
touches the database: every request carries a Bearer token and is authorised server-side.

```
browser ──▶ Express (server/index.js) ──▶ Postgres
             ├─ /api/*            JSON API, session-authenticated
             ├─ /client-config.js this shop's identity, read from env at boot
             └─ /*                the React build
```

**A client is an environment, not a build.** `server/clientConfig.js` reads the shop's name,
currency, tax rate, invoice prefix, receipt footer and enabled views from the environment and
serves them as `window.__CLIENT__` before the bundle runs. The literals in
`src/client.config.js` are only the fallback for when no server answers — the Pages demo and
the jsdom tests.

**The money is the server's business.** `validateOrderMoney` in `server/routes/orders.js`
recomputes every bill from its lines, extracts VAT at the rate from the server's own
environment, and refuses anything that does not add up. Line prices stay the client's to set
(a price override is a real till feature); the totals do not. See [SECURITY.md](SECURITY.md).

### Layout

| Path | What lives there |
|---|---|
| `src/views/` | One file per screen: Sales, Inventory, Receive, History, Reports, Financials, Settings, Login |
| `src/components/` | Shared UI — the shelf browser, modals, toasts, receipt paper, sidebar |
| `src/theme.js` | The whole design system, both themes. Shared across every client build; never forked per shop |
| `src/lib/` | ESC/POS thermal printing over Web Serial |
| `server/routes/` | The API, one module per group; mounted by `routes/index.js` |
| `server/migrations/` | App schema, applied by `npm run migrate` with a checksummed ledger |
| `server/seed-images/` | The shop's artwork, in git — 44 products by SKU + 6 categories |
| `reporting/` | The Financials module: its own schema, its own migrations, pure report builders |
| `deploy/` | Compose files, entrypoint, and the shared-VPS platform scripts |
| `docs/` | The image prompts and the record of which source file became which drink |

`reporting/` keeping its own migration ledger is the one piece of structure worth knowing about:
`npm run setup` applies both sets, and `server/index.js` warns at boot if the reporting schema
is missing, because the API boots perfectly without it and only the Financials screen fails.

---

## The catalogue

44 products in the printed menu's own order: Hot Coffee (13) · Cold Coffee (8) · Tea & Herbs (7)
· Hot Kan (3) · Cold Kan (6) · Special (7). Prices are tax-inclusive JOD.

Three deliberate choices in `server/seed-products.sql`:

- **`barcode` holds synthetic SKUs** (`KC-HC-01`…). Kan has no scanner, but `barcode` is the
  UNIQUE column the seed upserts on, and Postgres NULL never conflicts with NULL — empty codes
  would insert 44 fresh rows on every run. The UI labels the field **SKU**.
- **Made-to-order drinks carry `stock = 9999`, `low_at = 0`.** Checkout deducts per line and
  there is no non-stock flag, so seeding 0 would paint a permanent red "Out" pill on every tile.
  `Cold Brew Bottle` is the one genuinely stocked line (24 / low at 6).
- **`cost = 0` everywhere**, because no costs were supplied. Financials therefore reads 100%
  margin — an honest gap, not a figure. Load real costs before showing the owner that tab.

No suppliers and no demo sales are seeded: inventing vendor records or fabricated revenue for a
real shop corrupts every report the owner reads. `npm run seed:products` is idempotent and
deliberately does **not** reset `stock`, so a real count is never silently overwritten.

---

## Artwork

Every drink and every category has a cut-out picture. They are **in the repo**, so a clone gets
them without a copy of anyone's database:

```
server/seed-images/products/KC-HC-02.png      # 44, named by SKU
server/seed-images/categories/hot-coffee.png  # 6, plus categories.json for the real names
```

`npm run seed:images` loads them into the `product_images` / `category_images` tables (part of
`setup`). Named by SKU rather than row id because `product_images.product_id` is a serial that
depends on insert order — `12.png` would attach the cappuccino's picture to whatever landed on
row 12 in someone else's database.

**Uploading a new one:** Inventory → tap a product → *Product picture* (admin only, and only for
a product that already exists). Any image with a **transparent background** works; it is
normalised to a 512×512 transparent PNG, trimmed to the subject and centred, so a phone photo
and a 4000px render end up the same size on the shelf.

⚠ The browser cannot *remove* a background. If one is still there the upload warns you and the
tile shows a rectangular block on its gradient. Generate cut-outs in the first place — with
OpenAI that means `gpt-image-1` with `background: "transparent"`; DALL·E 3 cannot produce alpha.

**Where the bytes live:** the `product_images` table, not a column on `products` and not the
filesystem. A bytea column on `products` would drag ~300kB per row into the catalogue fetch every
till makes at login, and container filesystems are ephemeral. Images are served individually with
an ETag and a year-long `immutable` cache. Deleting a product deletes its picture with it.

A category with no artwork falls back to a coloured letter badge, which is a supported state:
the category list is user-editable, so a new one will appear without a picture.

---

## Tests

```bash
npm test                  # frontend, jsdom          143
npm run test:server       # API against Postgres     503
npm run test:reporting    # report builders, pure     60
npm run test:reporting:pg # reporting vs Postgres     48
npm run test:all          # all four                 754
```

CI runs all four on every push. The database suites create and migrate their own throwaway
databases (`kanpos_test`, `reporting_test`) per run, so they never touch the shop's data.

---

## Configuration

Everything shop-specific is environment. Copy `.env.example` to `.env` and fill it in; the
comments there explain each value and what breaks if it is wrong. An invalid tax rate or view
name stops the API booting **on purpose** — a rate that quietly fell back to 16% would print a
wrong VAT line on every receipt the shop ever issues.

The security-relevant knobs (`TRUST_PROXY`, the lockout counters, `PRINT_BRIDGE_ORIGIN`) are
documented in [SECURITY.md](SECURITY.md). `TRUST_PROXY` in particular must name the reverse
proxy's own address in production, and must never be a number or `true`.

---

## Deployment

[DEPLOY_VPS.md](DEPLOY_VPS.md) — one VPS hosts every shop: a shared platform stack (Caddy +
Postgres) plus one small client stack each. CI publishes an image to GHCR on every push to
`main`; pin a shop to a specific tag, never `latest`.

The thermal printer needs a **secure context**, so a real host must be HTTPS. `localhost` counts
as secure, which is why printing works in development.

---

## Known gaps

| | |
|---|---|
| **No registered tax number** | Receipts print without one. Set `CLIENT_SELLER_TAX_NO` before the shop issues a real receipt. The template's `1234567` placeholder was deliberately removed rather than shipped |
| **No JoFotara credentials** | E-invoicing is hidden until the owner supplies their own ISTD client id and secret. There is no sandbox — the first submission is a real filing |
| **Not deployed** | Runs locally only; no host, no DNS, no backup schedule yet |
| **`react-scripts` 5.0.1 is unmaintained** | Every remaining npm advisory chains up to it, and all are build-toolchain only. Migrating to Vite is the durable fix |
| **This repo is public** | Needed for the Pages demo on the free plan, which puts Kan's menu, prices and artwork in the open. See CLIENT_INTAKE.md |

Full agreed spec and blocker list: [CLIENT_INTAKE.md](CLIENT_INTAKE.md).
Security audit and what it changed: [SECURITY.md](SECURITY.md).
API reference: [server/API_README.md](server/API_README.md).
