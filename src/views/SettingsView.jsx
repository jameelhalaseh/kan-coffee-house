import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC, VIEWS, VIEW_LABELS } from '../client.config';
import { money, catColor } from '../lib';
import { Overlay } from '../components/ui';
import { VIEW_ICONS } from '../components/Sidebar';

function SettingsView({ user, isAdmin, notify }) {
  return (
    // marginInline:auto, and a wider measure. App.jsx already centres a 1180px column for
    // every non-Sales view, but this panel capped itself at 760 INSIDE that column with no
    // centring of its own — so it hugged the column's left edge and read as misaligned
    // against a large empty right margin. Centring it in the space it actually has, and
    // giving the category chips and the user rows more room to breathe.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 920, marginInline: 'auto', width: '100%' }}>
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

function Categories({ notify }) {
  const [cats, setCats] = useState([]);
  const [counts, setCounts] = useState({});   // category name → how many products use it
  const [input, setInput] = useState('');
  useEffect(() => {
    api.get('/settings/categories').then((r) => {
      try { setCats(r && r.value ? JSON.parse(r.value) : []); } catch (_) { setCats([]); }
    }).catch(() => {});
    // Product counts drive whether a category can be removed at all. Exact-match keys,
    // mirroring how the shelves group everywhere else in the app.
    api.get('/products').then((rows) => {
      const m = {};
      (rows || []).forEach((p) => { if (p.cat) m[p.cat] = (m[p.cat] || 0) + 1; });
      setCounts(m);
    }).catch(() => {});
  }, []);

  const persist = async (list) => {
    const before = cats;
    setCats(list);
    try { await api.put('/settings/categories', { value: JSON.stringify(list) }); }
    catch (ex) {
      // The server is the authority on this rule; roll the optimistic update back rather
      // than leave the screen showing a change that was refused.
      setCats(before);
      notify(ex.message === 'category_in_use'
        ? (ARABIC ? 'لا يمكن حذف فئة تحتوي على منتجات' : 'A category with products cannot be deleted')
        : (ARABIC ? 'فشل الحفظ' : 'Save failed'), 'red');
    }
  };
  const add = () => {
    const name = input.trim();
    if (!name) return;
    if (cats.some((c) => c.toLowerCase() === name.toLowerCase())) { notify(ARABIC ? 'الفئة موجودة' : 'Category exists', 'red'); return; }
    persist([...cats, name]); setInput('');
  };
  // Only an EMPTY category can be removed. The ✕ is not rendered at all on one that is in
  // use — a disabled-looking button still invites the click, and the person this guards
  // against is the one not reading the dialog. Emptying the shelf (reassign or delete its
  // products in Inventory) is the deliberate path, and then the ✕ appears on its own.
  const remove = (name) => {
    const n = counts[name] || 0;
    if (n > 0) return;
    if (!window.confirm((ARABIC ? 'حذف الفئة ' : 'Remove category ') + name + '?')) return;
    persist(cats.filter((c) => c !== name));
  };

  return (
    // Roomier than the default 16px card padding: this screen is a handful of panels on a
    // wide monitor, not a dense table, so the content was tight against its own border.
    <div style={{ ...S.card, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ fontWeight: 800, fontSize: 16 }}>🏷 {ARABIC ? 'فئات المنتجات' : 'Product categories'}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {cats.map((c) => {
          const used = counts[c] || 0;
          return (
            <span key={c} className="rise" title={used
              ? (ARABIC
                ? `${used} منتج في هذه الفئة — انقل أو احذف المنتجات أولاً لحذف الفئة`
                : `${used} product${used === 1 ? '' : 's'} in this category — move or delete them first to remove it`)
              : (ARABIC ? 'فئة فارغة' : 'Empty category')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: used ? '9px 14px' : '9px 8px 9px 14px',
                background: catColor(c, 0.14), border: `1px solid ${catColor(c, 0.55)}`, borderRadius: 20, fontSize: 14, fontWeight: 700,
              }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: catColor(c) }} />
              {c}
              {/* The count is the whole explanation for why the ✕ is missing, so it is
                  always shown rather than only on the locked ones. */}
              <span style={{ fontSize: 12, fontWeight: 700, color: C.dim }}>{used}</span>
              {used === 0 && (
                <button onClick={() => remove(c)} title={ARABIC ? 'حذف' : 'Remove'} style={{
                  width: 24, height: 24, borderRadius: 12, border: 'none', background: 'rgba(255,255,255,.08)',
                  color: C.dim, cursor: 'pointer', fontSize: 13, lineHeight: 1, fontFamily: 'inherit',
                }}>✕</button>
              )}
            </span>
          );
        })}
        {!cats.length && <span style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا فئات بعد — أضف أول فئة' : 'No categories yet — add the first one'}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input style={{ ...S.input, flex: 1 }} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder={ARABIC ? 'اسم فئة جديدة…' : 'New category name…'} />
        <button onClick={add} style={{ ...S.btn, padding: '10px 22px' }}>＋ {ARABIC ? 'إضافة' : 'Add'}</button>
      </div>
      <div style={{ color: C.dim, fontSize: 12 }}>{ARABIC
        ? 'يُحفظ تلقائياً · الرقم هو عدد المنتجات · لا يمكن حذف فئة تحتوي على منتجات'
        : 'Saves automatically · the number is the product count · a category with products cannot be deleted'}</div>
    </div>
  );
}

// ── Role-based user management (admin) ─────────────────────────────────────────
// Admin can add / edit (name, username, role, per-view access, wage) / reset password /
// enable-disable / delete. `allowed_views` is enforced server-side per request.
const VIEW_OPTS = ['inventory', 'receive', 'history', 'reports'];

// What this user will ACTUALLY see in the nav, in nav order, without repeats. Must track
// the `allowed()` rules in App.jsx — a permissions summary that disagrees with the app is
// worse than none, because it is what the owner checks before handing over a till.
function effectiveViews(u) {
  const granted = new Set(['sales', ...(u.allowed_views || [])]);
  if (granted.has('inventory')) granted.add('receive');
  return VIEWS.filter((v) => v !== 'settings' && v !== 'assistant' && granted.has(v));
}

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
    <div style={{ ...S.card, padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                {/* Sales is implicit for everyone, so it is prepended — but it is also a
                    legal entry in allowed_views, and a user carrying it read "sees: Sales,
                    Sales, History". Dedupe, and mirror App.jsx's rule that the `inventory`
                    grant also opens Receive so the summary matches the actual nav. */}
                {u.role !== 'admin' && ' · ' + (ARABIC ? 'يرى: ' : 'sees: ') + effectiveViews(u).map((v) => VIEW_LABELS[v] || v).join(ARABIC ? '، ' : ', ')}
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

export default SettingsView;
export { SettingsView };
