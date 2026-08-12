// /api/customers, /api/admin-log, /api/users
//
// The auth levels here are split deliberately — anyone may APPEND (a cashier saves a
// customer at checkout, any action lands in the audit log) but only an admin may READ,
// because customer rows are PII and the audit log is what an owner checks staff against.
// User management is admin-only throughout and must never leak a password hash.
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { seedUsers, login, auth, app, db } = require('./helpers');

let adminToken;
let cashierToken;
let adminId;

beforeAll(async () => {
  await seedUsers();
  adminToken = await login('admin');
  cashierToken = await login('cashier');
  const { rows } = await db.query("select id from app_users where username = 'test_admin'");
  adminId = rows[0].id;
});

beforeEach(async () => {
  await db.query('delete from customers');
  await db.query('delete from admin_log');
  await db.query("delete from app_users where username like 'made_%'");
});

afterAll(() => db.pool.end());

describe('customers (PII)', () => {
  const save = (token, body) => request(app).post('/api/customers').set(...auth(token)).send(body);
  const read = (token) => request(app).get('/api/customers').set(...auth(token));

  test('a cashier can save a customer at checkout', async () => {
    const res = await save(cashierToken, { order_id: 'ord-1', name: 'Sami', mobile: '0790000000' });
    expect(res.body).toEqual({ ok: true });
  });

  test('a cashier cannot read the customer list back', async () => {
    await save(cashierToken, { order_id: 'ord-1', name: 'Sami', mobile: '0790000000' });
    const res = await read(cashierToken);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_admin' });
  });

  test('an admin can read the list, newest first', async () => {
    await save(cashierToken, { order_id: 'ord-1', name: 'First' });
    await save(cashierToken, { order_id: 'ord-2', name: 'Second' });
    const res = await read(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.map((c) => c.name)).toEqual(['Second', 'First']);
  });

  test('stores blank name and mobile as null rather than empty strings', async () => {
    await save(cashierToken, { order_id: 'ord-3', name: '', mobile: '' });
    const { rows } = await db.query('select name, mobile from customers');
    expect(rows[0]).toEqual({ name: null, mobile: null });
  });

  test('requires a session to save', async () => {
    expect((await request(app).post('/api/customers').send({ name: 'X' })).status).toBe(401);
  });
});

describe('admin log (audit)', () => {
  // The API no longer accepts appends (12 Aug audit); the server writes these rows itself, so
  // the read tests below seed the table the way the server does.
  const append = (token, body) => request(app).post('/api/admin-log').set(...auth(token)).send(body);
  const seed = (action, actor = 'test_admin') =>
    db.query('insert into admin_log (action, actor) values ($1,$2)', [action, actor]);
  const read = (token, qs = '') => request(app).get(`/api/admin-log${qs}`).set(...auth(token));

  test('POST /admin-log no longer exists (12 Aug audit)', async () => {
    // Any session could append arbitrary text to the audit trail. Server-side writes remain.
    expect((await append(cashierToken, { action: 'opened the drawer' })).status).toBe(404);
  });

  test('a cashier cannot read the audit log', async () => {
    expect((await read(cashierToken)).status).toBe(403);
  });

  test('returns entries oldest-first for display', async () => {
    await seed('first');
    await seed('second');
    const rows = (await read(adminToken)).body;
    expect(rows.map((r) => r.action)).toEqual(['first', 'second']);
  });

  test('?limit keeps the most recent entries', async () => {
    for (const action of ['a', 'b', 'c']) await seed(action);
    const rows = (await read(adminToken, '?limit=2')).body;
    expect(rows.map((r) => r.action)).toEqual(['b', 'c']);
  });

  test('ignores a junk limit', async () => {
    await seed('only');
    expect((await read(adminToken, '?limit=abc')).body).toHaveLength(1);
  });
});

describe('user management', () => {
  const listUsers = (token) => request(app).get('/api/users').set(...auth(token));
  const createUser = (token, body) => request(app).post('/api/users').set(...auth(token)).send(body);

  const NEW_USER = { username: 'made_user', password: 'a-good-password', role: 'user', views: ['sales'] };

  test('is closed to non-admins across the board', async () => {
    expect((await listUsers(cashierToken)).status).toBe(403);
    expect((await createUser(cashierToken, NEW_USER)).status).toBe(403);
    expect((await request(app).put(`/api/users/${adminId}`).set(...auth(cashierToken)).send({ role: 'admin' })).status).toBe(403);
    expect((await request(app).delete(`/api/users/${adminId}`).set(...auth(cashierToken))).status).toBe(403);
  });

  test('never exposes a password hash or session token', async () => {
    const res = await listUsers(adminToken);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\$2[aby]\$/);
    expect(res.body[0].pass_hash).toBeUndefined();
    expect(res.body[0].session_token).toBeUndefined();
  });

  test('creates a user who can then log in', async () => {
    const res = await createUser(adminToken, NEW_USER);
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();

    const login = await request(app).post('/api/auth/login')
      .send({ username: NEW_USER.username, password: NEW_USER.password });
    expect(login.status).toBe(200);
    expect(login.body.allowed_views).toEqual(['sales']);
  });

  test('stores the password hashed, never in the clear', async () => {
    await createUser(adminToken, NEW_USER);
    const { rows } = await db.query('select pass_hash from app_users where username = $1', [NEW_USER.username]);
    expect(rows[0].pass_hash).not.toBe(NEW_USER.password);
    expect(bcrypt.compareSync(NEW_USER.password, rows[0].pass_hash)).toBe(true);
  });

  test('enforces a minimum password length', async () => {
    const res = await createUser(adminToken, { ...NEW_USER, password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_short' });
  });

  test('refuses a duplicate username', async () => {
    await createUser(adminToken, NEW_USER);
    const res = await createUser(adminToken, NEW_USER);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'exists' });
  });

  test('refuses a duplicate that differs only in case', async () => {
    await createUser(adminToken, NEW_USER);
    const res = await createUser(adminToken, { ...NEW_USER, username: 'MADE_USER' });
    expect(res.body).toEqual({ error: 'exists' });
  });

  test('lowercases the username on create', async () => {
    await createUser(adminToken, { ...NEW_USER, username: 'Made_Mixed' });
    const { rows } = await db.query("select username from app_users where username = 'made_mixed'");
    expect(rows).toHaveLength(1);
  });

  test('updates role and views', async () => {
    const { body } = await createUser(adminToken, NEW_USER);
    await request(app).put(`/api/users/${body.id}`).set(...auth(adminToken))
      .send({ role: 'admin', views: ['sales', 'reports'] });

    const { rows } = await db.query('select role, allowed_views from app_users where id = $1', [body.id]);
    expect(rows[0].role).toBe('admin');
    expect(rows[0].allowed_views).toEqual(['sales', 'reports']);
  });

  test('an update omitting a field leaves it unchanged', async () => {
    const { body } = await createUser(adminToken, NEW_USER);
    await request(app).put(`/api/users/${body.id}`).set(...auth(adminToken)).send({ email: 'a@b.c' });
    const { rows } = await db.query('select role, allowed_views from app_users where id = $1', [body.id]);
    expect(rows[0].role).toBe('user');
    expect(rows[0].allowed_views).toEqual(['sales']);
  });

  test('deactivating a user stops them logging in', async () => {
    const { body } = await createUser(adminToken, NEW_USER);
    await request(app).put(`/api/users/${body.id}`).set(...auth(adminToken)).send({ active: false });

    const res = await request(app).post('/api/auth/login')
      .send({ username: NEW_USER.username, password: NEW_USER.password });
    expect(res.status).toBe(401);
  });

  test('refuses a rename that collides with another user', async () => {
    const { body } = await createUser(adminToken, NEW_USER);
    await createUser(adminToken, { ...NEW_USER, username: 'made_other' });
    const res = await request(app).put(`/api/users/${body.id}`).set(...auth(adminToken))
      .send({ username: 'made_other' });
    expect(res.body).toEqual({ error: 'exists' });
  });

  test('deletes a user', async () => {
    const { body } = await createUser(adminToken, NEW_USER);
    expect((await request(app).delete(`/api/users/${body.id}`).set(...auth(adminToken))).body).toEqual({ ok: true });
    const { rows } = await db.query('select 1 from app_users where id = $1', [body.id]);
    expect(rows).toHaveLength(0);
  });

  test('an admin cannot delete themselves', async () => {
    // Deleting the last admin would lock the shop out of its own POS.
    const res = await request(app).delete(`/api/users/${adminId}`).set(...auth(adminToken));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'self' });
  });

  test('the self-guard is not bypassable with a non-canonical uuid', async () => {
    const res = await request(app).delete(`/api/users/${adminId.toUpperCase()}`).set(...auth(adminToken));
    expect(res.body).toEqual({ error: 'self' });
  });

  test('a malformed uuid is a 400, not a 500', async () => {
    const res = await request(app).delete('/api/users/not-a-uuid').set(...auth(adminToken));
    expect(res.status).toBe(400);
  });
});

describe('admin password reset', () => {
  const reset = (token, id, body) =>
    request(app).post(`/api/users/${id}/reset-password`).set(...auth(token)).send(body);

  let targetId;
  beforeEach(async () => {
    const { body } = await request(app).post('/api/users').set(...auth(adminToken))
      .send({ username: 'made_target', password: 'original-password', role: 'user' });
    targetId = body.id;
  });

  test('sets a new working password', async () => {
    expect((await reset(adminToken, targetId, { new: 'brand-new-password' })).body).toEqual({ ok: true });
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'made_target', password: 'brand-new-password' });
    expect(res.status).toBe(200);
  });

  test('the old password stops working', async () => {
    await reset(adminToken, targetId, { new: 'brand-new-password' });
    const res = await request(app).post('/api/auth/login')
      .send({ username: 'made_target', password: 'original-password' });
    expect(res.status).toBe(401);
  });

  test('kills the target\'s active session', async () => {
    // A reset happens because an account may be compromised; leaving the existing token
    // alive would defeat the point.
    const victim = (await request(app).post('/api/auth/login')
      .send({ username: 'made_target', password: 'original-password' })).body.token;
    expect((await request(app).get('/api/products').set(...auth(victim))).status).toBe(200);

    await reset(adminToken, targetId, { new: 'brand-new-password' });
    expect((await request(app).get('/api/products').set(...auth(victim))).status).toBe(401);
  });

  test('enforces the minimum length', async () => {
    const res = await reset(adminToken, targetId, { new: 'short' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_short' });
  });

  test('a cashier cannot reset anyone\'s password', async () => {
    expect((await reset(cashierToken, targetId, { new: 'brand-new-password' })).status).toBe(403);
  });
});
