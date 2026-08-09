#!/usr/bin/env bash
# Provision one client: a dedicated database + a role that can only touch that database.
#
#   ./new-client-db.sh liquorpos
#
# Prints the DATABASE_URL to paste into that client's deploy/.env. The password is
# generated here and shown once — it is never written to disk by this script.
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
DB="${1:-}"

# Same rule the app applies to store keys: a SQL-safe identifier, never interpolated blind.
if ! printf '%s' "$DB" | grep -Eq '^[a-z][a-z0-9_]*$'; then
  echo "usage: $0 <dbname>   (lowercase letters, digits, underscore; must start with a letter)" >&2
  exit 2
fi

cd "$PLATFORM_DIR"
PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)"

docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 <<SQL
create role ${DB} with login password '${PASS}';
create database ${DB} owner ${DB};
revoke all on database ${DB} from public;
SQL

echo
echo "Database '${DB}' created."
echo "Put this in the client's deploy/.env (shown once — it is not stored anywhere):"
echo
echo "DATABASE_URL=postgres://${DB}:${PASS}@postgres:5432/${DB}"
echo
echo "Host 'postgres' resolves on the private 'data' network — this URL only works from"
echo "inside a container attached to it, which is the point."
