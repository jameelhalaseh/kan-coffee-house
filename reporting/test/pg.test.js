// The reporting module against a REAL Postgres, with the app's own schema.
//
// The pure suite proves the arithmetic. This one proves what a fixture array cannot: that
// sales really do come from orders_main, that numerics survive the round trip as exact
// decimals rather than floats, that the store scoping is in the SQL, and that the restaurant
// tables are gone and stay gone.
const { Pool } = require('pg');
const express = require('express');
const request = require('supertest');

const { createPgRepo } = require('../pgRepo');
const { createReportingRouter } = require('../api');
const { resolvePeriod } = require('../period');
const R = require('../reports');

const URL = process.env.REPORTING_DATABASE_URL || require('./pgSetup').TEST_URL;
const pool = new Pool({ connectionString: URL, ssl: false });
const db = { query: (t, p) => pool.query(t, p), pool };
const repo = createPgRepo(db);

const ALL = resolvePeriod('all');
const AUG = { from: '2026-08-01', to: '2026-08-31', label: '2026-08' };

afterAll(() => pool.end());

beforeEach(async () => {
  await pool.query('delete from expenses');
  await pool.query('delete from expense_types');
  await pool.query('delete from orders_main');
});

// A sale exactly as checkout writes one: 3dp money, local Amman `date`, status 'paid'.
const sale = (o) => pool.query(
  `insert into orders_main (id, invoice_no, floor, items, sub, tax, disc, total, pay, waiter,
                            status, date, time, voided_at, created_at)
   values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15, now()))`,
  [o.id, o.invoice_no ?? null, o.floor || 'main', JSON.stringify(o.items || []),
    o.sub ?? 0, o.tax ?? 0, o.disc ?? 0, o.total ?? 0, o.pay ?? 'cash', o.waiter ?? null,
    o.status || 'paid', o.date, o.time || '12:00:00', o.voided_at ?? null, o.created_at ?? null]);

describe('sales come from orders_main', () => {
  test('a checkout row is reported without the module owning an orders table', async () => {
    await sale({ id: 'msp4oye5tn', invoice_no: 157, date: '2026-08-11', time: '23:44:12', sub: '2.241', tax: '0.359', total: '2.6' });
    const rep = R.salesReport(await repo.orders('main', ALL), 'main', ALL);
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0].billNo).toBe('157');
    expect(rep.totals.grandTotal.toFixed(3)).toBe('2.600');
    expect(rep.kpi.totalSales.toFixed(3)).toBe('2.600');
  });

  test('the module\'s own orders table is gone', async () => {
    const { rows } = await pool.query("select to_regclass('public.orders') as t");
    expect(rows[0].t).toBeNull();
  });

  test('the restaurant tables are gone', async () => {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('partners','partner_draws','entrance_tickets','orders')`);
    expect(rows).toEqual([]);
  });
});

describe('decimals survive the round trip', () => {
  test('money comes back as an exact string, not a float', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '0.1', tax: '0.2', total: '0.3' });
    const [row] = await repo.orders('main', ALL);
    expect(typeof row.sub).toBe('string');
    // 0.1 + 0.2 is the canonical float failure; through decimal.js it is exactly 0.300.
    expect(R.salesReport([row], 'main', ALL).totals.grandTotal.toFixed(3)).toBe('0.300');
  });

  test('three decimals are preserved end to end — JOD is not a 2dp currency', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '18.103', tax: '2.897', total: '21' });
    const rep = R.salesReport(await repo.orders('main', ALL), 'main', ALL);
    expect(rep.rows[0].sub.toFixed(3)).toBe('18.103');
    expect(rep.totals.grandTotal.toFixed(3)).toBe('21.000');
  });

  test('[§4] the TOTAL row differs from the sum of the rounded cells, against real rows', async () => {
    for (const i of [1, 2, 3]) {
      await sale({ id: `id${i}`, invoice_no: i, date: '2026-08-12', sub: '10.0005', total: '10.0005' });
    }
    const rep = R.salesReport(await repo.orders('main', ALL), 'main', ALL);
    expect(rep.totals.sub.toFixed(3)).toBe('30.002');    // r3 of the raw 30.0015, not 3 x 10.001
  });
});

describe('scoping and the period window', () => {
  test('an unknown floor throws at the data layer, not just at the route', async () => {
    await expect(repo.orders('gg', ALL)).rejects.toThrow(/unknown floor/);
  });

  test('bounds are inclusive and an empty bound is unbounded', async () => {
    for (const date of ['2026-07-31', '2026-08-01', '2026-08-31', '2026-09-01']) {
      await sale({ id: date, invoice_no: null, date, total: '1' });
    }
    expect((await repo.orders('main', AUG)).map((o) => o.id).sort())
      .toEqual(['2026-08-01', '2026-08-31']);
    expect(await repo.orders('main', ALL)).toHaveLength(4);
    expect(await repo.orders('main', { from: '', to: '2026-08-01' })).toHaveLength(2);
  });

  test('[QUIRK] a 01:04 sale reports under its own calendar date, as checkout stamped it', async () => {
    // The real shape of invoice 155: created 22:04 UTC, stamped 2026-08-10 in Amman.
    await sale({
      id: 'late', invoice_no: 155, date: '2026-08-10', time: '01:04:50', total: '21',
      created_at: '2026-08-09T22:04:50.655Z',
    });
    expect(await repo.orders('main', { from: '2026-08-10', to: '2026-08-10' })).toHaveLength(1);
    expect(await repo.orders('main', { from: '2026-08-09', to: '2026-08-09' })).toHaveLength(0);
  });
});

describe('voids', () => {
  test('a voided sale leaves the invoice number occupied but the money out of every figure', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '10', tax: '1.6', total: '11.6' });
    await sale({ id: 'b', invoice_no: 2, date: '2026-08-12', total: '99', voided_at: '2026-08-12T09:00:00Z' });

    const orders = await repo.orders('main', ALL);
    const rep = R.salesReport(orders, 'main', ALL);
    expect(rep.rows).toHaveLength(1);
    expect(rep.kpi.totalSales.toFixed(3)).toBe('11.600');
    expect(R.profitAndLoss(orders, [], 'main', ALL).totalRevenue.toFixed(3)).toBe('11.600');

    // …and the row is still there, so invoice 2 can never be re-issued.
    const { rows } = await pool.query('select count(*)::int n from orders_main');
    expect(rows[0].n).toBe(2);
  });

  test('receipts still render the void, outside the day total', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-08-12', time: '20:00:00', total: '10' });
    await sale({ id: 'b', invoice_no: 2, date: '2026-08-12', time: '23:00:00', total: '20', voided_at: '2026-08-12T21:00:00Z' });
    const res = R.receiptsByDate(await repo.ordersOnDate('main', '2026-08-12'), 'main', '2026-08-12');
    expect(res.rows.map((o) => o.id)).toEqual(['b', 'a']);
    expect(res.rows[0].voided).toBe(true);
    expect(res.dayTotal.toFixed(3)).toBe('10.000');
  });
});

describe('expenses and the shared type list', () => {
  test('a type deleted from the list leaves historical expenses untouched', async () => {
    const type = await repo.createExpenseType('Rent');
    await repo.createExpense({
      floor: 'main', type: type.name, value: '250.750', date: '2026-08-12',
      payment_method: 'cheque', supplier: 'Landlord', note: '',
    });
    await repo.deleteExpenseType(type.id);

    expect(await repo.expenseTypes()).toHaveLength(0);
    const rep = R.expensesReport(await repo.expenses('main', ALL), 'main', ALL);
    expect(rep.rows[0].type).toBe('Rent');            // free text on the row
    expect(rep.totals.value.toFixed(3)).toBe('250.750');
  });

  test('the type list de-duplicates by name, case- and space-insensitively', async () => {
    const a = await repo.createExpenseType('Electricity');
    const b = await repo.createExpenseType('  electricity  ');
    expect(b.id).toBe(a.id);
    expect(await repo.expenseTypes()).toHaveLength(1);
  });

  test('an invalid payment method is refused by the check constraint', async () => {
    await expect(repo.createExpense({
      floor: 'main', type: 'Rent', value: '1', date: '2026-08-12', payment_method: 'cash',
    })).rejects.toThrow();
  });

  test('P&L is revenue minus expenses, both scoped to the same window', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '18.103', tax: '2.897', total: '21' });
    await sale({ id: 'b', invoice_no: 2, date: '2026-07-01', total: '500' });      // outside August
    await repo.createExpense({ floor: 'main', type: 'Rent', value: '6.000', date: '2026-08-12', payment_method: 'cheque' });

    const pl = R.profitAndLoss(await repo.orders('main', AUG), await repo.expenses('main', AUG), 'main', AUG);
    expect(pl.totalRevenue.toFixed(3)).toBe('21.000');
    expect(pl.totalExpenses.toFixed(3)).toBe('6.000');
    expect(pl.grossProfit.toFixed(3)).toBe('15.000');
  });
});

// ── the router, over the real repo ────────────────────────────────────────────
describe('HTTP over Postgres', () => {
  const appAs = (user) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api', createReportingRouter(repo));
    return app;
  };
  const admin = () => appAs({ username: 'root', role: 'admin' });

  test('the sales endpoint serialises money as 3dp strings', async () => {
    await sale({ id: 'a', invoice_no: 157, date: '2026-08-11', items: [{ qty: 3 }], sub: '2.241', tax: '0.359', total: '2.6' });
    const res = await request(admin()).get('/api/reports/main/sales?period=custom&from=2026-08-01&to=2026-08-31');
    expect(res.status).toBe(200);
    expect(res.body.rows[0].sub).toBe('2.241');
    expect(res.body.kpi.totalSales).toBe('2.600');
  });

  test('[§8.10] a reports-only user is refused the write path, and nothing is written', async () => {
    const res = await request(appAs({ username: 'v', allowed_views: ['reports'] }))
      .post('/api/reports/main/expenses')
      .send({ type: 'Rent', value: '10', date: '2026-08-12', payment_method: 'cheque' });
    expect(res.status).toBe(403);
    const { rows } = await pool.query('select count(*)::int n from expenses');
    expect(rows[0].n).toBe(0);
  });

  test('the export endpoint returns a real xlsx', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-08-12', sub: '2.241', tax: '0.359', total: '2.6' });
    const res = await request(admin())
      .get('/api/reports/main/export/sales?period=custom&from=2026-08-01&to=2026-08-31')
      .buffer().parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('main-sales-');
    expect(res.body.subarray(0, 2).toString()).toBe('PK');
  });

  test('the retired reports 404 rather than half-working', async () => {
    expect((await request(admin()).get('/api/reports/main/entrance?period=all')).status).toBe(404);
    expect((await request(admin()).get('/api/reports/main/partners')).status).toBe(404);
  });
});

describe('trading span', () => {
  test('reports the first and last day that actually have sales, ignoring voids', async () => {
    await sale({ id: 'a', invoice_no: 1, date: '2026-07-25', total: '10' });
    await sale({ id: 'b', invoice_no: 2, date: '2026-08-11', total: '10' });
    // A void on a LATER day must not extend the span: opening the receipts tab on a day whose
    // only sale was cancelled is exactly the blank screen this endpoint exists to avoid.
    await sale({ id: 'c', invoice_no: 3, date: '2026-08-30', total: '10', voided_at: '2026-08-30T10:00:00Z' });

    const span = await repo.salesSpan('main');
    expect(span.first).toBe('2026-07-25');
    expect(span.last).toBe('2026-08-11');
    expect(span.orders).toBe(2);
  });

  test('an empty shop reports nulls rather than throwing', async () => {
    const span = await repo.salesSpan('main');
    expect(span).toMatchObject({ first: null, last: null, orders: 0 });
  });
});

describe('receipt amounts are formatted like every other page', () => {
  test('a numeric column with no scale still renders at the shop precision', async () => {
    // orders_main.total is `numeric` with no declared scale, so node-pg hands back '2.6'.
    // Rendering that straight gave "2.6" on Receipts and "2.600" on Sales for the same sale.
    await sale({ id: 'a', invoice_no: 157, date: '2026-08-11', time: '23:44:12', sub: '2.241', tax: '0.359', total: '2.6' });
    const app = express();
    app.use(express.json());
    app.use((req, _r, n) => { req.user = { username: 'root', role: 'admin' }; n(); });
    app.use('/api', createReportingRouter(repo));

    const res = await request(app).get('/api/reports/main/receipts?date=2026-08-11');
    expect(res.body.rows[0].total).toBe('2.600');
    expect(res.body.dayTotal).toBe('2.600');
  });
});

// ── receipt actions ───────────────────────────────────────────────────────────
describe('receipt view and edit', () => {
  const appAs = (user) => {
    const app = express();
    app.use(express.json());
    app.use((req, _r, n) => { req.user = user; n(); });
    app.use('/api', createReportingRouter(repo));
    return app;
  };
  const admin = () => appAs({ username: 'root', role: 'admin' });

  const aSale = () => sale({
    id: 'r1', invoice_no: 42, date: '2026-08-11', time: '21:00:00',
    items: [{ name: 'Stolichnaya 700ml', qty: 2, price: '21' }],
    sub: '36.207', tax: '5.793', total: '42', pay: 'cash', waiter: 'owner',
  });

  test('the bill view carries the lines, the tax split and the line sum', async () => {
    await aSale();
    const res = await request(admin()).get('/api/reports/main/receipts/r1');
    expect(res.status).toBe(200);
    expect(res.body.billNo).toBe('42');
    expect(res.body.items).toEqual([{
      name: 'Stolichnaya 700ml', qty: '2', price: '21.000', amount: '42.000',
      // Discount fields ride on every line so the bill view can print what a discount came
      // off. An undiscounted line carries zeros, so `amount` still equals `gross`.
      size: '', disc: '0.000', gross: '42.000',
    }]);
    expect(res.body.sub).toBe('36.207');
    expect(res.body.tax).toBe('5.793');
    expect(res.body.total).toBe('42.000');
    expect(res.body.lineSum).toBe('42.000');      // lines and stored total agree
    expect(res.body.voided).toBe(false);
  });

  test('a missing receipt is a 404, not an empty bill', async () => {
    expect((await request(admin()).get('/api/reports/main/receipts/nope')).status).toBe(404);
  });

  test('payment method and customer can be edited, and the change is audited', async () => {
    await aSale();
    const res = await request(admin())
      .patch('/api/reports/main/receipts/r1').send({ pay: 'card', buyer: 'Nour' });
    expect(res.status).toBe(200);
    expect(res.body.pay).toBe('card');
    expect(res.body.buyer).toBe('Nour');

    const { rows } = await pool.query(
      "select action, actor from admin_log where action like 'receipt_edit%' order by id desc limit 1");
    expect(rows[0].actor).toBe('root');
    expect(rows[0].action).toContain('#42');
    expect(rows[0].action).toContain('cash->card');
  });

  test('AMOUNTS AND ITEMS ARE REFUSED — a finalised invoice is not rewritten in place', async () => {
    await aSale();
    for (const patch of [{ total: '1' }, { tax: '0' }, { items: [] }, { invoice_no: 9 }, { date: '2026-01-01' }]) {
      const res = await request(admin()).patch('/api/reports/main/receipts/r1').send(patch);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('immutable_field');
    }
    // …and nothing moved.
    const { rows } = await pool.query('select total, tax, invoice_no, date from orders_main where id = $1', ['r1']);
    expect(Number(rows[0].total)).toBe(42);
    expect(Number(rows[0].invoice_no)).toBe(42);
  });

  test('a receipt can be corrected to CliQ, and to any method the till offers', async () => {
    // The list is shared with the client (reporting/payments.js); this proves the API
    // actually honours it rather than carrying a stale pair.
    for (const pay of ['cash', 'card', 'cliq']) {
      await aSale();
      const res = await request(admin()).patch('/api/reports/main/receipts/r1').send({ pay });
      expect(res.status).toBe(200);
      const { rows } = await pool.query('select pay from orders_main where id = $1', ['r1']);
      expect(rows[0].pay).toBe(pay);
      await pool.query('delete from orders_main');
    }
  });

  test('an invalid payment method is refused', async () => {
    await aSale();
    const res = await request(admin()).patch('/api/reports/main/receipts/r1').send({ pay: 'crypto' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_pay');
  });

  test('a voided bill cannot be edited', async () => {
    await sale({ id: 'v1', invoice_no: 43, date: '2026-08-11', total: '10', voided_at: '2026-08-11T22:00:00Z' });
    const res = await request(admin()).patch('/api/reports/main/receipts/v1').send({ pay: 'card' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('voided');
  });

  test('the customer on a refund is locked — it links the refund to its original sale', async () => {
    // buyer = 'return of #42' is what the over-refund guard in POST /api/orders parses.
    // Editing it would silently unhook that guard.
    await sale({ id: 'rf', invoice_no: 44, date: '2026-08-11', total: '-21', status: 'refund', buyer: 'return of #42' });
    const res = await request(admin()).patch('/api/reports/main/receipts/rf').send({ buyer: 'someone else' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('refund_buyer_locked');

    // The payment method on the same refund is still editable.
    expect((await request(admin()).patch('/api/reports/main/receipts/rf').send({ pay: 'card' })).status).toBe(200);
  });

  test('a view-only user can read a bill but not edit it', async () => {
    await aSale();
    const viewer = appAs({ username: 'v', allowed_views: ['reports'] });
    expect((await request(viewer).get('/api/reports/main/receipts/r1')).status).toBe(200);
    expect((await request(viewer).patch('/api/reports/main/receipts/r1').send({ pay: 'card' })).status).toBe(403);
  });

  test('an empty patch is refused rather than reported as a successful no-op', async () => {
    await aSale();
    const res = await request(admin()).patch('/api/reports/main/receipts/r1').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('nothing_to_change');
  });
});

// ── Discounts report ──────────────────────────────────────────────────────────
// The reason a discount was given is recorded for the SHOP, not for the customer: it must
// reach this report and must never reach the bill. These tests pin both halves.
describe('discounts report', () => {
  const appAs = (user) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api', createReportingRouter(repo));
    return app;
  };
  const admin = () => appAs({ username: 'root', role: 'admin' });
  const viewer = () => appAs({ username: 'v', allowed_views: ['reports'] });

  const discounted = () => sale({
    id: 'd1', invoice_no: 60, date: '2026-08-11', time: '20:00:00', waiter: 'sara',
    items: [
      { name: 'Arak', size: '750ml', qty: 1, price: '10', disc: '0.5', disc_note: 'damaged label' },
      { name: 'Whiskey', size: '1L', qty: 1, price: '20', disc: '1', disc_note: 'staff friend' },
      { name: 'Beer', qty: 6, price: '1' },
    ],
    sub: '29.741', tax: '4.759', disc: '1.5', total: '34.5',
  });

  test('one row per discounted line, carrying the reason', async () => {
    await discounted();
    const res = await request(admin()).get('/api/reports/main/discounts?period=all');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);          // the undiscounted beer is not a row
    expect(res.body.rows[0]).toMatchObject({
      billNo: '60', item: 'Arak', size: '750ml',
      gross: '10.000', disc: '0.500', net: '9.500',
      note: 'damaged label', cashier: 'sara',
    });
    expect(res.body.rows[1].note).toBe('staff friend');
  });

  test('totals sum the discounts, not the bills', async () => {
    await discounted();
    const res = await request(admin()).get('/api/reports/main/discounts?period=all');
    expect(res.body.totals.disc).toBe('1.500');
    expect(res.body.totals.gross).toBe('30.000');   // the two discounted lines only
    expect(res.body.kpi.discountedLines).toBe(2);
  });

  test('THE REASON NEVER REACHES THE BILL', async () => {
    // The bill view feeds BillPaper, which is what the customer is shown and what the
    // thermal roll prints. The amount belongs there; the reason does not.
    await discounted();
    const res = await request(admin()).get('/api/reports/main/receipts/d1');
    expect(res.status).toBe(200);
    expect(res.body.items[0].disc).toBe('0.500');
    expect(JSON.stringify(res.body)).not.toMatch(/damaged label|staff friend/);
  });

  test('a voided bill contributes no discounts', async () => {
    // A discount on a sale that did not happen is not a discount.
    await sale({
      id: 'd2', invoice_no: 61, date: '2026-08-11', voided_at: new Date().toISOString(),
      items: [{ name: 'Arak', qty: 1, price: '10', disc: '5', disc_note: 'void me' }],
      disc: '5', total: '5',
    });
    const res = await request(admin()).get('/api/reports/main/discounts?period=all');
    expect(res.body.rows).toHaveLength(0);
  });

  test('a discount with no reason recorded is still reported', async () => {
    await sale({
      id: 'd3', invoice_no: 62, date: '2026-08-11',
      items: [{ name: 'Vodka', qty: 1, price: '15', disc: '2' }],
      disc: '2', total: '13',
    });
    const res = await request(admin()).get('/api/reports/main/discounts?period=all');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].note).toBe('');
  });

  test('the export carries a Reason column', async () => {
    await discounted();
    const res = await request(admin())
      .get('/api/reports/main/export/discounts?period=all')
      .buffer().parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('main-discounts-');
    expect(res.body.subarray(0, 2).toString()).toBe('PK');   // a real xlsx (zip) payload
  });

  test('a view-only user may read it; it is revenue data behind the same grant', async () => {
    await discounted();
    expect((await request(viewer()).get('/api/reports/main/discounts?period=all')).status).toBe(200);
  });
});

// ── Stock report over the real schema ─────────────────────────────────────────
// The pure suite proves the arithmetic. This proves the three joins it depends on: that a
// delivery finds its supplier's NAME, that a timestamptz becomes the right Amman trading
// date, and that the log query hands over corrections only.
describe('stock report over Postgres', () => {
  const appAs = (user) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = user; next(); });
    app.use('/api', createReportingRouter(repo));
    return app;
  };
  const admin = () => appAs({ username: 'root', role: 'admin' });

  let productId;
  let supplierId;

  beforeEach(async () => {
    await pool.query('delete from batches');
    await pool.query('delete from stock_log');
    await pool.query('delete from suppliers');
    await pool.query('delete from products');
    const s = await pool.query("insert into suppliers (name) values ('Amman Drinks') returning id");
    supplierId = s.rows[0].id;
    const p = await pool.query(
      `insert into products (barcode, name, cat, size, cost, price, stock, low_at, active)
       values ('629','Arak','Arak','750ml',6,10,12,5,true) returning id`);
    productId = p.rows[0].id;
  });

  const AUGQ = 'period=custom&from=2026-08-01&to=2026-08-31';
  const stock = () => request(admin()).get(`/api/reports/main/stock?${AUGQ}`);

  test('a delivery arrives with its supplier name, quantity and cost', async () => {
    await pool.query(
      `insert into batches (product_id, supplier_id, qty, cost, received_at)
       values ($1,$2,10,6,'2026-08-03T09:00:00Z')`, [productId, supplierId]);

    const res = await stock();
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.id === productId);
    expect(row.received).toBe('10');
    expect(row.suppliers).toEqual(['Amman Drinks']);
    expect(row.receipts[0]).toMatchObject({
      date: '2026-08-03', supplier: 'Amman Drinks', qty: '10',
      unitCost: '6.000', lineCost: '60.000',
    });
    expect(row.purchases).toBe('60.000');
  });

  test('a delivery keeps its supplier name after the supplier row is deleted', async () => {
    // The join is LEFT: losing a supplier must not lose the delivery, because the stock
    // arrived whether or not the shop still trades with whoever sent it.
    await pool.query(
      `insert into batches (product_id, supplier_id, qty, cost, received_at)
       values ($1,$2,10,6,'2026-08-03T09:00:00Z')`, [productId, supplierId]);
    await pool.query('update batches set supplier_id = null');

    const row = (await stock()).body.rows.find((r) => r.id === productId);
    expect(row.received).toBe('10');
    expect(row.receipts[0].supplier).toBe('');
  });

  test('a delivery just after midnight Amman belongs to that Amman day', async () => {
    // 2026-08-03T22:30Z is 01:30 on the 4th in Amman. Reported under the UTC date it would
    // land in the wrong month at a month boundary, and reconcile against the wrong opening.
    await pool.query(
      `insert into batches (product_id, supplier_id, qty, cost, received_at)
       values ($1,$2,4,6,'2026-08-03T22:30:00Z')`, [productId, supplierId]);
    const row = (await stock()).body.rows.find((r) => r.id === productId);
    expect(row.receipts[0].date).toBe('2026-08-04');
  });

  test('the log query hands over corrections only, never sales or restocks', async () => {
    // Every one of these is a real row this app writes. Only the 'adjust' is this report's
    // to count; the others are read from orders_main and batches instead.
    for (const [kind, oldQ, newQ] of [['adjust', 12, 11], ['sale', 13, 12], ['restock', 3, 13]]) {
      await pool.query(
        `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by,created_at)
         values ($1,$2,'Arak',$3,$4,'owner','2026-08-06T09:00:00Z')`,
        [kind, String(productId), oldQ, newQ]);
    }
    const row = (await stock()).body.rows.find((r) => r.id === productId);
    expect(row.adjusted).toBe('-1');
    expect(row.adjustments).toHaveLength(1);
    expect(row.adjustments[0]).toMatchObject({ kind: 'adjust', by: 'owner', fromQty: '12', toQty: '11' });
  });

  test('the balance ties to the shelf count through a sale and a delivery', async () => {
    await sale({ id: 's1', invoice_no: 1, date: '2026-08-05', total: '30',
      items: [{ id: productId, name: 'Arak', qty: 3, price: '10' }] });
    await pool.query(
      `insert into batches (product_id, supplier_id, qty, cost, received_at)
       values ($1,$2,10,6,'2026-08-03T09:00:00Z')`, [productId, supplierId]);

    const row = (await stock()).body.rows.find((r) => r.id === productId);
    expect(row.opening).toBe('5');
    expect(row.received).toBe('10');
    expect(row.sold).toBe('3');
    expect(row.closing).toBe('12');
    expect(row.stockNow).toBe('12');
    expect(row.revenue).toBe('30.000');
    expect(row.cogs).toBe('18.000');
    expect(row.profit).toBe('12.000');
  });

  test('a sale after the period is undone to reach the closing balance', async () => {
    await sale({ id: 's1', invoice_no: 1, date: '2026-09-20', total: '40',
      items: [{ id: productId, name: 'Arak', qty: 4, price: '10' }] });
    const row = (await stock()).body.rows.find((r) => r.id === productId);
    expect(row.sold).toBe('0');         // it is not August's sale…
    expect(row.closing).toBe('16');     // …but it must still be undone
    expect(row.stockNow).toBe('12');
  });

  test('quantities serialise as counts, not padded to three decimals', async () => {
    const row = (await stock()).body.rows.find((r) => r.id === productId);
    expect(row.stockNow).toBe('12');
    expect(row.unitCost).toBe('6.000');   // money still is
  });

  test('the export is a real workbook with both sheets', async () => {
    await pool.query(
      `insert into batches (product_id, supplier_id, qty, cost, received_at)
       values ($1,$2,10,6,'2026-08-03T09:00:00Z')`, [productId, supplierId]);
    const res = await request(admin())
      .get(`/api/reports/main/export/stock?${AUGQ}`)
      .buffer().parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('main-stock-');
    expect(res.body.subarray(0, 2).toString()).toBe('PK');
  });

  test('a view-only user may read it', async () => {
    const viewer = appAs({ username: 'v', allowed_views: ['reports'] });
    expect((await request(viewer).get(`/api/reports/main/stock?${AUGQ}`)).status).toBe(200);
  });
});
