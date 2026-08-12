// HTTP surface for the reporting module.
//
// The router takes its data through an injected `repo`, so the same code runs against
// Postgres in production and against arrays in the acceptance tests. Nothing in here builds
// SQL; nothing in reports.js knows HTTP.
//
// Every route is scoped to ONE store, taken from :floor and validated against the registry.
// There is no "all stores" route, because §1 forbids aggregating across stores in a single
// figure and the cheapest way to guarantee that is to give the API no way to express it.
const express = require('express');
const { store, FLOORS } = require('./stores');
const { resolvePeriod } = require('./period');
const R = require('./reports');
const { serialize } = require('./money');
const X = require('./export');
const {
  requireSession, requireReportsView, requireReportsEdit,
} = require('./access');

const fail = (res, code, status = 400) => res.status(status).json({ error: code });

// Round every amount ONCE, at the store's precision, on the way out (§4). Amounts leave as
// fixed-precision strings so the browser never re-parses them into floats.
const send = (floor, payload) => serialize(payload, store(floor).dp);

// Resolve :floor and ?period=&from=&to= once, for every report route.
function scopeOf(req, res) {
  if (!FLOORS.includes(req.params.floor)) { fail(res, 'unknown_floor', 404); return null; }
  const period = resolvePeriod(req.query.period || 'today', {
    from: req.query.from || '', to: req.query.to || '',
  });
  // A custom period with one date filled renders nothing and prompts (§3) — the API says so
  // rather than quietly widening the window to everything.
  if (!period.ready) { res.status(400).json({ error: 'incomplete_period', prompt: period.prompt }); return null; }
  return { floor: req.params.floor, period };
}

function createReportingRouter(repo) {
  const router = express.Router();
  const view = [requireSession, requireReportsView];
  const edit = [requireSession, requireReportsEdit];

  // ── Reports (view grant) ────────────────────────────────────────────────────
  router.get('/reports/:floor/sales', ...view, async (req, res, next) => {
    try {
      const s = scopeOf(req, res); if (!s) return;
      res.json(send(s.floor, R.salesReport(await repo.orders(s.floor, s.period), s.floor, s.period)));
    } catch (e) { next(e); }
  });

  router.get('/reports/:floor/expenses', ...view, async (req, res, next) => {
    try {
      const s = scopeOf(req, res); if (!s) return;
      // Screen order: DESCENDING. The export asks for ascending separately (§5.2 quirk).
      res.json(send(s.floor, R.expensesReport(await repo.expenses(s.floor, s.period), s.floor, s.period)));
    } catch (e) { next(e); }
  });

  router.get('/reports/:floor/pnl', ...view, async (req, res, next) => {
    try {
      const s = scopeOf(req, res); if (!s) return;
      res.json(send(s.floor, R.profitAndLoss(
        await repo.orders(s.floor, s.period), await repo.expenses(s.floor, s.period),
        s.floor, s.period)));
    } catch (e) { next(e); }
  });

  // The shop's trading span: { first, last, orders }. The client asks for this once, so an
  // empty report can say "no sales on 12 Aug — the last was 11 Aug" instead of showing a page
  // of zeros that is indistinguishable from a broken page.
  router.get('/reports/:floor/span', ...view, async (req, res, next) => {
    try {
      if (!FLOORS.includes(req.params.floor)) return fail(res, 'unknown_floor', 404);
      res.json(await repo.salesSpan(req.params.floor));
    } catch (e) { next(e); }
  });

  // Live per-day receipt lookup — one exact date, not a window.
  router.get('/reports/:floor/receipts', ...view, async (req, res, next) => {
    try {
      if (!FLOORS.includes(req.params.floor)) return fail(res, 'unknown_floor', 404);
      const date = String(req.query.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, 'invalid_date', 400);
      res.json(send(req.params.floor, R.receiptsByDate(
        await repo.ordersOnDate(req.params.floor, date), req.params.floor, date, req.query.q || '')));
    } catch (e) { next(e); }
  });

  // One receipt, re-read from the database for the View / Edit dialog.
  router.get('/reports/:floor/receipts/:id', ...view, async (req, res, next) => {
    try {
      if (!FLOORS.includes(req.params.floor)) return fail(res, 'unknown_floor', 404);
      const row = await repo.order(req.params.floor, req.params.id);
      if (!row) return fail(res, 'not_found', 404);
      res.json(send(req.params.floor, R.receiptView(row)));
    } catch (e) { next(e); }
  });

  // PATCH a receipt's METADATA — payment method and customer only.
  //
  // Amounts, items, the invoice number and the date are not editable here, and an attempt to
  // send them is REFUSED rather than quietly ignored: a caller that believes it corrected a
  // total, and got a 200 back, is worse off than one that got an error. Correcting a mis-rung
  // sale is a void plus a re-ring — that path already returns the stock and keeps both rows
  // in the invoice sequence.
  const IMMUTABLE = ['items', 'sub', 'tax', 'svc', 'disc', 'disc_pct', 'total', 'invoice_no',
    'date', 'time', 'status', 'floor', 'id'];

  router.patch('/reports/:floor/receipts/:id', ...edit, async (req, res, next) => {
    try {
      if (!FLOORS.includes(req.params.floor)) return fail(res, 'unknown_floor', 404);
      const b = req.body || {};

      const attempted = IMMUTABLE.filter((k) => b[k] !== undefined);
      if (attempted.length) {
        return res.status(400).json({ error: 'immutable_field', fields: attempted });
      }
      if (b.pay !== undefined && !['cash', 'card'].includes(String(b.pay))) {
        return fail(res, 'invalid_pay', 400);
      }
      if (b.buyer !== undefined && String(b.buyer).length > 120) return fail(res, 'invalid', 400);
      if (b.pay === undefined && b.buyer === undefined) return fail(res, 'nothing_to_change', 400);

      const out = await repo.updateOrderMeta(req.params.floor, req.params.id, {
        pay: b.pay,
        buyer: b.buyer === undefined ? undefined : String(b.buyer).trim(),
      }, req.user && req.user.username);

      if (out.error === 'not_found') return fail(res, 'not_found', 404);
      // A voided sale is closed. Saying so beats a 200 that changed nothing.
      if (out.error === 'voided') return fail(res, 'voided', 409);
      if (out.error === 'refund_buyer_locked') return fail(res, 'refund_buyer_locked', 409);
      res.json(send(req.params.floor, R.receiptView(out.order)));
    } catch (e) { next(e); }
  });

  // ── Export (view grant — reading a report in Excel is still reading it) ──────
  router.get('/reports/:floor/export/:report', ...view, async (req, res, next) => {
    try {
      const s = scopeOf(req, res); if (!s) return;
      const { floor, period } = s;
      let sheets;
      switch (req.params.report) {
        case 'sales':
          sheets = [X.salesSheet(await repo.orders(floor, period), floor, period)]; break;
        case 'expenses':
          sheets = [X.expensesSheet(await repo.expenses(floor, period), floor, period)]; break;
        case 'pnl':
          sheets = [X.pnlSheet(await repo.orders(floor, period),
            await repo.expenses(floor, period), floor, period)]; break;
        default: return fail(res, 'unknown_report', 404);
      }
      const filename = X.exportFilename(floor, req.params.report, period);
      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(X.workbook(sheets));
    } catch (e) { next(e); }
  });

  // ── Mutations (edit grant) ──────────────────────────────────────────────────
  router.post('/reports/:floor/expenses', ...edit, async (req, res, next) => {
    try {
      if (!FLOORS.includes(req.params.floor)) return fail(res, 'unknown_floor', 404);
      const b = req.body || {};
      if (!b.type || b.value === undefined || b.value === null || !b.date) {
        return fail(res, 'invalid', 400);
      }
      if (!['cheque', 'petty_cash'].includes(b.payment_method)) return fail(res, 'invalid', 400);
      const row = await repo.createExpense({
        floor: req.params.floor,
        // The type is stored as free TEXT, not a foreign key: deleting a type from the shared
        // list must never rewrite or orphan a historical expense (§5.2).
        type: String(b.type),
        value: b.value,
        supplier: b.supplier || '',
        date: String(b.date),
        payment_method: b.payment_method,
        note: b.note || '',
      });
      res.status(201).json(row);
    } catch (e) { next(e); }
  });

  router.delete('/reports/:floor/expenses/:id', ...edit, async (req, res, next) => {
    try { await repo.deleteExpense(req.params.floor, req.params.id); res.json({ ok: true }); }
    catch (e) { next(e); }
  });

  // Expense types are a SHARED global list — deliberately not floor-scoped.
  router.get('/reports/expense-types', ...view, async (req, res, next) => {
    try { res.json(R.expenseTypes(await repo.expenseTypes())); } catch (e) { next(e); }
  });
  router.post('/reports/expense-types', ...edit, async (req, res, next) => {
    try {
      const name = String((req.body || {}).name || '').trim();
      if (!name) return fail(res, 'invalid', 400);
      res.status(201).json(await repo.createExpenseType(name));
    } catch (e) { next(e); }
  });
  router.delete('/reports/expense-types/:id', ...edit, async (req, res, next) => {
    try { await repo.deleteExpenseType(req.params.id); res.json({ ok: true }); }
    catch (e) { next(e); }
  });

  return router;
}

module.exports = { createReportingRouter, store };
