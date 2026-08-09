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
EOF
chmod 600 .env

docker compose up -d --build     # entrypoint applies migrations, then serves
docker compose logs -f app
```

Seed the staff and catalogue (passwords only ever exist in the command you type):

```bash
docker compose exec -e ADMIN_USERNAME=owner -e ADMIN_PASSWORD='<choose 8+>' app node server/seed-admin.js
docker compose exec -e USERS_JSON='[{"username":"cashier","password":"<choose>","role":"user","allowed_views":["sales","history"]}]' app node server/seed-users.js
docker compose exec app node server/seed-products.js      # demo catalogue; skip for a real client
```

Then add the client to `/srv/platform/Caddyfile` and reload with **no downtime for anyone
else**:

```bash
docker compose -f /srv/platform/docker-compose.yml exec caddy \
  caddy reload --config /etc/caddy/Caddyfile
```

Open `https://liquor.7uloultech.com`.

## 6. Deploying a change

```bash
cd /srv/clients/liquor && git pull
cd deploy && docker compose up -d --build
```

Migrations apply automatically on boot. Roll back with `git checkout <sha>` and the same
command — one client only.

## 7. Backups (do this on day one)

```bash
sudo crontab -e
15 2 * * * OFFSITE_CMD='rclone copy {} b2:7uloul-pos-backups/' /srv/platform/backup.sh >> /var/log/pos-backup.log 2>&1
```

Dumps every client database, gzips it, prunes local copies after 14 days, and **fails
loudly** if a dump comes back suspiciously small. Set `OFFSITE_CMD` — a backup sitting on
the same disk as the database is not a backup.

Restore drill (do it once now, not during an outage):

```bash
cd /srv/platform && ./restore.sh liquorpos backups/liquorpos-<stamp>.sql.gz
```

## 8. Monitoring

Uptime Kuma in a container, or any external checker, hitting
`https://liquor.7uloultech.com/healthz` (returns `{"status":"ok"}`, no auth) per client.
Alert to whatever you actually read.

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
