-- Drop batch expiry tracking.
--
-- This build is a liquor store. Spirits, wine and beer do not carry a use-by date the way
-- the dairy/grocery template they were inherited from did, so `batches.expiry` was a field
-- staff had to skip on every receipt and an alert panel that was permanently empty. Empty
-- alert panels are worse than absent ones: they train people to ignore the bell.
--
-- The batch row itself stays — it is the supplier + cost + qty history behind every restock.
-- Only the date column and its index go.
begin;

drop index if exists idx_batches_expiry;
alter table batches drop column if exists expiry;

commit;
