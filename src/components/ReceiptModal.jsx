// The bill dialog — an INTERNAL receipt view plus the till actions.
//
// The bill is rendered on screen as paper (white card, dashed rules, seller header, item
// table, tax breakdown), not as a dark app panel: the point of opening a receipt is to read
// the document the customer holds, and a preview that looks nothing like the printout is a
// worse answer than the printout. Printing is then a separate decision, not the only way to
// see it.
//
// ACTIONS, and why each is shaped the way it is:
//
//   Print + Drawer — one button, because at a till those two things happen together. Uses the
//                    thermal path (Web Serial, or the local bridge) when a printer is
//                    reachable, which also kicks the cash drawer; falls back to the browser
//                    print dialog when it is not. Same body/css as the original print, so a
//                    reprint cannot drift from what the customer was given.
//   Go Green       — drawer only, no paper. Only shown when a real printer is reachable,
//                    because there is no drawer to kick without one.
//   Edit           — payment method and customer ONLY (the server refuses amounts/items).
//   Void           — this app's cancel: keeps the invoice number, returns the goods to stock.
//   Close          — dismisses.
import React, { useEffect, useState } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC, DEFAULT_FLOOR, PAY_KEYS, payLabel } from '../client.config';
import { printReceipt, buildReceipt } from '../receipt';
import {
  serialSupported, isConnected, connectPrinter, printReceiptHTML, openDrawer,
} from '../lib/thermalPrinter';
// One bill renderer, shared with the post-payment popup in SalesView — see BillPaper.jsx.
import BillPaper, { PAPER } from './BillPaper';

const FLOOR = DEFAULT_FLOOR;

const dashed = `1px dashed ${PAPER.rule}`;

function ReceiptModal({ receipt: r, isAdmin, onClose, onChanged, onGone, notify }) {
  const [editing, setEditing] = useState(false);
  const [pay, setPay] = useState(r.pay || 'cash');
  const [buyer, setBuyer] = useState(r.buyer || '');
  const [busy, setBusy] = useState(false);

  // Is a real printer reachable? Web Serial in this browser, or the local bridge configured
  // for this store. Checked once on open — plugging a printer in mid-dialog is not a case
  // worth a polling loop.
  const [canSerial, setCanSerial] = useState(false);
  useEffect(() => {
    try { setCanSerial(serialSupported()); } catch (_) { setCanSerial(false); }
  }, []);

  const sale = {
    invoice_no: r.invoice_no, date: r.date, time: r.time,
    items: (r.items || []).map((li) => ({ name: li.name, qty: Number(li.qty), price: Number(li.price) })),
    sub: r.sub, tax: r.tax, total: r.total, pay: r.pay, waiter: r.cashier,
  };

  // Print + kick the drawer. The thermal path is tried first and the browser dialog is the
  // fallback — NOT the other way round: on a till the browser dialog needs a human to click
  // through it, and it cannot open the drawer at all.
  const printAndDrawer = async () => {
    setBusy(true);
    try {
      if (canSerial) {
        if (!isConnected()) await connectPrinter();
        const { body, css } = buildReceipt(sale);
        await printReceiptHTML(body, css, { kick: true });
        onClose();
        return;
      }
      printReceipt(sale);          // browser dialog; no drawer without a real printer
      onClose();
    } catch (e) {
      // A failed thermal print falls back rather than leaving the cashier with nothing.
      notify(ARABIC ? 'تعذّرت الطباعة الحرارية — فتح نافذة الطباعة' : 'Thermal print failed — opening the browser dialog', 'red');
      printReceipt(sale);
      onClose();
    } finally { setBusy(false); }
  };

  // Drawer only: a cash-out with no paper.
  const goGreen = async () => {
    setBusy(true);
    try {
      if (!isConnected()) await connectPrinter();
      await openDrawer();
      onClose();
    } catch (_) {
      notify(ARABIC ? 'تعذّر فتح الدرج' : 'Could not open the drawer', 'red');
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      onChanged(await api.patch(`/reports/${FLOOR}/receipts/${r.id}`, { pay, buyer }));
      setEditing(false);
      notify(ARABIC ? 'تم الحفظ' : 'Saved', 'green');
    } catch (e) {
      const code = e.body && e.body.error;
      notify(
        code === 'voided'
          ? (ARABIC ? 'الفاتورة ملغاة — لا يمكن تعديلها' : 'This bill is voided and cannot be edited')
          : code === 'refund_buyer_locked'
            ? (ARABIC ? 'لا يمكن تغيير العميل على فاتورة إرجاع' : 'The customer on a refund cannot be changed')
            : e.status === 403
              ? (ARABIC ? 'لا تملك صلاحية التعديل' : 'You do not have the edit permission')
              : (ARABIC ? 'تعذّر الحفظ' : 'Save failed'), 'red');
    } finally { setBusy(false); }
  };

  // Voiding is destructive in the way that matters — the money leaves every report and stock
  // moves — so it asks for a reason instead of firing on one click. The reason is stored on
  // the row and shown on every later view of this bill.
  const doVoid = async () => {
    const reason = window.prompt(ARABIC ? 'سبب الإلغاء' : 'Reason for voiding this bill');
    if (reason === null) return;
    setBusy(true);
    try {
      // The reason goes in the BODY — that is where the void endpoint reads it from.
      await api.del(`/orders/${r.id}?floor=${FLOOR}`, { reason: reason || '' });
      notify(ARABIC ? 'أُلغيت الفاتورة وأُعيد المخزون' : 'Bill voided — stock returned', 'green');
      onGone();
    } catch (e) {
      notify(e.status === 403
        ? (ARABIC ? 'الإلغاء للمدير فقط' : 'Only an admin can void a bill')
        : (ARABIC ? 'تعذّر الإلغاء' : 'Void failed'), 'red');
      setBusy(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,.65)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 16,
    }}>
      <div onClick={(e) => e.stopPropagation()} dir={ARABIC ? 'rtl' : 'ltr'} style={{
        background: PAPER.bg, color: PAPER.ink, borderRadius: 14, padding: 18,
        width: 'min(400px, 100%)', maxHeight: '92vh', overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: C.shadowLg,
      }}>
        <BillPaper bill={r} />

        {/* ── Edit form or actions ── */}
        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: dashed, paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {PAY_KEYS.map((m) => (
                <button key={m} onClick={() => setPay(m)} style={{
                  ...S.btn, flex: 1, padding: '10px 8px',
                  background: pay === m ? C.accent : '#eee',
                  color: pay === m ? C.accentText : PAPER.ink,
                  border: `1px solid ${pay === m ? C.accent : PAPER.rule}`,
                }}>{payLabel(m)}</button>
              ))}
            </div>
            <input value={buyer} onChange={(e) => setBuyer(e.target.value)}
              placeholder={ARABIC ? 'العميل' : 'Customer'}
              style={{ ...S.input, background: '#fff', color: PAPER.ink, border: `1px solid ${PAPER.rule}` }} />
            <div style={{ color: PAPER.faint, fontSize: 11, lineHeight: 1.5 }}>
              {ARABIC
                ? 'يمكن تعديل طريقة الدفع والعميل فقط. لتصحيح المبالغ أو الأصناف: ألغِ الفاتورة وأعد إصدارها.'
                : 'Only the payment method and customer can be changed. To correct amounts or items, void the bill and ring it again.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setEditing(false)} style={{ ...S.btnGhost, flex: 1, padding: '11px 0', color: PAPER.ink, borderColor: PAPER.rule }}>
                {ARABIC ? 'رجوع' : 'Cancel'}
              </button>
              <button onClick={save} disabled={busy} style={{ ...S.btn, flex: 1, padding: '11px 0', opacity: busy ? .6 : 1 }}>
                {ARABIC ? 'حفظ' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: dashed, paddingTop: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={printAndDrawer} disabled={busy} style={{
                ...S.btn, flex: 2, padding: '14px 0', fontSize: 15, fontWeight: 800, opacity: busy ? .6 : 1,
              }}>🖨 {ARABIC ? 'طباعة + درج' : 'Print + Drawer'}</button>
              <button onClick={onClose} style={{
                ...S.btnGhost, flex: 1, padding: '14px 0', fontSize: 15, color: PAPER.ink, borderColor: PAPER.rule,
              }}>{ARABIC ? 'إغلاق' : 'Close'}</button>
            </div>

            {/* Drawer-only. Hidden when no printer is reachable — there is nothing to kick. */}
            {canSerial && (
              <button onClick={goGreen} disabled={busy} style={{
                ...S.btn, padding: '13px 0', fontSize: 15, fontWeight: 800,
                background: '#1e9e5a', color: '#fff', border: '1px solid #1e9e5a', opacity: busy ? .6 : 1,
              }}>💵 {ARABIC ? 'فتح الدرج فقط' : 'Go Green'}</button>
            )}

            {isAdmin && !r.voided && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setEditing(true)} style={{
                  ...S.btnGhost, flex: 1, padding: '11px 0', fontSize: 14, color: PAPER.ink, borderColor: PAPER.rule,
                }}>✏️ {ARABIC ? 'تعديل' : 'Edit'}</button>
                <button onClick={doVoid} disabled={busy} style={{
                  ...S.btnGhost, flex: 1, padding: '11px 0', fontSize: 14, color: '#c0392b', borderColor: '#c0392b',
                }}>✕ {ARABIC ? 'إلغاء الفاتورة' : 'Void'}</button>
              </div>
            )}
            {isAdmin && !r.voided && (
              <div style={{ color: PAPER.faint, fontSize: 11, lineHeight: 1.5, textAlign: 'center' }}>
                {ARABIC
                  ? 'الإلغاء يُبقي رقم الفاتورة ويُعيد الأصناف إلى المخزون.'
                  : 'Voiding keeps the invoice number and returns the items to stock.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ReceiptModal;
