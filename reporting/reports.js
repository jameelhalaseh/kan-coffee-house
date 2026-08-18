// The reports (§5), for the single-store liquor build.
//
// Partners and Entrance tickets are GONE — those were the restaurant's, and the shop has
// neither. What remains: Sales, Expenses, Profit & Loss, Receipts by date.
//
// Every function here is PURE: rows in, report out. The data layer hands over plain arrays,
// which is what lets the acceptance suite run without a database and keeps the store scoping
// auditable in one place instead of spread across SQL.
//
// §4 governs the arithmetic: sum at full precision, round at the edge. A TOTAL row is ALWAYS
// computed from the raw source, never by adding up the rounded cells above it.
const { d, sum } = require('./decimal');
const { scope } = require('./period');

// ── what counts as a sale ─────────────────────────────────────────────────────
//
// The spec said status = 'done'. This build says status = 'paid', and cancels a sale by
// stamping voided_at rather than by changing the status — the row is KEPT so the invoice
// number stays occupied (migration 0006). Both facts are encoded here, once, so no report can
// apply a different rule: a voided sale is not revenue, was not sold, and must never reach a
// Z-report.
const isVoid = (o) => !!o.voided_at || o.status === 'void';
const isSale = (o) => !isVoid(o) && o.status !== 'open';

// Σ items[].qty — quantities, not line count. One line of 6 beers sold 6 items.
const itemsSold = (order) => sum(order.items || [], (it) => d(it.qty ?? 0));

// invoice_no when present, else the first 6 characters of the id, uppercased.
const billNo = (o) =>
  o.invoice_no === null || o.invoice_no === undefined || o.invoice_no === ''
    ? String(o.id || '').slice(0, 6).toUpperCase()
    : String(o.invoice_no);

// Numeric compare tolerating a null/non-numeric invoice_no by sorting it last, so the sort
// never becomes unstable on a legacy row.
const numAsc = (a, b) => {
  const x = Number(a); const y = Number(b);
  const xn = Number.isFinite(x); const yn = Number.isFinite(y);
  if (!xn && !yn) return 0;
  if (!xn) return 1;
  if (!yn) return -1;
  return x - y;
};

const strAsc = (a, b) => String(a ?? '').localeCompare(String(b ?? ''));

// ── 5.1 Sales ─────────────────────────────────────────────────────────────────
//
// [QUIRK — DO NOT RECONCILE] Two "totals" coexist and do not agree:
//   • the headline KPI, Total Sales = Σ order.total — what was actually collected;
//   • the table's Grand Total column = sub + tax.
// On this build they agree for an ordinary sale (no service charge, no untaxed flat fees), so
// the two figures are usually equal — and where they are NOT, the difference is real and is
// worth seeing rather than hiding. Both are shown.
function salesReport(orders, floor, period) {
  const rows = scope(orders, floor, period)
    .filter(isSale)
    .sort((a, b) =>
      strAsc(a.date, b.date) || numAsc(a.invoice_no, b.invoice_no) || strAsc(a.id, b.id));

  const table = rows.map((o) => ({
    billNo: billNo(o),
    date: o.date,
    itemsSold: itemsSold(o),
    sub: d(o.sub ?? 0),
    tax: d(o.tax ?? 0),
    grandTotal: d(o.sub ?? 0).add(o.tax ?? 0),
    disc: d(o.disc ?? 0),
  }));

  // TOTAL row — derived from the same unrounded source as the cells above it, NOT from them.
  // It may differ in the last decimal from adding up the rounded per-row cells; that is
  // correct, and is the point of §4.
  const totals = {
    itemsSold: sum(rows, (o) => itemsSold(o)),
    sub: sum(rows, (o) => o.sub),
    tax: sum(rows, (o) => o.tax),
    grandTotal: sum(rows, (o) => d(o.sub ?? 0).add(o.tax ?? 0)),
    disc: sum(rows, (o) => o.disc),
  };

  return { rows: table, totals, kpi: { totalSales: sum(rows, (o) => o.total), orders: rows.length } };
}

// ── 5.1b Discounts ────────────────────────────────────────────────────────────
//
// One row per DISCOUNTED LINE, not per bill. A bill-level total says money was given away;
// this says which bottle, how much, who rang it and why — which is the question actually
// being asked when a manager opens this report.
//
// The reason text lives here and NOWHERE on the customer's document. "Staff friend" or
// "damaged label" is a note between the shop and its own records; printing it on the bill
// would hand the customer an argument at the counter and, worse, a record of who gets
// discounts. See src/components/BillPaper.jsx, which deliberately renders the amount but
// not the note.
//
// Voided bills are excluded by isSale, same as everywhere else: a discount on a sale that
// did not happen is not a discount.
// A plain string, not a Decimal: serialize() would render it at the store's MONEY precision
// ("20.000%"), and a discount rate is not money. One decimal place is enough for every rate a
// counter actually gives, and a whole number stays whole.
function pctText(li, disc, gross) {
  const recorded = Number(li.disc_pct ?? 0);
  const n = recorded > 0
    ? recorded
    : (gross.toNumber() > 0 ? disc.div(gross).mul(100).toNumber() : 0);
  return String(Math.round(n * 10) / 10);
}

function discountsReport(orders, floor, period) {
  const rows = [];
  scope(orders, floor, period)
    .filter(isSale)
    .sort((a, b) =>
      strAsc(a.date, b.date) || numAsc(a.invoice_no, b.invoice_no) || strAsc(a.id, b.id))
    .forEach((o) => {
      (o.items || []).forEach((li) => {
        if (!(Number(li.disc ?? 0) > 0)) return;
        const disc = d(li.disc ?? 0);
        const gross = d(li.price ?? 0).mul(li.qty ?? 0);
        rows.push({
          date: o.date,
          billNo: billNo(o),
          item: li.name || '',
          size: li.size || '',
          qty: d(li.qty ?? 0),
          gross,
          disc,
          // The till asks for a discount as a PERCENTAGE, not an amount, so this report has to
          // be able to say "20%" - reading back only 0.650 leaves the owner re-deriving the
          // number the cashier actually authorised. `disc_pct` is what was typed and wins.
          // A line rung before that change carries the two amounts and no percentage, so fall
          // back to the rate they imply: the same figure recovered, not invented.
          pct: pctText(li, disc, gross),
          net: gross.sub(disc),
          note: li.disc_note || '',
          cashier: o.waiter || '',
        });
      });
    });

  return {
    rows,
    // Summed from the same unrounded source as the cells, per §4.
    totals: { disc: sum(rows, (r) => r.disc), gross: sum(rows, (r) => r.gross) },
    kpi: { discountedLines: rows.length },
  };
}

// ── 5.2 Expenses ──────────────────────────────────────────────────────────────
const PAYMENT_LABELS = { cheque: 'Cheque', petty_cash: 'Petty Cash' };
const paymentLabel = (m) => PAYMENT_LABELS[m] || String(m || '');

// [QUIRK] The on-screen table sorts DESCENDING; the export sorts ASCENDING. Both preserved:
// this returns the screen order, and the exporter asks for `ascending`.
function expensesReport(expenses, floor, period, { ascending = false } = {}) {
  const dir = ascending ? 1 : -1;
  const rows = scope(expenses, floor, period)
    .sort((a, b) => dir * (strAsc(a.date, b.date) || strAsc(a.created_at, b.created_at)));

  return {
    rows: rows.map((e) => ({
      date: e.date,
      type: e.type,                       // free text: deleting a type never rewrites history
      supplier: e.supplier || '',
      paymentMethod: paymentLabel(e.payment_method),
      value: d(e.value ?? 0),
      note: e.note || '',
      id: e.id,
    })),
    totals: { value: sum(rows, (e) => e.value) },
  };
}

// Expense types are a shared global list ordered by name.
const expenseTypes = (types) => (types || []).slice().sort((a, b) => strAsc(a.name, b.name));

// ── 5.3 Profit & Loss ─────────────────────────────────────────────────────────
//
// Total Revenue is Σ order.total, so it ties to the Sales KPI exactly and NOT to the table's
// Grand Total.
//
// Cost of goods and stock consumption are NOT in here — despite the "Gross Profit" label this
// is cash in minus cash out. The shop's actual margin (revenue against product cost) is a
// different figure and lives on the existing Reports page, which knows product costs.
function profitAndLoss(orders, expenses, floor, period) {
  const totalRevenue = sum(scope(orders, floor, period).filter(isSale), (o) => o.total);
  const totalExpenses = sum(scope(expenses, floor, period), (e) => e.value);
  return { totalRevenue, totalExpenses, grossProfit: totalRevenue.sub(totalExpenses) };
}

// ── 5.6 Receipts by date ──────────────────────────────────────────────────────
//
// A live per-day lookup, not a cached list: one exact date, searchable by invoice number,
// order id, cashier, or t<table>.
//
// The day total excludes voided orders — but the voided ROWS still render, dimmed and struck
// through, so a cashier can see the bill was cancelled instead of wondering where it went.
function receiptsByDate(orders, floor, date, query = '') {
  const q = String(query || '').trim().toLowerCase();
  const onDay = (orders || []).filter((o) => o && o.floor === floor && o.date === date);

  const matches = (o) => {
    if (!q) return true;
    if (q.startsWith('t') && String(o.table_id ?? '').toLowerCase() === q.slice(1)) return true;
    return [o.invoice_no, o.id, o.waiter].some((f) => String(f ?? '').toLowerCase().includes(q));
  };

  const rows = onDay.filter(matches).sort((a, b) => strAsc(b.time, a.time));   // time DESC

  return {
    // The money columns are re-wrapped as decimals rather than passed through as whatever
    // node-pg handed over. A numeric column with no declared scale comes back as '2.6', so a
    // receipt rendered straight from the row read "2.6" next to a Sales tab reading "2.600" —
    // same sale, two different-looking amounts. Wrapping them here means the serialiser
    // formats every amount on this page to the shop's precision, like everywhere else.
    rows: rows.map((o) => ({
      ...o,
      sub: d(o.sub ?? 0),
      tax: d(o.tax ?? 0),
      disc: d(o.disc ?? 0),
      total: d(o.total ?? 0),
      voided: isVoid(o),
    })),
    dayTotal: sum(rows.filter((o) => !isVoid(o)), (o) => o.total),
  };
}

// One receipt, shaped for the bill view: the line items with their own extended amounts, the
// tax breakdown, and the void marking. Money is wrapped as decimals so it serialises at the
// shop's precision like every other figure — a bill that renders "2.6" beside a report that
// says "2.600" is the same sale told two ways.
function receiptView(o) {
  if (!o) return null;
  // `amount` is the line NET of its own discount, because that is what the line contributed
  // to the stored total — computing it gross would make lineSum disagree with total on every
  // discounted bill and light the "items do not add up" warning on a correct invoice.
  // `gross` is kept so the bill view can show what the discount came off.
  const items = (o.items || []).map((li) => ({
    name: li.name,
    size: li.size || '',
    qty: d(li.qty ?? 0),
    price: d(li.price ?? 0),
    disc: d(li.disc ?? 0),
    gross: d(li.price ?? 0).mul(li.qty ?? 0),
    amount: d(li.price ?? 0).mul(li.qty ?? 0).sub(d(li.disc ?? 0)),
  }));
  return {
    id: o.id,
    billNo: billNo(o),
    invoice_no: o.invoice_no,
    date: o.date,
    time: o.time,
    cashier: o.waiter || '',
    pay: o.pay || '',
    buyer: o.buyer || '',
    status: o.status,
    items,
    itemsSold: itemsSold(o),
    sub: d(o.sub ?? 0),
    tax: d(o.tax ?? 0),
    disc: d(o.disc ?? 0),
    total: d(o.total ?? 0),
    // The line sum is shown alongside the stored total so a row whose items no longer add up
    // is visible in the bill view rather than only in a spreadsheet.
    lineSum: sum(items, (li) => li.amount),
    voided: isVoid(o),
    voided_at: o.voided_at || null,
    voided_by: o.voided_by || null,
    void_reason: o.void_reason || null,
    // A refund is a negative sale, not a mistake to be corrected — the UI labels it.
    refund: o.status === 'refund',
  };
}

module.exports = {
  salesReport, discountsReport, expensesReport, expenseTypes, profitAndLoss, receiptsByDate, receiptView,
  billNo, itemsSold, paymentLabel, isVoid, isSale,
};
