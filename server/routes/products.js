// /api/products + /api/stock-log
// The grocery catalogue. A product is keyed to the cashier by its barcode (UNIQUE), so a
// scan resolves to exactly one row. All reads/writes require a valid session; destructive
// ops (delete) require admin. Stock is absolute on write (SET stock = excluded.stock).
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireAdmin, requireView } = require('../auth');
const { fail, dbError } = require('../validate');

// ── List ──────────────────────────────────────────────────────────────────────
// GET /api/products → all active products (catalogue for the sales + inventory screens).
router.get('/products', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'select id, barcode, name, price, cat, cost, stock, unit, active from products order by name'
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// ── Scan lookup ─────────────────────────────────────────────────────────────────
// GET /api/products/barcode/:code → the matching product or 404. The hot path for scanning:
// the cashier's scanner types the code + Enter, the client hits this, adds the line to the cart.
router.get('/products/barcode/:code', requireSession, async (req, res, next) => {
  try {
    const code = String(req.params.code || '').trim();
    if (!code) return fail(res, 'invalid', 400);
    const { rows } = await db.query(
      'select id, barcode, name, price, cat, cost, stock, unit, active from products where barcode = $1',
      [code]
    );
    if (!rows[0]) return fail(res, 'not_found', 404);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ── Create / update ──────────────────────────────────────────────────────────────
// POST /api/products (create) — barcode + name required; price/cat/cost/stock optional.
// Returns the created row (with its generated id). 23505 (unique barcode) → 409 'exists'.
//
// PRICING IS ADMIN-ONLY ON CREATE AS WELL AS UPDATE. Guarding only the update path was
// pointless: a cashier could create "Whiskey" at 2.00, ring the real bottle through it and
// pocket the difference (classic under-ringing). A non-admin may still capture an unknown
// barcode — the useful half of quick-add — but the row lands at price 0, cost 0, stock 0
// and active=false, so it cannot be sold until an admin prices it. To finish the sale in
// front of them the cashier uses the open-price "Quick item" line, which is marked custom
// on the receipt and in reports instead of masquerading as catalogue stock.
router.post('/products', requireSession, async (req, res, next) => {
  try {
    const p = req.body || {};
    const name = String(p.name || '').trim();
    if (!name) return fail(res, 'invalid', 400);
    const barcode = p.barcode != null && String(p.barcode).trim() !== '' ? String(p.barcode).trim() : null;
    const isAdmin = req.user.role === 'admin';

    const price = isAdmin ? (p.price ?? 0) : 0;
    const cost = isAdmin ? (p.cost ?? 0) : 0;
    const stock = isAdmin ? (p.stock ?? 0) : 0;

    const { rows } = await db.query(
      `insert into products (barcode, name, price, cat, cost, stock, unit, active)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       returning id, barcode, name, price, cat, cost, stock, unit, active`,
      [barcode, name, price, p.cat ?? null, cost, stock, p.unit === 'kg' ? 'kg' : 'ea', isAdmin]
    );

    // Every catalogue addition is attributable, whoever made it.
    await db.query(
      `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
       values ('create',$1,$2,0,$3,$4)`,
      [String(rows[0].id), name, stock, req.user.username]
    );

    // Let the client say plainly that pricing was withheld.
    res.json({ ...rows[0], pending_admin_pricing: !isAdmin });
  } catch (e) { dbError(res, next, e); }
});

// PUT /api/products/:id (update) — full row edit. stock is ABSOLUTE (never incremented here).
// Price/cost/barcode changes are ADMIN-ONLY: a cashier session may fix names, categories and
// stock counts, but cannot silently reprice the catalogue (shrinkage vector).
// This — not PATCH /stock — is the route the Inventory screen actually uses, so it is the
// reachable stock-adjustment path. A stock change here now writes an attributable
// stock_log row in the SAME transaction: no silent "correcting away" of a missing bottle.
router.put('/products/:id', requireSession, async (req, res, next) => {
  const p = req.body || {};
  const name = String(p.name || '').trim();
  if (!name) return fail(res, 'invalid', 400);
  const barcode = p.barcode != null && String(p.barcode).trim() !== '' ? String(p.barcode).trim() : null;

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    // Row-lock so the before/after pair written to the audit log can't race another edit.
    const before = await client.query(
      'select price, cost, barcode, stock from products where id = $1 for update', [req.params.id]
    );
    if (!before.rows[0]) { await client.query('rollback'); return fail(res, 'not_found', 404); }
    const cur = before.rows[0];

    if (req.user.role !== 'admin') {
      const changed =
        Number(p.price ?? 0) !== Number(cur.price ?? 0) ||
        Number(p.cost ?? 0) !== Number(cur.cost ?? 0) ||
        (barcode ?? null) !== (cur.barcode ?? null);
      if (changed) { await client.query('rollback'); return fail(res, 'admin_only', 403); }
    }

    await client.query(
      `update products set
         barcode = $1, name = $2, price = $3, cat = $4, cost = $5, stock = $6,
         unit = $7, active = coalesce($8, active), updated_at = now()
       where id = $9`,
      [barcode, name, p.price ?? 0, p.cat ?? null, p.cost ?? 0, p.stock ?? 0, p.unit === 'kg' ? 'kg' : 'ea', p.active ?? null, req.params.id]
    );

    const newStock = Number(p.stock ?? 0);
    const oldStock = Number(cur.stock ?? 0);
    if (newStock !== oldStock) {
      await client.query(
        `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
         values ('adjust',$1,$2,$3,$4,$5)`,
        [String(req.params.id), name, oldStock, newStock, req.user.username]
      );
    }
    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* connection already dead */ }
    dbError(res, next, e);
  } finally {
    client.release();
  }
});

// PATCH /api/products/:id/stock — manual stock adjustment by a delta. { delta: number }.
//
// This is the highest-value endpoint to an insider: it is how a missing bottle gets
// "corrected" away. Two guards, both added deliberately:
//   1. ADMIN-ONLY (or the `inventory` view). Checkout does NOT use this route — sales
//      deduct stock inside the atomic order transaction in routes/orders.js — so gating it
//      costs the till nothing.
//   2. The adjustment and its stock_log row commit TOGETHER, with changed_by taken from
//      the session. An adjustment can no longer happen without a matching, attributable
//      audit row.
router.patch('/products/:id/stock', requireSession, requireView('inventory'), async (req, res, next) => {
  const delta = Number((req.body || {}).delta);
  if (!Number.isFinite(delta)) return fail(res, 'invalid', 400);

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      'update products set stock = coalesce(stock,0) + $1, updated_at = now() where id = $2 returning name, stock',
      [delta, req.params.id]
    );
    if (!rows[0]) { await client.query('rollback'); return fail(res, 'not_found', 404); }
    await client.query(
      `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
       values ('adjust',$1,$2,$3,$4,$5)`,
      [String(req.params.id), rows[0].name, Number(rows[0].stock) - delta, Number(rows[0].stock), req.user.username]
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

// DELETE /api/products/:id (admin) — hard delete.
router.delete('/products/:id', requireSession, requireAdmin, async (req, res, next) => {
  try {
    await db.query('delete from products where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

// ── Stock log ─────────────────────────────────────────────────────────────────
// `changed_by` is taken from the SESSION and any client-supplied value is ignored.
// Previously the whole row came from the request body, so the person causing shrinkage
// could also author the record of it — the audit trail attested to nothing.
router.post('/stock-log', requireSession, async (req, res, next) => {
  try {
    const s = req.body || {};
    await db.query(
      `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
       values ($1,$2,$3,$4,$5,$6)`,
      [s.kind ?? null, s.item_id != null ? String(s.item_id) : null, s.name ?? null,
       s.old_qty ?? null, s.new_qty ?? null, req.user.username]
    );
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

// ── Settings: categories (admin-editable product category list) ──────────────────
// app_settings.value holds a JSON string (TEXT, never ::jsonb) — same convention as the template.
router.get('/settings/categories', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query("select value from app_settings where key='categories'");
    res.json(rows[0] || null);
  } catch (e) { next(e); }
});

router.put('/settings/categories', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const value = (req.body || {}).value;
    await db.query(
      `insert into app_settings (key, value) values ('categories', $1)
       on conflict (key) do update set value = excluded.value`,
      [value ?? null]
    );
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

module.exports = router;
