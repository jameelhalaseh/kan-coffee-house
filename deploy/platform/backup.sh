#!/usr/bin/env bash
# Nightly backup of every client database on this box.
#
# Heroku gave you this for free; on a VPS it is yours to run. Install once:
#   sudo cp deploy/platform/backup.sh /srv/platform/backup.sh && sudo chmod +x /srv/platform/backup.sh
#   sudo crontab -e
#   15 2 * * * /srv/platform/backup.sh >> /var/log/pos-backup.log 2>&1
#
# Dumps land in ./backups (a bind mount inside the postgres container), then are pushed
# offsite. A backup that only exists on the same disk as the database is not a backup —
# fill in OFFSITE_CMD or you are one dead VPS away from losing every client's sales.
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
BACKUP_DIR="$PLATFORM_DIR/backups"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Offsite push. Examples:
#   OFFSITE_CMD='rclone copy {} b2:7uloul-pos-backups/'
#   OFFSITE_CMD='aws s3 cp {} s3://7uloul-pos-backups/'
# {} is replaced with the dump path.
OFFSITE_CMD="${OFFSITE_CMD:-}"

# Running local-only used to be the DEFAULT and it was silent: cron reported success every
# night while every copy sat on the same disk as the database it was protecting. One dead
# VPS and every client's sales are gone, with fourteen days of green log lines behind it.
# Local-only is still allowed — but it now has to be asked for, in writing, per run.
if [ -z "$OFFSITE_CMD" ] && [ "${ALLOW_LOCAL_ONLY:-0}" != "1" ]; then
  cat >&2 <<'MSG'
[backup] REFUSING TO RUN: no OFFSITE_CMD set.

  A backup on the same disk as the database is not a backup. Set OFFSITE_CMD in
  /srv/platform/.env (or the cron environment) to ship each dump off the box:

    OFFSITE_CMD='rclone copy {} b2:7uloul-pos-backups/'
    OFFSITE_CMD='aws s3 cp {} s3://7uloul-pos-backups/'

  If you genuinely want local-only dumps (a throwaway staging box, never production),
  say so explicitly:

    ALLOW_LOCAL_ONLY=1 /srv/platform/backup.sh
MSG
  exit 2
fi

if [ -z "$OFFSITE_CMD" ]; then
  echo "[backup] WARNING: local-only dumps (ALLOW_LOCAL_ONLY=1). These do NOT survive losing this box."
fi

mkdir -p "$BACKUP_DIR"
cd "$PLATFORM_DIR"

# Every non-template database = every client.
DBS=$(docker compose exec -T postgres psql -U postgres -tAc \
  "select datname from pg_database where datistemplate = false and datname <> 'postgres'")

if [ -z "$DBS" ]; then
  echo "[backup] no client databases found — nothing to do"
  exit 0
fi

FAILED=0
for db in $DBS; do
  out="$BACKUP_DIR/${db}-${STAMP}.sql.gz"
  echo "[backup] dumping $db"
  # --clean --if-exists makes the dump restorable over an existing database.
  if docker compose exec -T postgres pg_dump -U postgres --clean --if-exists "$db" | gzip > "$out"; then
    size=$(stat -c%s "$out")
    # A "successful" dump of a few hundred bytes means it failed silently. Catch it now,
    # not on the night you need to restore.
    if [ "$size" -lt 1024 ]; then
      echo "[backup] ERROR: $db dump is only ${size}B — treating as failure"
      FAILED=1
      continue
    fi
    echo "[backup] $db → $out (${size}B)"
    if [ -n "$OFFSITE_CMD" ]; then
      echo "[backup] shipping offsite"
      # shellcheck disable=SC2086
      eval "${OFFSITE_CMD//\{\}/$out}" || { echo "[backup] ERROR: offsite push failed for $db"; FAILED=1; }
    fi
  else
    echo "[backup] ERROR: pg_dump failed for $db"
    FAILED=1
  fi
done

echo "[backup] pruning local dumps older than ${RETAIN_DAYS} days"
find "$BACKUP_DIR" -name '*.sql.gz' -mtime "+$RETAIN_DAYS" -delete

if [ "$FAILED" -ne 0 ]; then
  echo "[backup] COMPLETED WITH ERRORS"
  exit 1
fi
echo "[backup] ok"
