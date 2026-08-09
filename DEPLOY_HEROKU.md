# Deploy — Liquor Store POS (Heroku + Postgres)

Single-dyno deploy: the Express server (`server/index.js`) serves both the `/api` JSON API
and the built React app. `Procfile` runs `release: node server/migrate.js` (applies
migrations on every deploy) and `web: node server/index.js`.

Replace `<APP>` with your chosen Heroku app name and `<prompt>` with real values.
**Passwords are never committed** — they only ever live in env at seed time (8+ chars).

> For running this locally against Docker Postgres instead, see `README_DEMO.md`.

## 1. Create the app + database

```bash
heroku create <APP>
heroku addons:create heroku-postgresql:essential-0 -a <APP>
```

## 2. Config

```bash
heroku config:set NODE_ENV=production SESSION_TTL_HOURS=12 -a <APP>
# DATABASE_URL is set automatically by the Postgres addon.
```

Optional — AI assistant chat (free tier at build.nvidia.com). Without it, the assistant's
deterministic inventory insights/alerts still work; only the chat box is disabled.
```bash
heroku config:set NVIDIA_API_KEY=<prompt> AI_LOW_STOCK_THRESHOLD=5 -a <APP>
```

Optional — admin forgot-password (server-side EmailJS). Skip if not needed; login still works.
```bash
heroku config:set EMAILJS_SERVICE_ID=<prompt> EMAILJS_TEMPLATE_ID=<prompt> \
  EMAILJS_PUBLIC_KEY=<prompt> EMAILJS_PRIVATE_KEY=<prompt> -a <APP>
# Also enable "Allow EmailJS API for non-browser applications" in the EmailJS dashboard.
# The template must reference {{code}}.
```

## 3. Deploy (runs migrate automatically via release phase)

```bash
git init && git add -A && git commit -m "Liquor Store POS"
heroku git:remote -a <APP>
git push heroku main      # release phase applies server/migrations/*.sql
```

If migrations need a manual run: `heroku run npm run migrate -a <APP>`.

## 4. Seed the first admin (and staff)

```bash
heroku run "ADMIN_USERNAME=owner ADMIN_PASSWORD=<prompt> npm run seed:admin" -a <APP>
```

Add staff. Grant `reports` to anyone who must see revenue/profit — it is enforced
server-side (403 otherwise). Sales is always allowed; admins bypass all view checks.
```bash
heroku run "USERS_JSON='[
  {\"username\":\"cashier\",\"password\":\"<prompt>\",\"role\":\"user\",\"allowed_views\":[\"sales\",\"history\"]},
  {\"username\":\"manager\",\"password\":\"<prompt>\",\"role\":\"user\",\"allowed_views\":[\"sales\",\"inventory\",\"receive\",\"history\",\"reports\",\"settings\"]}
]' npm run seed:users" -a <APP>
```

## 5. Load the catalogue

Demo catalogue (57 spirits/wine/beer/mixers + 4 suppliers):
```bash
heroku run npm run seed:products -a <APP>
```

For the client's real catalogue, either edit `server/seed-products.sql` first, or skip the
seed and add products in **Inventory → + Product**. NOTE: this build has CSV *export*
only — there is no Excel/CSV import in the UI, so a large catalogue must go through
`server/seed-products.sql`.

Open it: `heroku open -a <APP>`. Log in, then scan to sell. Scanning an unknown barcode on
the Sales screen opens the quick-add product modal.

## 6. Backups

essential-tier keeps ~7 days of daily backups. Set the daily schedule:
```bash
heroku pg:backups:schedule DATABASE_URL --at '02:00 Asia/Amman' -a <APP>
```
For long-term offsite retention, ask about the triweekly GitHub-Action backup job.

## Wipe demo sales before go-live (keeps products + users)

```bash
heroku run "CONFIRM_WIPE=YES npm run reset:data" -a <APP>
```
