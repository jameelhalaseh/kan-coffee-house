// pg connection pool for the Kan Coffee House POS API.
//
// SSL: managed Postgres (Heroku) requires TLS over a self-signed chain, so
// rejectUnauthorized must be false there. A Postgres container on a private Docker network
// wants no TLS at all — and NODE_ENV is 'production' in that container too, so the old
// NODE_ENV-only rule would wrongly demand TLS and fail to connect.
//
// DATABASE_SSL decides when set ('true'/'false'); otherwise fall back to the previous
// NODE_ENV behaviour, which leaves existing Heroku deploys working untouched.
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — the API cannot start without a database.');
}

const sslEnv = (process.env.DATABASE_SSL || '').trim().toLowerCase();
const useSsl = sslEnv ? sslEnv === 'true' : process.env.NODE_ENV === 'production';

// POOL SIZE. pg's default max is 10 per process, which is fine for one app and wrong for a
// shared box: every client stack on the VPS talks to the SAME Postgres, so the ceiling that
// matters is (clients × max) against the server's max_connections. At the default that is
// 15 shops × 10 = 150 against a server configured for 100 — the tenth shop to get busy
// starts collecting "sorry, too many clients already", and it lands on whichever shop
// happened to open last, not on the one causing it.
//
// 5 is ample here: the API is short queries against small tables, and a till holds a
// connection for milliseconds. Raise it only with a measured reason, and raise
// max_connections in deploy/platform/docker-compose.yml in the same change.
const poolMax = Number(process.env.DB_POOL_MAX) || 5;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: poolMax,
  // Hand idle connections back rather than holding five open per shop overnight.
  idleTimeoutMillis: 30_000,
  // Fail fast instead of hanging a request forever when the pool is drained or the DB is
  // down — the caller gets a 5xx it can log, which is the alertable outcome.
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // A pooled client died unexpectedly (e.g. DB restart). Log; pg will re-create on demand.
  console.error('[db] idle client error:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
