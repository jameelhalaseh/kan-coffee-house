# CashierPOS — Backup & Recovery Runbook (L13)

Supabase **free tier has no automated backups**. This document is the
recovery plan. Pick at least one off-site option below and run it on a
schedule, or accept that a lost project = lost data.

---

## Backup layers

| Layer | Tool | Protects against | Off-site? | Effort |
|-------|------|------------------|-----------|--------|
| 1. In-DB snapshot | `BACKUP.sql` | accidental delete, bad migration, app bug | ❌ no | 10s, in SQL Editor |
| 2. Off-site dump | `pg_dump` (below) | project deletion, region outage, total loss | ✅ yes | 1 cmd, local |
| 3. Managed | Supabase **Pro** ($25/mo) | everything + point-in-time restore | ✅ yes | upgrade only |

Recommended minimum: **Layer 2 daily** + **Layer 1 before any migration**.

---

## Layer 1 — In-DB snapshot (quick restore point)

**Backup:** paste `BACKUP.sql` into Supabase SQL Editor → Run.
Creates schema `backup_YYYYMMDD_HHMM` holding a copy of every operational table.

**List snapshots:**
```sql
select schema_name from information_schema.schemata
  where schema_name like 'backup_%' order by schema_name desc;
```

**Restore one table** (example: orders) from a snapshot:
```sql
begin;
  truncate public.orders;
  insert into public.orders select * from backup_20260602_1200.orders;
commit;
```

**Clean up old snapshots** (they consume your 500 MB free quota):
```sql
drop schema backup_20260602_1200 cascade;
```

---

## Layer 2 — Off-site dump (the one that actually saves you)

Runs on **your machine**, writes a file you keep off Supabase. Needs your
DB connection string: Supabase Dashboard → Project Settings → Database →
**Connection string** → URI (contains the DB password — never commit it).

**Backup (run in PowerShell):**
```powershell
# one-time: install postgres client tools (gives you pg_dump)
#   winget install PostgreSQL.PostgreSQL

$ts = Get-Date -Format "yyyyMMdd_HHmm"
pg_dump "postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres" `
  --no-owner --no-privileges -F c -f "cashierpos_$ts.dump"
```
Keep the `.dump` file somewhere off-site (Google Drive, external disk).
A full dump of this DB is small (a few MB).

**Restore to a fresh / repaired project:**
```powershell
pg_restore --no-owner --no-privileges --clean --if-exists `
  -d "postgresql://postgres:[PASSWORD]@db.[NEWPROJECT].supabase.co:5432/postgres" `
  cashierpos_20260602_1200.dump
```

> After restoring to a NEW project: re-run `LOCKDOWN.sql`, `PIN_LOCKOUT.sql`,
> and update `REACT_APP_SUPABASE_URL` / `ANON_KEY` repo secrets, then redeploy.

---

## Layer 3 — Supabase Pro (set-and-forget)

Upgrade the project to Pro: daily automated backups (7-day retention) +
point-in-time recovery. Zero scripts. Worth it once the POS handles real
revenue — the $25/mo is cheaper than one lost day of sales data.

---

## Client-side resilience (already in place)

The app caches state in `localStorage` and syncs to Supabase. If Supabase
is briefly unreachable, the current device keeps its last-known data and
re-syncs on reconnect. This is NOT a backup — it is per-device and can be
cleared by the browser. Do not rely on it for recovery.

---

## Recovery drill (do this ONCE to prove it works)

1. Run `BACKUP.sql` → note the snapshot schema name.
2. In a throwaway test row, delete something trivial.
3. Restore that table from the snapshot (Layer 1 steps).
4. Confirm the row is back.
5. Run a `pg_dump` (Layer 2), confirm the `.dump` file is non-empty.

An untested backup is not a backup. Run the drill.
