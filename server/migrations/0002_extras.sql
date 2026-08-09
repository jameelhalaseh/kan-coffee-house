-- Dukkan grocery POS — additive migration (0002)
-- Adds: weighed-item unit, suppliers, and received stock batches (expiry tracking).
-- Idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) so it is safe to re-run.

begin;

-- Weighed items: 'ea' (each / by unit) or 'kg' (by weight). price is per-unit OR per-kg.
alter table products add column if not exists unit text default 'ea';

-- Suppliers / vendors.
create table if not exists suppliers (
  id         integer generated always as identity primary key,
  name       text not null,
  phone      text,
  note       text,
  active     boolean default true,
  created_at timestamptz default now()
);

-- Received stock batches (lots). Each restock records qty, cost, expiry and the supplier.
-- Drives the expiry alert and supplier history. product.stock holds the running total.
create table if not exists batches (
  id          integer generated always as identity primary key,
  product_id  integer not null references products(id) on delete cascade,
  supplier_id integer references suppliers(id) on delete set null,
  qty         numeric default 0,
  cost        numeric default 0,
  expiry      date,
  received_at timestamptz default now()
);
create index if not exists idx_batches_expiry  on batches(expiry);
create index if not exists idx_batches_product on batches(product_id);

commit;
