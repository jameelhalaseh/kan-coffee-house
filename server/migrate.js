// Apply server/migrations/*.sql in filename order against DATABASE_URL.
//   npm run migrate                (locally, with .env)
//   docker compose exec app npm run migrate
//   npm run migrate -- --status    (show what is applied / pending, change nothing)
//
// WHY THERE IS A LEDGER NOW
// This used to re-execute EVERY .sql file on every deploy and rely on each statement being
// written `if not exists`. That holds for pure DDL and had held so far — but it is a trap
// with a fuse on it: the first migration that moves data (a backfill, an UPDATE, a seed of
// a lookup table) silently re-runs on every single deploy, and nothing in the file can
// protect itself. It also meant a deploy could never tell you what state the database was
// actually in.
//
// So: applied filenames are recorded in schema_migrations, each file runs exactly once, and
// each runs inside its own transaction — a failure half-way leaves nothing behind.
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./db');

const DIR = path.join(__dirname, 'migrations');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const LEDGER = `
  create table if not exists schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )`;

// Does this database predate the ledger? Any pre-existing table from 0001 proves the schema
// is already there, and re-running the files would be wrong to assume as "pending".
async function isExistingDatabase(client) {
  const { rows } = await client.query("select to_regclass('public.products') is not null as present");
  return rows[0].present;
}

async function main() {
  const statusOnly = process.argv.includes('--status');
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) { console.log('No migration files found.'); return; }

  const client = await pool.connect();
  try {
    await client.query(LEDGER);

    const { rows: doneRows } = await client.query('select filename, checksum from schema_migrations');
    const done = new Map(doneRows.map((r) => [r.filename, r.checksum]));

    // BASELINE. An empty ledger on a database that already has the schema means this is an
    // existing deployment meeting the ledger for the first time. Record every current file
    // as already applied instead of replaying it — replaying is exactly the risk above.
    if (done.size === 0 && await isExistingDatabase(client)) {
      if (statusOnly) {
        console.log('Existing database with no ledger — a real run would baseline these as applied:');
        files.forEach((f) => console.log(`  baseline  ${f}`));
        return;
      }
      await client.query('begin');
      for (const f of files) {
        await client.query(
          'insert into schema_migrations (filename, checksum) values ($1,$2) on conflict do nothing',
          [f, sha(fs.readFileSync(path.join(DIR, f), 'utf8'))]
        );
      }
      await client.query('commit');
      console.log(`Baselined ${files.length} existing migration(s) — schema was already present.`);
      return;
    }

    // A file that changed after being applied is a mistake worth naming: the database does
    // NOT contain what the file now says. Report it, don't silently re-run it.
    const drifted = [];
    const pending = [];
    for (const f of files) {
      const checksum = sha(fs.readFileSync(path.join(DIR, f), 'utf8'));
      if (!done.has(f)) pending.push({ f, checksum });
      else if (done.get(f) !== checksum) drifted.push(f);
    }

    if (statusOnly) {
      files.forEach((f) => {
        const state = !done.has(f) ? 'PENDING ' : drifted.includes(f) ? 'CHANGED ' : 'applied ';
        console.log(`  ${state} ${f}`);
      });
      console.log(`\n${done.size} applied, ${pending.length} pending${drifted.length ? `, ${drifted.length} CHANGED` : ''}.`);
      return;
    }

    for (const f of drifted) {
      console.warn(`WARNING: ${f} changed since it was applied. The database still has the old version.`);
      console.warn('         Add a NEW migration for the change rather than editing history.');
    }

    if (!pending.length) { console.log('Database is up to date — nothing to apply.'); return; }

    for (const { f, checksum } of pending) {
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8').trim();
      if (!sql) continue;
      process.stdout.write(`Applying ${f} ... `);
      // Own transaction per file. The existing files each contain begin/commit of their own;
      // Postgres treats those as no-ops inside an open transaction block (with a warning),
      // so both styles land atomically.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (filename, checksum) values ($1,$2)',
          [f, checksum]
        );
        await client.query('commit');
        console.log('done.');
      } catch (e) {
        await client.query('rollback').catch(() => {});
        throw new Error(`${f}: ${e.message}`);
      }
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Migration failed:', e.message); pool.end(); process.exit(1); });
