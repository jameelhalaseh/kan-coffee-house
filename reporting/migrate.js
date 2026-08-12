// Apply reporting/migrations/*.sql in filename order.
//   npm run migrate:reporting
//   npm run migrate:reporting -- --status
//
// Its own ledger table (reporting_migrations), separate from server/migrations' — the two
// schemas are deployed independently and a shared ledger would make one module's baseline
// silently mark the other's files as applied.
//
// Each file runs inside its own transaction, exactly once. A checksum change after a file
// has been applied is REPORTED, not re-run: the database does not contain what the file now
// says, and quietly replaying it is how a data migration runs twice.
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, 'migrations');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const LEDGER = `
  create table if not exists reporting_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`;

async function migrate(pool, { statusOnly = false, log = console.log } = {}) {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query(LEDGER);
    const { rows } = await client.query('select filename, checksum from reporting_migrations');
    const done = new Map(rows.map((r) => [r.filename, r.checksum]));

    const drifted = [];
    const pending = [];
    for (const f of files) {
      const checksum = sha(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!done.has(f)) pending.push({ f, checksum });
      else if (done.get(f) !== checksum) drifted.push(f);
    }

    if (drifted.length) {
      log(`WARNING: applied migration(s) changed on disk: ${drifted.join(', ')}`);
    }
    if (statusOnly) {
      files.forEach((f) => log(`  ${done.has(f) ? 'applied ' : 'pending '} ${f}`));
      return { applied: [], pending: pending.map((p) => p.f), drifted };
    }

    for (const { f, checksum } of pending) {
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into reporting_migrations (filename, checksum) values ($1,$2)', [f, checksum]);
        await client.query('commit');
        log(`applied ${f}`);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
    return { applied: pending.map((p) => p.f), pending: [], drifted };
  } finally {
    client.release();
  }
}

module.exports = { migrate, DIR };

if (require.main === module) {
  const { Pool } = require('pg');
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }
  const ssl = (process.env.DATABASE_SSL || '').toLowerCase() === 'true'
    || (process.env.DATABASE_SSL === undefined && process.env.NODE_ENV === 'production');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ssl ? { rejectUnauthorized: false } : false,
  });
  migrate(pool, { statusOnly: process.argv.includes('--status') })
    .then(() => pool.end())
    .catch((e) => { console.error(e.message); pool.end().finally(() => process.exit(1)); });
}
