import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S, IS_DAY, toggleTheme } from '../theme';
import { ARABIC, STORE_NAME, VIEW_LABELS, toggleLang } from '../client.config';

const VIEW_ICONS = { sales: '🛒', inventory: '📦', receive: '📥', history: '🧾', reports: '📊', storereports: '📈', assistant: '🤖', settings: '⚙️' };

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

// Bell badge: low-stock count, with a dropdown list. (Expiry was the other half of this
// panel and was always empty in a liquor store — see migration 0007.)
function NotificationsBell() {
  const [low, setLow] = useState([]);
  const [open, setOpen] = useState(false);
  // The sidebar mounts once and lives for the whole shift, so a single fetch here meant the
  // badge froze at whatever it read at login: receive six bottles and it still claims they
  // are out of stock, sell the last one and it never says so. Refetch on mount AND every
  // time the panel is opened — opening it is exactly the moment the number has to be true.
  const refresh = useCallback(() => {
    api.get('/reports/low-stock?threshold=5').then(setLow).catch(() => {});
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const toggle = () => setOpen((o) => { if (!o) refresh(); return !o; });
  const count = low.length;
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={toggle}
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
        // clipped by the sidebar's own width + overflow-y:auto. Opens to the RIGHT of the
        // rail now that the rail is on the left (220px wide + 16px gap).
        <div className="rise" style={{ position: 'fixed', left: 236, bottom: 16, width: 320, maxHeight: '70vh', overflow: 'auto', background: C.panel, border: `1px solid ${C.line}`, borderRadius: 12, padding: 14, zIndex: 1000, boxShadow: C.shadow }}>
          <div style={{ fontWeight: 800, marginBottom: 6, color: C.red }}>{ARABIC ? 'مخزون منخفض' : 'Low stock'} ({low.length})</div>
          {low.slice(0, 8).map((p) => <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}><span>{p.name}</span><span style={{ color: C.red }}>{Number(p.stock)}</span></div>)}
          {!count &&<div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا تنبيهات' : 'All good'}</div>}
        </div>
      )}
    </div>
  );
}

// Vertical navigation rail, pinned to the right edge. Bigger touch targets.
function Sidebar({ user, view, setView, navViews, onLogout, canSeeStock, onChangePassword }) {
  return (
    <aside dir={ARABIC ? 'rtl' : 'ltr'} style={{
      // borderRight, not borderInlineEnd: the rail is pinned to the physical left of the
      // window in both languages (App.jsx keeps the outer container dir="ltr"), but this
      // element's own dir flips with the UI language — a logical property would jump the
      // divider to the outside edge in Arabic.
      width: 220, flex: '0 0 220px', background: C.panel, borderRight: `1px solid ${C.line}`,
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
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={toggleLang} style={{ ...S.btnGhost, flex: 1, height: 56, fontSize: 16 }}>{ARABIC ? '🌐 English' : '🌐 عربي'}</button>
          {/* Day/night. Reloads the page — see the note in src/theme.js: the palette is read
              at import time, so a reload is what makes every screen agree. */}
          <button onClick={toggleTheme} title={ARABIC ? 'المظهر' : 'Theme'}
            style={{ ...S.btnGhost, flex: '0 0 56px', height: 56, fontSize: 20 }}>
            {IS_DAY ? '🌙' : '☀️'}
          </button>
        </div>
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

export default Sidebar;
export { Sidebar, VIEW_ICONS };
