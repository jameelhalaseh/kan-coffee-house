# Client Intake — Kan Coffee House

Record of what was agreed on **2026-08-17**. Every line maps to an env var in this repo's
`.env`, a seed command, or an open blocker. Approved by the owner before provisioning.

> **Deviation from the standard onboarding, agreed deliberately.** The platform model is one
> shared image serving many shops, where a client is a database + `.env` + Caddy block +
> container and **never** a copy of the repository. Kan was instead delivered as a **fork**
> (`kan-coffee-house`) at the owner's explicit instruction, after the trade-off was
> put to them. The cost accepted: every future fix to the shared template must be applied
> twice. The template remote is kept as `template` so upstream changes can still be merged.
>
> **The fork is PUBLIC, not private as first recorded here.** It was made public so GitHub
> Pages could host the demo, which the free plan will not do for a private repository. Two
> consequences the owner should know: the 51 product and category thumbnails under
> `public/demo-art/` are downloadable by anyone with the URL (192px demo copies - the
> full-resolution artwork stays in the database), and Kan's menu and prices are readable in
> `server/seed-products.sql`. No credentials, tax number or customer data are in the repo, and
> `.env` is gitignored. If the owner would rather none of that were public, the fix is to make
> the repository private, which takes the demo link down with it.
>
> Consequence for this document: paths like `/srv/clients/kancoffee/` do not exist yet. Config
> lives in this repo's `.env`, and the shop currently runs locally only.

## 1. Identity

| Field | Value | Env |
|---|---|---|
| Shop name (EN) | Kan Coffee House | `CLIENT_STORE_NAME` |
| Shop name (AR) | كان | — (receipt, when the till is in Arabic) |
| Category | Cafe / coffee house — **counter service** | — (drives categories + seed) |
| Startup language | English (AR⇄EN toggle persists per device) | `CLIENT_LANG` |
| Currency | JOD | `CLIENT_CURRENCY` |
| Timezone (trading day) | Asia/Amman | `STORE_TZ` |
| Shop key | `kancoffee` | database, container, folder |
| URL | **none yet — local only**, `http://localhost:3003` | n/a (no Caddy block) |

Local Postgres: container `kan-pos-db`, database `kanpos`, host port **5435**. App port
**3003**. Both differ from the documented defaults because this machine already runs Postgres
on 5432 (host), 5433 (`clinicos-db`) and 5434 (the liquor-store fork), and serves 3001
(WeRespond-UI) and 3002 (liquor-store fork).

## 2. Money and receipt

| Field | Value | Env |
|---|---|---|
| VAT | 16% (prices are tax-INCLUSIVE) | `CLIENT_TAX_PCT` |
| Seller name | Kan Coffee House | `CLIENT_SELLER_NAME` |
| Seller location | Amman, Jordan — **assumed, not confirmed by the owner** | `CLIENT_SELLER_LOCATION` |
| **Tax number** | ⛔ **NOT SUPPLIED — blocker #1** | `CLIENT_SELLER_TAX_NO` |
| Invoice prefix | `KC` → `KC-000123` | `CLIENT_INVOICE_PREFIX` |
| Receipt footer EN | See you again soon! | `CLIENT_BILL_FOOTER` |
| Receipt footer AR | نراكم قريباً | `CLIENT_BILL_FOOTER_AR` |
| Legal declaration | *(blank — owner's words only, none dictated)* | `CLIENT_LEGAL_NOTE` |

The owner confirmed menu prices already include the 16%: Espresso 2.00 = 1.72 net + 0.28 VAT.

**The template's `1234567` placeholder tax number was removed from this fork**, in both
`src/client.config.js` and `server/clientConfig.js`, and the fallback is now empty. A
placeholder is worse than nothing: it prints on every receipt, looks like a real
registration, and nothing in the app flags it. Empty renders no tax line — visibly
incomplete, which is the correct signal while the real number is outstanding.

## 2b. Branding

| File | Supplied? | Shown |
|---|---|---|
| `logo.png` / `logo.svg` | No — deferred, "later" | sidebar + sign-in card |
| `icon-192.png` | No | installed-app icon |
| `icon-512.png` | No | installed-app icon |

Nothing supplied → the shop's **name** is shown as text. Nothing looks borrowed or broken.

⚠ **`server/branding.js` and the `GET /brand/:file` route do not exist in this codebase.**
The standard onboarding describes per-client logos as a folder of files needing no rebuild,
but the code that resolves and serves them is absent. Adding Kan's logo is therefore
**template work, not configuration** — see out-of-scope below.

## 3. Counter hardware

- Barcode scanner: **No** — the till works by category chips + name search; the barcode column
  holds synthetic internal SKUs only (see §4a)
- Thermal printer: **Yes** — ESC/POS over Web Serial, Chrome/Edge only, **requires HTTPS**
- Cash drawer kick: **Yes** — popped through the printer; also an admin-PIN-gated button
- Customer display screen: **Yes** — `?display=1` on a second monitor, mirrors the live cart

Web Serial needs a secure context. `http://localhost` **is** a secure context, so printing
works in the current local setup; HTTPS becomes a hard requirement the moment Kan moves to a
real host.

## 4. Features

| Feature | On? | Notes |
|---|---|---|
| Sales (till) | always | not optional |
| Inventory | **Yes** | catalogue, CSV import, low-stock |
| Receive stock / suppliers | **Yes** | no suppliers seeded — Kan adds their real ones; unusable until they do |
| History (reprint, void) | **Yes** | |
| Reports (operational) | **Yes** | Z-report, top products, dead stock. Clocked-hours card removed |
| Financials (`storereports`) | **Yes** | sales · discounts · stock · expenses · P&L · receipts + Excel |
| AI assistant | **No** — off entirely | nav button hidden; no key needed |
| Staff time-clock | **No** | ⚠ had no feature flag — **removed in code**, see §4b |
| Forgot-password email | **No** | login unaffected; admin reset returns 503 |
| JoFotara e-invoicing | **Wired, but INERT** | credentials blank; also gated on blocker #1 |
| Error alerts to webhook | **No** | errors still logged as JSON with `X-Request-Id` |
| Sentry | **No** | no-op without a DSN |
| Daily offsite backups | **Yes, agreed** | ⚠ not yet actionable — no box, no bucket/rclone remote |

`CLIENT_VIEWS=sales,inventory,receive,history,reports,storereports,settings`

Always included, not toggleable: multi-line JOD discounts with notes, void-not-delete
invoices, the offline sales queue + PWA, Arabic⇄English toggle, cash/card/CliQ payments.

### 4a. Catalogue — 44 products, Kan's real drinks menu

Seeded from the shop's published menu. Six categories, ordered to match how the printed menu
reads: Hot Coffee (13) · Cold Coffee (8) · Tea & Herbs (7) · Hot Kan (3) · Cold Kan (6) ·
Special (7).

Three decisions worth recording:

1. **Synthetic internal SKUs (`KC-HC-01`…) occupy the `barcode` column.** Kan has no scanner,
   but `barcode` is the UNIQUE column the seed upserts on, and in Postgres NULL never
   conflicts with NULL — 44 empty barcodes would make the seed insert 44 more rows on every
   run. These are internal keys, not scannable codes.
2. **Made-to-order drinks carry `stock = 9999`, `low_at = 0`.** Checkout deducts stock for
   every catalogue line and there is no non-stock-item flag. Seeding 0 would paint a
   permanent red "Out" pill on all 44 tiles, training staff to ignore the badge.
   *Consequence:* the count drifts down one per drink sold and needs an occasional reset in
   Inventory. Cold Brew Bottle is the exception — a genuinely stocked item, `stock = 24`,
   `low_at = 6`.
3. **`cost = 0` on every line, because Kan supplied no costs.** Financials/P&L will therefore
   report 100% margin. That is an honest "no cost data" state, not a real figure — load costs
   before showing the owner the P&L tab.

Also: **Chai Karak was excluded** (greyed out on the menu; owner confirmed not sold), and
**Spanish Latte and Caramel Macchiato each exist twice** — hot and cold at different prices,
identical names at the owner's request. The category chip is the only thing distinguishing
them, so it is a barista training point rather than a bug. (Mocha appears twice too, but the
menu reverses the word order — "White / Dark" hot, "Dark / White" cold — so those two are
already distinguishable.)

No demo sales were seeded. The template's `seed:sales` script was renamed
`seed:demo-sales-DESTRUCTIVE` and removed from the setup chain: fabricated revenue in a real
client's database corrupts every report the owner will look at.

### 4b. Time-clock removal — a code change, not config

The owner declined the time-clock. Unlike every other feature it had **no env flag**: the
Clock In/Out button was hardcoded in `src/components/Sidebar.jsx` and the "Clocked hours" card
in `src/views/ReportsView.jsx`. Both were removed from this fork.

The server routes (`server/routes/timeclock.js`) and the `time_clock` table were **left
intact** — nothing calls them, they cost nothing idle, and re-enabling becomes a UI change
rather than a migration.

**This is a template gap.** The right fix is a feature flag upstream so the next cafe is an
`.env` line instead of a fork.

## 5. Users

| Username | Role | allowed_views |
|---|---|---|
| `owner` | admin | (all) |
| `manager` | user | sales, inventory, receive, history, reports, storereports, settings |
| `barista1` | user | sales, history |
| `barista2` | user | sales, history |

⚠ `allowed_views` is enforced server-side. Anyone who must see revenue/cost/profit needs
`reports` (and `storereports`), or the API returns 403 and the screen is empty. `barista1` and
`barista2` deliberately cannot see cost or profit.

Passwords are typed at seed time only. They are **not** in this file, the repo, or the `.env`
— the `.env` ships with `ADMIN_PASSWORD` and `USERS_JSON` blank and the exact seed commands in
a comment at the bottom of it. **The accounts are therefore NOT YET SEEDED.**

## 6. Open before go-live

- [ ] ⛔ **Real tax number on the receipt** — `CLIENT_SELLER_TAX_NO` is empty; Kan must not
      issue a single real receipt until it is filled in
- [ ] ⛔ **JoFotara credentials** — Client ID, Secret Key, activity/income-source number,
      seller TIN and taxpayer type, all from Kan's OWN ISTD portal account. No sandbox
      exists: the first submission is a real legal filing and **the owner triggers it**
- [ ] **Seed the four accounts** — passwords typed on the command line, see `.env`
- [ ] **Confirm the seller location line** (currently assumed "Amman, Jordan")
- [ ] **Load product costs** — P&L reads 100% margin until then
- [ ] **Kan's real suppliers** — none seeded; Receive is unusable until they add one
- [ ] **Hosting decision + DNS**, then HTTPS (a hard requirement for the printer)
- [ ] **Backups**: bucket + rclone remote, then one backup taken **and restored** into a
      scratch database. An untested backup is a guess
- [ ] Logo artwork, if wanted — requires the branding code first (§2b)

## 7. Out of scope (quoted separately if wanted)

- **Per-client logo support** — `server/branding.js` + `GET /brand/:file` are absent from this
  codebase and must be written before any shop can have its own mark.
- **Time-clock feature flag** — removing it required editing two components; a proper flag
  belongs upstream.
- **Non-stock-item flag** — the workaround for made-to-order drinks (`stock = 9999`) drifts
  and needs periodic resetting. A real fix means teaching the catalogue that some products
  are not counted.
- **Weighed / priced-by-kg items** — if Kan ever sells retail beans by weight. Today every
  line is unit-priced; the workaround is fixed pre-bagged SKUs.
- **Size variants** — small/medium/large would each be a separate product row.
- **Food menu** — drinks only at intake.

Known gaps in this template: no weighed/priced-by-kg items, no table service or kitchen
tickets, no batch expiry, no size/colour variants, no age-verification prompt, and no payment
method beyond cash / card / CliQ.
