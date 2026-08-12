// Mounts all /api/* route groups for the Dukkan grocery POS.
//   auth      → login / session / password reset
//   orders    → sales (orders_main) + per-store invoice numbering
//   products  → grocery catalogue (barcode lookup, stock, categories) + stock log
//   accounts  → customers, admin-log, users (admin user management)
//   reports   → sales + stock reporting (reports view)
const router = require('express').Router();
const { requireSession } = require('../auth');
const orders = require('./orders');

router.use('/auth', require('./auth'));
router.use('/orders', orders.router);
router.get('/invoice/next', requireSession, orders.invoiceNext);

// Flat route groups — each declares its own full sub-paths, so they mount at the /api root.
router.use('/', require('./products'));
router.use('/', require('./categoryImages'));   // user-uploaded category tile artwork
router.use('/', require('./suppliers'));
router.use('/', require('./accounts'));
router.use('/', require('./reports'));
router.use('/', require('./timeclock'));
router.use('/', require('./ai'));
router.use('/', require('./jofotara'));   // Jordan e-invoicing (فوترة) submission

// ── Multi-store reporting module (reporting/) ─────────────────────────────────
// Mounted LAST, on purpose. The grocery reports above own the one-segment paths
// (/reports/summary, /reports/zreport, …); this module's routes are two-segment and
// store-scoped (/reports/:floor/sales), so nothing overlaps — and mounting last means that
// if a path ever did collide, the incumbent keeps it rather than being shadowed.
//
// The session middleware is attached at '/reports' rather than '/', so it can only ever
// affect report paths. Attaching it at '/' would turn every unmatched /api/* request into a
// 401 instead of the 404 the error handler returns today.
//
// The module enforces its own two grants internally (reports / reports:edit, admins bypass);
// requireSession here only populates req.user for it to read.
router.use('/reports', requireSession);
router.use('/', require('../../reporting/api').createReportingRouter(
  require('../../reporting/pgRepo').createPgRepo(require('../db'))
));

module.exports = router;
