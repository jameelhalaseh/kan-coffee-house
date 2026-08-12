// Postgres data access for the reporting module.
//
// The only file in the module that writes SQL. reports.js stays pure and api.js stays
// HTTP-only, which is what lets the acceptance suite run the exact same report code against
// in-memory arrays.
//
// SALES COME FROM orders_main — the table this app has always written to. The module does not
// own an orders table and never did after this build: a second orders table would mean the
// reports showed a parallel universe of sales that the till never made. The physical table
// name is resolved through server/floors.js, which whitelists the floor key and returns a
// FIXED constant, so nothing here interpolates a caller's string into SQL.
//
// Two rules hold everywhere below:
//  1. Every query is scoped to one store.
//  2. Money comes back as node-pg's default numeric representation: a STRING, passed through
//     untouched to reporting/decimal.js, which parses it exactly. Nothing here calls Number()
//     on a money column — that is the line between this module and float drift in a tax total.
const { d } = require('./decimal');
const { FLOORS } = require('./stores');
const { ordersTable } = require('../server/floors');
const { tradingDate } = require('../server/tz');

// Build "and date >= $n" / "and date <= $n" only for the bounds that are set.
function windowClause(period, params, col = 'date') {
  let sql = '';
  if (period && period.from) { params.push(period.from); sql += ` and ${col} >= $${params.length}`; }
  if (period && period.to) { params.push(period.to); sql += ` and ${col} <= $${params.length}`; }
  return sql;
}

// Guard the floor at the data layer too, not only at the route: a repo method is callable
// from a script, and an unvalidated floor is how one store's report gets another's rows.
function floorOf(floor) {
  if (!FLOORS.includes(floor)) throw new RangeError(`unknown floor: ${floor}`);
  return floor;
}

// WHY THE FILTER IS ON THE `date` TEXT COLUMN
// §3 filters lexicographically on zero-padded YYYY-MM-DD, and this build already stores
// exactly that: orders_main.date is the LOCAL Amman calendar date stamped at checkout (see
// src/lib.js), not a UTC slice. Invoice 155, created 2026-08-09T22:04Z, carries date
// 2026-08-10 — 01:04 Amman. So the text comparison and the store's trading day agree, and the
// figures here tie out with the existing Reports page, which reaches the same answer through
// `created_at at time zone 'Asia/Amman'`.
//
// [QUIRK — §3] There is deliberately NO 02:00 business-day offset. A sale at 01:30 reports
// under its own calendar date.
function createPgRepo(db) {
  const q = (text, params) => db.query(text, params);

  const ORDER_COLS =
    'id, invoice_no, floor, table_id, items, sub, tax, svc, disc, disc_pct, total, pay, waiter, buyer, status, voided_at, date, time';

  return {
    // Status is NOT filtered here. Sales and P&L exclude voids, Receipts renders them — the
    // rule lives in reports.js so the two can never drift apart.
    async orders(floor, period) {
      const table = ordersTable(floorOf(floor));
      const params = [floor];
      const { rows } = await q(
        `select ${ORDER_COLS} from ${table} where floor = $1${windowClause(period, params)}`, params);
      return rows;
    },

    // ── Stock ─────────────────────────────────────────────────────────────────
    // The catalogue as it stands NOW. products.stock is the authority on how many bottles
    // are on the shelf; every historical figure in the stock report is derived by walking
    // back from it, never by adding up movements from zero. The shop's opening balances
    // were seeded straight into the column years of movements ago and were never logged,
    // so "sum the log from the beginning" would report every product as deeply negative.
    async stockProducts() {
      const { rows } = await q(
        `select id, barcode, name, cat, size, cost, price, stock, low_at, active
           from products order by name`);
      return rows;
    },

    // Deliveries. `date` is the LOCAL trading date so it lines up with the same YYYY-MM-DD
    // text the sales side filters on — a delivery booked at 01:30 Amman belongs to that
    // calendar day, not to the UTC one before it.
    //
    // Cost is per unit as entered on the Receive screen; lineCost is what the shop paid.
    async stockReceipts(from) {
      const params = [];
      let where = '';
      if (from) { params.push(from); where = ` where ${tradingDate('b.received_at')} >= $${params.length}`; }
      const { rows } = await q(
        `select b.id, b.product_id, b.qty, b.cost,
                ${tradingDate('b.received_at')}::text as date,
                b.received_at,
                coalesce(s.name, '') as supplier
           from batches b
           left join suppliers s on s.id = b.supplier_id${where}
          order by b.received_at, b.id`, params);
      return rows;
    },

    // Everything else that moved stock: manual corrections, catalogue creation, imports.
    //
    // Sales, refunds, voids and deliveries are DELIBERATELY excluded here even though they
    // write log rows too. Those events are read from orders_main and batches, which are the
    // records that carry the money; counting them from both places would double every
    // movement in the report.
    async stockAdjustments(from) {
      const params = [];
      let where = "where kind in ('adjust','create','import')";
      if (from) { params.push(from); where += ` and ${tradingDate('created_at')} >= $${params.length}`; }
      const { rows } = await q(
        `select item_id, kind, old_qty, new_qty, changed_by,
                ${tradingDate('created_at')}::text as date, created_at
           from stock_log ${where}
          order by created_at, id`, params);
      return rows;
    },

    // One exact date, for the live receipts lookup. Not a window — §5.6.
    async ordersOnDate(floor, date) {
      const table = ordersTable(floorOf(floor));
      const { rows } = await q(
        `select ${ORDER_COLS} from ${table} where floor = $1 and date = $2`, [floor, date]);
      return rows;
    },

    // The shop's actual trading span. The reports default to "today", and a shop that has not
    // rung anything up yet today then shows a page of zeros that looks broken rather than
    // empty. The UI uses this to say WHICH day it is showing and to offer the last day that
    // has sales, instead of leaving the user to guess the date.
    async salesSpan(floor) {
      const table = ordersTable(floorOf(floor));
      const { rows } = await q(
        `select min(date) as first, max(date) as last, count(*)::int as orders
           from ${table} where floor = $1 and voided_at is null`, [floor]);
      return rows[0] || { first: null, last: null, orders: 0 };
    },

    // One receipt, by id. The View/Edit dialog re-reads the row instead of trusting the copy
    // the table was rendered from, so it cannot act on a sale another till voided meanwhile.
    async order(floor, id) {
      const table = ordersTable(floorOf(floor));
      const { rows } = await q(
        `select ${ORDER_COLS}, voided_by, void_reason, created_at from ${table}
          where floor = $1 and id = $2`, [floor, id]);
      return rows[0] || null;
    },

    /**
     * Edit the METADATA of a finalised sale — who bought it and how they paid.
     *
     * WHAT IS DELIBERATELY NOT EDITABLE: items, quantities, prices, sub, tax, total, the
     * invoice number and the date. A finalised invoice is a tax document; silently rewriting
     * its amounts would make the reports, the printed receipt the customer holds, and the
     * stock ledger three different stories. To correct a mis-rung sale, VOID it (which
     * returns the goods to stock with an attributable stock_log row) and ring it again — the
     * invoice sequence keeps both, which is what an auditor expects to see.
     *
     * A voided sale is not editable at all: it is closed.
     */
    async updateOrderMeta(floor, id, patch, actor) {
      const table = ordersTable(floorOf(floor));
      const client = await db.pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query(
          `select id, invoice_no, pay, buyer, status, voided_at from ${table}
            where floor = $1 and id = $2 for update`, [floor, id]);
        const o = rows[0];
        if (!o) { await client.query('rollback'); return { error: 'not_found' }; }
        if (o.voided_at) { await client.query('rollback'); return { error: 'voided' }; }

        // `buyer` on a refund row carries "return of #<invoice>", which the over-refund guard
        // in POST /api/orders parses to find the original sale. Editing it would silently
        // unhook that guard and allow the same invoice to be refunded twice.
        if (patch.buyer !== undefined && o.status === 'refund') {
          await client.query('rollback');
          return { error: 'refund_buyer_locked' };
        }

        const next = {
          pay: patch.pay === undefined ? o.pay : patch.pay,
          buyer: patch.buyer === undefined ? o.buyer : patch.buyer,
        };
        const { rows: out } = await client.query(
          `update ${table} set pay = $3, buyer = $4 where floor = $1 and id = $2
           returning ${ORDER_COLS}`, [floor, id, next.pay, next.buyer]);

        // Same transaction as the edit: an audit line that exists only when the change did.
        await client.query(
          'insert into admin_log (action, actor) values ($1, $2)',
          [`receipt_edit #${o.invoice_no}: pay ${o.pay || '-'}->${next.pay || '-'}, `
           + `buyer ${o.buyer || '-'}->${next.buyer || '-'}`, actor || null]);

        await client.query('commit');
        return { order: out[0] };
      } catch (e) {
        await client.query('rollback');
        throw e;
      } finally {
        client.release();
      }
    },

    async expenses(floor, period) {
      const params = [floorOf(floor)];
      const { rows } = await q(
        `select id, floor, type, value, supplier, date, payment_method, note, created_at
           from expenses where floor = $1${windowClause(period, params)}`, params);
      return rows;
    },

    // Shared global list — not floor-scoped (§5.2).
    async expenseTypes() {
      const { rows } = await q('select id, name from expense_types');
      return rows;
    },

    // ── writes (all behind the reports:edit grant at the route) ──────────────
    async createExpense(e) {
      const { rows } = await q(
        `insert into expenses (floor, type, value, supplier, date, payment_method, note)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, floor, type, value, supplier, date, payment_method, note, created_at`,
        // Bound as TEXT and cast by Postgres into numeric. A JS number here would round-trip
        // the amount through a float first.
        [floorOf(e.floor), e.type, d(e.value).toFixed(4), e.supplier || '', e.date,
          e.payment_method, e.note || '']);
      return rows[0];
    },

    async deleteExpense(floor, id) {
      // The floor is part of the predicate, so an id cannot be deleted through another
      // store's endpoint by guessing it.
      const { rowCount } = await q('delete from expenses where floor = $1 and id = $2',
        [floorOf(floor), id]);
      return rowCount > 0;
    },

    async createExpenseType(name) {
      const { rows } = await q(
        `insert into expense_types (name) values ($1)
         on conflict (lower(btrim(name))) do update set name = expense_types.name
         returning id, name`, [String(name).trim()]);
      return rows[0];
    },

    async deleteExpenseType(id) {
      // Historical expenses keep their saved label (the column is free text), so this cannot
      // orphan anything — which is why there is no in-use check here.
      const { rowCount } = await q('delete from expense_types where id = $1', [id]);
      return rowCount > 0;
    },
  };
}

module.exports = { createPgRepo };
