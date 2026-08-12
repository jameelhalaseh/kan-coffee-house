// Jest globalSetup for the reporting module's Postgres suite.
//
// Its own database (reporting_test), dropped and recreated per run, so a run can never touch
// the demo data or race the server suite's liquorpos_test. The schema under test is the
// schema that ships: reporting/migrate.js applies the real migration files.
//
// Point REPORTING_TEST_DATABASE_URL anywhere to run this in CI. The default is the local
// docker-compose container (`npm run db:up`).
const { Client, Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');
const { migrate } = require('../migrate');

const TEST_URL = process.env.REPORTING_TEST_DATABASE_URL
  || 'postgres://pos:pos@localhost:5433/reporting_test';

module.exports = async () => {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1);

  const adminUrl = new URL(TEST_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host} — start it with \`npm run db:up\`.\n${e.message}`);
  }
  try {
    const ident = `"${dbName.replace(/"/g, '""')}"`;
    await admin.query(`drop database if exists ${ident} with (force)`);
    await admin.query(`create database ${ident}`);
  } finally {
    await admin.end();
  }

  // The APP's migrations first: sales now come from orders_main, which the app owns. Then the
  // module's own, which add the expense tables and retire the restaurant ones.
  execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'server', 'migrate.js')], {
    env: { ...process.env, DATABASE_URL: TEST_URL, DATABASE_SSL: 'false' },
    stdio: 'pipe',
  });

  const pool = new Pool({ connectionString: TEST_URL, ssl: false });
  try {
    await migrate(pool, { log: () => {} });
  } finally {
    await pool.end();
  }

  process.env.REPORTING_DATABASE_URL = TEST_URL;
};

module.exports.TEST_URL = TEST_URL;
