// /api/products CRUD, /api/products/:id/stock, /api/stock-log, /api/settings/categories.
//
// The theme throughout is that PRICING IS ADMIN-ONLY. A cashier who can set prices can
// under-ring: create "Whiskey" at 2.00, sell the real bottle through it, pocket the rest.
// So a cashier may capture an unknown barcode and fix a name, but never touch price, cost
// or barcode — and every stock movement leaves an attributable audit row.
const request = require('supertest');
const {
  seedUsers, login, auth, clearCatalogue, makeProduct, stockOf, app, db,
} = require('./helpers');

let adminToken;
let cashierToken;
let stockistToken;

beforeAll(async () => {
  await seedUsers();
  await db.query("update app_users set allowed_views = '{sales,inventory}' where username = 'test_stockist'");
  adminToken = await login('admin');
  cashierToken = await login('cashier');
  stockistToken = await login('stockist');
});

beforeEach(async () => {
  await clearCatalogue();
  await db.query("delete from app_settings where key = 'categories'");
});

afterAll(() => db.pool.end());

const create = (token, body) => request(app).post('/api/products').set(...auth(token)).send(body);
const update = (token, id, body) => request(app).put(`/api/products/${id}`).set(...auth(token)).send(body);
const adjust = (token, id, body) => request(app).patch(`/api/products/${id}/stock`).set(...auth(token)).send(body);

const FULL = { barcode: '6291111111111', name: 'Test Bottle', price: 20, cost: 12, stock: 30, cat: 'Whiskey', unit: 'ea' };

describe('listing and scanning', () => {
  test('lists the catalogue alphabetically', async () => {
    await makeProduct({ name: 'Zubrowka' });
    await makeProduct({ name: 'Absolut' });
    const res = await request(app).get('/api/products').set(...auth(cashierToken));
    expect(res.body.map((p) => p.name)).toEqual(['Absolut', 'Zubrowka']);
  });

  test('a scan resolves a barcode to exactly one product', async () => {
    const p = await makeProduct({ barcode: '6291000000123', name: 'Scanned' });
    const res = await request(app).get('/api/products/barcode/6291000000123').set(...auth(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: p.id, name: 'Scanned' });
  });

  test('an unknown barcode is a 404, not an empty 200', async () => {
    const res = await request(app).get('/api/products/barcode/0000000000000').set(...auth(cashierToken));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  test('a blank barcode is rejected', async () => {
    const res = await request(app).get('/api/products/barcode/%20').set(...auth(cashierToken));
    expect(res.status).toBe(400);
  });

  test('both read paths require a session', async () => {
    expect((await request(app).get('/api/products')).status).toBe(401);
    expect((await request(app).get('/api/products/barcode/123')).status).toBe(401);
  });
});

describe('create', () => {
  test('an admin creates a fully priced, active product', async () => {
    const res = await create(adminToken, FULL);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Test Bottle', active: true });
    expect(Number(res.body.price)).toBe(20);
    expect(Number(res.body.stock)).toBe(30);
  });

  test('a name is required', async () => {
    expect((await create(adminToken, { ...FULL, name: '  ' })).status).toBe(400);
  });

  test('a duplicate barcode is a 409', async () => {
    await create(adminToken, FULL);
    const res = await create(adminToken, FULL);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'exists' });
  });

  test('a cashier may capture an unknown barcode but gets no pricing', async () => {
    // The useful half of quick-add: the code is recorded so an admin can price it later.
    const res = await create(cashierToken, FULL);
    expect(res.status).toBe(200);
    expect(res.body.pending_admin_pricing).toBe(true);
    expect(Number(res.body.price)).toBe(0);
    expect(Number(res.body.cost)).toBe(0);
    expect(Number(res.body.stock)).toBe(0);
  });

  test('a cashier-created product is inactive, so it cannot be sold unpriced', async () => {
    const res = await create(cashierToken, FULL);
    expect(res.body.active).toBe(false);
  });

  test('logs the creation against the session user', async () => {
    await create(cashierToken, FULL);
    const { rows } = await db.query('select * from stock_log');
    expect(rows[0]).toMatchObject({ kind: 'create', changed_by: 'test_cashier' });
  });

  test('a blank barcode is stored as null', async () => {
    const res = await create(adminToken, { ...FULL, barcode: '   ' });
    expect(res.body.barcode).toBeNull();
  });

  test('an unknown unit falls back to ea', async () => {
    const res = await create(adminToken, { ...FULL, unit: 'litre' });
    expect(res.body.unit).toBe('ea');
  });

  test('kg is preserved for weighed items', async () => {
    const res = await create(adminToken, { ...FULL, unit: 'kg' });
    expect(res.body.unit).toBe('kg');
  });
});

describe('update', () => {
  test('an admin edits every field', async () => {
    const p = await makeProduct({ barcode: '6291222222222', price: 10, stock: 5 });
    const res = await update(adminToken, p.id, {
      barcode: '6291333333333', name: 'Renamed', price: 33, cost: 20, stock: 8, cat: 'Gin', unit: 'ea',
    });
    expect(res.body).toEqual({ ok: true });

    const { rows } = await db.query('select * from products where id = $1', [p.id]);
    expect(rows[0]).toMatchObject({ name: 'Renamed', barcode: '6291333333333', cat: 'Gin' });
    expect(Number(rows[0].price)).toBe(33);
  });

  test('a name is still required', async () => {
    const p = await makeProduct();
    expect((await update(adminToken, p.id, { name: '' })).status).toBe(400);
  });

  test('404s on an unknown id', async () => {
    expect((await update(adminToken, 999999, { name: 'Ghost' })).status).toBe(404);
  });

  test('a cashier may fix a name and category', async () => {
    const p = await makeProduct({ name: 'Mispelled', price: 10, cost: 6, cat: 'Whiskey' });
    const res = await update(cashierToken, p.id, {
      name: 'Corrected', cat: 'Gin', price: p.price, cost: p.cost, stock: p.stock, barcode: p.barcode,
    });
    expect(res.body).toEqual({ ok: true });
    const { rows } = await db.query('select name, cat from products where id = $1', [p.id]);
    expect(rows[0]).toMatchObject({ name: 'Corrected', cat: 'Gin' });
  });

  const forbidden = {
    'the price': { price: 1 },
    'the cost': { cost: 1 },
    'the barcode': { barcode: '6291999999999' },
  };
  for (const [label, over] of Object.entries(forbidden)) {
    test(`a cashier cannot change ${label}`, async () => {
      const p = await makeProduct({ barcode: '6291444444444', price: 10, cost: 6, stock: 5 });
      const res = await update(cashierToken, p.id, {
        name: p.name, price: p.price, cost: p.cost, stock: p.stock, barcode: p.barcode, ...over,
      });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'admin_only' });
    });
  }

  test('a refused cashier edit changes nothing at all', async () => {
    const p = await makeProduct({ name: 'Original', price: 10 });
    await update(cashierToken, p.id, { name: 'Sneaky Rename', price: 1, cost: p.cost, stock: p.stock });
    const { rows } = await db.query('select name, price from products where id = $1', [p.id]);
    expect(rows[0].name).toBe('Original');
    expect(Number(rows[0].price)).toBe(10);
  });

  test('a stock change writes an attributable audit row', async () => {
    const p = await makeProduct({ stock: 5, price: 10, cost: 6 });
    await update(adminToken, p.id, { name: p.name, price: 10, cost: 6, stock: 12 });

    const { rows } = await db.query("select * from stock_log where kind = 'adjust'");
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe('test_admin');
    expect(Number(rows[0].old_qty)).toBe(5);
    expect(Number(rows[0].new_qty)).toBe(12);
  });

  test('an edit that leaves stock alone writes no audit row', async () => {
    const p = await makeProduct({ stock: 5, price: 10, cost: 6 });
    await update(adminToken, p.id, { name: 'Just A Rename', price: 10, cost: 6, stock: 5 });
    const { rows } = await db.query("select count(*)::int as n from stock_log where kind = 'adjust'");
    expect(rows[0].n).toBe(0);
  });
});

describe('stock adjustment', () => {
  test('applies a positive delta', async () => {
    const p = await makeProduct({ stock: 10 });
    const res = await adjust(adminToken, p.id, { delta: 5 });
    expect(Number(res.body.stock)).toBe(15);
  });

  test('applies a negative delta', async () => {
    const p = await makeProduct({ stock: 10 });
    await adjust(adminToken, p.id, { delta: -4 });
    expect(await stockOf(p.id)).toBe(6);
  });

  test('a non-numeric delta is rejected', async () => {
    const p = await makeProduct({ stock: 10 });
    expect((await adjust(adminToken, p.id, { delta: 'lots' })).status).toBe(400);
    expect(await stockOf(p.id)).toBe(10);
  });

  test('404s on an unknown product', async () => {
    expect((await adjust(adminToken, 999999, { delta: 1 })).status).toBe(404);
  });

  test('a cashier without the inventory view cannot adjust stock', async () => {
    // This is how a missing bottle gets "corrected" away, so it is gated.
    const p = await makeProduct({ stock: 10 });
    expect((await adjust(cashierToken, p.id, { delta: -1 })).status).toBe(403);
    expect(await stockOf(p.id)).toBe(10);
  });

  test('a non-admin holding the inventory view can', async () => {
    const p = await makeProduct({ stock: 10 });
    expect((await adjust(stockistToken, p.id, { delta: -1 })).status).toBe(200);
  });

  test('the adjustment and its audit row commit together', async () => {
    const p = await makeProduct({ stock: 10 });
    await adjust(stockistToken, p.id, { delta: -3 });

    const { rows } = await db.query("select * from stock_log where kind = 'adjust'");
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe('test_stockist');
    expect(Number(rows[0].old_qty)).toBe(10);
    expect(Number(rows[0].new_qty)).toBe(7);
  });
});

describe('delete', () => {
  test('an admin deletes a product', async () => {
    const p = await makeProduct();
    expect((await request(app).delete(`/api/products/${p.id}`).set(...auth(adminToken))).body).toEqual({ ok: true });
    const { rows } = await db.query('select 1 from products where id = $1', [p.id]);
    expect(rows).toHaveLength(0);
  });

  test('a cashier cannot', async () => {
    const p = await makeProduct();
    expect((await request(app).delete(`/api/products/${p.id}`).set(...auth(cashierToken))).status).toBe(403);
    const { rows } = await db.query('select 1 from products where id = $1', [p.id]);
    expect(rows).toHaveLength(1);
  });

  test('holding the inventory view is not enough', async () => {
    const p = await makeProduct();
    expect((await request(app).delete(`/api/products/${p.id}`).set(...auth(stockistToken))).status).toBe(403);
  });
});

describe('stock log endpoint', () => {
  test('any session may append an entry', async () => {
    const res = await request(app).post('/api/stock-log').set(...auth(cashierToken))
      .send({ kind: 'adjust', item_id: '1', name: 'Something', old_qty: 5, new_qty: 3 });
    expect(res.body).toEqual({ ok: true });
  });

  test('the actor comes from the session, not the body', async () => {
    // Otherwise the person causing shrinkage also authors the record of it.
    await request(app).post('/api/stock-log').set(...auth(cashierToken))
      .send({ kind: 'adjust', name: 'Something', changed_by: 'test_admin' });
    const { rows } = await db.query('select changed_by from stock_log');
    expect(rows[0].changed_by).toBe('test_cashier');
  });

  test('requires a session', async () => {
    expect((await request(app).post('/api/stock-log').send({ kind: 'adjust' })).status).toBe(401);
  });
});

describe('category settings', () => {
  const get = (token) => request(app).get('/api/settings/categories').set(...auth(token));
  const put = (token, value) => request(app).put('/api/settings/categories').set(...auth(token)).send({ value });

  test('returns null before anything is configured', async () => {
    const res = await get(adminToken);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  test('an admin saves the list and anyone with a session reads it', async () => {
    const list = JSON.stringify(['Whiskey', 'Gin', 'Arak']);
    expect((await put(adminToken, list)).body).toEqual({ ok: true });

    const res = await get(cashierToken);
    expect(JSON.parse(res.body.value)).toEqual(['Whiskey', 'Gin', 'Arak']);
  });

  test('saving again replaces the list rather than adding a second row', async () => {
    await put(adminToken, JSON.stringify(['One']));
    await put(adminToken, JSON.stringify(['Two']));
    const { rows } = await db.query("select count(*)::int as n from app_settings where key = 'categories'");
    expect(rows[0].n).toBe(1);
    expect(JSON.parse((await get(adminToken)).body.value)).toEqual(['Two']);
  });

  test('a cashier cannot rewrite the shared category list', async () => {
    expect((await put(cashierToken, JSON.stringify(['Hacked']))).status).toBe(403);
  });

  test('reading requires a session', async () => {
    expect((await request(app).get('/api/settings/categories')).status).toBe(401);
  });
});
