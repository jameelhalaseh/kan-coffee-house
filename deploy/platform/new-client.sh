#!/usr/bin/env bash
# Provision one client end to end: database, role, app folder, .env, Caddy block, running
# container. What used to be a copied folder and six remembered edits.
#
#   ./new-client.sh --key dukkan --domain dukkan.7uloultech.com --name "Dukkan Al Balad" \
#                   --image ghcr.io/<owner>/liquor-store-pos:<sha>
#
# Optional: --tax 16  --prefix DK  --location "Irbid, Jordan"  --tax-no 9988776  --lang en
#
# WHY A SCRIPT AND NOT A CHECKLIST
# Every step here is one a human does correctly nineteen times and then gets wrong on the
# twentieth, at which point a shop is live with another shop's container name, or a .env
# readable by every user on the box, or a Caddy block that took the whole edge down on
# reload. The steps that can hurt someone else's shop — the Caddyfile especially — are
# validated and rolled back here rather than trusted.
#
# It is NOT idempotent by design: it refuses rather than overwrites. Re-running it for an
# existing client would mean regenerating that client's database password while their
# container still holds the old one.
set -euo pipefail

PLATFORM_DIR="${PLATFORM_DIR:-/srv/platform}"
CLIENTS_DIR="${CLIENTS_DIR:-/srv/clients}"

# Where the compose files are copied from. Defaults to the repo checkout this script lives
# in (deploy/platform/../ = deploy/). On the VPS, keep a checkout at /srv/platform/template
# and `git pull` it to pick up template changes:
#   TEMPLATE_DIR=/srv/platform/template/deploy ./new-client.sh ...
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="${TEMPLATE_DIR:-$SCRIPT_DIR/..}"

KEY=""; DOMAIN=""; NAME=""; IMAGE="${POS_IMAGE:-}"
TAX="16"; PREFIX=""; LOCATION=""; TAX_NO=""; LANG_DEFAULT="en"

die() { echo "[new-client] ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key)      KEY="${2:-}"; shift 2 ;;
    --domain)   DOMAIN="${2:-}"; shift 2 ;;
    --name)     NAME="${2:-}"; shift 2 ;;
    --image)    IMAGE="${2:-}"; shift 2 ;;
    --tax)      TAX="${2:-}"; shift 2 ;;
    --prefix)   PREFIX="${2:-}"; shift 2 ;;
    --location) LOCATION="${2:-}"; shift 2 ;;
    --tax-no)   TAX_NO="${2:-}"; shift 2 ;;
    --lang)     LANG_DEFAULT="${2:-}"; shift 2 ;;
    -h|--help)  sed -n '2,10p' "$0"; exit 0 ;;
    *)          die "unknown argument: $1" ;;
  esac
done

[ -n "$KEY" ]    || die "--key is required (short slug: dukkan, liquor, balad)"
[ -n "$DOMAIN" ] || die "--domain is required (e.g. dukkan.7uloultech.com)"
[ -n "$NAME" ]   || die "--name is required (the shop's name, as it appears on the receipt)"
[ -n "$IMAGE" ]  || die "--image is required, e.g. ghcr.io/<owner>/liquor-store-pos:<sha>.
  Pin a real tag, never 'latest' — a moving tag means a restart can change a shop's build."

# The key becomes a database name, a Postgres role, a compose project, a container name and
# a folder. One character set has to satisfy all five, so it is the strictest of them.
printf '%s' "$KEY" | grep -Eq '^[a-z][a-z0-9]{1,20}$' \
  || die "--key must be 2-21 chars, lowercase letters and digits, starting with a letter"

# Tax is checked here as well as in the app because the app's check happens after this
# script has already created a database and a DNS-facing Caddy block. Failing early leaves
# nothing behind to clean up.
printf '%s' "$TAX" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || die "--tax must be a number 0-100"
awk -v t="$TAX" 'BEGIN{exit !(t>=0 && t<=100)}' || die "--tax must be between 0 and 100"
[ "$LANG_DEFAULT" = "en" ] || [ "$LANG_DEFAULT" = "ar" ] || die "--lang must be 'en' or 'ar'"

PREFIX="${PREFIX:-$(printf '%s' "$KEY" | tr '[:lower:]' '[:upper:]' | cut -c1-2)}"
CLIENT_DIR="$CLIENTS_DIR/$KEY"
DEPLOY_DIR="$CLIENT_DIR/deploy"
CADDYFILE="$PLATFORM_DIR/Caddyfile"

# ── Refuse rather than overwrite ─────────────────────────────────────────────
[ -e "$DEPLOY_DIR/.env" ] && die "$DEPLOY_DIR/.env already exists — client '$KEY' looks provisioned.
  Re-running would mint a new database password while the running container still holds the old one."
grep -Eq "^[[:space:]]*${DOMAIN//./\\.}[[:space:]]*\{" "$CADDYFILE" 2>/dev/null \
  && die "$DOMAIN already has a block in $CADDYFILE"
[ -f "$TEMPLATE_DIR/docker-compose.yml" ] \
  || die "no docker-compose.yml in TEMPLATE_DIR ($TEMPLATE_DIR).
  Point TEMPLATE_DIR at the 'deploy' directory of a checkout of this repo."
[ -f "$PLATFORM_DIR/new-client-db.sh" ] || die "$PLATFORM_DIR/new-client-db.sh not found"

echo "[new-client] provisioning '$KEY' → https://$DOMAIN"

# ── 1. Database + scoped role ────────────────────────────────────────────────
# new-client-db.sh prints the URL once and stores it nowhere; capture it here or it is gone.
echo "[new-client] creating database and role"
DB_OUT="$("$PLATFORM_DIR/new-client-db.sh" "$KEY")"
DB_URL="$(printf '%s\n' "$DB_OUT" | grep -E '^DATABASE_URL=' || true)"
[ -n "$DB_URL" ] || { printf '%s\n' "$DB_OUT" >&2; die "could not read DATABASE_URL from new-client-db.sh"; }

# ── 2. App folder ────────────────────────────────────────────────────────────
mkdir -p "$DEPLOY_DIR"
cp "$TEMPLATE_DIR/docker-compose.yml" "$DEPLOY_DIR/"
[ -f "$TEMPLATE_DIR/docker-compose.build.yml" ] && cp "$TEMPLATE_DIR/docker-compose.build.yml" "$DEPLOY_DIR/"

# The .env holds this client's database password. Create it empty with the right mode BEFORE
# writing, so the secret is never briefly world-readable between creation and chmod.
umask 077
: > "$DEPLOY_DIR/.env"
cat >> "$DEPLOY_DIR/.env" <<EOF
# ${NAME} — generated by new-client.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# This file is the ONLY thing that makes this deployment different from every other shop's.

CLIENT_KEY=${KEY}
POS_IMAGE=${IMAGE}

${DB_URL}
SESSION_TTL_HOURS=12

# ── This shop's identity (served to the browser at runtime) ──────────────────
STORE_TZ=${STORE_TZ:-Asia/Amman}
CLIENT_STORE_NAME=${NAME}
CLIENT_LANG=${LANG_DEFAULT}
CLIENT_TAX_PCT=${TAX}
CLIENT_INVOICE_PREFIX=${PREFIX}
CLIENT_SELLER_LOCATION=${LOCATION}
CLIENT_SELLER_TAX_NO=${TAX_NO}

# Blank = the AI assistant view is hidden rather than shown and broken.
NVIDIA_API_KEY=
AI_LOW_STOCK_THRESHOLD=5
EOF
chmod 600 "$DEPLOY_DIR/.env"
umask 022
echo "[new-client] wrote $DEPLOY_DIR/.env (mode 600)"

# ── 3. Caddy block ───────────────────────────────────────────────────────────
# This is the step that can hurt OTHER clients: the Caddyfile is shared, and a reload with a
# broken block is an edge-wide event. Back up, append, VALIDATE, and restore on failure.
CADDY_BACKUP="$(mktemp)"
cp "$CADDYFILE" "$CADDY_BACKUP"
cat >> "$CADDYFILE" <<EOF

# ── ${NAME} ── added by new-client.sh $(date -u +%Y-%m-%d)
${DOMAIN} {
	encode zstd gzip
	reverse_proxy ${KEY}-pos-app:3001
	header Strict-Transport-Security "max-age=31536000; includeSubDomains"
	log {
		output file /data/logs/${KEY}.log {
			roll_size 10MB
			roll_keep 5
		}
	}
}
EOF

cd "$PLATFORM_DIR"
# Keep caddy's own output: "did not validate" without the reason sends the operator back to
# this script to re-run it by hand, which is the same work twice for no information.
if ! VALIDATE_OUT="$(docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile 2>&1)"; then
  cp "$CADDY_BACKUP" "$CADDYFILE"
  rm -f "$CADDY_BACKUP"
  printf '%s\n' "$VALIDATE_OUT" | tail -5 >&2
  die "the generated Caddy block did not validate (caddy's output above) — Caddyfile
  restored, nothing reloaded, the other clients are untouched.
  The database '$KEY' and $DEPLOY_DIR were already created; remove both before retrying:
    docker compose -f $PLATFORM_DIR/docker-compose.yml exec -T postgres \\
      psql -U postgres -c 'drop database $KEY' -c 'drop role $KEY'
    rm -rf $CLIENT_DIR"
fi
rm -f "$CADDY_BACKUP"

# ── 4. Start the app, then route to it ───────────────────────────────────────
# App first: reloading Caddy toward a container that is not yet listening would serve this
# shop a 502 for however long the image pull takes.
echo "[new-client] starting the app (migrations run on boot)"
cd "$DEPLOY_DIR"
docker compose up -d

echo "[new-client] reloading Caddy (no downtime for the other clients)"
cd "$PLATFORM_DIR"
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile

cat <<EOF

[new-client] '$KEY' is up at https://$DOMAIN

Seed the owner account — the password exists only in the command you type, never on disk:

  cd $DEPLOY_DIR
  docker compose exec -e ADMIN_USERNAME=owner -e ADMIN_PASSWORD='<choose 8+>' app node server/seed-admin.js

Then the staff, and the catalogue if they want the demo one:

  docker compose exec -e USERS_JSON='[{"username":"cashier","password":"<choose>","role":"user","allowed_views":["sales","history"]}]' app node server/seed-users.js
  docker compose exec app node server/seed-products.js

Before handing it over: point $DOMAIN at this box in DNS, and take a backup so this client
is covered from day one:

  OFFSITE_CMD='<your rclone/aws line>' $PLATFORM_DIR/backup.sh
EOF
