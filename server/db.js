// pg connection pool for the CashierPOS API.
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A pooled client died unexpectedly (e.g. DB restart). Log; pg will re-create on demand.
  console.error('[db] idle client error:', err.message);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
