// §5.7 Stock — what came in, what went out, and what is left.
//
// ── How the historical balances are derived ──────────────────────────────────
// products.stock is the ONLY authority on how many bottles are on the shelf. Every figure
// with a date on it is reached by walking BACKWARDS from that number through the movements
// since, never by adding movements up from zero.
//
// That is not a stylistic choice. This shop's opening quantities were written straight into
// products.stock when the catalogue was seeded, without a corresponding movement row, so
// summing the log from the beginning reports every product as hundreds of units in deficit.
// Walking back from the truth is immune to that: whatever the shelf held before the first
// logged movement cancels out.
//
//   closing(end)   = stock_now − Σ movements after `end`
//   opening(start) = closing(end) − Σ movements within [start, end]
//
// Both identities hold by construction, which means Opening + In − Out always equals
// Closing. Read that as a property of the arithmetic and NOT as proof that the movement log
// is complete: if a bottle ever left the shelf without a row being written, the error lands
// silently in the opening balance, where it looks like history rather than like a mistake.
// The per-product movement list is printed underneath for exactly that reason — it is the
// evidence, and the columns are only the summary of it.
//
// ── Where each movement comes from ───────────────────────────────────────────
// Sales and refunds come from orders_main, deliveries from batches, and only manual
// corrections come from stock_log. Every one of those events writes a stock_log row as well,
// so reading them from both places would double every movement on the report. The rule is:
// take the event from the record that carries its MONEY, and stock_log for the rest.
const { d, sum } = require('./decimal');
const { scope } = require('./period');

const isVoid = (o) => !!o.voided_at || o.status === 'void';
const isRefund = (o) => o.status === 'refund';
// A voided sale is excluded entirely: the goods went out and came straight back, so it nets
// to nothing on the shelf — and the 'void' log row that restored them is excluded to match.
const counts = (o) => !isVoid(o) && o.status !== 'open';

// Movement kinds this report reads from the log. Everything else (sale, return, void,
// restock) is read from the record that carries its money instead.
const COUNTED_ADJUSTMENTS = new Set(['adjust', 'create', 'import']);

// Catalogue lines only. Open-price "quick items" carry a client-generated string id, hold no
// stock and cannot appear in a stock report — there is no product for them to be about.
const catalogueId = (li) => (Number.isInteger(li && li.id) ? String(li.id) : null);

// A date string compares lexicographically because it is zero-padded YYYY-MM-DD (§3).
const onOrBefore = (date, bound) => !bound || String(date || '') <= bound;
const onOrAfter = (date, bound) => !bound || String(date || '') >= bound;

/**
 * @param products    catalogue rows as they stand now (repo.stockProducts)
 * @param orders      every order from period.from onwards, unbounded end (repo.orders)
 * @param receipts    every delivery from period.from onwards (repo.stockReceipts)
 * @param adjustments manual stock corrections from period.from onwards (repo.stockAdjustments)
 */
function stockReport(products, orders, receipts, adjustments, floor, period) {
  const from = period && period.from ? period.from : '';
  const to = period && period.to ? period.to : '';

  // Movements are accumulated per product in two buckets at once: what happened INSIDE the
  // window (the report's columns) and what happened AFTER it (only needed to walk back from
  // today's shelf count to the closing balance).
  const empty = () => ({
    sold: d(0), returned: d(0), received: d(0), adjusted: d(0),
    revenue: d(0), cogs: d(0), discount: d(0),
    afterSold: d(0), afterReturned: d(0), afterReceived: d(0), afterAdjusted: d(0),
    receiptRows: [], adjustmentRows: [], lastSold: '', lastReceived: '',
  });
  const acc = new Map();
  const bucket = (id) => {
    if (!acc.has(id)) acc.set(id, empty());
    return acc.get(id);
  };

  // ── Sales and refunds ───────────────────────────────────────────────────────
  for (const o of scope(orders, floor, { from, to: '' })) {
    if (!counts(o)) continue;
    const inWindow = onOrBefore(o.date, to);
    for (const li of o.items || []) {
      const id = catalogueId(li);
      if (!id) continue;
      const b = bucket(id);
      const qty = d(li.qty ?? 0);
      const gross = d(li.price ?? 0).mul(li.qty ?? 0);
      const disc = d(li.disc ?? 0);

      if (isRefund(o)) {
        // A refund is stored with a negative total; its quantities come back to the shelf.
        const back = qty.isNeg() ? qty.neg() : qty;
        if (inWindow) b.returned = b.returned.add(back);
        else b.afterReturned = b.afterReturned.add(back);
        continue;
      }

      if (inWindow) {
        b.sold = b.sold.add(qty);
        b.revenue = b.revenue.add(gross.sub(disc));
        b.discount = b.discount.add(disc);
        if (String(o.date || '') > b.lastSold) b.lastSold = o.date || '';
      } else {
        b.afterSold = b.afterSold.add(qty);
      }
    }
  }

  // ── Deliveries ──────────────────────────────────────────────────────────────
  for (const r of receipts || []) {
    const id = String(r.product_id);
    const b = bucket(id);
    const qty = d(r.qty ?? 0);
    if (!onOrAfter(r.date, from)) continue;
    if (onOrBefore(r.date, to)) {
      b.received = b.received.add(qty);
      if (String(r.date || '') > b.lastReceived) b.lastReceived = r.date || '';
      b.receiptRows.push({
        date: r.date,
        supplier: r.supplier || '',
        qty,
        unitCost: d(r.cost ?? 0),
        lineCost: d(r.cost ?? 0).mul(r.qty ?? 0),
      });
    } else {
      b.afterReceived = b.afterReceived.add(qty);
    }
  }

  // ── Manual corrections ──────────────────────────────────────────────────────
  for (const a of adjustments || []) {
    // The repo already selects only these kinds, but the rule is enforced here as well: a
    // 'restock' or 'sale' row reaching this bucket would double a movement that has already
    // been counted from batches or from orders_main, and the report would still balance
    // while being wrong — the worst failure mode a stock report has.
    if (!COUNTED_ADJUSTMENTS.has(a.kind)) continue;
    const id = String(a.item_id);
    const b = bucket(id);
    const delta = d(a.new_qty ?? 0).sub(d(a.old_qty ?? 0));
    if (!onOrAfter(a.date, from)) continue;
    if (onOrBefore(a.date, to)) {
      b.adjusted = b.adjusted.add(delta);
      b.adjustmentRows.push({
        date: a.date, kind: a.kind || '', by: a.changed_by || '',
        fromQty: d(a.old_qty ?? 0), toQty: d(a.new_qty ?? 0), delta,
      });
    } else {
      b.afterAdjusted = b.afterAdjusted.add(delta);
    }
  }

  const rows = (products || []).map((p) => {
    const b = acc.get(String(p.id)) || empty();
    const stockNow = d(p.stock ?? 0);
    const cost = d(p.cost ?? 0);

    // Walk back from the shelf: undo everything that happened after the window closed…
    const closing = stockNow
      .sub(b.afterReceived).sub(b.afterReturned).sub(b.afterAdjusted).add(b.afterSold);
    // …then undo the window itself to reach the balance it opened with.
    const opening = closing
      .sub(b.received).sub(b.returned).sub(b.adjusted).add(b.sold);

    const cogs = cost.mul(b.sold.sub(b.returned));
    const lowAt = d(p.low_at ?? 5);

    return {
      id: p.id,
      name: p.name,
      size: p.size || '',
      cat: p.cat || '',
      barcode: p.barcode || '',
      active: p.active !== false,

      opening,
      received: b.received,
      sold: b.sold,
      returned: b.returned,
      adjusted: b.adjusted,
      closing,
      stockNow,

      // Suppliers who delivered this product in the window, in the order they first appear.
      suppliers: Array.from(new Set(b.receiptRows.map((r) => r.supplier).filter(Boolean))),
      lastReceived: b.lastReceived,
      lastSold: b.lastSold,

      unitCost: cost,
      unitPrice: d(p.price ?? 0),
      purchases: sum(b.receiptRows, (r) => r.lineCost),
      revenue: b.revenue,
      discount: b.discount,
      cogs,
      profit: b.revenue.sub(cogs),
      closingValue: closing.mul(cost),
      stockValue: stockNow.mul(cost),

      lowAt,
      low: Number(p.stock ?? 0) <= Number(p.low_at ?? 5),
      out: Number(p.stock ?? 0) <= 0,
      // Nothing came in, nothing went out, and there is stock sitting there.
      dead: b.sold.isZero() && b.received.isZero() && Number(p.stock ?? 0) > 0,

      receipts: b.receiptRows,
      adjustments: b.adjustmentRows,
    };
  });

  // Movements whose product is no longer in the catalogue. They are NOT dropped silently:
  // stock that moved under a since-deleted product is exactly the kind of thing a stock
  // report exists to surface, and a total that quietly omits it is a total that lies.
  const known = new Set((products || []).map((p) => String(p.id)));
  const orphans = [];
  acc.forEach((b, id) => {
    if (known.has(id)) return;
    if (b.sold.isZero() && b.received.isZero() && b.adjusted.isZero()) return;
    orphans.push({ id, sold: b.sold, received: b.received, adjusted: b.adjusted, revenue: b.revenue });
  });

  const totals = {
    opening: sum(rows, (r) => r.opening),
    received: sum(rows, (r) => r.received),
    sold: sum(rows, (r) => r.sold),
    returned: sum(rows, (r) => r.returned),
    adjusted: sum(rows, (r) => r.adjusted),
    closing: sum(rows, (r) => r.closing),
    stockNow: sum(rows, (r) => r.stockNow),
    purchases: sum(rows, (r) => r.purchases),
    revenue: sum(rows, (r) => r.revenue),
    discount: sum(rows, (r) => r.discount),
    cogs: sum(rows, (r) => r.cogs),
    profit: sum(rows, (r) => r.profit),
    closingValue: sum(rows, (r) => r.closingValue),
    stockValue: sum(rows, (r) => r.stockValue),
  };

  return {
    rows,
    totals,
    orphans,
    kpi: {
      products: rows.length,
      lowCount: rows.filter((r) => r.low && !r.out).length,
      outCount: rows.filter((r) => r.out).length,
      deadCount: rows.filter((r) => r.dead).length,
      movedCount: rows.filter((r) => !r.sold.isZero() || !r.received.isZero()).length,
    },
  };
}

module.exports = { stockReport };
