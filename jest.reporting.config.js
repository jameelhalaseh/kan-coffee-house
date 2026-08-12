// Reporting module test suite. Pure logic + an in-memory express router — no Postgres, so
// it runs anywhere `npm ci` has run:  npm run test:reporting
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/reporting/test/**/*.test.js'],
  // pg.test.js needs a live Postgres and has its own config/globalSetup.
  testPathIgnorePatterns: ['<rootDir>/reporting/test/pg.test.js'],
  collectCoverageFrom: ['reporting/**/*.js', '!reporting/test/**'],
};
