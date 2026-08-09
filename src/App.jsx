/* eslint-disable */
// Dukkan — single-store, barcode-driven liquor POS.
// Scan → cart → checkout. No floors, no recipes: a product catalogue plus a sales screen.
// Talks to the Express API via src/api.js (Bearer session token). The store key is fixed
// to DEFAULT_FLOOR ("main") wherever the generic orders/invoice API needs a store id.
//
// This file is the SHELL only: session bootstrap, the offline banner, view routing and the
// toast. Each screen lives in src/views/ and shared pieces in src/components/ — it was one
// 2,600-line file, which meant every change to any screen touched the same module.
import React, { useState, useEffect, useCallback } from 'react';
import api from './api';
import { ARABIC, VIEWS } from './client.config';
import { C } from './theme';
import { TOKEN_KEY } from './constants';

import Sidebar from './components/Sidebar';
import CustomerDisplay from './components/CustomerDisplay';
import ChangePasswordModal from './components/ChangePasswordModal';
import { Centered } from './components/ui';

import Login from './views/Login';
import SalesView from './views/SalesView';
import InventoryView from './views/InventoryView';
import ReceiveView from './views/ReceiveView';
import HistoryView from './views/HistoryView';
import ReportsView from './views/ReportsView';
import SettingsView from './views/SettingsView';
import AssistantView from './AssistantView';

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

