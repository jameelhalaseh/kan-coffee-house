-- Retire the restaurant-only half of the reporting schema.
--
-- 0001 was written for two restaurants (gg / dealer) with door takings and capital partners.
-- This build is the single-store liquor shop: it has no door, no partners, and its sales have
-- always lived in orders_main. Everything below either belongs to those shops or duplicates a
-- table the app already owns.
--
-- THIS MIGRATION DELETES DATA. Everything it removes was created by reporting/seed-demo.js —
-- generated demo rows for shops that are not this one. It touches nothing the till wrote:
-- orders_main, products, stock_log and app_settings are not referenced here.

-- The module's own `orders` table: a parallel universe of sales the till never made. Sales
-- now read orders_main directly (reporting/pgRepo.js), which is the only table checkout
-- writes to.
drop table if exists orders;

-- Door takings: this shop has no entrance.
drop table if exists entrance_tickets;

-- Capital partners and their draws. Dropped in FK order — partner_draws references partners
-- with on delete restrict, so the child goes first.
drop table if exists partner_draws;
drop table if exists partners;

-- Expenses and expense types survive: Profit & Loss needs them, and they are the one thing
-- this module adds that the app did not already have.

-- Demo expense rows belonging to the two restaurants. There is exactly one store now, so any
-- row on another floor is unreachable by every report.
delete from expenses where floor <> 'main';

-- The seeded restaurant expense types. Named individually rather than truncated, so a type
-- the shop has since added by hand is left alone.
delete from expense_types where lower(btrim(name)) in ('gas','ice','cleaning','repairs','rent');

-- One store, so default the column rather than making every insert repeat it.
alter table expenses alter column floor set default 'main';
