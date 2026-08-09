// /api/suppliers + /api/batches + /api/expiry
// Supplier management and received-stock batches (expiry tracking). Receiving a batch bumps
// the product's running stock and logs it. All require a session; deletes require admin.
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireAdmin } = require('../auth');
const { fail, dbError } = require('../validate');

// ── Suppliers ───────────────────────────────────────────────────────────────────
router.get('/suppliers', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query('select id, name, phone, note, active from suppliers where active order by name');
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/suppliers', requireSession, async (req, res, next) => {
  try {
    const s = req.body || {};
    if (!String(s.name || '').trim()) return fail(res, 'invalid', 400);
    const { rows } = await db.query(
      'insert into suppliers (name, phone, note) values ($1,$2,$3) returning id, name, phone, note, active',
      [String(s.name).trim(), s.phone ?? null, s.note ?? null]
    );
    res.json(rows[0]);
  } catch (e) { dbError(res, next, e); }
});

router.put('/suppliers/:id', requireSession, async (req, res, next) => {
  try {
    const s = req.body || {};
    await db.query('update suppliers set name=$1, phone=$2, note=$3 where id=$4',
      [String(s.name || '').trim(), s.phone ?? null, s.note ?? null, req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

router.delete('/suppliers/:id', requireSession, requireAdmin, async (req, res, next) => {
  try { await db.query('update suppliers set active=false where id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { dbError(res, next, e); }
});

// ── Batches (receive stock) ───────────────────────────────────────────────────────
// POST /api/batches — record a received lot; bumps product.stock and logs it.
router.post('/batches', requireSession, async (req, res, next) => {
  try {
    const b = req.body || {};
    const qty = Number(b.qty);
    if (b.product_id == null || !Number.isFinite(qty) || qty <= 0) return fail(res, 'invalid', 400);
    await db.query(
      'insert into batches (product_id, supplier_id, qty, cost, expiry) values ($1,$2,$3,$4,$5)',
      [b.product_id, b.supplier_id ?? null, qty, b.cost ?? 0, b.expiry || null]
    );
    const { rows } = await db.query(
      'update products set stock = coalesce(stock,0) + $1, updated_at = now() where id = $2 returning stock, name',
      [qty, b.product_id]
    );
    db.query(
      `insert into stock_log (kind,item_id,name,new_qty,changed_by) values ('restock',$1,$2,$3,$4)`,
      [String(b.product_id), rows[0] && rows[0].name, rows[0] && rows[0].stock, (req.user && req.user.username) || null]
    ).catch(() => {});
    res.json({ ok: true, stock: rows[0] && rows[0].stock });
  } catch (e) { dbError(res, next, e); }
});

// GET /api/batches?product_id= → received lots (with supplier name), newest first.
router.get('/batches', requireSession, async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.product_id) { params.push(req.query.product_id); where = 'where b.product_id = $1'; }
    const { rows } = await db.query(
      `select b.id, b.product_id, p.name as product, b.supplier_id, s.name as supplier,
              b.qty, b.cost, b.expiry, b.received_at
         from batches b
         left join products p on p.id = b.product_id
         left join suppliers s on s.id = b.supplier_id
         ${where}
         order by b.received_at desc limit 500`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/expiry?days=30 → batches whose expiry is within `days` (or already past).
router.get('/expiry', requireSession, async (req, res, next) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days)) days = 30;
    const { rows } = await db.query(
      `select b.id, b.product_id, p.name as product, s.name as supplier, b.qty, b.expiry,
              (b.expiry - current_date) as days_left
         from batches b
         left join products p on p.id = b.product_id
         left join suppliers s on s.id = b.supplier_id
        where b.expiry is not null and b.expiry <= current_date + ($1 || ' days')::interval
        order by b.expiry asc limit 300`,
      [String(days)]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
