// Public entry point for the reporting module.
//
//   const { mountReporting } = require('./reporting');
//   mountReporting(app, { db: require('./server/db'), authenticate: mySessionMiddleware });
//
// `authenticate` must put the caller on req.user as { username, admin?, views: [...] }.
// It is REQUIRED: without it every route would see req.user undefined and answer 401, which
// looks like a config error rather than what it is — an unauthenticated mount. The grants
// themselves (§7) are enforced inside the router regardless of what the UI shows.
const { createReportingRouter } = require('./api');
const { createPgRepo } = require('./pgRepo');

function mountReporting(app, { db, authenticate, base = '/api' } = {}) {
  if (!db) throw new Error('mountReporting: db is required');
  if (typeof authenticate !== 'function') {
    throw new Error('mountReporting: an authenticate middleware is required');
  }
  const repo = createPgRepo(db);
  app.use(base, authenticate, createReportingRouter(repo));
  return repo;
}

module.exports = {
  mountReporting,
  createReportingRouter,
  createPgRepo,
  migrate: require('./migrate').migrate,
  reports: require('./reports'),
  exportSheets: require('./export'),
  money: require('./money'),
  period: require('./period'),
  stores: require('./stores'),
  access: require('./access'),
  decimal: require('./decimal'),
};
