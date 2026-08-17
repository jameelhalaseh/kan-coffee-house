-- Kan Coffee House POS — catalogue seed (the shop's REAL drinks menu).
-- Idempotent: products upsert on the unique barcode.
-- Apply AFTER `npm run migrate`:
--   psql "$DATABASE_URL" -f server/seed-products.sql
--   or: npm run seed:products
--
-- ── Three things about this catalogue that are deliberate ─────────────────────
--
-- 1. THE `barcode` VALUES ARE SYNTHETIC INTERNAL SKUs, NOT SCANNABLE CODES.
--    Kan has no barcode scanner and an espresso has no barcode. But `barcode` is the
--    UNIQUE column this seed upserts on, and in Postgres NULL never conflicts with NULL
--    — so 44 NULL barcodes would make `on conflict (barcode)` match nothing and every
--    re-run would insert 44 more rows. `KC-HC-01`-style keys keep the seed genuinely
--    idempotent. They also disambiguate the three drinks that appear on the menu twice
--    (Spanish Latte, Caramel Macchiato, Dark/White Mocha — hot and cold, different
--    prices, same name at the owner's request).
--
-- 2. MADE-TO-ORDER DRINKS CARRY stock = 9999 AND low_at = 0.
--    This template is a retail POS: checkout deducts stock for every catalogue line
--    (server/routes/orders.js) and there is no "this item isn't stocked" flag. A latte
--    has no meaningful unit count. Seeding 0 would paint a red "Out" pill on all 44
--    tiles permanently (src/views/SalesView.jsx:378 — the `stock <= 0` branch wins
--    before low_at is even consulted), training staff to ignore the badge that is
--    supposed to mean something. A high count with low_at = 0 shows a clean tile and
--    never raises a low-stock alert.
--    CONSEQUENCE: the number drifts down by one per drink sold and will need an
--    occasional reset in Inventory. The real fix is a non-stock-item flag in the
--    template — a gap worth closing upstream, not per shop.
--    Cold Brew Bottle is the exception: it IS a physical stocked item, so it gets a
--    real count and a real reorder point.
--
-- 3. cost = 0 EVERYWHERE, BECAUSE KAN HAS NOT SUPPLIED COSTS.
--    Zero rather than NULL so profit sums stay numeric instead of turning NULL. The
--    visible effect is that Financials / P&L reports 100% margin on every line. That is
--    an honest "no cost data yet" state, not a real figure — load costs before showing
--    the owner the P&L tab.
--
-- Prices are TAX-INCLUSIVE (16% VAT extracted on the receipt): Espresso 2.00 = 1.72
-- net + 0.28 VAT. Taken from Kan's published drinks menu.
--
-- NO SUPPLIERS ARE SEEDED. The liquor template shipped four with invented names and
-- phone numbers; inventing vendor records for a real business is not acceptable. Kan
-- adds their real suppliers in the Receive view, and Receive stays unusable until they do.

begin;

-- ── Categories (drives the chips on Sales + Inventory) ───────────────────────
-- Order matters: this is the left-to-right chip order at the counter, arranged the way
-- the printed menu reads so a barista's eye lands where it already expects to.
insert into app_settings(key, value) values
  ('categories', '["Hot Coffee","Cold Coffee","Tea & Herbs","Hot Kan","Cold Kan","Special"]')
on conflict (key) do update set value = excluded.value;

-- ── Catalogue ────────────────────────────────────────────────────────────────
-- sku | name | price (JOD, tax-inclusive) | cat | cost | stock | low_at | unit
insert into products (barcode, name, price, cat, cost, stock, low_at, unit, active) values
  -- Hot Coffee
  ('KC-HC-01', 'Espresso',            2.00, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-02', 'Espresso Macchiato',  2.25, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-03', 'Lungo',               2.00, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-04', 'Americano',           2.50, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-05', 'V60 / Chemex',        3.75, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-06', 'Cappuccino',          3.25, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-07', 'Cafe Latte',          3.25, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-08', 'Flat White',          3.25, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-09', 'White / Dark Mocha',  3.75, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-10', 'Spanish Latte',       3.75, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-11', 'Caramel Macchiato',   3.75, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-12', 'Cortado',             3.00, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  ('KC-HC-13', 'Turkish',             2.25, 'Hot Coffee',  0, 9999, 0, 'ea', true),
  -- Cold Coffee
  ('KC-CC-01', 'Iced Latte',          3.25, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  ('KC-CC-02', 'Cold Brew',           3.75, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  -- The one genuinely stocked line on the menu: a bottle that sits in a fridge and can
  -- actually run out. Real count, real reorder point, so the "Out"/"left" pills mean
  -- something on this tile and only this tile.
  ('KC-CC-03', 'Cold Brew Bottle',    4.75, 'Cold Coffee', 0,   24, 6, 'ea', true),
  ('KC-CC-04', 'Iced Americano',      2.75, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  ('KC-CC-05', 'Dark / White Mocha',  4.00, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  ('KC-CC-06', 'Spanish Latte',       4.00, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  ('KC-CC-07', 'Caramel Macchiato',   4.00, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  ('KC-CC-08', 'Frappuccino',         4.75, 'Cold Coffee', 0, 9999, 0, 'ea', true),
  -- Tea & Herbs
  -- Chai Karak is deliberately absent: it renders greyed out on Kan's published menu
  -- and the owner confirmed it is not being sold.
  ('KC-TH-01', 'Black / Green',       2.25, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  ('KC-TH-02', 'Persian Tea',         3.00, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  ('KC-TH-03', 'Beduin Tea',          3.00, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  ('KC-TH-04', 'Chai Latte',          3.25, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  ('KC-TH-05', 'Yemeni Tea',          3.25, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  ('KC-TH-06', 'Moroccan Tea',        2.50, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  ('KC-TH-07', 'Ask About Herbs',     2.75, 'Tea & Herbs', 0, 9999, 0, 'ea', true),
  -- Hot Kan
  ('KC-HK-01', 'Hot Chocolate',       3.50, 'Hot Kan',     0, 9999, 0, 'ea', true),
  ('KC-HK-02', 'Hot Lotus',           3.75, 'Hot Kan',     0, 9999, 0, 'ea', true),
  ('KC-HK-03', 'Hot Pistachio',       3.75, 'Hot Kan',     0, 9999, 0, 'ea', true),
  -- Cold Kan
  ('KC-CK-01', 'Mojito',              3.50, 'Cold Kan',    0, 9999, 0, 'ea', true),
  ('KC-CK-02', 'Iced Tea',            3.00, 'Cold Kan',    0, 9999, 0, 'ea', true),
  ('KC-CK-03', 'Smoothies',           4.00, 'Cold Kan',    0, 9999, 0, 'ea', true),
  ('KC-CK-04', 'Fresh Juice',         3.25, 'Cold Kan',    0, 9999, 0, 'ea', true),
  ('KC-CK-05', 'Matcha',              4.00, 'Cold Kan',    0, 9999, 0, 'ea', true),
  ('KC-CK-06', 'Summer Passion',      4.00, 'Cold Kan',    0, 9999, 0, 'ea', true),
  -- Special
  ('KC-SP-01', 'Hot Arabian Latte',   4.00, 'Special',     0, 9999, 0, 'ea', true),
  ('KC-SP-02', 'Hot Spanilla',        4.00, 'Special',     0, 9999, 0, 'ea', true),
  ('KC-SP-03', 'Iced Arabian Latte',  4.25, 'Special',     0, 9999, 0, 'ea', true),
  ('KC-SP-04', 'Iced Spanilla',       4.25, 'Special',     0, 9999, 0, 'ea', true),
  ('KC-SP-05', 'Pomberries Smoothie', 4.25, 'Special',     0, 9999, 0, 'ea', true),
  ('KC-SP-06', 'Matcha (Strawberry-Mango)', 4.25, 'Special', 0, 9999, 0, 'ea', true),
  ('KC-SP-07', 'Affogato',            4.25, 'Special',     0, 9999, 0, 'ea', true)
on conflict (barcode) do update set
  name  = excluded.name,
  price = excluded.price,
  cat   = excluded.cat,
  cost  = excluded.cost,
  -- stock is NOT overwritten on re-run. Re-seeding to fix a price must not silently
  -- reset a real count (Cold Brew Bottle) or wipe the drift on the made-to-order lines
  -- — that would be an unattributable inventory change with no stock_log row.
  low_at = excluded.low_at,
  unit  = excluded.unit,
  active = excluded.active,
  updated_at = now();

commit;
