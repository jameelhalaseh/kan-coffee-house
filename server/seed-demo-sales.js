// Demo-only: generate believable sales history so History/Reports/AI insights have data.
// Writes straight to orders_main (same shape the app's checkout posts) and deducts stock
// through the same stock_log trail. Deterministic-ish: seeded PRNG, so re-running after a
// reset gives the same history.
//   npm run seed:sales            (default: 14 days)
//   DEMO_DAYS=30 npm run seed:sales
//
// NOT for production — real sales come from the app.
try { require('dotenv').config(); } catch (_) {}

const { pool } = require('./db');
const { DEFAULT_FLOOR, ordersTable } = require('./floors');

const DAYS = Math.max(1, parseInt(process.env.DEMO_DAYS || '14', 10));
const TAX_RATE = 0.16;                 // must match client.config.js store.taxPct
const TABLE = ordersTable(DEFAULT_FLOOR);
const PAY_MODES = ['cash', 'cash', 'cash', 'card'];
const CASHIERS = ['owner', 'cashier', 'manager'];

// Tiny deterministic PRNG (mulberry32) so the demo dataset is reproducible.
let _s = 0x9e3779b9;
const rnd = () => { _s |= 0; _s = (_s + 0x6d2b79f5) | 0; let t = Math.imul(_s ^ (_s >>> 15), 1 | _s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const r2 = (n) => Math.round(n * 100) / 100;

async function main() {
  if (!TABLE) throw new Error('No orders table for store key ' + DEFAULT_FLOOR);
  const { rows: products } = await pool.query(
    'select id, name, price, cat from products where active order by id'
  );
  if (!products.length) throw new Error('No products — run `npm run seed:products` first.');

  // Bottles sell in ones and twos; beer and mixers move in six-packs.
  const qtyFor = (cat) => (['Beer', 'Mixers'].includes(cat) ? 2 + Math.floor(rnd() * 10) : 1 + Math.floor(rnd() * 2));

  const client = await pool.connect();
  let made = 0;
  try {
    await client.query('begin');
    for (let d = DAYS; d >= 1; d--) {
      const day = new Date(Date.now() - d * 86400000);
      const dateStr = day.toISOString().slice(0, 10);
      const isWeekend = [4, 5].includes(day.getDay());          // Thu/Fri = the busy nights
      const nOrders = (isWeekend ? 10 : 5) + Math.floor(rnd() * 6);

      for (let i = 0; i < nOrders; i++) {
        const hour = 12 + Math.floor(rnd() * 11);               // 12:00 – 22:xx
        const minute = Math.floor(rnd() * 60);
        const at = new Date(day); at.setHours(hour, minute, 0, 0);

        const lines = [];
        const nLines = 1 + Math.floor(rnd() * 4);
        for (let k = 0; k < nLines; k++) {
          const p = pick(products);
          if (lines.some((l) => l.id === p.id)) continue;
          const qty = qtyFor(p.cat);
          lines.push({ id: p.id, name: p.name, qty, price: Number(p.price) });
        }
        if (!lines.length) continue;

        const sub = r2(lines.reduce((s, l) => s + l.price * l.qty, 0));
        const tax = r2(sub * TAX_RATE);
        const total = r2(sub + tax);
        const id = `demo-${dateStr}-${i}`;

        const { rows: inv } = await client.query('select app_next_invoice($1) as n', [DEFAULT_FLOOR]);
        const ins = await client.query(
          `insert into ${TABLE} (id,items,sub,tax,svc,disc,total,pay,waiter,status,date,time,invoice_no,floor,created_at)
           values ($1,$2::jsonb,$3,$4,0,0,$5,$6,$7,'paid',$8,$9,$10,$11,$12)
           on conflict (id) do nothing
           returning id`,
          [id, JSON.stringify(lines), sub, tax, total, pick(PAY_MODES), pick(CASHIERS),
           dateStr, `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
           inv[0].n, DEFAULT_FLOOR, at.toISOString()]
        );
        if (!ins.rows.length) continue;   // already seeded — don't double-deduct stock

        for (const l of lines) {
          const upd = await client.query(
            'update products set stock = greatest(coalesce(stock,0) - $1, 0), updated_at = now() where id = $2 returning stock',
            [l.qty, l.id]
          );
          if (upd.rows[0]) {
            await client.query(
              `insert into stock_log (kind,item_id,name,old_qty,new_qty,changed_by,created_at)
               values ('sale',$1,$2,$3,$4,$5,$6)`,
              [String(l.id), l.name, Number(upd.rows[0].stock) + l.qty, Number(upd.rows[0].stock), 'demo', at.toISOString()]
            );
          }
        }
        made++;
      }
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`select count(*) c, coalesce(sum(total),0) rev from ${TABLE}`);
  console.log(`Seeded ${made} demo sales over ${DAYS} days. Table now: ${rows[0].c} orders, revenue ${rows[0].rev}.`);
}

main()
  .then(() => pool.end())
  .catch((e) => { console.error('Seed sales failed:', e.message); pool.end(); process.exit(1); });
