// Structured logging + 5xx alerting.
//
// The properties worth holding: an alert storm can't mute the on-call channel, a failing
// webhook can't take down the request that triggered it, and no request body — passwords on
// /auth/login, PII on /customers — ever reaches a log line or an alert payload.
const request = require('supertest');
const { seedUsers, login, auth, app, db } = require('./helpers');

const realFetch = global.fetch;

beforeEach(() => {
  jest.resetModules();
  process.env.ALERT_WEBHOOK_URL = 'https://alerts.example/hook';
  process.env.ALERT_MIN_GAP_MS = '60000';
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.ALERT_WEBHOOK_URL;
  delete process.env.ALERT_MIN_GAP_MS;
});

afterAll(() => db.pool.end());

// Fresh module per test so the dedupe map and env are not shared between cases.
const freshLogger = () => require('../logger');

describe('alerting', () => {
  test('posts to the configured webhook', async () => {
    const { alert } = freshLogger();
    await alert('something broke', { route: '/api/orders', error: 'boom' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://alerts.example/hook');
    expect(JSON.parse(init.body).text).toMatch(/something broke/);
  });

  test('sends nothing when no webhook is configured', async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    jest.resetModules();
    const { alert } = freshLogger();
    await alert('unnoticed', { error: 'boom' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('collapses a storm of the same error into one alert', async () => {
    // A failing dependency throws identically on every request. Firing 500 times gets the
    // channel muted by whoever owns the phone, which is worse than not alerting.
    const { alert } = freshLogger();
    for (let i = 0; i < 25; i++) await alert('db down', { route: '/api/orders', error: 'ECONNREFUSED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('still alerts separately for a different failure', async () => {
    const { alert } = freshLogger();
    await alert('a', { route: '/api/orders', error: 'ECONNREFUSED' });
    await alert('b', { route: '/api/products', error: 'syntax error' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a webhook that fails does not throw into the caller', async () => {
    global.fetch = jest.fn(async () => { throw new Error('alert host unreachable'); });
    const { alert } = freshLogger();
    await expect(alert('boom', { error: 'x' })).resolves.toBeUndefined();
  });

  test('a webhook that hangs does not hang the process', async () => {
    global.fetch = jest.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { alert } = freshLogger();
    await expect(alert('boom', { error: 'x' })).resolves.toBeUndefined();
  }, 10000);
});

describe('request logging', () => {
  let token;
  beforeAll(async () => {
    await seedUsers();
    token = await login('admin');
  });

  test('tags every response with a request id', async () => {
    const res = await request(app).get('/api/products').set(...auth(token));
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f]{8}$/);
  });

  test('gives each request its own id', async () => {
    const a = await request(app).get('/api/products').set(...auth(token));
    const b = await request(app).get('/api/products').set(...auth(token));
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  test('tags unauthenticated requests too, so a 401 can still be traced', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(401);
    expect(res.headers['x-request-id']).toBeDefined();
  });
});

describe('secrets never reach the logs', () => {
  test('a login attempt logs no password', async () => {
    // requestLogger records method/route/status only. If it ever starts logging bodies,
    // every cashier password lands in Docker's log driver in plain text.
    process.env.LOG_IN_TESTS = '1';
    jest.resetModules();
    const lines = [];
    const spyOut = jest.spyOn(console, 'log').mockImplementation((l) => lines.push(l));
    const spyErr = jest.spyOn(console, 'error').mockImplementation((l) => lines.push(l));
    try {
      const freshApp = require('../index');
      await request(freshApp).post('/api/auth/login')
        .send({ username: 'test_admin', password: 'test_admin_pw' });

      const all = lines.join('\n');
      expect(all).toMatch(/\/api\/auth\/login/);      // the request WAS logged
      expect(all).not.toMatch(/test_admin_pw/);       // the password was not
    } finally {
      spyOut.mockRestore();
      spyErr.mockRestore();
      delete process.env.LOG_IN_TESTS;
      jest.resetModules();
    }
  });
});
