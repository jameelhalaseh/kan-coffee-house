// /api/customers, /api/admin-log, /api/users
// AUTH levels intentionally split per resource:
//   customers   POST=session (save at checkout)   GET=admin (PII)
//   admin-log   POST=session (any user appends)    GET=admin (read audit)
//   users (admin user management) — all admin
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireSession, requireAdmin } = require('../auth');
const { fail, dbError } = require('../validate');

// ── Customers (PII) ───────────────────────────────────────────────────────────
router.post('/customers', requireSession, async (req, res, next) => {
  try {
    const { order_id, name, mobile } = req.body || {};
    await db.query(
      "insert into customers (order_id, name, mobile, created_at) values ($1, nullif($2,''), nullif($3,''), now())",
      [order_id ?? null, name ?? '', mobile ?? '']
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/customers', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await db.query('select name, mobile, order_id, created_at from customers order by created_at desc');
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Admin log (audit) ──────────────────────────────────────────────────────────
// `actor` comes from the SESSION, never the body. The action text stays client-supplied
// (it's a free-form description), but WHO performed it is now attested by the server, so a
// forged action string can no longer be pinned on someone else.
// POST /admin-log was REMOVED (audit of 12 Aug): it let any session append arbitrary text to
// the admin audit trail. The actor came from the session and could not be forged, but the
// content could — enough to bury a real action in noise. Server-side writes remain: see the
// receipt-edit entry in reporting/pgRepo.js and the user changes in this file.

router.get('/admin-log', requireSession, requireAdmin, async (req, res, next) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 1000;
    // inner: most-recent N (desc limit); outer: re-sort ascending for display (verbatim app_list_admin_log).
    const { rows } = await db.query(
      'select action, actor, created_at from (select action, actor, created_at from admin_log order by created_at desc limit $1) t order by created_at asc',
      [limit]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Users (admin user management) — ports app_admin_* (AUTH_SETUP.sql) ───────────
router.get('/users', requireSession, requireAdmin, async (req, res, next) => {
  try {
    // pass_hash / session_token are never exposed.
    const { rows } = await db.query(
      'select id, username, email, role, allowed_views, active, full_name, wage from app_users order by created_at'
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/users', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const { username, password, role, views, email, full_name, wage } = req.body || {};
    if (!password || String(password).length < 8) return fail(res, 'too_short', 400);
    const dup = await db.query('select 1 from app_users where username = lower($1)', [String(username || '')]);
    if (dup.rows[0]) return fail(res, 'exists', 400);
    const hash = bcrypt.hashSync(String(password), 10);
    const { rows } = await db.query(
      `insert into app_users (username, email, role, allowed_views, pass_hash, full_name, wage)
       values (lower($1), nullif($2,''), coalesce($3,'user'), coalesce($4::text[],'{}'), $5, $6, $7) returning id`,
      [String(username || ''), email ?? '', role ?? null, views ?? null, hash, full_name ?? null, wage ?? 0]   // views: text[] (JS array) or null
    );
    res.json({ id: rows[0].id, ok: true });
  } catch (e) { dbError(res, next, e); }
});

router.put('/users/:id', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const { role, views, active, email, username, full_name, wage } = req.body || {};
    if (username != null && String(username).trim().length > 0) {
      const dup = await db.query('select 1 from app_users where username = lower($1) and id <> $2',
        [String(username), req.params.id]);
      if (dup.rows[0]) return fail(res, 'exists', 400);
    }
    await db.query(
      `update app_users set
         username      = coalesce(nullif(lower(trim($1)),''), username),
         role          = coalesce($2, role),
         allowed_views = coalesce($3, allowed_views),
         active        = coalesce($4, active),
         email         = coalesce($5, email),
         full_name     = coalesce($7, full_name),
         wage          = coalesce($8, wage)
       where id = $6`,
      [username ?? null, role ?? null, views ?? null, active ?? null, email ?? null, req.params.id, full_name ?? null, wage ?? null]
    );
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

router.delete('/users/:id', requireSession, requireAdmin, async (req, res, next) => {
  try {
    // Compare at the uuid type (canonical, case/whitespace-insensitive) so a non-canonical id
    // can't slip past the self-guard. A bad uuid → 22P02 → dbError → 400.
    const self = await db.query('select ($1::uuid = $2::uuid) as is_self', [req.params.id, req.user.id]);
    if (self.rows[0].is_self) return fail(res, 'self', 400);
    await db.query('delete from app_users where id = $1::uuid', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

router.post('/users/:id/reset-password', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const newPw = req.body && (req.body.new ?? req.body.p_new);
    if (!newPw || String(newPw).length < 8) return fail(res, 'too_short', 400);
    await db.query(
      'update app_users set pass_hash = $1, session_token = null where id = $2',
      [bcrypt.hashSync(String(newPw), 10), req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

module.exports = router;
