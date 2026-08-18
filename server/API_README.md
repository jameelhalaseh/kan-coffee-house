# API reference

`server/index.js` mounts everything under `/api` via `server/routes/index.js`. One Express
process serves both this API and the static React build.

This file documents the **model and the guarantees**. Per-endpoint request and response shapes
live beside the handlers, which are commented — a second copy here would drift, and a stale API
document is worse than none because people trust it.

## Authentication

An opaque session token, **not** a JWT. `POST /api/auth/login` returns one; every other request
carries it as `Authorization: Bearer <token>`.

- 24 random bytes (192 bits), stored **sha256-hashed** in `app_users.session_token` — a database
  dump does not yield usable sessions.
- **Idle** expiry, renewed on use (`SESSION_IDLE_HOURS`, default 48). A till in daily use never
  logs itself out; a device that goes quiet expires.
- One active session per user: logging in elsewhere invalidates the previous token.
- Passwords are bcrypt. `POST /api/auth/confirm-reset` codes are capped independently of the
  login lockout — see [SECURITY.md](../SECURITY.md).

**Unauthenticated endpoints, and only these:** `POST /auth/login`, `POST /auth/logout`,
`GET /auth/validate`, `POST /auth/request-reset`, `POST /auth/confirm-reset`, plus `/healthz`
and `/readyz` outside `/api`. Everything else returns **401** without a valid session.

## Authorisation

Three levels, all enforced **server-side**. Hiding a button is a courtesy, not a control.

| Guard | Meaning |
|---|---|
| `requireSession` | Any valid session |
| `requireView(...)` | The user's `allowed_views` must include one of the named views. Admins bypass |
| `requireAdmin` | `role = 'admin'` |

A cashier without the `reports` view gets **403** from the reporting endpoints, not an empty
page — verified in `server/test/security.test.js`.

## Route groups

| Mounted at | Module | Gate |
|---|---|---|
| `/api/auth/*` | `routes/auth.js` | public (see above) |
| `/api/orders` | `routes/orders.js` | session to write; reading history is view-gated (`history`/`dashboard`/`reports`); `DELETE` (void) is admin |
| `/api/invoice/next` | `routes/orders.js` | session |
| `/api/products`, `/api/settings/categories` | `routes/products.js` | session; price changes and deletes are admin; `products/import` is admin |
| `/api/product-images`, `/api/category-images` | `routes/productImages.js`, `routes/categoryImages.js` | session to read, admin to upload or delete |
| `/api/suppliers`, `/api/batches` | `routes/suppliers.js` | session to read, `receive` view to write, admin to delete |
| `/api/users`, `/api/customers`, `/api/admin-log` | `routes/accounts.js` | **admin** for every user-management route |
| `/api/reports/*` (one segment) | `routes/reports.js` | `requireView('reports', 'dashboard')` |
| `/api/reports/:floor/*` (two segments) | `reporting/api.js` | its own `reports` / `reports:edit` grants; admins bypass |
| `/api/timeclock/*` | `routes/timeclock.js` | session for one's own clock-in/out, view-gated to read others |
| `/api/jofotara/*` | `routes/jofotara.js` | `requireView('reports')`; 503 until credentials are configured |
| `/api/ai/*` | `routes/ai.js` | **admin**; 503 without `NVIDIA_API_KEY` |

The reporting module mounts **last**, deliberately: the one-segment report paths above own their
names, and if a path ever collided the incumbent would keep it rather than be shadowed.

## Conventions

- **Errors** are `{ "error": "<code>" }` with a real status. Codes are stable and the UI switches
  on them (`invoice_taken`, `over_refund`, `total_mismatch`, `tax_mismatch`,
  `discount_exceeds_line`, `exists`, `rate_limited`). Unhandled failures return
  `500 {"error":"server"}` and the stack goes only to the log.
- **Money is validated, not trusted.** `POST /api/orders` recomputes `sub`, `tax` and `total`
  from the lines and refuses a bill that does not add up. Line prices remain the caller's to set,
  because a price override is a real till feature.
- **Checkout is one transaction:** the order row, the stock movement for every catalogue line and
  the stock-log entries commit together. A re-POST of the same order id does not deduct twice.
- **Stores are whitelisted**, never interpolated: `server/floors.js` maps `main` → the physical
  `orders_main` table and returns null for anything else.
- **Rate limits** are layered — auth, reports, then a global `/api` ceiling — and keyed on an IP
  that cannot be forged. See `TRUST_PROXY` in [SECURITY.md](../SECURITY.md).
- **Images** are served individually with an ETag and a year-long `immutable` cache, and the
  `Content-Type` is hardcoded rather than taken from the upload.

## Health

`GET /healthz` answers "is the process up"; `GET /readyz` answers "can it serve" — it touches the
database. Neither leaks anything about the shop.
