// /api/auth/* — login, session validate/logout, password change, admin reset.
// Faithful to the Supabase app_login/app_validate/app_logout/app_change_password/
// app_request_admin_reset/app_confirm_reset RPCs (see server/auth.js).
const router = require('express').Router();
const auth = require('../auth');
const { fail, missingField } = require('../validate');

// Map the original RPC error codes to HTTP status.
const STATUS = {
  session: 401, not_admin: 403,
  invalid: 401, wrong_old: 400, too_short: 400,
  no_admin: 400, no_email: 400, no_user: 400, bad_code: 400, exists: 400, self: 400,
  locked: 429,                       // per-username lockout (auth.js checkLock)
  email_failed: 502, email_not_configured: 503,
};
const send = (res, result) =>
  result && result.error ? fail(res, result.error, STATUS[result.error] || 400) : res.json(result);

// POST /api/auth/login  { username, password }  → user JSON (incl. token) | 401
router.post('/login', async (req, res, next) => {
  try {
    const username = req.body.username ?? req.body.p_username;
    const password = req.body.password ?? req.body.p_password;
    const miss = missingField({ username, password }, ['username', 'password']);
    if (miss) return fail(res, 'invalid', 401);
    const user = await auth.loginUser(username, password);
    // Lockout is reported explicitly (429 + seconds remaining): a cashier standing at the
    // till needs to know WHY the screen refuses them. This is safe against enumeration
    // because the counter keys on the submitted username whether or not it exists, so an
    // unknown username locks out identically.
    if (user && user.error === 'locked') {
      res.set('Retry-After', String(user.retry_after_s));
      return res.status(429).json({ error: 'locked', retry_after_s: user.retry_after_s });
    }
    if (!user) return fail(res, 'invalid', 401);
    res.json(user);
  } catch (e) { next(e); }
});

// GET /api/auth/validate  (Bearer token) → user JSON | 401
router.get('/validate', async (req, res, next) => {
  try {
    const user = await auth.validateToken(auth.getToken(req));
    if (!user) return fail(res, 'session', 401);
    res.json(user);
  } catch (e) { next(e); }
});

// POST /api/auth/logout  (Bearer token) → { ok:true }  (idempotent, unauthenticated)
router.post('/logout', async (req, res, next) => {
  try { res.json(await auth.logoutToken(auth.getToken(req))); } catch (e) { next(e); }
});

// POST /api/auth/change-password  { old, new }  (Bearer token)
router.post('/change-password', async (req, res, next) => {
  try {
    const oldPw = req.body.old ?? req.body.p_old;
    const newPw = req.body.new ?? req.body.p_new;
    send(res, await auth.changePassword(auth.getToken(req), oldPw, newPw));
  } catch (e) { next(e); }
});

// POST /api/auth/request-reset  { username }  → { email, code, username } | { error }
router.post('/request-reset', async (req, res, next) => {
  try {
    const username = req.body.username ?? req.body.p_username;
    send(res, await auth.requestReset(username));
  } catch (e) { next(e); }
});

// POST /api/auth/confirm-reset  { username, code, new }
router.post('/confirm-reset', async (req, res, next) => {
  try {
    const username = req.body.username ?? req.body.p_username;
    const code = req.body.code ?? req.body.p_code;
    const newPw = req.body.new ?? req.body.p_new;
    send(res, await auth.confirmReset(username, code, newPw));
  } catch (e) { next(e); }
});

module.exports = router;
