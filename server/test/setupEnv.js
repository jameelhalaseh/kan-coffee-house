// Runs in every worker BEFORE any test file (and therefore before server/db.js builds its
// pool). globalSetup already put the test URL on process.env; this re-asserts it so a
// stray .env load in a required module can never repoint a test run at the demo database.
// Default retargeted for this fork: Kan's local Postgres is 5435/kanpos (docker-compose.yml).
// The inherited default was 5433/liquorpos_test, and on a machine running several of these
// shops 5433 belongs to a DIFFERENT project's Postgres — the suite failed with "password
// authentication failed for user pos", which reads like a broken test setup rather than a
// wrong port. CI overrides this with TEST_DATABASE_URL either way.
//
// TEST_DATABASE_URL may also live in .env, so rotating the dev database's password does not
// break the suite. Read with `processEnv: {}` so dotenv fills a throwaway object instead of
// process.env: a plain dotenv.config() here would also load DATABASE_URL and point the run at
// the SHOP'S OWN database, which the paragraph above exists to prevent.
let fileEnv = {};
try { fileEnv = require('dotenv').config({ processEnv: {} }).parsed || {}; } catch (_) { /* no .env */ }

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || fileEnv.TEST_DATABASE_URL
  || 'postgres://pos:pos@localhost:5435/kanpos_test';
process.env.DATABASE_SSL = 'false';
process.env.NODE_ENV = 'test';

// Deterministic session lifetime regardless of what the developer's .env says.
process.env.SESSION_TTL_HOURS = '12';

// Deterministic brute-force lockout for the same reason: a developer whose .env sets
// AUTH_LOCK_MAX_FAILS=0 to stop being locked out locally would otherwise silently turn off
// the very behaviour auth.test.js exists to pin, and the suite would go green on a shop
// with no protection at all.
process.env.AUTH_LOCK_MAX_FAILS = '5';
process.env.AUTH_LOCK_MINUTES = '15';

// The VAT rate the order validator checks every bill against (server/routes/orders.js).
// Pinned rather than inherited: the fixtures compute the tax they send, so a developer's
// .env setting a different rate would fail every checkout test with tax_mismatch.
process.env.CLIENT_TAX_PCT = '16';

// A suite logs in far more often than a shop does, and every test shares one "client IP",
// so the shipped per-IP ceilings would throttle the run itself. Raised through the same
// env knobs an operator would use — the limiter code under test is unchanged, and the
// per-USERNAME lockout in server/auth.js (which the auth suite asserts on) still applies.
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.REPORTS_RATE_LIMIT_MAX = '100000';
