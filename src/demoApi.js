/* eslint-disable */
// In-browser MOCK API for the GitHub Pages preview (no backend/DB).
// Activated only when REACT_APP_DEMO === '1' (see src/api.js). Implements the same
// contract as the real api.js (get/post/put/patch/del + token helpers), backed by
// localStorage so data survives reloads. The real Heroku build never imports this.
//
// Demo logins (any password):  admin / admin   ·   cashier / cashier
const LS_KEY = 'dukkan_demo_db';
const DEMO_BANNER = true;
const isoIn = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

const seed = () => ({
  products: [
    { id: 1, barcode: '6281000011002', name: 'Laban 1L', price: 1.250, cat: 'Dairy', cost: 0.9, stock: 24, unit: 'ea', active: true },
    { id: 2, barcode: '6281000022003', name: 'Pita Bread', price: 0.400, cat: 'Bakery', cost: 0.25, stock: 60, unit: 'ea', active: true },
    { id: 3, barcode: '5449000000996', name: 'Cola 330ml', price: 0.500, cat: 'Drinks', cost: 0.3, stock: 4, unit: 'ea', active: true },
    { id: 4, barcode: '6281000033004', name: 'Potato Chips', price: 0.750, cat: 'Snacks', cost: 0.45, stock: 18, unit: 'ea', active: true },
    { id: 5, barcode: '6281000044005', name: 'Tomatoes (per kg)', price: 0.900, cat: 'Produce', cost: 0.6, stock: 30, unit: 'kg', active: true },
    { id: 6, barcode: '6281000055006', name: 'Dish Soap', price: 1.100, cat: 'Household', cost: 0.7, stock: 9, unit: 'ea', active: true },
  ],
  suppliers: [
    { id: 1, name: 'Amman Dairy Co.', phone: '06-555-1234', note: '', active: true },
    { id: 2, name: 'Fresh Farms', phone: '079-555-9876', note: '', active: true },
  ],
  batches: [
    { id: 1, product_id: 1, supplier_id: 1, qty: 24, cost: 0.9, expiry: isoIn(6), received_at: new Date().toISOString() },
    { id: 2, product_id: 5, supplier_id: 2, qty: 30, cost: 0.6, expiry: isoIn(2), received_at: new Date().toISOString() },
  ],
  nextSupplier: 3,
  nextBatch: 3,
  orders: [],
  users: [
    { id: 'u-admin', username: 'admin', role: 'admin', allowed_views: [], active: true, full_name: 'Store Owner', wage: 0 },
    { id: 'u-cashier', username: 'cashier', role: 'user', allowed_views: ['inventory', 'history'], active: true, full_name: 'Cashier One', wage: 2.5 },
  ],
  time_clock: [],
  nextPunch: 1,
  categories: ['Drinks', 'Snacks', 'Dairy', 'Produce', 'Bakery', 'Household', 'Frozen', 'Other'],
  invoice: 0,
  nextId: 7,
});

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY));
    if (d && d.products) {
      // Backfill keys added in later versions so older saved demo DBs keep working.
      const s = seed();
      for (const k of Object.keys(s)) if (d[k] === undefined) d[k] = s[k];
      d.products.forEach((p) => { if (p.unit === undefined) p.unit = 'ea'; });
      return d;
    }
  } catch (_) {}
  const s = seed(); save(s); return s;
}
function save(db) { localStorage.setItem(LS_KEY, JSON.stringify(db)); }

let _token = null, _onExpired = null;
const err = (code, status) => { const e = new Error(code); e.status = status; e.message = code; throw e; };
const userJson = (u) => ({ id: u.id, username: u.username, role: u.role, allowed_views: u.allowed_views, token: 'demo-' + u.id });
const currentUser = (db) => db.users.find((u) => _token === 'demo-' + u.id) || null;

// Parse "/path?query" → { parts:[...], query:{...} }
function parse(path) {
  const [p, qs] = String(path).split('?');
  const parts = p.split('/').filter(Boolean);
  const query = {};
  (qs || '').split('&').filter(Boolean).forEach((kv) => { const [k, v] = kv.split('='); query[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
  return { parts, query };
}

async function handle(method, path, body) {
  const db = load();
  const { parts, query } = parse(path);
  const top = parts[0];

  // ── auth ──
  if (top === 'auth') {
    const action = parts[1];
    if (action === 'login') {
      const u = db.users.find((x) => x.username === String(body.username || '').toLowerCase().trim());
      if (!u) err('invalid', 401);
      _token = 'demo-' + u.id;
      return userJson(u);
    }
    if (action === 'validate') { const u = currentUser(db); if (!u) err('session', 401); return userJson(u); }
    if (action === 'logout') { _token = null; return { ok: true }; }
    if (action === 'change-password') return { ok: true };
    err('not_found', 404);
  }

  const me = currentUser(db);
  if (!me) err('session', 401);
  const isAdmin = me.role === 'admin';

  // ── products ──
  if (top === 'products') {
    if (method === 'GET' && parts[1] === 'barcode') {
      const code = decodeURIComponent(parts[2] || '');
      const p = db.products.find((x) => x.barcode === code);
      if (!p) err('not_found', 404);
      return p;
    }
    if (method === 'GET') return db.products.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (method === 'POST') {
      if (body.barcode && db.products.some((x) => x.barcode === body.barcode)) err('exists', 409);
      const p = { id: db.nextId++, barcode: body.barcode || null, name: body.name, price: +body.price || 0, cat: body.cat || null, cost: +body.cost || 0, stock: +body.stock || 0, unit: body.unit === 'kg' ? 'kg' : 'ea', active: true };
      db.products.push(p); save(db); return p;
    }
    if (method === 'PUT') {
      const p = db.products.find((x) => String(x.id) === parts[1]);
      if (!p) err('not_found', 404);
      // Mirrors the server rule: price/cost/barcode changes are admin-only.
      if (!isAdmin) {
        const changed = (+body.price || 0) !== (+p.price || 0) || (+body.cost || 0) !== (+p.cost || 0) || (body.barcode || null) !== (p.barcode || null);
        if (changed) err('admin_only', 403);
      }
      Object.assign(p, { barcode: body.barcode || null, name: body.name, price: +body.price || 0, cat: body.cat || null, cost: +body.cost || 0, stock: +body.stock || 0, unit: body.unit === 'kg' ? 'kg' : 'ea' });
      save(db); return { ok: true };
    }
    if (method === 'PATCH' && parts[2] === 'stock') {
      const p = db.products.find((x) => String(x.id) === parts[1]);
      if (!p) err('not_found', 404);
      p.stock = (+p.stock || 0) + (+body.delta || 0); save(db); return { ok: true, stock: p.stock };
    }
    if (method === 'DELETE') { db.products = db.products.filter((x) => String(x.id) !== parts[1]); save(db); return { ok: true }; }
  }

  if (top === 'stock-log') return { ok: true };

  if (top === 'settings' && parts[1] === 'categories') {
    if (method === 'GET') return { value: JSON.stringify(db.categories) };
    if (method === 'PUT') { try { db.categories = JSON.parse(body.value); } catch (_) {} save(db); return { ok: true }; }
  }

  // ── invoice + orders ──
  if (top === 'invoice' && parts[1] === 'next') { db.invoice += 1; save(db); return db.invoice; }
  if (top === 'orders') {
    if (method === 'POST') {
      const isRefund = body.status === 'refund';
      // Mirrors server: over-refund guard against the original invoice.
      if (isRefund && /^return of #(\d+)$/.test(String(body.buyer || ''))) {
        const inv = Number(String(body.buyer).match(/#(\d+)$/)[1]);
        const orig = db.orders.filter((o) => o.invoice_no === inv && o.status !== 'refund').reduce((s, o) => s + (+o.total || 0), 0);
        const prior = db.orders.filter((o) => o.status === 'refund' && o.buyer === body.buyer).reduce((s, o) => s + (+o.total || 0), 0);
        if (Math.abs(+body.total || 0) > orig + prior + 0.0005) err('over_refund', 400);
      }
      // Mirrors server: stock moves with the order (sale deducts, refund restores).
      (body.items || []).forEach((li) => {
        const p = db.products.find((x) => x.id === li.id);
        if (p && Number.isFinite(+li.qty)) p.stock = (+p.stock || 0) + (isRefund ? +li.qty : -li.qty);
      });
      db.orders.unshift({ ...body, created_at: new Date().toISOString() });
      save(db); return { ok: true };
    }
    if (method === 'GET') { const lim = +query.limit || 200; return db.orders.slice(0, lim); }
    if (method === 'DELETE') { db.orders = db.orders.filter((o) => o.id !== parts[1]); save(db); return { ok: true }; }
  }

  // ── reports ──
  if (top === 'reports') {
    const inRange = (o) => {
      const d = (o.date || (o.created_at || '').slice(0, 10));
      if (query.from && d < query.from) return false;
      if (query.to && d > query.to) return false;
      return true;
    };
    const sales = db.orders.filter(inRange);
    if (parts[1] === 'summary') {
      const revenue = sales.reduce((s, o) => s + (+o.total || 0), 0);
      const units = sales.reduce((s, o) => s + (o.items || []).reduce((n, l) => n + (+l.qty || 0), 0), 0);
      return { orders: sales.length, revenue, units };
    }
    if (parts[1] === 'daily') {
      const m = {}; sales.forEach((o) => { const d = o.date || (o.created_at || '').slice(0, 10); (m[d] = m[d] || { day: d, orders: 0, revenue: 0 }).orders++; m[d].revenue += +o.total || 0; });
      return Object.values(m).sort((a, b) => b.day.localeCompare(a.day));
    }
    if (parts[1] === 'top-products') {
      const m = {}; sales.forEach((o) => (o.items || []).forEach((l) => { (m[l.name] = m[l.name] || { name: l.name, units: 0, revenue: 0 }).units += +l.qty || 0; m[l.name].revenue += (+l.price || 0) * (+l.qty || 0); }));
      return Object.values(m).sort((a, b) => b.units - a.units).slice(0, +query.limit || 20);
    }
    if (parts[1] === 'low-stock') { const t = +query.threshold || 5; return db.products.filter((p) => p.active && (+p.stock || 0) <= t).sort((a, b) => a.stock - b.stock); }
    if (parts[1] === 'zreport') {
      const day = query.date || new Date().toISOString().slice(0, 10);
      const dayOf = (o) => (o.date || (o.created_at || '').slice(0, 10));
      const m = {};
      db.orders.filter((o) => dayOf(o) === day).forEach((o) => { const k = o.pay || '?'; (m[k] = m[k] || { pay: k, orders: 0, total: 0 }).orders++; m[k].total += +o.total || 0; });
      const lines = Object.values(m);
      return { date: day, lines, net: lines.reduce((s, r) => s + r.total, 0) };
    }
    if (parts[1] === 'abc') {
      const m = {}; sales.forEach((o) => (o.items || []).forEach((l) => { m[l.name] = (m[l.name] || 0) + (+l.price || 0) * (+l.qty || 0); }));
      const arr = Object.entries(m).map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue);
      const grand = arr.reduce((s, r) => s + r.revenue, 0) || 1;
      let cum = 0;
      return arr.map((r) => { cum += r.revenue; const share = cum / grand; return { name: r.name, revenue: r.revenue, cum_share: share, class: share <= 0.8 ? 'A' : share <= 0.95 ? 'B' : 'C' }; });
    }
  }

  // ── time clock ──
  if (top === 'timeclock') {
    if (parts[1] === 'status') return db.time_clock.find((t) => t.user_id === me.id && !t.clock_out) || null;
    if (parts[1] === 'in') {
      if (!db.time_clock.some((t) => t.user_id === me.id && !t.clock_out)) { db.time_clock.unshift({ id: db.nextPunch++, user_id: me.id, username: me.username, clock_in: new Date().toISOString(), clock_out: null }); save(db); }
      return { ok: true };
    }
    if (parts[1] === 'out') {
      const p = db.time_clock.find((t) => t.user_id === me.id && !t.clock_out);
      if (!p) err('not_clocked_in', 400);
      p.clock_out = new Date().toISOString(); save(db); return { ok: true };
    }
    if (method === 'GET') {
      return db.time_clock.map((t) => ({ username: t.username, clock_in: t.clock_in, clock_out: t.clock_out, hours: Math.round(((t.clock_out ? new Date(t.clock_out) : new Date()) - new Date(t.clock_in)) / 36000) / 100 }));
    }
  }

  // ── suppliers ──
  if (top === 'suppliers') {
    if (method === 'GET') return db.suppliers.filter((s) => s.active);
    if (method === 'POST') { const s = { id: db.nextSupplier++, name: body.name, phone: body.phone || null, note: body.note || null, active: true }; db.suppliers.push(s); save(db); return s; }
    if (method === 'PUT') { const s = db.suppliers.find((x) => String(x.id) === parts[1]); if (s) Object.assign(s, { name: body.name, phone: body.phone || null, note: body.note || null }); save(db); return { ok: true }; }
    if (method === 'DELETE') { const s = db.suppliers.find((x) => String(x.id) === parts[1]); if (s) s.active = false; save(db); return { ok: true }; }
  }

  // ── batches (receive stock) ──
  if (top === 'batches') {
    if (method === 'POST') {
      const qty = +body.qty || 0;
      const b = { id: db.nextBatch++, product_id: +body.product_id, supplier_id: body.supplier_id ? +body.supplier_id : null, qty, cost: +body.cost || 0, expiry: body.expiry || null, received_at: new Date().toISOString() };
      db.batches.unshift(b);
      const p = db.products.find((x) => x.id === b.product_id); if (p) p.stock = (+p.stock || 0) + qty;
      save(db); return { ok: true, stock: p ? p.stock : null };
    }
    if (method === 'GET') {
      const pid = query.product_id ? +query.product_id : null;
      return db.batches.filter((b) => !pid || b.product_id === pid).map((b) => ({
        ...b, product: (db.products.find((p) => p.id === b.product_id) || {}).name,
        supplier: (db.suppliers.find((s) => s.id === b.supplier_id) || {}).name,
      }));
    }
  }

  if (top === 'expiry') {
    const days = +query.days || 30;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    return db.batches.filter((b) => b.expiry).map((b) => {
      const left = Math.round((new Date(b.expiry) - today) / 86400000);
      return { id: b.id, product_id: b.product_id, product: (db.products.find((p) => p.id === b.product_id) || {}).name, supplier: (db.suppliers.find((s) => s.id === b.supplier_id) || {}).name, qty: b.qty, expiry: b.expiry, days_left: left };
    }).filter((x) => x.days_left <= days).sort((a, b) => a.days_left - b.days_left);
  }

  // ── users (admin) ──
  if (top === 'users') {
    if (!isAdmin) err('not_admin', 403);
    if (method === 'GET') return db.users.map((u) => ({ id: u.id, username: u.username, role: u.role, allowed_views: u.allowed_views, active: u.active, full_name: u.full_name || '', wage: u.wage || 0 }));
    if (method === 'POST') {
      if (db.users.some((u) => u.username === String(body.username).toLowerCase())) err('exists', 400);
      const u = { id: 'u-' + Date.now(), username: String(body.username).toLowerCase(), role: body.role || 'user', allowed_views: body.views || [], active: true, full_name: body.full_name || '', wage: +body.wage || 0 };
      db.users.push(u); save(db); return { id: u.id, ok: true };
    }
    if (method === 'POST' && parts[2] === 'reset-password') return { ok: true };   // demo: no real passwords
    if (method === 'PUT') {
      const u = db.users.find((x) => x.id === parts[1]);
      if (u) {
        const uname = String(body.username || '').toLowerCase().trim();
        if (uname && uname !== u.username && db.users.some((x) => x.username === uname)) err('exists', 400);
        Object.assign(u, { username: uname || u.username, role: body.role ?? u.role, allowed_views: body.views ?? u.allowed_views, active: body.active ?? u.active, full_name: body.full_name ?? u.full_name, wage: body.wage ?? u.wage });
      }
      save(db); return { ok: true };
    }
    if (method === 'DELETE') { db.users = db.users.filter((x) => x.id !== parts[1]); save(db); return { ok: true }; }
  }

  err('not_found', 404);
}

export const setToken = (t) => { _token = t || null; };
export const getToken = () => _token;
export const setOnSessionExpired = (fn) => { _onExpired = fn; };
export const demoBanner = DEMO_BANNER;

export const api = {
  get: (p) => handle('GET', p),
  post: (p, b) => handle('POST', p, b || {}),
  put: (p, b) => handle('PUT', p, b || {}),
  patch: (p, b) => handle('PATCH', p, b || {}),
  del: (p) => handle('DELETE', p),
  setToken, getToken, setOnSessionExpired,
};
export default api;
