-- User-uploaded artwork for a product category.
--
-- Thirteen categories ship with bundled artwork in src/assets/categories/, but the category
-- list is user-editable: a shop that adds "Cigars" or "Soft Drinks" gets a coloured letter
-- badge and no way to improve it. This table is where their own picture lives.
--
-- WHY THE DATABASE AND NOT THE FILESYSTEM
-- This app deploys two ways: Docker Compose on a VPS (a volume, which would be fine) and
-- Heroku (an ephemeral filesystem, which would not — every dyno restart silently discards
-- uploaded files, and the shop finds out weeks later when the tiles go blank). Bytes in
-- Postgres behave identically on both, and the nightly backup that already exists covers
-- them without anyone remembering to add a second job.
--
-- The images are small and few — one per category, normalised to 512x512 by the browser
-- before upload — so bytea is the right shape here. This is not a general media store.
begin;

create table if not exists category_images (
  -- The category name, lowercased and trimmed. Same key the client resolves artwork by
  -- (categoryImage() in src/assets/categories/index.js), so "Whiskey" and "whiskey" cannot
  -- end up with two different pictures.
  cat        text primary key,
  mime       text not null default 'image/png',
  bytes      bytea not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

commit;
