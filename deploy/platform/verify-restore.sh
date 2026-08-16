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

# A drill that fails silently is worse than no drill: it is a monthly cron line reporting
# success while the backups it checks are unrestorable. Same webhook and shape as backup.sh
# and the API's own alerts.
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

notify() {
  [ -n "$ALERT_WEBHOOK_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"[ALERT] pos-restore-drill: $1\n$2\",\"service\":\"pos-restore-drill\",\"title\":\"$1\"}" \
    "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || echo "[drill] WARNING: alert delivery failed"
  return 0
}

# Any nonzero exit, for the same reason as backup.sh: this script dies under `set -e` well
# before its own failure branch if Docker is down or there are no dumps at all, and "no
# dumps exist" is precisely the state you must hear about.
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    notify "restore drill FAILED (exit ${rc})" \
      "Backups on $(hostname) could not be verified - they cannot currently be trusted. See /var/log/pos-restore-drill.log."
  fi
  exit "$rc"
}
trap on_exit EXIT

cd "$PLATFORM_DIR"

psql_super() { docker compose exec -T postgres psql -U postgres "$@"; }

# Which databases have dumps on disk.
#
# -maxdepth 1 keeps this on the DAILY tier. backup.sh --hourly writes into backups/hourly,
# and those are the short-lived damage-limiting copies — the dump that has to be provably
# restorable is the one retained for fourteen days. Drilling the hourly tier would also make
# the age check below meaningless, since an hourly dump is never more than an hour old and
# would report healthy on a box where the nightly cron had been dead for a week.
mapfile -t DBS < <(
  find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.gz' -printf '%f\n' 2>/dev/null \
    | sed -E 's/-[0-9]{8}-[0-9]{6}\.sql\.gz$//' | sort -u \
    | grep -v '^restore_drill_' || true
)
if [ "${#DBS[@]}" -eq 0 ]; then
  echo "[drill] no dumps found in $BACKUP_DIR — has backup.sh ever run?"
  exit 1
fi

FAILED=0
for db in "${DBS[@]}"; do
  [ -n "$ONLY_DB" ] && [ "$db" != "$ONLY_DB" ] && continue

  latest=$(find "$BACKUP_DIR" -maxdepth 1 -name "${db}-*.sql.gz" | sort | tail -n1)
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
  # `|| true`: under `set -e` a failing count query kills the whole script HERE, before the
  # drop below, leaving restore_drill_<client> behind — which backup.sh then treats as a
  # client and dumps forever. The query failing is itself a finding (a dump missing the money
  # tables is a bad dump), so it must be reported and cleaned up, not fatal.
  counts=$(psql_super -tAF' ' -d "$scratch" -c \
    "select (select count(*) from products), (select count(*) from orders_main), (select count(*) from app_users)" \
    2>&1 | tr -d '\r') || true
  read -r products orders users <<<"$counts"

  if [ -z "${users:-}" ] || ! [ "${users}" -ge 0 ] 2>/dev/null; then
    echo "[drill] FAILED: $db restored but the money tables could not be counted:"
    echo "        $counts"
    FAILED=1
  else
    echo "[drill] $db restored: ${products} products, ${orders} orders, ${users} users"
    if [ "${users:-0}" -lt 1 ] || [ "${products:-0}" -lt 1 ]; then
      echo "[drill] FAILED: $db restored but looks empty — the dump is not usable"
      FAILED=1
    fi
  fi

  psql_super -c "drop database if exists \"$scratch\" with (force)" >/dev/null
done

if [ "$FAILED" -ne 0 ]; then
  # The EXIT trap sends the alert — see backup.sh for why it lives there.
  echo "[drill] COMPLETED WITH ERRORS"
  exit 1
fi
echo "[drill] ok — backups restore and contain data"
