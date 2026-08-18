# Security — Kan Coffee House POS

Record of the audit of **2026-08-18** and what it changed. Every finding below was tested, not
inferred: where it says something was exploitable, it was exploited against the local instance
first and re-tested after the fix.

---

## Fixed

### 1. Every rate limit was bypassable with one header

`server/index.js` set `trust proxy: 1`, so Express read the client's own `X-Forwarded-For` as
the source address — letting a caller pick their own limiter bucket. Measured before the fix:
29 wrong passwords, then `429`, then **twenty more attempts accepted** simply by adding
`X-Forwarded-For: 9.9.9.1`. It defeated the login limiter, the reports limiter and the global
API limiter alike.

Putting Caddy in front would not have fixed it. Caddy *appends* the real client to the header,
so an attacker-supplied value sits to its left and the numeric setting lands on exactly the
value the attacker wrote.

**Now:** `TRUST_PROXY` (default empty) — nothing is trusted and `req.ip` is the socket address,
which cannot be forged. A deployment behind a proxy sets it to that proxy's address or subnet,
never a number and never `true`. The server warns once at boot if it sees the header while the
setting is empty, which is the opposite misconfiguration (the whole shop shares one bucket).

**Re-tested:** 40 attempts, each with a fresh forged IP → 30 throttled. Before: 0.

### 2. No account could ever lock

`AUTH_LOCK_MAX_FAILS=0`. Verified: 40 wrong passwords for `owner` left `pin_attempts` empty.
That was a deliberate choice — the shipped 5 strikes / 15 minutes cost a barista a quarter of an
hour for one mistyped password — but combined with finding 1 it left password guessing with no
cap at all.

**Now:** back on, retuned to **10 failures / 2 minutes**. Ten consecutive failures is not a
typo, and two minutes is a pause rather than a lost shift, so the reason it was switched off is
gone. Verified engaging at exactly 10 with a 2-minute lock.

### 3. The reset code was capped only by the login lockout

`confirm-reset` takes a **six-digit** code with a fifteen-minute life. Its only brute-force
protection was the same counter as login, so setting `AUTH_LOCK_MAX_FAILS=0` for counter
convenience silently removed it from the admin account-recovery path too.

**Now:** `AUTH_RESET_MAX_FAILS` is a separate floor that the login switch cannot reach, and a
`0` is read as `5` so it cannot be switched off. `server/test/resetLockFloor.test.js` loads the
module with the login lockout disabled and asserts reset failures still lock.

This one was **latent, not live**: the flow returns 503 because EmailJS is unconfigured. It
would have become live the day those four `EMAILJS_*` vars were filled in.

### 4. The database was on the network with the password `pos`

`docker-compose.yml` published `0.0.0.0:5435`. Proven by connecting from a separate container
over the machine's LAN address and reading the products table. On any shared café or office
WiFi that exposed every price and sale, and the whole `app_users` table — where overwriting a
bcrypt hash is easier than cracking one. Docker writes its own iptables rules, so a host
firewall did not cover it.

**Now:** bound to `127.0.0.1:5435`. Re-tested: the same connection is refused, while local
development is unaffected.

⚠ **One step is still yours to run.** The password is still `pos`. It is no longer reachable off
this machine, so this is hygiene rather than exposure, but on a shared machine rotate it:

```bash
docker exec -it kan-pos-db psql -U pos -d postgres -c "alter user pos with password '<new>'"
```

then update `POS_DB_PASSWORD`, `DATABASE_URL`, `TEST_DATABASE_URL` and
`REPORTING_TEST_DATABASE_URL` in `.env`. The test harnesses read those from `.env` now, so
rotating will not break `npm test`.

### 5. The server never checked the money

`validateDiscounts` returned early unless some line carried a discount, so for an ordinary sale
`sub`, `tax` and `total` were written **exactly as the browser sent them**. Any staff session —
or anyone running a modified copy of the front end — could post a 3.750 latte as
`total: 0.100, tax: 0`. Everything downstream is built from those three columns: the Z-report,
the P&L, and whatever is eventually filed with the ISTD. A bill with **no lines at all** and any
total was accepted too.

**Now:** `validateOrderMoney` recomputes every bill, discounted or not:

| Checked | Not checked, deliberately |
|---|---|
| `total` follows from the lines, discounts and service charge | Line **prices** — a price override is a real till feature, and open-price items have no catalogue row |
| `tax` is the inclusive extraction from that total, at the rate from the **server's** environment | |
| `sub` is the remainder | |
| Every line has a finite, positive qty and a non-negative price | |
| A bill must have at least one line | |

Refunds keep their own shape (positive lines, negated total, no tax of their own), stated
explicitly so returns are not rejected. `server/test/orderMoney.test.js` covers 18 cases,
including the exact attacks above and the honest bills that must still go through.

Two notes on the change:

- **A contract changed.** `lineDiscounts.test.js` used to assert that `total: 999` on a single
  10.000 line was accepted. That test now asserts the opposite.
- **Refunds still do not reverse the VAT line** (`tax: 0` on the reversing row). That is
  pre-existing behaviour and a reporting question, not a security one — it was not changed here.

### 6. Sessions lasted thirty days idle

`SESSION_IDLE_HOURS=720`, with the token in `localStorage`. **Now 48.** Sessions renew on every
use, so a till used daily still never logs itself out, while a device that goes quiet expires
within two days.

### 7. Smaller items

- **Source maps were published** — the live site served `main.*.js.map`. `GENERATE_SOURCEMAP=false`
  is now part of `npm run build`, which both the Docker image and the Pages workflow use.
- **`@supabase/supabase-js` was a dead dependency**, referenced only in a comment. Removed.
- **CSP allowed `http://localhost:*`** in `connect-src`, i.e. every port on the operator's own
  machine. Now pinned to the print bridge's own origin via `PRINT_BRIDGE_ORIGIN`.
- **Dependency CVEs: 37 → 30** (high 19 → 12) via same-major `overrides`, verified against
  `npm ci`, all four test suites and both builds. See the caveat below.

---

## What was tested and found sound

Worth recording, because it is most of the app:

- **SQL injection is not possible.** The only interpolations are table names, whitelisted
  through `server/floors.js` to the single constant `orders_main`; everything else is
  parameterised.
- **XSS is handled.** `src/receipt.js` escapes product names before building receipt HTML, the
  thermal printer's `innerHTML` receives already-escaped markup, and CSP is `script-src 'self'`
  with no `unsafe-inline`, plus `object-src 'none'` and `frame-ancestors 'none'`.
- **Authentication and authorisation.** All ten sensitive endpoints return 401 unauthenticated;
  every user-management route is `requireSession, requireAdmin` — no IDOR. Passwords are bcrypt
  cost 10. Session tokens are 24 random bytes, stored sha256-hashed, cleared on logout.
- **Uploads.** PNG signature + `IHDR` + exact 512×512 dimensions + a 1MB cap, and the served
  `Content-Type` is hardcoded rather than taken from the upload.
- **Errors.** The handler returns `{"error":"server"}`; the stack goes only to the log.
- **Secrets.** None has ever been committed (full history checked), `.env` is gitignored, and the
  container runs as `USER node`.
- **The AI assistant** is off and keyless. If it is ever switched on, shop sales, costs and stock
  are sent to NVIDIA's API — worth knowing before enabling it.

---

## Open, and needing a decision rather than a patch

1. **`react-scripts` 5.0.1 is unmaintained.** Every one of the remaining 30 advisories chains up
   to it — verified: `express`, `pg`, `helmet`, `cors`, `bcryptjs`, `express-rate-limit`, `react`
   and `react-dom` are all clean, so none of them is in the server's or the browser's runtime
   path. They are build-toolchain only. The durable fix is migrating to Vite, which is a project
   rather than a patch.
2. **The repository is public**, so Kan's menu, prices and the 51 artwork thumbnails are
   downloadable by anyone with the URL. It is public because GitHub Pages will not host the demo
   from a private repo on the free plan. Making it private takes the demo link down. Deliberately
   not changed unilaterally — see `CLIENT_INTAKE.md`.
3. **The registered tax number is still empty**, so every receipt prints without one. Not a
   vulnerability; still the most important open item in the project.
