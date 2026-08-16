#!/usr/bin/env bash
# Sign people out, now.
#
#   ./revoke-sessions.sh dukkan                 every session at one shop
#   ./revoke-sessions.sh dukkan cashier         one user at one shop
#   ./revoke-sessions.sh --all                  every session at every shop
#
# WHY THIS EXISTS
# Sessions are an idle window (30 days, renewed by use), so a till in daily use never logs
# itself out — which is the point, and which means there is no longer a timer that quietly
# cleans up after a device that should not have a session any more. This is the lever for
# that: a lost or stolen tablet, a cashier who left on bad terms, a password shared with
# someone who should not have it.
#
# Deploys deliberately do NOT do this. One image serves every shop and you will deploy
# often; forcing every till at every client back to a login screen on a Thursday evening is
# the same interruption the idle window was meant to remove.
#
# The user can log straight back in afterwards — this ends the SESSION, it does not disable
# the account. To stop someone logging back in, set active = false on their row instead.
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
DB="${1:-}"
USER_NAME="${2:-}"

if [ -z "$DB" ]; then
  sed -n '2,8p' "$0" >&2
  exit 2
fi

cd "$PLATFORM_DIR"
psql_super() { docker compose exec -T postgres psql -U postgres "$@"; }

# Nulling session_token is exactly what logout does, so this reuses the path the app already
# takes rather than inventing a second notion of "signed out". The next request from that
# token gets a 401 'session' and the client clears its own state.
# The username is passed as a psql VARIABLE and quoted with :'name', which applies proper SQL
# literal quoting. Interpolating it into the statement text would put a shell string straight
# into SQL, and a username is user-supplied data — an apostrophe alone ("o'brien") breaks the
# query before anyone has to be malicious about it.
#
# The SQL goes in on STDIN rather than through -c: psql does not perform variable
# interpolation on a -c argument, so :'uname' would reach the server literally and fail with
# a syntax error at ":". Via stdin it is substituted as intended.
revoke_one() {
  db="$1"
  if [ -n "$USER_NAME" ]; then
    n=$(cat <<'SQL' | psql_super -d "$db" -v uname="$USER_NAME" -tA | grep -c '^1$' || true
update app_users set session_token = null, token_exp = null
 where username = :'uname' and session_token is not null
 returning 1;
SQL
)
    echo "[revoke] $db / $USER_NAME: ${n} session(s) ended"
  else
    n=$(cat <<'SQL' | psql_super -d "$db" -tA | grep -c '^1$' || true
update app_users set session_token = null, token_exp = null
 where session_token is not null
 returning 1;
SQL
)
    echo "[revoke] $db: ${n} session(s) ended"
  fi
}

if [ "$DB" = "--all" ]; then
  # Same client list the backups use, and the same exclusion of the drill's scratch copies.
  DBS=$(psql_super -tAc \
    "select datname from pg_database
      where datistemplate = false
        and datname <> 'postgres'
        and datname not like 'restore\_drill\_%'")
  [ -n "$DBS" ] || { echo "[revoke] no client databases found"; exit 0; }
  echo "[revoke] every session at every shop on this box:"
  printf '%s\n' "$DBS" | sed 's/^/  - /'
  for d in $DBS; do revoke_one "$d"; done
else
  # A typo'd database name must not read as "nothing to do" — "0 sessions ended" against a
  # shop that does not exist looks exactly like success.
  exists=$(cat <<'SQL' | psql_super -v d="$DB" -tA
select 1 from pg_database where datname = :'d';
SQL
)
  [ "$exists" = "1" ] || { echo "[revoke] no such database: $DB" >&2; exit 2; }
  revoke_one "$DB"
fi

echo "[revoke] done. Affected staff simply log in again."
