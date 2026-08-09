// Apply server/seed-products.sql (demo catalogue: categories, suppliers, products)
// against DATABASE_URL. Cross-platform alternative to psql. Idempotent — re-running
// re-syncs prices/stock to the seed values.
//   npm run seed:products
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const file = path.join(__dirname, 'seed-products.sql');
  if (!fs.existsSync(file)) throw new Error('seed-products.sql not found');
  const sql = fs.readFileSync(file, 'utf8');
  await pool.query(sql);
  const { rows } = await pool.query(
    'select (select count(*) from products) as products, (select count(*) from suppliers) as suppliers'
  );
  console.log(`Seeded catalogue: ${rows[0].products} products, ${rows[0].suppliers} suppliers.`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Seed products failed:', e.message); pool.end(); process.exit(1); });
