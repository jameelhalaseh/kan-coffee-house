/* eslint-disable */
// Dukkan — single-store, barcode-driven liquor POS.
// Scan → cart → checkout. No floors, no recipes: a product catalogue plus a sales screen.
// Talks to the Express API via src/api.js (Bearer session token). The store key is fixed
// to DEFAULT_FLOOR ("main") wherever the generic orders/invoice API needs a store id.
//
// This file is the SHELL only: session bootstrap, the offline banner, view routing and the
// toast. Each screen lives in src/views/ and shared pieces in src/components/ — it was one
// 2,600-line file, which meant every change to any screen touched the same module.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from './api';
import { ARABIC, VIEWS } from './client.config';
import { C } from './theme';
import { TOKEN_KEY, USER_KEY } from './constants';
import { sessionAction, readCachedUser, SESSION_OFFLINE, SESSION_LOGOUT } from './session';

import Sidebar from './components/Sidebar';
import CustomerDisplay from './components/CustomerDisplay';
import ChangePasswordModal from './components/ChangePasswordModal';
import { Centered } from './components/ui';
import Toasts, { TOAST_MS, toastCap } from './components/Toasts';

import Login from './views/Login';
import SalesView from './views/SalesView';
import InventoryView from './views/InventoryView';
import ReceiveView from './views/ReceiveView';
import HistoryView from './views/HistoryView';
import ReportsView from './views/ReportsView';
import StoreReportsView from './views/StoreReportsView';
import SettingsView from './views/SettingsView';
import AssistantView from './AssistantView';

export default function App() {
  const isDisplay = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('display') === '1';
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState('sales');
  const [toasts, setToasts] = useState([]);
  const toastSeq = useRef(0);            // ids, so two identical messages are still two toasts
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [pwOpen, setPwOpen] = useState(false);   // change-password popup

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  // Messages STACK. Every call adds one; nothing replaces anything. A failure and a success
  // that land together are both readable, which is the whole point — the previous single-slot
  // toast silently dropped whichever arrived first.
  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback((msg, kind = 'info') => {
    const id = ++toastSeq.current;
    const ms = TOAST_MS[kind] || TOAST_MS.info;
    setToasts((list) => toastCap([...list, { id, msg, kind, ms }]));
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), ms);
  }, []);

  // Restore session on load from the persisted token.
  //
  // THE DISTINCTION THAT MATTERS: "the server says this session is dead" and "I cannot reach
  // the server" are not the same thing, and this used to treat them identically — any failure
  // cleared the token. So the moment the shop's internet dropped, a reload logged the cashier
  // out and dumped them on a login screen that could not reach the server either. The till
  // was dead for the whole outage, and the offline sales queue it carries never got a chance
  // to be used, because you have to be signed in to reach the sales screen at all.
  //
  // src/api.js sets err.status on any response the server actually sent; a fetch that never
  // completed throws without one. That is the discriminator:
  //   status present  → the server answered and rejected us. Really log out.
  //   status absent   → nobody answered. Keep the session and carry on offline.
  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY);
    if (!t) { setBooting(false); return; }
    api.setToken(t);
    let alive = true;
    api.get('/auth/validate')
      .then((u) => {
        if (!alive) return;
        setUser(u);
        // Cached so the branch below has an identity to restore. Written only after the
        // server has confirmed it, and never read while the server is reachable.
        try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch (_) {}
      })
      .catch((e) => {
        if (!alive) return;
        const cached = readCachedUser(localStorage.getItem(USER_KEY));
        const action = sessionAction(e, cached);

        if (action === SESSION_OFFLINE) {
          // Reopen the last confirmed session and let the till work.
          //
          // This grants nothing: the token is still the only credential, the API re-authorises
          // every request, and if the session HAS expired the first call that reaches the
          // server 401s and the normal expiry path signs them out. The worst case is a cashier
          // seeing their own shop's screens during an outage — while every sale they ring is
          // held in the offline queue, which is exactly what it is for.
          setUser(cached);
          notify(
            ARABIC ? 'لا يوجد اتصال — الوضع دون اتصال' : 'No connection — working offline',
            'info',
          );
          return;
        }

        if (action === SESSION_LOGOUT) {
          api.setToken(null);
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(USER_KEY);
        }
        // SESSION_LOGIN: nothing to restore — fall through to the login screen.
      })
      .finally(() => { if (alive) setBooting(false); });
    return () => { alive = false; };
  }, [notify]);

  // Blocking overlay when the session dies mid-use.
  useEffect(() => {
    api.setOnSessionExpired(() => {
      api.setToken(null);
      localStorage.removeItem(TOKEN_KEY);
      // The cached identity goes with it. Left behind, the next reload would reopen the
      // session this handler just closed — including the case where the token expired while
      // the till was offline and the server rejected it the moment it came back.
      localStorage.removeItem(USER_KEY);
      setUser(null);
      notify(ARABIC ? 'انتهت الجلسة، سجّل الدخول من جديد' : 'Session expired — please log in again', 'red');
    });
  }, [notify]);

  const handleLogin = (u) => {
    api.setToken(u.token);
    localStorage.setItem(TOKEN_KEY, u.token);
    try { localStorage.setItem(USER_KEY, JSON.stringify(u)); } catch (_) {}
    setUser(u);
    setView('sales');
  };
  const handleLogout = async () => {
    try { await api.post('/auth/logout'); } catch (_) {}
    api.setToken(null);
    localStorage.removeItem(TOKEN_KEY);
    // Deliberate sign-out clears the cache too, so the next reload cannot reopen it — a
    // cashier handing the till to the next shift must actually be signed out, offline or not.
    localStorage.removeItem(USER_KEY);
    setUser(null);
  };

  if (isDisplay) return <CustomerDisplay />;
  if (booting) return <Centered>{ARABIC ? 'جارٍ التحميل…' : 'Loading…'}</Centered>;
  // The login screen gets the stack too: "session expired" is raised at the moment the user is
  // sent back here, and with the toasts living only in the signed-in branch it was raised into
  // a component that had already unmounted — the message was never seen.
  if (!user) {
    return (
      <>
        <Login onLogin={handleLogin} />
        <Toasts items={toasts} onDismiss={dismiss} />
      </>
    );
  }

  const isAdmin = user.role === 'admin';
  const allowed = (v) => {
    if (v === 'assistant') return isAdmin;   // owner-only: inventory AI sees revenue + costs
    if (v === 'sales' || v === 'settings' || isAdmin) return true;
    const views = user.allowed_views || [];
    if (v === 'receive') return views.includes('inventory') || views.includes('receive');
    // Store Reports rides on the `reports` grant — the same one the server enforces for it.
    // Without this it would be admin-only, since no user carries a 'storereports' view key.
    if (v === 'storereports') return views.includes('reports');
    return views.includes(v);
  };
  const navViews = VIEWS.filter(allowed);

  return (
    <div dir="ltr" style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif", display: 'flex', alignItems: 'stretch' }}>
      {/* Nav rail first in DOM order, so it sits on the physical LEFT — the outer container
          is always dir="ltr" regardless of UI language, so order here is position. Keeping
          it before <main> also means keyboard focus reaches navigation before content. */}
      <Sidebar user={user} view={view} setView={setView} navViews={navViews} onLogout={handleLogout} canSeeStock={allowed('inventory') || allowed('reports')} onChangePassword={() => setPwOpen(true)} />
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
          {view === 'receive' && allowed('receive') && <ReceiveView notify={notify} />}
          {view === 'history' && allowed('history') && <HistoryView user={user} notify={notify} />}
          {view === 'reports' && allowed('reports') && <ReportsView notify={notify} />}
          {view === 'storereports' && allowed('storereports') && <StoreReportsView isAdmin={isAdmin} notify={notify} />}
          {view === 'assistant' && allowed('assistant') && <AssistantView notify={notify} />}
          {view === 'settings' && <SettingsView user={user} isAdmin={isAdmin} notify={notify} />}
        </div>
      </main>
      {pwOpen && <ChangePasswordModal notify={notify} onClose={() => setPwOpen(false)} />}
      <Toasts items={toasts} onDismiss={dismiss} />
    </div>
  );
}

