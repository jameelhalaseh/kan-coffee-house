// Apply server/migrations/*.sql in filename order against DATABASE_URL.
// Each file manages its own transaction (begin/commit). Cross-platform alt to psql.
//   npm run migrate          (locally, with .env)
//   heroku run npm run migrate -a <app>
try { require('dotenv').config(); } catch (_) {}

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function main() {
  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) { console.log('No migration files found.'); return; }

  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    if (!sql) continue;
    process.stdout.write(`Applying ${f} ... `);
    await pool.query(sql);
    console.log('done.');
  }
  console.log(`Applied ${files.length} migration(s).`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Migration failed:', e.message); pool.end(); process.exit(1); });
