-- Make the starter expense list a COFFEE SHOP's, not an off-licence's.
--
-- 0003 seeded the list this module shipped with, written for a liquor shop: its one
-- shop-specific entry was an alcohol licence, and the three lines a cafe actually spends the
-- most on every week - beans, milk, cups - were not on it. The Expenses picker is the first
-- thing an owner meets on that tab, and a list that does not name their real costs teaches
-- them to type a new type for every entry, which is how a P&L ends up with 'milk', 'Milk' and
-- 'dairy' as three separate lines.
--
-- The type is free TEXT on each expense row, so this changes what is OFFERED, never what was
-- recorded: anything typed into the field still joins the list, and nothing here rewrites a
-- historical expense.

-- The cafe's own cost lines. 'Rent', 'Electricity', 'Water', 'Salaries', 'Maintenance',
-- 'Transport & delivery', 'Bank & card fees', 'Licence & permits' and 'Other' all came from
-- 0003 and are kept: they are generic to any shop with a door and a card machine.
insert into expense_types (name) values
  ('Coffee beans'),
  ('Milk & dairy'),
  ('Syrups & sauces'),
  ('Tea & herbs'),              -- Kan sells a whole Tea & Herbs shelf; it has a supply cost
  ('Cups, lids & napkins'),     -- the counter-service equivalent of packaging
  ('Cleaning & hygiene'),
  ('Gas'),                      -- for the kitchen side, if the shop ever runs one
  ('Internet & phone')          -- the card machine and the tills both depend on it
on conflict (lower(btrim(name))) do nothing;

-- 'Packaging & bags' was the off-licence's wording for what a cafe calls cups and lids, so it
-- now duplicates the row added above. Dropped only if no expense has ever been filed under it:
-- deleting a type that a historical row still names would leave that row pointing at a label
-- the picker can no longer offer.
delete from expense_types et
 where lower(btrim(et.name)) = 'packaging & bags'
   and not exists (
     select 1 from expenses e
      where lower(btrim(e.type)) = lower(btrim(et.name))
   );
