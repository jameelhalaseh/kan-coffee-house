// /api/jofotara/* — send a recorded sale to Jordan's national e-invoicing system.
//
// Gated to `history` (the view that lists invoices); admins bypass. Credentials never leave
// the server — the browser only ever sees a status, a UUID and the QR payload.
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireView } = require('../auth');
const { fail } = require('../validate');
const { FLOORS, ordersTable, DEFAULT_FLOOR } = require('../floors');
const jofotara = require('../jofotara');

// `history` was in this gate until the audit of 12 Aug, and the standard cashier holds it.
// Submitting to the ISTD is an outbound legal filing on the business's behalf, so it belongs
// with whoever owns the tax position — the `reports` grant, or an admin.
const gate = [requireSession, requireView('reports')];

// GET /api/jofotara/status → is the integration wired up on this deployment?
// The UI uses this to enable/disable the button instead of guessing.
router.get('/jofotara/status', requireSession, (_req, res) => {
  const cfg = jofotara.CFG();
  res.json({ configured: jofotara.isConfigured(), taxpayer_type: cfg.taxpayerType });
});

// POST /api/jofotara/send/:id  { floor? } → submit that sale, persist the outcome.
// Idempotent: a sale already accepted by ISTD is returned as-is rather than re-submitted,
// so a double-tap can never file the same invoice twice.
router.post('/jofotara/send/:id', ...gate, async (req, res, next) => {
  const floor = req.body && req.body.floor ? req.body.floor : DEFAULT_FLOOR;
  const t = ordersTable(floor);
  if (!t) return fail(res, 'invalid_floor', 400);
  if (!jofotara.isConfigured()) return fail(res, 'not_configured', 503);

  try {
    const { rows } = await db.query(`select * from ${t} where id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return fail(res, 'not_found', 404);
    if (order.jofotara_status === 'sent') {
      return res.json({ ok: true, already: true, uuid: order.jofotara_uuid, qr: order.jofotara_qr });
    }

    await db.query(`update ${t} set jofotara_status = 'sending' where id = $1`, [order.id]);
    const out = await jofotara.submitInvoice(order);

    if (!out.ok) {
      await db.query(
        `update ${t} set jofotara_status = 'failed', jofotara_uuid = coalesce($2, jofotara_uuid),
                         jofotara_error = $3 where id = $1`,
        [order.id, out.uuid || null, out.error]
      );
      // 502: we reached our own server fine; the authority is what refused.
      return res.status(502).json({ error: 'jofotara_rejected', detail: out.error });
    }

    await db.query(
      `update ${t} set jofotara_status = 'sent', jofotara_uuid = $2, jofotara_qr = $3,
                       jofotara_error = null, jofotara_sent_at = now() where id = $1`,
      [order.id, out.uuid, out.qr]
    );
    res.json({ ok: true, uuid: out.uuid, qr: out.qr });
  } catch (e) { next(e); }
});

// GET /api/jofotara/pending → sales not yet accepted, oldest first (the accountant's queue).
router.get('/jofotara/pending', ...gate, async (_req, res, next) => {
  try {
    const union = FLOORS.map((f) => `select id, invoice_no, date, total, jofotara_status, jofotara_error from ${ordersTable(f)}`).join(' union all ');
    const { rows } = await db.query(
      `select * from ( ${union} ) o
        where jofotara_status is distinct from 'sent'
        order by date asc, invoice_no asc limit 500`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
