// Regression tests for the 12 Aug 2026 security audit.
//
// Each of these reproduces a finding as it was exploited, and asserts the fix. They exist so
// that re-opening any of these holes fails the build rather than shipping quietly.
const crypto = require('crypto');
const request = require('supertest');
const { seedUsers, login, auth, makeProduct, app, db } = require('./helpers');

let adminToken, cashierToken, stockistToken;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');       // views: sales, history
  stockistToken = await login('stockist');     // views: sales, inventory
});
afterAll(() => db.pool.end());

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

describe('F-01 — stock cannot be written through the product edit route', () => {
  const edit = (token, p, over = {}) => request(app).put(`/api/products/${p.id}`).set(...auth(token))
    .send({ name: p.name, price: p.price, cost: p.cost ?? 0, barcode: p.barcode ?? null,
      cat: p.cat ?? null, unit: 'ea', stock: p.stock, ...over });

  test('a sales-only cashier is refused, and the stock does not move', async () => {
    const p = await makeProduct({ name: 'F01 Bottle', price: 10, stock: 5 });
    const res = await edit(cashierToken, { ...p, stock: 5 }, { stock: 9999 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'admin_only' });

    const { rows } = await db.query('select stock from products where id = $1', [p.id]);
    expect(Number(rows[0].stock)).toBe(5);
  });

  test('and no stock_log row is invented on the way', async () => {
    const p = await makeProduct({ name: 'F01 Ghost', price: 10, stock: 5 });
    await edit(cashierToken, { ...p, stock: 5 }, { stock: 4242 });
    const { rows } = await db.query('select count(*)::int n from stock_log where item_id = $1', [String(p.id)]);
    expect(rows[0].n).toBe(0);
  });

  test('the gated route is still the way in — an admin may adjust', async () => {
    const p = await makeProduct({ name: 'F01 Legit', price: 10, stock: 5 });
    expect((await request(app).patch(`/api/products/${p.id}/stock`).set(...auth(adminToken))
      .send({ delta: 3 })).status).toBe(200);
    const { rows } = await db.query('select stock from products where id = $1', [p.id]);
    expect(Number(rows[0].stock)).toBe(8);
  });

  test('an edit that leaves stock alone still works for a non-admin', async () => {
    // The fix must not stop a cashier fixing a typo in a product name.
    const p = await makeProduct({ name: 'F01 Typo', price: 10, stock: 7 });
    const res = await edit(cashierToken, { ...p, stock: 7 }, { name: 'F01 Fixed' });
    expect(res.status).toBe(200);
  });
});

describe('F-02 — receiving stock requires the inventory grant', () => {
  test('a sales-only cashier cannot receive a delivery', async () => {
    const p = await makeProduct({ name: 'F02 Bottle', price: 10, stock: 2 });
    const res = await request(app).post('/api/batches').set(...auth(cashierToken))
      .send({ product_id: p.id, qty: 100, cost: 1 });
    expect(res.status).toBe(403);
    const { rows } = await db.query('select stock from products where id = $1', [p.id]);
    expect(Number(rows[0].stock)).toBe(2);
  });

  test('a stockist still can — the Receive screen keeps working', async () => {
    const p = await makeProduct({ name: 'F02 Delivery', price: 10, stock: 2 });
    const res = await request(app).post('/api/batches').set(...auth(stockistToken))
      .send({ product_id: p.id, qty: 6, cost: 4 });
    expect(res.status).toBe(200);
    const { rows } = await db.query('select stock from products where id = $1', [p.id]);
    expect(Number(rows[0].stock)).toBe(8);
  });

  test('supplier records are gated the same way', async () => {
    expect((await request(app).post('/api/suppliers').set(...auth(cashierToken))
      .send({ name: 'F02 Supplier' })).status).toBe(403);
  });
});

describe('F-03 — the audit trail is not client-writable', () => {
  test('POST /stock-log is gone', async () => {
    expect((await request(app).post('/api/stock-log').set(...auth(cashierToken))
      .send({ kind: 'adjust', item_id: '1', name: 'ghost', new_qty: 999 })).status).toBe(404);
  });

  test('POST /admin-log is gone', async () => {
    expect((await request(app).post('/api/admin-log').set(...auth(adminToken))
      .send({ action: 'anything' })).status).toBe(404);
  });

  test('reading the admin log is still admin-only', async () => {
    expect((await request(app).get('/api/admin-log').set(...auth(cashierToken))).status).toBe(403);
    expect((await request(app).get('/api/admin-log').set(...auth(adminToken))).status).toBe(200);
  });
});

describe('F-05 — session secrets are hashed at rest', () => {
  // Logging in again REVOKES the previous token (one session per user, by design), so these
  // tests mint their own and hand the shared ones back afterwards.
  afterAll(async () => {
    adminToken = await login('admin');
    cashierToken = await login('cashier');
  });

  test('the database never holds the bearer token', async () => {
    const token = await login('admin');
    const { rows } = await db.query(
      'select session_token from app_users where username = $1', ['test_admin']);
    expect(rows[0].session_token).not.toBe(token);
    expect(rows[0].session_token).toBe(sha(token));
    expect(rows[0].session_token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a stolen database row cannot be replayed as a token', async () => {
    await login('admin');
    const { rows } = await db.query(
      'select session_token from app_users where username = $1', ['test_admin']);
    // The attacker sends exactly what the table contains.
    const res = await request(app).get('/api/products').set('Authorization', `Bearer ${rows[0].session_token}`);
    expect(res.status).toBe(401);
  });

  test('the real token still works, and logout still revokes it', async () => {
    const token = await login('cashier');
    expect((await request(app).get('/api/products').set(...auth(token))).status).toBe(200);
    await request(app).post('/api/auth/logout').set(...auth(token));
    expect((await request(app).get('/api/products').set(...auth(token))).status).toBe(401);
  });

  test('validate returns the caller\'s token, not the stored hash', async () => {
    const token = await login('admin');
    const res = await request(app).get('/api/auth/validate').set(...auth(token));
    expect(res.status).toBe(200);
    expect(res.body.token).toBe(token);
  });
});

describe('F-07 — malformed input is the caller\'s error, not a server fault', () => {
  test('a NUL byte in a barcode is a 400, not a 500', async () => {
    const res = await request(app).get('/api/products/barcode/%00').set(...auth(cashierToken));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid' });
  });

  test('an over-long barcode is refused before it reaches the database', async () => {
    const res = await request(app).get(`/api/products/barcode/${'9'.repeat(80)}`).set(...auth(cashierToken));
    expect(res.status).toBe(400);
  });

  test('a normal miss is still a clean 404', async () => {
    expect((await request(app).get('/api/products/barcode/6291000999999').set(...auth(cashierToken))).status).toBe(404);
  });
});
