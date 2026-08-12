import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC, CURRENCY, DEFAULT_FLOOR } from '../client.config';
import { money, catColor, todayInStore } from '../lib';
import { Stat, Field } from '../components/ui';
import { Donut, Spline, Scatter, Bars } from '../components/charts';

function ReportsView({ notify }) {
  // The SHOP's today, not UTC's. Between midnight and 03:00 in Amman those are different
  // days, and every default here ("Today" tab, the Z-report date, the dead-stock cutoff)
  // has to mean the shift the cashier just worked — which is the busiest one.
  const today = todayInStore();
  const [tab, setTab] = useState('today');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sum, setSum] = useState(null);
  const [top, setTop] = useState([]);
  const [low, setLow] = useState([]);
  const [abc, setAbc] = useState([]);
  const [zrep, setZrep] = useState(null);
  const [hours, setHours] = useState([]);
  const [orders, setOrders] = useState([]);     // raw orders → hourly chart, staff sales, dead stock, CSV
  const [products, setProducts] = useState([]);

  const load = useCallback(() => {
    const qs = `?from=${from}&to=${to}`;
    api.get('/reports/summary' + qs).then(setSum).catch(() => notify(ARABIC ? 'تعذّر تحميل التقارير' : 'Failed to load reports', 'red'));
    api.get('/reports/top-products' + qs + '&limit=10').then(setTop).catch(() => {});
    api.get('/reports/low-stock?threshold=5').then(setLow).catch(() => {});
    api.get('/reports/abc' + qs).then(setAbc).catch(() => {});
    api.get('/reports/zreport?date=' + today).then(setZrep).catch(() => {});
    api.get('/timeclock' + qs).then(setHours).catch(() => {});
    api.get('/orders?floor=' + DEFAULT_FLOOR + '&limit=100000').then(setOrders).catch(() => {});
    api.get('/products').then(setProducts).catch(() => {});
  }, [from, to, today, notify]);
  useEffect(() => { load(); }, [load]);

  const dayOf = (o) => o.date || (o.created_at || '').slice(0, 10);
  const inRange = (o) => { const d = dayOf(o); return d >= from && d <= to; };

  // ── Derived: hourly sales (today), daily revenue (range), staff sales, dead stock ──
  const hourly = Array.from({ length: 24 }, (_, h) => ({ label: h, value: 0 }));
  orders.filter((o) => dayOf(o) === today && o.status !== 'refund').forEach((o) => {
    const h = parseInt(String(o.time || '').slice(0, 2), 10);
    if (h >= 0 && h < 24) hourly[h].value += Number(o.total) || 0;
  });
  const activeHours = hourly.slice(7, 24);   // 07:00–23:00 — grocery hours

  const dailyMap = {};
  orders.filter(inRange).forEach((o) => { const d = dayOf(o); dailyMap[d] = (dailyMap[d] || 0) + (Number(o.total) || 0); });
  const daily = Object.keys(dailyMap).sort().map((d) => ({ label: d.slice(5), value: dailyMap[d] })).slice(-31);

  const staffMap = {};
  orders.filter(inRange).forEach((o) => {
    const w = o.waiter || '?';
    const s = (staffMap[w] = staffMap[w] || { username: w, orders: 0, revenue: 0 });
    s.orders += 1; s.revenue += Number(o.total) || 0;
  });
  const staffSales = Object.values(staffMap).sort((a, b) => b.revenue - a.revenue);

  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const soldIds = new Set();
  orders.filter((o) => dayOf(o) >= cutoff && o.status !== 'refund').forEach((o) => (o.items || []).forEach((l) => soldIds.add(l.id)));
  const deadStock = products.filter((p) => p.active !== false && Number(p.stock) > 0 && !soldIds.has(p.id));

  const hoursByUser = Object.values(hours.reduce((m, h) => { (m[h.username] = m[h.username] || { username: h.username, hours: 0 }).hours += Number(h.hours) || 0; return m; }, {}));
  const topMax = Math.max(...top.map((t) => Number(t.revenue) || 0), 1);
  const abcBadge = (cls) => ({ A: C.green, B: C.accent, C: C.dim }[cls]);

  // Donut: payment split for today (Z-report lines).
  const payColor = { cash: C.green, card: C.blue, refund: C.red };
  const paySlices = ((zrep && zrep.lines) || []).map((l) => ({
    label: l.pay === 'cash' ? (ARABIC ? 'نقدي' : 'Cash') : l.pay === 'card' ? (ARABIC ? 'بطاقة' : 'Card') : l.pay,
    value: Math.abs(Number(l.total) || 0),
    color: payColor[l.pay] || C.dim,
  }));

  // Donut: revenue by category over the range (product id → cat via the catalogue).
  const catOf = {};
  products.forEach((p) => { catOf[p.id] = p.cat || (ARABIC ? 'أخرى' : 'other'); });
  const catRev = {};
  orders.filter((o) => inRange(o) && o.status !== 'refund').forEach((o) => (o.items || []).forEach((l) => {
    const cat = catOf[l.id] || (ARABIC ? 'أخرى' : 'other');
    catRev[cat] = (catRev[cat] || 0) + (Number(l.qty) || 0) * (Number(l.price) || 0);
  }));
  const catSlices = Object.entries(catRev).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([cat, v]) => ({ label: cat, value: v, color: catColor(cat) }));

  // Scatter: units × revenue per product (range), colored by ABC class.
  const abcOf = {};
  abc.forEach((x) => { abcOf[x.name] = x.class; });
  const prodAgg = {};
  orders.filter((o) => inRange(o) && o.status !== 'refund').forEach((o) => (o.items || []).forEach((l) => {
    const e = (prodAgg[l.name] = prodAgg[l.name] || { units: 0, revenue: 0 });
    e.units += Number(l.qty) || 0;
    e.revenue += (Number(l.qty) || 0) * (Number(l.price) || 0);
  }));
  const scatterPoints = Object.entries(prodAgg).map(([name, e]) => ({
    label: name, x: Number(e.units.toFixed(2)), y: e.revenue, color: abcBadge(abcOf[name]) || C.blue,
  }));

  // Excel-friendly CSV: UTF-8 BOM (Arabic opens correctly in Excel) + 3 sections in one file.
  const exportCSV = () => {
    try {
      const q = (c) => `"${String(c ?? '').replace(/"/g, '""')}"`;
      const line = (r) => r.map(q).join(',');
      const rows = orders.filter(inRange);
      const parts = [];
      parts.push(line([ARABIC ? 'المبيعات' : 'SALES', from + ' → ' + to]));
      parts.push(line(['invoice_no', 'date', 'time', 'payment', 'cashier', 'units', 'total']));
      rows.forEach((o) => parts.push(line([o.invoice_no, o.date, o.time, o.pay, o.waiter, (o.items || []).reduce((n, l) => n + (+l.qty || 0), 0), Number(o.total).toFixed(3)])));
      parts.push('');
      parts.push(line([ARABIC ? 'حسب المنتج' : 'PER PRODUCT']));
      parts.push(line(['product', 'units', 'revenue']));
      const pm = {};
      rows.filter((o) => o.status !== 'refund').forEach((o) => (o.items || []).forEach((l) => {
        const e = (pm[l.name] = pm[l.name] || { u: 0, r: 0 }); e.u += +l.qty || 0; e.r += (+l.qty || 0) * (+l.price || 0);
      }));
      Object.entries(pm).sort((a, b) => b[1].r - a[1].r).forEach(([n, e]) => parts.push(line([n, e.u, e.r.toFixed(3)])));
      parts.push('');
      parts.push(line([ARABIC ? 'حسب طريقة الدفع' : 'BY PAYMENT']));
      parts.push(line(['payment', 'orders', 'total']));
      const zm = {};
      rows.forEach((o) => { const k = o.pay || '?'; const e = (zm[k] = zm[k] || { n: 0, t: 0 }); e.n += 1; e.t += +o.total || 0; });
      Object.entries(zm).forEach(([k, e]) => parts.push(line([k, e.n, e.t.toFixed(3)])));
      const url = URL.createObjectURL(new Blob(['﻿' + parts.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url; a.download = `dukkan_${from}_${to}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (_) { notify(ARABIC ? 'فشل التصدير' : 'Export failed', 'red'); }
  };

  const TABS = [
    ['today', '🧮', ARABIC ? 'اليوم' : 'Today'],
    ['sales', '📈', ARABIC ? 'المبيعات' : 'Sales'],
    ['stock', '📦', ARABIC ? 'المخزون' : 'Stock'],
    ['staff', '👥', ARABIC ? 'الموظفون' : 'Staff'],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map(([k, icon, lbl]) => (
          <button key={k} onClick={() => setTab(k)} style={{
            ...S.btnGhost, padding: '13px 22px', fontSize: 16, display: 'flex', gap: 8, alignItems: 'center',
            ...(tab === k ? { background: C.accent, color: C.accentText, borderColor: C.accent, fontWeight: 800 } : {}),
          }}>{icon} {lbl}</button>
        ))}
        <div style={{ flex: 1 }} />
        <button onClick={exportCSV} style={{ ...S.btnGhost, padding: '13px 18px', fontSize: 15, borderColor: C.green, color: C.green }}>
          ⬇ {ARABIC ? 'تصدير Excel (CSV)' : 'Export Excel (CSV)'}
        </button>
      </div>

      {(tab === 'sales' || tab === 'staff') && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
          <Field label={ARABIC ? 'من' : 'From'}><input style={S.input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={ARABIC ? 'إلى' : 'To'}><input style={S.input} type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}

      {tab === 'today' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            <Stat label={ARABIC ? 'إيراد اليوم' : "Today's revenue"} value={money(zrep && zrep.net)} accent />
            <Stat label={ARABIC ? 'عدد الفواتير' : 'Sales'} value={zrep ? zrep.lines.reduce((n, l) => n + l.orders, 0) : '—'} />
            <Stat label={ARABIC ? 'نقدي' : 'Cash'} value={money(zrep && (zrep.lines.find((l) => l.pay === 'cash') || {}).total)} />
          </div>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 10 }}>🧮 {ARABIC ? 'تقرير الإغلاق (Z)' : 'Z-Report (close-out)'} — {today}</div>
            {zrep && zrep.lines.map((l) => (
              <div key={l.pay} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px dashed ${C.line}`, fontSize: 15 }}>
                <span style={{ textTransform: 'capitalize' }}>{l.pay === 'cash' ? (ARABIC ? '💵 نقدي' : '💵 Cash') : l.pay === 'card' ? (ARABIC ? '💳 بطاقة' : '💳 Card') : l.pay} <span style={{ color: C.dim, fontSize: 12 }}>×{l.orders}</span></span>
                <span style={{ fontWeight: 700 }}>{money(l.total)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, fontWeight: 800, fontSize: 18 }}>
              <span>{ARABIC ? 'الصافي' : 'Net'}</span><span style={{ color: C.accent }}>{money(zrep && zrep.net)}</span>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>🥧 {ARABIC ? 'توزيع الدفع' : 'Payment split'}</div>
              <Donut slices={paySlices} />
            </div>
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>🕑 {ARABIC ? 'المبيعات حسب الساعة' : 'Sales by hour'}</div>
              <Bars data={activeHours} fmt={(v) => money(v)} />
            </div>
          </div>
        </>
      )}

      {tab === 'sales' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12 }}>
            <Stat label={ARABIC ? 'الإيراد' : 'Revenue'} value={money(sum && sum.revenue)} accent />
            <Stat label={ARABIC ? 'عدد الفواتير' : 'Sales'} value={sum ? sum.orders : '—'} />
            <Stat label={ARABIC ? 'وحدات مباعة' : 'Units sold'} value={sum ? Number(sum.units) : '—'} />
          </div>
          {daily.length > 1 && (
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>📈 {ARABIC ? 'الإيراد اليومي' : 'Daily revenue'}</div>
              <Spline points={daily} />
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 12 }}>🥧 {ARABIC ? 'الإيراد حسب الفئة' : 'Revenue by category'}</div>
              <Donut slices={catSlices} />
            </div>
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 4 }}>🎯 {ARABIC ? 'الكمية × الإيراد لكل منتج' : 'Units × revenue per product'}</div>
              <div style={{ color: C.dim, fontSize: 12, marginBottom: 8 }}>
                {ARABIC ? 'مرّر على النقاط — الألوان حسب تصنيف ABC' : 'Hover dots — colored by ABC class'}
                <span style={{ marginInlineStart: 10 }}><span style={{ color: C.green }}>● A</span> <span style={{ color: C.accent }}>● B</span> <span style={{ color: C.dim }}>● C</span></span>
              </div>
              <Scatter points={scatterPoints} xLabel={ARABIC ? 'الكمية' : 'units'} yLabel={CURRENCY} />
            </div>
          </div>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>🏆 {ARABIC ? 'الأكثر مبيعاً' : 'Top products'}</div>
            {top.map((t, i) => (
              <div key={i} style={{ position: 'relative', padding: '7px 8px', marginBottom: 4, borderRadius: 8, overflow: 'hidden' }}>
                <div style={{ position: 'absolute', inset: 0, width: `${(Number(t.revenue) / topMax) * 100}%`, background: `${C.accent}22`, borderRadius: 8 }} />
                <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
                  <span>{i + 1}. {t.name}</span><span style={{ color: C.dim }}>{Number(t.units)} · <b style={{ color: C.accent }}>{money(t.revenue)}</b></span>
                </div>
              </div>
            ))}
            {!top.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا بيانات' : 'No data'}</div>}
          </div>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>🅰 {ARABIC ? 'تحليل ABC (مساهمة الإيراد)' : 'ABC analysis (revenue contribution)'}</div>
            {abc.slice(0, 20).map((x, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: `1px solid ${C.line}`, fontSize: 13 }}>
                <span style={{ background: abcBadge(x.class), color: C.accentText, borderRadius: 6, fontWeight: 800, fontSize: 11, padding: '2px 8px' }}>{x.class}</span>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.name}</span>
                <span style={{ color: C.dim }}>{money(x.revenue)}</span>
              </div>
            ))}
            {!abc.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا بيانات مبيعات' : 'No sales data'}</div>}
          </div>
        </>
      )}

      {tab === 'stock' && (
        <>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 8, color: C.red }}>⚠ {ARABIC ? 'مخزون منخفض' : 'Low stock'} ({low.length})</div>
            {low.map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                <span>{p.name} <span style={{ color: C.dim, fontSize: 12 }}>· {p.cat || '—'}</span></span>
                <span style={{ color: Number(p.stock) <= 0 ? C.red : C.accent, fontWeight: 700 }}>{Number(p.stock)}</span>
              </div>
            ))}
            {!low.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'كل المخزون جيد' : 'All stocked'}</div>}
          </div>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 8, color: C.dim }}>🧊 {ARABIC ? 'مخزون راكد — لم يُبَع منذ ٣٠ يوماً' : 'Dead stock — no sales in 30 days'} ({deadStock.length})</div>
            {deadStock.slice(0, 25).map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                <span>{p.name} <span style={{ color: C.dim, fontSize: 12 }}>· {p.cat || '—'}</span></span>
                <span style={{ color: C.dim }}>{Number(p.stock)} {ARABIC ? 'بالمخزون' : 'in stock'} · {money(Number(p.stock) * Number(p.cost || 0))} {ARABIC ? 'كلفة' : 'cost'}</span>
              </div>
            ))}
            {!deadStock.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'كل شيء يتحرك 👍' : 'Everything is moving 👍'}</div>}
          </div>
        </>
      )}

      {tab === 'staff' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>💰 {ARABIC ? 'المبيعات حسب الموظف' : 'Sales per employee'}</div>
            {staffSales.map((s) => (
              <div key={s.username} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                <span>{s.username} <span style={{ color: C.dim, fontSize: 12 }}>×{s.orders}</span></span>
                <span style={{ fontWeight: 700, color: C.accent }}>{money(s.revenue)}</span>
              </div>
            ))}
            {!staffSales.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا مبيعات في الفترة' : 'No sales in range'}</div>}
          </div>
          <div style={S.card}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>🕐 {ARABIC ? 'ساعات الدوام' : 'Clocked hours'}</div>
            {hoursByUser.map((h) => (
              <div key={h.username} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                <span>{h.username}</span><span style={{ color: C.dim }}>{h.hours.toFixed(2)} {ARABIC ? 'ساعة' : 'h'}</span>
              </div>
            ))}
            {!hoursByUser.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا سجلّات' : 'No punches'}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── SVG charts — hand-rolled, no chart library (bundle stays tiny) ──────────────

// Donut chart. slices: [{label, value, color}]. Shows legend with % share.

export default ReportsView;
export { ReportsView };
