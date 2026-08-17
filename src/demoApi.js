/* eslint-disable */
// In-browser MOCK API for the GitHub Pages preview (no backend/DB).
// Activated only when REACT_APP_DEMO === '1' (see src/api.js). Implements the same
// contract as the real api.js (get/post/put/patch/del + token helpers), backed by
// localStorage so data survives reloads. The real Heroku build never imports this.
//
// Demo logins — ANY PASSWORD IS ACCEPTED (see the auth branch below):
//   owner / anything   ·   manager / anything   ·   barista1 / anything
//
// That is safe only because this mock never touches Kan's real database: there is no server,
// no Postgres and no real money in it, and every write lands in this browser's localStorage.
// It is also why a demo build must never be pointed at a real API.
//
// ⚠ THE CATALOGUE BELOW IS KAN'S REAL MENU AND MUST STAY THAT WAY.
// This file previously seeded a grocery shop (Laban, Pita Bread, Dish Soap) inherited from
// the Dukkan ancestor. A public demo showing groceries under the Kan Coffee House name is
// worse than no demo — it reads as the wrong shop's till.
const LS_KEY = 'kan_demo_db';
const DEMO_BANNER = true;

// Prices are tax-inclusive JOD, matching server/seed-products.sql. cost is 0 because Kan
// supplied none, so the demo's profit figures read as 100% margin — the same honest gap the
// real shop has, not an invented number.
//
// stock 9999 / low_at 0 on made-to-order drinks for the same reason as the SQL seed: the
// till deducts stock per line with no non-stock-item flag, and seeding 0 would paint a red
// "Out" pill on every tile. Cold Brew Bottle is the one genuinely stocked line.
const D = (id, sku, name, price, cat) =>
  ({ id, barcode: sku, name, price, cat, cost: 0, stock: 9999, low_at: 0, unit: 'ea', size: null, active: true });

const seed = () => ({
  products: [
    // Hot Coffee
    D(1,  'KC-HC-01', 'Espresso',           2.00, 'Hot Coffee'),
    D(2,  'KC-HC-02', 'Espresso Macchiato', 2.25, 'Hot Coffee'),
    D(3,  'KC-HC-03', 'Lungo',              2.00, 'Hot Coffee'),
    D(4,  'KC-HC-04', 'Americano',          2.50, 'Hot Coffee'),
    D(5,  'KC-HC-05', 'V60 / Chemex',       3.75, 'Hot Coffee'),
    D(6,  'KC-HC-06', 'Cappuccino',         3.25, 'Hot Coffee'),
    D(7,  'KC-HC-07', 'Cafe Latte',         3.25, 'Hot Coffee'),
    D(8,  'KC-HC-08', 'Flat White',         3.25, 'Hot Coffee'),
    D(9,  'KC-HC-09', 'White / Dark Mocha', 3.75, 'Hot Coffee'),
    D(10, 'KC-HC-10', 'Spanish Latte',      3.75, 'Hot Coffee'),
    D(11, 'KC-HC-11', 'Caramel Macchiato',  3.75, 'Hot Coffee'),
    D(12, 'KC-HC-12', 'Cortado',            3.00, 'Hot Coffee'),
    D(13, 'KC-HC-13', 'Turkish',            2.25, 'Hot Coffee'),
    // Cold Coffee
    D(14, 'KC-CC-01', 'Iced Latte',         3.25, 'Cold Coffee'),
    D(15, 'KC-CC-02', 'Cold Brew',          3.75, 'Cold Coffee'),
    { ...D(16, 'KC-CC-03', 'Cold Brew Bottle', 4.75, 'Cold Coffee'), stock: 24, low_at: 6 },
    D(17, 'KC-CC-04', 'Iced Americano',     2.75, 'Cold Coffee'),
    D(18, 'KC-CC-05', 'Dark / White Mocha', 4.00, 'Cold Coffee'),
    D(19, 'KC-CC-06', 'Spanish Latte',      4.00, 'Cold Coffee'),
    D(20, 'KC-CC-07', 'Caramel Macchiato',  4.00, 'Cold Coffee'),
    D(21, 'KC-CC-08', 'Frappuccino',        4.75, 'Cold Coffee'),
    // Tea & Herbs — Chai Karak omitted: greyed out on Kan's menu, owner confirmed not sold.
    D(22, 'KC-TH-01', 'Black / Green',      2.25, 'Tea & Herbs'),
    D(23, 'KC-TH-02', 'Persian Tea',        3.00, 'Tea & Herbs'),
    D(24, 'KC-TH-03', 'Beduin Tea',         3.00, 'Tea & Herbs'),
    D(25, 'KC-TH-04', 'Chai Latte',         3.25, 'Tea & Herbs'),
    D(26, 'KC-TH-05', 'Yemeni Tea',         3.25, 'Tea & Herbs'),
    D(27, 'KC-TH-06', 'Moroccan Tea',       2.50, 'Tea & Herbs'),
    D(28, 'KC-TH-07', 'Ask About Herbs',    2.75, 'Tea & Herbs'),
    // Hot Kan
    D(29, 'KC-HK-01', 'Hot Chocolate',      3.50, 'Hot Kan'),
    D(30, 'KC-HK-02', 'Hot Lotus',          3.75, 'Hot Kan'),
    D(31, 'KC-HK-03', 'Hot Pistachio',      3.75, 'Hot Kan'),
    // Cold Kan
    D(32, 'KC-CK-01', 'Mojito',             3.50, 'Cold Kan'),
    D(33, 'KC-CK-02', 'Iced Tea',           3.00, 'Cold Kan'),
    D(34, 'KC-CK-03', 'Smoothies',          4.00, 'Cold Kan'),
    D(35, 'KC-CK-04', 'Fresh Juice',        3.25, 'Cold Kan'),
    D(36, 'KC-CK-05', 'Matcha',             4.00, 'Cold Kan'),
    D(37, 'KC-CK-06', 'Summer Passion',     4.00, 'Cold Kan'),
    // Special
    D(38, 'KC-SP-01', 'Hot Arabian Latte',  4.00, 'Special'),
    D(39, 'KC-SP-02', 'Hot Spanilla',       4.00, 'Special'),
    D(40, 'KC-SP-03', 'Iced Arabian Latte', 4.25, 'Special'),
    D(41, 'KC-SP-04', 'Iced Spanilla',      4.25, 'Special'),
    D(42, 'KC-SP-05', 'Pomberries Smoothie', 4.25, 'Special'),
    D(43, 'KC-SP-06', 'Matcha (Strawberry-Mango)', 4.25, 'Special'),
    D(44, 'KC-SP-07', 'Affogato',           4.25, 'Special'),
  ],
  // Named "(demo)" on purpose. Kan's real suppliers are not known, and inventing plausible
  // vendor names for a business in a PUBLIC demo would read as a real trading relationship.
  suppliers: [
    { id: 1, name: 'Sample Roastery (demo)', phone: '', note: 'Placeholder so Receive can be demonstrated', active: true },
    { id: 2, name: 'Sample Dairy (demo)', phone: '', note: 'Placeholder so Receive can be demonstrated', active: true },
  ],
  batches: [
    { id: 1, product_id: 16, supplier_id: 1, qty: 24, cost: 0, received_at: new Date().toISOString() },
  ],
  nextSupplier: 3,
  nextBatch: 2,
  orders: [],
  // Same usernames as the real shop so the demo matches CLIENT_INTAKE.md. Any password works
  // here; the real accounts have bcrypt hashes and are unrelated to these.
  users: [
    { id: 'u-owner', username: 'owner', role: 'admin', allowed_views: [], active: true, full_name: 'Owner', wage: 0 },
    { id: 'u-manager', username: 'manager', role: 'user', allowed_views: ['sales', 'inventory', 'receive', 'history', 'reports', 'storereports', 'settings'], active: true, full_name: 'Manager', wage: 0 },
    { id: 'u-barista1', username: 'barista1', role: 'user', allowed_views: ['sales', 'history'], active: true, full_name: 'Barista One', wage: 0 },
  ],
  time_clock: [],
  nextPunch: 1,
  categories: ['Hot Coffee', 'Cold Coffee', 'Tea & Herbs', 'Hot Kan', 'Cold Kan', 'Special'],
  invoice: 0,
  nextId: 45,
});

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY));
    if (d && d.products) {
      // Backfill keys added in later versions so older saved demo DBs keep working.
      const s = seed();
      for (const k of Object.keys(s)) if (d[k] === undefined) d[k] = s[k];
      d.products.forEach((p) => { if (p.unit === undefined) p.unit = 'ea'; });
      // Browsers hold a demo catalogue from before size/low_at existed. Fill the defaults in
      // rather than letting `undefined` reach the low-stock badge as NaN.
      d.products.forEach((p) => { if (p.low_at === undefined) p.low_at = 5; if (p.size === undefined) p.size = null; });
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
      const p = { id: db.nextId++, barcode: body.barcode || null, name: body.name, price: +body.price || 0, cat: body.cat || null, cost: +body.cost || 0, stock: +body.stock || 0, unit: body.unit === 'kg' ? 'kg' : 'ea', size: body.size || null, low_at: Number.isFinite(+body.low_at) ? +body.low_at : 5, active: true };
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
      const b = { id: db.nextBatch++, product_id: +body.product_id, supplier_id: body.supplier_id ? +body.supplier_id : null, qty, cost: +body.cost || 0, received_at: new Date().toISOString() };
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
  // The demo has no server to store uploaded artwork in, so every tile falls back to the
  // bundled image. Rejecting (rather than omitting the method) is what categoryArt.js
  // already treats as "no upload for this category".
  getBlob: () => Promise.reject(new Error('not_found')),
  setToken, getToken, setOnSessionExpired,
};
export default api;
