# Client Intake — Liquor Store POS

**Status: DEMO BUILD.** No client meeting has happened. Every answer below is a sensible
demo default chosen to exercise the whole feature set (notably: VAT is ON so the tax path
is visible). Overwrite the ✎ lines with the client's real answers and re-run the skill —
each maps 1:1 to `src/client.config.js`, seed data, or a Heroku env var.

## 1. Store identity

- Store / brand name (EN): ✎ **Liquor Store**
- Store name (AR, printed on receipt): ✎ *(not set — receipt header uses the EN name)*
- Business type: **liquor / off-licence retail** (catalogued bottles, counter checkout)
- Currency: **JOD**
- Default language: **English** (AR⇄EN runtime toggle still available in Settings)
- Store key: **`main`** → table `orders_main`, mirrored in `server/floors.js`

## 2. Tax & receipt

- Tax-free receipts? **no → VAT 16%** (alcohol is taxable; also proves the tax path works)
- Seller identity on receipt: name ✎ **Liquor Store** / location ✎ **Amman, Jordan** /
  taxNo ✎ **1234567** *(placeholder — replace with the real registration number)*
- Receipt footer (EN): "Please drink responsibly. Thank you!"
- Receipt footer (AR): "نرجو الشرب بمسؤولية. شكراً لكم"
- Invoice prefix: **`LQ`**

## 3. Catalogue

- Barcode-driven? **yes** — USB keyboard-wedge scanner at the counter
- Categories: Whiskey, Vodka, Gin, Rum, Tequila, Brandy, Arak, Liqueur, Wine, Beer,
  Champagne, Mixers, Accessories
- Initial catalogue import: **demo seed** — 57 products in `server/seed-products.sql`.
  A real client catalogue can now be loaded from the UI: Inventory → ⬆ Import CSV (admin
  only), columns `barcode, name, price, cost, stock, cat, unit, active`. Ask the client for
  their stock list as a spreadsheet at the meeting; editing the SQL seed is no longer
  required.
- Weighted items: **no** — bottles and cans are unit-priced (`unit = 'ea'`)

## 4. Views / modules

All seven shipped: `sales`, `inventory`, `receive`, `history`, `reports`, `assistant`,
`settings`.

- Suppliers & receive-stock flow: **yes** (4 demo suppliers seeded)
- Staff time-clock: **yes**
- AI assistant: **insights only** — deterministic low-stock/expiry alerts work with no key.
  Set `NVIDIA_API_KEY` to turn on chat.
- Thermal printer: **available** (ESC/POS over Web Serial, Chrome/Edge) — demo runs paperless
- Cash drawer kick: **available**, untested without hardware

## 5. Users

Admins see everything. Non-admins get `allowed_views`, enforced server-side — anyone who
needs revenue/profit MUST have `reports` or the API returns 403.

| # | Username  | Role  | allowed_views                                             | Email |
|---|-----------|-------|-----------------------------------------------------------|-------|
| 1 | `owner`   | admin | (all)                                                     | —     |
| 2 | `manager` | user  | sales, inventory, receive, history, reports, settings      | —     |
| 3 | `cashier` | user  | sales, history                                            | —     |

Demo passwords live in `.env` (gitignored) and were used once by `seed:admin`/`seed:users`.
Real passwords are collected at seed time only (8+ chars), never written to the repo.

## 6. Hosting

- Heroku app name: ✎ *(not created — demo runs on local Docker Postgres, port 5433)*
- Region: ✎ TBD
- Forgot-password email (EmailJS): **skipped** — endpoint returns 503, login unaffected
- Daily backups + offsite GitHub backup repo: **later** (see `DEPLOY_HEROKU.md` §6)

## 7. Notes / follow-ups

- **Age verification is not in the product.** A liquor shop may need an "18+/21+ confirmed"
  prompt at checkout and/or an ID-check audit trail. That's schema + UI work, not a config
  change — flag as a follow-up phase if the client wants it.
- Excise/licence numbers beyond the single `taxNo` receipt field would also be new work.
- Batch/expiry tracking already exists (`batches.expiry`) if the client stocks anything
  perishable — unused in this demo.
