// /api/timeclock/* — staff punch their own clock; the hours listing is payroll data.
//
// Two properties matter: a user can only ever punch THEIR OWN clock (the user id comes
// from the session, never the request), and the hours listing — which is what wages are
// paid from — is not readable by an ordinary cashier.
const request = require('supertest');
const { seedUsers, login, auth, app, db } = require('./helpers');

let adminToken;
let cashierToken;
let reporterToken;
let cashierId;

beforeAll(async () => {
  await seedUsers();
  await db.query("update app_users set allowed_views = '{sales,reports}' where username = 'test_stockist'");
  adminToken = await login('admin');
  cashierToken = await login('cashier');
  reporterToken = await login('stockist');
  const { rows } = await db.query("select id from app_users where username = 'test_cashier'");
  cashierId = rows[0].id;
});

beforeEach(() => db.query('delete from time_clock'));
afterAll(() => db.pool.end());

const status = (token) => request(app).get('/api/timeclock/status').set(...auth(token));
const punchIn = (token, body = {}) => request(app).post('/api/timeclock/in').set(...auth(token)).send(body);
const punchOut = (token) => request(app).post('/api/timeclock/out').set(...auth(token)).send({});
const list = (token, qs = '') => request(app).get(`/api/timeclock${qs}`).set(...auth(token));

describe('punching in and out', () => {
  test('status is null before the first punch', async () => {
    const res = await status(cashierToken);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  test('clocking in opens a punch the caller can see', async () => {
    expect((await punchIn(cashierToken)).body).toEqual({ ok: true });
    const res = await status(cashierToken);
    expect(res.body.clock_in).toEqual(expect.any(String));
    expect(res.body.id).toBeDefined();
  });

  test('clocking in twice does not open a second punch', async () => {
    await punchIn(cashierToken);
    const second = await punchIn(cashierToken);

    expect(second.body).toMatchObject({ ok: true, already: true });
    const { rows } = await db.query('select count(*)::int as n from time_clock where clock_out is null');
    expect(rows[0].n).toBe(1);
  });

  test('clocking out closes the punch', async () => {
    await punchIn(cashierToken);
    expect((await punchOut(cashierToken)).body).toEqual({ ok: true });
    expect((await status(cashierToken)).body).toBeNull();

    const { rows } = await db.query('select clock_out from time_clock');
    expect(rows[0].clock_out).not.toBeNull();
  });

  test('clocking out without being clocked in is refused', async () => {
    const res = await punchOut(cashierToken);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'not_clocked_in' });
  });

  test('a full in/out cycle can be repeated', async () => {
    await punchIn(cashierToken);
    await punchOut(cashierToken);
    expect((await punchIn(cashierToken)).body).toEqual({ ok: true });

    const { rows } = await db.query('select count(*)::int as n from time_clock');
    expect(rows[0].n).toBe(2);
  });

  test('records the punch against the session user', async () => {
    await punchIn(cashierToken);
    const { rows } = await db.query('select user_id, username from time_clock');
    expect(rows[0].username).toBe('test_cashier');
    expect(rows[0].user_id).toBe(cashierId);
  });

  test('a caller cannot punch someone else in by naming them in the body', async () => {
    await punchIn(cashierToken, { user_id: '00000000-0000-0000-0000-000000000000', username: 'test_admin' });
    const { rows } = await db.query('select username from time_clock');
    expect(rows[0].username).toBe('test_cashier');
  });

  test('each user has an independent clock', async () => {
    await punchIn(cashierToken);
    expect((await status(adminToken)).body).toBeNull();

    await punchIn(adminToken);
    const { rows } = await db.query('select count(*)::int as n from time_clock where clock_out is null');
    expect(rows[0].n).toBe(2);
  });

  test('clocking out closes only the caller\'s punch', async () => {
    await punchIn(cashierToken);
    await punchIn(adminToken);
    await punchOut(adminToken);

    expect((await status(cashierToken)).body).not.toBeNull();
    expect((await status(adminToken)).body).toBeNull();
  });

  test('all punch endpoints require a session', async () => {
    expect((await request(app).get('/api/timeclock/status')).status).toBe(401);
    expect((await request(app).post('/api/timeclock/in')).status).toBe(401);
    expect((await request(app).post('/api/timeclock/out')).status).toBe(401);
  });
});

describe('hours listing (payroll)', () => {
  test('a cashier cannot read the hours of the whole shop', async () => {
    const res = await list(cashierToken);
    expect(res.status).toBe(403);
  });

  test('a non-admin with the reports view can', async () => {
    expect((await list(reporterToken)).status).toBe(200);
  });

  test('an admin can', async () => {
    expect((await list(adminToken)).status).toBe(200);
  });

  test('requires a session', async () => {
    expect((await request(app).get('/api/timeclock')).status).toBe(401);
  });

  test('computes hours for a closed punch', async () => {
    await db.query(
      `insert into time_clock (user_id, username, clock_in, clock_out)
       values ($1, 'test_cashier', now() - interval '3 hours', now())`,
      [cashierId]
    );
    const rows = (await list(adminToken)).body;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].hours)).toBeCloseTo(3, 1);
  });

  test('counts an open punch as hours worked so far', async () => {
    await db.query(
      `insert into time_clock (user_id, username, clock_in)
       values ($1, 'test_cashier', now() - interval '2 hours')`,
      [cashierId]
    );
    const rows = (await list(adminToken)).body;
    expect(rows[0].clock_out).toBeNull();
    expect(Number(rows[0].hours)).toBeCloseTo(2, 1);
  });

  test('returns punches newest first', async () => {
    await db.query(
      `insert into time_clock (user_id, username, clock_in, clock_out) values
        ($1, 'older', now() - interval '2 days', now() - interval '2 days' + interval '1 hour'),
        ($1, 'newer', now() - interval '1 day',  now() - interval '1 day'  + interval '1 hour')`,
      [cashierId]
    );
    const rows = (await list(adminToken)).body;
    expect(rows.map((r) => r.username)).toEqual(['newer', 'older']);
  });

  test('honours a from/to window, inclusive of the end day', async () => {
    await db.query(
      `insert into time_clock (user_id, username, clock_in, clock_out) values
        ($1, 'in_window',  timestamptz '2026-03-10 09:00', timestamptz '2026-03-10 17:00'),
        ($1, 'out_window', timestamptz '2026-04-10 09:00', timestamptz '2026-04-10 17:00')`,
      [cashierId]
    );
    const rows = (await list(adminToken, '?from=2026-03-01&to=2026-03-10')).body;
    expect(rows.map((r) => r.username)).toEqual(['in_window']);
  });

  test('returns an empty array when nobody has punched', async () => {
    expect((await list(adminToken)).body).toEqual([]);
  });
});
