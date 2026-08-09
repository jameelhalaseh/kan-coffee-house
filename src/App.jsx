/* eslint-disable */
// Dukkan — single-store, barcode-driven grocery POS.
// Scan → cart → checkout. No floors, no recipes: a product catalogue plus a sales screen.
// Talks to the Express API via src/api.js (Bearer session token). The store key is fixed
// to DEFAULT_FLOOR ("main") wherever the generic orders/invoice API needs a store id.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from './api';
import {
  STORE_NAME, CURRENCY, ARABIC, DEFAULT_FLOOR, BILL, SELLER, VIEWS, VIEW_LABELS, toggleLang, TAX_RATE,
} from './client.config';
import {
  money, r3, splitInclusiveTax, uid, nowParts, todayInStore, storeTimeOf, storeDateOf,
  cashSuggestions, catColor, escapeHtml, remainingQty, returnedMapFor,
} from './lib';
import { parseProductCsv, importTemplateCsv, MAX_IMPORT_ROWS } from './csv';
import AssistantView from './AssistantView';

const TOKEN_KEY = 'dukkan_token';

// ── Theme (shared via src/theme.js) ─────────────────────────────────────────────
import { C, S } from './theme';

// ── Receipt printing (hidden iframe → window.print) ─────────────────────────────
function printReceipt(sale) {
  const lines = (sale.items || []).map(
    (li) => `<tr><td>${escapeHtml(li.name)}</td><td style="text-align:center">${li.qty}</td>
      <td style="text-align:right">${(Number(li.price) || 0).toFixed(3)}</td>
      <td style="text-align:right">${((Number(li.price) || 0) * li.qty).toFixed(3)}</td></tr>`
  ).join('');
  const thanks = ARABIC ? (BILL.footerThanksAr || BILL.footerThanks) : BILL.footerThanks;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{font-family:'Courier New',monospace;color:#000} body{width:280px;margin:0 auto;padding:8px}
    h2{text-align:center;margin:4px 0;font-size:18px} .muted{text-align:center;font-size:11px;color:#333}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
    td,th{padding:2px 0} thead th{border-bottom:1px dashed #000;text-align:left}
    .tot{border-top:1px dashed #000;font-weight:bold;font-size:14px}
    .ftr{text-align:center;margin-top:10px;font-size:12px}</style></head><body>
    <h2>${escapeHtml(SELLER.name || STORE_NAME)}</h2>
    ${SELLER.location ? `<div class="muted">${escapeHtml(SELLER.location)}</div>` : ''}
    ${SELLER.taxNo ? `<div class="muted">Tax No: ${escapeHtml(SELLER.taxNo)}</div>` : ''}
    <div class="muted">Invoice ${BILL.invoicePrefix || ''}${sale.invoice_no ?? ''} — ${sale.date} ${sale.time}</div>
    <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th>
      <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${lines}</tbody>
      <tfoot>${Number(sale.tax) > 0 ? `
        <tr><td colspan="3">Subtotal</td>
          <td style="text-align:right">${(Number(sale.sub) || 0).toFixed(3)}</td></tr>
        <tr><td colspan="3">VAT ${Math.round(TAX_RATE * 100)}% (included)</td>
          <td style="text-align:right">${(Number(sale.tax) || 0).toFixed(3)}</td></tr>` : ''}
        <tr class="tot"><td colspan="3">TOTAL</td>
        <td style="text-align:right">${(Number(sale.total) || 0).toFixed(3)}</td></tr>
        <tr><td colspan="4" style="font-size:11px;padding-top:4px">Paid: ${escapeHtml(sale.pay || '')}</td></tr>
      </tfoot></table>
    <div class="ftr">${escapeHtml(thanks || '')}</div></body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  frame.contentWindow.focus();
  setTimeout(() => {
    frame.contentWindow.print();
    setTimeout(() => document.body.removeChild(frame), 1000);
  }, 250);
}
// ── Audio feedback (WebAudio, no assets) ─────────────────────────────────────────
// Success: one short high beep (scan accepted). Error: two low buzzes (unknown barcode).
let _audioCtx = null;
function beep(ok = true) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const play = (freq, at, dur) => {
      const o = _audioCtx.createOscillator();
      const g = _audioCtx.createGain();
      o.type = 'square'; o.frequency.value = freq;
      o.connect(g); g.connect(_audioCtx.destination);
      const t = _audioCtx.currentTime + at;
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur);
    };
    if (ok) play(1500, 0, 0.08);
    else { play(300, 0, 0.14); play(300, 0.18, 0.14); }
  } catch (_) { /* audio unavailable (old browser / no user gesture yet) — silent */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// Root
// ══════════════════════════════════════════════════════════════════════════════
const BC_NAME = 'dukkan_pos';
export default function App() {
  const isDisplay = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('display') === '1';
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('sales');
  const [toast, setToast] = useState(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [pwOpen, setPwOpen] = useState(false);   // change-password popup

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  const notify = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  }, []);

  // Restore session on load from the persisted token.
  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) { setBooting(false); return; }
    api.setToken(t);
    let alive = true;
    api.get('/auth/validate')
      .then((u) => { if (alive) setUser(u); })
      .catch(() => { api.setToken(null); localStorage.removeItem(TOKEN_KEY); })
      .finally(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, []);

  // Blocking overlay when the session dies mid-use.
  useEffect(() => {
    api.setOnSessionExpired(() => {
      api.setToken(null);
      localStorage.removeItem(TOKEN_KEY);
      setUser(null);
      notify(ARABIC ? 'انتهت الجلسة، سجّل الدخول من جديد' : 'Session expired — please log in again', 'red');
    });
  }, [notify]);

  const handleLogin = (u) => {
    api.setToken(u.token);
    localStorage.setItem(TOKEN_KEY, u.token);
    setUser(u);
    setView('sales');
  };
  const handleLogout = async () => {
    try { await api.post('/auth/logout'); } catch (_) {}
    api.setToken(null);
    localStorage.removeItem(TOKEN_KEY);
    setUser(null);
  };

  if (isDisplay) return <CustomerDisplay />;
  if (booting) return <Centered>{ARABIC ? 'جارٍ التحميل…' : 'Loading…'}</Centered>;
  if (!user) return <Login onLogin={handleLogin} />;

  const isAdmin = user.role === 'admin';
  const allowed = (v) => {
    if (v === 'assistant') return isAdmin;   // owner-only: inventory AI sees revenue + costs
    if (v === 'sales' || v === 'settings' || isAdmin) return true;
    const views = user.allowed_views || [];
    if (v === 'receive') return views.includes('inventory') || views.includes('receive');
    return views.includes(v);
  };
  const navViews = VIEWS.filter(allowed);

  return (
    <div dir="ltr" style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif", display: 'flex', alignItems: 'stretch' }}>
      <main dir={ARABIC ? 'rtl' : 'ltr'} style={{ flex: 1, minWidth: 0, padding: 16, boxSizing: 'border-box' }}>
        {!online && (
          <div style={{ background: C.red, color: '#fff', borderRadius: 10, padding: '10px 16px', marginBottom: 12, fontWeight: 800, fontSize: 15, textAlign: 'center' }}>
            ⚠ {ARABIC ? 'لا يوجد اتصال — سيتم حفظ المبيعات محلياً ومزامنتها عند عودة الاتصال' : 'Offline — sales are saved locally and sync when the connection returns'}
          </div>
        )}
        {/* Sales earns the full width — more product tiles visible means fewer taps. Every
            other view is a table or a few stat cards, and stretched across a 1500px counter
            monitor those read as an unfinished page rather than a spacious one: the eye has
            to travel the whole width to pair a row with its buttons. Capping the measure and
            centring it keeps related things near each other. */}
        <div style={{ maxWidth: view === 'sales' ? 'none' : 1180, marginInline: view === 'sales' ? 0 : 'auto' }}>
          {view === 'sales' && <SalesView user={user} notify={notify} />}
          {view === 'inventory' && allowed('inventory') && <InventoryView isAdmin={isAdmin} notify={notify} />}
          {view === 'receive' && allowed('receive') && <ReceiveView isAdmin={isAdmin} notify={notify} />}
          {view === 'history' && allowed('history') && <HistoryView user={user} notify={notify} />}
          {view === 'reports' && allowed('reports') && <ReportsView notify={notify} />}
          {view === 'assistant' && allowed('assistant') && <AssistantView notify={notify} />}
          {view === 'settings' && <SettingsView user={user} isAdmin={isAdmin} notify={notify} />}
        </div>
      </main>
      <Sidebar user={user} view={view} setView={setView} navViews={navViews} onLogout={handleLogout} canSeeStock={allowed('inventory') || allowed('reports')} onChangePassword={() => setPwOpen(true)} />
      {pwOpen && <ChangePasswordModal notify={notify} onClose={() => setPwOpen(false)} />}
      {toast && (
        <div className="toast-pop" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.kind === 'red' ? C.red : toast.kind === 'green' ? C.green : C.panel2, color: toast.kind === 'info' ? C.text : C.accentText, padding: '13px 24px', borderRadius: 12, fontWeight: 700, fontSize: 15, boxShadow: '0 10px 34px rgba(0,0,0,.5)', zIndex: 1000 }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function Centered({ children }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, color: C.dim, fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif" }}>{children}</div>;
}

// ── Customer-facing display (open ?display=1 on a 2nd screen) ────────────────────
// Mirrors the live cart from the Sales screen via BroadcastChannel (+ localStorage fallback).
function CustomerDisplay() {
  const [state, setState] = useState(() => { try { return JSON.parse(localStorage.getItem('dukkan_display')) || null; } catch (_) { return null; } });
  useEffect(() => {
    let bc;
    try { bc = new BroadcastChannel(BC_NAME); bc.onmessage = (e) => setState(e.data); } catch (_) {}
    const onStorage = (e) => { if (e.key === 'dukkan_display' && e.newValue) { try { setState(JSON.parse(e.newValue)); } catch (_) {} } };
    window.addEventListener('storage', onStorage);
    return () => { if (bc) bc.close(); window.removeEventListener('storage', onStorage); };
  }, []);
  const items = (state && state.items) || [];
  const total = (state && state.total) || 0;
  return (
    <div dir={ARABIC ? 'rtl' : 'ltr'} style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif", display: 'flex', flexDirection: 'column', padding: 28 }}>
      <div style={{ fontWeight: 800, fontSize: 40, color: C.accent, textAlign: 'center', marginBottom: 18 }}>{STORE_NAME}</div>
      <div style={{ flex: 1, overflow: 'auto', maxWidth: 720, width: '100%', margin: '0 auto' }}>
        {!items.length && <div style={{ color: C.dim, fontSize: 26, textAlign: 'center', marginTop: 80 }}>{ARABIC ? 'أهلاً بك' : 'Welcome'}</div>}
        {items.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: `1px solid ${C.line}`, fontSize: 26 }}>
            <span>{l.name} <span style={{ color: C.dim, fontSize: 20 }}>× {l.qty}</span></span>
            <span style={{ fontWeight: 700 }}>{money(l.price * l.qty)}</span>
          </div>
        ))}
      </div>
      <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', borderTop: `2px solid ${C.accent}`, paddingTop: 16, display: 'flex', justifyContent: 'space-between', fontSize: 48, fontWeight: 800 }}>
        <span>{ARABIC ? 'المجموع' : 'Total'}</span><span style={{ color: C.accent }}>{money(total)}</span>
      </div>
      {state && state.change != null && state.change >= 0 && (
        <div style={{ maxWidth: 720, width: '100%', margin: '6px auto 0', display: 'flex', justifyContent: 'space-between', fontSize: 30, color: C.green, fontWeight: 700 }}>
          <span>{ARABIC ? 'الباقي' : 'Change'}</span><span>{money(state.change)}</span>
        </div>
      )}
    </div>
  );
}

const VIEW_ICONS = { sales: '🛒', inventory: '📦', receive: '📥', history: '🧾', reports: '📊', assistant: '🤖', settings: '⚙️' };

// Clock In/Out for the logged-in employee.
function ClockButton() {
  const [open, setOpen] = useState(null); // open punch or null
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/timeclock/status').then(setOpen).catch(() => {}); }, []);
  const toggle = async () => {
    setBusy(true);
    try {
      if (open) { await api.post('/timeclock/out'); setOpen(null); }
      else { await api.post('/timeclock/in'); api.get('/timeclock/status').then(setOpen); }
    } catch (_) {} finally { setBusy(false); }
  };
  return (
    <button onClick={toggle} disabled={busy} style={{ ...S.btnGhost, height: 64, fontSize: 14, ...(open ? { borderColor: C.green, color: C.green } : {}) }}>
      {open ? (ARABIC ? '🟢 خروج' : '🟢 Clock Out') : (ARABIC ? '🕐 دخول' : '🕐 Clock In')}
    </button>
  );
}

// Bell badge: low-stock + expiring counts, with a dropdown list.
function NotificationsBell() {
  const [low, setLow] = useState([]);
  const [exp, setExp] = useState([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api.get('/reports/low-stock?threshold=5').then(setLow).catch(() => {});
    api.get('/expiry?days=14').then(setExp).catch(() => {});
  }, []);
  const count = low.length + exp.length;
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)}
        title={ARABIC ? 'تنبيهات المخزون' : 'Stock alerts'}
        style={{ ...S.btnGhost, height: 56, fontSize: 15, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                 ...(count > 0 ? { borderColor: C.red, color: C.red } : {}) }}>
        <span style={{ fontSize: 18 }}>🔔</span>
        <span>{ARABIC ? 'تنبيهات' : 'Alerts'}</span>
        {count > 0 && (
          <span style={{ background: C.red, color: '#fff', borderRadius: 10, fontSize: 12, fontWeight: 800, padding: '1px 7px' }}>{count}</span>
        )}
      </button>
      {open && <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 999 }} />}
      {open && (
        // Fixed to the viewport, floating beside the sidebar — an absolute panel would be
        // clipped by the sidebar's own width + overflow-y:auto.
        <div className="rise" style={{ position: 'fixed', right: 236, bottom: 16, width: 320, maxHeight: '70vh', overflow: 'auto', background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, zIndex: 1000, boxShadow: '0 12px 40px rgba(0,0,0,.55)' }}>
          <div style={{ fontWeight: 800, marginBottom: 6, color: C.red }}>{ARABIC ? 'مخزون منخفض' : 'Low stock'} ({low.length})</div>
          {low.slice(0, 8).map((p) => <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>{p.name}</span><span style={{ color: C.red }}>{Number(p.stock)}</span></div>)}
          <div style={{ fontWeight: 800, margin: '10px 0 6px', color: C.accent }}>{ARABIC ? 'قرب الانتهاء' : 'Expiring'} ({exp.length})</div>
          {exp.slice(0, 8).map((e) => <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>{e.product}</span><span style={{ color: Number(e.days_left) < 0 ? C.red : C.accent }}>{e.expiry}</span></div>)}
          {!count && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا تنبيهات' : 'All good'}</div>}
        </div>
      )}
    </div>
  );
}

// Vertical navigation rail, pinned to the right edge. Bigger touch targets.
function Sidebar({ user, view, setView, navViews, onLogout, canSeeStock, onChangePassword }) {
  return (
    <aside dir={ARABIC ? 'rtl' : 'ltr'} style={{
      width: 220, flex: '0 0 220px', background: C.panel, borderInlineStart: `1px solid ${C.line}`,
      display: 'flex', flexDirection: 'column', gap: 10, padding: 14, boxSizing: 'border-box',
      position: 'sticky', top: 0, height: '100vh', overflowY: 'auto',
    }}>
      <div style={{ fontWeight: 800, fontSize: 26, color: C.accent, textAlign: 'center', padding: '6px 0 10px' }}>{STORE_NAME}</div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {navViews.map((v) => {
          const on = view === v;
          return (
            <button key={v} onClick={() => setView(v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                width: '100%', height: 72, padding: '0 18px', borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${on ? C.accent : C.line}`, background: on ? `linear-gradient(135deg, ${C.accent}, #d98f1c)` : C.panel2,
                color: on ? C.accentText : C.text, fontWeight: 700, fontSize: 18, transition: 'background .12s',
                boxShadow: on ? '0 6px 20px rgba(240,168,48,.35)' : 'none',
              }}>
              <span style={{ fontSize: 30, lineHeight: 1 }}>{VIEW_ICONS[v]}</span>
              <span>{VIEW_LABELS[v]}</span>
            </button>
          );
        })}
      </nav>

      <div style={{ flex: 1 }} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
        {canSeeStock && <NotificationsBell />}
        <ClockButton />
        <button onClick={toggleLang} style={{ ...S.btnGhost, height: 56, fontSize: 16 }}>{ARABIC ? '🌐 English' : '🌐 عربي'}</button>
        <div style={{ fontSize: 14, color: C.dim, textAlign: 'center' }}>{user.full_name || user.username}</div>
        <button onClick={onChangePassword} style={{ ...S.btnGhost, height: 48, fontSize: 14 }}>🔑 {ARABIC ? 'كلمة المرور' : 'Password'}</button>
        <button onClick={onLogout} style={{ ...S.btnGhost, height: 56, fontSize: 16 }}>{ARABIC ? '🚪 خروج' : '🚪 Logout'}</button>
      </div>
    </aside>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// On-screen keyboard (touch screens) — drives whichever field is active.
// ══════════════════════════════════════════════════════════════════════════════
function OnScreenKeyboard({ onKey, onBackspace, onEnter, onClose }) {
  const [mode, setMode] = useState('num');   // 'num' (default) | 'abc'
  const [caps, setCaps] = useState(false);
  const key = (label, onTap, flex = 1, extra = {}) => (
    <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={onTap}
      style={{ flex, minWidth: 0, height: 56, borderRadius: 10, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 20, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', userSelect: 'none', ...extra }}>
      {label}
    </button>
  );
  const toggleKey = key(mode === 'num' ? 'ABC' : '123', () => setMode((m) => (m === 'num' ? 'abc' : 'num')), 1.4, { background: C.blue, color: '#fff', fontSize: 16 });
  const bottomRow = (
    <div style={{ display: 'flex', gap: 8 }}>
      {key(ARABIC ? 'إغلاق' : 'Hide', onClose, 1.4, { fontSize: 15 })}
      {key('␣', () => onKey(' '), 4)}
      {key(ARABIC ? 'دخول' : 'Enter', onEnter, 2, { background: C.green, color: C.accentText, fontSize: 16 })}
    </div>
  );

  if (mode === 'num') {
    const cell = (ch) => key(ch, () => onKey(ch));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>{r.map(cell)}</div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          {toggleKey}
          {cell('0')}
          {key('⌫', onBackspace, 1.4, { background: C.red, color: '#fff' })}
        </div>
        {bottomRow}
      </div>
    );
  }

  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '_', '@'],
  ];
  const cell = (ch) => key(caps ? ch.toUpperCase() : ch, () => onKey(caps ? ch.toUpperCase() : ch));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8 }}>
          {i === 3 && key(caps ? '⇧' : '⇪', () => setCaps((c) => !c), 1.4, caps ? { background: C.accent, color: C.accentText } : {})}
          {r.map(cell)}
          {i === 3 && key('⌫', onBackspace, 1.4, { background: C.red, color: '#fff' })}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        {toggleKey}
        {key('␣', () => onKey(' '), 4)}
        {key(ARABIC ? 'دخول' : 'Enter', onEnter, 2, { background: C.green, color: C.accentText, fontSize: 16 })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Login
// ══════════════════════════════════════════════════════════════════════════════
function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState('username');   // which field the keyboard types into
  const [kb, setKb] = useState(true);                 // on-screen keyboard visible
  const [showLogo, setShowLogo] = useState(false);    // logo fades in when the bg video ends
  const videoRef = useRef(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play?.().catch(() => {});                        // muted autoplay; ignore blocked promise
    let t;
    const arm = () => {
      clearTimeout(t);
      const secs = v.duration && isFinite(v.duration) ? v.duration : 6;
      t = setTimeout(() => setShowLogo(true), secs * 1000 + 200);   // fallback if 'ended' never fires
    };
    if (v.readyState >= 1) arm();
    else v.addEventListener('loadedmetadata', arm, { once: true });
    return () => clearTimeout(t);
  }, []);

  const submit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const u = await api.post('/auth/login', { username, password });
      onLogin(u);
    } catch (ex) {
      // 429 'locked' = too many failed attempts for this username. Say so plainly with the
      // wait — a cashier mid-queue needs to know it's a lockout, not a typo.
      if (ex.message === 'locked') {
        const mins = Math.max(1, Math.ceil(((ex.body && ex.body.retry_after_s) || 900) / 60));
        setErr(ARABIC
          ? `محاولات كثيرة خاطئة — حاول بعد ${mins} دقيقة`
          : `Too many failed attempts — try again in ${mins} min`);
      } else {
        setErr(ARABIC ? 'اسم المستخدم أو كلمة المرور غير صحيحة' : 'Invalid username or password');
      }
    } finally { setBusy(false); }
  };

  const setActiveValue = (fn) => (active === 'username' ? setUsername(fn) : setPassword(fn));
  const onKey = (ch) => setActiveValue((v) => v + ch);
  const onBackspace = () => setActiveValue((v) => v.slice(0, -1));

  const fieldStyle = (name) => ({ ...S.input, fontSize: 17, padding: '14px 14px', ...(active === name && kb ? { borderColor: C.accent, boxShadow: `0 0 0 2px ${C.accent}33` } : {}) });

  const base = process.env.PUBLIC_URL || '';
  const bgPoster = base + '/login-bg.png';
  const bgVideo = base + '/login-bg.mp4';
  const logoMark = base + '/logo-mark.png';
  return (
    <div dir="ltr" style={{
      position: 'relative', overflow: 'hidden',
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif", padding: 'clamp(16px, 4vw, 64px)',
      background: '#0f1117',
    }}>
      {/* Supermarket checkout background video — plays once, then the logo fades in */}
      <video
        ref={videoRef}
        autoPlay muted playsInline loop
        poster={bgPoster}
        onEnded={() => setShowLogo(true)}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 0 }}
      >
        <source src={bgVideo} type="video/mp4" />
      </video>
      {/* Readability scrim */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
        background: 'linear-gradient(90deg, rgba(15,17,23,.10) 0%, rgba(15,17,23,.45) 50%, rgba(15,17,23,.85) 100%)' }} />
      {/* Logo reveal after the video ends */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, textAlign: 'center',
        paddingInlineEnd: 'min(40vw, 480px)',
        background: showLogo ? 'rgba(15,17,23,.55)' : 'rgba(15,17,23,0)',
        opacity: showLogo ? 1 : 0, transition: 'opacity 1.4s ease, background 1.4s ease' }}>
        <img src={logoMark} alt="حtech." style={{ width: 'min(38vw, 340px)', maxWidth: '80%', filter: 'drop-shadow(0 8px 30px rgba(0,0,0,.6))',
          transform: showLogo ? 'translateY(0)' : 'translateY(12px)', transition: 'transform 1.4s ease' }} />
        <div style={{ color: '#fff', fontWeight: 600, fontSize: 'clamp(15px, 2.2vw, 24px)', letterSpacing: '.01em',
          textShadow: '0 2px 16px rgba(0,0,0,.7)' }}>we bring your idea to life.</div>
      </div>
      <form onSubmit={submit} dir={ARABIC ? 'rtl' : 'ltr'} style={{ ...S.card, position: 'relative', zIndex: 2, width: 'min(94vw, 440px)', display: 'flex', flexDirection: 'column', gap: 14, backdropFilter: 'blur(6px)', background: 'rgba(26,28,37,.92)', boxShadow: '0 20px 60px rgba(0,0,0,.55)' }}>
        <div style={{ fontWeight: 800, fontSize: 30, color: C.accent, textAlign: 'center' }}>{STORE_NAME}</div>
        <div style={{ color: C.dim, fontSize: 14, textAlign: 'center', marginTop: -8 }}>{ARABIC ? 'تسجيل الدخول' : 'Sign in'}</div>
        <button type="button" onClick={toggleLang} style={{ ...S.btnGhost, alignSelf: 'center', padding: '6px 16px', fontSize: 13 }}>{ARABIC ? '🌐 English' : '🌐 عربي'}</button>
        <input style={fieldStyle('username')} placeholder={ARABIC ? 'اسم المستخدم' : 'Username'} value={username}
          onChange={(e) => setUsername(e.target.value)} onFocus={() => { setActive('username'); setKb(true); }}
          autoFocus autoCapitalize="off" autoComplete="off" />
        <input style={fieldStyle('password')} type="password" placeholder={ARABIC ? 'كلمة المرور' : 'Password'} value={password}
          onChange={(e) => setPassword(e.target.value)} onFocus={() => { setActive('password'); setKb(true); }} autoComplete="off" />
        {err && <div style={{ color: C.red, fontSize: 14 }}>{err}</div>}
        {process.env.REACT_APP_DEMO === '1' && (
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.dim, textAlign: 'center' }}>
            DEMO — no backend. Sign in: <b style={{ color: C.accent }}>admin</b> / any password<br />or <b style={{ color: C.accent }}>cashier</b> (limited views). Data is local to your browser.
          </div>
        )}
        <button type="submit" disabled={busy} style={{ ...S.btn, padding: '16px', fontSize: 18, opacity: busy ? 0.6 : 1 }}>{busy ? '…' : (ARABIC ? 'دخول' : 'Login')}</button>
        {!kb && <button type="button" onClick={() => setKb(true)} style={{ ...S.btnGhost, padding: '12px' }}>{ARABIC ? 'إظهار لوحة المفاتيح' : 'Show keyboard'}</button>}
        {kb && <OnScreenKeyboard onKey={onKey} onBackspace={onBackspace} onEnter={submit} onClose={() => setKb(false)} />}
      </form>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Sales — scan → cart → checkout
// ══════════════════════════════════════════════════════════════════════════════
const HELD_KEY = 'dukkan_held_sales';
const PENDING_KEY = 'dukkan_pending_sales';   // sales made offline, awaiting sync
const PAD_KEY = 'dukkan_show_cash_pad';       // cash keypad visibility preference

const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (_) { return []; } };
// Network failure = fetch rejected before a response (our api errors always carry .status).
const isNetworkError = (ex) => ex && ex.status === undefined;

// ── Category browsing (shared by Sales and Inventory) ─────────────────────────
// Both screens use the same two-step model: pick a shelf, then work inside it.
//   cat === null → the grid below is showing
//   cat === 'all' → every product      cat === '' → products with no category
//   otherwise     → that category name
// ALL_CAT/NO_CAT are the sentinel values so neither screen invents its own.
const ALL_CAT = 'all';
const NO_CAT = '';

// Build the card list from a product array: one card per category, plus an
// "Uncategorised" card only when something actually needs it.
function categoryCards(products) {
  const named = Array.from(new Set(products.map((p) => p.cat).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ key: c, name: c, count: products.filter((p) => p.cat === c).length }));
  const orphans = products.filter((p) => !p.cat).length;
  if (orphans) named.push({ key: NO_CAT, name: ARABIC ? 'بدون فئة' : 'Uncategorised', count: orphans, orphan: true });
  return named;
}

// Does this product belong in the current view? (search is handled by the caller)
const inCat = (p, cat) => (cat === ALL_CAT ? true : cat === NO_CAT ? !p.cat : p.cat === cat);

function CategoryGrid({ cards, total, onPick, emptyHint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, alignContent: 'start' }}>
      {cards.map((c) => (
        <button key={c.key || 'none'} onClick={() => onPick(c.key)} className="rise" style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10, height: 132, padding: '14px 16px',
          borderRadius: 14, border: `1px solid ${c.orphan ? C.line : catColor(c.name, 0.45)}`,
          background: c.orphan ? C.panel2 : `linear-gradient(150deg, ${catColor(c.name, 0.26)} 0%, ${C.panel2} 70%)`,
          color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', overflow: 'hidden',
        }}>
          <span style={{
            width: 34, height: 34, borderRadius: 10, background: c.orphan ? C.line : catColor(c.name),
            color: c.orphan ? C.dim : '#0f1117',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17,
          }}>{c.orphan ? '?' : c.name.slice(0, 1)}</span>
          <span>
            <span style={{ display: 'block', fontSize: 17, fontWeight: 800, lineHeight: 1.2 }}>{c.name}</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: C.dim }}>
              {c.count} {ARABIC ? 'صنف' : c.count === 1 ? 'item' : 'items'}
            </span>
          </span>
        </button>
      ))}
      {!!cards.length && (
        <button onClick={() => onPick(ALL_CAT)} className="rise" style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10, height: 132, padding: '14px 16px',
          borderRadius: 14, border: `1px dashed ${C.line}`, background: C.panel2,
          color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit',
        }}>
          <span style={{ fontSize: 26, opacity: .5 }}>🗂</span>
          <span>
            <span style={{ display: 'block', fontSize: 17, fontWeight: 800 }}>{ARABIC ? 'كل الأصناف' : 'All items'}</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: C.dim }}>
              {total} {ARABIC ? 'صنف' : 'items'}
            </span>
          </span>
        </button>
      )}
      {!cards.length && (
        <div style={{ color: C.dim, fontSize: 15, gridColumn: '1/-1', padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 12, opacity: .45 }}>📦</div>
          {emptyHint}
        </div>
      )}
    </div>
  );
}

// Breadcrumb above the drilled-in list. Back sits at the trailing edge (right in LTR,
// left in RTL) so it lands under the thumb on a counter tablet.
function CategoryHeader({ title, count, onBack, extra }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{title}</span>
      <span style={{ fontSize: 13, color: C.dim }}>
        {count} {ARABIC ? 'صنف' : count === 1 ? 'item' : 'items'}
      </span>
      {extra}
      {onBack && (
        <button onClick={onBack} style={{
          ...S.btn, marginInlineStart: 'auto', padding: '14px 22px', fontSize: 17, fontWeight: 800,
          background: C.accent, color: C.accentText, border: `1px solid ${C.accent}`,
          borderRadius: 12, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(240,168,48,.25)',
        }}>
          {ARABIC ? 'الأقسام ›' : '‹ Categories'}
        </button>
      )}
    </div>
  );
}

const catTitle = (cat) => (cat === ALL_CAT ? (ARABIC ? 'كل الأصناف' : 'All items')
  : cat === NO_CAT ? (ARABIC ? 'بدون فئة' : 'Uncategorised') : cat);

function SalesView({ user, notify }) {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);          // [{id,barcode,name,price,qty}]
  // ONE query box, not two. There used to be a scan field and a separate search field
  // stacked on top of each other doing overlapping jobs, and the scanner's target was the
  // one that didn't say "search" — new staff picked wrong daily. Now: typing filters the
  // tiles live, Enter treats what you typed as a barcode. A scanner bursts characters and
  // sends Enter, so it lands on the barcode path without anyone aiming at anything.
  const [scan, setScan] = useState('');
  // null = browsing the category grid; 'all' or a category name = viewing that shelf's items.
  const [cat, setCat] = useState(null);
  const [pay, setPay] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [newProduct, setNewProduct] = useState(null); // {barcode} → modal
  const [editLine, setEditLine] = useState(null);      // cart line → qty/price keypad
  const [quickItem, setQuickItem] = useState(false);   // open-price misc item modal
  const [weighItem, setWeighItem] = useState(null);    // kg product → weight keypad
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(() => { try { return JSON.parse(localStorage.getItem(HELD_KEY)) || []; } catch (_) { return []; } });
  const [showHeld, setShowHeld] = useState(false);
  const [lastAdded, setLastAdded] = useState(null);   // {name, price, qty} → green flash in bill
  const [receipt, setReceipt] = useState(null);       // completed sale → print-or-skip popup
  const [showPad, setShowPad] = useState(() => localStorage.getItem(PAD_KEY) === '1');   // cash keypad, hidden by default
  const scanRef = useRef(null);
  const flashTimer = useRef(null);
  const flash = useCallback((line) => {
    setLastAdded(line);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setLastAdded(null), 1800);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const loadProducts = useCallback(async () => {
    try { setProducts(await api.get('/products')); } catch (_) {}
  }, []);
  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { scanRef.current && scanRef.current.focus(); }, []);
  const persistHeld = (list) => { setHeld(list); localStorage.setItem(HELD_KEY, JSON.stringify(list)); };

  const addToCart = useCallback((p, qty = 1) => {
    setCart((prev) => {
      const i = prev.findIndex((l) => l.id === p.id);
      if (i >= 0) { const next = [...prev]; next[i] = { ...next[i], qty: next[i].qty + qty }; return next; }
      return [...prev, { id: p.id, barcode: p.barcode, name: p.name, price: Number(p.price) || 0, qty, unit: p.unit || 'ea' }];
    });
    beep(true);
    flash({ name: p.name, price: Number(p.price) || 0, qty });
  }, [flash]);
  const refocus = () => scanRef.current && scanRef.current.focus();

  // Add a catalogue product: weighed (kg) products open the weight keypad; others add directly.
  const addProduct = (p) => {
    if (p.unit === 'kg') { setWeighItem(p); return; }
    addToCart(p); refocus();
  };

  const onScan = async (code) => {
    const c = String(code || '').trim();
    if (!c) return;
    setScan('');
    const local = products.find((p) => p.barcode && p.barcode === c);
    if (local) { addProduct(local); return; }
    try {
      const p = await api.get('/products/barcode/' + encodeURIComponent(c));
      setProducts((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
      addProduct(p);
    } catch (ex) {
      if (ex.status === 404) { beep(false); setNewProduct({ barcode: c }); }
      else { beep(false); notify(ARABIC ? 'تعذّر البحث' : 'Lookup failed', 'red'); }
    }
  };

  // ── Scanner hardening ───────────────────────────────────────────────────────
  // USB barcode scanners are keyboards: they burst characters fast and end with Enter.
  // If focus wandered off the scan input (cashier tapped a tile, closed a modal…), we
  // still capture the burst globally: keystrokes <100ms apart accumulate; Enter fires
  // the scan. Slow (human) typing outside an input is ignored, as is typing in inputs.
  const onScanRef = useRef(null);
  onScanRef.current = onScan;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = !!(newProduct || editLine || quickItem || weighItem || showHeld || receipt);
  useEffect(() => {
    let buf = '';
    let lastTs = 0;
    const onKeyDown = (e) => {
      if (modalOpenRef.current) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const now = Date.now();
      if (now - lastTs > 100) buf = '';       // gap too slow → human keys, restart buffer
      lastTs = now;
      if (e.key === 'Enter') {
        if (buf.length >= 4) { e.preventDefault(); onScanRef.current(buf); }
        buf = '';
      } else if (e.key.length === 1) {
        buf += e.key;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const setQty = (id, qty) => setCart((prev) => prev.flatMap((l) => (l.id === id ? (qty <= 0 ? [] : [{ ...l, qty }]) : [l])));
  const setLine = (id, patch) => setCart((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id) => setCart((prev) => prev.filter((l) => l.id !== id));
  const addCustom = ({ name, price, qty }) => setCart((prev) => [...prev, { id: 'misc-' + uid(), barcode: null, name, price: Number(price) || 0, qty: Number(qty) || 1, custom: true }]);

  const total = cart.reduce((s, l) => s + l.price * l.qty, 0);
  // Shelf prices in Jordan are VAT-INCLUSIVE, so the tax is extracted from the total rather
  // than added on top — the customer pays exactly the marked price. Checkout used to send
  // `tax: 0, sub: total` and never imported TAX_RATE at all, so every sale was recorded as
  // carrying no VAT: wrong on the receipt, wrong in the Z-report, and wrong on anything
  // filed with the ISTD. (If this client's prices are ever quoted NET of VAT, this is the
  // one place to change — and every shelf price rises by the rate.)
  const { net: netAmount, tax: taxAmount } = splitInclusiveTax(total, TAX_RATE);
  const change = pay === 'cash' && tendered ? (Number(tendered) - total) : null;

  // Push the live cart to the customer-facing display (2nd screen).
  useEffect(() => {
    const payload = { items: cart.map((l) => ({ name: l.name, price: l.price, qty: l.qty })), total, change, store: STORE_NAME };
    try { localStorage.setItem('dukkan_display', JSON.stringify(payload)); } catch (_) {}
    try { const bc = new BroadcastChannel(BC_NAME); bc.postMessage(payload); bc.close(); } catch (_) {}
  }, [cart, total, change]);
  const openDisplay = () => window.open(window.location.pathname + '?display=1', 'dukkan_customer', 'width=900,height=700');

  // Hold the current cart for later; clear the screen for the next customer.
  const holdSale = () => {
    if (!cart.length) return;
    persistHeld([...held, { id: uid(), items: cart, total, ts: new Date().toLocaleTimeString().slice(0, 5) }]);
    setCart([]); setTendered('');
    notify(ARABIC ? 'تم تعليق الفاتورة' : 'Sale held', 'green');
  };
  const resumeSale = (h) => {
    if (cart.length && !window.confirm(ARABIC ? 'استبدال الفاتورة الحالية؟' : 'Replace current bill?')) return;
    setCart(h.items); persistHeld(held.filter((x) => x.id !== h.id)); setShowHeld(false);
  };

  // ── Offline sales queue ────────────────────────────────────────────────────
  // A checkout that can't reach the server is stored locally (without an invoice
  // number) and synced automatically when the connection returns. Sync is serial
  // and stops on the first failure, so order is preserved and nothing is lost.
  const [pending, setPending] = useState(readPending);
  const persistPending = (list) => { setPending(list); localStorage.setItem(PENDING_KEY, JSON.stringify(list)); };
  const syncingRef = useRef(false);

  const syncPending = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      let list = readPending();
      let synced = 0;
      while (list.length) {
        const s = list[0];
        try {
          const invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
          await api.post('/orders', { ...s, invoice_no });
        } catch (ex) { break; }   // still unreachable (or rejected) — retry on next online event
        list = list.slice(1);
        synced += 1;
        localStorage.setItem(PENDING_KEY, JSON.stringify(list));
      }
      setPending(list);
      if (synced) {
        notify(ARABIC ? `تمت مزامنة ${synced} فاتورة معلّقة` : `Synced ${synced} offline sale${synced > 1 ? 's' : ''}`, 'green');
        loadProducts();
      }
    } finally { syncingRef.current = false; }
  }, [notify, loadProducts]);

  useEffect(() => {
    syncPending();   // flush anything left over from a previous session
    window.addEventListener('online', syncPending);
    return () => window.removeEventListener('online', syncPending);
  }, [syncPending]);

  const checkout = async () => {
    if (!cart.length || busy) return;
    setBusy(true);
    const { date, time } = nowParts();
    const sale = { id: uid(), floor: DEFAULT_FLOOR, items: cart, sub: r3(netAmount), tax: r3(taxAmount), svc: 0, disc: 0, total, pay, waiter: user.username, status: 'paid', date, time };
    // Sale is committed at this point — the popup only decides whether to print.
    const finish = (s) => { setReceipt({ ...s, change }); setCart([]); setTendered(''); setPay('cash'); };
    try {
      let invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
      try {
        // Server commits the order + stock deduction + stock log in ONE transaction.
        await api.post('/orders', { ...sale, invoice_no });
      } catch (ex) {
        if (ex.message === 'invoice_taken') {
          // Another terminal took this number — grab a fresh one and retry once.
          invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
          await api.post('/orders', { ...sale, invoice_no });
        } else throw ex;
      }
      finish({ ...sale, invoice_no });
      loadProducts();
      notify(ARABIC ? `تمت الفاتورة #${invoice_no}` : `Sale #${invoice_no} done`, 'green');
    } catch (ex) {
      if (isNetworkError(ex)) {
        // No server — keep the sale locally, print an OFFLINE receipt, move on.
        persistPending([...readPending(), sale]);
        finish({ ...sale, invoice_no: ARABIC ? 'غير متصل' : 'OFFLINE' });
        notify(ARABIC ? 'لا اتصال — حُفظت الفاتورة محلياً وستُزامن تلقائياً' : 'Offline — sale saved locally, will sync automatically', 'green');
      } else {
        notify(ex.message === 'invoice_taken' ? (ARABIC ? 'تعارض رقم الفاتورة، أعد المحاولة' : 'Invoice clash — retry') : (ARABIC ? 'فشل الدفع' : 'Checkout failed'), 'red');
      }
    } finally { setBusy(false); }
  };

  // Browse model: pick a category first, then its items. Searching cuts across every
  // category (you shouldn't have to guess the shelf to find a bottle), and a barcode scan
  // never touches this — it resolves straight to the product.
  const q = scan.trim();
  const searching = q.length > 0;
  const catCards = categoryCards(products);
  const browsing = !searching && cat === null;
  const tiles = products.filter((p) => {
    if (searching) {
      const s = q.toLowerCase();
      return (p.name || '').toLowerCase().includes(s) || (p.barcode || '').includes(q);
    }
    if (cat === null) return false;                 // category grid is showing instead
    return inCat(p, cat);
  });

  return (
    <div dir="ltr" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* Left: scan + tap-to-add product tiles */}
      <div dir={ARABIC ? 'rtl' : 'ltr'} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <input ref={scanRef} style={{ ...S.input, width: '100%', fontSize: 18, padding: '14px', paddingInlineEnd: scan ? 44 : 14, letterSpacing: 1 }}
              value={scan} onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onScan(scan);
                if (e.key === 'Escape') setScan('');
              }}
              placeholder={ARABIC ? '🔍 امسح الباركود أو ابحث بالاسم' : '🔍 Scan barcode or search by name'} inputMode="search" />
            {/* Clearing by hand is otherwise a long press on Backspace mid-queue. */}
            {scan && (
              <button onClick={() => { setScan(''); refocus(); }} aria-label={ARABIC ? 'مسح' : 'Clear'}
                style={{
                  position: 'absolute', insetInlineEnd: 6, top: '50%', transform: 'translateY(-50%)',
                  width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent',
                  color: C.dim, fontSize: 18, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
            )}
          </div>
          <button onClick={() => setQuickItem(true)} style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 }}>
            ＋ {ARABIC ? 'صنف يدوي' : 'Quick item'}
          </button>
          <button onClick={openDisplay} title={ARABIC ? 'شاشة الزبون' : 'Customer screen'} style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 }}>🖥</button>
          {!!held.length && (
            <button onClick={() => setShowHeld(true)} style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 }}>
              ⏸ {ARABIC ? 'المعلّقة' : 'Held'} ({held.length})
            </button>
          )}
          {!!pending.length && (
            <button onClick={syncPending} title={ARABIC ? 'مبيعات بانتظار المزامنة — اضغط للمحاولة' : 'Sales waiting to sync — tap to retry'}
              style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700, borderColor: C.red, color: C.red }}>
              ⇪ {pending.length}
            </button>
          )}
        </div>

        {/* Breadcrumb — only once you're inside a category (or searching across all of them). */}
        {!browsing && (
          <CategoryHeader
            title={searching ? (ARABIC ? 'نتائج البحث' : 'Search results') : catTitle(cat)}
            count={tiles.length}
            onBack={searching ? null : () => setCat(null)} />
        )}

        {browsing ? (
          /* Step 1 — the shelves. Tapping one drills into its items. */
          <CategoryGrid cards={catCards} total={products.length} onPick={setCat}
            emptyHint={ARABIC ? 'لا منتجات — أضفها من المخزون' : 'No products — add them in Inventory'} />
        ) : (
        /* Step 2 — the items on that shelf (or the search hits across all of them). */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))', gap: 12, alignContent: 'start' }}>
          {tiles.map((p) => (
            <button key={p.id} onClick={() => addProduct(p)} className="rise" style={{
              display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 6, height: 112, padding: '10px 12px 12px',
              borderRadius: 12, border: `1px solid ${C.line}`, borderTop: `3px solid ${catColor(p.cat)}`,
              background: `linear-gradient(180deg, ${catColor(p.cat, 0.10)} 0%, ${C.panel2} 55%)`,
              color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', overflow: 'hidden',
            }}>
              <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {p.name}{p.unit === 'kg' ? ' ⚖' : ''}
              </span>
              <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span style={{ color: C.accent, fontWeight: 800, fontSize: 16 }}>{money(p.price)}{p.unit === 'kg' ? (ARABIC ? '/كغ' : '/kg') : ''}</span>
                {/* A bare red pill reading "2" on a product tile reads as "2 in the cart",
                    which is the opposite of what it means. Say the word: it costs a few
                    pixels and removes the guess. Out of stock is worth its own wording —
                    the cashier should stop reaching for the shelf, not just hurry. */}
                {Number(p.stock) <= 0
                  ? <span style={{ fontSize: 11, color: '#fff', background: C.red, fontWeight: 800, borderRadius: 8, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                      {ARABIC ? 'نفد' : 'Out'}
                    </span>
                  : Number(p.stock) <= 5
                    ? <span title={ARABIC ? 'كمية منخفضة' : 'Low stock'}
                        style={{ fontSize: 11, color: C.red, border: `1px solid ${C.red}`, fontWeight: 800, borderRadius: 8, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                        {ARABIC ? `${Number(p.stock)} متبقٍ` : `${Number(p.stock)} left`}
                      </span>
                    : <span style={{ fontSize: 11, color: C.dim }}>{p.cat || ''}</span>}
              </span>
            </button>
          ))}
          {!tiles.length && (
            <div style={{ color: C.dim, fontSize: 15, gridColumn: '1/-1', padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 52, marginBottom: 12, opacity: .45 }}>{searching ? '🔍' : '📦'}</div>
              {searching
                ? (ARABIC ? 'لا نتائج مطابقة' : 'Nothing matches that search')
                : (ARABIC ? 'لا منتجات — أضفها من المخزون' : 'No products — add them in Inventory')}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Right: bill */}
      <div dir={ARABIC ? 'rtl' : 'ltr'} style={{ ...S.card, flex: '0 0 400px', width: 400, position: 'sticky', top: 16, padding: 0, overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,.35)' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.accent}, #d98f1c)`, color: C.accentText, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 800, fontSize: 20 }}>🧾 {ARABIC ? 'الفاتورة' : 'Bill'}</span>
          <span style={{ background: 'rgba(15,17,23,.25)', borderRadius: 20, padding: '3px 12px', fontWeight: 800, fontSize: 14 }}>
            {cart.reduce((s, l) => s + l.qty, 0)} {ARABIC ? 'صنف' : 'items'}
          </span>
        </div>
        {lastAdded && (
          <div className="rise" style={{ background: 'rgba(62,207,142,.14)', borderBottom: `2px solid ${C.green}`, color: C.green, padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 800, fontSize: 17 }}>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>✓ {lastAdded.name}{lastAdded.qty !== 1 ? ` × ${lastAdded.qty}` : ''}</span>
            <span style={{ flexShrink: 0 }}>{money(lastAdded.price * lastAdded.qty)}</span>
          </div>
        )}
        <div style={{ padding: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '38vh', overflow: 'auto' }}>
          {!cart.length && (
            <div style={{ color: C.dim, fontSize: 15, padding: '34px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 44, marginBottom: 10, opacity: .5 }}>🛒</div>
              {ARABIC ? 'اضغط أو امسح منتجاً للبدء' : 'Tap or scan a product to start'}
            </div>
          )}
          {cart.map((l) => (
            <div key={l.id} className="rise" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px dashed ${C.line}` }}>
              <button onClick={() => setEditLine(l)} style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', textAlign: 'start', cursor: 'pointer', color: C.text, fontFamily: 'inherit', padding: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name} <span style={{ fontSize: 12, color: C.dim }}>✎</span></div>
                <div style={{ fontSize: 13, color: C.accent, fontWeight: 700 }}>{money(l.price)} × {l.qty} = {money(l.price * l.qty)}</div>
              </button>
              <button onClick={() => setQty(l.id, l.qty - 1)} style={qtyBtn}>−</button>
              <span style={{ minWidth: 28, textAlign: 'center', fontWeight: 800, fontSize: 16 }}>{l.qty}</span>
              <button onClick={() => setQty(l.id, l.qty + 1)} style={qtyBtn}>+</button>
              <button onClick={() => removeLine(l.id)} style={{ ...qtyBtn, color: C.red, borderColor: C.red }}>×</button>
            </div>
          ))}
        </div>
        <div style={{ margin: '14px 0', background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 16px' }}>
          {/* "How much is the tax?" is a question cashiers get asked at the counter. It used
              to be unanswerable without printing the receipt first. */}
          {TAX_RATE > 0 && total > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, fontSize: 14, color: C.dim }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{ARABIC ? 'المجموع الفرعي' : 'Subtotal'}</span><span>{money(netAmount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{ARABIC ? `ضريبة ${Math.round(TAX_RATE * 100)}% (مشمولة)` : `VAT ${Math.round(TAX_RATE * 100)}% (incl.)`}</span>
                <span>{money(taxAmount)}</span>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 26, fontWeight: 800 }}>
            <span style={{ fontSize: 17, color: C.dim }}>{ARABIC ? 'المجموع' : 'Total'}</span><span style={{ color: C.accent }}>{money(total)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {['cash', 'card'].map((m) => (
            <button key={m} onClick={() => setPay(m)} style={{ ...S.btnGhost, flex: 1, padding: '14px', fontSize: 16, ...(pay === m ? { background: C.blue, color: '#fff', borderColor: C.blue } : {}) }}>
              {m === 'cash' ? (ARABIC ? '💵 نقدي' : '💵 Cash') : (ARABIC ? '💳 بطاقة' : '💳 Card')}
            </button>
          ))}
        </div>
        {pay === 'cash' && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ ...S.input, fontSize: 20, fontWeight: 800, padding: '12px 14px', textAlign: 'center', color: tendered ? C.text : C.dim }}>
              {tendered || (ARABIC ? 'المبلغ المدفوع' : 'Cash given')}
            </div>
            {/* Smart suggestions: exact + the likely notes handed over (≥ total, deduped) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 8 }}>
              <button onClick={() => setTendered(total.toFixed(3))} style={{ ...S.btnGhost, padding: '12px', fontWeight: 800, borderColor: C.green, color: C.green }}>{ARABIC ? 'بالضبط' : 'Exact'}</button>
              {cashSuggestions(total).map((d) => (
                <button key={d} onClick={() => setTendered(String(d))} style={{ ...S.btnGhost, padding: '12px', fontWeight: 700 }}>{d}</button>
              ))}
            </div>
            {/* Touch keypad — optional; collapsed by default (suggestion buttons cover most cases) */}
            <button onClick={() => { const v = !showPad; setShowPad(v); localStorage.setItem(PAD_KEY, v ? '1' : '0'); }}
              style={{ ...S.btnGhost, width: '100%', padding: '9px', marginTop: 8, fontSize: 13, color: C.dim }}>
              {showPad ? (ARABIC ? '▲ إخفاء لوحة الأرقام' : '▲ Hide keypad') : (ARABIC ? '▼ إظهار لوحة الأرقام' : '▼ Show keypad')}
            </button>
            {showPad && (
              <div className="rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 8 }}>
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'].map((d) => (
                  <button key={d} onClick={() => setTendered((v) => (d === '.' && v.includes('.') ? v : v + d))}
                    style={{ ...S.btnGhost, padding: '13px 0', fontSize: 18, fontWeight: 800 }}>{d}</button>
                ))}
                <button onClick={() => setTendered((v) => v.slice(0, -1))} style={{ ...S.btnGhost, padding: '13px 0', fontSize: 18, color: C.red }}>⌫</button>
              </div>
            )}
            {change != null && change >= 0 && (
              <div style={{ background: 'rgba(62,207,142,.12)', border: `1px solid ${C.green}`, borderRadius: 10, padding: '10px 14px', marginTop: 8, display: 'flex', justifyContent: 'space-between', color: C.green, fontSize: 19, fontWeight: 800 }}>
                <span>{ARABIC ? 'الباقي' : 'Change'}</span><span>{money(change)}</span>
              </div>
            )}
            {change != null && change < 0 && <div style={{ color: C.red, fontSize: 15, marginTop: 8, fontWeight: 700 }}>{ARABIC ? 'ناقص' : 'Short'}: {money(-change)}</div>}
          </div>
        )}
        <button onClick={checkout} disabled={!cart.length || busy} style={{ ...S.btn, width: '100%', padding: '18px', fontSize: 19, opacity: (!cart.length || busy) ? 0.5 : 1 }}>
          {busy ? '…' : (ARABIC ? '✓ إتمام وطباعة' : '✓ Pay & Print')}
        </button>
        {!!cart.length && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={holdSale} style={{ ...S.btnGhost, flex: 1, padding: '12px' }}>⏸ {ARABIC ? 'تعليق' : 'Hold'}</button>
            <button onClick={() => { setCart([]); setTendered(''); }} style={{ ...S.btnGhost, flex: 1, padding: '12px', color: C.red }}>✕ {ARABIC ? 'إلغاء' : 'Clear'}</button>
          </div>
        )}
        </div>
      </div>

      {newProduct && (
        <ProductModal initial={newProduct} notify={notify}
          onClose={() => { setNewProduct(null); scanRef.current && scanRef.current.focus(); }}
          onSaved={(p) => { setProducts((prev) => [...prev, p]); addToCart(p); setNewProduct(null); scanRef.current && scanRef.current.focus(); }} />
      )}

      {showHeld && (
        <Overlay onClose={() => setShowHeld(false)}>
          <div style={{ ...S.card, width: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>⏸ {ARABIC ? 'الفواتير المعلّقة' : 'Held sales'}</div>
            {!held.length && <div style={{ color: C.dim }}>{ARABIC ? 'لا شيء' : 'None'}</div>}
            {held.map((h) => (
              <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px solid ${C.line}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{money(h.total)} <span style={{ color: C.dim, fontSize: 12 }}>· {h.items.length} {ARABIC ? 'صنف' : 'items'} · {h.ts}</span></div>
                </div>
                <button onClick={() => resumeSale(h)} style={{ ...S.btn, padding: '8px 14px' }}>{ARABIC ? 'استئناف' : 'Resume'}</button>
                <button onClick={() => persistHeld(held.filter((x) => x.id !== h.id))} style={{ ...S.btnGhost, padding: '8px 10px', color: C.red }}>×</button>
              </div>
            ))}
          </div>
        </Overlay>
      )}

      {editLine && (
        <LineEditModal line={editLine}
          onClose={() => setEditLine(null)}
          onApply={(qty, price) => { if (qty <= 0) removeLine(editLine.id); else setLine(editLine.id, { qty, price }); setEditLine(null); }}
          onRemove={() => { removeLine(editLine.id); setEditLine(null); }} />
      )}
      {quickItem && (
        <QuickItemModal notify={notify} onClose={() => setQuickItem(false)}
          onAdd={(it) => { addCustom(it); setQuickItem(false); }} />
      )}
      {weighItem && (
        <WeightModal product={weighItem} notify={notify}
          onClose={() => { setWeighItem(null); refocus(); }}
          onAdd={(kg) => { addToCart(weighItem, kg); setWeighItem(null); refocus(); }} />
      )}
      {receipt && <ReceiptModal sale={receipt} onClose={() => { setReceipt(null); refocus(); }} />}
    </div>
  );
}

// Post-payment popup: bill summary + "Print" or paperless "Done". The sale is already
// saved — this only decides whether paper comes out.
function ReceiptModal({ sale, onClose }) {
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 380, display: 'flex', flexDirection: 'column', gap: 0, padding: 0, overflow: 'hidden' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.green}, #2aa872)`, color: '#0f1117', padding: '16px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 34, lineHeight: 1 }}>✓</div>
          <div style={{ fontWeight: 800, fontSize: 19, marginTop: 4 }}>{ARABIC ? 'تم الدفع' : 'Payment complete'}</div>
          <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.75 }}>{ARABIC ? 'فاتورة' : 'Invoice'} #{sale.invoice_no} · {sale.date} {String(sale.time).slice(0, 5)}</div>
        </div>
        <div style={{ padding: '14px 20px', maxHeight: '38vh', overflow: 'auto' }}>
          {(sale.items || []).map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderBottom: `1px dashed ${C.line}`, fontSize: 14 }}>
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name} <span style={{ color: C.dim }}>× {l.qty}</span></span>
              <span style={{ flexShrink: 0, fontWeight: 700 }}>{money(l.price * l.qty)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, fontWeight: 800, fontSize: 19 }}>
            <span>{ARABIC ? 'المجموع' : 'Total'}</span><span style={{ color: C.accent }}>{money(sale.total)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 4, fontSize: 14, color: C.dim }}>
            <span>{sale.pay === 'cash' ? (ARABIC ? '💵 نقدي' : '💵 Cash') : (ARABIC ? '💳 بطاقة' : '💳 Card')}</span>
            {sale.change != null && sale.change >= 0 && <span style={{ color: C.green, fontWeight: 800 }}>{ARABIC ? 'الباقي' : 'Change'}: {money(sale.change)}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '0 20px 18px' }}>
          <button onClick={() => { printReceipt(sale); onClose(); }} style={{ ...S.btnGhost, flex: 1, padding: '16px', fontSize: 16, fontWeight: 800 }}>
            🖨 {ARABIC ? 'طباعة' : 'Print'}
          </button>
          <button onClick={onClose} autoFocus style={{ ...S.btn, flex: 1.4, padding: '16px', fontSize: 16, background: C.green }}>
            🌿 {ARABIC ? 'تم — بدون طباعة' : 'Done — no paper'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Weighed item: enter weight in kg on a keypad; line qty = weight, price = per-kg ──
function WeightModal({ product, onClose, onAdd, notify }) {
  const [kg, setKg] = useState('');
  const onKey = (ch) => setKg((v) => (ch === '.' && v.includes('.') ? v : v + ch));
  const w = Number(kg) || 0;
  const submit = () => { if (!(w > 0)) { notify(ARABIC ? 'أدخل الوزن' : 'Enter weight', 'red'); return; } onAdd(w); };
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>⚖ {product.name}</div>
        <div style={{ color: C.dim, fontSize: 13 }}>{money(product.price)}{ARABIC ? ' / كغ' : ' / kg'}</div>
        <div style={{ ...S.input, fontSize: 22, fontWeight: 800, textAlign: 'center' }}>{kg || '0'} {ARABIC ? 'كغ' : 'kg'}</div>
        <div style={{ textAlign: 'center', color: C.accent, fontWeight: 800, fontSize: 20 }}>= {money(w * (Number(product.price) || 0))}</div>
        <NumPad onKey={onKey} onClear={() => setKg('')} onBackspace={() => setKg((v) => v.slice(0, -1))} />
        <button onClick={submit} style={{ ...S.btn, padding: '14px', fontSize: 16 }}>{ARABIC ? 'إضافة للفاتورة' : 'Add to bill'}</button>
      </div>
    </Overlay>
  );
}
const qtyBtn = { width: 42, height: 42, borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 22, lineHeight: '1', cursor: 'pointer', fontWeight: 700 };

// ── Numeric keypad (touch) — drives a numeric string field ──────────────────────
function NumPad({ onKey, onClear, onBackspace }) {
  const k = (label, fn, extra = {}) => (
    <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={fn}
      style={{ height: 56, borderRadius: 10, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 22, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', ...extra }}>{label}</button>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => k(d, () => onKey(d)))}
      {k('.', () => onKey('.'))}
      {k('0', () => onKey('0'))}
      {k('⌫', onBackspace, { background: C.red, color: '#fff' })}
      {k('C', onClear, { gridColumn: '1 / -1', background: C.line })}
    </div>
  );
}

// ── Edit a cart line: set quantity + override price via keypad ───────────────────
function LineEditModal({ line, onClose, onApply, onRemove }) {
  const [field, setField] = useState('qty');
  const [qty, setQty] = useState(String(line.qty));
  const [price, setPrice] = useState(String(line.price));
  const set = field === 'qty' ? setQty : setPrice;
  const onKey = (ch) => set((v) => (ch === '.' && v.includes('.') ? v : (v === '0' && ch !== '.' ? ch : v + ch)));
  const tab = (name, label, val) => (
    <button type="button" onClick={() => setField(name)} style={{ flex: 1, padding: '12px', borderRadius: 8, border: `1px solid ${field === name ? C.accent : C.line}`, background: field === name ? C.accent : C.panel2, color: field === name ? C.accentText : C.text, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
      <div style={{ fontSize: 12 }}>{label}</div><div style={{ fontSize: 18 }}>{val || '0'}</div>
    </button>
  );
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{line.name}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab('qty', ARABIC ? 'الكمية' : 'Qty', qty)}
          {tab('price', ARABIC ? 'السعر' : 'Price', price)}
        </div>
        <NumPad onKey={onKey} onClear={() => set('')} onBackspace={() => set((v) => v.slice(0, -1))} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onApply(Number(qty) || 0, Number(price) || 0)} style={{ ...S.btn, flex: 1, padding: '14px', fontSize: 16 }}>{ARABIC ? 'حفظ' : 'Save'}</button>
          <button onClick={onRemove} style={{ ...S.btnGhost, padding: '14px', color: C.red }}>{ARABIC ? 'حذف' : 'Remove'}</button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Open-price "misc" item: type a name + price for something with no barcode ────
function QuickItemModal({ onClose, onAdd, notify }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const onKey = (ch) => setPrice((v) => (ch === '.' && v.includes('.') ? v : v + ch));
  const submit = () => {
    if (!name.trim()) { notify(ARABIC ? 'الاسم مطلوب' : 'Name required', 'red'); return; }
    if (!(Number(price) > 0)) { notify(ARABIC ? 'السعر مطلوب' : 'Price required', 'red'); return; }
    onAdd({ name: name.trim(), price: Number(price), qty: 1 });
  };
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{ARABIC ? 'صنف يدوي' : 'Quick item'}</div>
        <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={ARABIC ? 'الاسم' : 'Name'} autoFocus />
        <div style={{ ...S.input, fontSize: 20, fontWeight: 800, textAlign: 'center', color: C.accent }}>{price || '0'}</div>
        <NumPad onKey={onKey} onClear={() => setPrice('')} onBackspace={() => setPrice((v) => v.slice(0, -1))} />
        <button onClick={submit} style={{ ...S.btn, padding: '14px', fontSize: 16 }}>{ARABIC ? 'إضافة للفاتورة' : 'Add to bill'}</button>
      </div>
    </Overlay>
  );
}

// ── Add/Edit product modal (shared by Sales quick-add + Inventory) ──────────────
function ProductModal({ initial, onClose, onSaved, notify, editing }) {
  const [barcode, setBarcode] = useState(initial.barcode || '');
  const [name, setName] = useState(initial.name || '');
  const [price, setPrice] = useState(initial.price != null ? String(initial.price) : '');
  const [cat, setCat] = useState(initial.cat || '');
  const [stock, setStock] = useState(initial.stock != null ? String(initial.stock) : '');
  const [cost, setCost] = useState(initial.cost != null ? String(initial.cost) : '');
  const [unit, setUnit] = useState(initial.unit === 'kg' ? 'kg' : 'ea');
  const [cats, setCats] = useState([]);
  const [newCat, setNewCat] = useState(false);   // typing a category that doesn't exist yet
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    api.get('/settings/categories').then((r) => {
      try { setCats(r && r.value ? JSON.parse(r.value) : []); } catch (_) {}
    }).catch(() => {});
    nameRef.current && nameRef.current.focus();
  }, []);

  // The chips: the configured list, plus this product's own category if it predates the list.
  const catOptions = Array.from(new Set([...cats, ...(initial.cat ? [initial.cat] : [])]));

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) { notify(ARABIC ? 'الاسم مطلوب' : 'Name required', 'red'); return; }
    if (!cat.trim()) { notify(ARABIC ? 'اختر فئة للمنتج' : 'Pick a category for this product', 'red'); return; }
    setBusy(true);
    const body = { barcode: barcode.trim() || null, name: name.trim(), price: Number(price) || 0, cat: cat.trim(), cost: Number(cost) || 0, stock: Number(stock) || 0, unit };
    // A brand-new category is added to the shared list so it shows up as a chip everywhere.
    // Non-admins can't write settings — the product still saves with the category either way.
    if (!cats.includes(body.cat)) {
      try { await api.put('/settings/categories', { value: JSON.stringify([...cats, body.cat]) }); } catch (_) {}
    }
    try {
      if (editing) {
        await api.put('/products/' + initial.id, body);
        onSaved({ ...initial, ...body });
      } else {
        const p = await api.post('/products', body);
        onSaved(p);
      }
    } catch (ex) {
      notify(ex.message === 'exists' ? (ARABIC ? 'باركود مكرر' : 'Barcode already exists')
        : ex.message === 'admin_only' ? (ARABIC ? 'تعديل السعر يتطلب صلاحية مدير' : 'Price changes need an admin')
        : (ARABIC ? 'فشل الحفظ' : 'Save failed'), 'red');
    } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={save} style={{ ...S.card, width: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{editing ? (ARABIC ? 'تعديل منتج' : 'Edit product') : (ARABIC ? 'منتج جديد' : 'New product')}</div>
        <Field label={ARABIC ? 'الباركود' : 'Barcode'}><input style={S.input} value={barcode} onChange={(e) => setBarcode(e.target.value)} /></Field>
        <Field label={ARABIC ? 'الاسم' : 'Name'}><input ref={nameRef} style={S.input} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={ARABIC ? 'تباع بـ' : 'Sold by'}>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['ea', ARABIC ? 'بالقطعة' : 'Each'], ['kg', ARABIC ? 'بالوزن (كغ)' : 'Weight (kg)']].map(([v, lbl]) => (
              <button key={v} type="button" onClick={() => setUnit(v)} style={{ ...S.btnGhost, flex: 1, padding: '10px', ...(unit === v ? { background: C.blue, color: '#fff', borderColor: C.blue } : {}) }}>{lbl}</button>
            ))}
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label={unit === 'kg' ? (ARABIC ? 'السعر / كغ' : 'Price / kg') : (ARABIC ? 'السعر' : 'Price')}><input style={S.input} type="number" step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label={ARABIC ? 'الكمية' : 'Stock'}><input style={S.input} type="number" step="0.001" value={stock} onChange={(e) => setStock(e.target.value)} /></Field>
        </div>
        <Field label={ARABIC ? 'التكلفة' : 'Cost'}><input style={S.input} type="number" step="0.001" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>

        {/* Category is required — an uncategorised product is unreachable on the Sales
            screen now that it browses by shelf. Pick an existing one or name a new one. */}
        <Field label={ARABIC ? 'الفئة (مطلوبة)' : 'Category (required)'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            {catOptions.map((c) => {
              const on = !newCat && cat === c;
              return (
                <button key={c} type="button" onClick={() => { setNewCat(false); setCat(c); }} style={{
                  ...S.btnGhost, padding: '8px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 7,
                  ...(on ? { background: catColor(c), color: '#0f1117', borderColor: catColor(c), fontWeight: 800 } : {}),
                }}>
                  {!on && <span style={{ width: 8, height: 8, borderRadius: 4, background: catColor(c), display: 'inline-block' }} />}
                  {c}
                </button>
              );
            })}
            <button type="button" onClick={() => { setNewCat(true); setCat(''); }} style={{
              ...S.btnGhost, padding: '8px 12px', fontSize: 13, borderStyle: 'dashed',
              ...(newCat ? { borderColor: C.accent, color: C.accent, fontWeight: 800 } : {}),
            }}>＋ {ARABIC ? 'فئة جديدة' : 'New category'}</button>
          </div>
          {newCat && (
            <input style={{ ...S.input, marginTop: 8 }} autoFocus value={cat} onChange={(e) => setCat(e.target.value)}
              placeholder={ARABIC ? 'اسم الفئة الجديدة' : 'New category name'} />
          )}
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="submit" disabled={busy} style={{ ...S.btn, flex: 1, opacity: busy ? 0.6 : 1 }}>{ARABIC ? 'حفظ' : 'Save'}</button>
          <button type="button" onClick={onClose} style={S.btnGhost}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </form>
    </Overlay>
  );
}
function Field({ label, children }) {
  return <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: C.dim, fontWeight: 700 }}>{label}{children}</label>;
}
function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV catalogue import (admin) — pick file → preview → confirm
// ══════════════════════════════════════════════════════════════════════════════
// The client never posts a file: src/csv.js parses and validates in the browser, the user
// sees exactly which lines are wrong, and only the valid rows are sent as JSON. The server
// re-validates everything and imports in one transaction.
function ImportModal({ onClose, onImported, notify }) {
  const [parsed, setParsed] = useState(null);     // { items, errors, error }
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState('upsert');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    try {
      setParsed(parseProductCsv(await file.text()));
    } catch (_) {
      setParsed({ items: [], errors: [], error: 'unreadable_file' });
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([importTemplateCsv()], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'catalogue_template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // File-level failures get a plain sentence; the raw code is useless to a shopkeeper.
  const fileError = (code) => {
    if (!code) return null;
    if (code === 'empty_file') return ARABIC ? 'الملف فارغ' : 'That file is empty';
    if (code === 'unreadable_file') return ARABIC ? 'تعذّر قراءة الملف' : 'That file could not be read';
    if (code.startsWith('missing_column:')) {
      const cols = code.split(':')[1];
      return ARABIC ? `عمود مفقود: ${cols}` : `Missing required column: ${cols}`;
    }
    if (code.startsWith('too_many_rows:')) {
      return ARABIC ? `صفوف أكثر من الحد (${MAX_IMPORT_ROWS})` : `Too many rows — the limit is ${MAX_IMPORT_ROWS}`;
    }
    return ARABIC ? 'ملف غير صالح' : 'Invalid file';
  };

  const run = async () => {
    if (!parsed || !parsed.items.length) return;
    setBusy(true);
    try {
      // `line` is a UI-only field for error reporting — strip it before sending.
      const items = parsed.items.map(({ line, ...rest }) => rest);
      const r = await api.post('/products/import', { items, mode });
      notify(ARABIC
        ? `تم الاستيراد: ${r.created} جديد، ${r.updated} محدّث`
        : `Imported ${r.created} new, ${r.updated} updated`, 'green');
      onImported();
    } catch (ex) {
      notify(ex.message === 'not_admin' ? (ARABIC ? 'الاستيراد يتطلب صلاحية مدير' : 'Import needs an admin')
        : ex.message === 'exists' ? (ARABIC ? 'باركود مكرر في الملف' : 'A barcode in this file already exists')
        : ex.message === 'too_many_rows' ? (ARABIC ? 'عدد الصفوف كبير جداً' : 'Too many rows')
        : (ARABIC ? 'فشل الاستيراد — لم يتغيّر شيء' : 'Import failed — nothing was changed'), 'red');
    } finally { setBusy(false); }
  };

  const err = parsed && fileError(parsed.error);

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div style={{ ...S.card, width: 460, maxWidth: '92vw', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{ARABIC ? 'استيراد كتالوج (CSV)' : 'Import catalogue (CSV)'}</div>

        <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.5 }}>
          {ARABIC
            ? 'الأعمدة: barcode, name, price, cost, stock, cat, unit, active — الاسم فقط إلزامي.'
            : 'Columns: barcode, name, price, cost, stock, cat, unit, active — only name is required.'}
          {' '}
          <button type="button" onClick={downloadTemplate}
            style={{ background: 'none', border: 'none', padding: 0, color: C.accent, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, textDecoration: 'underline' }}>
            {ARABIC ? 'تنزيل نموذج' : 'Download template'}
          </button>
        </div>

        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={pick} style={{ display: 'none' }} />
        <button type="button" onClick={() => fileRef.current && fileRef.current.click()} style={{ ...S.btnGhost, padding: '14px', borderStyle: 'dashed' }}>
          {fileName || (ARABIC ? '📁 اختر ملف CSV' : '📁 Choose a CSV file')}
        </button>

        {err && (
          <div style={{ ...S.card, background: 'transparent', borderColor: C.red, color: C.red, fontSize: 13, padding: 12 }}>{err}</div>
        )}

        {parsed && !parsed.error && (
          <>
            <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
              <span style={{ color: C.green, fontWeight: 800 }}>
                {parsed.items.length} {ARABIC ? 'صف صالح' : 'valid'}
              </span>
              {parsed.errors.length > 0 && (
                <span style={{ color: C.red, fontWeight: 800 }}>
                  {parsed.errors.length} {ARABIC ? 'صف به خطأ (سيتم تجاهله)' : 'with errors (skipped)'}
                </span>
              )}
            </div>

            {parsed.errors.length > 0 && (
              <div style={{ maxHeight: 130, overflowY: 'auto', fontSize: 12, color: C.dim, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {parsed.errors.slice(0, 50).map((e) => (
                  <div key={e.line}><b style={{ color: C.red }}>{ARABIC ? 'سطر' : 'Line'} {e.line}</b> — {e.message}</div>
                ))}
                {parsed.errors.length > 50 && <div>… {parsed.errors.length - 50} {ARABIC ? 'أخرى' : 'more'}</div>}
              </div>
            )}

            <Field label={ARABIC ? 'الصفوف ذات الباركود الموجود' : 'Rows whose barcode already exists'}>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['upsert', ARABIC ? 'تحديث' : 'Update them'], ['insert', ARABIC ? 'رفض الملف' : 'Reject the file']].map(([v, lbl]) => (
                  <button key={v} type="button" onClick={() => setMode(v)} style={{ ...S.btnGhost, flex: 1, padding: '10px', ...(mode === v ? { background: C.blue, color: '#fff', borderColor: C.blue } : {}) }}>{lbl}</button>
                ))}
              </div>
            </Field>

            {/* Overwriting prices across the whole catalogue is the point of this screen,
                so say it out loud before the button is pressed. */}
            {mode === 'upsert' && parsed.items.length > 0 && (
              <div style={{ fontSize: 12, color: C.dim }}>
                {ARABIC
                  ? 'سيتم استبدال السعر والتكلفة والمخزون للمنتجات المطابقة.'
                  : 'Price, cost and stock will be overwritten for matching products.'}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={run} disabled={busy || !parsed || !!parsed.error || !parsed.items.length}
            style={{ ...S.btn, flex: 1, opacity: (busy || !parsed || !!parsed.error || !parsed.items.length) ? 0.5 : 1 }}>
            {busy ? (ARABIC ? 'جارٍ الاستيراد…' : 'Importing…')
              : parsed && parsed.items.length ? (ARABIC ? `استيراد ${parsed.items.length}` : `Import ${parsed.items.length}`)
              : (ARABIC ? 'استيراد' : 'Import')}
          </button>
          <button type="button" onClick={onClose} disabled={busy} style={S.btnGhost}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </div>
    </Overlay>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Inventory
// ══════════════════════════════════════════════════════════════════════════════
function InventoryView({ isAdmin, notify }) {
  const [products, setProducts] = useState([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(null);          // null = category grid; else the shelf you're in
  const [editing, setEditing] = useState(null);  // product or {cat} for new
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => api.get('/products').then(setProducts).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const remove = async (p) => {
    if (!window.confirm((ARABIC ? 'حذف ' : 'Delete ') + p.name + '?')) return;
    try { await api.del('/products/' + p.id); setProducts((prev) => prev.filter((x) => x.id !== p.id)); }
    catch (ex) { notify(ARABIC ? 'فشل الحذف' : 'Delete failed', 'red'); }
  };

  // Same two-step browse as Sales: shelves first, then the rows on that shelf.
  // Searching cuts across every category. A new product is created straight into the
  // category you're standing in.
  const searching = q.trim().length > 0;
  const browsing = !searching && cat === null;
  const catCards = categoryCards(products);
  const rows = products.filter((p) => {
    if (searching) {
      const s = q.trim().toLowerCase();
      return (p.name || '').toLowerCase().includes(s) || (p.barcode || '').includes(q.trim());
    }
    if (cat === null) return false;
    return inCat(p, cat);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input style={{ ...S.input, flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={ARABIC ? 'بحث عن منتج' : 'Search products'} />
        {/* Bulk import is admin-only for the same reason pricing is: it rewrites prices
            across the whole catalogue in one action. */}
        {isAdmin && <button onClick={() => setImporting(true)} style={S.btnGhost}>{ARABIC ? '⬆ استيراد CSV' : '⬆ Import CSV'}</button>}
        <button onClick={() => setEditing({ cat: cat && cat !== ALL_CAT ? cat : '' })} style={S.btn}>{ARABIC ? '+ منتج' : '+ Product'}</button>
      </div>

      {!browsing && (
        <CategoryHeader
          title={searching ? (ARABIC ? 'نتائج البحث' : 'Search results') : catTitle(cat)}
          count={rows.length}
          onBack={searching ? null : () => setCat(null)} />
      )}

      {browsing ? (
        <CategoryGrid cards={catCards} total={products.length} onPick={setCat}
          emptyHint={ARABIC ? 'لا منتجات بعد — اضغط + منتج' : 'No products yet — tap + Product'} />
      ) : (
      <div style={S.card}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ color: C.dim, textAlign: ARABIC ? 'right' : 'left' }}>
            <th style={th}>{ARABIC ? 'الاسم' : 'Name'}</th><th style={th}>{ARABIC ? 'الباركود' : 'Barcode'}</th>
            <th style={th}>{ARABIC ? 'الفئة' : 'Category'}</th><th style={{ ...th, textAlign: 'right' }}>{ARABIC ? 'السعر' : 'Price'}</th>
            <th style={{ ...th, textAlign: 'right' }}>{ARABIC ? 'المخزون' : 'Stock'}</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={td}>{p.name}</td>
                <td style={{ ...td, color: C.dim, fontFamily: 'monospace' }}>{p.barcode || '—'}</td>
                <td style={{ ...td, color: C.dim }}>{p.cat || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{money(p.price)}</td>
                <td style={{ ...td, textAlign: 'right', color: Number(p.stock) <= 5 ? C.red : C.text }}>{Number(p.stock)}</td>
                <td style={{ ...td, textAlign: 'end', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setEditing(p)} style={S.btnRow}>{ARABIC ? 'تعديل' : 'Edit'}</button>
                  {isAdmin && <button onClick={() => remove(p)} style={{ ...S.btnRow, color: C.red, marginInlineStart: 8 }}>{ARABIC ? 'حذف' : 'Del'}</button>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} style={{ ...td, color: C.dim, textAlign: 'center', padding: 24 }}>{searching ? (ARABIC ? 'لا نتائج مطابقة' : 'Nothing matches that search') : (ARABIC ? 'لا منتجات في هذه الفئة' : 'No products in this category')}</td></tr>}
          </tbody>
        </table>
      </div>
      )}
      {editing && (
        <ProductModal initial={editing} editing={!!editing.id} notify={notify}
          onClose={() => setEditing(null)}
          onSaved={(p) => { setProducts((prev) => { const i = prev.findIndex((x) => x.id === p.id); return i >= 0 ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]; }); setEditing(null); }} />
      )}
      {importing && (
        <ImportModal notify={notify}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); load(); }} />
      )}
    </div>
  );
}
const th = { padding: '6px 8px', fontWeight: 700, fontSize: 12 };
const td = { padding: '8px' };

// ══════════════════════════════════════════════════════════════════════════════
// Receive — restock with supplier + expiry (creates a batch, bumps stock)
// ══════════════════════════════════════════════════════════════════════════════
function ReceiveView({ isAdmin, notify }) {
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [batches, setBatches] = useState([]);
  const [form, setForm] = useState({ product_id: '', supplier_id: '', qty: '', cost: '', expiry: '' });
  const [newSup, setNewSup] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/products').then(setProducts).catch(() => {});
    api.get('/suppliers').then(setSuppliers).catch(() => {});
    api.get('/batches').then(setBatches).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const receive = async () => {
    if (!form.product_id || !(Number(form.qty) > 0)) { notify(ARABIC ? 'اختر المنتج والكمية' : 'Pick product + qty', 'red'); return; }
    setBusy(true);
    try {
      await api.post('/batches', { product_id: Number(form.product_id), supplier_id: form.supplier_id ? Number(form.supplier_id) : null, qty: Number(form.qty), cost: Number(form.cost) || 0, expiry: form.expiry || null });
      setForm({ product_id: '', supplier_id: '', qty: '', cost: '', expiry: '' });
      load();
      notify(ARABIC ? 'تم استلام البضاعة' : 'Stock received', 'green');
    } catch (_) { notify(ARABIC ? 'فشل' : 'Failed', 'red'); } finally { setBusy(false); }
  };
  const addSupplier = async () => {
    if (!newSup.name.trim()) return;
    try { await api.post('/suppliers', newSup); setNewSup({ name: '', phone: '' }); api.get('/suppliers').then(setSuppliers); notify(ARABIC ? 'تمت إضافة المورّد' : 'Supplier added', 'green'); }
    catch (_) { notify(ARABIC ? 'فشل' : 'Failed', 'red'); }
  };

  const sel = { ...S.input, appearance: 'auto' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
      <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>📥 {ARABIC ? 'استلام بضاعة' : 'Receive stock'}</div>
        <Field label={ARABIC ? 'المنتج' : 'Product'}>
          <select style={sel} value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
            <option value="">{ARABIC ? '— اختر —' : '— select —'}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={ARABIC ? 'المورّد' : 'Supplier'}>
          <select style={sel} value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">{ARABIC ? '— بدون —' : '— none —'}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label={ARABIC ? 'الكمية' : 'Quantity'}><input style={S.input} type="number" step="0.001" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
          <Field label={ARABIC ? 'التكلفة/وحدة' : 'Cost/unit'}><input style={S.input} type="number" step="0.001" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
        </div>
        <Field label={ARABIC ? 'تاريخ الانتهاء' : 'Expiry date'}><input style={S.input} type="date" value={form.expiry} onChange={(e) => setForm({ ...form, expiry: e.target.value })} /></Field>
        <button onClick={receive} disabled={busy} style={{ ...S.btn, padding: '14px', fontSize: 16, opacity: busy ? 0.6 : 1 }}>{ARABIC ? '＋ استلام وتحديث المخزون' : '＋ Receive & add to stock'}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>🏷 {ARABIC ? 'الموردون' : 'Suppliers'}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={S.input} value={newSup.name} onChange={(e) => setNewSup({ ...newSup, name: e.target.value })} placeholder={ARABIC ? 'اسم المورّد' : 'Supplier name'} />
            <input style={{ ...S.input, maxWidth: 130 }} value={newSup.phone} onChange={(e) => setNewSup({ ...newSup, phone: e.target.value })} placeholder={ARABIC ? 'هاتف' : 'Phone'} />
            <button onClick={addSupplier} style={S.btn}>＋</button>
          </div>
          {suppliers.map((s) => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${C.line}`, fontSize: 14 }}>
              <span>{s.name}</span><span style={{ color: C.dim }}>{s.phone || ''}</span>
            </div>
          ))}
          {!suppliers.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا موردين' : 'No suppliers'}</div>}
        </div>

        <div style={{ ...S.card }}>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>{ARABIC ? 'آخر الاستلامات' : 'Recent receipts'}</div>
          {batches.slice(0, 12).map((b) => (
            <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: `1px solid ${C.line}`, fontSize: 13 }}>
              <span>{b.product} <span style={{ color: C.dim }}>×{Number(b.qty)}</span></span>
              <span style={{ color: C.dim }}>{b.supplier || '—'}{b.expiry ? ' · ⌛' + b.expiry : ''}</span>
            </div>
          ))}
          {!batches.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا شيء بعد' : 'Nothing yet'}</div>}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// History
// ══════════════════════════════════════════════════════════════════════════════
// "2026-08-08" → "Sat 8 Aug 2026" / "السبت ٨ أغسطس ٢٠٢٦". Day-name first: when someone is
// hunting a receipt they remember the day of the week, not the date.
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
function ReportsView({ notify }) {
  const today = new Date().toISOString().slice(0, 10);
  const [tab, setTab] = useState('today');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [sum, setSum] = useState(null);
  const [top, setTop] = useState([]);
  const [low, setLow] = useState([]);
  const [exp, setExp] = useState([]);
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
    api.get('/expiry?days=30').then(setExp).catch(() => {});
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
                <span style={{ background: abcBadge(x.class), color: '#0f1117', borderRadius: 6, fontWeight: 800, fontSize: 11, padding: '2px 8px' }}>{x.class}</span>
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 8, color: C.red }}>⚠ {ARABIC ? 'مخزون منخفض' : 'Low stock'} ({low.length})</div>
              {low.map((p) => (
                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                  <span>{p.name}</span><span style={{ color: Number(p.stock) <= 0 ? C.red : C.accent, fontWeight: 700 }}>{Number(p.stock)}</span>
                </div>
              ))}
              {!low.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'كل المخزون جيد' : 'All stocked'}</div>}
            </div>
            <div style={S.card}>
              <div style={{ fontWeight: 800, marginBottom: 8, color: C.accent }}>⌛ {ARABIC ? 'قرب الانتهاء (٣٠ يوم)' : 'Expiring soon (30d)'} ({exp.length})</div>
              {exp.map((e) => {
                const dl = Number(e.days_left);
                const col = dl < 0 ? C.red : dl <= 7 ? C.accent : C.dim;
                return (
                  <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.line}`, fontSize: 14 }}>
                    <span>{e.product} {e.supplier ? <span style={{ color: C.dim, fontSize: 12 }}>· {e.supplier}</span> : null}</span>
                    <span style={{ color: col, fontWeight: 700 }}>{e.expiry} ({dl < 0 ? (ARABIC ? 'منتهي' : 'expired') : dl + (ARABIC ? ' يوم' : 'd')})</span>
                  </div>
                );
              })}
              {!exp.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا شيء قريب الانتهاء' : 'Nothing expiring soon'}</div>}
            </div>
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
function Donut({ slices, size = 170 }) {
  const total = slices.reduce((s, x) => s + (Number(x.value) || 0), 0);
  if (!(total > 0)) return <div style={{ color: C.dim, fontSize: 13 }}>—</div>;
  const R = 60, CX = 75, CY = 75, W = 26;
  let angle = -Math.PI / 2;
  const arcs = slices.filter((s) => Number(s.value) > 0).map((s) => {
    const frac = Number(s.value) / total;
    const a0 = angle, a1 = angle + frac * 2 * Math.PI;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a) => `${CX + R * Math.cos(a)} ${CY + R * Math.sin(a)}`;
    // Full-circle arcs collapse in SVG; nudge the end a hair.
    const end = frac >= 0.999 ? a1 - 0.001 : a1;
    return { ...s, frac, d: `M ${p(a0)} A ${R} ${R} 0 ${large} 1 ${p(end)}` };
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox="0 0 150 150">
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={W} strokeLinecap="butt">
            <title>{`${a.label}: ${money(a.value)} (${Math.round(a.frac * 100)}%)`}</title>
          </path>
        ))}
        <text x={CX} y={CY - 4} textAnchor="middle" fill={C.text} fontSize="15" fontWeight="800">{total.toFixed(2)}</text>
        <text x={CX} y={CY + 14} textAnchor="middle" fill={C.dim} fontSize="9">{CURRENCY}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {arcs.sort((a, b) => b.frac - a.frac).map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: a.color, flexShrink: 0 }} />
            <span style={{ color: C.text }}>{a.label}</span>
            <span style={{ color: C.dim }}>{Math.round(a.frac * 100)}% · {money(a.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Smooth spline (Catmull-Rom → cubic bezier) with filled area. points: [{label, value}].
function Spline({ points, color = C.green, height = 150 }) {
  if (points.length < 2) return <div style={{ color: C.dim, fontSize: 13 }}>{points.length ? '—' : '—'}</div>;
  const W = 600, H = 130, PAD = 8;
  const max = Math.max(...points.map((p) => Number(p.value) || 0), 0.001);
  const xy = points.map((p, i) => [
    PAD + (i / (points.length - 1)) * (W - 2 * PAD),
    H - PAD - ((Number(p.value) || 0) / max) * (H - 2 * PAD),
  ]);
  let d = `M ${xy[0][0]} ${xy[0][1]}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  const area = `${d} L ${xy[xy.length - 1][0]} ${H} L ${xy[0][0]} ${H} Z`;
  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="splineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#splineFill)" />
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        {xy.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3.5" fill={color}>
            <title>{`${points[i].label}: ${money(points[i].value)}`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim }}>
        <span>{points[0].label}</span>
        {points.length > 2 && <span>{points[Math.floor(points.length / 2)].label}</span>}
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}

// Scatter plot. points: [{label, x, y, color?}] — hover a dot for details.
function Scatter({ points, xLabel, yLabel, height = 210 }) {
  if (!points.length) return <div style={{ color: C.dim, fontSize: 13 }}>—</div>;
  const W = 600, H = 190, PAD = 34;
  const maxX = Math.max(...points.map((p) => p.x), 0.001);
  const maxY = Math.max(...points.map((p) => p.y), 0.001);
  const sx = (v) => PAD + (v / maxX) * (W - PAD - 12);
  const sy = (v) => H - PAD + 10 - (v / maxY) * (H - PAD - 6);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={PAD} y1={sy(maxY * f)} x2={W - 8} y2={sy(maxY * f)} stroke={C.line} strokeWidth="1" strokeDasharray="4 4" />
      ))}
      <line x1={PAD} y1={sy(0)} x2={W - 8} y2={sy(0)} stroke={C.line} strokeWidth="1.5" />
      <line x1={PAD} y1={sy(0)} x2={PAD} y2={sy(maxY)} stroke={C.line} strokeWidth="1.5" />
      <text x={W - 10} y={sy(0) + 16} textAnchor="end" fill={C.dim} fontSize="10">{xLabel}</text>
      <text x={PAD - 4} y={sy(maxY) - 6} textAnchor="start" fill={C.dim} fontSize="10">{yLabel}</text>
      {points.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="5.5" fill={p.color || C.blue} fillOpacity="0.75" stroke={p.color || C.blue}>
          <title>{`${p.label}\n${xLabel}: ${p.x}\n${yLabel}: ${Number(p.y).toFixed(3)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Minimal CSS bar chart — no chart library (bundle stays tiny). data: [{label, value}].
function Bars({ data, color = C.accent, height = 130, fmt = (v) => v }) {
  const max = Math.max(...data.map((d) => Number(d.value) || 0), 0.001);
  if (!data.length) return <div style={{ color: C.dim, fontSize: 13 }}>—</div>;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height }}>
      {data.map((d, i) => (
        <div key={i} title={`${d.label}: ${fmt(d.value)}`} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
          <div style={{ width: '100%', height: `${Math.max(2, (Number(d.value) / max) * 82)}%`, background: Number(d.value) > 0 ? color : C.line, borderRadius: '4px 4px 0 0', transition: 'height .25s' }} />
          <span style={{ fontSize: 10, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%' }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}
function Stat({ label, value, accent }) {
  return (
    <div style={S.card}>
      <div style={{ color: C.dim, fontSize: 12, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4, color: accent ? C.accent : C.text }}>{value}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Settings — change password, (admin) users + categories
// ══════════════════════════════════════════════════════════════════════════════
function SettingsView({ user, isAdmin, notify }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      {isAdmin && <Categories notify={notify} />}
      {isAdmin && <Users me={user} notify={notify} />}
      {!isAdmin && (
        <div style={{ ...S.card, color: C.dim, fontSize: 14 }}>
          🔑 {ARABIC ? 'لتغيير كلمة المرور اضغط زر "كلمة المرور" في الشريط الجانبي.' : 'To change your password, use the "Password" button in the sidebar.'}
        </div>
      )}
    </div>
  );
}

// Change-password popup — opened from the sidebar session area.
function ChangePasswordModal({ onClose, notify }) {
  const [oldPw, setOld] = useState(''); const [newPw, setNew] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (newPw.length < 8) { notify(ARABIC ? 'كلمة المرور 8 أحرف على الأقل' : 'Password must be 8+ chars', 'red'); return; }
    if (newPw !== confirm) { notify(ARABIC ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match', 'red'); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { old: oldPw, new: newPw });
      notify(ARABIC ? 'تم تغيير كلمة المرور' : 'Password changed', 'green');
      onClose();
    } catch (ex) {
      notify(ex.message === 'wrong_old' ? (ARABIC ? 'كلمة المرور الحالية خاطئة' : 'Current password wrong') : (ARABIC ? 'فشل' : 'Failed'), 'red');
    } finally { setBusy(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form onSubmit={submit} style={{ ...S.card, width: 340, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>🔑 {ARABIC ? 'تغيير كلمة المرور' : 'Change password'}</div>
        <input style={S.input} type="password" value={oldPw} onChange={(e) => setOld(e.target.value)} placeholder={ARABIC ? 'كلمة المرور الحالية' : 'Current password'} autoFocus />
        <input style={S.input} type="password" value={newPw} onChange={(e) => setNew(e.target.value)} placeholder={ARABIC ? 'كلمة مرور جديدة (8+)' : 'New password (8+)'} />
        <input style={S.input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={ARABIC ? 'تأكيد كلمة المرور' : 'Confirm new password'} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...S.btn, flex: 1, padding: '13px', opacity: busy ? 0.6 : 1 }}>{ARABIC ? 'حفظ' : 'Save'}</button>
          <button type="button" onClick={onClose} style={{ ...S.btnGhost, padding: '13px' }}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </form>
    </Overlay>
  );
}

// Categories — chip manager: colored chips (same color identity as tiles), tap ✕ to
// remove, type + add. Saves immediately on every change.
function Categories({ notify }) {
  const [cats, setCats] = useState([]);
  const [input, setInput] = useState('');
  useEffect(() => {
    api.get('/settings/categories').then((r) => {
      try { setCats(r && r.value ? JSON.parse(r.value) : []); } catch (_) { setCats([]); }
    }).catch(() => {});
  }, []);

  const persist = async (list) => {
    setCats(list);
    try { await api.put('/settings/categories', { value: JSON.stringify(list) }); }
    catch (_) { notify(ARABIC ? 'فشل الحفظ' : 'Save failed', 'red'); }
  };
  const add = () => {
    const name = input.trim();
    if (!name) return;
    if (cats.some((c) => c.toLowerCase() === name.toLowerCase())) { notify(ARABIC ? 'الفئة موجودة' : 'Category exists', 'red'); return; }
    persist([...cats, name]); setInput('');
  };
  const remove = (name) => {
    if (!window.confirm((ARABIC ? 'حذف الفئة ' : 'Remove category ') + name + '?')) return;
    persist(cats.filter((c) => c !== name));
  };

  return (
    <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>🏷 {ARABIC ? 'فئات المنتجات' : 'Product categories'}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {cats.map((c) => (
          <span key={c} className="rise" style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 8px 9px 14px',
            background: catColor(c, 0.14), border: `1px solid ${catColor(c, 0.55)}`, borderRadius: 20, fontSize: 14, fontWeight: 700,
          }}>
            <span style={{ width: 10, height: 10, borderRadius: 5, background: catColor(c) }} />
            {c}
            <button onClick={() => remove(c)} title={ARABIC ? 'حذف' : 'Remove'} style={{
              width: 24, height: 24, borderRadius: 12, border: 'none', background: 'rgba(255,255,255,.08)',
              color: C.dim, cursor: 'pointer', fontSize: 13, lineHeight: 1, fontFamily: 'inherit',
            }}>✕</button>
          </span>
        ))}
        {!cats.length && <span style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا فئات بعد — أضف أول فئة' : 'No categories yet — add the first one'}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...S.input, flex: 1 }} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder={ARABIC ? 'اسم فئة جديدة…' : 'New category name…'} />
        <button onClick={add} style={{ ...S.btn, padding: '10px 22px' }}>＋ {ARABIC ? 'إضافة' : 'Add'}</button>
      </div>
      <div style={{ color: C.dim, fontSize: 12 }}>{ARABIC ? 'يُحفظ تلقائياً · لون الفئة يظهر على بطاقات المنتجات' : 'Saves automatically · the color follows the category onto product tiles'}</div>
    </div>
  );
}

// ── Role-based user management (admin) ─────────────────────────────────────────
// Admin can add / edit (name, username, role, per-view access, wage) / reset password /
// enable-disable / delete. `allowed_views` is enforced server-side per request.
const VIEW_OPTS = ['inventory', 'receive', 'history', 'reports'];

function Users({ me, notify }) {
  const [users, setUsers] = useState([]);
  const [editing, setEditing] = useState(null);    // user object | 'new'
  const [resetting, setResetting] = useState(null); // user object
  const load = useCallback(() => api.get('/users').then(setUsers).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const del = async (u) => {
    if (!window.confirm((ARABIC ? 'حذف ' : 'Delete ') + u.username + '?')) return;
    try { await api.del('/users/' + u.id); load(); } catch (_) { notify(ARABIC ? 'فشل' : 'Failed', 'red'); }
  };

  return (
    <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>👥 {ARABIC ? 'المستخدمون والصلاحيات' : 'Users & permissions'}</div>
        <button onClick={() => setEditing('new')} style={S.btn}>＋ {ARABIC ? 'مستخدم' : 'User'}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {users.map((u) => (
          <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: `1px solid ${C.line}`, opacity: u.active === false ? 0.45 : 1 }}>
            <span style={{
              width: 40, height: 40, borderRadius: 20, background: u.role === 'admin' ? C.accent : C.panel2,
              color: u.role === 'admin' ? C.accentText : C.text, display: 'inline-flex', alignItems: 'center',
              justifyContent: 'center', fontWeight: 800, fontSize: 16, flexShrink: 0, border: `1px solid ${C.line}`,
            }}>{(u.full_name || u.username || '?').slice(0, 1).toUpperCase()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700 }}>
                {u.full_name || u.username}
                <span style={{
                  marginInlineStart: 8, fontSize: 11, fontWeight: 800, borderRadius: 6, padding: '2px 8px',
                  background: u.role === 'admin' ? C.accent : C.blue, color: u.role === 'admin' ? C.accentText : '#fff',
                }}>{u.role === 'admin' ? (ARABIC ? 'مدير' : 'ADMIN') : (ARABIC ? 'موظف' : 'STAFF')}</span>
                {u.active === false && <span style={{ marginInlineStart: 6, fontSize: 11, color: C.red, fontWeight: 700 }}>{ARABIC ? 'موقوف' : 'disabled'}</span>}
              </div>
              <div style={{ color: C.dim, fontSize: 12, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                @{u.username}
                {u.role !== 'admin' && ' · ' + (ARABIC ? 'يرى: ' : 'sees: ') + ['sales', ...(u.allowed_views || [])].map((v) => VIEW_LABELS[v] || v).join('، ')}
                {Number(u.wage) > 0 ? ' · ' + money(u.wage) + (ARABIC ? '/ساعة' : '/h') : ''}
              </div>
            </div>
            <button onClick={() => setEditing(u)} style={{ ...S.btnGhost, padding: '8px 12px' }}>✎ {ARABIC ? 'تعديل' : 'Edit'}</button>
            <button onClick={() => setResetting(u)} style={{ ...S.btnGhost, padding: '8px 12px' }}>🔑</button>
            {u.id !== me.id && <button onClick={() => del(u)} style={{ ...S.btnGhost, padding: '8px 12px', color: C.red }}>🗑</button>}
          </div>
        ))}
      </div>

      {editing && (
        <UserModal user={editing === 'new' ? null : editing} me={me} notify={notify}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {resetting && (
        <ResetPasswordModal user={resetting} notify={notify} onClose={() => setResetting(null)} />
      )}
    </div>
  );
}

// Create/edit one user: name, username, role, per-view permissions, wage, active.
function UserModal({ user, me, onClose, onSaved, notify }) {
  const isNew = !user;
  const [form, setForm] = useState(() => ({
    full_name: (user && user.full_name) || '',
    username: (user && user.username) || '',
    password: '',
    role: (user && user.role) || 'user',
    views: (user && user.allowed_views) || [],
    wage: user && Number(user.wage) > 0 ? String(user.wage) : '',
    active: user ? user.active !== false : true,
  }));
  const [busy, setBusy] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const toggleView = (v) => set({ views: form.views.includes(v) ? form.views.filter((x) => x !== v) : [...form.views, v] });
  const isSelf = user && me && user.id === me.id;

  const submit = async () => {
    if (!form.username.trim()) { notify(ARABIC ? 'اسم المستخدم مطلوب' : 'Username required', 'red'); return; }
    if (isNew && form.password.length < 8) { notify(ARABIC ? 'كلمة المرور 8 أحرف على الأقل' : 'Password 8+ chars', 'red'); return; }
    setBusy(true);
    try {
      const payload = {
        username: form.username.trim(), role: form.role,
        views: form.role === 'admin' ? [] : form.views,
        full_name: form.full_name.trim() || null, wage: Number(form.wage) || 0,
      };
      if (isNew) await api.post('/users', { ...payload, password: form.password });
      else await api.put('/users/' + user.id, { ...payload, active: form.active });
      notify(isNew ? (ARABIC ? 'تمت الإضافة' : 'User added') : (ARABIC ? 'تم الحفظ' : 'Saved'), 'green');
      onSaved();
    } catch (ex) {
      notify(ex.message === 'exists' ? (ARABIC ? 'اسم مستخدم مكرر' : 'Username taken') : (ARABIC ? 'فشل' : 'Failed'), 'red');
    } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 400, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>{isNew ? (ARABIC ? '＋ مستخدم جديد' : '＋ New user') : `✎ ${user.full_name || user.username}`}</div>
        <input style={S.input} value={form.full_name} onChange={(e) => set({ full_name: e.target.value })} placeholder={ARABIC ? 'الاسم الكامل' : 'Full name'} autoFocus={isNew} />
        <input style={S.input} value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder={ARABIC ? 'اسم المستخدم' : 'Username'} autoCapitalize="off" />
        {isNew && <input style={S.input} type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} placeholder={ARABIC ? 'كلمة المرور (8+)' : 'Password (8+)'} />}
        <input style={S.input} type="number" step="0.01" value={form.wage} onChange={(e) => set({ wage: e.target.value })} placeholder={ARABIC ? 'أجر الساعة (اختياري)' : 'Hourly wage (optional)'} />

        <div style={{ color: C.dim, fontSize: 12, fontWeight: 700, marginTop: 2 }}>{ARABIC ? 'الدور' : 'Role'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['user', ARABIC ? '👤 موظف' : '👤 Staff'], ['admin', ARABIC ? '⭐ مدير' : '⭐ Admin']].map(([r, lbl]) => (
            <button key={r} onClick={() => !isSelf && set({ role: r })} disabled={isSelf}
              style={{ ...S.btnGhost, flex: 1, padding: '12px', ...(form.role === r ? { background: C.blue, color: '#fff', borderColor: C.blue, fontWeight: 800 } : {}), opacity: isSelf ? 0.5 : 1 }}>{lbl}</button>
          ))}
        </div>

        {form.role === 'user' && (
          <>
            <div style={{ color: C.dim, fontSize: 12, fontWeight: 700 }}>{ARABIC ? 'الشاشات المسموحة (البيع دائماً مسموح)' : 'Allowed views (Sales is always allowed)'}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {VIEW_OPTS.map((v) => {
                const on = form.views.includes(v);
                return (
                  <button key={v} onClick={() => toggleView(v)} style={{
                    ...S.btnGhost, padding: '12px', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-start',
                    ...(on ? { background: C.accent, color: C.accentText, borderColor: C.accent, fontWeight: 800 } : {}),
                  }}>
                    <span style={{ fontSize: 16 }}>{on ? '☑' : '☐'}</span> {VIEW_ICONS[v]} {VIEW_LABELS[v]}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {!isNew && !isSelf && (
          <button onClick={() => set({ active: !form.active })} style={{ ...S.btnGhost, padding: '11px', color: form.active ? C.red : C.green }}>
            {form.active ? (ARABIC ? '⛔ إيقاف الحساب' : '⛔ Disable account') : (ARABIC ? '✓ تفعيل الحساب' : '✓ Enable account')}
          </button>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={busy} style={{ ...S.btn, flex: 1, padding: '13px', opacity: busy ? 0.6 : 1 }}>{isNew ? (ARABIC ? 'إضافة' : 'Add') : (ARABIC ? 'حفظ' : 'Save')}</button>
          <button onClick={onClose} style={{ ...S.btnGhost, padding: '13px' }}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </div>
    </Overlay>
  );
}

// Admin resets a user's password (also kills their active session server-side).
function ResetPasswordModal({ user, onClose, notify }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pw.length < 8) { notify(ARABIC ? 'كلمة المرور 8 أحرف على الأقل' : 'Password 8+ chars', 'red'); return; }
    setBusy(true);
    try {
      await api.post('/users/' + user.id + '/reset-password', { new: pw });
      notify(ARABIC ? 'تم تغيير كلمة المرور' : 'Password reset', 'green');
      onClose();
    } catch (_) { notify(ARABIC ? 'فشل' : 'Failed', 'red'); } finally { setBusy(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 340, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>🔑 {ARABIC ? 'إعادة تعيين كلمة مرور' : 'Reset password'} — {user.full_name || user.username}</div>
        <input style={S.input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={ARABIC ? 'كلمة المرور الجديدة (8+)' : 'New password (8+)'} autoFocus />
        <div style={{ color: C.dim, fontSize: 12 }}>{ARABIC ? 'سيُسجَّل خروج المستخدم من جلسته الحالية.' : 'The user will be signed out of any active session.'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={submit} disabled={busy} style={{ ...S.btn, flex: 1, padding: '13px', opacity: busy ? 0.6 : 1 }}>{ARABIC ? 'تعيين' : 'Reset'}</button>
          <button onClick={onClose} style={{ ...S.btnGhost, padding: '13px' }}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </div>
    </Overlay>
  );
}
