// The password-reset code stays capped even when the login lockout is switched off.
//
// Kan runs (ran) with AUTH_LOCK_MAX_FAILS=0, because the shipped 5-strikes/15-minutes locked a
// barista out for a quarter of an hour over one mistyped password. That switch used to govern
// BOTH counters, so turning it off also removed the only cap on `confirm-reset` — a six-digit
// code with a fifteen-minute life. A million possibilities is nothing to guess at machine
// speed, and the per-IP limiter that was supposed to be the backstop turned out to be
// bypassable with a forged X-Forwarded-For header.
//
// So the reset counter now has its own floor that AUTH_LOCK_MAX_FAILS cannot reach. This file
// loads a FRESH copy of server/auth.js with the lockout disabled and checks both halves: login
// failures are not counted, reset failures still lock.
const { db } = require('./helpers');

const KEY_LOGIN = 'test-floor-login';
const KEY_RESET = 'reset:test-floor-user';

// A private module registry per case, so the module-scope constants in auth.js are read with
// the env this test sets rather than the one setupEnv.js pinned for everybody else.
function authWith(env) {
  let mod;
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  jest.isolateModules(() => { mod = require('../auth'); });
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  return mod;
}

const failsFor = async (key) => {
  const { rows } = await db.query('select fails, locked_until from pin_attempts where id = $1', [key]);
  return rows[0] || null;
};

beforeEach(() => db.query('delete from pin_attempts where id = any($1)', [[KEY_LOGIN, KEY_RESET]]));
afterAll(() => db.pool.end());

describe('with the login lockout DISABLED (AUTH_LOCK_MAX_FAILS=0)', () => {
  const env = { AUTH_LOCK_MAX_FAILS: '0', AUTH_RESET_MAX_FAILS: '5', AUTH_RESET_LOCK_MINUTES: '15' };

  test('login failures are not counted at all — the shop asked for that', async () => {
    const auth = authWith(env);
    for (let i = 0; i < 12; i++) await auth.recordFail(KEY_LOGIN);
    expect(await failsFor(KEY_LOGIN)).toBeNull();
    expect((await auth.checkLock(KEY_LOGIN)).locked).toBe(false);
  });

  test('reset-code failures ARE counted, and lock on the fifth', async () => {
    const auth = authWith(env);
    for (let i = 0; i < 4; i++) await auth.recordFail(KEY_RESET);
    expect((await auth.checkLock(KEY_RESET)).locked).toBe(false);   // four is not yet a lock

    await auth.recordFail(KEY_RESET);
    const lock = await auth.checkLock(KEY_RESET);
    expect(lock.locked).toBe(true);
    expect(lock.retry_after_s).toBeGreaterThan(0);
  });

  test('the reset floor cannot itself be switched off with a zero', async () => {
    // envInt(...) || 5 — a 0 here would otherwise reopen exactly the hole this file is about.
    const auth = authWith({ ...env, AUTH_RESET_MAX_FAILS: '0' });
    for (let i = 0; i < 5; i++) await auth.recordFail(KEY_RESET);
    expect((await auth.checkLock(KEY_RESET)).locked).toBe(true);
  });
});

describe('with the login lockout enabled', () => {
  test('login failures lock on the configured count', async () => {
    const auth = authWith({ AUTH_LOCK_MAX_FAILS: '3', AUTH_LOCK_MINUTES: '2' });
    for (let i = 0; i < 2; i++) await auth.recordFail(KEY_LOGIN);
    expect((await auth.checkLock(KEY_LOGIN)).locked).toBe(false);

    await auth.recordFail(KEY_LOGIN);
    expect((await auth.checkLock(KEY_LOGIN)).locked).toBe(true);
  });

  test('a successful login clears the counter', async () => {
    const auth = authWith({ AUTH_LOCK_MAX_FAILS: '3', AUTH_LOCK_MINUTES: '2' });
    await auth.recordFail(KEY_LOGIN);
    await auth.recordFail(KEY_LOGIN);
    await auth.clearFails(KEY_LOGIN);
    // The row is zeroed, not deleted — so the next wrong password starts from one again
    // rather than from where the last near-miss left off.
    expect(await failsFor(KEY_LOGIN)).toMatchObject({ fails: 0, locked_until: null });
    expect((await auth.checkLock(KEY_LOGIN)).locked).toBe(false);
  });
});

describe('the shipped defaults are the retuned ones', () => {
  test('ten strikes and two minutes, not five and fifteen', async () => {
    // The old defaults are why the shop turned the lockout off. If someone restores them, a
    // mistyped password costs a quarter of an hour at the counter again.
    const auth = authWith({
      AUTH_LOCK_MAX_FAILS: undefined, AUTH_LOCK_MINUTES: undefined,
    });
    for (let i = 0; i < 9; i++) await auth.recordFail(KEY_LOGIN);
    expect((await auth.checkLock(KEY_LOGIN)).locked).toBe(false);   // nine is still a human

    await auth.recordFail(KEY_LOGIN);
    const lock = await auth.checkLock(KEY_LOGIN);
    expect(lock.locked).toBe(true);
    // A range, not an exact second: locked_until is `now() + 2 minutes` computed by Postgres
    // at transaction start, and retry_after_s rounds UP, so 121 is normal under load. What
    // matters is that it is minutes-not-a-quarter-hour.
    expect(lock.retry_after_s).toBeGreaterThan(60);
    expect(lock.retry_after_s).toBeLessThan(5 * 60);
  });
});
