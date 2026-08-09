-- Liquor Store POS — demo catalogue seed.
-- Idempotent: products upsert on the unique barcode, suppliers upsert on name.
-- Apply AFTER `npm run migrate`:
--   psql "$DATABASE_URL" -f server/seed-products.sql
--   or: npm run seed:products

begin;

-- ── Categories (drives the chips on Sales + Inventory) ───────────────────────
insert into app_settings(key, value) values
  ('categories', '["Whiskey","Vodka","Gin","Rum","Tequila","Brandy","Arak","Liqueur","Wine","Beer","Champagne","Mixers","Accessories"]')
on conflict (key) do update set value = excluded.value;

-- ── Suppliers (Receive view) ─────────────────────────────────────────────────
insert into suppliers (name, phone, note, active) values
  ('Levant Spirits Import',  '+962 6 500 1100', 'Main spirits distributor — weekly delivery', true),
  ('Amman Beverage Co.',     '+962 6 500 2200', 'Beer + mixers, Sunday/Wednesday',            true),
  ('Cellar Direct Wines',    '+962 7 900 3300', 'Wine & champagne, order 3 days ahead',       true),
  ('Local Arak Distillery',  '+962 7 900 4400', 'Arak only, cash on delivery',                true)
on conflict do nothing;

-- ── Catalogue ────────────────────────────────────────────────────────────────
-- barcode | name | price (JOD, tax-inclusive display) | cat | cost | stock | unit
insert into products (barcode, name, price, cat, cost, stock, unit, active) values
  -- Whiskey
  ('5000267023656', 'Johnnie Walker Black Label 750ml', 38.00, 'Whiskey',     26.50, 24, 'ea', true),
  ('5000267014302', 'Johnnie Walker Red Label 750ml',   24.00, 'Whiskey',     16.00, 30, 'ea', true),
  ('5000267170800', 'Johnnie Walker Blue Label 750ml',  185.00,'Whiskey',    148.00,  4, 'ea', true),
  ('5010314302108', 'Jack Daniel''s Old No.7 700ml',     32.00, 'Whiskey',     22.00, 28, 'ea', true),
  ('5010106113127', 'Glenfiddich 12yr 700ml',            52.00, 'Whiskey',     38.00, 12, 'ea', true),
  ('5010314100109', 'Chivas Regal 12yr 700ml',           40.00, 'Whiskey',     28.00, 18, 'ea', true),
  ('5010103801003', 'Ballantine''s Finest 1L',           27.00, 'Whiskey',     18.50, 22, 'ea', true),
  ('0080686032106', 'Jameson Irish Whiskey 700ml',       30.00, 'Whiskey',     21.00,  3, 'ea', true),
  -- Vodka
  ('5452000032102', 'Absolut Vodka 700ml',               22.00, 'Vodka',       14.50, 36, 'ea', true),
  ('7610100010005', 'Smirnoff Red No.21 1L',             19.00, 'Vodka',       12.00, 40, 'ea', true),
  ('4750021000188', 'Grey Goose 700ml',                  55.00, 'Vodka',       41.00,  9, 'ea', true),
  ('5060045490018', 'Belvedere 700ml',                   52.00, 'Vodka',       39.00,  2, 'ea', true),
  ('8710128000042', 'Stolichnaya 700ml',                 21.00, 'Vodka',       13.50, 15, 'ea', true),
  -- Gin
  ('5010677714002', 'Tanqueray London Dry 700ml',        29.00, 'Gin',         20.00, 16, 'ea', true),
  ('5000299221136', 'Bombay Sapphire 700ml',             31.00, 'Gin',         21.50, 14, 'ea', true),
  ('5010327755113', 'Hendrick''s Gin 700ml',             47.00, 'Gin',         35.00,  6, 'ea', true),
  ('5000289927796', 'Gordon''s London Dry 1L',           20.00, 'Gin',         13.00, 20, 'ea', true),
  -- Rum
  ('7501035042001', 'Bacardi Carta Blanca 750ml',        21.00, 'Rum',         14.00, 26, 'ea', true),
  ('5010296003468', 'Captain Morgan Spiced Gold 1L',     25.00, 'Rum',         17.00, 18, 'ea', true),
  ('7610594000021', 'Havana Club 7yr 700ml',             33.00, 'Rum',         23.00,  7, 'ea', true),
  -- Tequila
  ('7501035010109', 'Jose Cuervo Especial Gold 700ml',   28.00, 'Tequila',     19.00, 13, 'ea', true),
  ('7500462476014', 'Patron Silver 700ml',               68.00, 'Tequila',     52.00,  5, 'ea', true),
  ('7501083530010', 'Olmeca Blanco 700ml',               24.00, 'Tequila',     16.00,  4, 'ea', true),
  -- Brandy / Cognac
  ('3049197001504', 'Hennessy VS 700ml',                 62.00, 'Brandy',      47.00,  8, 'ea', true),
  ('3049195100108', 'Martell VS 700ml',                  55.00, 'Brandy',      41.00,  6, 'ea', true),
  ('8410261000015', 'Torres 10 Brandy 700ml',            26.00, 'Brandy',      17.50, 11, 'ea', true),
  -- Arak
  ('5281000010012', 'Arak Touma 750ml',                  23.00, 'Arak',        15.00, 20, 'ea', true),
  ('5281000020011', 'Arak Massaya 750ml',                29.00, 'Arak',        20.00, 12, 'ea', true),
  ('6251000030014', 'Arak Haddad 750ml',                 18.00, 'Arak',        11.00,  9, 'ea', true),
  -- Liqueur
  ('4008300010005', 'Jägermeister 700ml',                27.00, 'Liqueur',     18.50, 17, 'ea', true),
  ('5011013100019', 'Baileys Irish Cream 700ml',         24.00, 'Liqueur',     16.00, 21, 'ea', true),
  ('8000040011006', 'Campari 700ml',                     26.00, 'Liqueur',     18.00,  8, 'ea', true),
  ('9002859031007', 'Aperol 700ml',                      23.00, 'Liqueur',     15.50, 10, 'ea', true),
  -- Wine
  ('3282111008019', 'Bordeaux Rouge AOC 750ml',          18.00, 'Wine',        11.00, 30, 'ea', true),
  ('8410415510017', 'Rioja Crianza 750ml',               21.00, 'Wine',        13.50, 24, 'ea', true),
  ('5281002010013', 'Ksara Reserve du Couvent 750ml',    19.00, 'Wine',        12.00, 26, 'ea', true),
  ('9300727001009', 'Yellow Tail Shiraz 750ml',          15.00, 'Wine',         9.00, 33, 'ea', true),
  ('3760040170015', 'Provence Rosé 750ml',               22.00, 'Wine',        14.00,  6, 'ea', true),
  -- Champagne / Sparkling
  ('3049614088001', 'Moët & Chandon Impérial 750ml',     72.00, 'Champagne',   55.00,  6, 'ea', true),
  ('3049614160004', 'Veuve Clicquot Brut 750ml',         85.00, 'Champagne',   66.00,  3, 'ea', true),
  ('8003625000018', 'Prosecco DOC Extra Dry 750ml',      17.00, 'Champagne',   10.50, 18, 'ea', true),
  -- Beer
  ('8712000030001', 'Heineken 330ml can',                 1.60, 'Beer',         1.00,240, 'ea', true),
  ('5410228142805', 'Stella Artois 330ml bottle',         1.80, 'Beer',         1.15,180, 'ea', true),
  ('4006020010009', 'Corona Extra 355ml bottle',          2.10, 'Beer',         1.35,144, 'ea', true),
  ('5411681005010', 'Amstel 500ml can',                   2.00, 'Beer',         1.25, 96, 'ea', true),
  ('6251010050017', 'Petra Lager 500ml can',              1.50, 'Beer',         0.90,120, 'ea', true),
  ('5010134510019', 'Guinness Draught 440ml can',         3.20, 'Beer',         2.10, 48, 'ea', true),
  -- Mixers
  ('5449000000996', 'Coca-Cola 1L',                       1.10, 'Mixers',       0.65, 60, 'ea', true),
  ('5449000011527', 'Sprite 1L',                          1.10, 'Mixers',       0.65, 48, 'ea', true),
  ('5000112611854', 'Schweppes Tonic Water 1L',           1.60, 'Mixers',       0.95, 54, 'ea', true),
  ('5000112630015', 'Schweppes Soda Water 1L',            1.50, 'Mixers',       0.90, 40, 'ea', true),
  ('6281000010015', 'Ice Cubes 2kg bag',                  1.00, 'Mixers',       0.45, 35, 'ea', true),
  ('5449000131805', 'Red Bull 250ml can',                 1.40, 'Mixers',       0.90, 72, 'ea', true),
  -- Accessories
  ('6251020010012', 'Corkscrew — waiter''s friend',       4.50, 'Accessories',  2.20, 15, 'ea', true),
  ('6251020020011', 'Wine Gift Box (single)',             3.00, 'Accessories',  1.30, 40, 'ea', true),
  ('6251020030010', 'Whiskey Glass — set of 2',           9.00, 'Accessories',  5.00, 12, 'ea', true),
  ('6251020040019', 'Bottle Opener',                      1.50, 'Accessories',  0.60, 50, 'ea', true)
on conflict (barcode) do update set
  name  = excluded.name,
  price = excluded.price,
  cat   = excluded.cat,
  cost  = excluded.cost,
  stock = excluded.stock,
  unit  = excluded.unit,
  active = excluded.active,
  updated_at = now();

commit;
