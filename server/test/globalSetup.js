// Jest globalSetup for the server suite.
//
// Server tests run against a REAL Postgres — the routes' whole job is transactions,
// unique constraints and row locks, and a mocked `pg` would assert nothing about any of
// them. What is mocked away instead is the *demo data*: tests get their own database
// (kanpos_test by default), created and migrated from scratch here, so a test run can
// never touch the catalogue or sales the shop is showing.
//
// Point TEST_DATABASE_URL at any Postgres to run this elsewhere (CI). Default is this
// fork's local container from docker-compose.yml (`npm run db:up`) — 5435/kanpos, NOT the
// inherited 5433, which on a machine hosting several of these shops is another project's
// database entirely.
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const TEST_URL = process.env.TEST_DATABASE_URL
  || 'postgres://pos:pos@localhost:5435/kanpos_test';

module.exports = async () => {
  const url = new URL(TEST_URL);
  const dbName = url.pathname.slice(1);

  // Connect to the maintenance database to (re)create the test one. Dropping first keeps
  // runs independent: no leftover rows from a previous failed run change an assertion.
  const adminUrl = new URL(TEST_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host} — start it with \`npm run db:up\`.\n${e.message}`
    );
  }

  try {
    // dbName comes from our own env var, not a request, but quote it anyway.
    const ident = `"${dbName.replace(/"/g, '""')}"`;
    await admin.query(`drop database if exists ${ident} with (force)`);
    await admin.query(`create database ${ident}`);
  } finally {
    await admin.end();
  }

  // Run the real migrations — the schema under test is the schema that ships.
  execFileSync(process.execPath, [path.join(__dirname, '..', 'migrate.js')], {
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'pipe',
  });

  // Every test file inherits this, so server/db.js pools against the test database.
  process.env.DATABASE_URL = TEST_URL;
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_SSL = 'false';
};

module.exports.TEST_URL = TEST_URL;
