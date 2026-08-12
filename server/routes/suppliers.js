// /api/suppliers + /api/batches
// Supplier management and received-stock batches. Receiving a batch bumps the product's
// running stock and logs it. All require a session; deletes require admin.
//
// No expiry tracking: this is a liquor store (migration 0007 dropped the column).
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireAdmin, requireView } = require('../auth');
const { fail, dbError } = require('../validate');

// ── Suppliers ───────────────────────────────────────────────────────────────────
router.get('/suppliers', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query('select id, name, phone, note, active from suppliers where active order by name');
    res.json(rows);
  } catch (e) { next(e); }
});

// Names are unique, case-insensitively (migration 0008). A second "Levant Spirits Import"
// splits one distributor's delivery history across two ids that look identical in the
// Receive dropdown, so the second one is refused with 409 'exists'.
//
// DELETE is a soft delete (active=false), and a re-add of a name that was removed is the
// user asking for it back — not an error. So an inactive row with that name is revived
// rather than 409'd, which is also the only way back: nothing in the UI lists inactive
// suppliers, so a bare 409 would leave the name permanently unusable.
router.post('/suppliers', requireSession, requireView('inventory', 'receive'), async (req, res, next) => {
  try {
    const s = req.body || {};
    const name = String(s.name || '').trim();
    if (!name) return fail(res, 'invalid', 400);

    const { rows } = await db.query(
      `insert into suppliers (name, phone, note) values ($1,$2,$3)
       on conflict (lower(btrim(name))) do update
         set phone = excluded.phone, note = excluded.note, active = true
       where suppliers.active = false
       returning id, name, phone, note, active`,
      [name, s.phone ?? null, s.note ?? null]
    );
    // No row back = the conflict target existed AND was active: a genuine duplicate.
    if (!rows[0]) return fail(res, 'exists', 409);
    res.json(rows[0]);
  } catch (e) { dbError(res, next, e); }
});

router.put('/suppliers/:id', requireSession, requireView('inventory', 'receive'), async (req, res, next) => {
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
//
// The lot row, the stock bump and the audit row commit TOGETHER. They used to be three
// separate statements — the last one fire-and-forget — so a failure between them could
// record a delivery that never reached the shelf count, or bump stock with no lot behind
// it. Receiving is the only way stock legitimately goes up; it has to be all-or-nothing.
//
// The product is locked and checked first: an unknown product_id used to fall through to
// `rows[0] && ...`, writing a stock_log row full of nulls and answering 200 with no stock.
// Receiving stock is a stock WRITE: it increments products.stock and books a cost that feeds
// margin reporting. Session-only until the audit of 12 Aug, which meant a cashier with no
// inventory grant could invent a delivery to cover a shortfall.
router.post('/batches', requireSession, requireView('inventory', 'receive'), async (req, res, next) => {
  const b = req.body || {};
  const qty = Number(b.qty);
  const cost = b.cost == null || b.cost === '' ? 0 : Number(b.cost);
  if (b.product_id == null || !Number.isFinite(qty) || qty <= 0) return fail(res, 'invalid', 400);
  if (!Number.isFinite(cost) || cost < 0) return fail(res, 'invalid', 400);

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const before = await client.query(
      'select id, name, coalesce(stock,0) as stock from products where id = $1 for update',
      [b.product_id]
    );
    if (!before.rows[0]) { await client.query('rollback'); return fail(res, 'not_found', 404); }
    const prev = before.rows[0];

    await client.query(
      'insert into batches (product_id, supplier_id, qty, cost) values ($1,$2,$3,$4)',
      [prev.id, b.supplier_id ?? null, qty, cost]
    );
    const { rows } = await client.query(
      'update products set stock = coalesce(stock,0) + $1, updated_at = now() where id = $2 returning stock',
      [qty, prev.id]
    );
    await client.query(
      `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
       values ('restock',$1,$2,$3,$4,$5)`,
      [String(prev.id), prev.name, Number(prev.stock), rows[0].stock, req.user.username]
    );
    await client.query('commit');
    res.json({ ok: true, stock: rows[0].stock });
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* connection already dead */ }
    dbError(res, next, e);
  } finally {
    client.release();
  }
});

// GET /api/batches?product_id= → received lots (with supplier name), newest first.
router.get('/batches', requireSession, async (req, res, next) => {
  try {
    const params = [];
    let where = '';
    if (req.query.product_id) { params.push(req.query.product_id); where = 'where b.product_id = $1'; }
    const { rows } = await db.query(
      `select b.id, b.product_id, p.name as product, b.supplier_id, s.name as supplier,
              b.qty, b.cost, b.received_at
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

module.exports = router;
