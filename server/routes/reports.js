// /api/reports/* — grocery sales + stock reporting.
// Gated to the `reports` view (admins bypass) — a limited cashier cannot read revenue.
// All figures come from orders_main (sales) and products (stock). Tax-free build, so
// `total` is the gross take.
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireView } = require('../auth');

const gate = [requireSession, requireView('reports', 'dashboard', 'history')];

// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD window on created_at. Missing = all time.
// Returns a WHERE fragment + params starting at $1.
//
// VOIDED sales are excluded from every figure. The row is kept, because the invoice number
// must stay occupied (see migration 0006) — but a cancelled sale is not revenue, was not
// sold, and must never appear in a Z-report. Filtering here means every report inherits it.
function range(req) {
  const clauses = ['voided_at is null'];
  const params = [];
  if (req.query.from) { params.push(req.query.from); clauses.push(`created_at >= $${params.length}`); }
  if (req.query.to)   { params.push(req.query.to);   clauses.push(`created_at < ($${params.length}::date + 1)`); }
  return { where: 'where ' + clauses.join(' and '), params };
}

// GET /api/reports/summary → { orders, revenue, units }
router.get('/reports/summary', ...gate, async (req, res, next) => {
  try {
    const { where, params } = range(req);
    const { rows } = await db.query(
      `select count(*)::int as orders,
              coalesce(sum(total),0) as revenue,
              coalesce(sum((
                select sum((li->>'qty')::numeric)
                from jsonb_array_elements(coalesce(items,'[]'::jsonb)) li
              )),0) as units
         from orders_main ${where}`,
      params
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// GET /api/reports/daily → revenue grouped by day (last 90 days or the given window).
router.get('/reports/daily', ...gate, async (req, res, next) => {
  try {
    const { where, params } = range(req);
    const { rows } = await db.query(
      `select to_char(created_at::date, 'YYYY-MM-DD') as day,
              count(*)::int as orders,
              coalesce(sum(total),0) as revenue
         from orders_main ${where}
         group by created_at::date
         order by created_at::date desc
         limit 90`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/reports/top-products?limit=20 → best sellers by units sold in the window.
router.get('/reports/top-products', ...gate, async (req, res, next) => {
  try {
    const { where, params } = range(req);
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    params.push(Math.min(limit, 200));
    const { rows } = await db.query(
      `select li->>'name' as name,
              sum((li->>'qty')::numeric) as units,
              sum((li->>'qty')::numeric * (li->>'price')::numeric) as revenue
         from orders_main o, jsonb_array_elements(coalesce(o.items,'[]'::jsonb)) li
         ${where}
         group by li->>'name'
         order by units desc
         limit $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/reports/zreport?date=YYYY-MM-DD → daily close-out: count + total per payment method.
router.get('/reports/zreport', ...gate, async (req, res, next) => {
  try {
    const day = req.query.date || new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `select coalesce(pay,'?') as pay, count(*)::int as orders, coalesce(sum(total),0) as total
         from orders_main
        where voided_at is null
          and created_at >= $1::date and created_at < ($1::date + 1)
        group by pay order by pay`,
      [day]
    );
    const net = rows.reduce((s, r) => s + Number(r.total), 0);
    res.json({ date: day, lines: rows, net });
  } catch (e) { next(e); }
});

// GET /api/reports/abc → Pareto class per product by revenue share (A<=80%, B<=95%, C rest).
router.get('/reports/abc', ...gate, async (req, res, next) => {
  try {
    const { where, params } = range(req);
    const { rows } = await db.query(
      `select li->>'name' as name,
              sum((li->>'qty')::numeric * (li->>'price')::numeric) as revenue
         from orders_main o, jsonb_array_elements(coalesce(o.items,'[]'::jsonb)) li
         ${where}
         group by li->>'name' order by revenue desc`,
      params
    );
    const grand = rows.reduce((s, r) => s + Number(r.revenue || 0), 0) || 1;
    let cum = 0;
    const out = rows.map((r) => {
      cum += Number(r.revenue || 0);
      const share = cum / grand;
      const cls = share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C';
      return { name: r.name, revenue: Number(r.revenue || 0), cum_share: share, class: cls };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// GET /api/reports/low-stock?threshold=5 → products at/under the threshold (restock list).
router.get('/reports/low-stock', ...gate, async (req, res, next) => {
  try {
    let threshold = Number(req.query.threshold);
    if (!Number.isFinite(threshold)) threshold = 5;
    const { rows } = await db.query(
      `select id, barcode, name, cat, stock from products
        where active and coalesce(stock,0) <= $1
        order by stock asc, name`,
      [threshold]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
