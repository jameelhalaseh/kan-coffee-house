// Load the shop's artwork from server/seed-images/ into the database.
//   npm run seed:images
//
// WHY THIS EXISTS. The pictures live in Postgres (`product_images` / `category_images`, bytes
// in a bytea column), which means a `git clone` never brought them: a second developer pulled
// the repo, ran the setup, and got a working till with 44 unillustrated drinks. The images
// themselves were only ever in one laptop's database and one Downloads folder.
//
// So the PNGs are committed under server/seed-images/ and this script puts them back. Run after
// seed-products, because a product row has to exist for its picture to attach to — `npm run
// setup` does both in the right order.
//
// KEYED BY SKU, NOT BY ROW ID. `product_images.product_id` is a serial that depends on insert
// order, so filenames like `12.png` would silently attach the cappuccino's picture to whatever
// happened to land on row 12 in someone else's database. The SKUs (`KC-HC-02`) are written into
// seed-products.sql and are the same everywhere, so the filename IS the join key.
//
// Categories carry the same problem in reverse: 'Tea & Herbs' cannot be recovered from the
// filename 'tea-herbs.png', so categories.json holds the slug → real-name mapping.
//
// Idempotent: re-running replaces the bytes and touches updated_at. It never deletes a picture
// somebody uploaded through Settings that has no file here — an upload made on the shop's own
// till is newer information than a checkout of this repo.
try { require('dotenv').config(); } catch (_) { /* dotenv optional in production */ }

const fs = require('fs');
const path = require('path');
const db = require('./db');
// The SAME validator the upload endpoint uses (PNG signature + IHDR + exact 512x512). A file
// that would be refused from the browser must be refused here too, or the repo becomes a way
// to put bytes in the database that the API would never have accepted.
const { validatePng } = require('./routes/categoryImages');

const DIR = path.join(__dirname, 'seed-images');
const PRODUCTS = path.join(DIR, 'products');
const CATEGORIES = path.join(DIR, 'categories');
const MANIFEST = path.join(CATEGORIES, 'categories.json');

const pngsIn = (dir) => (fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort()
  : []);

async function seedProducts(actor) {
  const files = pngsIn(PRODUCTS);
  const done = [];
  const noProduct = [];
  const invalid = [];

  for (const file of files) {
    const sku = path.basename(file, '.png');
    const bytes = fs.readFileSync(path.join(PRODUCTS, file));

    const bad = validatePng(bytes);
    if (bad) { invalid.push(`${file} (${bad})`); continue; }

    // Resolve the product by SKU. A missing one is reported rather than skipped quietly: it
    // means the catalogue and the artwork have drifted apart, which is worth knowing.
    const { rows } = await db.query('select id from products where barcode = $1', [sku]);
    if (!rows.length) { noProduct.push(sku); continue; }

    await db.query(
      `insert into product_images (product_id, mime, bytes, updated_at, updated_by)
       values ($1, 'image/png', $2, now(), $3)
       on conflict (product_id) do update
         set bytes = excluded.bytes, mime = excluded.mime,
             updated_at = now(), updated_by = excluded.updated_by`,
      [rows[0].id, bytes, actor]
    );
    done.push(sku);
  }
  return { done, noProduct, invalid, files };
}

async function seedCategories(actor) {
  const files = pngsIn(CATEGORIES);
  let names = {};
  try { names = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (_) { names = {}; }

  const done = [];
  const noName = [];
  const invalid = [];

  for (const file of files) {
    const slug = path.basename(file, '.png');
    // Without the manifest entry the real category name is unknowable — '&' and spaces are
    // gone from the slug — and guessing would create a SECOND category row the shelf never
    // matches. Report it instead.
    const cat = names[slug];
    if (!cat) { noName.push(slug); continue; }

    const bytes = fs.readFileSync(path.join(CATEGORIES, file));
    const bad = validatePng(bytes);
    if (bad) { invalid.push(`${file} (${bad})`); continue; }

    await db.query(
      `insert into category_images (cat, mime, bytes, updated_at, updated_by)
       values ($1, 'image/png', $2, now(), $3)
       on conflict (cat) do update
         set bytes = excluded.bytes, mime = excluded.mime,
             updated_at = now(), updated_by = excluded.updated_by`,
      [cat, bytes, actor]
    );
    done.push(cat);
  }
  return { done, noName, invalid, files };
}

async function main() {
  const actor = process.env.SEED_IMAGES_ACTOR || 'seed-images';

  if (!fs.existsSync(PRODUCTS) && !fs.existsSync(CATEGORIES)) {
    console.error(`No artwork found at ${DIR}. Nothing to seed.`);
    process.exit(1);
  }

  const p = await seedProducts(actor);
  const c = await seedCategories(actor);

  console.log(`products  : ${p.done.length}/${p.files.length} loaded`);
  if (p.noProduct.length) {
    console.log(`  no product with that SKU (${p.noProduct.length}): ${p.noProduct.join(', ')}`);
    console.log('  → run `npm run seed:products` first, or reconcile the catalogue.');
  }
  if (p.invalid.length) console.log(`  REJECTED (${p.invalid.length}): ${p.invalid.join(', ')}`);

  console.log(`categories: ${c.done.length} loaded${c.done.length ? ' — ' + c.done.join(', ') : ''}`);
  if (c.noName.length) console.log(`  not in categories.json (${c.noName.length}): ${c.noName.join(', ')}`);
  if (c.invalid.length) console.log(`  REJECTED (${c.invalid.length}): ${c.invalid.join(', ')}`);

  // A rejected file is a broken commit, not a warning to scroll past. A missing product is not:
  // a shop that has renamed a SKU should still get the rest of its pictures.
  const failed = p.invalid.length + c.invalid.length + c.noName.length;
  await db.pool.end();
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('seed-images failed:', e.message);
    db.pool.end().finally(() => process.exit(1));
  });
}

module.exports = { seedProducts, seedCategories };
