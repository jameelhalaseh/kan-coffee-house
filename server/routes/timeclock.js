// /api/timeclock/* — employee clock in/out (logged-in user punches their own clock).
// One open punch (clock_out null) per user. Listing/hours require the reports view (admins bypass).
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireView } = require('../auth');
const { fail } = require('../validate');

// GET /api/timeclock/status → the caller's open punch, or null.
router.get('/timeclock/status', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'select id, clock_in from time_clock where user_id = $1 and clock_out is null order by clock_in desc limit 1',
      [req.user.id]
    );
    res.json(rows[0] || null);
  } catch (e) { next(e); }
});

// POST /api/timeclock/in — open a punch (no-op if one is already open).
router.post('/timeclock/in', requireSession, async (req, res, next) => {
  try {
    const open = await db.query('select id from time_clock where user_id = $1 and clock_out is null', [req.user.id]);
    if (open.rows[0]) return res.json({ ok: true, already: true });
    await db.query('insert into time_clock (user_id, username) values ($1, $2)', [req.user.id, req.user.username]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/timeclock/out — close the caller's open punch.
router.post('/timeclock/out', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'update time_clock set clock_out = now() where id = (select id from time_clock where user_id = $1 and clock_out is null order by clock_in desc limit 1) returning id',
      [req.user.id]
    );
    if (!rows[0]) return fail(res, 'not_clocked_in', 400);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/timeclock?from=&to= — punches with hours (reports view).
router.get('/timeclock', requireSession, requireView('reports', 'dashboard'), async (req, res, next) => {
  try {
    const params = [];
    const clauses = [];
    if (req.query.from) { params.push(req.query.from); clauses.push(`clock_in >= $${params.length}`); }
    if (req.query.to)   { params.push(req.query.to);   clauses.push(`clock_in < ($${params.length}::date + 1)`); }
    const where = clauses.length ? 'where ' + clauses.join(' and ') : '';
    const { rows } = await db.query(
      `select username, clock_in, clock_out,
              round(extract(epoch from (coalesce(clock_out, now()) - clock_in)) / 3600.0, 2) as hours
         from time_clock ${where} order by clock_in desc limit 500`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
