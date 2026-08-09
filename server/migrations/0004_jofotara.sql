-- Liquor Store POS — additive migration (0004)
-- JoFotara (فوترة) submission state per sale. Idempotent.
--
-- One sale = one e-invoice. We keep the submission outcome ON the order row so History can
-- show status without a second table, and so a resend is always idempotent against the
-- authority: status 'sent' means ISTD accepted it and returned a UUID + QR.
--
--   status: null (never sent) | 'sending' | 'sent' | 'failed'
--   uuid:   the invoice UUID we generated and submitted (stable across retries)
--   qr:     the QR payload ISTD returns; printed on the customer receipt
--   error:  last failure message, for the cashier/accountant to act on

begin;

alter table orders_main add column if not exists jofotara_status  text;
alter table orders_main add column if not exists jofotara_uuid    text;
alter table orders_main add column if not exists jofotara_qr      text;
alter table orders_main add column if not exists jofotara_error   text;
alter table orders_main add column if not exists jofotara_sent_at timestamptz;

create index if not exists idx_orders_main_jofotara on orders_main(jofotara_status);

commit;
