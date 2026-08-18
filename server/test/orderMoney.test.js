// The server recomputes every bill's money. These are the attacks that used to work.
//
// Before validateOrderMoney (server/routes/orders.js), a bill with no line discount was not
// examined at all: `sub`, `tax` and `total` went into the database exactly as the browser sent
// them. Anyone holding a staff session — or anyone running a modified copy of the front end —
// could post a 3.750 latte as `total: 0.100, tax: 0`, and every figure downstream (the
// Z-report, the P&L, whatever is filed with the ISTD) was built from that row.
//
// Line PRICES are deliberately still the client's to set: a price override is a real feature
// of the till, and open-price items have no catalogue row to check against. What the server
// insists on is that the bill is internally honest and that the VAT follows from the total at
// the shop's own rate, which is read from the server's environment and never from the request.
const request = require('supertest');
const {
  seedUsers, login, auth, clearCatalogue, clearOrders, makeProduct, withTax, splitInclusiveTax,
  TAX_PCT, app, db,
} = require('./helpers');

let cashierToken;
let product;

beforeAll(async () => {
  await seedUsers();
  cashierToken = await login('cashier');
});
beforeEach(async () => {
  await clearOrders();
  await clearCatalogue();
  product = await makeProduct({ price: 3.75, stock: 100 });
});
afterAll(() => db.pool.end());

let n = 0;
const uid = () => `test-money-${Date.now()}-${++n}`;
const save = (body) => request(app).post('/api/orders').set(...auth(cashierToken)).send(body);

// One 3.750 latte, with every figure correct.
const honest = (over = {}) => withTax({
  id: uid(), floor: 'main',
  items: [{ id: product.id, name: product.name, qty: 1, price: 3.75 }],
  disc: 0, svc: 0, total: 3.75,
  pay: 'cash', waiter: 'test_cashier', status: 'paid',
  date: '2026-02-01', time: '12:00:00', ...over,
});

const stored = async () => (await db.query('select count(*)::int c from orders_main')).rows[0].c;

describe('an honest bill still goes through', () => {
  test('a plain sale is accepted, and its VAT is the inclusive extraction', async () => {
    const body = honest();
    expect((await save(body)).status).toBe(200);

    const { rows } = await db.query('select sub, tax, total from orders_main');
    const { net, tax } = splitInclusiveTax(3.75, TAX_PCT / 100);
    expect(Number(rows[0].total)).toBeCloseTo(3.75, 3);
    expect(Number(rows[0].tax)).toBeCloseTo(tax, 3);
    expect(Number(rows[0].sub)).toBeCloseTo(net, 3);
    // Sanity: a 16% shop must not be recording 3.750 as carrying no tax.
    expect(Number(rows[0].tax)).toBeGreaterThan(0);
  });

  test('a price OVERRIDE is allowed — the catalogue price is not enforced', async () => {
    // The cashier is permitted to sell at another figure; what must still hold is that the
    // rest of the bill follows from the price actually charged.
    const res = await save(honest({
      items: [{ id: product.id, name: product.name, qty: 2, price: 2.5 }], total: 5,
    }));
    expect(res.status).toBe(200);
  });

  test('an open-price misc line is allowed, having no catalogue row at all', async () => {
    const res = await save(honest({
      items: [{ id: 'misc-xyz', name: 'Bottle of water', qty: 1, price: 0.5 }], total: 0.5,
    }));
    expect(res.status).toBe(200);
  });

  test('rounding to the fils is tolerated, not treated as tampering', async () => {
    const res = await save(honest({
      items: [{ id: product.id, name: product.name, qty: 3, price: 3.333 }], total: 9.999,
    }));
    expect(res.status).toBe(200);
  });
});

describe('the bill cannot lie about what it collected', () => {
  test('a total below what the lines add up to is refused', async () => {
    const res = await save(honest({ total: 0.1 }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'total_mismatch' });
    expect(await stored()).toBe(0);
  });

  test('a total ABOVE the lines is refused too', async () => {
    const res = await save(honest({ total: 99 }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'total_mismatch' });
  });

  test('zero VAT on a taxed sale is refused', async () => {
    // The original skim: keep the total honest so the drawer balances, and declare no tax.
    const res = await save(honest({ tax: 0, sub: 3.75 }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'tax_mismatch' });
    expect(await stored()).toBe(0);
  });

  test('an understated VAT figure is refused', async () => {
    const res = await save(honest({ tax: 0.01 }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'tax_mismatch' });
  });

  test('a net figure that does not complete the total is refused', async () => {
    const res = await save(honest({ sub: 0 }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'sub_mismatch' });
  });

  test('a bill with no lines at all is refused, whatever total it claims', async () => {
    // A sale with revenue and no goods behind it is a fabricated row, and it used to be
    // accepted because the validator only ran when a line carried a discount.
    const res = await save(honest({ items: [], total: 50 }));
    expect(res.status).toBe(400);
    expect(await stored()).toBe(0);
  });
});

describe('lines themselves have to be numbers', () => {
  test('a non-numeric price is refused rather than counted as zero', async () => {
    const res = await save(honest({
      items: [{ id: product.id, name: product.name, qty: 1, price: 'free' }], total: 0,
    }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_line' });
  });

  test('a non-numeric quantity is refused', async () => {
    const res = await save(honest({
      items: [{ id: product.id, name: product.name, qty: 'lots', price: 3.75 }], total: 0,
    }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_line' });
  });

  test('a negative price is refused', async () => {
    // Otherwise a negative line is a discount with no ceiling and no audit trail.
    const res = await save(honest({
      items: [
        { id: product.id, name: product.name, qty: 1, price: 10 },
        { id: 'misc-credit', name: 'Adjustment', qty: 1, price: -9 },
      ],
      total: 1,
    }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_line' });
  });

  test('a zero or negative quantity is refused', async () => {
    const res = await save(honest({
      items: [{ id: product.id, name: product.name, qty: 0, price: 3.75 }], total: 0,
    }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_line' });
  });
});

describe('refunds keep their own shape', () => {
  test('a consistent refund is accepted', async () => {
    await save(honest({ invoice_no: 7001, items: [{ id: product.id, name: product.name, qty: 2, price: 10 }], total: 20 }));
    const res = await save(honest({
      status: 'refund', buyer: 'return of #7001',
      items: [{ id: product.id, name: product.name, qty: 1, price: 10 }], total: -10,
    }));
    expect(res.status).toBe(200);
  });

  test('a refund paying out more than the goods it names is refused', async () => {
    await save(honest({ invoice_no: 7002, items: [{ id: product.id, name: product.name, qty: 2, price: 10 }], total: 20 }));
    const res = await save(honest({
      status: 'refund', buyer: 'return of #7002',
      items: [{ id: product.id, name: product.name, qty: 1, price: 10 }], total: -18,
    }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'total_mismatch' });
  });
});

describe('the tax rate comes from the server, not the caller', () => {
  test('a rate smuggled into the request body changes nothing', async () => {
    const body = honest({ tax: 0, sub: 3.75 });
    body.taxPct = 0;          // ignored: clientConfig() is the only source
    body.store = { taxPct: 0 };
    const res = await save(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'tax_mismatch' });
  });

  test("the server's rate is the one the browser's own helper produces", () => {
    // If these two ever drift, every honest checkout starts failing tax_mismatch. The server
    // keeps its own copy (it cannot import from src/), so the copies are pinned to each other.
    const fromClientMath = splitInclusiveTax(3.75, TAX_PCT / 100);
    expect(fromClientMath.tax).toBeCloseTo(3.75 - 3.75 / (1 + TAX_PCT / 100), 3);
    expect(fromClientMath.net + fromClientMath.tax).toBeCloseTo(3.75, 3);
  });
});
