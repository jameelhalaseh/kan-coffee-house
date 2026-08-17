-- Per-PRODUCT artwork (0012).
--
-- category_images (0009) holds one picture per CATEGORY, and its own comment says it is
-- "not a general media store". This is the sibling table for the other grain: one picture
-- per product, so a shop can put a photo of the actual drink on its sales tile instead of
-- the category's generic artwork.
--
-- WHY A SECOND TABLE RATHER THAN A COLUMN ON products
-- `select * from products` is the catalogue fetch every till makes at login and after every
-- edit. A bytea column there would drag ~150KB per row into that response — six megabytes
-- to render a grid that needs names and prices — and every product write would rewrite the
-- image bytes with it. Keeping the bytes in their own table means the catalogue query is
-- untouched and images are fetched once, individually, and then cached immutably.
--
-- WHY THE DATABASE AND NOT THE FILESYSTEM
-- Same reason as 0009, unchanged: this app deploys to a Docker volume on a VPS (fine) and to
-- Heroku (an ephemeral filesystem, not fine — restarts discard uploads silently and the shop
-- finds out weeks later when the tiles go blank). Bytes in Postgres behave identically on
-- both and the existing backup covers them with no second job to remember.
--
-- ON DELETE CASCADE, deliberately: an image for a product that no longer exists is
-- unreachable by every code path and would only ever be dead weight in the backup.
begin;

create table if not exists product_images (
  product_id integer primary key references products(id) on delete cascade,
  mime       text not null default 'image/png',
  bytes      bytea not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

commit;
