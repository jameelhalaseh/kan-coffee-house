// /api/auth/* and the session middleware.
//
// Everything else in the app trusts these two claims: "this request has a valid session"
// and "this session is allowed to do that". The tests below pin the behaviours that make
// those claims true — single active session, no sliding expiry, lockout that does not leak
// which usernames exist, and no token accepted from anywhere but the Bearer header.
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { seedUsers, login, auth, USERS, app, db } = require('./helpers');

// The session token is stored as SHA-256 (migration 0010), so a test that reaches into
// app_users has to look it up the same way the server does.
const stored = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

beforeAll(seedUsers);
afterAll(() => db.pool.end());

// Lockout state is global per username, so clear it between tests.
beforeEach(() => db.query('delete from pin_attempts'));

const doLogin = (username, password) =>
  request(app).post('/api/auth/login').send({ username, password });

const admin = USERS.admin;
const cashier = USERS.cashier;

describe('login', () => {
  test('returns a session token and the user record', async () => {
    const res = await doLogin(admin.username, admin.password);
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body).toMatchObject({ username: admin.username, role: 'admin' });
  });

  test('never returns the password hash', async () => {
    const res = await doLogin(admin.username, admin.password);
    expect(res.body.pass_hash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);   // no bcrypt hash anywhere
  });

  test('rejects a wrong password', async () => {
    const res = await doLogin(admin.username, 'wrong-password');
    expect(res.status).toBe(401);
    expect(res.body.token).toBeUndefined();
  });

  test('rejects an unknown user with the same shape as a wrong password', async () => {
    // Different responses here would enumerate valid usernames.
    const unknown = await doLogin('no_such_user', 'whatever');
    const wrong = await doLogin(admin.username, 'wrong-password');
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
  });

  test('is case-insensitive on the username', async () => {
    const res = await doLogin(admin.username.toUpperCase(), admin.password);
    expect(res.status).toBe(200);
  });

  test('rejects an inactive user', async () => {
    await db.query("update app_users set active = false where username = $1", [cashier.username]);
    const res = await doLogin(cashier.username, cashier.password);
    expect(res.status).toBe(401);
    await db.query("update app_users set active = true where username = $1", [cashier.username]);
  });

  test('logging in again invalidates the previous session', async () => {
    // Single active session per user: a token left on a shared till stops working the
    // moment that user logs in somewhere else.
    const first = (await doLogin(admin.username, admin.password)).body.token;
    const second = (await doLogin(admin.username, admin.password)).body.token;
    expect(second).not.toBe(first);

    const stale = await request(app).get('/api/products').set(...auth(first));
    expect(stale.status).toBe(401);
    const fresh = await request(app).get('/api/products').set(...auth(second));
    expect(fresh.status).toBe(200);
  });
});

describe('lockout', () => {
  test('locks the username after repeated failures', async () => {
    let res;
    for (let i = 0; i < 12; i++) res = await doLogin(cashier.username, 'wrong-password');
    expect(res.body).toMatchObject({ error: 'locked' });
    expect(res.body.retry_after_s).toEqual(expect.any(Number));
  });

  test('a locked username is refused even with the correct password', async () => {
    for (let i = 0; i < 12; i++) await doLogin(cashier.username, 'wrong-password');
    const res = await doLogin(cashier.username, cashier.password);
    expect(res.body).toMatchObject({ error: 'locked' });
  });

  test('counts failures for unknown usernames too', async () => {
    // Otherwise "this one can be locked" reveals that the account exists.
    let res;
    for (let i = 0; i < 12; i++) res = await doLogin('ghost_user', 'wrong-password');
    expect(res.body).toMatchObject({ error: 'locked' });
  });

  test('a successful login clears the failure count', async () => {
    for (let i = 0; i < 3; i++) await doLogin(cashier.username, 'wrong-password');
    expect((await doLogin(cashier.username, cashier.password)).status).toBe(200);
    const { rows } = await db.query("select fails from pin_attempts where id = $1", ['login:' + cashier.username]);
    expect(Number(rows[0].fails)).toBe(0);
  });
});

describe('token transport', () => {
  let token;
  beforeEach(async () => { token = await login('admin'); });

  test('accepts the token in the Authorization header', async () => {
    expect((await request(app).get('/api/products').set(...auth(token))).status).toBe(200);
  });

  test('is case-insensitive about the Bearer keyword', async () => {
    const res = await request(app).get('/api/products').set('Authorization', `bearer ${token}`);
    expect(res.status).toBe(200);
  });

  test('rejects a token passed in the query string', async () => {
    // Tokens in URLs end up in router logs, proxies and browser history.
    const res = await request(app).get(`/api/products?p_token=${token}`);
    expect(res.status).toBe(401);
  });

  test('rejects a token passed in the body', async () => {
    const res = await request(app).post('/api/products').send({ name: 'X', p_token: token });
    expect(res.status).toBe(401);
  });

  test('rejects a malformed Authorization header', async () => {
    const res = await request(app).get('/api/products').set('Authorization', token);
    expect(res.status).toBe(401);
  });

  test('rejects a made-up token', async () => {
    const res = await request(app).get('/api/products').set(...auth('not-a-real-token'));
    expect(res.status).toBe(401);
  });
});

describe('session expiry', () => {
  test('an expired token is refused', async () => {
    const token = await login('admin');
    await db.query('update app_users set token_exp = now() - interval \'1 minute\' where session_token = $1', [stored(token)]);
    const res = await request(app).get('/api/products').set(...auth(token));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'session' });
  });

  test('using a session does NOT extend its expiry', async () => {
    // No sliding TTL: a till left logged in overnight still expires on schedule.
    const token = await login('admin');
    const before = (await db.query('select token_exp from app_users where session_token = $1', [stored(token)])).rows[0].token_exp;
    await request(app).get('/api/products').set(...auth(token));
    const after = (await db.query('select token_exp from app_users where session_token = $1', [stored(token)])).rows[0].token_exp;
    expect(after).toEqual(before);
  });
});

describe('logout', () => {
  test('invalidates the token', async () => {
    const token = await login('admin');
    const res = await request(app).post('/api/auth/logout').set(...auth(token)).send({});
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/products').set(...auth(token))).status).toBe(401);
  });

  test('is idempotent and safe with a junk token', async () => {
    expect((await request(app).post('/api/auth/logout').set(...auth('junk')).send({})).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').send({})).status).toBe(200);
  });
});

describe('change password', () => {
  const CHANGED = 'changed_password_1';

  afterEach(async () => {
    // Put the fixture password back so later tests still log in.
    await db.query('update app_users set pass_hash = $1 where username = $2',
      [bcrypt.hashSync(cashier.password, 4), cashier.username]);
  });

  test('changes the password with the correct current one', async () => {
    const token = await login('cashier');
    const res = await request(app).post('/api/auth/change-password')
      .set(...auth(token)).send({ old: cashier.password, new: CHANGED });
    expect(res.body).toEqual({ ok: true });
    expect((await doLogin(cashier.username, CHANGED)).status).toBe(200);
  });

  test('refuses a wrong current password', async () => {
    const token = await login('cashier');
    const res = await request(app).post('/api/auth/change-password')
      .set(...auth(token)).send({ old: 'nope', new: CHANGED });
    expect(res.body).toMatchObject({ error: 'wrong_old' });
    expect((await doLogin(cashier.username, cashier.password)).status).toBe(200);
  });

  test('enforces a minimum length', async () => {
    const token = await login('cashier');
    const res = await request(app).post('/api/auth/change-password')
      .set(...auth(token)).send({ old: cashier.password, new: 'short' });
    expect(res.body).toMatchObject({ error: 'too_short' });
  });

  test('refuses without a valid session', async () => {
    const res = await request(app).post('/api/auth/change-password')
      .set(...auth('junk')).send({ old: cashier.password, new: CHANGED });
    expect(res.body).toMatchObject({ error: 'session' });
  });
});

describe('role and view enforcement', () => {
  test('a non-admin is refused an admin-only route', async () => {
    const token = await login('cashier');
    const res = await request(app).delete('/api/products/1').set(...auth(token));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'not_admin' });
  });

  test('an admin bypasses the view whitelist', async () => {
    const token = await login('admin');
    // The admin fixture has an EMPTY allowed_views; role alone must be enough.
    expect((await request(app).get('/api/orders?floor=main').set(...auth(token))).status).toBe(200);
  });

  test('a non-admin needs the specific view', async () => {
    await db.query("update app_users set allowed_views = '{sales}' where username = $1", [USERS.stockist.username]);
    const token = await login('stockist');
    expect((await request(app).get('/api/orders?floor=main').set(...auth(token))).status).toBe(403);

    await db.query("update app_users set allowed_views = '{sales,history}' where username = $1", [USERS.stockist.username]);
    const token2 = await login('stockist');
    expect((await request(app).get('/api/orders?floor=main').set(...auth(token2))).status).toBe(200);
  });

  test('allowed_views cannot be raised by the client', async () => {
    // The middleware reads the DB row, never the request body.
    await db.query("update app_users set allowed_views = '{sales}' where username = $1", [USERS.stockist.username]);
    const token = await login('stockist');
    const res = await request(app)
      .get('/api/orders?floor=main')
      .set(...auth(token))
      .send({ allowed_views: ['history', 'reports'], role: 'admin' });
    expect(res.status).toBe(403);
  });

  test('the history view does NOT unlock aggregated revenue reports', async () => {
    // Regression guard. The reports gate used to accept 'history', so the demo cashier —
    // who holds it to see their own receipts — could also read revenue, margin and
    // Z-report figures, contradicting both the README and the route's own header.
    const token = await login('cashier');   // allowed_views = sales, history
    const res = await request(app).get('/api/reports/summary').set(...auth(token));
    expect(res.status).toBe(403);
  });

  test('a cashier can still read their own sales history', async () => {
    // The tightened reports gate must not cost the cashier the history screen itself.
    const token = await login('cashier');
    expect((await request(app).get('/api/orders?floor=main').set(...auth(token))).status).toBe(200);
  });
});

describe('unmatched API routes', () => {
  test('return JSON 404, not the React shell', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
