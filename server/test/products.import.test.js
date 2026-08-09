// POST /api/products/import — bulk catalogue import.
//
// This is the highest-risk write path in the app: one call rewrites prices across the
// whole catalogue. The tests below hold the three properties that make it safe —
// admin-only, all-or-nothing, and fully attributable.
const request = require('supertest');
const { seedUsers, login, auth, clearCatalogue, app, db } = require('./helpers');

let adminToken;
let cashierToken;
let stockistToken;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
  stockistToken = await login('stockist');
});

beforeEach(clearCatalogue);
afterAll(() => db.pool.end());

const post = (token, body) =>
  request(app).post('/api/products/import').set(...auth(token)).send(body);

const item = (over = {}) => ({
  barcode: '6291000000001', name: 'Test Whiskey 700ml',
  price: 24.5, cost: 17, stock: 12, cat: 'Whiskey', unit: 'ea', active: true, ...over,
});

describe('authorization', () => {
  test('rejects an unauthenticated caller', async () => {
    const res = await request(app).post('/api/products/import').send({ items: [item()] });
    expect(res.status).toBe(401);
  });

  test('rejects a cashier', async () => {
    const res = await post(cashierToken, { items: [item()] });
    expect(res.status).toBe(403);
  });

  test('rejects a non-admin who merely holds the inventory view', async () => {
    // The inventory view is enough to adjust one product's stock; it is deliberately NOT
    // enough to reprice the catalogue in bulk.
    const res = await post(stockistToken, { items: [item()] });
    expect(res.status).toBe(403);
  });

  test('writes nothing when authorization fails', async () => {
    await post(cashierToken, { items: [item()] });
    const { rows } = await db.query('select count(*)::int as n from products');
    expect(rows[0].n).toBe(0);
  });

  test('accepts an admin', async () => {
    const res = await post(adminToken, { items: [item()] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, created: 1, updated: 0, total: 1 });
  });
});

describe('payload validation', () => {
  const badPayloads = {
    'items missing': {},
    'items not an array': { items: 'nope' },
    'items empty': { items: [] },
  };
  for (const [label, body] of Object.entries(badPayloads)) {
    test(`rejects ${label}`, async () => {
      const res = await post(adminToken, body);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  }

  const badItems = {
    'a blank name': { name: '   ' },
    'a name over 200 chars': { name: 'x'.repeat(201) },
    'a negative price': { price: -1 },
    'a negative stock': { stock: -5 },
    'a non-numeric price': { price: 'free' },
    'a barcode with spaces': { barcode: '62 91 00' },
    'a barcode with a semicolon': { barcode: '629;drop' },
  };
  for (const [label, over] of Object.entries(badItems)) {
    test(`rejects ${label}`, async () => {
      const res = await post(adminToken, { items: [item(over)] });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid' });
    });
  }

  test('rejects a payload over the row cap', async () => {
    const items = Array.from({ length: 5001 }, (_, i) => item({ barcode: `bulk-${i}` }));
    const res = await post(adminToken, { items });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'too_many_rows' });
  });

  test('re-validates server-side even though the client already validated', async () => {
    // A hand-rolled request bypassing src/csv.js entirely must still be rejected.
    const res = await post(adminToken, { items: [{ name: 'Sneaky', price: -999 }] });
    expect(res.status).toBe(400);
    const { rows } = await db.query('select count(*)::int as n from products');
    expect(rows[0].n).toBe(0);
  });
});

describe('field coercion', () => {
  test('stores an item with all fields intact', async () => {
    await post(adminToken, { items: [item()] });
    const { rows } = await db.query('select * from products where barcode = $1', ['6291000000001']);
    expect(rows[0]).toMatchObject({
      name: 'Test Whiskey 700ml', cat: 'Whiskey', unit: 'ea', active: true,
    });
    expect(Number(rows[0].price)).toBe(24.5);
    expect(Number(rows[0].cost)).toBe(17);
    expect(Number(rows[0].stock)).toBe(12);
  });

  test('defaults missing numbers to zero', async () => {
    await post(adminToken, { items: [{ name: 'Bare Minimum' }] });
    const { rows } = await db.query("select * from products where name = 'Bare Minimum'");
    expect(Number(rows[0].price)).toBe(0);
    expect(Number(rows[0].cost)).toBe(0);
    expect(Number(rows[0].stock)).toBe(0);
  });

  test('treats a blank barcode as null rather than an empty string', async () => {
    // Empty strings would collide on the UNIQUE index and break the second such row.
    const res = await post(adminToken, {
      items: [{ name: 'No Code A', barcode: '' }, { name: 'No Code B', barcode: '   ' }],
    });
    expect(res.status).toBe(200);
    const { rows } = await db.query('select barcode from products order by name');
    expect(rows.map((r) => r.barcode)).toEqual([null, null]);
  });

  test('coerces an unknown unit to ea instead of writing it through', async () => {
    await post(adminToken, { items: [item({ unit: 'litre' })] });
    const { rows } = await db.query('select unit from products');
    expect(rows[0].unit).toBe('ea');
  });

  test('honours active: false', async () => {
    await post(adminToken, { items: [item({ active: false })] });
    const { rows } = await db.query('select active from products');
    expect(rows[0].active).toBe(false);
  });

  test('truncates an over-long category rather than failing the import', async () => {
    await post(adminToken, { items: [item({ cat: 'c'.repeat(300) })] });
    const { rows } = await db.query('select cat from products');
    expect(rows[0].cat).toHaveLength(100);
  });
});

describe('upsert mode', () => {
  test('updates the existing row on a barcode match instead of duplicating it', async () => {
    await post(adminToken, { items: [item()] });
    const res = await post(adminToken, { items: [item({ name: 'Renamed', price: 30, stock: 40 })] });

    expect(res.body).toMatchObject({ created: 0, updated: 1 });
    const { rows } = await db.query('select * from products');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Renamed');
    expect(Number(rows[0].price)).toBe(30);
    expect(Number(rows[0].stock)).toBe(40);
  });

  test('counts creates and updates separately in one call', async () => {
    await post(adminToken, { items: [item()] });
    const res = await post(adminToken, {
      items: [item({ price: 26 }), item({ barcode: '6291000000002', name: 'New Gin' })],
    });
    expect(res.body).toMatchObject({ created: 1, updated: 1, total: 2 });
  });

  test('rows without a barcode always insert, never merge onto each other', async () => {
    await post(adminToken, { items: [{ name: 'Loose A' }, { name: 'Loose B' }] });
    const res = await post(adminToken, { items: [{ name: 'Loose A' }] });
    expect(res.body).toMatchObject({ created: 1, updated: 0 });
    const { rows } = await db.query('select count(*)::int as n from products');
    expect(rows[0].n).toBe(3);
  });
});

describe('insert mode', () => {
  test('refuses the whole file when a barcode already exists', async () => {
    await post(adminToken, { items: [item()] });
    const res = await post(adminToken, { mode: 'insert', items: [item({ name: 'Dupe' })] });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'exists' });
  });

  test('leaves the existing row untouched after that refusal', async () => {
    await post(adminToken, { items: [item()] });
    await post(adminToken, { mode: 'insert', items: [item({ name: 'Dupe', price: 999 })] });
    const { rows } = await db.query('select name, price from products');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Test Whiskey 700ml');
    expect(Number(rows[0].price)).toBe(24.5);
  });

  test('rejects a barcode duplicated inside the same payload', async () => {
    const res = await post(adminToken, {
      mode: 'insert', items: [item(), item({ name: 'Same Code' })],
    });
    expect(res.status).toBe(409);
  });
});

describe('atomicity', () => {
  test('a failure part-way through rolls the whole import back', async () => {
    await post(adminToken, { items: [item()] });          // seed the conflict
    const res = await post(adminToken, {
      mode: 'insert',
      items: [
        item({ barcode: 'ROLLBACK-1', name: 'Should Vanish 1' }),
        item({ barcode: 'ROLLBACK-2', name: 'Should Vanish 2' }),
        item({ name: 'Conflicts With Seed' }),             // duplicate barcode → 409
      ],
    });

    expect(res.status).toBe(409);
    const { rows } = await db.query("select count(*)::int as n from products where barcode like 'ROLLBACK-%'");
    expect(rows[0].n).toBe(0);
  });

  test('rolls the audit log back too, so no orphan stock_log rows survive', async () => {
    await post(adminToken, { items: [item()] });
    await db.query('delete from stock_log');
    await post(adminToken, {
      mode: 'insert',
      items: [item({ barcode: 'ROLLBACK-3', name: 'Ghost' }), item({ name: 'Conflict' })],
    });
    const { rows } = await db.query("select count(*)::int as n from stock_log where name = 'Ghost'");
    expect(rows[0].n).toBe(0);
  });
});

describe('audit trail', () => {
  test('logs a create with a zero opening quantity', async () => {
    await post(adminToken, { items: [item({ stock: 12 })] });
    const { rows } = await db.query('select * from stock_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'create', changed_by: 'test_admin' });
    expect(Number(rows[0].old_qty)).toBe(0);
    expect(Number(rows[0].new_qty)).toBe(12);
  });

  test('logs an update with the real before/after stock', async () => {
    await post(adminToken, { items: [item({ stock: 12 })] });
    await db.query('delete from stock_log');
    await post(adminToken, { items: [item({ stock: 30 })] });

    const { rows } = await db.query('select * from stock_log');
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('import');
    expect(Number(rows[0].old_qty)).toBe(12);
    expect(Number(rows[0].new_qty)).toBe(30);
  });

  test('attributes every row to the session user, never to the payload', async () => {
    // A caller cannot author the record of their own import.
    await post(adminToken, { items: [item({ changed_by: 'somebody_else' })] });
    const { rows } = await db.query('select changed_by from stock_log');
    expect(rows[0].changed_by).toBe('test_admin');
  });

  test('writes one audit row per imported product', async () => {
    await post(adminToken, {
      items: [item(), item({ barcode: '6291000000002', name: 'Gin' }), { name: 'Loose' }],
    });
    const { rows } = await db.query('select count(*)::int as n from stock_log');
    expect(rows[0].n).toBe(3);
  });
});

describe('imported catalogue is usable', () => {
  test('an imported barcode resolves on the scan path', async () => {
    await post(adminToken, { items: [item({ barcode: '6291000000009', name: 'Scannable' })] });
    const res = await request(app)
      .get('/api/products/barcode/6291000000009')
      .set(...auth(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Scannable');
  });

  test('imported products appear in the catalogue listing', async () => {
    await post(adminToken, { items: [item(), item({ barcode: '6291000000003', name: 'Second' })] });
    const res = await request(app).get('/api/products').set(...auth(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.name).sort()).toEqual(['Second', 'Test Whiskey 700ml']);
  });
});
