#!/usr/bin/env bash
# Restore one client database from a dump.
#
#   ./restore.sh liquorpos /srv/platform/backups/liquorpos-20260809-021500.sql.gz
#
# DESTRUCTIVE: the dump is taken with --clean --if-exists, so it DROPS and recreates every
# object in the target database. Stop that client's app container first, or it will write
# into a half-restored schema.
#
# Run this on purpose at least once, against a scratch database, BEFORE you need it.
# An untested backup is a guess.
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
DB="${1:-}"
DUMP="${2:-}"

if [ -z "$DB" ] || [ -z "$DUMP" ]; then
  echo "usage: $0 <database> <path-to-dump.sql.gz>" >&2
  exit 2
fi
if [ ! -f "$DUMP" ]; then
  echo "no such dump: $DUMP" >&2
  exit 2
fi

cd "$PLATFORM_DIR"

echo "About to restore '$DB' from $DUMP"
echo "This DROPS existing objects in that database. Type the database name to confirm:"
read -r confirm
[ "$confirm" = "$DB" ] || { echo "aborted"; exit 1; }

gunzip -c "$DUMP" | docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -d "$DB"

echo "Restored $DB. Start the client's app container and verify a login + one sale."
