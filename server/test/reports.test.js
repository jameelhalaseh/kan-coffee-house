// /api/reports/* — the figures the owner closes the till against.
//
// Two things matter here and both are easy to get silently wrong: voided sales must never
// count as revenue, and a limited cashier must not be able to read the aggregates at all.
const request = require('supertest');
const {
  seedUsers, login, auth, clearCatalogue, clearOrders, makeProduct, app, db,
} = require('./helpers');

let adminToken;
let cashierToken;
let reporterToken;

beforeAll(async () => {
  await seedUsers();
  // Give the third fixture the reports view — the role that legitimately reads these.
  await db.query("update app_users set allowed_views = '{sales,reports}' where username = 'test_stockist'");
  adminToken = await login('admin');
  cashierToken = await login('cashier');
  reporterToken = await login('stockist');
});

beforeEach(async () => {
  await clearOrders();
  await clearCatalogue();
});

afterAll(() => db.pool.end());

const get = (path, token) => request(app).get(path).set(...auth(token));

let n = 0;
const uid = () => `rep-${Date.now()}-${++n}`;

// Save a sale directly so the reports read committed rows without depending on the
// checkout route's own behaviour.
async function sale({ total = 10, pay = 'cash', items = [], date = '2026-03-01', invoice = null, voided = false } = {}) {
  const id = uid();
  await db.query(
    `insert into orders_main (id, items, sub, tax, total, pay, waiter, status, date, time, invoice_no, floor, created_at)
     values ($1,$2::jsonb,$3,0,$3,$4,'test_cashier',null,$5::text,'12:00:00',$6,'main',$5::date + interval '12 hours')`,
    [id, JSON.stringify(items), total, pay, date, invoice]
  );
  if (voided) {
    await db.query("update orders_main set voided_at = now(), voided_by = 'test_admin', status = 'void' where id = $1", [id]);
  }
  return id;
}

const line = (name, qty, price) => ({ id: 1, name, qty, price });

const ENDPOINTS = [
  '/api/reports/summary',
  '/api/reports/daily',
  '/api/reports/top-products',
  '/api/reports/zreport',
  '/api/reports/abc',
  '/api/reports/low-stock',
];

describe('access control', () => {
  for (const path of ENDPOINTS) {
    test(`${path} requires a session`, async () => {
      expect((await request(app).get(path)).status).toBe(401);
    });

    test(`${path} refuses a cashier holding only sales+history`, async () => {
      const res = await get(path, cashierToken);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden' });
    });

    test(`${path} allows a non-admin holding the reports view`, async () => {
      expect((await get(path, reporterToken)).status).toBe(200);
    });

    test(`${path} allows an admin with no views at all`, async () => {
      expect((await get(path, adminToken)).status).toBe(200);
    });
  }
});

describe('summary', () => {
  test('counts orders, revenue and units', async () => {
    await sale({ total: 30, items: [line('Whiskey', 2, 10), line('Gin', 1, 10)] });
    await sale({ total: 20, items: [line('Whiskey', 2, 10)] });

    const res = await get('/api/reports/summary', adminToken);
    expect(res.body.orders).toBe(2);
    expect(Number(res.body.revenue)).toBe(50);
    expect(Number(res.body.units)).toBe(5);
  });

  test('excludes voided sales from every figure', async () => {
    await sale({ total: 30, items: [line('Whiskey', 3, 10)] });
    await sale({ total: 100, items: [line('Rum', 10, 10)], voided: true });

    const res = await get('/api/reports/summary', adminToken);
    expect(res.body.orders).toBe(1);
    expect(Number(res.body.revenue)).toBe(30);
    expect(Number(res.body.units)).toBe(3);
  });

  test('returns zeroes rather than nulls on an empty window', async () => {
    const res = await get('/api/reports/summary', adminToken);
    expect(res.body.orders).toBe(0);
    expect(Number(res.body.revenue)).toBe(0);
    expect(Number(res.body.units)).toBe(0);
  });

  test('honours a from/to window', async () => {
    await sale({ total: 10, date: '2026-03-01' });
    await sale({ total: 99, date: '2026-04-15' });

    const res = await get('/api/reports/summary?from=2026-03-01&to=2026-03-31', adminToken);
    expect(Number(res.body.revenue)).toBe(10);
  });

  test('the `to` bound includes sales made on that day', async () => {
    // A half-open bound that excluded the end date would silently drop the last day of
    // every month-end report.
    await sale({ total: 42, date: '2026-03-31' });
    const res = await get('/api/reports/summary?from=2026-03-01&to=2026-03-31', adminToken);
    expect(Number(res.body.revenue)).toBe(42);
  });
});

describe('daily', () => {
  test('groups revenue by day, newest first', async () => {
    await sale({ total: 10, date: '2026-03-01' });
    await sale({ total: 15, date: '2026-03-01' });
    await sale({ total: 20, date: '2026-03-02' });

    const rows = (await get('/api/reports/daily', adminToken)).body;
    expect(rows).toHaveLength(2);
    expect(rows[0].day).toBe('2026-03-02');
    expect(Number(rows[0].revenue)).toBe(20);
    expect(rows[1].day).toBe('2026-03-01');
    expect(Number(rows[1].revenue)).toBe(25);
    expect(rows[1].orders).toBe(2);
  });

  test('omits voided sales', async () => {
    await sale({ total: 10, date: '2026-03-01' });
    await sale({ total: 500, date: '2026-03-01', voided: true });
    const rows = (await get('/api/reports/daily', adminToken)).body;
    expect(Number(rows[0].revenue)).toBe(10);
  });

  test('returns an empty array when there are no sales', async () => {
    expect((await get('/api/reports/daily', adminToken)).body).toEqual([]);
  });
});

describe('top products', () => {
  test('ranks by units sold', async () => {
    await sale({ total: 50, items: [line('Vodka', 5, 10)] });
    await sale({ total: 20, items: [line('Gin', 2, 10)] });
    await sale({ total: 30, items: [line('Vodka', 3, 10)] });

    const rows = (await get('/api/reports/top-products', adminToken)).body;
    expect(rows[0].name).toBe('Vodka');
    expect(Number(rows[0].units)).toBe(8);
    expect(Number(rows[0].revenue)).toBe(80);
    expect(rows[1].name).toBe('Gin');
  });

  test('respects ?limit', async () => {
    for (const name of ['A', 'B', 'C']) await sale({ items: [line(name, 1, 10)] });
    const rows = (await get('/api/reports/top-products?limit=2', adminToken)).body;
    expect(rows).toHaveLength(2);
  });

  test('caps an absurd limit instead of passing it to the query', async () => {
    await sale({ items: [line('A', 1, 10)] });
    expect((await get('/api/reports/top-products?limit=999999', adminToken)).status).toBe(200);
  });

  test('falls back to the default limit for a junk value', async () => {
    await sale({ items: [line('A', 1, 10)] });
    expect((await get('/api/reports/top-products?limit=abc', adminToken)).status).toBe(200);
  });

  test('omits voided sales', async () => {
    await sale({ items: [line('Real', 1, 10)] });
    await sale({ items: [line('Voided', 50, 10)], voided: true });
    const names = (await get('/api/reports/top-products', adminToken)).body.map((r) => r.name);
    expect(names).toEqual(['Real']);
  });
});

describe('z-report', () => {
  test('splits the day by payment method and nets the total', async () => {
    await sale({ total: 30, pay: 'cash', date: '2026-03-05' });
    await sale({ total: 20, pay: 'cash', date: '2026-03-05' });
    await sale({ total: 50, pay: 'card', date: '2026-03-05' });

    const res = await get('/api/reports/zreport?date=2026-03-05', adminToken);
    expect(res.body.date).toBe('2026-03-05');
    expect(res.body.net).toBe(100);

    const byPay = Object.fromEntries(res.body.lines.map((l) => [l.pay, l]));
    expect(byPay.cash.orders).toBe(2);
    expect(Number(byPay.cash.total)).toBe(50);
    expect(Number(byPay.card.total)).toBe(50);
  });

  test('never counts a voided sale in the close-out', async () => {
    // The single most consequential exclusion in the app: a voided sale in the Z-report
    // means the drawer is short against the paperwork every night.
    await sale({ total: 30, pay: 'cash', date: '2026-03-06' });
    await sale({ total: 70, pay: 'cash', date: '2026-03-06', voided: true });

    const res = await get('/api/reports/zreport?date=2026-03-06', adminToken);
    expect(res.body.net).toBe(30);
  });

  test('only counts the requested day', async () => {
    await sale({ total: 30, date: '2026-03-07' });
    await sale({ total: 90, date: '2026-03-08' });
    expect((await get('/api/reports/zreport?date=2026-03-07', adminToken)).body.net).toBe(30);
  });

  test('reports an empty day as zero', async () => {
    const res = await get('/api/reports/zreport?date=2026-03-09', adminToken);
    expect(res.body.lines).toEqual([]);
    expect(res.body.net).toBe(0);
  });

  test('defaults to today when no date is given', async () => {
    const res = await get('/api/reports/zreport', adminToken);
    expect(res.body.date).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('ABC analysis', () => {
  test('classes products by cumulative revenue share', async () => {
    // 800 / 150 / 50 of a 1000 total → cumulative 80% / 95% / 100% → A / B / C.
    await sale({ items: [line('Big', 80, 10)] });
    await sale({ items: [line('Mid', 15, 10)] });
    await sale({ items: [line('Small', 5, 10)] });

    const rows = (await get('/api/reports/abc', adminToken)).body;
    expect(rows.map((r) => [r.name, r.class])).toEqual([
      ['Big', 'A'], ['Mid', 'B'], ['Small', 'C'],
    ]);
    expect(rows[2].cum_share).toBeCloseTo(1, 5);
  });

  test('does not divide by zero on an empty window', async () => {
    expect((await get('/api/reports/abc', adminToken)).body).toEqual([]);
  });
});

describe('low stock', () => {
  test('lists products at or under the threshold, lowest first', async () => {
    await makeProduct({ name: 'Empty', stock: 0 });
    await makeProduct({ name: 'Low', stock: 3 });
    await makeProduct({ name: 'Fine', stock: 50 });

    const rows = (await get('/api/reports/low-stock?threshold=5', adminToken)).body;
    expect(rows.map((r) => r.name)).toEqual(['Empty', 'Low']);
  });

  test('defaults the threshold to 5', async () => {
    await makeProduct({ name: 'Five', stock: 5 });
    await makeProduct({ name: 'Six', stock: 6 });
    const rows = (await get('/api/reports/low-stock', adminToken)).body;
    expect(rows.map((r) => r.name)).toEqual(['Five']);
  });

  test('ignores a junk threshold rather than returning nothing', async () => {
    await makeProduct({ name: 'Low', stock: 1 });
    const rows = (await get('/api/reports/low-stock?threshold=abc', adminToken)).body;
    expect(rows.map((r) => r.name)).toEqual(['Low']);
  });

  test('excludes inactive products from the restock list', async () => {
    const p = await makeProduct({ name: 'Discontinued', stock: 0 });
    await db.query('update products set active = false where id = $1', [p.id]);
    expect((await get('/api/reports/low-stock', adminToken)).body).toEqual([]);
  });
});
