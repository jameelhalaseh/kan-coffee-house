// One-off repair: the demo sales were seeded VAT-EXCLUSIVE.
//
// WHAT WENT WRONG
// server/seed-demo-sales.js used to compute `sub` as the sum of the line prices and then ADD
// 16% on top. This app's prices are tax-INCLUSIVE (src/lib.js splitInclusiveTax): the menu
// price already contains the VAT, and checkout backs the tax out of it. So every seeded order
// carries a total inflated by 16% and a `tax` that is 16% of the total instead of 16/116 of
// it. The seed itself was fixed earlier; these rows were left pending a decision.
//
// WHAT THIS DOES
// For each affected order, rebuilds the money from the ITEM LINES, which are the only
// trustworthy part of the row:
//
//     total = Σ (price × qty)          ← the tax-inclusive prices actually charged
//     tax   = total − total / (1 + rate)
//     sub   = total − tax
//
// which is exactly what splitInclusiveTax() does at the till. Revenue therefore FALLS: the
// old totals were charging a tax that was never in the price. That is the correction, not a
// side effect — see the summary the script prints before it writes anything.
//
// WHAT IT WILL NOT TOUCH
//   • orders whose total already equals the line sum (genuine, inclusive sales)
//   • invoice numbers, ids, dates, times, items, payment method, status
//   • any order carrying a discount, a service charge, or a void — none exist today, and if
//     one appears later this script refuses it rather than guessing how to rebuild it
//
// SAFETY
// Dry run by default: prints what would change and writes nothing. `--apply` copies every
// affected row into a timestamped backup table, then updates inside ONE transaction, then
// re-verifies before committing.
//
//   node server/fix-demo-vat.js              # dry run
//   node server/fix-demo-vat.js --apply
try { require('dotenv').config(); } catch (_) {}

const { pool } = require('./db');

const RATE = Number(process.env.TAX_RATE || 0.16);
const TOL = 0.006;                       // money is 3dp; this is half a fils of slack
const r3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

const lineSum = (items) =>
  r3((items || []).reduce((s, l) => s + Number(l.price || 0) * Number(l.qty || 0), 0));

// Back the tax out of a tax-inclusive total — the same arithmetic as src/lib.js.
function splitInclusive(total, rate) {
  const tax = r3(total - total / (1 + rate));
  return { net: r3(total - tax), tax };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const { rows } = await pool.query(
    `select id, invoice_no, date, items, sub, tax, svc, disc, disc_pct, total, voided_at, status
       from orders_main order by invoice_no`);

  const fixes = [];
  const skipped = [];
  const refused = [];

  for (const o of rows) {
    const lines = lineSum(o.items);
    const total = Number(o.total);

    if (!lines) { skipped.push({ o, why: 'no item lines' }); continue; }
    // Already inclusive: the line prices sum to the total. Nothing to correct.
    if (Math.abs(total - lines) < TOL) { skipped.push({ o, why: 'already inclusive' }); continue; }

    // The signature of the bug: total is exactly the line sum plus `rate`.
    const looksExclusive = Math.abs(total - r3(lines * (1 + RATE))) < TOL;
    if (!looksExclusive) { refused.push({ o, lines, why: 'total matches neither model' }); continue; }

    // A discount, service charge or void would need a rebuild this script cannot infer.
    if (Number(o.disc) || Number(o.disc_pct) || Number(o.svc) || o.voided_at) {
      refused.push({ o, lines, why: 'has discount / service / void' });
      continue;
    }

    const { net, tax } = splitInclusive(lines, RATE);
    fixes.push({ id: o.id, invoice_no: o.invoice_no, before: { sub: Number(o.sub), tax: Number(o.tax), total }, after: { sub: net, tax, total: lines } });
  }

  const sum = (list, pick) => r3(list.reduce((s, f) => s + pick(f), 0));
  console.log(`orders scanned            : ${rows.length}`);
  console.log(`to fix                    : ${fixes.length}`);
  console.log(`left alone (correct)      : ${skipped.length}`);
  console.log(`refused (needs a human)   : ${refused.length}`);
  refused.forEach((r) => console.log(`   invoice ${r.o.invoice_no}: ${r.why}`));

  if (fixes.length) {
    console.log('\nmoney impact across the fixed rows');
    console.log(`  total  ${sum(fixes, (f) => f.before.total).toFixed(3)}  ->  ${sum(fixes, (f) => f.after.total).toFixed(3)}`);
    console.log(`  tax    ${sum(fixes, (f) => f.before.tax).toFixed(3)}  ->  ${sum(fixes, (f) => f.after.tax).toFixed(3)}`);
    console.log(`  net    ${sum(fixes, (f) => f.before.sub).toFixed(3)}  ->  ${sum(fixes, (f) => f.after.sub).toFixed(3)}`);
    console.log('\nfirst three:');
    fixes.slice(0, 3).forEach((f) => console.log(
      `  #${f.invoice_no}  sub ${f.before.sub} -> ${f.after.sub}   tax ${f.before.tax} -> ${f.after.tax}   total ${f.before.total} -> ${f.after.total}`));
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to commit.');
    return;
  }
  if (!fixes.length) { console.log('\nNothing to do.'); return; }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const backup = `orders_main_backup_vatfix_${stamp}`;

  const client = await pool.connect();
  try {
    await client.query('begin');

    // The backup is inside the transaction too: if the update fails, there is no orphan table
    // left behind implying a repair that never happened.
    await client.query(
      `create table "${backup}" as select * from orders_main where id = any($1)`,
      [fixes.map((f) => f.id)]);

    for (const f of fixes) {
      // Each row is matched on its CURRENT values as well as its id. If anything changed
      // between the scan and the write, the update hits nothing and the count check below
      // aborts the whole transaction rather than half-applying.
      const { rowCount } = await client.query(
        `update orders_main set sub = $2, tax = $3, total = $4
          where id = $1 and total = $5`,
        [f.id, f.after.sub.toFixed(3), f.after.tax.toFixed(3), f.after.total.toFixed(3),
          f.before.total]);
      if (rowCount !== 1) {
        throw new Error(`order ${f.invoice_no} changed under the script — nothing was written`);
      }
    }

    // Re-verify from the database, not from the plan: every fixed row must now satisfy
    // total = line sum and tax = total − total/(1+rate).
    const { rows: after } = await client.query(
      'select id, invoice_no, items, sub, tax, total from orders_main where id = any($1)',
      [fixes.map((f) => f.id)]);
    for (const o of after) {
      const lines = lineSum(o.items);
      const { net, tax } = splitInclusive(lines, RATE);
      if (Math.abs(Number(o.total) - lines) > TOL
        || Math.abs(Number(o.tax) - tax) > TOL
        || Math.abs(Number(o.sub) - net) > TOL) {
        throw new Error(`verification failed on invoice ${o.invoice_no}`);
      }
    }

    await client.query('commit');
    console.log(`\nApplied to ${fixes.length} order(s). Backup: ${backup}`);
    console.log(`Roll back with:  update orders_main o set sub=b.sub, tax=b.tax, total=b.total from "${backup}" b where b.id = o.id;`);
  } catch (e) {
    await client.query('rollback');
    console.error(`\nROLLED BACK — nothing changed. ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch((e) => {
  console.error(e.message);
  pool.end().finally(() => process.exit(1));
});
