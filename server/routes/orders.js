// /api/orders + /api/invoice/next
// Per-store model: GG → orders_gg, Dealer → orders_dealer (separate tables, independent invoice
// numbering). Faithful to app_save_order / app_list_orders / app_delete_order / app_next_invoice.
//   list/save  → any valid session     delete → admin only
// items & split_data are jsonb: bound as JSON.stringify + ::jsonb (NULL stays NULL).
// created_at is never written — the DB default / existing value is preserved.
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireAdmin, requireView } = require('../auth');
const { fail, dbError } = require('../validate');
const { FLOORS, ordersTable } = require('../floors');

const jsonb = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

// Whitelist floor → physical table (orders_<key>). Returns a FIXED constant or null.
// Keys come from the server floor registry, never interpolated raw from the request.
const tableFor = ordersTable;
// Merged read across every floor's table — built from the whitelisted FLOORS list.
const ALL_ORDERS_UNION = FLOORS.map((f) => `select * from ${ordersTable(f)}`).join(' union all ');

// GET /api/orders?floor=gg&limit=200 → that store's table.
// GET /api/orders?limit=200 (no floor) → both stores merged (combined history/reports).
// Revenue history — gated to views that display it (history/dashboard/reports). A limited
// operator (e.g. "tables"-only) cannot read sales totals directly via the API. Admins bypass.
router.get('/', requireSession, requireView('history', 'dashboard', 'reports'), async (req, res, next) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 200;   // RPC default
    limit = Math.min(limit, 100000);                          // largest legit caller (receipts/reports)

    if (req.query.floor !== undefined) {
      const t = tableFor(req.query.floor);
      if (!t) return fail(res, 'invalid_floor', 400);
      const { rows } = await db.query(`select * from ${t} order by created_at desc limit $1`, [limit]);
      return res.json(rows);
    }
    const { rows } = await db.query(
      `select * from ( ${ALL_ORDERS_UNION} ) o order by created_at desc limit $1`,
      [limit]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// POST /api/orders (create/update) — body.floor selects the store table (required).
//
// ATOMIC CHECKOUT: the order upsert, the stock movement for every catalogue line, and the
// stock-log rows all commit in ONE transaction. Either the sale exists AND stock moved, or
// neither did — a network drop can no longer record a sale while leaving inventory untouched.
// Stock direction: normal sale deducts (-qty); status='refund' restores (+qty).
// Stock is only moved when the order row is INSERTED (xmax=0), never on a re-POST of the
// same order id, so retries can't double-deduct.
//
// OVER-REFUND GUARD: a refund whose buyer is 'return of #<invoice>' is validated against the
// original sale — the sum of all refunds for that invoice can never exceed the original total.
router.post('/', requireSession, async (req, res, next) => {
  const o = req.body || {};
  if (o.id === undefined || o.id === null || String(o.id).trim() === '') return fail(res, 'invalid', 400);
  const t = tableFor(o.floor);
  if (!t) return fail(res, 'invalid_floor', 400);   // every order must declare its store

  const isRefund = o.status === 'refund';
  const client = await db.pool.connect();
  try {
    await client.query('begin');

    if (isRefund) {
      const m = /^return of #(\d+)$/.exec(String(o.buyer || ''));
      if (m) {
        // A VOIDED original is worth nothing — its goods were already returned to stock when
        // it was voided, so refunding against it would pay out twice.
        const orig = await client.query(
          `select coalesce(sum(total),0) as total from ${t}
            where invoice_no = $1 and coalesce(status,'') <> 'refund' and voided_at is null`,
          [Number(m[1])]
        );
        const prior = await client.query(
          `select coalesce(sum(total),0) as total from ${t}
            where status = 'refund' and buyer = $1 and voided_at is null`,
          [o.buyer]
        );
        const remaining = Number(orig.rows[0].total) + Number(prior.rows[0].total); // refunds are negative
        if (Math.abs(Number(o.total) || 0) > remaining + 0.0005) {
          await client.query('rollback');
          return fail(res, 'over_refund', 400);
        }
      }
    }

    const ins = await client.query(
      `insert into ${t} (id,table_id,items,sub,tax,svc,disc,disc_pct,disc_staff,
         total,pay,waiter,status,split_data,date,time,invoice_no,floor,buyer)
       values ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19)
       on conflict (id) do update set
         table_id=excluded.table_id, items=excluded.items, sub=excluded.sub, tax=excluded.tax,
         svc=excluded.svc, disc=excluded.disc, disc_pct=excluded.disc_pct, disc_staff=excluded.disc_staff,
         total=excluded.total, pay=excluded.pay, waiter=excluded.waiter, status=excluded.status,
         split_data=excluded.split_data, date=excluded.date, time=excluded.time,
         invoice_no=excluded.invoice_no, floor=excluded.floor, buyer=excluded.buyer
       returning (xmax = 0) as inserted`,
      [
        o.id, o.table_id ?? null, jsonb(o.items), o.sub ?? null, o.tax ?? null, o.svc ?? null,
        o.disc ?? null, o.disc_pct ?? null, o.disc_staff ?? null, o.total ?? null, o.pay ?? null,
        o.waiter ?? null, o.status ?? null, jsonb(o.split_data), o.date ?? null, o.time ?? null,
        o.invoice_no ?? null, o.floor, o.buyer ?? null,
      ]
    );

    // Move stock only for brand-new orders, only for catalogue lines (integer product ids —
    // open-price "misc" lines carry client-generated string ids and hold no stock).
    if (ins.rows[0].inserted && Array.isArray(o.items)) {
      for (const li of o.items) {
        const qty = Number(li.qty);
        if (!Number.isInteger(li.id) || !Number.isFinite(qty) || qty <= 0) continue;
        const delta = isRefund ? qty : -qty;
        const upd = await client.query(
          'update products set stock = coalesce(stock,0) + $1, updated_at = now() where id = $2 returning stock',
          [delta, li.id]
        );
        if (upd.rows[0]) {
          await client.query(
            `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
             values ($1,$2,$3,$4,$5,$6)`,
            // changed_by from the SESSION, not o.waiter — the body's waiter field is
            // client-supplied and would let a cashier stamp someone else on the movement.
            [isRefund ? 'return' : 'sale', String(li.id), li.name ?? null,
             Number(upd.rows[0].stock) - delta, Number(upd.rows[0].stock), req.user.username]
          );
        }
      }
    }

    await client.query('commit');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* connection already dead */ }
    // Unique-violation on invoice_no = two checkouts raced for the same store number.
    // Surface so the client re-fetches a number instead of silently duplicating a tax invoice.
    if (e && e.code === '23505') return fail(res, 'invoice_taken', 409);
    dbError(res, next, e);
  } finally {
    client.release();
  }
});

// DELETE /api/orders/:id (admin) — VOID, not a hard delete.
//
// This used to `delete from orders_<floor>`, which did two bad things at once: it punched a
// gap in the invoice sequence (and the old gap-reusing numberer then handed that number to a
// DIFFERENT sale), and it left stock deducted — goods gone, no record. For a tax-registered
// seller a vanished invoice is worse than a cancelled one.
//
// Now the row stays, keeps its invoice number, and is marked voided. Stock the sale consumed
// is returned in the SAME transaction with an attributable stock_log row, because a voided
// sale is a sale that did not happen.
//
// Idempotent: voiding an already-voided order reports success without moving stock twice.
router.delete('/:id', requireSession, requireAdmin, async (req, res, next) => {
  const reason = String((req.body && req.body.reason) || '').slice(0, 500) || null;
  // id is a client-generated uid (globally unique); ?floor= targets one table explicitly.
  if (req.query.floor !== undefined && !tableFor(req.query.floor)) return fail(res, 'invalid_floor', 400);
  const floors = req.query.floor !== undefined ? [req.query.floor] : FLOORS;

  const client = await db.pool.connect();
  try {
    await client.query('begin');
    let result = null;

    for (const f of floors) {
      const t = ordersTable(f);
      const found = await client.query(`select * from ${t} where id = $1 for update`, [req.params.id]);
      const o = found.rows[0];
      if (!o) continue;

      if (o.voided_at) { result = { already: true, invoice_no: o.invoice_no }; break; }

      await client.query(
        `update ${t} set voided_at = now(), voided_by = $2, void_reason = $3, status = 'void'
          where id = $1`,
        [o.id, req.user.username, reason]
      );

      // Give the goods back. No reversing document is created — a void says the sale never
      // legitimately existed, whereas a refund is a real reversing invoice of its own.
      const wasRefund = String(o.status || '') === 'refund';
      if (Array.isArray(o.items)) {
        for (const li of o.items) {
          const qty = Number(li.qty);
          if (!Number.isInteger(li.id) || !Number.isFinite(qty) || qty <= 0) continue;
          // Undo exactly what the original row did: a sale deducted, a refund added back.
          const delta = wasRefund ? -qty : qty;
          const upd = await client.query(
            'update products set stock = coalesce(stock,0) + $1, updated_at = now() where id = $2 returning stock',
            [delta, li.id]
          );
          if (upd.rows[0]) {
            await client.query(
              `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by)
               values ('void',$1,$2,$3,$4,$5)`,
              [String(li.id), li.name ?? null,
               Number(upd.rows[0].stock) - delta, Number(upd.rows[0].stock), req.user.username]
            );
          }
        }
      }
      result = { invoice_no: o.invoice_no };
      break;
    }

    if (!result) { await client.query('rollback'); return fail(res, 'not_found', 404); }
    await client.query('commit');
    res.json({ ok: true, voided: true, ...result });
  } catch (e) {
    try { await client.query('rollback'); } catch (_) { /* connection already dead */ }
    next(e);
  } finally {
    client.release();
  }
});

// GET /api/invoice/next?floor=gg → bare JSON number. Strictly increasing per store
// (max+1, never reused — see migration 0006); advisory-locked in SQL against races.
async function invoiceNext(req, res, next) {
  try {
    const floor = req.query.floor;
    if (!tableFor(floor)) return fail(res, 'invalid_floor', 400);
    const { rows } = await db.query('select app_next_invoice($1) as invoice_no', [floor]);
    res.json(Number(rows[0].invoice_no));
  } catch (e) { next(e); }
}

module.exports = { router, invoiceNext };
