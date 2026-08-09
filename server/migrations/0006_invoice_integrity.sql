-- Liquor Store POS — migration 0006: invoice-sequence integrity. Idempotent.
--
-- TWO RELATED PROBLEMS, both fatal to a tax-auditable invoice sequence:
--
--   1. app_next_invoice() reused gaps: it returned the smallest UNUSED number, so deleting
--      invoice #7 caused the next sale to be issued #7 again. Two different sales, same
--      invoice number, at different times — the sequence no longer identifies a sale.
--
--   2. DELETE /api/orders/:id hard-deleted the row, which is what created those gaps. The
--      sale simply vanished; stock stayed deducted, so the goods were gone with no record.
--
-- Fix: numbering becomes strictly increasing (max+1, never reused), and cancellation
-- becomes a VOID that keeps the row and its number. A voided invoice still exists, still
-- occupies its number, and is visibly marked — which is exactly what an auditor expects.

begin;

-- ── Void marking ──────────────────────────────────────────────────────────────
alter table orders_main add column if not exists voided_at   timestamptz;
alter table orders_main add column if not exists voided_by   text;
alter table orders_main add column if not exists void_reason text;

create index if not exists idx_orders_main_voided on orders_main(voided_at);

-- ── Strictly increasing invoice numbers ───────────────────────────────────────
-- Same safety as before: the store key is validated with to_regclass and only ever reaches
-- SQL through %I (quote_ident) — never concatenated raw. Still advisory-locked per store so
-- two concurrent checkouts cannot be handed the same number.
--
-- The difference is coalesce(max(invoice_no),0)+1 instead of the generate_series gap hunt:
-- a number is issued once and never comes back, even after a void.
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
  execute format('select coalesce(max(invoice_no), 0) + 1 from %1$I', v_tbl)
  into v_next;
  return v_next;
end;
$$;

commit;
