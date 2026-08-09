#!/usr/bin/env bash
# Restore drill: prove the latest dump actually restores, WITHOUT touching the live client
# database.
#
# An untested backup is a hypothesis. The failure everyone meets eventually is the one where
# pg_dump exited 0 every night for a year and the file turns out to be truncated, or gzipped
# twice, or missing the extension the schema needs — discovered at 2am on the night it
# matters. This restores into a scratch database, counts what came back, and drops it.
#
# Run it monthly from cron, right after the nightly backup:
#   45 2 1 * * /srv/platform/verify-restore.sh >> /var/log/pos-restore-drill.log 2>&1
#
#   ./verify-restore.sh                # newest dump of every client database
#   ./verify-restore.sh liquorpos      # just this one
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
BACKUP_DIR="$PLATFORM_DIR/backups"
ONLY_DB="${1:-}"

cd "$PLATFORM_DIR"

psql_super() { docker compose exec -T postgres psql -U postgres "$@"; }

# Which databases have dumps on disk.
mapfile -t DBS < <(
  find "$BACKUP_DIR" -name '*.sql.gz' -printf '%f\n' 2>/dev/null \
    | sed -E 's/-[0-9]{8}-[0-9]{6}\.sql\.gz$//' | sort -u
)
if [ "${#DBS[@]}" -eq 0 ]; then
  echo "[drill] no dumps found in $BACKUP_DIR — has backup.sh ever run?"
  exit 1
fi

FAILED=0
for db in "${DBS[@]}"; do
  [ -n "$ONLY_DB" ] && [ "$db" != "$ONLY_DB" ] && continue

  latest=$(find "$BACKUP_DIR" -name "${db}-*.sql.gz" | sort | tail -n1)
  [ -z "$latest" ] && continue

  # Age check: a dump that stopped refreshing is as bad as no dump, and cron failures are
  # quiet by nature.
  age_h=$(( ( $(date +%s) - $(stat -c%Y "$latest") ) / 3600 ))
  if [ "$age_h" -gt 48 ]; then
    echo "[drill] WARNING: newest $db dump is ${age_h}h old — is the nightly cron still running?"
    FAILED=1
  fi

  scratch="restore_drill_${db}"
  echo "[drill] restoring $(basename "$latest") into $scratch"

  psql_super -c "drop database if exists \"$scratch\" with (force)" >/dev/null
  psql_super -c "create database \"$scratch\"" >/dev/null

  if ! gunzip -c "$latest" | docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -q "$scratch" >/dev/null; then
    echo "[drill] FAILED: $db dump did not restore cleanly"
    FAILED=1
    psql_super -c "drop database if exists \"$scratch\" with (force)" >/dev/null
    continue
  fi

  # Restoring without error is necessary but not sufficient — an empty schema restores
  # perfectly. Assert the tables that carry the money are actually populated.
  read -r products orders users < <(
    psql_super -tAF' ' -d "$scratch" -c \
      "select (select count(*) from products), (select count(*) from orders_main), (select count(*) from app_users)" \
      | tr -d '\r'
  )
  echo "[drill] $db restored: ${products} products, ${orders} orders, ${users} users"

  if [ "${users:-0}" -lt 1 ] || [ "${products:-0}" -lt 1 ]; then
    echo "[drill] FAILED: $db restored but looks empty — the dump is not usable"
    FAILED=1
  fi

  psql_super -c "drop database if exists \"$scratch\" with (force)" >/dev/null
done

if [ "$FAILED" -ne 0 ]; then
  echo "[drill] COMPLETED WITH ERRORS"
  exit 1
fi
echo "[drill] ok — backups restore and contain data"
