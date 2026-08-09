-- Dukkan grocery POS — additive migration (0003)
-- Employee fields + time clock. Idempotent.

begin;

alter table app_users add column if not exists full_name text;
alter table app_users add column if not exists wage      numeric default 0;

-- Time clock punches. One open row (clock_out null) per user at a time.
create table if not exists time_clock (
  id         integer generated always as identity primary key,
  user_id    uuid references app_users(id) on delete cascade,
  username   text,
  clock_in   timestamptz default now(),
  clock_out  timestamptz
);
create index if not exists idx_time_clock_user on time_clock(user_id, clock_in desc);

commit;
