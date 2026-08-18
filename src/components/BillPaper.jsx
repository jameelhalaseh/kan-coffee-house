// The invoice, rendered as paper.
//
// ONE component, two callers: the post-payment popup in SalesView and the receipt dialog in
// Financials. That is the point of it — the cashier confirming a sale and the manager
// reviewing it a week later must be looking at the same document, and both must match what
// the printer puts on the roll (src/receipt.js). Three separate hand-built summaries is how
// they drift apart.
//
// The palette is FIXED, not themed: this is a document, and it is the same document whether
// the app is in day or night mode.
import React from 'react';
import { ARABIC, CURRENCY, SELLER, STORE_NAME, BILL, TAX_RATE, payLabel } from '../client.config';

export const PAPER = { bg: '#fff', ink: '#111', faint: '#555', rule: '#c9c9c9' };
const dashed = `1px dashed ${PAPER.rule}`;
const row = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 };
const amt = (v) => `${v ?? '0.000'} ${CURRENCY}`;

// 3dp everywhere, because JOD is a 3-decimal currency and the printed roll is 3dp. A popup
// that rounded to 2 would disagree with the paper in the customer's hand.
const d3 = (n) => (Number(n) || 0).toFixed(3);

/**
 * Normalise a till-shaped sale (plain numbers, as SalesView holds it at checkout) into the
 * same shape the reporting API returns, so BillPaper has exactly one input format.
 */
export function billFromSale(sale) {
  const items = (sale.items || []).map((li) => ({
    name: li.name,
    size: li.size || '',
    qty: String(Number(li.qty) || 0),
    price: d3(li.price),
    disc: d3(li.disc),
    // The percentage is what was agreed out loud; the money is what it came to. Print both.
    discPct: Number(li.disc_pct) > 0 ? String(Number(li.disc_pct)) : '',
    // The line's own discount comes off the line, so `amount` is what that line actually
    // contributes to the total. The gross is kept alongside it so the bill can show both.
    gross: d3((Number(li.price) || 0) * (Number(li.qty) || 0)),
    amount: d3((Number(li.price) || 0) * (Number(li.qty) || 0) - (Number(li.disc) || 0)),
  }));
  return {
    billNo: sale.invoice_no ?? String(sale.id || '').slice(0, 6).toUpperCase(),
    invoice_no: sale.invoice_no,
    date: sale.date,
    time: sale.time,
    pay: sale.pay || '',
    buyer: sale.buyer || '',
    cashier: sale.waiter || '',
    items,
    sub: d3(sale.sub),
    tax: d3(sale.tax),
    disc: d3(sale.disc),
    total: d3(sale.total),
    lineSum: d3(items.reduce((s, li) => s + Number(li.amount), 0)),
    voided: false,
    refund: sale.status === 'refund',
  };
}

function BillPaper({ bill: r, compact = false }) {
  const vatPct = Math.round((TAX_RATE || 0) * 100);

  return (
    <div dir={ARABIC ? 'rtl' : 'ltr'} style={{
      background: PAPER.bg, color: PAPER.ink,
      display: 'flex', flexDirection: 'column', gap: compact ? 8 : 10,
    }}>
      {/* ── Seller header ── */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: compact ? 17 : 20 }}>{SELLER.name || STORE_NAME}</div>
        {SELLER.location && <div style={{ fontSize: 12, color: PAPER.faint }}>{SELLER.location}</div>}
        {SELLER.taxNo && (
          <div style={{ fontSize: 12, color: PAPER.faint }}>
            {ARABIC ? 'الرقم الضريبي' : 'Tax No'}: {SELLER.taxNo}
          </div>
        )}
      </div>

      {r.voided && (
        <div style={{ border: '1px solid #c0392b', color: '#c0392b', borderRadius: 8, padding: '6px 10px', fontSize: 12, textAlign: 'center', fontWeight: 800 }}>
          {ARABIC ? 'ملغاة' : 'VOIDED'}
          {r.voided_by ? ` — ${r.voided_by}` : ''}
          {r.void_reason ? `: ${r.void_reason}` : ''}
        </div>
      )}
      {r.refund && (
        <div style={{ border: '1px solid #2b6cb0', color: '#2b6cb0', borderRadius: 8, padding: '6px 10px', fontSize: 12, textAlign: 'center', fontWeight: 800 }}>
          {ARABIC ? 'إرجاع' : 'REFUND'}
        </div>
      )}

      {/* ── Bill meta ── */}
      <div style={{ borderTop: dashed, borderBottom: dashed, padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={row}>
          <span style={{ color: PAPER.faint }}>{ARABIC ? 'رقم الفاتورة' : 'Invoice No'}</span>
          <span style={{ fontWeight: 700 }}>{BILL.invoicePrefix || ''}{r.billNo}</span>
        </div>
        <div style={row}>
          <span style={{ color: PAPER.faint }}>{ARABIC ? 'التاريخ' : 'Date'}</span>
          <span>{r.date} {r.time}</span>
        </div>
        <div style={row}>
          <span style={{ color: PAPER.faint }}>{ARABIC ? 'طريقة الدفع' : 'Payment'}</span>
          <span>{r.pay ? payLabel(r.pay) : '—'}</span>
        </div>
        {r.cashier && (
          <div style={row}>
            <span style={{ color: PAPER.faint }}>{ARABIC ? 'الكاشير' : 'Cashier'}</span>
            <span>{r.cashier}</span>
          </div>
        )}
        {r.buyer && (
          <div style={row}>
            <span style={{ color: PAPER.faint }}>{ARABIC ? 'العميل' : 'Customer'}</span>
            <span>{r.buyer}</span>
          </div>
        )}
      </div>

      {/* ── Items: Item | Qty | Unit | Total ── */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${PAPER.rule}` }}>
            <th style={{ textAlign: 'start', padding: '4px 0', fontWeight: 700 }}>{ARABIC ? 'الصنف' : 'Item'}</th>
            <th style={{ textAlign: 'center', padding: '4px 0', fontWeight: 700 }}>{ARABIC ? 'الكمية' : 'Qty'}</th>
            <th style={{ textAlign: 'end', padding: '4px 0', fontWeight: 700 }}>{ARABIC ? 'سعر الوحدة' : 'Unit'}</th>
            <th style={{ textAlign: 'end', padding: '4px 0', fontWeight: 700 }}>{ARABIC ? 'الإجمالي' : 'Total'}</th>
          </tr>
        </thead>
        <tbody>
          {(r.items || []).map((li, i) => (
            <tr key={i} style={{ borderBottom: dashed }}>
              <td style={{ padding: '5px 0' }}>
                {li.name}{li.size ? <span style={{ color: PAPER.faint }}> · {li.size}</span> : ''}
                {/* An itemised discount is printed under the line it belongs to, naming the
                    item it came off. A lump sum at the foot of the bill would not say which. */}
                {li.disc && li.disc !== '0.000' && (
                  <div style={{ fontSize: 11, color: PAPER.faint }}>
                    {ARABIC ? 'خصم' : 'Discount'}{li.discPct ? ` ${li.discPct}%` : ''} −{li.disc} {ARABIC ? `(من ${li.gross})` : `(off ${li.gross})`}
                  </div>
                )}
              </td>
              <td style={{ padding: '5px 0', textAlign: 'center', verticalAlign: 'top' }}>{li.qty}</td>
              <td style={{ padding: '5px 0', textAlign: 'end', verticalAlign: 'top' }}>{li.price}</td>
              <td style={{ padding: '5px 0', textAlign: 'end', fontWeight: 700, verticalAlign: 'top' }}>{li.amount}</td>
            </tr>
          ))}
          {!(r.items || []).length && (
            <tr><td colSpan={4} style={{ padding: '10px 0', color: PAPER.faint, textAlign: 'center' }}>
              {ARABIC ? 'لا أصناف مسجّلة' : 'No line items recorded'}
            </td></tr>
          )}
        </tbody>
      </table>

      {/* ── Totals. Prices are tax-INCLUSIVE, so the VAT line is what was extracted out of
             them, not something added on top — the wording says so. ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={row}>
          <span style={{ color: PAPER.faint }}>{ARABIC ? 'المجموع قبل الضريبة' : 'Subtotal before tax'}</span>
          <span>{amt(r.sub)}</span>
        </div>
        <div style={row}>
          <span style={{ color: PAPER.faint }}>
            {ARABIC ? `ضريبة المبيعات (${vatPct}%)` : `VAT ${vatPct}% (included)`}
          </span>
          <span>{amt(r.tax)}</span>
        </div>
        {r.disc && r.disc !== '0.000' && (
          <div style={row}>
            <span style={{ color: PAPER.faint }}>{ARABIC ? 'الخصم' : 'Discount'}</span>
            <span>{amt(r.disc)}</span>
          </div>
        )}
        <div style={{
          display: 'flex', justifyContent: 'space-between', gap: 12,
          borderTop: `2px solid ${PAPER.ink}`, marginTop: 4, paddingTop: 6,
          fontWeight: 800, fontSize: compact ? 17 : 19,
        }}>
          <span>{ARABIC ? 'المجموع الكلي' : 'Grand Total'}</span>
          <span>{amt(r.total)}</span>
        </div>
        {/* Only when it disagrees: a bill whose lines no longer add up to its stored total is
            worth seeing on the bill itself, not just in a spreadsheet. */}
        {r.lineSum !== r.total && (
          <div style={{ ...row, color: '#c0392b', fontSize: 11 }}>
            <span>{ARABIC ? 'مجموع الأصناف' : 'Line items add up to'}</span><span>{amt(r.lineSum)}</span>
          </div>
        )}
      </div>

      {/* Empty by default — see client.config.js (bill.legalNote): a legal declaration about
          this business is the owner's to assert. */}
      {(ARABIC ? BILL.legalNoteAr : BILL.legalNote) && (
        <div style={{ fontSize: 10, color: PAPER.faint, textAlign: 'center', lineHeight: 1.5 }}>
          {ARABIC ? BILL.legalNoteAr : BILL.legalNote}
        </div>
      )}
    </div>
  );
}

export default BillPaper;
