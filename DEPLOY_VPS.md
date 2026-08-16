# Deploy — VPS (Docker + Caddy + Postgres)

Replaces the Heroku path. One VPS hosts every client: a shared **platform stack**
(Caddy + Postgres) plus one small **client stack** per shop.

```
                    ┌──────────── VPS ────────────┐
  internet ──443──▶ │ caddy   (TLS, routing)      │   network: web
                    │   ├─▶ liquor-pos-app :3001  │
                    │   └─▶ dukkan-pos-app :3001  │
                    │ postgres (no public port)   │   network: data
                    │   ├─ db liquorpos           │
                    │   └─ db dukkanpos           │
                    └─────────────────────────────┘
```

Why this shape: one Postgres with a database per client uses a third of the RAM of a
container each and gives one backup job; splitting `web` and `data` networks means a
compromised app container still can't reach another client's app. Each client lives in
its own folder, so you can rebuild or roll back one shop without touching the others.

**Verified locally before this file was written** — image builds, migrations run on boot,
the app serves through Caddy, Postgres is unreachable from the host, a backup was taken
and restored into a scratch database (57 products / 135 orders / 3 users all present),
and the app survives a Postgres restart.

---

## 0. Buy the box

Hetzner **CX22** (2 vCPU / 4GB / 40GB, ~€4/mo) is the sweet spot — comfortably 10–15
client stacks. Hetzner is EU-only (~70–90ms to Amman), which is fine: the till does its
work in the browser and the API calls are tiny. Ubuntu 24.04 LTS.

## 1. Harden it (before anything else)

```bash
ssh root@<IP>
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# Key-only SSH
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'               /etc/ssh/sshd_config
systemctl restart ssh

ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable

apt update && apt install -y unattended-upgrades fail2ban
dpkg-reconfigure -plow unattended-upgrades
```

> Docker publishes ports by writing iptables rules that **bypass ufw**. That is exactly
> why the Postgres service has no `ports:` — it is never published, so there is nothing
> for ufw to fail to block. Do not add one "just for pgAdmin"; use
> `docker compose exec postgres psql` or an SSH tunnel.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
```

## 3. DNS

At your registrar for `7uloultech.com`, add an **A record per client**, all pointing at
the VPS IP:

| Type | Name     | Value      |
|------|----------|------------|
| A    | `liquor` | `<VPS IP>` |
| A    | `@`      | `<VPS IP>` |

Wait for it to resolve (`dig +short liquor.7uloultech.com`) **before** starting Caddy —
Let's Encrypt validates over HTTP and failed attempts are rate-limited.

## 4. Platform stack (once)

```bash
sudo mkdir -p /srv/platform && sudo chown deploy:deploy /srv/platform
# copy deploy/platform/{docker-compose.yml,Caddyfile,backup.sh,restore.sh,new-client-db.sh}
cd /srv/platform

# Superuser password — generated, never typed by hand, never committed.
echo "POSTGRES_SUPERUSER_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=')" > .env
chmod 600 .env

docker compose up -d
docker compose logs -f caddy      # watch the certificate get issued, then Ctrl-C
```

This creates the `web` and `data` networks that client stacks attach to.

## 5. Per client

One command. It creates the database and a role scoped to it, writes the client folder and
a `chmod 600` `.env`, appends and **validates** a Caddy block (restoring the Caddyfile if it
does not validate, so a typo cannot take the edge down for everyone else), starts the app,
and reloads Caddy:

```bash
# Once per box: a checkout the generator copies its compose files from.
sudo git clone <your-repo> /srv/platform/template

cd /srv/platform
TEMPLATE_DIR=/srv/platform/template/deploy ./new-client.sh \
  --key dukkan \
  --domain dukkan.7uloultech.com \
  --name "Dukkan Al Balad" \
  --image ghcr.io/<owner>/liquor-store-pos:<sha> \
  --tax 16 --prefix DK --location "Irbid, Jordan" --tax-no 9988776
```

`--key` becomes the database, the role, the compose project, the container name
(`dukkan-pos-app`) and the folder — which is what stops the failure the old copy-a-folder
flow invited, where two clients both claimed `liquor-pos:latest` and `liquor-pos-app` and
the second `docker compose up` silently adopted the first shop's image.

It **refuses rather than overwrites**: an existing `.env` or an existing Caddy block for
that domain stops it. Re-running would mint a new database password while the running
container still held the old one.

Pin `--image` to a real tag (a commit sha or `vX.Y.Z`), never `latest` — with one image
serving every shop, a moving tag means a restart can silently change which build a till is
running. CI prints the exact line to pin at the end of each publish.

<details>
<summary>Doing it by hand instead</summary>

```bash
# 5a. Database + a role scoped to just that database. Prints the DATABASE_URL once.
cd /srv/platform && ./new-client-db.sh liquorpos

# 5b. The app
sudo mkdir -p /srv/clients/liquor && sudo chown deploy:deploy /srv/clients/liquor
cd /srv/clients/liquor
git clone <your-repo> .
cd deploy
cat > .env <<'EOF'
DATABASE_URL=postgres://liquorpos:<from step 5a>@postgres:5432/liquorpos
SESSION_TTL_HOURS=12
NVIDIA_API_KEY=
AI_LOW_STOCK_THRESHOLD=5

# This shop's identity. The bundle is generic; these make it theirs.
STORE_TZ=Asia/Amman
CLIENT_STORE_NAME=Dukkan Al Balad
CLIENT_TAX_PCT=16
CLIENT_INVOICE_PREFIX=DK
CLIENT_SELLER_LOCATION=Irbid, Jordan
CLIENT_SELLER_TAX_NO=9988776
EOF
chmod 600 .env

# CLIENT_KEY and POS_IMAGE are required — the compose file refuses to interpolate without
# them rather than guessing a container name or an image tag.
echo 'CLIENT_KEY=liquor' >> .env
echo 'POS_IMAGE=ghcr.io/<owner>/liquor-store-pos:<sha>' >> .env

docker compose up -d             # entrypoint applies migrations, then serves
docker compose logs -f app
```

Then add the Caddy block by hand and reload.

</details>

**The shop's name, VAT rate and receipt identity are env, not code.** The API serves them to
the browser at boot (`GET /client-config.js` → `window.__CLIENT__`), so the same build works
for every client — see `.env.example` for the full list. Anything left unset keeps the
shipped Liquor Store default; anything set to an invalid value (`CLIENT_TAX_PCT=sixteen`)
stops the container starting rather than silently printing a wrong VAT line on every
receipt. Changing a value is an `.env` edit plus `docker compose up -d`, with no rebuild.

`STORE_TZ` is now the *only* place the trading-day clock is set — the till reads it from the
server, so the browser and the reports cannot disagree about which day a late-night sale
belongs to.

Seed the staff and catalogue (passwords only ever exist in the command you type):

```bash
docker compose exec -e ADMIN_USERNAME=owner -e ADMIN_PASSWORD='<choose 8+>' app node server/seed-admin.js
docker compose exec -e USERS_JSON='[{"username":"cashier","password":"<choose>","role":"user","allowed_views":["sales","history"]}]' app node server/seed-users.js
docker compose exec app node server/seed-products.js      # demo catalogue; skip for a real client
```

Open `https://dukkan.7uloultech.com`.

## 6. Deploying a change

Push to `main`. CI runs both suites and, only if they pass, builds and pushes **one** image
to GHCR tagged with the commit sha. Nothing on the VPS builds anything.

Then move a shop onto it — one shop at a time, which is the point:

```bash
cd /srv/clients/dukkan/deploy
sed -i 's|^POS_IMAGE=.*|POS_IMAGE=ghcr.io/<owner>/liquor-store-pos:<new-sha>|' .env
docker compose up -d          # pulls, migrates on boot, restarts
```

Roll that one shop back by putting the previous sha in `.env` and running the same command.
No other client is touched, and no rebuild happens anywhere.

Migrations apply automatically on boot — both ledgers, `server/migrations` and
`reporting/migrations`.

**Staged rollout.** With thirty shops on one image, put a new sha on one quiet shop first,
leave it a day, then move the rest. That is only possible because each `.env` pins its own
tag; a shared `latest` would move all thirty at once, on whatever schedule Docker felt like.

## 7. Backups (do this on day one)

```bash
sudo crontab -e
OFFSITE='rclone copy {} b2:7uloul-pos-backups/$TIER/'
ALERT_WEBHOOK_URL=https://ntfy.sh/<your-secret-topic>
15 2 * * *         OFFSITE_CMD="$OFFSITE" /srv/platform/backup.sh          >> /var/log/pos-backup.log 2>&1
0 10-23,0-2 * * *  OFFSITE_CMD="$OFFSITE" /srv/platform/backup.sh --hourly >> /var/log/pos-backup.log 2>&1
45 2 1 * *         /srv/platform/verify-restore.sh                         >> /var/log/pos-restore-drill.log 2>&1
```

`ALERT_WEBHOOK_URL` is the same webhook the API posts 5xx and crashes to, so backup and
drill failures land in the same place. **Set it.** Without it a failing backup exits 1 into
cron's mail, which nobody reads — a backup that fails silently every night is
indistinguishable from one that works, and you find out which it was on the night you need
to restore. Both scripts alert on *any* nonzero exit, not just a failed dump, because the
likeliest failures (Docker down, disk full, postgres container stopped) kill them before
they reach their own error branch.

Dumps every client database, gzips it, and **fails loudly** if a dump comes back
suspiciously small. Set `OFFSITE_CMD` — a backup sitting on the same disk as the database
is not a backup.

**Why the second line.** With only the nightly run, a disk failure at 21:00 loses every
sale rung since midnight, for every shop on the box — an off-licence's whole trading day,
peak hours included. The tills keep unsynced sales in the browser's offline queue, but
anything already synced dies with the disk. Hourly dumps during trading hours cut the worst
case from ~19 hours to ~1.

The two tiers are separate: daily lands in `backups/` and is kept 14 days; hourly lands in
`backups/hourly/` and is kept 3 (`HOURLY_RETAIN_DAYS`). They share a lock, so they never run
on top of each other. Set the hour range to **the shop's** trading hours — the range above
is a late-night Amman off-licence, and cron uses the host's timezone (`timedatectl`).

This is not point-in-time recovery. **pgBackRest with continuous WAL archiving** is the real
answer and gets the window to seconds; move to it as shop count grows. Hourly dumps are the
one-cron-line version that removes most of the exposure today.

Restore drill (do it once now, not during an outage):

```bash
cd /srv/platform && ./restore.sh liquorpos backups/liquorpos-<stamp>.sql.gz
```

The monthly `verify-restore.sh` line above proves the newest **daily** dump still restores
into a scratch database. An untested backup is a hypothesis.

## 8. Monitoring

**Point external checks at `/readyz`, not `/healthz`.** They answer different questions and
the difference matters at 9pm:

| | checks | who uses it |
|---|---|---|
| `/healthz` | the process is up, nothing else | Docker's `HEALTHCHECK` |
| `/readyz` | the process is up **and the database answers** | Uptime Kuma, you |

`/healthz` deliberately does not touch Postgres. If it did, Docker would restart the
container over a database outage it cannot fix — killing the process that would have served
the shop the moment the database came back. `/readyz` returns 503 with
`{"status":"degraded","error":"database"}` instead, so the outage is visible without
anything being restarted over it. Neither endpoint needs auth; successful probes are kept
out of the request log so they cannot bury the history you search during an incident.

Uptime Kuma in a container, or any external checker, hitting
`https://<client>.7uloultech.com/readyz` per client. Alert to whatever you actually read —
the same ntfy/Discord webhook as `ALERT_WEBHOOK_URL` is the obvious choice.

---

## Things that will bite you

- **HTTPS is required for the thermal printer.** The receipt printer uses the Web Serial
  API, which browsers only expose in a secure context. On plain HTTP printing silently
  fails. Same for PWA install. This is the main reason Caddy is not optional.
- **HSTS is sticky.** The `Strict-Transport-Security` header in the Caddyfile tells
  browsers to refuse HTTP for a year. Confirm HTTPS works before leaving it on; removing
  the header later does not un-stick already-visited browsers.
- **The lockfile must match the image's npm.** `npm ci` fails if `package-lock.json` was
  generated by a different major npm than the `node:20-alpine` image carries. Regenerate
  it inside the image, not on your Windows box:
  `docker run --rm -v "$PWD:/w" -w /w node:20-alpine npm install --package-lock-only`
- **`deploy/package.runtime.json` is a second dependency list.** The runtime image installs
  only what `server/` requires (CRA keeps the build toolchain under `dependencies`, which
  would otherwise add ~460MB of unused code). Add a server dependency → add it there too,
  pinned to the version in `package-lock.json`.
- **`DATABASE_SSL=false` matters.** `server/db.js` used to demand TLS purely because
  `NODE_ENV=production`, which is also true inside the container — where the connection is
  private and unencrypted by design. The compose file sets it explicitly. Heroku deploys
  keep working: unset, it falls back to the old NODE_ENV rule.
- **Disk fills quietly.** Log rotation is set on the app container; also run
  `docker system prune -af --filter "until=720h"` monthly to clear old build layers.
- **Offline sales still work.** The app queues sales in the browser and syncs when the API
  returns, so a reboot or a brief outage doesn't stop the till.

## Local dev against this stack

`deploy/platform/Caddyfile.local` + `platform.local.yml` run the same topology on
`http://localhost:8080` with TLS off:

```bash
cd deploy/platform && docker compose -f docker-compose.yml -f platform.local.yml up -d
cd ../ && docker compose up -d --build
```

The lighter loop for day-to-day work is still `npm run db:up && npm run server`
(see `README_DEMO.md`).
