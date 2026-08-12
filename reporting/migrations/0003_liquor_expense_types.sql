-- Starter expense types for an off-licence.
--
-- 0002 removed the restaurant's list (Gas, Ice, Cleaning, Repairs, Rent). Without a list the
-- Expenses tab opens with an empty picker, which reads as a broken screen rather than an empty
-- one — the shop has no way to tell that the feature works, only that nothing is in it.
--
-- These are a starting point, not a fixed vocabulary: the type is stored on each expense as
-- free TEXT, so anything typed into the field is added to this list and deleting one from the
-- list never rewrites a historical row.
insert into expense_types (name) values
  ('Rent'),
  ('Electricity'),
  ('Water'),
  ('Salaries'),
  ('Licence & permits'),      -- an alcohol licence is the one an off-licence cannot forget
  ('Transport & delivery'),
  ('Maintenance'),
  ('Packaging & bags'),
  ('Bank & card fees'),       -- card settlement charges, which the P&L would otherwise miss
  ('Other')
on conflict (lower(btrim(name))) do nothing;
