-- Dukkan grocery POS — Heroku Postgres schema (0001)
-- Single-store, barcode-driven grocery. Authorization is enforced by the Express API
-- (the only DB client), not by the database. Apply with:  npm run migrate
--   or:  psql "$DATABASE_URL" -f server/migrations/0001_schema.sql

begin;

create extension if not exists pgcrypto;

-- ── Products (the grocery catalogue) ──────────────────────────────────────────
-- A product is identified to the cashier by its barcode (the scanned code). `id` is the
-- internal serial PK; `barcode` is the human/scanner key and is UNIQUE so a scan resolves
-- to exactly one product. stock is NUMERIC for forgiving counts (units only in v1).
create table if not exists products (
  id         integer generated always as identity primary key,
  barcode    text unique,
  name       text not null,
  price      numeric default 0,
  cat        text,
  cost       numeric default 0,
  stock      numeric default 0,
  active     boolean default true,
  updated_at timestamptz default now()
);
create index if not exists idx_products_barcode on products(barcode);
create index if not exists idx_products_cat      on products(cat);

-- ── Sales (orders_main) ───────────────────────────────────────────────────────
-- One physical table per store (here just `main`). Columns mirror the generic orders
-- route so it works unchanged. items is jsonb (the cart line items). tax/svc/disc stay
-- for schema compatibility but are 0 in this tax-free grocery build.
create table if not exists orders_main (
  id         text primary key,
  table_id   integer,
  items      jsonb,
  sub        numeric,
  tax        numeric default 0,
  svc        numeric default 0,
  disc       numeric default 0,
  disc_pct   numeric default 0,
  disc_staff text,
  total      numeric,
  pay        text,
  waiter     text,
  status     text,
  split_data jsonb,
  date       text,
  time       text,
  invoice_no bigint,
  floor      text,
  buyer      text,
  created_at timestamptz default now()
);
create unique index if not exists uq_orders_main_invoice on orders_main(invoice_no);
create index        if not exists idx_orders_main_created on orders_main(created_at desc);

-- ── Stock audit log (append-only) ─────────────────────────────────────────────
create table if not exists stock_log (
  id         bigint generated always as identity primary key,
  kind       text,            -- 'sale' | 'adjust' | 'restock' | 'create'
  item_id    text,            -- product id as text
  name       text,
  old_qty    numeric,
  new_qty    numeric,
  changed_by text,
  created_at timestamptz default now()
);
create index if not exists idx_stock_log_created on stock_log(created_at desc);

-- ── Auth: single-active-session-per-user ──────────────────────────────────────
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  email         text,
  role          text not null default 'user' check (role in ('admin','user')),
  allowed_views text[] not null default '{}',
  pass_hash     text not null,
  session_token text,
  token_exp     timestamptz,
  reset_code    text,
  reset_exp     timestamptz,
  active        boolean not null default true,
  created_at    timestamptz default now()
);

create table if not exists pin_attempts (
  id           text primary key,   -- e.g. 'login:<username>'
  fails        int default 0,
  locked_until timestamptz
);

create table if not exists app_settings (
  key   text primary key,
  value text
);

create table if not exists admin_log (
  id         text primary key default gen_random_uuid()::text,
  action     text,
  created_at timestamptz default now()
);

-- Customer capture at checkout (optional PII) — kept for the generic accounts route.
create table if not exists customers (
  id         bigint generated always as identity primary key,
  order_id   text,
  name       text,
  mobile     text,
  created_at timestamptz default now()
);

-- ── Functions ─────────────────────────────────────────────────────────────────
-- app_next_invoice(store): gap-reusing invoice numberer, advisory-locked per store.
-- Resolves orders_<store> at call time; the store name is validated via to_regclass and
-- only ever passed through %I (quote_ident) — never concatenated raw into SQL.
create or replace function app_next_invoice(p_floor text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_next bigint;
  v_tbl  text := 'orders_' || p_floor;
begin
  if to_regclass(v_tbl) is null then
    raise exception 'app_next_invoice: unknown store %', p_floor;
  end if;
  perform pg_advisory_xact_lock(745219, hashtext(p_floor));
  execute format(
    'select coalesce(min(t.n), 1)
       from generate_series(1, (select coalesce(max(invoice_no), 0) + 1 from %1$I)) as t(n)
       left join %1$I o on o.invoice_no = t.n
      where o.invoice_no is null', v_tbl)
  into v_next;
  return v_next;
end;
$$;

-- ── Reference seeds (non-secret only) ─────────────────────────────────────────
-- Default product categories (the admin can edit these in-app via app_settings).
insert into app_settings(key, value) values
  ('categories', '["Drinks","Snacks","Dairy","Produce","Bakery","Household","Frozen","Other"]')
on conflict (key) do nothing;

-- Credentials (app_users) are NOT seeded here — use `npm run seed:admin`.

commit;
