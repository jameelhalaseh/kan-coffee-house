# Liquor Store POS — single image serving the API and the built React app.
# Mirrors what Heroku did (heroku-postbuild + web: node server/index.js), just explicit.

# ── Stage 1: build the React bundle ──────────────────────────────────────────
# node:24 (npm 11), NOT node:20 (npm 10). This must stay in step with node-version in
# .github/workflows/*.yml and with whatever npm regenerates package-lock.json: npm 10
# rejects this lock with "Missing: yaml@2.9.0 from lock file" and the image build dies at
# `npm ci` below. Three places pin a Node version — both workflows and here — and this one
# is the easy one to forget, because a green test job says nothing about the image.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# CI=true makes CRA treat warnings as warnings, not an interactive prompt.
# INLINE_RUNTIME_CHUNK=false (also set in the npm script) keeps CRA's runtime out of an
# inline <script>, which is what lets the server send script-src 'self' with no
# 'unsafe-inline'. Losing this flag silently breaks the app under that CSP.
RUN CI=true INLINE_RUNTIME_CHUNK=false npm run build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# tini reaps zombies and forwards signals, so `docker stop` is a clean shutdown.
# curl is only here for the healthcheck.
RUN apk add --no-cache tini curl

# The app's package.json keeps react/react-scripts under "dependencies" (CRA convention),
# so `npm ci --omit=dev` would drag the whole build toolchain into the runtime image —
# ~550MB of code that never executes in production and only widens the attack surface.
# deploy/package.runtime.json lists ONLY what server/ actually requires, at versions pinned
# from package-lock.json. Regenerate it whenever a server dependency changes.
COPY deploy/package.runtime.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server
# server/routes/index.js requires ../../reporting/api at startup, so this is not optional —
# without it the container crash-loops on `Cannot find module '../../reporting/api'` before
# it ever listens. It carries its own migrations too (reporting/migrations/*.sql, applied by
# the entrypoint), and it needs no dependency that package.runtime.json does not already
# list: express, pg, dotenv and Node builtins.
COPY reporting ./reporting
COPY --from=build /app/build ./build
COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Never run the app as root — a container escape shouldn't land on a root shell.
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/index.js"]
