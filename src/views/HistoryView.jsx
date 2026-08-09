import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC, DEFAULT_FLOOR } from '../client.config';
import {
  money, uid, nowParts, todayInStore, storeTimeOf, storeDateOf, remainingQty, returnedMapFor,
} from '../lib';
import printReceipt from '../receipt';
import { Overlay, th, td, qtyBtn } from '../components/ui';

function formatDayLabel(iso) {
  const d = new Date(iso + 'T12:00:00Z');          // midday, so no timezone can shift the day
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(ARABIC ? 'ar-JO' : 'en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(d);
}

function HistoryView({ user, notify }) {
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [returning, setReturning] = useState(null); // sale being returned
  const [fotaraOn, setFotaraOn] = useState(false);  // JoFotara wired up on this deployment?
  // History is one trading day at a time, opening on today: the receipt a cashier needs is
  // almost always from the last few minutes, and a shop open for a year should not have to
  // scroll a year to reach it. Older days are one tap back.
  const [day, setDay] = useState(todayInStore);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/orders?floor=' + DEFAULT_FLOOR + '&date=' + day + '&limit=500')
      .then(setSales).catch(() => notify(ARABIC ? 'تعذّر تحميل السجل' : 'Failed to load history', 'red'))
      .finally(() => setLoading(false));
  }, [notify, day]);
  useEffect(() => { load(); }, [load]);

  // Step the selected day. Built from the YYYY-MM-DD string in UTC so it can't drift a day
  // either side of midnight the way a local-timezone Date would.
  const shiftDay = (delta) => {
    const d = new Date(day + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    setDay(d.toISOString().slice(0, 10));
  };
  const today = todayInStore();
  const isToday = day === today;
  // Credentials live server-side; we only ask whether they exist so the button can be
  // hidden entirely on deployments that aren't registered with the ISTD.
  useEffect(() => { api.get('/jofotara/status').then((r) => setFotaraOn(!!(r && r.configured))).catch(() => {}); }, []);

  // Submit one sale to JoFotara (فوترة). The server holds Client-Id/Secret-Key, builds the
  // UBL 2.1 document and records the returned UUID + QR on the order.
  const sendFotara = async (sale) => {
    setBusyId(sale.id);
    try {
      const r = await api.post('/jofotara/send/' + sale.id, { floor: DEFAULT_FLOOR });
      setSales((prev) => prev.map((x) => (x.id === sale.id
        ? { ...x, jofotara_status: 'sent', jofotara_uuid: r.uuid, jofotara_qr: r.qr, jofotara_error: null } : x)));
      notify(r.already
        ? (ARABIC ? 'مُرسلة مسبقاً إلى فوترة' : 'Already filed with JoFotara')
        : (ARABIC ? 'تم الإرسال إلى فوترة' : 'Sent to JoFotara'), 'green');
    } catch (ex) {
      const detail = (ex.body && ex.body.detail) || '';
      setSales((prev) => prev.map((x) => (x.id === sale.id ? { ...x, jofotara_status: 'failed', jofotara_error: detail } : x)));
      notify(ex.message === 'not_configured'
        ? (ARABIC ? 'فوترة غير مهيأة على هذا الخادم' : 'JoFotara is not configured on this server')
        : (ARABIC ? 'رفضت فوترة الفاتورة: ' : 'JoFotara rejected it: ') + (detail || ex.message), 'red');
    } finally { setBusyId(null); }
  };

  // Process a (full or partial) return: record a reversing order for the chosen lines + restore stock.
  const doReturn = async (sale, lines) => {
    const items = lines.filter((l) => l.qty > 0);
    if (!items.length) { setReturning(null); return; }
    const refundTotal = items.reduce((s, l) => s + l.price * l.qty, 0);
    setBusyId(sale.id);
    try {
      const invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
      const { date, time } = nowParts();
      const r = { id: uid(), floor: DEFAULT_FLOOR, items, sub: -refundTotal, tax: 0, svc: 0, disc: 0, total: -refundTotal, pay: 'refund', waiter: user.username, status: 'refund', date, time, invoice_no, buyer: 'return of #' + sale.invoice_no };
      // Server restores stock + validates the refund cap in the same transaction.
      await api.post('/orders', r);
      notify(ARABIC ? 'تم الاسترجاع' : 'Returned', 'green');
      setReturning(null); load();
    } catch (ex) {
      notify(ex.message === 'over_refund'
        ? (ARABIC ? 'تجاوز مبلغ الاسترجاع قيمة الفاتورة' : 'Refund exceeds what remains of this sale')
        : (ARABIC ? 'فشل الاسترجاع' : 'Return failed'), 'red');
    } finally { setBusyId(null); }
  };

  // Already-returned quantities per line (lib.returnedMapFor) → drives the remaining clamp.
  const returnedFor = (sale) => returnedMapFor(sale, sales);
  const fullyReturned = (sale) => {
    const map = returnedFor(sale);
    return (sale.items || []).every((l) => remainingQty(l, map) === 0);
  };

  // The list can also contain a refund from ANOTHER day that reverses one of this day's
  // sales (the server returns those so the Return button clamps correctly). Those must not
  // move this day's takings — a refund belongs to the day it was issued, same rule the
  // Z-report follows — so the total counts only rows actually dated to the selected day.
  const ownRows = sales.filter((s) => storeDateOf(s.created_at, s.date) === day);
  const dayTotal = ownRows.reduce((sum, s) => sum + (Number(s.total) || 0), 0);

  const dayPicker = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
      <button onClick={() => shiftDay(-1)} style={{ ...S.btnGhost, padding: '9px 14px' }}
        title={ARABIC ? 'اليوم السابق' : 'Previous day'}>‹</button>
      {/* The native picker renders the browser's locale — on this machine 08/09/2026, which
          in Jordan reads as 8 September. So the readable label is ours ("Sat 8 Aug 2026")
          and the native control sits on top of it, invisible but still doing the picking:
          full keyboard and calendar behaviour, no ambiguity about which number is the day. */}
      <label style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <span style={{ ...S.input, width: 'auto', minWidth: 190, minHeight: 44, display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 700, cursor: 'pointer' }}>
          🗓 {formatDayLabel(day)}
        </span>
        <input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)}
          style={{ position: 'absolute', inset: 0, opacity: 0, width: '100%', height: '100%', cursor: 'pointer' }} />
      </label>
      {/* Never offer a day that hasn't happened — there is nothing to show there. */}
      <button onClick={() => shiftDay(1)} disabled={isToday}
        style={{ ...S.btnGhost, padding: '9px 14px', opacity: isToday ? 0.4 : 1, cursor: isToday ? 'default' : 'pointer' }}
        title={ARABIC ? 'اليوم التالي' : 'Next day'}>›</button>
      {!isToday && (
        <button onClick={() => setDay(today)} style={{ ...S.btnGhost, padding: '9px 14px', color: C.accent, borderColor: C.accent }}>
          {ARABIC ? 'اليوم' : 'Today'}
        </button>
      )}
      <div style={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ color: C.dim, fontSize: 13 }}>
          {ownRows.length} {ARABIC ? 'فاتورة' : ownRows.length === 1 ? 'sale' : 'sales'}
        </span>
        <span style={{ fontWeight: 800, fontSize: 17 }}>{money(dayTotal)}</span>
      </div>
    </div>
  );

  if (loading) return (
    <div>
      {dayPicker}
      <div style={{ color: C.dim }}>{ARABIC ? 'جارٍ التحميل…' : 'Loading…'}</div>
    </div>
  );
  return (
    <div>
    {dayPicker}
    <div style={S.card}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead><tr style={{ color: C.dim, textAlign: ARABIC ? 'right' : 'left' }}>
          <th style={th}>#</th><th style={th}>{ARABIC ? 'الوقت' : 'Time'}</th><th style={th}>{ARABIC ? 'الأصناف' : 'Items'}</th>
          <th style={th}>{ARABIC ? 'الدفع' : 'Pay'}</th><th style={{ ...th, textAlign: 'right' }}>{ARABIC ? 'المجموع' : 'Total'}</th><th style={th}></th>
        </tr></thead>
        <tbody>
          {sales.map((s) => {
            const isRefund = Number(s.total) < 0 || s.pay === 'refund';
            return (
              <tr key={s.id} style={{ borderTop: `1px solid ${C.line}`, opacity: isRefund ? 0.7 : 1 }}>
                <td style={td}>{s.invoice_no}</td>
                {/* The day is already in the picker above — repeating it on every row is
                    noise. A refund pulled in from another day DOES show its own date,
                    because there the date is the surprising part. */}
                <td style={{ ...td, color: C.dim, whiteSpace: 'nowrap' }}>
                  {storeDateOf(s.created_at, s.date) !== day && (
                    <span style={{ marginInlineEnd: 6 }}>{storeDateOf(s.created_at, s.date)}</span>
                  )}
                  {storeTimeOf(s.created_at, s.time)}
                </td>
                <td style={{ ...td, color: C.dim }}>{(s.items || []).reduce((n, l) => n + (l.qty || 0), 0)}</td>
                <td style={td}>{isRefund ? (ARABIC ? '↩ استرجاع' : '↩ refund') : s.pay}</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: isRefund ? C.red : C.text }}>{money(s.total)}</td>
                <td style={{ ...td, textAlign: 'end', whiteSpace: 'nowrap' }}>
                  <button onClick={() => printReceipt(s)} style={S.btnRow}>{ARABIC ? 'طباعة' : 'Print'}</button>
                  {!isRefund && !fullyReturned(s) && <button onClick={() => setReturning(s)} disabled={busyId === s.id} style={{ ...S.btnRow, color: C.red, marginInlineStart: 8 }}>{busyId === s.id ? '…' : (ARABIC ? 'استرجاع' : 'Return')}</button>}
                  {!isRefund && fullyReturned(s) && <span style={{ color: C.dim, fontSize: 12, marginInlineStart: 6 }}>{ARABIC ? 'مسترجعة' : 'returned'}</span>}
                  {/* فوترة — file this sale with the ISTD. Hidden entirely when the
                      deployment has no credentials, so it can't be tapped in vain. */}
                  {fotaraOn && (s.jofotara_status === 'sent'
                    ? <span title={s.jofotara_uuid || ''} style={{ fontSize: 12, fontWeight: 800, color: C.green, marginInlineStart: 6 }}>✓ فوترة</span>
                    : <button onClick={() => sendFotara(s)} disabled={busyId === s.id}
                        title={s.jofotara_error || ''}
                        style={{
                          ...S.btnRow, marginInlineStart: 8, fontWeight: 700,
                          color: s.jofotara_status === 'failed' ? C.red : C.blue,
                          borderColor: s.jofotara_status === 'failed' ? C.red : C.blue,
                        }}>
                        {busyId === s.id ? '…' : (s.jofotara_status === 'failed' ? '↻ فوترة' : 'فوترة')}
                      </button>)}
                </td>
              </tr>
            );
          })}
          {/* An empty day is normal (a closed Friday, or first thing in the morning) — say
              which day is empty rather than implying the shop has never sold anything. */}
          {!sales.length && (
            <tr><td colSpan={6} style={{ ...td, color: C.dim, textAlign: 'center', padding: 24 }}>
              {isToday
                ? (ARABIC ? 'لا مبيعات اليوم بعد' : 'No sales yet today')
                : (ARABIC ? `لا مبيعات في ${day}` : `No sales on ${day}`)}
            </td></tr>
          )}
        </tbody>
      </table>
      {returning && <ReturnModal sale={returning} returned={returnedFor(returning)} busy={busyId === returning.id} onClose={() => setReturning(null)} onConfirm={(lines) => doReturn(returning, lines)} />}
    </div>
    </div>
  );
}

// Pick how many of each line to return — capped at what's LEFT (sold − already returned).
function ReturnModal({ sale, returned = {}, onClose, onConfirm, busy }) {
  const remainingOf = (l) => remainingQty(l, returned);
  const [qty, setQty] = useState(() => (sale.items || []).map(remainingOf));
  const lines = (sale.items || []).map((l, i) => ({ ...l, qty: qty[i] }));
  const refundTotal = lines.reduce((s, l) => s + (Number(l.price) || 0) * l.qty, 0);
  const setI = (i, v) => setQty((q) => q.map((x, j) => (j === i ? Math.max(0, Math.min(remainingOf(sale.items[i]), v)) : x)));
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 380, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>↩ {ARABIC ? 'استرجاع فاتورة' : 'Return sale'} #{sale.invoice_no}</div>
        {(sale.items || []).map((l, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>{l.name} <span style={{ color: C.dim, fontSize: 12 }}>
              ({ARABIC ? 'بيع' : 'sold'} {Number(l.qty)}{remainingOf(l) < Number(l.qty) ? ` · ${ARABIC ? 'متبقٍ' : 'left'} ${remainingOf(l)}` : ''})
            </span></span>
            <button onClick={() => setI(i, qty[i] - 1)} style={qtyBtn}>−</button>
            <span style={{ minWidth: 26, textAlign: 'center', fontWeight: 700 }}>{qty[i]}</span>
            <button onClick={() => setI(i, qty[i] + 1)} style={qtyBtn}>+</button>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, fontSize: 18, marginTop: 4 }}>
          <span>{ARABIC ? 'مبلغ الاسترجاع' : 'Refund'}</span><span style={{ color: C.red }}>{money(refundTotal)}</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onConfirm(lines)} disabled={busy || refundTotal <= 0} style={{ ...S.btn, flex: 1, padding: '14px', opacity: busy || refundTotal <= 0 ? 0.5 : 1 }}>{ARABIC ? 'تأكيد الاسترجاع' : 'Confirm return'}</button>
          <button onClick={onClose} style={{ ...S.btnGhost, padding: '14px' }}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </div>
    </Overlay>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Reports
// ══════════════════════════════════════════════════════════════════════════════
// Reports — 4 tabs: Today (close-out), Sales (trends), Stock (restock), Staff (payroll).

export default HistoryView;
export { HistoryView };
