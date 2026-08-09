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
router.use('/', require('./suppliers'));
router.use('/', require('./accounts'));
router.use('/', require('./reports'));
router.use('/', require('./timeclock'));
router.use('/', require('./ai'));
router.use('/', require('./jofotara'));   // Jordan e-invoicing (فوترة) submission

module.exports = router;
