// Auth + session model for the Kan Coffee House POS API.
//
// Faithful port of the Supabase RPCs (AUTH_SETUP.sql / SECURITY_HARDENING.sql):
//   * Session = an opaque random token stored in app_users.session_token (NOT a JWT).
//   * Single active session per user (a new login overwrites the prior token).
//   * IDLE expiry (default 30 days), renewed by use — see SESSION_IDLE_HOURS below.
//   * Passwords are bcrypt; bcryptjs verifies pgcrypto's $2a$ hashes unchanged.
//   * allowed_views is CLIENT-SIDE UI gating only — data routes require a valid
//     session (any role); only admin routes require role='admin'.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { sendResetCode, emailConfigured } = require('./email');

// Mask an email for display: ab***@example.com (never reveals the full address client-side).
function maskEmail(email) {
  return String(email || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
}

// ── Session lifetime: IDLE, not fixed ────────────────────────────────────────
// This used to be a hard 12h from login, which expired mid-shift by design — a cashier who
// signed in at 09:00 was thrown out at 21:00, in the middle of the busiest hours, with a
// customer at the counter. Worse, it did so on the schedule of when they happened to log in
// rather than anything about the shop.
//
// It is now an IDLE window: every authenticated request pushes the expiry out, so a till in
// daily use never logs out at all. What still expires is a session nobody is using — a
// tablet left in a drawer, or one that walked out of the shop. That is the property worth
// keeping, and the only one the old timer actually bought.
//
// The renewal is throttled to at most one write per half-window (see touchSession), so this
// costs an UPDATE roughly every fifteen days per till rather than one per request.
const _idle = parseInt(process.env.SESSION_IDLE_HOURS, 10);
const _legacy = parseInt(process.env.SESSION_TTL_HOURS, 10);   // pre-sliding name
const IDLE_HOURS = Number.isFinite(_idle) && _idle > 0 ? _idle
  : Number.isFinite(_legacy) && _legacy > 0 ? _legacy
  : 24 * 30;                                  // 30 days
// 0/NaN/negative are rejected above rather than honoured: they would mint tokens that are
// already expired, locking every user out of a shop with one typo in an .env.

// SESSION_TTL_HOURS still works, but it no longer means what its name says — a deployment
// carrying `SESSION_TTL_HOURS=12` from the old model would silently get a 12-hour IDLE
// window, which is not what anyone reading that line would expect. Say so once at boot.
if (!Number.isFinite(_idle) && Number.isFinite(_legacy) && _legacy > 0) {
  console.warn(JSON.stringify({
    level: 'warn',
    msg: 'SESSION_TTL_HOURS is deprecated and now means IDLE hours, not a fixed lifetime — '
       + 'sessions renew on use. Rename it to SESSION_IDLE_HOURS.',
    idle_hours: IDLE_HOURS,
  }));
}

// Kept as the old export name so nothing downstream breaks; it is the idle window now.
const TTL_HOURS = IDLE_HOURS;

const newToken = () => crypto.randomBytes(24).toString('hex'); // 48 hex chars (mirrors encode(gen_random_bytes(24),'hex'))

// ── Secrets at rest ──────────────────────────────────────────────────────────
// The session token and the reset code are BEARER SECRETS: whoever holds one is the user.
// Until the audit of 12 Aug they were stored verbatim, so anyone who could read the database
// — a backup file, a support dump, a future read-only bug — could take over every live
// session or complete a password reset without touching the mailbox.
//
// Now only their SHA-256 lands in the database. The plaintext exists in the client's
// localStorage and in transit, and nowhere else. sha256 (not bcrypt) is the right primitive
// here: these are 192 bits of crypto-random, so there is nothing to brute-force and the
// lookup stays a single indexed comparison on every request.
//
// The reset code is the weaker case and honestly so: 6 digits is only 10^6 preimages, so the
// hash protects against casual disclosure rather than a determined offline attack. What
// actually guards it is the 15-minute expiry plus the per-username lockout.
const hashSecret = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

// Shape returned to the client on login/validate — never includes pass_hash/session_token-as-secret.
function userJson(u, token) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    allowed_views: u.allowed_views,
    token,
  };
}

// ── Per-identity lockout (pin_attempts) ──────────────────────────────────────
// express-rate-limit throttles per IP, which a handful of hosts defeats. This locks the
// USERNAME, so distributing the attack across IPs buys nothing.
//
// The counter is keyed on the submitted username whether or not that user exists —
// otherwise "locked" vs "invalid" would itself enumerate accounts.
// Both are env-overridable, following the pattern index.js already uses for the rate limits.
// The defaults are unchanged, so a deployment that sets neither behaves exactly as before.
//
// AUTH_LOCK_MAX_FAILS=0 DISABLES the lockout for LOGIN. It exists because the shipped 5-fails
// / 15-minutes was genuinely unusable at a counter: one mistyped password cost a barista a
// quarter of an hour with a queue in front of them, so the shop turned it off — and turning it
// off left password guessing capped only by a per-IP rate limit that (see index.js) was itself
// bypassable with one header.
//
// The defaults are therefore retuned rather than restored. 10 consecutive failures is not a
// typo, and 2 minutes is a pause rather than a shift-stopper. That keeps the protection the
// shop actually needs while removing the reason it was switched off.
//
// The RESET-CODE cap is deliberately NOT part of that switch — see RESET_MAX_FAILS below.
const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
};
const MAX_FAILS = envInt('AUTH_LOCK_MAX_FAILS', 10);
const LOCK_MINUTES = envInt('AUTH_LOCK_MINUTES', 2) || 2;
const LOCKOUT_DISABLED = MAX_FAILS === 0;

// A password-reset code is SIX DIGITS with a fifteen-minute life: one million possibilities,
// which is nothing to guess at machine speed. Its only cap used to be the login lockout, so
// setting AUTH_LOCK_MAX_FAILS=0 for counter convenience silently removed the brute-force
// protection from the admin account-recovery path as well. That is not a trade any shop would
// knowingly make, so this floor applies even when the login lockout is off. It is tunable but
// cannot be switched off: envInt(...) || 5 turns a 0 into 5.
const RESET_MAX_FAILS = envInt('AUTH_RESET_MAX_FAILS', 5) || 5;
const RESET_LOCK_MINUTES = envInt('AUTH_RESET_LOCK_MINUTES', 15) || 15;

// The reset path passes its own key ('reset:<username>'); everything else uses the login
// settings. Keeping the choice in one predicate means neither call site can forget it.
const isResetKey = (key) => String(key).startsWith('reset:');
const limitsFor = (key) => (isResetKey(key)
  ? { max: RESET_MAX_FAILS, minutes: RESET_LOCK_MINUTES, enforced: true }
  : { max: MAX_FAILS, minutes: LOCK_MINUTES, enforced: !LOCKOUT_DISABLED });

// Said once at boot rather than left silent. A shop running without brute-force protection
// should be discoverable from its logs, not only by reading the .env it was started with.
if (LOCKOUT_DISABLED) {
  console.warn(JSON.stringify({
    level: 'warn',
    msg: 'AUTH_LOCK_MAX_FAILS=0 - per-username lockout is DISABLED for login. Wrong passwords '
       + 'are not counted and no account can lock. Only the per-IP rate limit remains. '
       + 'Password-reset codes are still capped.',
  }));
}

// Returns { locked: true, retry_after_s } while a lock is in force. An EXPIRED lock is
// cleared here so the next attempt starts from a clean counter.
async function checkLock(key) {
  if (!limitsFor(key).enforced) return { locked: false };
  const { rows } = await db.query('select fails, locked_until from pin_attempts where id = $1', [key]);
  const r = rows[0];
  if (!r || !r.locked_until) return { locked: false };
  const msLeft = new Date(r.locked_until).getTime() - Date.now();
  if (msLeft > 0) return { locked: true, retry_after_s: Math.ceil(msLeft / 1000) };
  await db.query('update pin_attempts set fails = 0, locked_until = null where id = $1', [key]);
  return { locked: false };
}

// Count a failure; arm the lock on the Nth consecutive one.
async function recordFail(key) {
  const { max, minutes, enforced } = limitsFor(key);
  if (!enforced) return;
  await db.query(
    `insert into pin_attempts (id, fails, locked_until) values ($1, 1, null)
     on conflict (id) do update set
       fails = pin_attempts.fails + 1,
       locked_until = case when pin_attempts.fails + 1 >= $2
                           then now() + make_interval(mins => $3)
                           else pin_attempts.locked_until end`,
    [key, max, minutes]
  );
}

const clearFails = (key) =>
  db.query('update pin_attempts set fails = 0, locked_until = null where id = $1', [key]);

// ── app_login ────────────────────────────────────────────────────────────────
// Returns userJson on success, null on bad credentials, or { error:'locked' } while the
// username is locked out.
async function loginUser(username, password) {
  const uname = String(username || '').trim().toLowerCase();
  const key = 'login:' + uname;

  const lock = await checkLock(key);
  if (lock.locked) return { error: 'locked', retry_after_s: lock.retry_after_s };

  const { rows } = await db.query(
    'select * from app_users where username = lower($1) and active',
    [uname]
  );
  const u = rows[0];
  // Count the failure for unknown users too — otherwise an attacker learns which usernames
  // are real by seeing which ones can be locked.
  if (!u) { await recordFail(key); return null; }
  if (!bcrypt.compareSync(String(password || ''), u.pass_hash)) { await recordFail(key); return null; }

  await clearFails(key);
  const token = newToken();
  await db.query(
    'update app_users set session_token = $1, token_exp = now() + make_interval(hours => $2) where id = $3',
    [hashSecret(token), TTL_HOURS, u.id]
  );
  // The caller gets the PLAINTEXT once, here. It is never readable from the database again.
  return userJson(u, token);
}

// Push a live session's expiry back out to a full idle window.
//
// Throttled: only when less than HALF the window is left. Renewing on every request would
// mean a database write per API call — a sale is ~5 calls, and thirty shops share one
// Postgres — to move a deadline that is thirty days away. Half-window renewal keeps the
// guarantee identical (a session in use never lapses) at roughly one write per fortnight.
//
// Never throws: a failure here must not turn a good request into a 500. The worst case of a
// missed renewal is that the session expires on time, which is the old behaviour.
async function touchSession(tokenHash, expiresAt) {
  try {
    const halfway = Date.now() + (IDLE_HOURS * 3600 * 1000) / 2;
    if (expiresAt && new Date(expiresAt).getTime() > halfway) return;
    await db.query(
      'update app_users set token_exp = now() + make_interval(hours => $1) where session_token = $2',
      [IDLE_HOURS, tokenHash]
    );
  } catch (_) { /* renewal is best-effort; the session remains valid until it lapses */ }
}

// ── app_validate (renews the idle window) ────────────────────────────────────
async function validateToken(token) {
  if (!token) return null;
  const hash = hashSecret(token);
  const { rows } = await db.query(
    'select * from app_users where session_token = $1 and token_exp > now() and active',
    [hash]
  );
  const u = rows[0];
  // Opening the app is use. Without this, a till that is only ever reloaded — rather than
  // making API calls — would still lapse.
  if (u) await touchSession(hash, u.token_exp);
  // Echo back the token the CALLER sent, not the column: the column is now a hash, and
  // returning it would hand the client a credential that does not work.
  return u ? userJson(u, token) : null;
}

// ── app_logout (idempotent, unauthenticated) ─────────────────────────────────
async function logoutToken(token) {
  if (token) await db.query('update app_users set session_token = null where session_token = $1', [hashSecret(token)]);
  return { ok: true };
}

// ── app_change_password ──────────────────────────────────────────────────────
async function changePassword(token, oldPw, newPw) {
  const { rows } = await db.query(
    'select * from app_users where session_token = $1 and token_exp > now() and active',
    [hashSecret(token)]
  );
  const u = rows[0];
  if (!u) return { error: 'session' };
  if (!bcrypt.compareSync(String(oldPw || ''), u.pass_hash)) return { error: 'wrong_old' };
  if (String(newPw || '').length < 8) return { error: 'too_short' };
  await db.query('update app_users set pass_hash = $1 where id = $2', [bcrypt.hashSync(String(newPw), 10), u.id]);
  return { ok: true };
}

// ── app_request_admin_reset (no session; forgot-password) ─────────────────────
// SECURITY: the 6-digit code is delivered out-of-band to the admin's own inbox
// (server-side EmailJS) and is NEVER returned in the HTTP response. The caller only
// learns a masked form of the destination email. This closes the prior account-takeover
// where any unauthenticated caller received the code directly.
//
// ENUMERATION: the response is identical whether or not the username exists, is an admin,
// or has an email on file — always { ok:true, email_masked:<masked|null> }. Previously the
// distinct no_admin / no_email errors let an unauthenticated caller map valid admin
// accounts. `email_not_configured` is still surfaced because it is a property of the
// deployment, identical for every username, so it leaks nothing.
async function requestReset(username) {
  if (!emailConfigured()) return { error: 'email_not_configured' };
  const { rows } = await db.query(
    "select * from app_users where username = lower($1) and role = 'admin' and active",
    [String(username || '')]
  );
  const u = rows[0];
  const silentOk = { ok: true, email_masked: null, username: String(username || '') };
  if (!u) return silentOk;
  if (!u.email) return silentOk;

  // crypto.randomInt, NOT Math.random(): this is a password-reset secret. V8's Math.random
  // is xorshift128+ — its internal state is recoverable from a handful of observed outputs,
  // so anyone able to trigger resets could predict the next code and take over an admin.
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Send BEFORE persisting the code so a delivery failure never arms a confirm-reset.
  try {
    await sendResetCode(u.email, code, u.username);
  } catch (e) {
    // Logged loudly, but reported to the caller as the same silent ok: a delivery failure
    // only ever happens for a username that EXISTS and HAS an email, so surfacing it would
    // reopen the enumeration hole. Watch the server log for this one.
    console.error('[auth] reset email send failed:', e && e.message ? e.message : e);
    return silentOk;
  }
  await db.query(
    "update app_users set reset_code = $1, reset_exp = now() + interval '15 minutes' where id = $2",
    [hashSecret(code), u.id]
  );
  return { ok: true, email_masked: maskEmail(u.email), username: u.username };
}

// ── app_confirm_reset (no session; clears token to force re-login) ────────────
// The code is only 6 digits, so without a cap it is guessable inside the 15-minute window.
// Failures are counted per username and lock after MAX_FAILS, independent of source IP.
// A wrong username returns the same 'bad_code' as a wrong code (no enumeration).
async function confirmReset(username, code, newPw) {
  const uname = String(username || '').trim().toLowerCase();
  const key = 'reset:' + uname;

  const lock = await checkLock(key);
  if (lock.locked) return { error: 'locked', retry_after_s: lock.retry_after_s };

  const { rows } = await db.query(
    'select * from app_users where username = lower($1) and active',
    [uname]
  );
  const u = rows[0];
  if (!u) { await recordFail(key); return { error: 'bad_code' }; }
  // timingSafeEqual over the hashes: equal-length buffers, so no early-exit on the first
  // differing character.
  const supplied = Buffer.from(hashSecret(code), 'hex');
  const stored = u.reset_code && /^[0-9a-f]{64}$/.test(u.reset_code) ? Buffer.from(u.reset_code, 'hex') : null;
  const codeOk = !!stored && crypto.timingSafeEqual(supplied, stored);
  if (!u.reset_code || new Date(u.reset_exp).getTime() < Date.now() || !codeOk) {
    await recordFail(key);
    return { error: 'bad_code' };
  }
  // Correct code: stop counting before the password-policy check, so a short new password
  // doesn't burn attempts against a user who already proved possession of the code.
  await clearFails(key);
  if (String(newPw || '').length < 8) return { error: 'too_short' };
  await db.query(
    'update app_users set pass_hash = $1, reset_code = null, reset_exp = null, session_token = null where id = $2',
    [bcrypt.hashSync(String(newPw), 10), u.id]
  );
  return { ok: true };
}

// ── Token transport: Authorization: Bearer <token> ONLY.
// The legacy p_token query/body fallback was removed: tokens in URLs leak into
// Heroku router logs, proxies and browser history. The client only ever sends the
// Bearer header (src/api.js), so this is transparent to the app.
function getToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ── Middleware: requireSession (mirrors _app_session) ─────────────────────────
async function requireSession(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) return res.status(401).json({ error: 'session' });
    const hash = hashSecret(token);
    const { rows } = await db.query(
      'select id, username, email, role, allowed_views, token_exp from app_users where session_token = $1 and token_exp > now() and active',
      [hash]
    );
    if (!rows[0]) return res.status(401).json({ error: 'session' });
    req.user = rows[0];
    req.token = token;
    // Using the till is what keeps the session alive. Awaited rather than fired and
    // forgotten: an unawaited rejection here would surface as an unhandled rejection and
    // page whoever is on call, and the write is throttled to roughly one per fortnight.
    await touchSession(hash, rows[0].token_exp);
    next();
  } catch (e) {
    next(e);
  }
}

// ── Middleware: requireAdmin (mirrors _app_admin) — chain AFTER requireSession ─
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'not_admin' });
  next();
}

// ── Middleware: requireView(...keys) — chain AFTER requireSession ──────────────
// Server-side enforcement of allowed_views (previously UI-only). Admins bypass.
// A non-admin must have at least one of the listed view keys in allowed_views.
// Use to protect data that a limited operator (e.g. a "tables"-only waiter) must
// not read directly via the API — financial reports, revenue history, etc.
function requireView(...keys) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'session' });
    if (req.user.role === 'admin') return next();
    const views = Array.isArray(req.user.allowed_views) ? req.user.allowed_views : [];
    if (keys.some((k) => views.includes(k))) return next();
    return res.status(403).json({ error: 'forbidden' });
  };
}

module.exports = {
  TTL_HOURS,
  loginUser,
  validateToken,
  logoutToken,
  changePassword,
  requestReset,
  confirmReset,
  getToken,
  requireSession,
  requireAdmin,
  requireView,
  // The lockout counters, exported for server/test/resetLockFloor.test.js. That file loads a
  // fresh copy of this module under different AUTH_LOCK_* values to prove the reset-code cap
  // survives AUTH_LOCK_MAX_FAILS=0 — a property no route-level test can reach, because
  // setupEnv.js pins those values for the whole suite.
  checkLock,
  recordFail,
  clearFails,
};
