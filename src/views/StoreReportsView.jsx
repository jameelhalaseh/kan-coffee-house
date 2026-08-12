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
import { C, S } from '../theme';
import { ARABIC, CURRENCY, DEFAULT_FLOOR } from '../client.config';
import { Stat, th, td } from '../components/ui';
import ReceiptModal from '../components/ReceiptModal';

const FLOOR = DEFAULT_FLOOR;   // single store; the API is still store-scoped

const TABS = [
  { key: 'sales', en: 'Sales', ar: 'المبيعات', export: 'sales' },
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

const TOTAL_ROW = { fontWeight: 800, background: C.panel2 };
const dateInput = { ...S.input, width: 'auto' };

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

function Table({ head, children }) {
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: 12 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontVariantNumeric: 'tabular-nums' }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// An empty report and a broken report look identical unless the empty one says WHY. The shop
// closes at night and the page opens on "today", so a blank screen at 10am is the normal case,
// not the failure case — it has to be told apart from a failure at a glance.
const Empty = ({ children }) => (
  <tr><td style={{ ...td, color: C.dim, textAlign: 'center', padding: 26 }} colSpan={12}>
    {children || (ARABIC ? 'لا بيانات في هذه الفترة' : 'Nothing in this period')}
  </td></tr>
);

// "No sales on <day>" plus the last day that actually has sales, as a button.
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
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {/* Two totals, side by side and labelled, because they measure different things:
              Total Sales is what was collected; Grand Total is sub + tax. On this build they
              agree for an ordinary sale — where they do not, the difference is real. */}
          <Stat label={ARABIC ? 'إجمالي المبيعات' : 'Total Sales'} value={amt(data.kpi.totalSales)} accent />
          <Stat label={ARABIC ? 'الفواتير' : 'Bills'} value={String(data.kpi.orders)} />
          <Stat label={ARABIC ? 'قبل الضريبة' : 'Before Tax'} value={amt(data.totals.sub)} />
          <Stat label={ARABIC ? 'الضريبة' : 'Tax'} value={amt(data.totals.tax)} />
        </div>
        <Table head={[ARABIC ? 'رقم الفاتورة' : 'Bill No', ARABIC ? 'التاريخ' : 'Date',
          ARABIC ? 'القطع' : 'Items Sold', ARABIC ? 'قبل الضريبة' : 'Amount Before Tax',
          ARABIC ? 'الضريبة' : 'Tax Amount', ARABIC ? 'الإجمالي' : 'Grand Total',
          ARABIC ? 'الخصم' : 'Discount']}>
          {!data.rows.length && <Empty><NoSales span={span} preset={preset} /></Empty>}
          {data.rows.map((r, i) => (
            <tr key={i}>
              <td style={td}>{r.billNo}</td><td style={td}>{r.date}</td>
              <td style={td}>{r.itemsSold}</td><td style={td}>{r.sub}</td>
              <td style={td}>{r.tax}</td><td style={td}>{r.grandTotal}</td><td style={td}>{r.disc}</td>
            </tr>
          ))}
          {!!data.rows.length && (
            <tr style={TOTAL_ROW}>
              <td style={td}>TOTAL</td><td style={td} />
              <td style={td}>{data.totals.itemsSold}</td><td style={td}>{data.totals.sub}</td>
              <td style={td}>{data.totals.tax}</td><td style={td}>{data.totals.grandTotal}</td>
              <td style={td}>{data.totals.disc}</td>
            </tr>
          )}
        </Table>
      </>
    );
  }

  if (tab === 'expenses') {
    return (
      <>
        <Stat label={ARABIC ? 'إجمالي المصاريف' : 'Total Expenses'} value={amt(data.totals.value)} accent />
        <Table head={[ARABIC ? 'التاريخ' : 'Date', ARABIC ? 'النوع' : 'Type',
          ARABIC ? 'المورّد' : 'Supplier', ARABIC ? 'طريقة الدفع' : 'Payment Method',
          ARABIC ? 'القيمة' : 'Value', ARABIC ? 'ملاحظة' : 'Note', '']}>
          {!data.rows.length && (
            <Empty>
              {ARABIC
                ? 'لا مصاريف مسجّلة في هذه الفترة'
                : 'No expenses recorded in this period'}
              {isAdmin && (
                <span style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
                  {ARABIC ? 'اضغط “+ مصروف” لإضافة واحد' : 'Use “+ Expense” to add one'}
                </span>
              )}
            </Empty>
          )}
          {data.rows.map((e) => (
            <tr key={e.id}>
              <td style={td}>{e.date}</td><td style={td}>{e.type}</td>
              <td style={td}>{e.supplier}</td><td style={td}>{e.paymentMethod}</td>
              <td style={td}>{e.value}</td><td style={td}>{e.note}</td>
              <td style={td}>
                {isAdmin && (
                  <button onClick={() => onDelete(e.id)} title={ARABIC ? 'حذف' : 'Delete'}
                    style={{ ...S.btnGhost, padding: '4px 10px', color: C.red }}>✕</button>
                )}
              </td>
            </tr>
          ))}
          {!!data.rows.length && (
            <tr style={TOTAL_ROW}>
              <td style={td}>TOTAL</td><td style={td} /><td style={td} /><td style={td} />
              <td style={td}>{data.totals.value}</td><td style={td} /><td style={td} />
            </tr>
          )}
        </Table>
      </>
    );
  }

  if (tab === 'pnl') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
        <Stat label={ARABIC ? 'إجمالي الإيرادات' : 'Total Revenue'} value={amt(data.totalRevenue)} accent />
        <Stat label={ARABIC ? 'إجمالي المصاريف' : 'Total Expenses'} value={amt(data.totalExpenses)} />
        <Stat label={ARABIC ? 'الربح الإجمالي' : 'Gross Profit'} value={amt(data.grossProfit)} />
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
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Stat label={ARABIC ? 'إجمالي اليوم' : 'Day total'} value={amt(data.dayTotal)} accent />
        {/* Row count next to the money: "8 bills / 96.500" answers "is this the whole day?"
            which the total alone cannot. Voided rows are counted here but not in the total,
            so the two figures disagreeing is itself information. */}
        <Stat label={ARABIC ? 'عدد الفواتير' : 'Bills'} value={String(data.rows.length)} />
      </div>
      <Table head={[ARABIC ? 'رقم الفاتورة' : 'Bill No', ARABIC ? 'الوقت' : 'Time',
        ARABIC ? 'الكاشير' : 'Cashier', ARABIC ? 'الدفع' : 'Pay', ARABIC ? 'الإجمالي' : 'Total', '']}>
        {!data.rows.length && (
          <Empty><NoSales span={span} date={receiptDate} onJump={onJump} /></Empty>
        )}
        {data.rows.map((o) => (
          <tr key={o.id} style={o.voided ? { opacity: .45, textDecoration: 'line-through' } : null}>
            <td style={td}>{o.invoice_no ?? String(o.id).slice(0, 6).toUpperCase()}</td>
            <td style={td}>{o.time}</td><td style={td}>{o.waiter}</td>
            <td style={td}>{o.pay}</td><td style={td}>{o.total}</td>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>
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
        ))}
      </Table>
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
