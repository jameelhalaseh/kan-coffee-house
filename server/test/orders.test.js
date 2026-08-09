// POST/GET/DELETE /api/orders + /api/invoice/next — the checkout path.
//
// The properties under test are the ones the till depends on being true even when the
// network drops mid-sale: stock and sale move together or not at all, a retried POST does
// not deduct twice, a void returns the goods, and a refund cannot exceed the original.
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
const uid = () => `test-order-${Date.now()}-${++uidCounter}`;

// A minimal well-formed order for the single `main` store.
const order = (over = {}) => ({
  id: uid(), floor: 'main', table_id: null,
  items: [], sub: 0, tax: 0, total: 0, pay: 'cash', waiter: 'test_cashier',
  date: '2026-01-01', time: '12:00:00', ...over,
});

const save = (token, body) => request(app).post('/api/orders').set(...auth(token)).send(body);

describe('store (floor) whitelist', () => {
  test('rejects an unknown floor rather than building a table name from it', async () => {
    const res = await save(cashierToken, order({ floor: 'nope' }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_floor' });
  });

  test('rejects a SQL-injection attempt in the floor key', async () => {
    const res = await save(cashierToken, order({ floor: 'main; drop table products' }));
    expect(res.status).toBe(400);
    // The catalogue is still there.
    await expect(db.query('select 1 from products')).resolves.toBeDefined();
  });

  test('rejects an order with no id', async () => {
    const res = await save(cashierToken, order({ id: '' }));
    expect(res.status).toBe(400);
  });
});

describe('checkout deducts stock atomically', () => {
  test('a sale deducts each catalogue line', async () => {
    const p = await makeProduct({ stock: 100 });
    const res = await save(cashierToken, order({
      items: [{ id: p.id, name: p.name, qty: 3, price: 10 }], total: 30,
    }));
    expect(res.status).toBe(200);
    expect(await stockOf(p.id)).toBe(97);
  });

  test('deducts across multiple lines in one sale', async () => {
    const a = await makeProduct({ name: 'A', stock: 50 });
    const b = await makeProduct({ name: 'B', stock: 20 });
    await save(cashierToken, order({
      items: [{ id: a.id, name: 'A', qty: 2, price: 10 }, { id: b.id, name: 'B', qty: 5, price: 4 }],
      total: 40,
    }));
    expect(await stockOf(a.id)).toBe(48);
    expect(await stockOf(b.id)).toBe(15);
  });

  test('ignores open-price lines, which carry a client string id and hold no stock', async () => {
    const res = await save(cashierToken, order({
      items: [{ id: 'misc-abc123', name: 'Quick item', qty: 1, price: 5 }], total: 5,
    }));
    expect(res.status).toBe(200);
    const { rows } = await db.query('select count(*)::int as n from stock_log');
    expect(rows[0].n).toBe(0);
  });

  test('a re-POST of the same order id does not deduct twice', async () => {
    // The client retries a checkout after a dropped response; stock must not move again.
    const p = await makeProduct({ stock: 100 });
    const body = order({ items: [{ id: p.id, name: p.name, qty: 4, price: 10 }], total: 40 });

    await save(cashierToken, body);
    await save(cashierToken, body);

    expect(await stockOf(p.id)).toBe(96);
    const { rows } = await db.query('select count(*)::int as n from orders_main');
    expect(rows[0].n).toBe(1);
  });

  test('writes an attributable sale row to the audit log', async () => {
    const p = await makeProduct({ stock: 10 });
    await save(cashierToken, order({ items: [{ id: p.id, name: p.name, qty: 2, price: 10 }], total: 20 }));

    const { rows } = await db.query('select * from stock_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'sale', changed_by: 'test_cashier' });
    expect(Number(rows[0].old_qty)).toBe(10);
    expect(Number(rows[0].new_qty)).toBe(8);
  });

  test('attributes the movement to the session, not the body waiter field', async () => {
    // Otherwise a cashier could stamp a colleague on the shrinkage.
    const p = await makeProduct({ stock: 10 });
    await save(cashierToken, order({
      items: [{ id: p.id, name: p.name, qty: 1, price: 10 }], total: 10, waiter: 'somebody_else',
    }));
    const { rows } = await db.query('select changed_by from stock_log');
    expect(rows[0].changed_by).toBe('test_cashier');
  });
});

describe('refunds', () => {
  test('a refund returns stock instead of deducting it', async () => {
    const p = await makeProduct({ stock: 10 });
    await save(cashierToken, order({
      status: 'refund', items: [{ id: p.id, name: p.name, qty: 2, price: 10 }], total: -20,
    }));
    expect(await stockOf(p.id)).toBe(12);
    const { rows } = await db.query('select kind from stock_log');
    expect(rows[0].kind).toBe('return');
  });

  test('refunding more than the original sale is refused', async () => {
    const p = await makeProduct({ stock: 100 });
    await save(cashierToken, order({
      invoice_no: 4001, items: [{ id: p.id, name: p.name, qty: 1, price: 10 }], total: 10,
    }));

    const res = await save(cashierToken, order({
      status: 'refund', buyer: 'return of #4001',
      items: [{ id: p.id, name: p.name, qty: 5, price: 10 }], total: -50,
    }));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'over_refund' });
  });

  test('a refused over-refund moves no stock', async () => {
    const p = await makeProduct({ stock: 100 });
    await save(cashierToken, order({
      invoice_no: 4002, items: [{ id: p.id, name: p.name, qty: 1, price: 10 }], total: 10,
    }));
    const before = await stockOf(p.id);

    await save(cashierToken, order({
      status: 'refund', buyer: 'return of #4002',
      items: [{ id: p.id, name: p.name, qty: 5, price: 10 }], total: -50,
    }));
    expect(await stockOf(p.id)).toBe(before);
  });

  test('a refund up to the original total is allowed', async () => {
    const p = await makeProduct({ stock: 100 });
    await save(cashierToken, order({
      invoice_no: 4003, items: [{ id: p.id, name: p.name, qty: 2, price: 10 }], total: 20,
    }));
    const res = await save(cashierToken, order({
      status: 'refund', buyer: 'return of #4003',
      items: [{ id: p.id, name: p.name, qty: 2, price: 10 }], total: -20,
    }));
    expect(res.status).toBe(200);
  });

  test('two partial refunds cannot together exceed the original', async () => {
    const p = await makeProduct({ stock: 100 });
    await save(cashierToken, order({
      invoice_no: 4004, items: [{ id: p.id, name: p.name, qty: 2, price: 10 }], total: 20,
    }));
    const partial = () => order({
      status: 'refund', buyer: 'return of #4004',
      items: [{ id: p.id, name: p.name, qty: 1, price: 10 }], total: -12,
    });
    expect((await save(cashierToken, partial())).status).toBe(200);
    expect((await save(cashierToken, partial())).status).toBe(400);
  });
});

describe('void (DELETE)', () => {
  const voidOrder = (token, id, body = {}) =>
    request(app).delete(`/api/orders/${id}?floor=main`).set(...auth(token)).send(body);

  test('a cashier cannot void', async () => {
    const o = order();
    await save(cashierToken, o);
    expect((await voidOrder(cashierToken, o.id)).status).toBe(403);
  });

  test('voiding keeps the row and its invoice number instead of deleting it', async () => {
    const o = order({ invoice_no: 5001 });
    await save(cashierToken, o);
    const res = await voidOrder(adminToken, o.id, { reason: 'customer walked out' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, voided: true, invoice_no: 5001 });

    const { rows } = await db.query('select * from orders_main where id = $1', [o.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('void');
    expect(rows[0].voided_at).not.toBeNull();
    expect(rows[0].voided_by).toBe('test_admin');
    expect(rows[0].void_reason).toBe('customer walked out');
  });

  test('voiding a sale returns its goods to stock', async () => {
    const p = await makeProduct({ stock: 10 });
    const o = order({ invoice_no: 5002, items: [{ id: p.id, name: p.name, qty: 3, price: 10 }], total: 30 });
    await save(cashierToken, o);
    expect(await stockOf(p.id)).toBe(7);

    await voidOrder(adminToken, o.id);
    expect(await stockOf(p.id)).toBe(10);
  });

  test('voiding a refund takes the goods back out again', async () => {
    const p = await makeProduct({ stock: 10 });
    const o = order({
      invoice_no: 5003, status: 'refund',
      items: [{ id: p.id, name: p.name, qty: 2, price: 10 }], total: -20,
    });
    await save(cashierToken, o);
    expect(await stockOf(p.id)).toBe(12);

    await voidOrder(adminToken, o.id);
    expect(await stockOf(p.id)).toBe(10);
  });

  test('voiding twice does not return the goods twice', async () => {
    const p = await makeProduct({ stock: 10 });
    const o = order({ invoice_no: 5004, items: [{ id: p.id, name: p.name, qty: 3, price: 10 }], total: 30 });
    await save(cashierToken, o);

    await voidOrder(adminToken, o.id);
    const second = await voidOrder(adminToken, o.id);

    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ already: true });
    expect(await stockOf(p.id)).toBe(10);
  });

  test('logs the void against the admin who did it', async () => {
    const p = await makeProduct({ stock: 10 });
    const o = order({ invoice_no: 5005, items: [{ id: p.id, name: p.name, qty: 1, price: 10 }], total: 10 });
    await save(cashierToken, o);
    await db.query('delete from stock_log');

    await voidOrder(adminToken, o.id);
    const { rows } = await db.query('select * from stock_log');
    expect(rows[0]).toMatchObject({ kind: 'void', changed_by: 'test_admin' });
  });

  test('404s on an unknown order', async () => {
    expect((await voidOrder(adminToken, 'no-such-order')).status).toBe(404);
  });
});

describe('invoice numbering', () => {
  const next = (token, floor = 'main') =>
    request(app).get(`/api/invoice/next?floor=${floor}`).set(...auth(token));

  test('returns a bare number', async () => {
    const res = await next(cashierToken);
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('number');
  });

  test('peeking twice yields the same number — it is max+1, not a reservation', async () => {
    // The number is only consumed when an order carrying it is saved. Two tills that peek
    // before either checks out therefore see the same number; the UNIQUE index on
    // invoice_no is what stops them both keeping it (see 'invoice_taken' below).
    const a = (await next(cashierToken)).body;
    const b = (await next(cashierToken)).body;
    expect(b).toBe(a);
  });

  test('advances once a sale has taken the number', async () => {
    const n = (await next(cashierToken)).body;
    await save(cashierToken, order({ invoice_no: n, total: 10 }));
    expect((await next(cashierToken)).body).toBe(n + 1);
  });

  test('a second sale cannot keep an invoice number already taken', async () => {
    const n = (await next(cashierToken)).body;
    await save(cashierToken, order({ invoice_no: n, total: 10 }));
    const res = await save(cashierToken, order({ invoice_no: n, total: 20 }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'invoice_taken' });
  });

  test('does not reuse the number of a voided invoice', async () => {
    // A gap-reusing numberer would hand a voided sale's number to a different sale — for a
    // tax-registered seller that is two different invoices with one number.
    const n = (await next(adminToken)).body;
    const o = order({ invoice_no: n });
    await save(cashierToken, o);
    await request(app).delete(`/api/orders/${o.id}?floor=main`).set(...auth(adminToken)).send({});

    expect((await next(adminToken)).body).toBeGreaterThan(n);
  });

  test('rejects an unknown floor', async () => {
    expect((await next(cashierToken, 'nope')).status).toBe(400);
  });
});

describe('reading history', () => {
  test('a cashier holding the history view can list orders', async () => {
    await save(cashierToken, order({ invoice_no: 6001, total: 15 }));
    const res = await request(app).get('/api/orders?floor=main').set(...auth(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  test('a session with neither history nor reports cannot read sales totals', async () => {
    await db.query(
      "update app_users set allowed_views = '{sales}' where username = 'test_stockist'"
    );
    const limited = await login('stockist');
    const res = await request(app).get('/api/orders?floor=main').set(...auth(limited));
    expect(res.status).toBe(403);
  });

  test('rejects an unknown floor on read', async () => {
    const res = await request(app).get('/api/orders?floor=nope').set(...auth(cashierToken));
    expect(res.status).toBe(400);
  });

  test('requires a session', async () => {
    expect((await request(app).get('/api/orders')).status).toBe(401);
  });
});
