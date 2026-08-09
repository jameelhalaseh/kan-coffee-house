// Create (or reset) the first admin user — bcrypt is done here in Node, never in SQL.
// Credentials come from env so no secret is ever committed:
//   ADMIN_USERNAME=owner ADMIN_PASSWORD='strong-pass' [ADMIN_EMAIL=you@x.com] npm run seed:admin
//   heroku run -a <app> "ADMIN_USERNAME=owner ADMIN_PASSWORD=... npm run seed:admin"
try { require('dotenv').config(); } catch (_) {}

const bcrypt = require('bcryptjs');
const { pool } = require('./db');

async function main() {
  const username = (process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  const email = (process.env.ADMIN_EMAIL || '').trim() || null;
  const role = (process.env.ADMIN_ROLE || 'admin').trim();

  if (!username || !password) throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD.');
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');

  const hash = bcrypt.hashSync(password, 10);
  const { rows } = await pool.query(
    `insert into app_users (username, email, role, allowed_views, pass_hash, active)
     values (lower($1), $2, $3, '{}', $4, true)
     on conflict (username) do update
       set pass_hash = excluded.pass_hash, role = excluded.role,
           email = coalesce(excluded.email, app_users.email), active = true
     returning id, username, role`,
    [username, email, role, hash]
  );
  console.log('Admin user ready:', rows[0]);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Seed failed:', e.message); pool.end(); process.exit(1); });
