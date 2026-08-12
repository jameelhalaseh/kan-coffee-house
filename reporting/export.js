// Export layout (§6).
//
// Every sheet begins with the same header block, so a printed page identifies the seller and
// the window without anyone having to remember which tab it came from:
//
//   A1: <store legal name>
//   A2: Tax No: <tax number>
//   A3: Period: <period label>
//   A4: (blank)
//   A5: <data table — header row, then rows>
//
// Every exported CELL is rounded once, at the edge, to the STORE's precision (3dp for JOD).
// TOTAL rows come from the report's raw sums, never from adding up the cells printed above.
const { d } = require('./decimal');
const { roundTo } = require('./money');
const { store } = require('./stores');
const { today } = require('./period');
const { writeWorkbook } = require('./xlsx');
const R = require('./reports');

// A money cell: numeric, so the column can be re-totalled in Excel — a money figure exported
// as text is the most common complaint about POS exports.
const money = (v, dp) => ({ v: Number(roundTo(v, dp).toFixed(dp)), t: 'n' });
const qty = (v) => ({ v: Number(d(v).round(2).toFixed(2)), t: 'n' });

const headerBlock = (s, periodLabel) => [
  [s.legalName],
  [`Tax No: ${s.taxNo || ''}`],
  [`Period: ${periodLabel}`],
  [],
];

const sheet = (s, periodLabel, table) => ({ rows: [...headerBlock(s, periodLabel), ...table] });

// ── Sales ─────────────────────────────────────────────────────────────────────
function salesSheet(orders, floor, period) {
  const s = store(floor);
  const rep = R.salesReport(orders, floor, period);
  const m = (v) => money(v, s.dp);
  const table = [
    ['Bill No', 'Date', 'Items Sold', 'Amount Before Tax', 'Tax Amount', 'Grand Total', 'Discount'],
    ...rep.rows.map((r) => [
      r.billNo, r.date, qty(r.itemsSold), m(r.sub), m(r.tax), m(r.grandTotal), m(r.disc),
    ]),
    ['TOTAL', '', qty(rep.totals.itemsSold), m(rep.totals.sub), m(rep.totals.tax),
      m(rep.totals.grandTotal), m(rep.totals.disc)],
  ];
  return { name: 'Sales', ...sheet(s, period.label, table) };
}

// ── Discounts ─────────────────────────────────────────────────────────────────
// One row per discounted line. The Reason column is the whole point of exporting this: it is
// the only place the note appears, by design — it is never printed on the customer's bill.
function discountsSheet(orders, floor, period) {
  const s = store(floor);
  const rep = R.discountsReport(orders, floor, period);
  const m = (v) => money(v, s.dp);
  const table = [
    ['Date', 'Bill No', 'Item', 'Size', 'Qty', 'Before Discount', 'Discount', 'After Discount', 'Reason', 'Cashier'],
    ...rep.rows.map((r) => [
      r.date, r.billNo, r.item, r.size, qty(r.qty), m(r.gross), m(r.disc), m(r.net), r.note, r.cashier,
    ]),
    ['TOTAL', '', '', '', '', m(rep.totals.gross), m(rep.totals.disc), '', '', ''],
  ];
  return { name: 'Discounts', ...sheet(s, period.label, table) };
}

// ── Expenses ──────────────────────────────────────────────────────────────────
// [QUIRK] ASCENDING here, while the on-screen table is descending.
function expensesSheet(expenses, floor, period) {
  const s = store(floor);
  const rep = R.expensesReport(expenses, floor, period, { ascending: true });
  const table = [
    ['Date', 'Type', 'Supplier', 'Payment Method', 'Value', 'Note'],
    ...rep.rows.map((e) => [e.date, e.type, e.supplier, e.paymentMethod, money(e.value, s.dp), e.note]),
    ['TOTAL', '', '', '', money(rep.totals.value, s.dp), ''],
  ];
  return { name: 'Expenses', ...sheet(s, period.label, table) };
}

// ── Profit & Loss ─────────────────────────────────────────────────────────────
function pnlSheet(orders, expenses, floor, period) {
  const s = store(floor);
  const pl = R.profitAndLoss(orders, expenses, floor, period);
  const table = [
    ['Line', 'Amount'],
    ['Total Revenue', money(pl.totalRevenue, s.dp)],
    ['Total Expenses', money(pl.totalExpenses, s.dp)],
    ['Gross Profit', money(pl.grossProfit, s.dp)],
  ];
  return { name: 'Profit & Loss', ...sheet(s, period.label, table) };
}

// ── Filename (§6) ─────────────────────────────────────────────────────────────
// `<store>-<report>-<today>.xlsx`, with a date-range suffix when the export was scoped to a
// range. Unbounded ("All time") carries no suffix — there is no range to name.
function exportFilename(floor, report, period, now = new Date()) {
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const range = period && period.from && period.to && period.from !== period.to
    ? `-${period.from}_${period.to}` : '';
  return `${slug(floor)}-${slug(report)}-${today(now)}${range}.xlsx`;
}

const workbook = (sheets) => writeWorkbook(sheets);

module.exports = {
  salesSheet, discountsSheet, expensesSheet, pnlSheet, headerBlock, exportFilename, workbook, money, qty,
};
