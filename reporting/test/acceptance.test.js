// §8 — the acceptance checks that still apply, plus a test for each [QUIRK] so that "fixing"
// one fails the build rather than quietly changing a tax figure.
//
// Checks 1–3 (the checkout extraction) and 7 (the partner ledger) are GONE, and deliberately:
// this build's checkout is splitInclusiveTax() in src/lib.js, which src/lib.test.js already
// covers, and the shop has no capital partners. Reports never recompute tax — they sum the
// stored sub / tax / total, which is what the rest of this file exercises.
const zlib = require('zlib');
const express = require('express');
const request = require('supertest');

const { d } = require('../decimal');
const { roundTo, fmt } = require('../money');
const { resolvePeriod, inPeriod } = require('../period');
const R = require('../reports');
const X = require('../export');
const { writeWorkbook } = require('../xlsx');
const { createReportingRouter } = require('../api');

const ALL = resolvePeriod('all');
// A completed sale in this build: status 'paid', voided_at null.
const on = (over) => ({
  floor: 'main', status: 'paid', voided_at: null, items: [], sub: 0, tax: 0, total: 0, ...over,
});

// ── §4 — round at the edge, not per row ───────────────────────────────────────
test('4 — the TOTAL row comes from the raw sums, and may differ from the rounded cells', () => {
  // 3dp currency, so the half-cent case lives in the fourth decimal.
  const orders = [1, 2, 3].map((i) => on({
    id: `id${i}`, invoice_no: i, date: '2026-08-12', sub: '10.0005', tax: '0', total: '10.0005',
  }));
  const rep = R.salesReport(orders, 'main', ALL);

  expect(rep.totals.sub.toFixed(3)).toBe('30.002');           // r3 of the raw 30.0015

  const sumOfRoundedCells = rep.rows.reduce((acc, r) => acc.add(roundTo(r.sub, 3)), d(0));
  expect(sumOfRoundedCells.toFixed(3)).toBe('30.003');        // 10.001 x 3
  expect(rep.totals.sub.toFixed(3)).not.toBe(sumOfRoundedCells.toFixed(3));
});

test('4b — rounding is half AWAY FROM ZERO in both directions, at the store precision', () => {
  expect(roundTo('0.0005', 3).toFixed(3)).toBe('0.001');
  expect(roundTo('-0.0005', 3).toFixed(3)).toBe('-0.001');
  expect(roundTo('2.675', 2).toFixed(2)).toBe('2.68');        // the float-arithmetic classic
});

test('4c — money is formatted at the store\'s own precision, 3dp for JOD', () => {
  expect(fmt('2.241', 'main')).toBe('2.241 JOD');
  // Not 2.24: the printed invoice says 2.241, and a report that disagreed with the invoice
  // would be wrong in the only way that matters.
  expect(fmt('2.2414', 'main')).toBe('2.241 JOD');
});

// ── §5.1 — the two totals ─────────────────────────────────────────────────────
test('5 — [QUIRK] the Sales KPI and the table Grand Total are reported separately', () => {
  // No service charge in this shop, so an ordinary sale has them equal…
  const plain = [on({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '2.241', tax: '0.359', total: '2.600' })];
  const p = R.salesReport(plain, 'main', ALL);
  expect(p.totals.grandTotal.toFixed(3)).toBe('2.600');
  expect(p.kpi.totalSales.toFixed(3)).toBe('2.600');

  // …but they are still two different sums, and a row where they diverge must show both
  // rather than one silently standing in for the other.
  const odd = [on({ id: 'b', invoice_no: 2, date: '2026-08-12', sub: '10.000', tax: '1.600', total: '16.600' })];
  const o = R.salesReport(odd, 'main', ALL);
  expect(o.totals.grandTotal.toFixed(3)).toBe('11.600');
  expect(o.kpi.totalSales.toFixed(3)).toBe('16.600');
});

// ── §8.6 — P&L ties to the KPI ────────────────────────────────────────────────
test('6 — P&L Total Revenue equals the Sales KPI exactly', () => {
  const orders = [
    on({ id: 'a', invoice_no: 1, date: '2026-08-10', sub: '10.000', tax: '1.600', total: '11.600' }),
    on({ id: 'b', invoice_no: 2, date: '2026-08-11', sub: '20.000', tax: '3.200', total: '23.200' }),
    on({ id: 'c', invoice_no: 3, date: '2026-08-11', total: '99.000', voided_at: '2026-08-11T10:00:00Z' }),
  ];
  const expenses = [{ id: 1, floor: 'main', date: '2026-08-11', value: '4.800', type: 'Rent' }];
  const pl = R.profitAndLoss(orders, expenses, 'main', ALL);
  const rep = R.salesReport(orders, 'main', ALL);

  expect(pl.totalRevenue.toFixed(3)).toBe(rep.kpi.totalSales.toFixed(3));
  expect(pl.totalRevenue.toFixed(3)).toBe('34.800');          // the void is excluded entirely
  expect(pl.grossProfit.toFixed(3)).toBe('30.000');
});

test('6b — Gross Profit is cash in minus cash out: no cost of goods anywhere in it', () => {
  const orders = [on({ id: 'a', invoice_no: 1, date: '2026-08-11', total: '100.000' })];
  const pl = R.profitAndLoss(orders, [], 'main', ALL);
  expect(pl.grossProfit.toFixed(3)).toBe('100.000');          // product cost is not a factor
});

// ── §8.8 — no business-day shift in reports ───────────────────────────────────
test('8 — [QUIRK] a sale at 01:30 reports under its own calendar date', () => {
  // This is a real shape from the shop's data: invoice 155 was created 2026-08-09T22:04Z and
  // carries date 2026-08-10, because `date` is stamped in Amman local time at checkout.
  const orders = [on({ id: 'a', invoice_no: 155, date: '2026-08-10', time: '01:04:50', sub: '18.103', tax: '2.897', total: '21.000' })];
  expect(R.salesReport(orders, 'main', { from: '2026-08-10', to: '2026-08-10' }).rows).toHaveLength(1);
  expect(R.salesReport(orders, 'main', { from: '2026-08-09', to: '2026-08-09' }).rows).toHaveLength(0);
});

// ── §8.9 — scoping ────────────────────────────────────────────────────────────
test('9 — a row from an unknown floor never reaches a figure', () => {
  // One store today, but the scoping is what keeps it that way if a branch is ever added.
  const orders = [
    on({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '10', tax: '1.6', total: '11.6' }),
    on({ id: 'b', invoice_no: 2, date: '2026-08-12', floor: 'other', sub: '99', tax: '15.84', total: '114.84' }),
  ];
  const rep = R.salesReport(orders, 'main', ALL);
  expect(rep.rows).toHaveLength(1);
  expect(rep.kpi.totalSales.toFixed(3)).toBe('11.600');
});

// ── §8.10 — the API enforces the grants, not just the UI ──────────────────────
function appAs(user, repo = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api', createReportingRouter({
    orders: async () => [], expenses: async () => [], ordersOnDate: async () => [],
    expenseTypes: async () => [], createExpense: async (e) => ({ id: 1, ...e }),
    deleteExpense: async () => true, createExpenseType: async (n) => ({ id: 1, name: n }),
    deleteExpenseType: async () => true, ...repo,
  }));
  return app;
}

const NEW_EXPENSE = { type: 'Rent', value: '250.000', date: '2026-08-12', payment_method: 'cheque' };

describe('10 — access control is enforced server-side', () => {
  test('a reports-only user gets 403 from expense-create, not a hidden button', async () => {
    const res = await request(appAs({ username: 'viewer', allowed_views: ['reports'] }))
      .post('/api/reports/main/expenses').send(NEW_EXPENSE);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  test('the same user CAN read the reports', async () => {
    const res = await request(appAs({ username: 'viewer', allowed_views: ['reports'] }))
      .get('/api/reports/main/sales?period=all');
    expect(res.status).toBe(200);
  });

  test('this app\'s session shape (allowed_views) is what the grants read', async () => {
    // server/auth.js puts { username, role, allowed_views } on req.user. If the module read a
    // differently-named field, every cashier would look ungranted and every admin fine —
    // which is exactly the bug that hides until a non-admin opens the page.
    const res = await request(appAs({ username: 'cashier', allowed_views: ['sales'] }))
      .get('/api/reports/main/sales?period=all');
    expect(res.status).toBe(403);
  });

  test('reports:edit may create and delete', async () => {
    const app = appAs({ username: 'mgr', allowed_views: ['reports', 'reports:edit'] });
    expect((await request(app).post('/api/reports/main/expenses').send(NEW_EXPENSE)).status).toBe(201);
    expect((await request(app).delete('/api/reports/main/expenses/1')).status).toBe(200);
  });

  test('an admin bypasses both grants', async () => {
    const app = appAs({ username: 'root', role: 'admin', allowed_views: [] });
    expect((await request(app).get('/api/reports/main/sales?period=all')).status).toBe(200);
    expect((await request(app).post('/api/reports/main/expenses').send(NEW_EXPENSE)).status).toBe(201);
  });

  test('no session is a 401, and an unknown floor is a 404', async () => {
    expect((await request(appAs(null)).get('/api/reports/main/sales?period=all')).status).toBe(401);
    expect((await request(appAs({ role: 'admin' })).get('/api/reports/gg/sales?period=all')).status).toBe(404);
  });

  test('a half-filled custom period renders nothing and prompts', async () => {
    const res = await request(appAs({ role: 'admin' }))
      .get('/api/reports/main/sales?period=custom&from=2026-08-01');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('incomplete_period');
  });

  test('the retired restaurant reports are gone from the API', async () => {
    const app = appAs({ role: 'admin' });
    expect((await request(app).get('/api/reports/main/partners')).status).toBe(404);
    expect((await request(app).get('/api/reports/main/entrance?period=all')).status).toBe(404);
    expect((await request(app).get('/api/reports/main/export/partners?period=all')).status).toBe(404);
  });
});

// ── sales table shape ─────────────────────────────────────────────────────────
describe('sales table shape', () => {
  const orders = [
    on({ id: 'msp4oye5tn', invoice_no: null, date: '2026-08-12', items: [{ qty: 2 }, { qty: 4 }], sub: '10', tax: '1.6', total: '11.6' }),
    on({ id: 'b', invoice_no: 10, date: '2026-08-11', sub: '1', tax: '0.16', total: '1.16' }),
    on({ id: 'a', invoice_no: 2, date: '2026-08-11', sub: '1', tax: '0.16', total: '1.16' }),
  ];

  test('sorts by date, then invoice_no NUMERICALLY, then id', () => {
    expect(R.salesReport(orders, 'main', ALL).rows.map((r) => r.billNo))
      .toEqual(['2', '10', 'MSP4OY']);                        // not '10' < '2'
  });

  test('a null invoice_no falls back to the first 6 chars of the id, uppercased', () => {
    expect(R.salesReport(orders, 'main', ALL).rows[2].billNo).toBe('MSP4OY');
  });

  test('Items Sold sums quantities, not line count', () => {
    expect(R.salesReport(orders, 'main', ALL).rows[2].itemsSold.toFixed(2)).toBe('6.00');
  });

  test('a voided sale is excluded entirely — by voided_at, which is how this app cancels', () => {
    const mixed = [
      on({ id: 'a', invoice_no: 1, date: '2026-08-12', total: '10' }),
      on({ id: 'b', invoice_no: 2, date: '2026-08-12', total: '10', voided_at: '2026-08-12T09:00:00Z' }),
      on({ id: 'c', invoice_no: 3, date: '2026-08-12', total: '10', status: 'open' }),
    ];
    const rep = R.salesReport(mixed, 'main', ALL);
    expect(rep.rows).toHaveLength(1);
    expect(rep.kpi.totalSales.toFixed(3)).toBe('10.000');
  });
});

// ── expenses ──────────────────────────────────────────────────────────────────
describe('expenses', () => {
  const expenses = [
    { id: 1, floor: 'main', date: '2026-08-10', created_at: '1', value: '5.500', type: 'Rent', payment_method: 'cheque' },
    { id: 2, floor: 'main', date: '2026-08-12', created_at: '2', value: '7.250', type: 'Electricity', payment_method: 'petty_cash' },
  ];

  test('[QUIRK] the screen sorts descending and the export sorts ascending', () => {
    expect(R.expensesReport(expenses, 'main', ALL).rows.map((e) => e.id)).toEqual([2, 1]);
    expect(R.expensesReport(expenses, 'main', ALL, { ascending: true }).rows.map((e) => e.id))
      .toEqual([1, 2]);
  });

  test('payment methods get their display labels', () => {
    expect(R.expensesReport(expenses, 'main', ALL).rows.map((e) => e.paymentMethod))
      .toEqual(['Petty Cash', 'Cheque']);
  });

  test('expense types are a shared list ordered by name', () => {
    expect(R.expenseTypes([{ id: 2, name: 'Rent' }, { id: 1, name: 'Electricity' }]).map((t) => t.name))
      .toEqual(['Electricity', 'Rent']);
  });

  test('the total is summed unrounded and rounded once', () => {
    expect(R.expensesReport(expenses, 'main', ALL).totals.value.toFixed(3)).toBe('12.750');
  });
});

// ── receipts ──────────────────────────────────────────────────────────────────
describe('receipts by date', () => {
  const orders = [
    on({ id: 'a', invoice_no: 100, date: '2026-08-12', time: '20:00:11', waiter: 'Rami', total: '10' }),
    on({ id: 'b', invoice_no: 101, date: '2026-08-12', time: '23:00:02', waiter: 'Lina', total: '20', voided_at: '2026-08-12T21:00:00Z' }),
    on({ id: 'c', invoice_no: 102, date: '2026-08-12', time: '21:00:45', waiter: 'Rami', total: '30' }),
  ];

  test('sorts by time descending, shows the void, and excludes it from the day total', () => {
    const res = R.receiptsByDate(orders, 'main', '2026-08-12');
    expect(res.rows.map((o) => o.id)).toEqual(['b', 'c', 'a']);
    expect(res.rows[0].voided).toBe(true);
    expect(res.dayTotal.toFixed(3)).toBe('40.000');
  });

  test('searches by invoice, id and cashier', () => {
    const find = (q) => R.receiptsByDate(orders, 'main', '2026-08-12', q).rows.map((o) => o.id);
    expect(find('101')).toEqual(['b']);
    expect(find('rami')).toEqual(['c', 'a']);
    expect(find('c')).toEqual(['c']);
  });
});

// ── period selection ──────────────────────────────────────────────────────────
describe('period selection', () => {
  const now = new Date(2026, 7, 12);   // 12 Aug 2026, local

  test('the five presets resolve to the stated bounds and labels', () => {
    expect(resolvePeriod('today', { now })).toMatchObject({ from: '2026-08-12', to: '2026-08-12', label: '2026-08-12' });
    expect(resolvePeriod('week', { now })).toMatchObject({ from: '2026-08-05', to: '2026-08-12' });
    expect(resolvePeriod('month', { now })).toMatchObject({ from: '2026-08-01', to: '2026-08-12', label: '2026-08' });
    expect(resolvePeriod('all', { now })).toMatchObject({ from: '', to: '', label: 'All time' });
  });

  test('a custom period needs both dates', () => {
    expect(resolvePeriod('custom', { from: '2026-08-01', now }).ready).toBe(false);
    expect(resolvePeriod('custom', { from: '2026-08-01', to: '2026-08-03', now }).ready).toBe(true);
  });

  test('an empty bound is unbounded', () => {
    expect(inPeriod('1999-01-01', '', '2026-08-12')).toBe(true);
    expect(inPeriod('2030-01-01', '2026-08-12', '')).toBe(true);
  });
});

// ── export ────────────────────────────────────────────────────────────────────
describe('export', () => {
  const orders = [on({ id: 'a', invoice_no: 1, date: '2026-08-12', items: [{ qty: 3 }], sub: '2.241', tax: '0.359', total: '2.600' })];

  test('every sheet opens with the header block and the table starts at A5', () => {
    const s = X.salesSheet(orders, 'main', { from: '2026-08-12', to: '2026-08-12', label: '2026-08-12' });
    expect(s.rows[0][0]).toBe('Liquor Store');
    expect(s.rows[1][0]).toBe('Tax No: 1234567');
    expect(s.rows[2][0]).toBe('Period: 2026-08-12');
    expect(s.rows[3]).toEqual([]);
    expect(s.rows[4][0]).toBe('Bill No');
    expect(s.rows[5][0]).toBe('1');
    expect(s.rows[6][0]).toBe('TOTAL');
  });

  test('money cells are numeric and keep all three decimals', () => {
    const s = X.salesSheet(orders, 'main', ALL);
    expect(s.rows[5][3]).toEqual({ v: 2.241, t: 'n' });        // not 2.24
    expect(s.rows[5][4]).toEqual({ v: 0.359, t: 'n' });
  });

  test('the P&L sheet carries the three lines', () => {
    const rows = X.pnlSheet(orders, [{ id: 1, floor: 'main', date: '2026-08-12', value: '0.600' }], 'main', ALL).rows;
    expect(rows.slice(4).map((r) => r[0]))
      .toEqual(['Line', 'Total Revenue', 'Total Expenses', 'Gross Profit']);
    expect(rows[7][1]).toEqual({ v: 2, t: 'n' });
  });

  test('the filename carries the store, report, today and the range', () => {
    const now = new Date(2026, 7, 12);
    expect(X.exportFilename('main', 'sales', resolvePeriod('today', { now }), now))
      .toBe('main-sales-2026-08-12.xlsx');
    expect(X.exportFilename('main', 'sales', resolvePeriod('week', { now }), now))
      .toBe('main-sales-2026-08-12-2026-08-05_2026-08-12.xlsx');
  });

  test('writeWorkbook produces a real zip Excel will open', () => {
    const buf = writeWorkbook([{ name: 'Sales', rows: [['Liquor Store'], ['x', { v: 2.241, t: 'n' }]] }]);
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    const sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml');
    expect(sheet).toContain('<t xml:space="preserve">Liquor Store</t>');
    expect(sheet).toContain('<v>2.241</v>');
    expect(readZipEntry(buf, 'xl/workbook.xml')).toContain('name="Sales"');
  });
});

// Minimal ZIP reader — walks local headers, so the writer is verified against the format
// rather than against itself.
function readZipEntry(buf, wanted) {
  let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8);
    const csize = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 30, p + 30 + nameLen);
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + csize);
    if (name === wanted) return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    p = start + csize;
  }
  throw new Error(`entry not found: ${wanted}`);
}
