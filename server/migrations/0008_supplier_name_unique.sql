-- Make supplier names unique, and merge the duplicates that already exist.
--
-- server/seed-products.sql says "suppliers upsert on name" and ends with `on conflict do
-- nothing` — but nothing was ever unique on `name`, so that clause only ever guarded the
-- serial primary key, which cannot conflict. Every re-run of the seed therefore inserted a
-- fresh copy of all four suppliers. The demo database had each one twice.
--
-- This is not cosmetic. The Receive screen picks a supplier by id from that list, so two
-- rows named "Levant Spirits Import" silently split one distributor's delivery history
-- across two ids: cost-per-supplier and "who did we buy this from" both go wrong, and the
-- person receiving stock has no way to tell the two entries apart.
--
-- Merge rather than delete: batches already pointing at a duplicate are repointed to the
-- surviving row (the lowest id, i.e. the original), so no receiving history is lost.
begin;

with canonical as (
  select min(id) as keep_id, lower(btrim(name)) as key
    from suppliers
   group by lower(btrim(name))
),
dupes as (
  select s.id as dup_id, c.keep_id
    from suppliers s
    join canonical c on c.key = lower(btrim(s.name))
   where s.id <> c.keep_id
)
update batches b set supplier_id = d.keep_id
  from dupes d where b.supplier_id = d.dup_id;

delete from suppliers s
 where s.id <> (select min(id) from suppliers x where lower(btrim(x.name)) = lower(btrim(s.name)));

-- Case-insensitive: "Cellar Direct" and "cellar direct" are one distributor, and a list the
-- staff cannot visually distinguish is the whole problem being fixed here.
create unique index if not exists idx_suppliers_name_unique on suppliers (lower(btrim(name)));

commit;
