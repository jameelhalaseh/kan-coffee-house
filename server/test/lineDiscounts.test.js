// Line discounts, per-product reorder points, and bottle size.
//
// The discount tests are the ones that matter. A discount is the only field on a bill whose
// entire job is to reduce what is owed, so every one of these is a way the drawer comes up
// short at close with a valid-looking invoice explaining it. The client clamps too, but the
// client is the part an operator can bypass — these assert the server refuses on its own.
const request = require('supertest');
const {
  seedUsers, login, auth, clearCatalogue, clearOrders, makeProduct, stockOf, app, db,
} = require('./helpers');

let adminToken;
let cashierToken;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
});

beforeEach(async () => {
  await clearOrders();
  await clearCatalogue();
});

afterAll(() => db.pool.end());

let uidCounter = 0;
const uid = () => `test-disc-${Date.now()}-${++uidCounter}`;

const save = (token, body) => request(app).post('/api/orders').set(...auth(token)).send(body);

// A bill whose figures agree: total = Σ(price × qty) − Σ disc.
const billOf = (items, over = {}) => {
  const gross = items.reduce((s, li) => s + li.price * li.qty, 0);
  const disc = items.reduce((s, li) => s + (li.disc || 0), 0);
  return {
    id: uid(), floor: 'main', items,
    sub: 0, tax: 0, disc, total: gross - disc,
    pay: 'cash', waiter: 'test_cashier', status: 'paid',
    date: '2026-02-01', time: '12:00:00', ...over,
  };
};

describe('line discounts', () => {
  test('accepts a bill whose line discounts add up', async () => {
    const p = await makeProduct({ price: 12, stock: 10 });
    const res = await save(cashierToken, billOf([{ id: p.id, name: p.name, price: 12, qty: 2, disc: 1.5 }]));
    expect(res.status).toBe(200);

    const { rows } = await db.query('select disc, total, items from orders_main');
    expect(Number(rows[0].disc)).toBeCloseTo(1.5, 3);
    expect(Number(rows[0].total)).toBeCloseTo(22.5, 3);
    // The discount is stored ON the line, not just as a bill-level lump — that is what lets
    // the receipt say which item it came off.
    expect(Number(rows[0].items[0].disc)).toBeCloseTo(1.5, 3);
  });

  test('several lines can each carry their own discount', async () => {
    const a = await makeProduct({ name: 'Arak', price: 10, stock: 10 });
    const b = await makeProduct({ name: 'Whiskey', price: 20, stock: 10 });
    const res = await save(cashierToken, billOf([
      { id: a.id, name: 'Arak', price: 10, qty: 1, disc: 0.5 },
      { id: b.id, name: 'Whiskey', price: 20, qty: 1, disc: 1 },
    ]));
    expect(res.status).toBe(200);

    const { rows } = await db.query('select disc, total from orders_main');
    expect(Number(rows[0].disc)).toBeCloseTo(1.5, 3);
    expect(Number(rows[0].total)).toBeCloseTo(28.5, 3);
  });

  test('refuses a discount larger than the line it is taken off', async () => {
    // Otherwise the line goes negative and the bill pays the customer to leave.
    const p = await makeProduct({ price: 5, stock: 10 });
    const res = await save(cashierToken, billOf([{ id: p.id, name: p.name, price: 5, qty: 1, disc: 9999 }]));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'discount_exceeds_line' });
  });

  test('allows a discount that takes the line to exactly zero', async () => {
    // A giveaway is legitimate and is not the same thing as a negative line.
    const p = await makeProduct({ price: 5, stock: 10 });
    const res = await save(cashierToken, billOf([{ id: p.id, name: p.name, price: 5, qty: 1, disc: 5 }]));
    expect(res.status).toBe(200);
  });

  test('refuses a negative discount', async () => {
    const p = await makeProduct({ price: 5, stock: 10 });
    const res = await save(cashierToken, billOf([{ id: p.id, name: p.name, price: 5, qty: 1, disc: -3 }]));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_discount' });
  });

  test('refuses a non-numeric discount rather than treating it as zero', async () => {
    const p = await makeProduct({ price: 5, stock: 10 });
    const body = billOf([{ id: p.id, name: p.name, price: 5, qty: 1, disc: 1 }]);
    body.items[0].disc = '1; drop';
    const res = await save(cashierToken, body);
    expect(res.status).toBe(400);
  });

  test("refuses a bill whose stored disc does not match its lines", async () => {
    // A receipt showing 0.5 off while the bill records 5 off is a receipt that lies.
    const p = await makeProduct({ price: 20, stock: 10 });
    const body = billOf([{ id: p.id, name: p.name, price: 20, qty: 1, disc: 0.5 }]);
    body.disc = 5;
    const res = await save(cashierToken, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'discount_mismatch' });
  });

  test('refuses a total that took MORE off than the discounts declare', async () => {
    // The theft case: the discount on paper is small, the money that left is not.
    const p = await makeProduct({ price: 20, stock: 10 });
    const body = billOf([{ id: p.id, name: p.name, price: 20, qty: 1, disc: 1 }]);
    body.total = 5;
    const res = await save(cashierToken, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'total_mismatch' });
  });

  test('refuses a discount that never reaches the total', async () => {
    // The other direction: the customer is shown money off that they still paid.
    const p = await makeProduct({ price: 20, stock: 10 });
    const body = billOf([{ id: p.id, name: p.name, price: 20, qty: 1, disc: 1 }]);
    body.total = 20;
    expect((await save(cashierToken, body)).body).toEqual({ error: 'total_mismatch' });
  });

  test('nothing is written when a bill is refused', async () => {
    const p = await makeProduct({ price: 5, stock: 10 });
    await save(cashierToken, billOf([{ id: p.id, name: p.name, price: 5, qty: 1, disc: 9999 }]));
    const { rows } = await db.query('select count(*)::int as n from orders_main');
    expect(rows[0].n).toBe(0);
    expect(await stockOf(p.id)).toBe(10);   // and the bottle is still on the shelf
  });

  test('a bill with no discounts is not examined at all', async () => {
    // The existing contract: the server has never recomputed totals for ordinary sales, and
    // introducing discounts must not quietly start rejecting orders that predate them.
    const p = await makeProduct({ price: 10, stock: 10 });
    const res = await save(cashierToken, {
      id: uid(), floor: 'main', items: [{ id: p.id, name: p.name, price: 10, qty: 1 }],
      sub: 0, tax: 0, total: 999, pay: 'cash', date: '2026-02-01', time: '12:00:00',
    });
    expect(res.status).toBe(200);
  });

  test('tolerates rounding to the fils', async () => {
    const p = await makeProduct({ price: 3.333, stock: 10 });
    const body = billOf([{ id: p.id, name: p.name, price: 3.333, qty: 3, disc: 0.111 }]);
    body.total = Number(body.total.toFixed(3));
    expect((await save(cashierToken, body)).status).toBe(200);
  });
});

describe('per-product reorder point', () => {
  test('low-stock lists a product against its OWN low_at, not a shop-wide 5', async () => {
    // The crate of beer is a crisis at 20; the rare arak is fine at 2. One number cannot
    // describe both, which is the whole reason low_at exists.
    await makeProduct({ name: 'Beer Crate', stock: 12, low_at: 20 });
    await makeProduct({ name: 'Rare Arak', stock: 3, low_at: 2 });

    const res = await request(app).get('/api/reports/low-stock').set(...auth(adminToken));
    expect(res.status).toBe(200);
    const names = res.body.map((r) => r.name);
    expect(names).toContain('Beer Crate');      // 12 of 20 — under its own line
    expect(names).not.toContain('Rare Arak');   // 3 of 2 — fine, though under the old 5
  });

  test('?threshold overrides every product, for a question about a specific level', async () => {
    await makeProduct({ name: 'Rare Arak', stock: 3, low_at: 2 });
    const res = await request(app).get('/api/reports/low-stock?threshold=5').set(...auth(adminToken));
    expect(res.body.map((r) => r.name)).toContain('Rare Arak');
  });

  test('orders the worst shortfall first, not the smallest number', async () => {
    await makeProduct({ name: 'Nearly Fine', stock: 4, low_at: 5 });    // 1 under
    await makeProduct({ name: 'Empty Shelf', stock: 0, low_at: 12 });   // 12 under
    const res = await request(app).get('/api/reports/low-stock').set(...auth(adminToken));
    expect(res.body[0].name).toBe('Empty Shelf');
  });

  test('a product with no low_at set behaves exactly as it did before', async () => {
    const { rows } = await db.query(
      `insert into products (name, price, stock, active) values ('Legacy Row', 5, 5, true) returning low_at`
    );
    expect(Number(rows[0].low_at)).toBe(5);
    const res = await request(app).get('/api/reports/low-stock').set(...auth(adminToken));
    expect(res.body.map((r) => r.name)).toContain('Legacy Row');
  });

  test('the API round-trips low_at and rejects a nonsense value into the default', async () => {
    const created = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'Threshold Bottle', price: 5, low_at: 24 });
    expect(Number(created.body.low_at)).toBe(24);

    // "soon" must not land as 0 — a product that only warns once it is gone reads as covered.
    const bad = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'Vague Bottle', price: 5, low_at: 'soon' });
    expect(Number(bad.body.low_at)).toBe(5);

    const negative = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'Negative Bottle', price: 5, low_at: -10 });
    expect(Number(negative.body.low_at)).toBe(5);
  });
});

describe('product size', () => {
  test('round-trips through create, list and update', async () => {
    const created = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'Arak', price: 12, size: '750ml' });
    expect(created.body.size).toBe('750ml');

    const listed = await request(app).get('/api/products').set(...auth(adminToken));
    expect(listed.body.find((p) => p.id === created.body.id).size).toBe('750ml');

    await request(app).put('/api/products/' + created.body.id).set(...auth(adminToken))
      .send({ ...created.body, size: '1L' });
    const after = await db.query('select size from products where id = $1', [created.body.id]);
    expect(after.rows[0].size).toBe('1L');
  });

  test('takes a size no preset covers', async () => {
    // The form offers 500ml/750ml/1L, but a 1.75L handle is real stock and must not need a
    // migration to sell.
    const res = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'Handle', price: 30, size: '1.75L' });
    expect(res.body.size).toBe('1.75L');
  });

  test('blank size is stored as null, not an empty string', async () => {
    // One value for "no size recorded" keeps every screen's `size ? … : …` honest.
    const res = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'No Size', price: 5, size: '   ' });
    expect(res.body.size).toBeNull();
  });

  test('caps an over-long size rather than storing a paragraph', async () => {
    const res = await request(app).post('/api/products').set(...auth(adminToken))
      .send({ name: 'Chatty', price: 5, size: 'x'.repeat(400) });
    expect(res.body.size.length).toBeLessThanOrEqual(24);
  });

  test('a cashier may set size and low_at — neither is a pricing field', async () => {
    // The admin-only guard covers price, cost, barcode and stock. A size label and a reorder
    // point are shelf facts, and locking them behind admin would just leave them unset.
    const p = await makeProduct({ name: 'Shelf Item', price: 10, stock: 4 });
    const res = await request(app).put('/api/products/' + p.id).set(...auth(cashierToken))
      .send({ name: 'Shelf Item', price: 10, cost: 6, stock: 4, cat: 'Whiskey', size: '500ml', low_at: 9 });
    expect(res.status).toBe(200);
    const { rows } = await db.query('select size, low_at from products where id = $1', [p.id]);
    expect(rows[0].size).toBe('500ml');
    expect(Number(rows[0].low_at)).toBe(9);
  });
});

describe('discount reasons', () => {
  const itemsOf = async () => (await db.query('select items from orders_main')).rows[0].items;

  test('the reason is stored on the line beside the amount it explains', async () => {
    const p = await makeProduct({ price: 10, stock: 10 });
    const res = await save(cashierToken, billOf([
      { id: p.id, name: p.name, price: 10, qty: 1, disc: 1, disc_note: 'damaged label' },
    ]));
    expect(res.status).toBe(200);
    expect((await itemsOf())[0].disc_note).toBe('damaged label');
  });

  test('a reason without a discount is dropped, not stored', async () => {
    // Otherwise it is an unbounded free-text field on every line of every order that no
    // report ever reads.
    const p = await makeProduct({ price: 10, stock: 10 });
    await save(cashierToken, billOf([{ id: p.id, name: p.name, price: 10, qty: 1, disc_note: 'nothing given' }]));
    expect((await itemsOf())[0].disc_note).toBeUndefined();
  });

  test('a blank reason is dropped rather than stored as an empty string', async () => {
    const p = await makeProduct({ price: 10, stock: 10 });
    await save(cashierToken, billOf([
      { id: p.id, name: p.name, price: 10, qty: 1, disc: 1, disc_note: '   ' },
    ]));
    expect((await itemsOf())[0].disc_note).toBeUndefined();
  });

  test('an over-long reason is capped', async () => {
    const p = await makeProduct({ price: 10, stock: 10 });
    await save(cashierToken, billOf([
      { id: p.id, name: p.name, price: 10, qty: 1, disc: 1, disc_note: 'x'.repeat(500) },
    ]));
    expect((await itemsOf())[0].disc_note.length).toBe(120);
  });

  test('each line keeps its OWN reason', async () => {
    const a = await makeProduct({ name: 'Arak', price: 10, stock: 10 });
    const b = await makeProduct({ name: 'Whiskey', price: 20, stock: 10 });
    await save(cashierToken, billOf([
      { id: a.id, name: 'Arak', price: 10, qty: 1, disc: 0.5, disc_note: 'damaged label' },
      { id: b.id, name: 'Whiskey', price: 20, qty: 1, disc: 1, disc_note: 'staff friend' },
    ]));
    const items = await itemsOf();
    expect(items.map((li) => li.disc_note)).toEqual(['damaged label', 'staff friend']);
  });

  test('a reason cannot smuggle a discount past validation', async () => {
    // Notes are normalised AFTER the amounts are validated, so no note can change a figure.
    const p = await makeProduct({ price: 5, stock: 10 });
    const res = await save(cashierToken, billOf([
      { id: p.id, name: p.name, price: 5, qty: 1, disc: 9999, disc_note: 'manager said so' },
    ]));
    expect(res.status).toBe(400);
  });
});
