#!/usr/bin/env bash
# Backup of every client database on this box. Two tiers:
#
#   daily  (default) — the keeper. Retained 14 days, runs once at 02:15.
#   hourly (--hourly) — the damage limiter. Retained 3 days, runs through trading hours.
#
# WHY TWO TIERS. A once-nightly dump means a disk failure at 21:00 loses everything rung
# since midnight — for an off-licence that is the entire trading day, the busiest hours
# included, across every shop on the box. The tills hold unsynced sales locally (the app's
# offline queue), but anything already synced is gone with the disk. Hourly dumps cut the
# worst case from ~19 hours of sales to ~1. That is not the same guarantee as continuous WAL
# archiving — pgBackRest with point-in-time recovery is the real answer and the right thing
# to move to as shop count grows — but it is one cron line instead of a new component, and
# it removes most of the exposure tonight.
#
# Hourly dumps are NOT retained for long on purpose: 17 dumps a day at 14 days' retention is
# 238 copies per shop sitting on the same disk (and in the same bucket) as the daily ones,
# which buys nothing. Three days is enough to notice a problem and reach for one.
#
# Install once:
#   sudo cp deploy/platform/backup.sh /srv/platform/backup.sh && sudo chmod +x /srv/platform/backup.sh
#   sudo crontab -e
#   15 2 * * *          /srv/platform/backup.sh >> /var/log/pos-backup.log 2>&1
#   0 10-23,0-2 * * *   /srv/platform/backup.sh --hourly >> /var/log/pos-backup.log 2>&1
#
# The hourly range is the SHOP's trading hours, not the clock's — dumping at 05:00 costs a
# bucket write to capture nothing. Adjust the range per box; the hours above are a late-night
# off-licence in Amman (cron runs in the host's timezone, so check `timedatectl`).
#
# Dumps land in ./backups (a bind mount inside the postgres container), then are pushed
# offsite. A backup that only exists on the same disk as the database is not a backup —
# fill in OFFSITE_CMD or you are one dead VPS away from losing every client's sales.
set -euo pipefail

TIER="daily"
case "${1:-}" in
  --hourly) TIER="hourly" ;;
  --daily|"") ;;
  *) echo "usage: $0 [--daily|--hourly]" >&2; exit 2 ;;
esac

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Hourly dumps live in their own directory so the two tiers prune independently, and so the
# restore drill (verify-restore.sh, -maxdepth 1) keeps testing the tier you actually keep.
if [ "$TIER" = "hourly" ]; then
  BACKUP_DIR="$PLATFORM_DIR/backups/hourly"
  RETAIN_DAYS="${HOURLY_RETAIN_DAYS:-3}"
else
  BACKUP_DIR="$PLATFORM_DIR/backups"
  RETAIN_DAYS="${RETAIN_DAYS:-14}"
fi

# Offsite push. Examples:
#   OFFSITE_CMD='rclone copy {} b2:7uloul-pos-backups/'
#   OFFSITE_CMD='aws s3 cp {} s3://7uloul-pos-backups/'
# {} is replaced with the dump path.
#
# The command is eval'd, so $TIER expands here too — worth using, because it lets the bucket
# expire the two tiers on different schedules instead of hoarding every hourly dump forever:
#   OFFSITE_CMD='rclone copy {} b2:7uloul-pos-backups/$TIER/'
# Quote it SINGLY in cron (as above) so the shell leaves $TIER for this script to expand.
OFFSITE_CMD="${OFFSITE_CMD:-}"

# Where a failure goes. Same webhook the API uses for 5xx and crashes (ALERT_WEBHOOK_URL in
# the client .env files), and the same JSON shape, so Slack/Discord/ntfy render it without
# extra configuration.
#
# WHY: exiting 1 sends the reason to cron, which mails root, which nobody reads. A backup
# that fails silently every night is indistinguishable from one that works, and you find out
# which it was on the night you need to restore. This is the same failure the OFFSITE_CMD
# guard exists to prevent, one layer up.
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"

notify() {
  [ -n "$ALERT_WEBHOOK_URL" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  # Never let alerting failure change the script's own outcome: the backup result is what
  # matters, and a webhook that is down must not turn a good run into a bad exit code.
  curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"[ALERT] pos-backup: $1\n$2\",\"service\":\"pos-backup\",\"title\":\"$1\"}" \
    "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 || echo "[backup] WARNING: alert delivery failed"
  return 0
}

# On ANY nonzero exit, not just a failed pg_dump. Under `set -e` this script can die long
# before the dump loop — Docker not running, the postgres container down, the wrong
# PLATFORM_DIR, a full disk — and those are the likeliest real failures. Alerting only at
# the end would mean the loudest cases were the silent ones.
on_exit() {
  rc=$?
  if [ "$rc" -ne 0 ]; then
    notify "backup FAILED (${TIER}, exit ${rc})" \
      "Backups did not complete on $(hostname). See /var/log/pos-backup.log."
  fi
  exit "$rc"
}
trap on_exit EXIT

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

# One backup at a time, across BOTH tiers. Without this the 02:15 daily run and an hourly
# run can overlap on a slow night: two pg_dumps competing for the same disk make each other
# slower, which makes the overlap likelier, and a shop feels it as a slow till. The hourly
# run is the one that yields — skipping it is free, since another fires in an hour.
#
# The `command -v` check is not paranoia. Without it, a box missing flock takes the
# "another backup is already running" branch on EVERY run and exits 0 — cron logs a green
# line each hour while nothing is ever dumped. That is the same silent-success failure the
# OFFSITE_CMD guard above exists to prevent, so a missing lock degrades to a loud warning
# rather than a quiet skip. flock ships with util-linux and is present on Ubuntu 24.04.
LOCKFILE="${LOCKFILE:-/tmp/pos-backup.lock}"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE"
  if ! flock -n 9; then
    echo "[backup] another backup is already running — skipping this ${TIER} run"
    exit 0
  fi
else
  echo "[backup] WARNING: flock not found — running unlocked. Concurrent tiers may overlap." >&2
fi

mkdir -p "$BACKUP_DIR"
cd "$PLATFORM_DIR"

# Every non-template database = every client.
#
# Except the restore drill's scratch databases. verify-restore.sh restores into
# restore_drill_<client> and drops it again — but if a drill dies partway (a schema the dump
# doesn't carry, a full disk, an interrupted ssh) the scratch database survives. Without this
# filter it then looks exactly like a client forever: dumped every hour, shipped offsite,
# and re-drilled into restore_drill_restore_drill_<client>, nesting one layer per run.
DBS=$(docker compose exec -T postgres psql -U postgres -tAc \
  "select datname from pg_database
    where datistemplate = false
      and datname <> 'postgres'
      and datname not like 'restore\_drill\_%'")

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

# -maxdepth 1: the daily tier must not reach down into backups/hourly and prune it on the
# daily schedule. Each tier owns its own directory and its own retention.
echo "[backup] pruning local ${TIER} dumps older than ${RETAIN_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -name '*.sql.gz' -mtime "+$RETAIN_DAYS" -delete

if [ "$FAILED" -ne 0 ]; then
  # The EXIT trap turns this into the alert; no second notify here, or a partial failure
  # would page twice.
  echo "[backup] COMPLETED WITH ERRORS"
  exit 1
fi
echo "[backup] ok"
