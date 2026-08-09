-- Liquor Store POS — additive migration (0005)
-- Attribute audit rows to the authenticated user, server-side. Idempotent.
--
-- Before this, `stock_log.changed_by` and the whole `admin_log.action` string came
-- straight from the request body — the person causing shrinkage could also write the
-- record of it. `actor` is now set from the session in the route and is never accepted
-- from the client.

begin;

alter table admin_log add column if not exists actor text;

create index if not exists idx_admin_log_actor    on admin_log(actor);
create index if not exists idx_stock_log_changed  on stock_log(changed_by);

commit;
