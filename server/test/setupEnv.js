// Runs in every worker BEFORE any test file (and therefore before server/db.js builds its
// pool). globalSetup already put the test URL on process.env; this re-asserts it so a
// stray .env load in a required module can never repoint a test run at the demo database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  || 'postgres://pos:pos@localhost:5433/liquorpos_test';
process.env.DATABASE_SSL = 'false';
process.env.NODE_ENV = 'test';

// Deterministic session lifetime regardless of what the developer's .env says.
process.env.SESSION_TTL_HOURS = '12';

// A suite logs in far more often than a shop does, and every test shares one "client IP",
// so the shipped per-IP ceilings would throttle the run itself. Raised through the same
// env knobs an operator would use — the limiter code under test is unchanged, and the
// per-USERNAME lockout in server/auth.js (which the auth suite asserts on) still applies.
process.env.AUTH_RATE_LIMIT_MAX = '100000';
process.env.API_RATE_LIMIT_MAX = '100000';
process.env.REPORTS_RATE_LIMIT_MAX = '100000';
