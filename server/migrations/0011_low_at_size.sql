-- Per-product reorder point and bottle size (0011)
--
-- low_at replaces a hard-coded 5 that appeared in four places (the sidebar bell, the
-- Reports panel, the AI insight query and the sales tile badge). A shop that turns over
-- forty crates of beer a week and two bottles of a rare arak cannot share one threshold:
-- the beer is a crisis at 20 and the arak is fine at 2. Default 5 so every existing row
-- keeps exactly the behaviour it has today.
--
-- size is the bottle/can size as it is printed on the label — '500ml', '750ml', '1L'. It is
-- FREE TEXT and optional, not an enum: the presets in the product form cover most of the
-- shelf, but a 1.75L handle and a 200ml miniature are both real and neither should require
-- a migration to sell. It is descriptive only — nothing computes with it.

begin;

alter table products add column if not exists low_at numeric default 5;
alter table products add column if not exists size   text;

comment on column products.low_at is
  'Reorder point for THIS product. stock <= low_at raises the low-stock warning.';
comment on column products.size is
  'Label size, free text ("750ml", "1L"). Descriptive only — no arithmetic depends on it.';

commit;
