// Wipe TRANSACTIONAL data only — keep the product catalogue and all credentials
// (app_users). Use at go-live to clear test sales while keeping config.
//
// DESTRUCTIVE. Guarded — must pass CONFIRM_WIPE=YES or it refuses to run.
//   Local:  CONFIRM_WIPE=YES npm run reset:data
//   Heroku: heroku run -a <app> "CONFIRM_WIPE=YES npm run reset:data"
//
// Store-aware: truncates orders_<key> for every store in server/floors.js. Invoice numbers
// reset automatically (gap-reuse scans the now-empty table).
try { require('dotenv').config(); } catch (_) {}

const { pool } = require('./db');
const { FLOORS, ordersTable } = require('./floors');

// Transactional tables (NOT credentials, NOT the product catalogue / settings).
const TX_TABLES = ['customers', 'stock_log', 'admin_log', 'pin_attempts'];

async function main() {
  if (process.env.CONFIRM_WIPE !== 'YES') {
    throw new Error('Refusing to wipe. Re-run with CONFIRM_WIPE=YES to confirm.');
  }

  const orderTables = FLOORS.map((f) => ordersTable(f)).filter(Boolean); // orders_main
  const targets = [...orderTables, ...TX_TABLES];
  const list = targets.map((t) => `public.${t}`).join(', ');
  console.log('Wiping transactional tables:\n  ' + targets.join(', '));
  await pool.query(`truncate table ${list} restart identity`);
  console.log('Done. Products + credentials kept. Invoice numbering reset to 1.');
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Reset failed:', e.message); pool.end(); process.exit(1); });
