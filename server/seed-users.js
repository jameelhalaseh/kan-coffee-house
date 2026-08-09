// Bulk-create the client's staff logins (admins + regular users) from one env var.
// bcrypt is done here in Node, never in SQL. No password is ever committed — they come
// from USERS_JSON at run time.
//
//   USERS_JSON='[{"username":"owner","password":"...","role":"admin"},
//                {"username":"cashier1","password":"...","role":"user","allowed_views":["tables","kitchen"]}]'
//   npm run seed:users
//   heroku run -a <app> "USERS_JSON='[...]' npm run seed:users"
//
// role: 'admin' (full access) or 'user' (limited to allowed_views — floor views + tools).
// allowed_views: array of view ids (floor view ids from client.config + 'kitchen','drinks',...).
// Omit/empty allowed_views for admins (they see everything).
try { require('dotenv').config(); } catch (_) {}

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function main() {
  let list;
  try {
    list = JSON.parse(process.env.USERS_JSON || '[]');
  } catch (e) {
    throw new Error('USERS_JSON is not valid JSON: ' + e.message);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('USERS_JSON must be a non-empty JSON array of {username,password,role,allowed_views?}.');
  }

  const results = [];
  for (const u of list) {
    const username = String(u.username || '').trim();
    const password = String(u.password || '');
    const role = (u.role === 'admin' ? 'admin' : 'user');
    const email = (u.email && String(u.email).trim()) || null;
    const views = Array.isArray(u.allowed_views) ? u.allowed_views : [];

    if (!username) throw new Error('Every user needs a username.');
    if (password.length < 8) throw new Error(`Password for "${username}" must be at least 8 characters.`);

    const hash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query(
      `insert into app_users (username, email, role, allowed_views, pass_hash, active)
       values (lower($1), $2, $3, $4, $5, true)
       on conflict (username) do update
         set pass_hash = excluded.pass_hash, role = excluded.role,
             allowed_views = excluded.allowed_views,
             email = coalesce(excluded.email, app_users.email), active = true
       returning id, username, role, allowed_views`,
      [username, email, role, views, hash]
    );
    results.push(rows[0]);
  }

  console.log('Seeded users:');
  for (const r of results) console.log('  -', r.username, '(' + r.role + ')', r.allowed_views || []);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Seed users failed:', e.message); pool.end(); process.exit(1); });
