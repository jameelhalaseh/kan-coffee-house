#!/bin/sh
# Container start: wait for Postgres, apply migrations, then hand off to the CMD.
# This is the Heroku `release:` phase, made explicit — every deploy migrates before serving.
set -e

echo "[entrypoint] waiting for database…"
i=0
until node -e "
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});
p.query('select 1').then(()=>{p.end();process.exit(0)}).catch(()=>{p.end();process.exit(1)});
" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -ge 60 ]; then echo "[entrypoint] database unreachable after 60 tries — giving up"; exit 1; fi
  sleep 2
done

echo "[entrypoint] applying migrations…"
node server/migrate.js

# The reporting module keeps its own migration ledger and its own directory
# (reporting/migrations), so `npm run migrate:reporting` is a SECOND migration path that
# server/migrate.js does not cover. Left out, the container boots clean and then every
# Financials request 500s on a missing table — a failure that shows up days later, from the
# shop, rather than here on deploy where it belongs.
echo "[entrypoint] applying reporting migrations…"
node reporting/migrate.js

echo "[entrypoint] starting: $*"
exec "$@"
