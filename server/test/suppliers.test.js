// /api/suppliers, /api/batches — the receiving side of inventory.
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

  // Duplicate names split one distributor's delivery history across two ids that are
  // indistinguishable in the Receive dropdown. The demo DB had all four suppliers twice
  // because the seed's `on conflict do nothing` had no unique constraint to fire on.
  test('refuses a duplicate supplier name', async () => {
    await newSupplier(adminToken, { name: 'Levant Spirits Import' });
    const res = await newSupplier(adminToken, { name: 'Levant Spirits Import' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'exists' });
    expect((await listSuppliers(adminToken)).body).toHaveLength(1);
  });

  test('duplicate detection ignores case and surrounding space', async () => {
    await newSupplier(adminToken, { name: 'Cellar Direct Wines' });
    expect((await newSupplier(adminToken, { name: '  cellar direct wines ' })).status).toBe(409);
  });

  test('re-adding a deleted supplier revives it instead of 409-ing', async () => {
    // Delete is a soft delete and nothing in the UI lists inactive suppliers, so a bare
    // 409 here would make the name permanently unusable with no way to see why.
    const { body } = await newSupplier(adminToken, { name: 'Back Again', phone: '079' });
    await request(app).delete(`/api/suppliers/${body.id}`).set(...auth(adminToken));

    const res = await newSupplier(adminToken, { name: 'Back Again', phone: '078' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: body.id, active: true, phone: '078' });
    expect((await listSuppliers(adminToken)).body).toHaveLength(1);
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

  test('records the lot with its supplier and cost', async () => {
    const p = await makeProduct({ stock: 0 });
    const { body: sup } = await newSupplier(adminToken, { name: 'Batch Supplier' });
    await receive(adminToken, { product_id: p.id, supplier_id: sup.id, qty: 5, cost: 9 });

    const rows = (await request(app).get('/api/batches').set(...auth(adminToken))).body;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product: p.name, supplier: 'Batch Supplier' });
    expect(Number(rows[0].qty)).toBe(5);
  });

  test('logs the restock against the receiving user', async () => {
    const p = await makeProduct({ stock: 10 });
    await receive(adminToken, { product_id: p.id, qty: 5 });

    // The audit row commits in the SAME transaction as the stock bump — no waiting, and
    // no window in which stock has moved but nothing says who moved it.
    const { rows } = await db.query("select * from stock_log where kind = 'restock'");
    expect(rows).toHaveLength(1);
    expect(rows[0].changed_by).toBe('test_admin');
    expect(Number(rows[0].old_qty)).toBe(10);
    expect(Number(rows[0].new_qty)).toBe(15);
  });

  test('an unknown product is a 404, and writes nothing', async () => {
    // This used to fall through to `rows[0] && ...`: a 200 with stock null and an audit
    // row full of nulls, for a delivery against a product that does not exist.
    const res = await receive(adminToken, { product_id: 999999, qty: 5 });
    expect(res.status).toBe(404);
    expect((await db.query('select count(*)::int as n from batches')).rows[0].n).toBe(0);
    expect((await db.query("select count(*)::int as n from stock_log where kind='restock'")).rows[0].n).toBe(0);
  });

  test('refuses a negative cost', async () => {
    const p = await makeProduct({ stock: 10 });
    const res = await receive(adminToken, { product_id: p.id, qty: 5, cost: -100 });
    expect(res.status).toBe(400);
    expect(await stockOf(p.id)).toBe(10);
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

// A liquor store's stock does not date-expire, so batch expiry — the column, the endpoint,
// the alert panel and the AI dimension — was removed in migration 0007. These pin that it
// stays gone, rather than being quietly reintroduced by a merge from the grocery template.
describe('no expiry tracking', () => {
  test('the expiry endpoint no longer exists', async () => {
    expect((await request(app).get('/api/expiry').set(...auth(adminToken))).status).toBe(404);
  });

  test('the batches table has no expiry column', async () => {
    const { rows } = await db.query(
      "select 1 from information_schema.columns where table_name='batches' and column_name='expiry'"
    );
    expect(rows).toHaveLength(0);
  });

  test('an expiry sent by an old client is ignored, not an error', async () => {
    const p = await makeProduct({ stock: 0 });
    const res = await receive(adminToken, { product_id: p.id, qty: 4, expiry: '2027-01-31' });
    expect(res.status).toBe(200);
    expect(await stockOf(p.id)).toBe(4);
  });
});
