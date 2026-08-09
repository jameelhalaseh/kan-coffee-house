// Auth + session model for the CashierPOS API.
//
// Faithful port of the Supabase RPCs (AUTH_SETUP.sql / SECURITY_HARDENING.sql):
//   * Session = an opaque random token stored in app_users.session_token (NOT a JWT).
//   * Single active session per user (a new login overwrites the prior token).
//   * Hard TTL from login (default 12h); validate does NOT slide/renew the expiry.
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

const _ttl = parseInt(process.env.SESSION_TTL_HOURS, 10);
const TTL_HOURS = Number.isFinite(_ttl) && _ttl > 0 ? _ttl : 12; // reject 0/NaN/negative → would mint already-expired tokens

const newToken = () => crypto.randomBytes(24).toString('hex'); // 48 hex chars (mirrors encode(gen_random_bytes(24),'hex'))

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
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

// Returns { locked: true, retry_after_s } while a lock is in force. An EXPIRED lock is
// cleared here so the next attempt starts from a clean counter.
async function checkLock(key) {
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
  await db.query(
    `insert into pin_attempts (id, fails, locked_until) values ($1, 1, null)
     on conflict (id) do update set
       fails = pin_attempts.fails + 1,
       locked_until = case when pin_attempts.fails + 1 >= $2
                           then now() + make_interval(mins => $3)
                           else pin_attempts.locked_until end`,
    [key, MAX_FAILS, LOCK_MINUTES]
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
    [token, TTL_HOURS, u.id]
  );
  return userJson(u, token);
}

// ── app_validate (no expiry renewal) ─────────────────────────────────────────
async function validateToken(token) {
  if (!token) return null;
  const { rows } = await db.query(
    'select * from app_users where session_token = $1 and token_exp > now() and active',
    [token]
  );
  const u = rows[0];
  return u ? userJson(u, u.session_token) : null;
}

// ── app_logout (idempotent, unauthenticated) ─────────────────────────────────
async function logoutToken(token) {
  if (token) await db.query('update app_users set session_token = null where session_token = $1', [token]);
  return { ok: true };
}

// ── app_change_password ──────────────────────────────────────────────────────
async function changePassword(token, oldPw, newPw) {
  const { rows } = await db.query(
    'select * from app_users where session_token = $1 and token_exp > now() and active',
    [token]
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
    [code, u.id]
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
  if (!u.reset_code || new Date(u.reset_exp).getTime() < Date.now() || u.reset_code !== String(code)) {
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
    const { rows } = await db.query(
      'select id, username, email, role, allowed_views from app_users where session_token = $1 and token_exp > now() and active',
      [token]
    );
    if (!rows[0]) return res.status(401).json({ error: 'session' });
    req.user = rows[0];   // NOTE: token_exp is deliberately NOT extended (no sliding TTL)
    req.token = token;
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
};
