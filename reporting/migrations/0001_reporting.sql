-- Reporting module schema (§1). Applied by reporting/migrate.js, which keeps its OWN ledger
-- (reporting_migrations) so this never entangles with server/migrations.
--
-- WHY `date` IS TEXT
-- §3 filters with a lexicographic string comparison on a zero-padded YYYY-MM-DD column, and
-- §3's [QUIRK] forbids a business-day shift in reports. A date/timestamptz column would drag
-- a timezone into every comparison — which is exactly how the operational 02:00 shift would
-- creep back in. The format is load-bearing, so it is enforced by a CHECK rather than left to
-- the callers.
--
-- WHY numeric(14,4)
-- Stored money is written already rounded (r2 at checkout), but four decimals leave room for
-- a historical row that carries more, so §4's "the TOTAL row may differ from the sum of the
-- rounded cells" stays reproducible against real data instead of being a test-only artefact.
-- pg returns numeric as a STRING, which reporting/decimal.js parses exactly — no float ever
-- touches a stored value.

create table if not exists orders (
  id          text primary key,
  invoice_no  bigint,
  floor       text not null,
  table_id    text,
  items       jsonb not null default '[]'::jsonb,
  sub         numeric(14,4) not null default 0,
  tax         numeric(14,4) not null default 0,
  svc         numeric(14,4) not null default 0,
  disc        numeric(14,4) not null default 0,
  disc_pct    numeric(6,2)  not null default 0,
  total       numeric(14,4) not null default 0,
  pay         text,
  waiter      text,
  status      text not null default 'open',
  date        text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  time        text not null default '' check (time = '' or time ~ '^\d{2}:\d{2}$'),
  created_at  timestamptz not null default now()
);

-- Every report reads one store over a date window, so the store key leads the index.
create index if not exists idx_orders_floor_date on orders (floor, date);
-- Sales is the hot path and excludes everything but 'done'; a partial index keeps the void
-- and open rows out of it entirely.
create index if not exists idx_orders_floor_done on orders (floor, date) where status = 'done';
-- Invoice numbers are per store, not global: two stores each issue their own #1.
create unique index if not exists idx_orders_invoice_floor on orders (floor, invoice_no)
  where invoice_no is not null;

-- Expense types are a SHARED GLOBAL list — deliberately NOT floor-scoped (§5.2).
create table if not exists expense_types (
  id   bigserial primary key,
  name text not null
);
create unique index if not exists idx_expense_types_name on expense_types (lower(btrim(name)));

create table if not exists expenses (
  id             bigserial primary key,
  floor          text not null,
  -- FREE TEXT, not a foreign key. Deleting a type from the shared list must never rewrite or
  -- orphan a historical expense — the row keeps the label it was saved with (§5.2).
  type           text not null,
  value          numeric(14,4) not null default 0,
  supplier       text not null default '',
  date           text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  payment_method text not null check (payment_method in ('cheque','petty_cash')),
  note           text not null default '',
  created_at     timestamptz not null default now()
);
create index if not exists idx_expenses_floor_date on expenses (floor, date, created_at);

-- Partners are FIXED SEEDED SLOTS — the report never creates or deletes them (§5.4), so the
-- slot is unique per store and rows are inserted by the seed, not by the API.
create table if not exists partners (
  id               bigserial primary key,
  floor            text not null,
  slot             int  not null,
  label            text not null,
  name             text not null default '',
  starting_balance numeric(14,4) not null default 0
);
create unique index if not exists idx_partners_floor_slot on partners (floor, slot);

create table if not exists partner_draws (
  id         bigserial primary key,
  partner_id bigint not null references partners (id) on delete restrict,
  floor      text not null,
  date       text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  amount     numeric(14,4) not null default 0,
  note       text not null default '',
  created_at timestamptz not null default now()
);
-- on delete RESTRICT above, not CASCADE: a partner's balance is derived from their draws, so
-- deleting the partner row would silently rewrite history that partners hold paper copies of.
create index if not exists idx_draws_partner on partner_draws (partner_id, date, created_at);

create table if not exists entrance_tickets (
  id         text primary key,
  ticket_no  text,
  floor      text not null,
  qty        int,
  fee        numeric(14,4) not null default 0,
  pay        text,
  name       text not null default '',
  phone      text not null default '',
  status     text not null default 'waiting' check (status in ('waiting','redeemed')),
  drink      jsonb,
  date       text not null check (date ~ '^\d{4}-\d{2}-\d{2}$'),
  time       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists idx_tickets_floor_date on entrance_tickets (floor, date);
