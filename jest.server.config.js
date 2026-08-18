// Server-side test suite. Separate from the CRA/jsdom suite (`npm test`, src/**) because
// these run in Node against a real Postgres.
//   npm run test:server        (needs `npm run db:up`)
module.exports = {
  testEnvironment: 'node',
  rootDir: __dirname,
  testMatch: ['<rootDir>/server/test/**/*.test.js'],
  globalSetup: '<rootDir>/server/test/globalSetup.js',
  setupFiles: ['<rootDir>/server/test/setupEnv.js'],
  // The suites share one database, so they must not race each other for the same rows.
  maxWorkers: 1,
  testTimeout: 20000,
  collectCoverageFrom: [
    'server/**/*.js',
    '!server/test/**',
    '!server/migrations/**',
    '!server/seed-*.js',
  ],
};
