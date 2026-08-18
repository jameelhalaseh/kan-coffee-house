// Shared fixtures for the server suite: seed users directly (bcrypt, no HTTP), log in
// through the real /api/auth/login so tests carry genuine session tokens, and reset the
// tables a test touched.
const bcrypt = require('bcryptjs');
const request = require('supertest');
const db = require('../db');
const app = require('../index');

// Passwords exist only here; they never reach the repo's .env or a real deployment.
const USERS = {
  admin: { username: 'test_admin', password: 'test_admin_pw', role: 'admin', views: [] },
  cashier: { username: 'test_cashier', password: 'test_cashier_pw', role: 'user', views: ['sales', 'history'] },
  stockist: { username: 'test_stockist', password: 'test_stock_pw', role: 'user', views: ['sales', 'inventory'] },
};

async function seedUsers() {
  for (const u of Object.values(USERS)) {
    const hash = bcrypt.hashSync(u.password, 4);   // low cost: these are throwaway fixtures
    await db.query(
      `insert into app_users (username, role, allowed_views, pass_hash)
       values ($1,$2,$3,$4)
       on conflict (username) do update set
         role = excluded.role, allowed_views = excluded.allowed_views, pass_hash = excluded.pass_hash`,
      [u.username, u.role, u.views, hash]
    );
  }
}

// Returns the Bearer token for one of the fixture users.
async function login(which) {
  const u = USERS[which];
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: u.username, password: u.password });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`fixture login failed for ${which}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

const auth = (token) => ['Authorization', `Bearer ${token}`];

async function clearCatalogue() {
  await db.query('delete from stock_log');
  await db.query('delete from products');
}

async function clearOrders() {
  await db.query('delete from orders_main');
}

// Insert a catalogue product straight into the DB and return the row (id included).
// Bypasses the API on purpose: tests of the ORDER path should not fail because the
// product path changed.
async function makeProduct({ name = 'Fixture Bottle', barcode = null, price = 10, cost = 6, stock = 100, cat = 'Whiskey', size = null, low_at = 5 } = {}) {
  const { rows } = await db.query(
    `insert into products (barcode, name, price, cat, cost, stock, unit, size, low_at, active)
     values ($1,$2,$3,$4,$5,$6,'ea',$7,$8,true) returning *`,
    [barcode, name, price, cat, cost, stock, size, low_at]
  );
  return rows[0];
}

const stockOf = async (id) => {
  const { rows } = await db.query('select stock from products where id = $1', [id]);
  return Number(rows[0].stock);
};

// The browser's money arithmetic, for building bills the server will accept.
//
// The server now recomputes sub/tax/total from the lines (validateOrderMoney), so a fixture
// that hardcodes `sub: 0, tax: 0` on a 22.500 bill is no longer a harmless shortcut - it is
// a bill claiming a 16% shop collected no VAT, which is exactly what the validator exists to
// refuse. Every fixture derives its figures here instead of restating them.
const TAX_PCT = Number(process.env.CLIENT_TAX_PCT || 16);
const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// Mirrors src/lib.js splitInclusiveTax and the server's copy of it.
function splitInclusiveTax(total, rate) {
  const t = Number(total) || 0;
  const r = Number(rate) || 0;
  if (r <= 0) return { net: r3(t), tax: 0 };
  const tax = r3(t - t / (1 + r));
  return { net: r3(t - tax), tax };
}

// Fill in the two VAT columns from a bill's OWN total, after any override the test applied.
// Deriving from the final total (rather than from the lines) is deliberate: a test that
// deliberately posts a mismatched total still gets self-consistent tax and sub, so it fails
// on the mismatch it is about instead of on the VAT columns.
function withTax(body) {
  const total = Number(body.total) || 0;
  // A refund's lines stay positive while its total is negated, and it carries no tax of its
  // own - the original sale already did. Same shape the History screen posts.
  if (body.status === 'refund') {
    return { ...body, tax: body.tax ?? 0, sub: body.sub ?? total };
  }
  const { net, tax } = splitInclusiveTax(total, TAX_PCT / 100);
  return { ...body, tax: body.tax ?? tax, sub: body.sub ?? net };
}

module.exports = {
  USERS, seedUsers, login, auth,
  clearCatalogue, clearOrders, makeProduct, stockOf,
  splitInclusiveTax, withTax, TAX_PCT,
  app, db,
};
