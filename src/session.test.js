// The boot-time session decision. See src/session.js for why it is a separate module.
import {
  sessionAction, readCachedUser,
  SESSION_LOGOUT, SESSION_OFFLINE, SESSION_LOGIN,
} from './session';

const CASHIER = { username: 'cashier', role: 'user', allowed_views: ['sales', 'history'] };

describe('a server that answers and rejects us', () => {
  // Whenever the server can be reached it is the authority, and "no" means no.
  test('401 signs the user out even with a cached user available', () => {
    const err = Object.assign(new Error('session'), { status: 401 });
    expect(sessionAction(err, CASHIER)).toBe(SESSION_LOGOUT);
  });

  test('403 signs the user out', () => {
    expect(sessionAction(Object.assign(new Error('forbidden'), { status: 403 }), CASHIER))
      .toBe(SESSION_LOGOUT);
  });

  test('a 500 signs the user out too — it answered, so it is reachable', () => {
    // Staying signed in here would be guessing about a server we can plainly talk to.
    expect(sessionAction(Object.assign(new Error('server'), { status: 500 }), CASHIER))
      .toBe(SESSION_LOGOUT);
  });
});

describe('a server that cannot be reached', () => {
  // The case this module exists for: the shop's internet drops, a till reloads, and the
  // cashier must NOT be dumped on a login screen that cannot reach the server either.
  test('a bare network error with a cached user keeps the session', () => {
    expect(sessionAction(new TypeError('Failed to fetch'), CASHIER)).toBe(SESSION_OFFLINE);
  });

  test('an aborted/timed-out request keeps the session', () => {
    expect(sessionAction(new DOMException('aborted', 'AbortError'), CASHIER))
      .toBe(SESSION_OFFLINE);
  });

  test('no cached user means there is nothing to restore', () => {
    // This browser has never completed a login, so there is no offline mode to enter.
    expect(sessionAction(new TypeError('Failed to fetch'), null)).toBe(SESSION_LOGIN);
  });

  test('a cached object without a username is not a user', () => {
    expect(sessionAction(new TypeError('Failed to fetch'), { role: 'admin' }))
      .toBe(SESSION_LOGIN);
  });

  test('a status of undefined is treated as unreachable, not as a rejection', () => {
    // Guards the discriminator itself: api.js sets .status only on a real response.
    const err = Object.assign(new Error('boom'), { status: undefined });
    expect(sessionAction(err, CASHIER)).toBe(SESSION_OFFLINE);
  });

  test('a string status is not a response — an HTTP status is a number', () => {
    const err = Object.assign(new Error('boom'), { status: '401' });
    expect(sessionAction(err, CASHIER)).toBe(SESSION_OFFLINE);
  });
});

describe('reading the cached user out of localStorage', () => {
  // It is localStorage: it can be absent, truncated by a full quota, or hand-edited.
  test('round-trips a real user', () => {
    expect(readCachedUser(JSON.stringify(CASHIER))).toEqual(CASHIER);
  });

  test.each([
    ['null', null],
    ['empty', ''],
    ['truncated JSON', '{"username":"cash'],
    ['not an object', '"cashier"'],
    ['a JSON null', 'null'],
    ['an object with no username', '{"role":"admin"}'],
  ])('%s reads as no cached user', (_label, raw) => {
    expect(readCachedUser(raw)).toBeNull();
  });

  test('a hand-edited entry cannot invent a session on its own', () => {
    // It restores a NAME, not authority: the token is the credential and the API
    // re-authorises every request, so a forged cache buys a screen and no data.
    const forged = readCachedUser('{"username":"owner","role":"admin"}');
    expect(forged.username).toBe('owner');
    expect(sessionAction(new TypeError('Failed to fetch'), forged)).toBe(SESSION_OFFLINE);
  });
});
