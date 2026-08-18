// Financial reports — Sales, Expenses, Profit & Loss and Receipts, with an Excel export.
//
// Separate from ReportsView on purpose: that page is the operational one (top products, ABC,
// dead stock, Z-report, staff hours). This one is the accountant's view — the invoice-level
// sales list, the expense ledger the app did not have before, and the cash-in-minus-cash-out
// figure that falls out of the two.
//
// Every amount arrives from the server as a STRING already rounded to the shop's precision
// (3dp for JOD). The browser never re-does the arithmetic, so it can never introduce a float
// or a second rounding — nothing here calls Number() on money.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api';
import { C, S, IS_DAY } from '../theme';
import { ARABIC, CURRENCY, DEFAULT_FLOOR } from '../client.config';
import { Stat } from '../components/ui';
import ReceiptModal from '../components/ReceiptModal';

const FLOOR = DEFAULT_FLOOR;   // single store; the API is still store-scoped

const TABS = [
  { key: 'sales', en: 'Sales', ar: 'المبيعات', export: 'sales' },
  { key: 'discounts', en: 'Discounts', ar: 'الخصومات', export: 'discounts' },
  { key: 'stock', en: 'Stock', ar: 'المخزون', export: 'stock' },
  { key: 'expenses', en: 'Expenses', ar: 'المصاريف', export: 'expenses' },
  { key: 'pnl', en: 'Profit & Loss', ar: 'الأرباح والخسائر', export: 'pnl' },
  { key: 'receipts', en: 'Receipts', ar: 'الفواتير', export: null },
];

const PRESETS = [
  { key: 'today', en: 'Today', ar: 'اليوم' },
  { key: 'week', en: 'Week', ar: 'أسبوع' },
  { key: 'month', en: 'Month', ar: 'شهر' },
  { key: 'all', en: 'All time', ar: 'الكل' },
  { key: 'custom', en: 'Custom', ar: 'مخصص' },
];

const PAY_METHODS = [
  { key: 'petty_cash', en: 'Petty Cash', ar: 'نثرية' },
  { key: 'cheque', en: 'Cheque', ar: 'شيك' },
];

const L = (o) => (ARABIC ? o.ar : o.en);
const amt = (v) => `${v ?? '0.000'} ${CURRENCY}`;
const localToday = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const dateInput = { ...S.input, width: 'auto' };

// The figures above every table. A grid, not a flex wrap: equal-width cards line up in
// columns instead of leaving a ragged last row, and the set reads as one panel.
const KPI = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' };

function StoreReportsView({ isAdmin, notify }) {
  const [tab, setTab] = useState('sales');
  const [preset, setPreset] = useState('month');
  const [from, setFrom] = useState(localToday());
  const [to, setTo] = useState(localToday());
  const [receiptDate, setReceiptDate] = useState(localToday());
  // The shop's trading span. Every preset defaults to "today", and on a day with no sales yet
  // that produces a page of zeros indistinguishable from a broken one — so the empty states
  // below say which day they are showing and offer the last day that actually has sales.
  const [span, setSpan] = useState(null);
  const [search, setSearch] = useState('');
  const [data, setData] = useState(null);
  const [types, setTypes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [openReceipt, setOpenReceipt] = useState(null);   // the bill dialog

  // A custom period with only one date filled renders nothing and prompts — the server
  // answers 400 incomplete_period, so the client does not send it at all.
  const incomplete = preset === 'custom' && (!from || !to);
  const qs = `period=${preset}` + (preset === 'custom' ? `&from=${from}&to=${to}` : '');

  // Each tab has a DIFFERENT payload shape: Sales has { rows, totals, kpi }, Receipts has
  // { rows, dayTotal }, P&L has three bare figures. So the response has to be pinned to the
  // tab that asked for it, on two counts:
  //
  //   1. Switching tabs must not leave the old payload on screen for a frame — rendering the
  //      Sales markup against the Receipts payload reads data.kpi.totalSales on an object
  //      with no `kpi` and takes the whole app down with "Cannot read properties of
  //      undefined". That is a crash, not a blank panel.
  //   2. A slow response that lands AFTER the user has moved on must be dropped, or it puts
  //      the previous tab's figures under the new tab's headings — which is worse than a
  //      crash, because it looks plausible.
  //
  // `data.for` is the tab the payload belongs to; nothing renders unless it matches.
  const reqSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++reqSeq.current;
    setData(null);                       // never show the previous tab's shape
    if (incomplete) return;
    setBusy(true);
    const path = tab === 'receipts'
      ? `/reports/${FLOOR}/receipts?date=${receiptDate}&q=${encodeURIComponent(search)}`
      : `/reports/${FLOOR}/${tab}?${qs}`;
    api.get(path)
      .then((payload) => { if (seq === reqSeq.current) setData({ for: tab, payload }); })
      .catch((e) => {
        if (seq !== reqSeq.current) return;   // stale failure: the user already moved on
        setData(null);
        notify(e.status === 403
          ? (ARABIC ? 'لا تملك صلاحية التقارير' : 'You do not have the reports permission')
          : (ARABIC ? 'تعذّر تحميل التقرير' : 'Failed to load the report'), 'red');
      })
      .finally(() => { if (seq === reqSeq.current) setBusy(false); });
  }, [tab, qs, receiptDate, search, incomplete, notify]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/reports/expense-types').then(setTypes).catch(() => {}); }, []);
  useEffect(() => {
    api.get(`/reports/${FLOOR}/span`).then((sp) => {
      setSpan(sp);
      // Open Receipts on the last day that has sales rather than on a blank today. The picker
      // is still there; this only changes where it starts.
      if (sp && sp.last) setReceiptDate((d) => (d === localToday() && sp.last < d ? sp.last : d));
    }).catch(() => {});
  }, []);

  // The export endpoint is authenticated, so the file cannot be fetched by pointing a link at
  // it — the bytes come back through the API client (which carries the Bearer token) and are
  // handed to the browser as an object URL.
  const download = async (report) => {
    try {
      const blob = await api.getBlob(`/reports/${FLOOR}/export/${report}?${qs}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${FLOOR}-${report}-${localToday()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke on the next tick — revoking synchronously can beat the download in Safari.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) {
      notify(ARABIC ? 'تعذّر تصدير الملف' : 'Export failed', 'red');
    }
  };

  // Open the bill dialog. The row is RE-READ from the server rather than reused from the
  // table: between rendering the list and clicking a row, another till may have voided the
  // sale, and acting on a stale copy is how a voided bill gets edited.
  const viewReceipt = async (id) => {
    try {
      setOpenReceipt(await api.get(`/reports/${FLOOR}/receipts/${id}`));
    } catch (_) {
      notify(ARABIC ? 'تعذّر فتح الفاتورة' : 'Could not open the receipt', 'red');
    }
  };

  // Void straight from the list, for the common case of cancelling a bill you can already
  // see. Same endpoint and same guarantees as the button inside the dialog: the reason is
  // recorded, the invoice number survives, the stock comes back.
  const voidReceipt = async (o) => {
    const label = o.invoice_no ?? String(o.id).slice(0, 6).toUpperCase();
    const reason = window.prompt(
      ARABIC ? `سبب إلغاء الفاتورة #${label}` : `Reason for voiding bill #${label}`);
    if (reason === null) return;
    try {
      await api.del(`/orders/${o.id}?floor=${FLOOR}`, { reason: reason || '' });
      notify(ARABIC ? 'أُلغيت الفاتورة وأُعيد المخزون' : 'Bill voided — stock returned', 'green');
      load();
    } catch (e) {
      notify(e.status === 403
        ? (ARABIC ? 'الإلغاء للمدير فقط' : 'Only an admin can void a bill')
        : (ARABIC ? 'تعذّر الإلغاء' : 'Void failed'), 'red');
    }
  };

  const removeExpense = async (id) => {
    try {
      await api.del(`/reports/${FLOOR}/expenses/${id}`);
      load();
    } catch (_) {
      notify(ARABIC ? 'تعذّر الحذف' : 'Delete failed', 'red');
    }
  };

  const activeTab = TABS.find((t) => t.key === tab);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...S.btn, padding: '11px 18px', fontSize: 15, fontWeight: 700, borderRadius: 10,
            background: tab === t.key ? C.accent : C.panel2,
            color: tab === t.key ? C.accentText : C.text,
            border: `1px solid ${tab === t.key ? C.accent : C.line}`,
          }}>{L(t)}</button>
        ))}
        <div style={{ flex: 1 }} />
        {tab === 'expenses' && isAdmin && (
          <button onClick={() => setAdding(true)} style={{ ...S.btn, padding: '11px 18px', fontSize: 15, fontWeight: 700 }}>
            + {ARABIC ? 'مصروف' : 'Expense'}
          </button>
        )}
        {activeTab.export && (
          <button onClick={() => download(activeTab.export)} disabled={incomplete} style={{
            ...S.btnGhost, padding: '11px 16px', fontSize: 15, fontWeight: 700,
            opacity: incomplete ? .5 : 1,
          }}>⤓ {ARABIC ? 'تصدير Excel' : 'Export Excel'}</button>
        )}
      </div>

      {tab === 'receipts' ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Capped at today: there are no receipts in the future, and letting the picker go
              there only produces an empty page that looks broken. */}
          <input type="date" max={localToday()} value={receiptDate}
            onChange={(e) => setReceiptDate(e.target.value)} style={dateInput} />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={ARABIC ? 'رقم الفاتورة أو الكاشير' : 'invoice, id, or cashier'}
            style={{ ...S.input, maxWidth: 260 }} />
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {PRESETS.map((p) => (
            <button key={p.key} onClick={() => setPreset(p.key)} style={{
              ...S.btn, padding: '9px 14px', fontSize: 14, borderRadius: 10,
              background: preset === p.key ? C.accent : C.panel2,
              color: preset === p.key ? C.accentText : C.text,
              border: `1px solid ${preset === p.key ? C.accent : C.line}`,
            }}>{L(p)}</button>
          ))}
          {preset === 'custom' && (
            <>
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={dateInput} />
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={dateInput} />
            </>
          )}
        </div>
      )}

      {incomplete && (
        <div style={{ color: C.dim, padding: 30, textAlign: 'center' }}>
          {ARABIC ? 'اختر تاريخي البداية والنهاية' : 'Pick both dates'}
        </div>
      )}
      {busy && !data && <div style={{ color: C.dim, padding: 20 }}>{ARABIC ? 'جارٍ التحميل…' : 'Loading…'}</div>}

      {/* data.for === tab is the guard, not a nicety: without it the wrong renderer runs
          against the wrong payload shape and throws. */}
      {!incomplete && data && data.for === tab && (
        <Body tab={tab} data={data.payload} isAdmin={isAdmin} onDelete={removeExpense}
          span={span} preset={preset} receiptDate={receiptDate} onJump={setReceiptDate}
          onOpenReceipt={viewReceipt} onVoidReceipt={voidReceipt} />
      )}

      {openReceipt && (
        <ReceiptModal receipt={openReceipt} isAdmin={isAdmin} notify={notify}
          onClose={() => setOpenReceipt(null)}
          onChanged={(r) => { setOpenReceipt(r); load(); }}
          onGone={() => { setOpenReceipt(null); load(); }} />
      )}

      {adding && (
        <ExpenseModal types={types} notify={notify}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load(); api.get('/reports/expense-types').then(setTypes).catch(() => {}); }} />
      )}
    </div>
  );
}

// ── The financial grid ────────────────────────────────────────────────────────
//
// Every table on this page is a ledger, and a ledger is read by column as often as by row.
// So the grid is ruled: a rule between every column, a heavier rule where one GROUP of
// columns ends and the next begins, banded rows, and money right-aligned on tabular numerals
// so the decimal points line up in a straight line down the page.
//
// Three things are frozen, because the thing you are comparing against must not scroll away
// from the thing you are comparing: the header, the TOTAL row, and — where a table is wide —
// the first column that says which row you are on.
//
// These styles are local to this page rather than in theme.js: this is the accountant's view,
// and the shared `th`/`td` are used by the operational screens, which are fine as they are.
const G = (() => {
  const RULE = `1px solid ${C.line}`;
  const GROUP_RULE = `2px solid ${C.line}`;
  const START = ARABIC ? 'right' : 'left';
  const END = ARABIC ? 'left' : 'right';

  const cell = {
    padding: '10px 12px', borderBottom: RULE, borderInlineEnd: RULE,
    whiteSpace: 'nowrap', textAlign: START,
  };
  const num = { ...cell, textAlign: END, fontVariantNumeric: 'tabular-nums' };
  const head = {
    padding: '8px 12px', fontSize: 11, fontWeight: 800, letterSpacing: .6,
    textTransform: 'uppercase', color: C.dim, background: C.panel2,
    borderBottom: GROUP_RULE, borderInlineEnd: RULE, whiteSpace: 'nowrap', textAlign: START,
  };
  const foot = {
    padding: '11px 12px', fontWeight: 800, background: C.panel2,
    borderTop: GROUP_RULE, borderInlineEnd: RULE, whiteSpace: 'nowrap',
    position: 'sticky', bottom: 0, zIndex: 2,
  };
  return {
    RULE,
    GROUP_RULE,
    START,
    END,
    // Frame: rounded, ruled, and scrollable in BOTH directions, so thirteen columns never
    // push the page itself sideways.
    frame: {
      border: RULE, borderRadius: 14, overflow: 'auto', maxHeight: '64vh',
      background: C.panel, boxShadow: C.shadow,
    },
    table: {
      width: '100%', borderCollapse: 'separate', borderSpacing: 0,
      fontSize: 13.5, fontVariantNumeric: 'tabular-nums',
    },
    group: {
      ...head, textAlign: 'center', borderBottom: RULE, fontSize: 10.5,
      color: C.accent, letterSpacing: 1.2,
    },
    head,
    headNum: { ...head, textAlign: END },
    headRow2: { position: 'sticky', top: 31, zIndex: 3 },   // directly under the group row
    stickyHead: { position: 'sticky', top: 0, zIndex: 3 },
    // The product name follows you across the numeric columns. zIndex below the header so
    // the two sticky planes cross correctly at the corner.
    stickyCol: {
      position: 'sticky', insetInlineStart: 0, zIndex: 2,
      borderInlineEnd: GROUP_RULE, minWidth: 220,
    },
    cell,
    num,
    foot,
    footNum: { ...foot, textAlign: END, fontVariantNumeric: 'tabular-nums' },
    BAND: IS_DAY ? '#f7f9fb' : '#1e2029',   // banding, a shade off the panel, not panel2
    OPEN: IS_DAY ? 'rgba(224,154,34,.12)' : 'rgba(240,168,48,.10)',
  };
})();

// One table for the whole page.
//
// `cols` is the column spec: { label, num } for a right-aligned figure, { end: true } to close
// a group with the heavier rule. `groups` is the optional second header row above it, given as
// { label, span }. `stickyFirst` freezes the first column, for the tables wide enough to scroll
// sideways.
function Grid({ cols, groups, stickyFirst, children }) {
  const corner = stickyFirst ? { ...G.stickyCol, zIndex: 5 } : null;
  const groupEnds = new Set();
  if (groups) {
    let at = 0;
    groups.forEach((g) => { at += g.span || 1; groupEnds.add(at - 1); });
  }
  return (
    <div style={G.frame}>
      <table style={G.table}>
        <thead>
          {groups && (
            <tr>
              {groups.map((g, i) => (
                <th key={i} colSpan={g.span || 1} style={{
                  ...G.group,
                  ...(i === 0 ? corner : null),
                  ...G.stickyHead,
                  ...(i === 0 && stickyFirst ? { zIndex: 5, textAlign: G.START } : null),
                  ...(i < groups.length - 1 ? { borderInlineEnd: G.GROUP_RULE } : null),
                }}>{g.label}</th>
              ))}
            </tr>
          )}
          <tr>
            {cols.map((c, i) => (
              <th key={i} style={{
                ...(c.num ? G.headNum : G.head),
                ...(i === 0 ? corner : null),
                ...(groups ? G.headRow2 : G.stickyHead),
                ...(i === 0 && stickyFirst ? { zIndex: 5 } : null),
                ...(c.end || groupEnds.has(i) ? { borderInlineEnd: G.GROUP_RULE } : null),
                ...(i === cols.length - 1 ? { borderInlineEnd: 'none' } : null),
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        {children}
      </table>
    </div>
  );
}

// The banded background. A real colour, never transparent: a frozen first column with a
// see-through cell shows the rows sliding underneath it.
const band = (i) => (i % 2 ? G.BAND : C.panel);

// An empty report and a broken report look identical unless the empty one says WHY.
const EmptyRow = ({ span, children }) => (
  <tr><td colSpan={span} style={{ padding: 32, textAlign: 'center', color: C.dim, background: C.panel }}>
    {children || (ARABIC ? 'لا بيانات في هذه الفترة' : 'Nothing in this period')}
  </td></tr>
);

// ── Stock ─────────────────────────────────────────────────────────────────────
//
// The columns read left to right as the sentence a stock take actually is: this is what you
// started with, this came in, this went out, this is what should be left, and this is what the
// shelf says. Opening and Closing are DERIVED — the shelf count is the only measured number —
// so a row that looks wrong is a prompt to open its movements, which is why every row opens.
const STOCK_GROUPS = [
  { label: ARABIC ? 'المنتج' : 'Product', span: 1 },
  { label: ARABIC ? 'الكميات' : 'Quantities', span: 7 },
  { label: ARABIC ? 'القيمة' : 'Value', span: 4 },
  { label: ARABIC ? 'المصدر' : 'Source', span: 1 },
];
const STOCK_COLS = [
  { label: '' },
  { label: ARABIC ? 'أول المدة' : 'Opening', num: true },
  { label: ARABIC ? 'وارد' : 'Received', num: true },
  { label: ARABIC ? 'مباع' : 'Sold', num: true },
  { label: ARABIC ? 'مرتجع' : 'Returned', num: true },
  { label: ARABIC ? 'تسوية' : 'Adjusted', num: true },
  { label: ARABIC ? 'آخر المدة' : 'Closing', num: true },
  { label: ARABIC ? 'على الرف' : 'On Shelf', num: true },
  { label: ARABIC ? 'التكلفة' : 'Unit Cost', num: true },
  { label: ARABIC ? 'قيمة المخزون' : 'Stock Value', num: true },
  { label: ARABIC ? 'الإيراد' : 'Revenue', num: true },
  { label: ARABIC ? 'الربح' : 'Profit', num: true },
  { label: ARABIC ? 'المورّد' : 'Supplier' },
];

function StockBody({ data, span, preset }) {
  const [open, setOpen] = useState(null);        // product id whose movements are showing
  const [only, setOnly] = useState('moved');     // moved | all | low | dead

  const rows = (data.rows || []).filter((r) => {
    if (only === 'all') return true;
    if (only === 'low') return r.low || r.out;
    if (only === 'dead') return r.dead;
    return Number(r.sold) !== 0 || Number(r.received) !== 0 || Number(r.adjusted) !== 0;
  });

  const FILTERS = [
    { key: 'moved', en: 'Moved', ar: 'تحرّك' },
    { key: 'low', en: 'Low / out', ar: 'منخفض / نافد' },
    { key: 'dead', en: 'No movement', ar: 'بدون حركة' },
    { key: 'all', en: 'Everything', ar: 'الكل' },
  ];

  return (
    <>
      <div style={KPI}>
        <Stat label={ARABIC ? 'قيمة المخزون الآن' : 'Stock Value Now'} value={amt(data.totals.stockValue)} accent />
        <Stat label={ARABIC ? 'مشتريات الفترة' : 'Purchases'} value={amt(data.totals.purchases)} />
        <Stat label={ARABIC ? 'تكلفة المبيعات' : 'Cost of Goods Sold'} value={amt(data.totals.cogs)} />
        <Stat label={ARABIC ? 'الربح' : 'Profit'} value={amt(data.totals.profit)} />
        <Stat label={ARABIC ? 'قطع مباعة' : 'Units Sold'} value={String(data.totals.sold)} />
        <Stat label={ARABIC ? 'قطع مستلمة' : 'Units Received'} value={String(data.totals.received)} />
        <Stat label={ARABIC ? 'نافد' : 'Out of Stock'} value={String(data.kpi.outCount)} />
        <Stat label={ARABIC ? 'منخفض' : 'Low'} value={String(data.kpi.lowCount)} />
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0' }}>
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setOnly(f.key)} style={{
            padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
            fontFamily: 'inherit',
            background: only === f.key ? C.accent : C.panel2,
            color: only === f.key ? C.accentText : C.text,
            border: `1px solid ${only === f.key ? C.accent : C.line}`,
          }}>{L(f)}</button>
        ))}
        <span style={{ alignSelf: 'center', color: C.dim, fontSize: 13 }}>
          {rows.length} / {data.rows.length} {ARABIC ? 'منتج' : 'products'}
        </span>
      </div>

      {/* The group row names the four things a stock line is made of, so thirteen columns
          read as four ideas instead of thirteen unrelated numbers. */}
      <Grid stickyFirst groups={STOCK_GROUPS} cols={STOCK_COLS}>
        <tbody>
            {!rows.length && (
              <EmptyRow span={13}><NoSales span={span} preset={preset} /></EmptyRow>
            )}
            {rows.map((r, i) => {
              const isOpen = open === r.id;
              const detail = (r.receipts || []).length + (r.adjustments || []).length;
              const bg = isOpen ? G.OPEN : band(i);
              const cell = { ...G.cell, background: bg };
              const num = { ...G.num, background: bg };
              return (
                <React.Fragment key={r.id}>
                  <tr onClick={() => setOpen(isOpen ? null : r.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ ...cell, ...G.stickyCol, background: bg }}>
                      <span style={{ color: isOpen ? C.accent : C.dim, marginInlineEnd: 8, fontSize: 11 }}>
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <span style={{ fontWeight: 600 }}>{r.name}</span>
                      {r.size ? <span style={{ color: C.dim }}> · {r.size}</span> : ''}
                      {r.out
                        ? <Pill color={C.red}>{ARABIC ? 'نافد' : 'OUT'}</Pill>
                        : r.low ? <Pill color={C.red} hollow>{ARABIC ? 'منخفض' : 'LOW'}</Pill>
                        : r.dead ? <Pill color={C.dim} hollow>{ARABIC ? 'راكد' : 'NO MOVEMENT'}</Pill> : null}
                    </td>
                    <td style={{ ...num, color: C.dim }}>{r.opening}</td>
                    <td style={{ ...num, color: Number(r.received) ? C.green : C.dim, fontWeight: Number(r.received) ? 700 : 400 }}>{r.received}</td>
                    <td style={num}>{r.sold}</td>
                    <td style={{ ...num, color: Number(r.returned) ? C.red : C.dim }}>{r.returned}</td>
                    {/* A manual correction is the movement with no paperwork behind it, so it is
                        the one worth colouring: it is where shrinkage gets written off. */}
                    <td style={{ ...num, color: Number(r.adjusted) ? C.red : C.dim, fontWeight: Number(r.adjusted) ? 800 : 400 }}>
                      {Number(r.adjusted) > 0 ? `+${r.adjusted}` : r.adjusted}
                    </td>
                    <td style={{ ...num, fontWeight: 800 }}>{r.closing}</td>
                    <td style={{ ...num, borderInlineEnd: G.GROUP_RULE }}>
                      {r.stockNow}<span style={{ color: C.dim, fontSize: 11.5 }}> / {r.lowAt}</span>
                    </td>
                    <td style={{ ...num, color: C.dim }}>{r.unitCost}</td>
                    <td style={num}>{r.stockValue}</td>
                    <td style={num}>{r.revenue}</td>
                    <td style={{ ...num, borderInlineEnd: G.GROUP_RULE, fontWeight: 700, color: Number(r.profit) < 0 ? C.red : C.green }}>{r.profit}</td>
                    <td style={{ ...cell, color: C.dim, fontSize: 12, whiteSpace: 'normal', maxWidth: 200 }}>
                      {r.suppliers && r.suppliers.length ? r.suppliers.join(', ') : '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={13} style={{
                        background: C.panel2, padding: '14px 16px',
                        borderBottom: G.GROUP_RULE, borderTop: `1px solid ${C.accent}`,
                      }}>
                        <StockDetail row={r} count={detail} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
          {/* The totals stay on screen while the list scrolls — the figure you are checking a
              row against is the one that must not scroll away from it. */}
          {!!rows.length && (
            <tfoot>
              <tr>
                <td style={{ ...G.foot, ...G.stickyCol, zIndex: 4, background: C.panel2, textAlign: ARABIC ? 'right' : 'left' }}>
                  {ARABIC ? 'الإجمالي' : 'TOTAL'}
                </td>
                <td style={G.footNum}>{data.totals.opening}</td>
                <td style={G.footNum}>{data.totals.received}</td>
                <td style={G.footNum}>{data.totals.sold}</td>
                <td style={G.footNum}>{data.totals.returned}</td>
                <td style={G.footNum}>{data.totals.adjusted}</td>
                <td style={G.footNum}>{data.totals.closing}</td>
                <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE }}>{data.totals.stockNow}</td>
                <td style={G.footNum} />
                <td style={G.footNum}>{data.totals.stockValue}</td>
                <td style={G.footNum}>{data.totals.revenue}</td>
                <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE, color: Number(data.totals.profit) < 0 ? C.red : C.green }}>
                  {data.totals.profit}
                </td>
                <td style={{ ...G.foot, borderInlineEnd: 'none' }} />
              </tr>
            </tfoot>
          )}
      </Grid>

      {/* Movements against a product that is no longer in the catalogue. Dropping them
          silently would make the totals disagree with the sales report for no visible
          reason. */}
      {!!(data.orphans || []).length && (
        <div style={{ border: `1px solid ${C.red}`, borderRadius: 12, padding: 12, fontSize: 13 }}>
          <div style={{ fontWeight: 800, color: C.red, marginBottom: 6 }}>
            ⚠ {ARABIC ? 'حركة على منتجات محذوفة' : 'Movement on products no longer in the catalogue'}
          </div>
          {data.orphans.map((o) => (
            <div key={o.id} style={{ color: C.dim }}>
              #{o.id} — {ARABIC ? 'مباع' : 'sold'} {o.sold}, {ARABIC ? 'وارد' : 'received'} {o.received}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const Pill = ({ color, hollow, children }) => (
  <span style={{
    marginInlineStart: 8, fontSize: 10, fontWeight: 800, borderRadius: 8, padding: '2px 7px',
    whiteSpace: 'nowrap',
    color: hollow ? color : C.accentText, background: hollow ? 'transparent' : color,
    border: `1px solid ${color}`,
  }}>{children}</span>
);

// The evidence under one product's row: every delivery and every correction, dated, with the
// supplier or the person who made it. Sales are not itemised here — they are in the Sales and
// Receipts tabs, invoice by invoice, and repeating 400 of them per product would bury the two
// rows that actually explain a discrepancy.
function StockDetail({ row, count }) {
  const START = ARABIC ? 'right' : 'left';
  const END = ARABIC ? 'left' : 'right';
  const cell = {
    padding: '7px 10px', borderBottom: `1px solid ${C.line}`,
    borderInlineEnd: `1px solid ${C.line}`, fontSize: 12.5, textAlign: START,
    whiteSpace: 'nowrap',
  };
  const num = { ...cell, textAlign: END, fontVariantNumeric: 'tabular-nums' };
  const head = {
    ...cell, color: C.dim, fontSize: 10.5, fontWeight: 800,
    letterSpacing: .6, textTransform: 'uppercase', background: C.panel,
  };

  if (!count) {
    return (
      <div style={{ color: C.dim, fontSize: 13, padding: '4px 2px' }}>
        {ARABIC
          ? 'لا استلام ولا تسويات في هذه الفترة — الحركة كلها بيع.'
          : 'No deliveries or corrections in this period — every movement was a sale.'}
      </div>
    );
  }
  return (
    <div>
      <div style={{
        fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
        color: C.accent, marginBottom: 8,
      }}>
        {ARABIC ? 'حركة المخزون' : 'Movements'} · {row.name}
      </div>
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 10, overflow: 'auto', background: C.panel }}>
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontVariantNumeric: 'tabular-nums' }}>
          <thead><tr>
            <th style={head}>{ARABIC ? 'التاريخ' : 'Date'}</th>
            <th style={head}>{ARABIC ? 'الحركة' : 'Movement'}</th>
            <th style={head}>{ARABIC ? 'المورّد / بواسطة' : 'Supplier / By'}</th>
            <th style={{ ...head, textAlign: END }}>{ARABIC ? 'الكمية' : 'Qty'}</th>
            <th style={{ ...head, textAlign: END }}>{ARABIC ? 'سعر الوحدة' : 'Unit Cost'}</th>
            <th style={{ ...head, textAlign: END }}>{ARABIC ? 'الإجمالي' : 'Total Cost'}</th>
            <th style={{ ...head, borderInlineEnd: 'none' }}>{ARABIC ? 'من ← إلى' : 'From → To'}</th>
          </tr></thead>
          <tbody>
            {(row.receipts || []).map((b, i) => (
              <tr key={`r${i}`}>
                <td style={cell}>{b.date}</td>
                <td style={cell}><Tag color={C.green}>{ARABIC ? 'استلام' : 'Received'}</Tag></td>
                <td style={cell}>{b.supplier || '—'}</td>
                <td style={{ ...num, color: C.green, fontWeight: 700 }}>+{b.qty}</td>
                <td style={num}>{b.unitCost}</td>
                <td style={num}>{b.lineCost}</td>
                <td style={{ ...cell, borderInlineEnd: 'none' }} />
              </tr>
            ))}
            {(row.adjustments || []).map((a, i) => (
              <tr key={`a${i}`}>
                <td style={cell}>{a.date}</td>
                <td style={cell}><Tag color={C.red}>{ADJUST_LABEL(a.kind)}</Tag></td>
                <td style={cell}>{a.by || '—'}</td>
                <td style={{ ...num, color: Number(a.delta) < 0 ? C.red : C.green, fontWeight: 700 }}>
                  {Number(a.delta) > 0 ? `+${a.delta}` : a.delta}
                </td>
                <td style={num} /><td style={num} />
                <td style={{ ...cell, borderInlineEnd: 'none', color: C.dim }}>{a.fromQty} → {a.toQty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// A movement type reads as a coloured chip, not as coloured text: at 12.5px, green words and
// red words in the same column are harder to tell apart than two chips are.
const Tag = ({ color, children }) => (
  <span style={{
    display: 'inline-block', fontSize: 10.5, fontWeight: 800, letterSpacing: .4,
    padding: '3px 8px', borderRadius: 999, color,
    border: `1px solid ${color}`, background: 'transparent', whiteSpace: 'nowrap',
  }}>{children}</span>
);

const ADJUST_LABEL = (kind) => (ARABIC
  ? ({ adjust: 'تسوية يدوية', create: 'إنشاء منتج', import: 'استيراد' }[kind] || kind)
  : ({ adjust: 'Manual correction', create: 'Product created', import: 'Bulk import' }[kind] || kind));

// "No sales on <day>" plus the last day that actually has sales, as a button. The shop closes
// at night and the page opens on "today", so a blank screen at 10am is the normal case, not
// the failure case — it has to be told apart from a failure at a glance.
function NoSales({ span, preset, date, onJump }) {
  const last = span && span.last;
  const when = date || (preset === 'today' ? localToday() : null);
  return (
    <span>
      <span style={{ display: 'block' }}>
        {when
          ? (ARABIC ? `لا مبيعات في ${when}` : `No sales on ${when}`)
          : (ARABIC ? 'لا مبيعات في هذه الفترة' : 'No sales in this period')}
      </span>
      {last && last !== when && (
        <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
          {ARABIC ? 'آخر يوم فيه مبيعات' : 'Last day with sales'}:{' '}
          {onJump ? (
            <button onClick={() => onJump(last)} style={{
              ...S.btnGhost, padding: '4px 10px', color: C.accent, borderColor: C.accent,
            }}>{last}</button>
          ) : <b style={{ color: C.text }}>{last}</b>}
        </span>
      )}
      {span && !span.orders && (
        <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
          {ARABIC ? 'لا توجد مبيعات مسجّلة بعد' : 'No sales have been recorded yet'}
        </span>
      )}
    </span>
  );
}

function Body({ tab, data, isAdmin, onDelete, span, preset, receiptDate, onJump, onOpenReceipt, onVoidReceipt }) {
  if (tab === 'sales') {
    return (
      <>
        <div style={KPI}>
          {/* Two totals, side by side and labelled, because they measure different things:
              Total Sales is what was collected; Grand Total is sub + tax. On this build they
              agree for an ordinary sale — where they do not, the difference is real. */}
          <Stat label={ARABIC ? 'إجمالي المبيعات' : 'Total Sales'} value={amt(data.kpi.totalSales)} accent />
          <Stat label={ARABIC ? 'الفواتير' : 'Bills'} value={String(data.kpi.orders)} />
          <Stat label={ARABIC ? 'قبل الضريبة' : 'Before Tax'} value={amt(data.totals.sub)} />
          <Stat label={ARABIC ? 'الضريبة' : 'Tax'} value={amt(data.totals.tax)} />
        </div>
        {/* The bill and its date identify the row; the four figures to the right of the rule
            are the money, and they are the only columns that add up. */}
        <Grid
          groups={[
            { label: ARABIC ? 'الفاتورة' : 'Bill', span: 3 },
            { label: ARABIC ? 'المبالغ' : 'Amounts', span: 4 },
          ]}
          cols={[
            { label: ARABIC ? 'رقم الفاتورة' : 'Bill No' },
            { label: ARABIC ? 'التاريخ' : 'Date' },
            { label: ARABIC ? 'القطع' : 'Items', num: true },
            { label: ARABIC ? 'قبل الضريبة' : 'Before Tax', num: true },
            { label: ARABIC ? 'الضريبة' : 'Tax', num: true },
            { label: ARABIC ? 'الإجمالي' : 'Grand Total', num: true },
            { label: ARABIC ? 'الخصم' : 'Discount', num: true },
          ]}>
          <tbody>
            {!data.rows.length && <EmptyRow span={7}><NoSales span={span} preset={preset} /></EmptyRow>}
            {data.rows.map((r, i) => {
              const cell = { ...G.cell, background: band(i) };
              const num = { ...G.num, background: band(i) };
              return (
                <tr key={i}>
                  <td style={{ ...cell, fontWeight: 700 }}>{r.billNo}</td>
                  <td style={{ ...cell, color: C.dim }}>{r.date}</td>
                  <td style={{ ...num, borderInlineEnd: G.GROUP_RULE }}>{r.itemsSold}</td>
                  <td style={num}>{r.sub}</td>
                  <td style={{ ...num, color: C.dim }}>{r.tax}</td>
                  <td style={{ ...num, fontWeight: 800 }}>{r.grandTotal}</td>
                  <td style={{
                    ...num, borderInlineEnd: 'none',
                    color: Number(r.disc) ? C.green : C.dim, fontWeight: Number(r.disc) ? 700 : 400,
                  }}>{r.disc}</td>
                </tr>
              );
            })}
          </tbody>
          {!!data.rows.length && (
            <tfoot><tr>
              <td style={G.foot}>{ARABIC ? 'الإجمالي' : 'TOTAL'}</td>
              <td style={G.foot} />
              <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE }}>{data.totals.itemsSold}</td>
              <td style={G.footNum}>{data.totals.sub}</td>
              <td style={G.footNum}>{data.totals.tax}</td>
              <td style={G.footNum}>{data.totals.grandTotal}</td>
              <td style={{ ...G.footNum, borderInlineEnd: 'none' }}>{data.totals.disc}</td>
            </tr></tfoot>
          )}
        </Grid>
      </>
    );
  }

  // Discounts — one row per discounted LINE, with the reason it was given.
  //
  // This is the ONLY place the reason appears. It is deliberately absent from the bill, the
  // thermal roll and the customer display: "staff friend" or "damaged label" is a note
  // between the shop and its own records, and handing it to the customer invites an argument
  // at the counter over who gets what.
  if (tab === 'discounts') {
    return (
      <>
        <div style={KPI}>
          <Stat label={ARABIC ? 'إجمالي الخصم' : 'Total Discount'} value={amt(data.totals.disc)} accent />
          <Stat label={ARABIC ? 'أسطر مخصومة' : 'Discounted Lines'} value={String(data.kpi.discountedLines)} />
          <Stat label={ARABIC ? 'قبل الخصم' : 'Before Discount'} value={amt(data.totals.gross)} />
        </div>
        <Grid
          groups={[
            { label: ARABIC ? 'السطر' : 'Line', span: 4 },
            { label: ARABIC ? 'المبالغ' : 'Amounts', span: 3 },
            { label: ARABIC ? 'من ولماذا' : 'Who & Why', span: 2 },
          ]}
          cols={[
            { label: ARABIC ? 'التاريخ' : 'Date' },
            { label: ARABIC ? 'رقم الفاتورة' : 'Bill No' },
            { label: ARABIC ? 'الصنف' : 'Item' },
            { label: ARABIC ? 'الكمية' : 'Qty', num: true },
            { label: ARABIC ? 'قبل الخصم' : 'Before', num: true },
            { label: ARABIC ? 'الخصم' : 'Discount', num: true },
            { label: ARABIC ? 'بعد الخصم' : 'After', num: true },
            { label: ARABIC ? 'السبب' : 'Reason' },
            { label: ARABIC ? 'الكاشير' : 'Cashier' },
          ]}>
          <tbody>
            {!data.rows.length && (
              <EmptyRow span={9}>
                {ARABIC ? 'لا خصومات في هذه الفترة' : 'No discounts given in this period'}
              </EmptyRow>
            )}
            {data.rows.map((r, i) => {
              const cell = { ...G.cell, background: band(i) };
              const num = { ...G.num, background: band(i) };
              return (
                <tr key={i}>
                  <td style={{ ...cell, color: C.dim }}>{r.date}</td>
                  <td style={{ ...cell, fontWeight: 700 }}>{r.billNo}</td>
                  <td style={cell}>{r.item}{r.size ? <span style={{ color: C.dim }}> · {r.size}</span> : ''}</td>
                  <td style={{ ...num, borderInlineEnd: G.GROUP_RULE }}>{r.qty}</td>
                  <td style={{ ...num, color: C.dim }}>{r.gross}</td>
                  {/* The amount AND the rate in one cell, rather than a tenth column: the till
                      takes the discount as a percentage, so that is the number the cashier
                      authorised and the owner recognises - but the money is what the P&L moves
                      by, so neither one can be the only figure shown. */}
                  <td style={{ ...num, color: C.green, fontWeight: 800 }}>
                    −{r.disc}
                    {r.pct && r.pct !== '0' && (
                      <span style={{ color: C.dim, fontWeight: 700, fontSize: 12 }}> ({r.pct}%)</span>
                    )}
                  </td>
                  <td style={{ ...num, fontWeight: 700, borderInlineEnd: G.GROUP_RULE }}>{r.net}</td>
                  {/* A discount with no reason recorded is itself worth seeing, so say so rather
                      than leaving the cell blank and ambiguous. */}
                  <td style={{ ...cell, color: r.note ? C.text : C.dim, whiteSpace: 'normal', maxWidth: 260 }}>
                    {r.note || (ARABIC ? '— بدون سبب' : '— none given')}
                  </td>
                  <td style={{ ...cell, borderInlineEnd: 'none', color: C.dim }}>{r.cashier}</td>
                </tr>
              );
            })}
          </tbody>
          {!!data.rows.length && (
            <tfoot><tr>
              <td style={G.foot}>{ARABIC ? 'الإجمالي' : 'TOTAL'}</td>
              <td style={G.foot} /><td style={G.foot} />
              <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE }} />
              <td style={G.footNum}>{data.totals.gross}</td>
              <td style={{ ...G.footNum, color: C.green }}>−{data.totals.disc}</td>
              <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE }} /><td style={G.foot} />
              <td style={{ ...G.foot, borderInlineEnd: 'none' }} />
            </tr></tfoot>
          )}
        </Grid>
      </>
    );
  }

  if (tab === 'stock') return <StockBody data={data} span={span} preset={preset} />;

  if (tab === 'expenses') {
    return (
      <>
        <div style={KPI}>
          <Stat label={ARABIC ? 'إجمالي المصاريف' : 'Total Expenses'} value={amt(data.totals.value)} accent />
          <Stat label={ARABIC ? 'عدد القيود' : 'Entries'} value={String(data.rows.length)} />
        </div>
        <Grid cols={[
          { label: ARABIC ? 'التاريخ' : 'Date' },
          { label: ARABIC ? 'النوع' : 'Type' },
          { label: ARABIC ? 'المورّد' : 'Supplier' },
          { label: ARABIC ? 'طريقة الدفع' : 'Paid By' },
          { label: ARABIC ? 'القيمة' : 'Value', num: true, end: true },
          { label: ARABIC ? 'ملاحظة' : 'Note' },
          { label: '' },
        ]}>
          <tbody>
            {!data.rows.length && (
              <EmptyRow span={7}>
                {ARABIC
                  ? 'لا مصاريف مسجّلة في هذه الفترة'
                  : 'No expenses recorded in this period'}
                {isAdmin && (
                  <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                    {ARABIC ? 'اضغط “+ مصروف” لإضافة واحد' : 'Use “+ Expense” to add one'}
                  </span>
                )}
              </EmptyRow>
            )}
            {data.rows.map((e, i) => {
              const cell = { ...G.cell, background: band(i) };
              return (
                <tr key={e.id}>
                  <td style={{ ...cell, color: C.dim }}>{e.date}</td>
                  <td style={{ ...cell, fontWeight: 600 }}>{e.type}</td>
                  <td style={cell}>{e.supplier || '—'}</td>
                  <td style={cell}>{e.paymentMethod ? <Tag color={C.dim}>{e.paymentMethod}</Tag> : '—'}</td>
                  <td style={{ ...G.num, background: band(i), borderInlineEnd: G.GROUP_RULE, fontWeight: 800, color: C.red }}>
                    {e.value}
                  </td>
                  <td style={{ ...cell, color: C.dim, whiteSpace: 'normal', maxWidth: 280 }}>{e.note}</td>
                  <td style={{ ...cell, borderInlineEnd: 'none', textAlign: 'center' }}>
                    {isAdmin && (
                      <button onClick={() => onDelete(e.id)} title={ARABIC ? 'حذف' : 'Delete'}
                        style={{ ...S.btnGhost, padding: '4px 10px', color: C.red }}>✕</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          {!!data.rows.length && (
            <tfoot><tr>
              <td style={G.foot}>{ARABIC ? 'الإجمالي' : 'TOTAL'}</td>
              <td style={G.foot} /><td style={G.foot} /><td style={G.foot} />
              <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE, color: C.red }}>{data.totals.value}</td>
              <td style={G.foot} />
              <td style={{ ...G.foot, borderInlineEnd: 'none' }} />
            </tr></tfoot>
          )}
        </Grid>
      </>
    );
  }

  // P&L is a STATEMENT, not three loose cards: three lines that subtract down to one figure,
  // ruled where the arithmetic happens, so it reads the way it would on paper.
  if (tab === 'pnl') {
    const line = {
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
      gap: 24, padding: '14px 18px', borderBottom: G.RULE,
    };
    const figure = { fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: 17 };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
        <div style={{
          border: G.RULE, borderRadius: 14, background: C.panel, boxShadow: C.shadow,
          overflow: 'hidden',
        }}>
          <div style={{
            ...G.head, position: 'static', borderBottom: G.GROUP_RULE, color: C.accent,
            letterSpacing: 1.2, fontSize: 10.5, padding: '10px 18px',
          }}>
            {ARABIC ? 'قائمة الدخل' : 'Profit & Loss'}
          </div>
          <div style={line}>
            <span>{ARABIC ? 'إجمالي الإيرادات' : 'Total Revenue'}</span>
            <span style={{ ...figure, color: C.green }}>{amt(data.totalRevenue)}</span>
          </div>
          <div style={{ ...line, borderBottom: G.GROUP_RULE }}>
            <span>{ARABIC ? 'ناقص المصاريف' : 'Less Expenses'}</span>
            <span style={{ ...figure, color: C.red }}>− {amt(data.totalExpenses)}</span>
          </div>
          <div style={{ ...line, borderBottom: 'none', background: C.panel2, padding: '18px' }}>
            <span style={{ fontWeight: 800 }}>{ARABIC ? 'الربح الإجمالي' : 'Gross Profit'}</span>
            <span style={{
              ...figure, fontSize: 24, fontWeight: 800,
              color: Number(data.grossProfit) < 0 ? C.red : C.accent,
            }}>{amt(data.grossProfit)}</span>
          </div>
        </div>
        {/* Said on the page, not only in the code: the label says Gross Profit, but the figure
            is cash in minus cash out. Product cost is not in it — the margin report that does
            know costs lives on the operational Reports page. */}
        <div style={{ color: C.dim, fontSize: 13, lineHeight: 1.6 }}>
          {ARABIC
            ? 'نقد داخل ناقص نقد خارج — لا يشمل كلفة البضاعة. المبيعات الملغاة غير محتسبة.'
            : 'Cash in minus cash out — excludes cost of goods. Voided sales are not counted.'}
          {/* Without this line, "Gross Profit == Total Revenue" looks like the expenses side
              failed to load rather than like a period with nothing recorded in it. */}
          {data.totalExpenses === '0.000' && (
            <span style={{ display: 'block', marginTop: 6 }}>
              {ARABIC
                ? 'لا مصاريف مسجّلة في هذه الفترة، لذلك الربح يساوي الإيراد.'
                : 'No expenses recorded in this period, so profit equals revenue.'}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Receipts — voided bills still render, struck through and dimmed, but out of the total.
  return (
    <>
      <div style={KPI}>
        <Stat label={ARABIC ? 'إجمالي اليوم' : 'Day total'} value={amt(data.dayTotal)} accent />
        {/* Row count next to the money: "8 bills / 96.500" answers "is this the whole day?"
            which the total alone cannot. Voided rows are counted here but not in the total,
            so the two figures disagreeing is itself information. */}
        <Stat label={ARABIC ? 'عدد الفواتير' : 'Bills'} value={String(data.rows.length)} />
      </div>
      <Grid cols={[
        { label: ARABIC ? 'رقم الفاتورة' : 'Bill No' },
        { label: ARABIC ? 'الوقت' : 'Time' },
        { label: ARABIC ? 'الكاشير' : 'Cashier' },
        { label: ARABIC ? 'الدفع' : 'Paid By' },
        { label: ARABIC ? 'الإجمالي' : 'Total', num: true, end: true },
        { label: '' },
      ]}>
        <tbody>
          {!data.rows.length && (
            <EmptyRow span={6}><NoSales span={span} date={receiptDate} onJump={onJump} /></EmptyRow>
          )}
          {data.rows.map((o, i) => {
            const cell = { ...G.cell, background: band(i) };
            // A voided bill is struck through, but only over the FIGURES — dimming the whole
            // row would hide the Receipt button that is the reason to open it.
            const dead = o.voided ? { color: C.dim, textDecoration: 'line-through' } : null;
            return (
              <tr key={o.id}>
                <td style={{ ...cell, fontWeight: 700, ...dead }}>
                  {o.invoice_no ?? String(o.id).slice(0, 6).toUpperCase()}
                  {o.voided && <Pill color={C.red} hollow>{ARABIC ? 'ملغاة' : 'VOID'}</Pill>}
                </td>
                <td style={{ ...cell, color: C.dim }}>{o.time}</td>
                <td style={cell}>{o.waiter}</td>
                <td style={cell}>{o.pay ? <Tag color={C.dim}>{o.pay}</Tag> : '—'}</td>
                <td style={{ ...G.num, background: band(i), borderInlineEnd: G.GROUP_RULE, fontWeight: 800, ...dead }}>
                  {o.total}
                </td>
                <td style={{ ...cell, borderInlineEnd: 'none', textAlign: 'center' }}>
                  <button onClick={() => onOpenReceipt(o.id)} style={{ ...S.btnGhost, padding: '4px 12px' }}>
                    {ARABIC ? 'الفاتورة' : 'Receipt'}
                  </button>
                  {/* Void, not delete. The row and its invoice number stay (migration 0006), and
                      the goods go back to stock — see ReceiptModal for the full reasoning. An
                      already-voided row shows nothing here: there is nothing left to do to it. */}
                  {isAdmin && !o.voided && (
                    <button onClick={() => onVoidReceipt(o)} title={ARABIC ? 'إلغاء الفاتورة' : 'Void'}
                      style={{ ...S.btnGhost, padding: '4px 10px', marginInlineStart: 6, color: C.red, borderColor: C.red }}>✕</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        {!!data.rows.length && (
          <tfoot><tr>
            <td style={G.foot}>{ARABIC ? 'إجمالي اليوم' : 'DAY TOTAL'}</td>
            <td style={G.foot} /><td style={G.foot} /><td style={G.foot} />
            <td style={{ ...G.footNum, borderInlineEnd: G.GROUP_RULE }}>{data.dayTotal}</td>
            <td style={{ ...G.foot, borderInlineEnd: 'none' }} />
          </tr></tfoot>
        )}
      </Grid>
    </>
  );
}

// Add an expense. Admin-only in the UI; the API enforces the same thing with the
// `reports:edit` grant, so hiding this button is convenience, not security.
function ExpenseModal({ types, onClose, onSaved, notify }) {
  const [type, setType] = useState('');
  const [value, setValue] = useState('');
  const [supplier, setSupplier] = useState('');
  const [date, setDate] = useState(localToday());
  const [method, setMethod] = useState('petty_cash');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const name = type.trim();
    if (!name || !value || !date) {
      notify(ARABIC ? 'النوع والقيمة والتاريخ مطلوبة' : 'Type, value and date are required', 'red');
      return;
    }
    setSaving(true);
    try {
      // A new type name is added to the shared list as well, so it is offered next time. The
      // expense itself stores the LABEL, not a reference — deleting the type later must never
      // rewrite this row.
      if (!types.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
        await api.post('/reports/expense-types', { name }).catch(() => {});
      }
      await api.post(`/reports/${FLOOR}/expenses`, {
        type: name, value, supplier, date, payment_method: method, note,
      });
      onSaved();
    } catch (e) {
      notify(e.status === 403
        ? (ARABIC ? 'لا تملك صلاحية التعديل' : 'You do not have the edit permission')
        : (ARABIC ? 'تعذّر الحفظ' : 'Save failed'), 'red');
      setSaving(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: C.panel, border: `1px solid ${C.line}`, borderRadius: 16, padding: 20,
        width: 'min(460px, 100%)', display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{ARABIC ? 'مصروف جديد' : 'New expense'}</div>

        <input list="expense-types" value={type} onChange={(e) => setType(e.target.value)}
          placeholder={ARABIC ? 'النوع (إيجار، كهرباء…)' : 'Type (Rent, Electricity…)'} style={S.input} />
        <datalist id="expense-types">
          {types.map((t) => <option key={t.id} value={t.name} />)}
        </datalist>

        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal"
          placeholder={`${ARABIC ? 'القيمة' : 'Value'} (${CURRENCY})`} style={S.input} />
        <input value={supplier} onChange={(e) => setSupplier(e.target.value)}
          placeholder={ARABIC ? 'المورّد' : 'Supplier'} style={S.input} />
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={S.input} />

        <div style={{ display: 'flex', gap: 8 }}>
          {PAY_METHODS.map((m) => (
            <button key={m.key} onClick={() => setMethod(m.key)} style={{
              ...S.btn, flex: 1, padding: '10px 8px',
              background: method === m.key ? C.accent : C.panel2,
              color: method === m.key ? C.accentText : C.text,
              border: `1px solid ${method === m.key ? C.accent : C.line}`,
            }}>{L(m)}</button>
          ))}
        </div>

        <input value={note} onChange={(e) => setNote(e.target.value)}
          placeholder={ARABIC ? 'ملاحظة' : 'Note'} style={S.input} />

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} style={{ ...S.btnGhost, flex: 1, padding: '12px 0', fontSize: 15 }}>
            {ARABIC ? 'إلغاء' : 'Cancel'}
          </button>
          <button onClick={save} disabled={saving} style={{ ...S.btn, flex: 1, padding: '12px 0', fontSize: 15, opacity: saving ? .6 : 1 }}>
            {ARABIC ? 'حفظ' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default StoreReportsView;
