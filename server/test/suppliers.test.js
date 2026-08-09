// /api/suppliers, /api/batches, /api/expiry — the receiving side of inventory.
//
// A received batch is the only path that ADDS stock outside an import or a manual
// adjustment, so it has to bump the right product by the right amount and leave a record.
const request = require('supertest');
const {
  seedUsers, login, auth, clearCatalogue, makeProduct, stockOf, app, db,
} = require('./helpers');

let adminToken;
let cashierToken;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
});

beforeEach(async () => {
  await db.query('delete from batches');
  await db.query('delete from suppliers');
  await clearCatalogue();
});

afterAll(() => db.pool.end());

const newSupplier = (token, body) => request(app).post('/api/suppliers').set(...auth(token)).send(body);
const listSuppliers = (token) => request(app).get('/api/suppliers').set(...auth(token));
const receive = (token, body) => request(app).post('/api/batches').set(...auth(token)).send(body);

describe('suppliers', () => {
  test('creates and lists a supplier', async () => {
    const created = await newSupplier(adminToken, { name: 'Amman Drinks Co', phone: '0790000000', note: 'weekly' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: 'Amman Drinks Co', phone: '0790000000', active: true });

    const rows = (await listSuppliers(cashierToken)).body;
    expect(rows.map((s) => s.name)).toEqual(['Amman Drinks Co']);
  });

  test('requires a name', async () => {
    const res = await newSupplier(adminToken, { phone: '079' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid' });
  });

  test('rejects a whitespace-only name', async () => {
    expect((await newSupplier(adminToken, { name: '   ' })).status).toBe(400);
  });

  test('trims the name', async () => {
    const res = await newSupplier(adminToken, { name: '  Spaced Out  ' });
    expect(res.body.name).toBe('Spaced Out');
  });

  test('lists alphabetically', async () => {
    await newSupplier(adminToken, { name: 'Zed Imports' });
    await newSupplier(adminToken, { name: 'Alpha Beverages' });
    const rows = (await listSuppliers(adminToken)).body;
    expect(rows.map((s) => s.name)).toEqual(['Alpha Beverages', 'Zed Imports']);
  });

  test('updates a supplier', async () => {
    const { body } = await newSupplier(adminToken, { name: 'Old Name', phone: '079' });
    const res = await request(app).put(`/api/suppliers/${body.id}`).set(...auth(adminToken))
      .send({ name: 'New Name', phone: '078', note: 'changed' });
    expect(res.body).toEqual({ ok: true });

    const rows = (await listSuppliers(adminToken)).body;
    expect(rows[0]).toMatchObject({ name: 'New Name', phone: '078', note: 'changed' });
  });

  test('deleting deactivates rather than destroying the row', async () => {
    // Batches reference the supplier; a hard delete would orphan receiving history.
    const { body } = await newSupplier(adminToken, { name: 'Gone Supplier' });
    const res = await request(app).delete(`/api/suppliers/${body.id}`).set(...auth(adminToken));
    expect(res.body).toEqual({ ok: true });

    expect((await listSuppliers(adminToken)).body).toEqual([]);
    const { rows } = await db.query('select active from suppliers where id = $1', [body.id]);
    expect(rows[0].active).toBe(false);
  });

  test('a cashier cannot delete a supplier', async () => {
    const { body } = await newSupplier(adminToken, { name: 'Protected' });
    const res = await request(app).delete(`/api/suppliers/${body.id}`).set(...auth(cashierToken));
    expect(res.status).toBe(403);
    expect((await listSuppliers(adminToken)).body).toHaveLength(1);
  });

  test('all supplier routes require a session', async () => {
    expect((await request(app).get('/api/suppliers')).status).toBe(401);
    expect((await request(app).post('/api/suppliers').send({ name: 'X' })).status).toBe(401);
  });
});

describe('receiving a batch', () => {
  test('adds the received quantity to the product', async () => {
    const p = await makeProduct({ stock: 10 });
    const res = await receive(adminToken, { product_id: p.id, qty: 24, cost: 15 });

    expect(res.status).toBe(200);
    expect(Number(res.body.stock)).toBe(34);
    expect(await stockOf(p.id)).toBe(34);
  });

  test('accumulates across several deliveries', async () => {
    const p = await makeProduct({ stock: 0 });
    await receive(adminToken, { product_id: p.id, qty: 12 });
    await receive(adminToken, { product_id: p.id, qty: 6 });
    expect(await stockOf(p.id)).toBe(18);
  });

  test('records the lot with its supplier and expiry', async () => {
    const p = await makeProduct({ stock: 0 });
    const { body: sup } = await newSupplier(adminToken, { name: 'Batch Supplier' });
    await receive(adminToken, { product_id: p.id, supplier_id: sup.id, qty: 5, cost: 9, expiry: '2027-01-31' });

    const rows = (await request(app).get('/api/batches').set(...auth(adminToken))).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product: p.name, supplier: 'Batch Supplier' });
    expect(Number(rows[0].qty)).toBe(5);
  });

  test('logs the restock against the receiving user', async () => {
    const p = await makeProduct({ stock: 10 });
    await receive(adminToken, { product_id: p.id, qty: 5 });

    // The route fires the audit insert without awaiting it, so give it a tick to land.
    await new Promise((r) => setTimeout(r, 150));
    const { rows } = await db.query("select * from stock_log where kind = 'restock'");
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe('test_admin');
    expect(Number(rows[0].new_qty)).toBe(15);
  });

  const badBodies = {
    'no product': { qty: 5 },
    'no quantity': { product_id: 1 },
    'zero quantity': { product_id: 1, qty: 0 },
    'negative quantity': { product_id: 1, qty: -5 },
    'non-numeric quantity': { product_id: 1, qty: 'lots' },
  };
  for (const [label, body] of Object.entries(badBodies)) {
    test(`refuses a batch with ${label}`, async () => {
      const res = await receive(adminToken, body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid' });
    });
  }

  test('a negative quantity cannot be used to write stock down', async () => {
    // Otherwise receiving becomes an unaudited shrinkage path.
    const p = await makeProduct({ stock: 10 });
    await receive(adminToken, { product_id: p.id, qty: -10 });
    expect(await stockOf(p.id)).toBe(10);
  });

  test('requires a session', async () => {
    expect((await request(app).post('/api/batches').send({ product_id: 1, qty: 1 })).status).toBe(401);
  });
});

describe('batch listing', () => {
  test('filters by product', async () => {
    const a = await makeProduct({ name: 'Product A' });
    const b = await makeProduct({ name: 'Product B' });
    await receive(adminToken, { product_id: a.id, qty: 1 });
    await receive(adminToken, { product_id: b.id, qty: 1 });

    const rows = (await request(app).get(`/api/batches?product_id=${a.id}`).set(...auth(adminToken))).body;
    expect(rows).toHaveLength(1);
    expect(rows[0].product).toBe('Product A');
  });

  test('returns newest first', async () => {
    const p = await makeProduct();
    await receive(adminToken, { product_id: p.id, qty: 1 });
    await receive(adminToken, { product_id: p.id, qty: 2 });

    const rows = (await request(app).get('/api/batches').set(...auth(adminToken))).body;
    expect(Number(rows[0].qty)).toBe(2);
  });

  test('is empty when nothing has been received', async () => {
    expect((await request(app).get('/api/batches').set(...auth(adminToken))).body).toEqual([]);
  });
});

describe('expiry watch', () => {
  const expiring = async (days) => {
    const p = await makeProduct({ name: `Expires in ${days}` });
    await db.query(
      `insert into batches (product_id, qty, cost, expiry)
       values ($1, 3, 5, current_date + ($2 || ' days')::interval)`,
      [p.id, String(days)]
    );
    return p;
  };

  test('lists lots expiring within the default 30-day window', async () => {
    await expiring(10);
    await expiring(200);
    const rows = (await request(app).get('/api/expiry').set(...auth(adminToken))).body;
    expect(rows.map((r) => r.product)).toEqual(['Expires in 10']);
  });

  test('honours ?days', async () => {
    await expiring(10);
    await expiring(60);
    const rows = (await request(app).get('/api/expiry?days=90').set(...auth(adminToken))).body;
    expect(rows).toHaveLength(2);
  });

  test('includes lots that already expired, with a negative days_left', async () => {
    await expiring(-5);
    const rows = (await request(app).get('/api/expiry').set(...auth(adminToken))).body;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].days_left)).toBe(-5);
  });

  test('soonest first', async () => {
    await expiring(20);
    await expiring(2);
    const rows = (await request(app).get('/api/expiry').set(...auth(adminToken))).body;
    expect(rows.map((r) => r.product)).toEqual(['Expires in 2', 'Expires in 20']);
  });

  test('ignores lots with no expiry date', async () => {
    const p = await makeProduct();
    await receive(adminToken, { product_id: p.id, qty: 5 });   // no expiry
    expect((await request(app).get('/api/expiry').set(...auth(adminToken))).body).toEqual([]);
  });

  test('falls back to the default window for a junk ?days', async () => {
    await expiring(10);
    const rows = (await request(app).get('/api/expiry?days=abc').set(...auth(adminToken))).body;
    expect(rows).toHaveLength(1);
  });

  test('requires a session', async () => {
    expect((await request(app).get('/api/expiry')).status).toBe(401);
  });
});
