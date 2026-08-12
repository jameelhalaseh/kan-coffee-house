// Reporting module against a real Postgres:  npm run test:reporting:pg  (needs `npm run db:up`).
// Separate from jest.reporting.config.js so the pure suite stays runnable with no database.
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/reporting/test/pg.test.js'],
  globalSetup: '<rootDir>/reporting/test/pgSetup.js',
  // One database, shared by the file's suites — they must not race each other for rows.
  maxWorkers: 1,
  testTimeout: 20000,
};
