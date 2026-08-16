// CashierPOS API server (Heroku). Serves the /api/* JSON API and the static React
// build from one dyno. Replaces the Supabase REST/anon-key model — the DB is reached
// only through this server, which authorizes every request server-side.
try { require('dotenv').config(); } catch (_) { /* dotenv optional in production */ }

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { log, alert, requestLogger } = require('./logger');

const app = express();
app.set('trust proxy', 1); // Heroku terminates TLS at the router; needed for rate-limit IPs

// CSP — the build is self-hosted and loads no external scripts.
// script-src is 'self' ONLY — no 'unsafe-inline'. The build sets
// INLINE_RUNTIME_CHUNK=false (package.json + Dockerfile), so CRA emits its runtime as a
// real file instead of an inline <script>. With the session token living in localStorage,
// this is the difference between "an XSS would steal every cashier's session" and
// "injected script never executes". If you ever see the app fail to boot with a CSP error
// about an inline script, the build lost that env var — fix the build, do not re-add
// 'unsafe-inline' here.
// style-src still needs 'unsafe-inline': the whole UI is React inline style={{}} attributes
// plus the theme <style> block in index.html. Removing that is a rewrite, not a config flip.
// connect-src allows same-origin API + Sentry ingest. img-src allows data: + https:.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      // blob: is required, not cosmetic. Category artwork is served from an AUTHENTICATED
      // endpoint, and an <img> tag cannot carry an Authorization header — so the bytes are
      // fetched with the Bearer token and turned into an object URL. Without blob: here the
      // browser refuses every one of those images and the shelf silently falls back to
      // letter badges. The same applies to the upload preview, which reads a local file.
      'img-src': ["'self'", 'data:', 'blob:', 'https:'],
      'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
      // localhost/127.0.0.1 allowed so the page can reach the local print bridge (Dealer).
      'connect-src': ["'self'", 'https://*.sentry.io', 'https://*.ingest.sentry.io', 'http://localhost:*', 'http://127.0.0.1:*'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
}));
app.use(compression());

// CORS — Bearer auth (no cookies). Same-origin requests (no Origin header) always pass.
// Cross-origin is blocked unless the Origin is in CORS_ORIGINS (comma-separated env).
// Default (unset) = same-origin only, which is all the web app needs.
const corsAllow = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // same-origin, curl, health checks
    if (corsAllow.includes(origin)) return cb(null, true);
    return cb(null, false);                             // block cross-origin not on the allowlist
  },
}));

app.use(express.json({ limit: '2mb' }));           // orders carry an items[] array
app.use(requestLogger);

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Keyed on the CLIENT IP.
//
// Keying on the session token was tried and rejected: logging in mints a fresh token
// (single-session-per-user), so an attacker resets their whole budget just by
// re-authenticating — the limit becomes login-rate × per-token-limit instead of the number
// on the tin. IP is the only identifier the caller cannot rotate at will here.
//
// The cost is that a shop's tills share one public IP and therefore one budget, so the
// numbers below are sized for a whole store rather than a single terminal.
//
// `trust proxy` is 1 (Caddy/Heroku), so req.ip is the real client, not the proxy.
const limiterKey = (req) => {
  // IPv6 callers are bucketed by /64: one bucket per address would make the limit free to
  // evade, since a single host is routinely handed a whole /64.
  const ip = req.ip || '';
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
};

// The ceilings are sized for a whole shop behind one IP (see each mount below), but a
// busy multi-till store — or a test run, which logs in far more often than a human — needs
// to raise them without editing code. Each is an env override with the shipped value as
// the default; a non-numeric or absent value keeps the default.
const envMax = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const limiter = (windowMs, max) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: limiterKey,   // IPv6 normalisation handled above
  message: { error: 'rate_limited' },
});

// Throttle auth endpoints (login + reset) to blunt credential stuffing. Per-USERNAME
// lockout lives in server/auth.js (pin_attempts) — this is the per-caller layer on top.
app.use(['/api/auth/login', '/api/auth/request-reset', '/api/auth/confirm-reset'],
  limiter(15 * 60 * 1000, envMax('AUTH_RATE_LIMIT_MAX', 30)));

// Expensive read paths: the reports aggregates and the AI insight queries scan 30 days of
// orders with jsonb_array_elements. On a shared VPS one authenticated user hammering these
// degrades EVERY client on the box, so they get their own tight budget.
app.use(['/api/reports', '/api/ai/insights', '/api/timeclock', '/api/jofotara/pending'],
  limiter(5 * 60 * 1000, envMax('REPORTS_RATE_LIMIT_MAX', 120)));

// Global backstop for everything else under /api. Sized for a WHOLE SHOP behind one IP:
// several tills checking out continuously (a sale is ~5 calls) sit far under 4 req/s,
// while a scripted flood hits the ceiling immediately.
app.use('/api', limiter(5 * 60 * 1000, envMax('API_RATE_LIMIT_MAX', 1200)));

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', require('./routes'));

// ── Per-client identity, handed to the browser at RUNTIME ─────────────────────
// This is what lets ONE image serve every shop: the bundle ships with defaults and this
// response overrides them, so a client is an .env file rather than its own React build.
//
// A file, not an inline <script>, because script-src is 'self' with no 'unsafe-inline'
// (see the CSP above) — an inline block would be blocked, and loosening the policy to allow
// it would hand any XSS the cashier's session token. A same-origin script SRC is allowed
// under exactly the policy already in force, so this costs nothing.
//
// It must load BEFORE the bundle. public/index.html requests it with a plain <script> in
// <head>; CRA's own bundle tag is `defer`, and a blocking script in head always runs before
// a deferred one, so window.__CLIENT__ is set by the time any module body evaluates.
//
// Registered ahead of express.static so it wins over any stale build/client-config.js, and
// ahead of the SPA catch-all so a request for it never comes back as index.html.
const { clientConfigScript, manifest } = require('./clientConfig');

app.get('/client-config.js', (_req, res) => {
  // no-store for the same reason index.html is no-store: an operator who fixes a shop's
  // name or VAT rate and restarts must not be overruled by a cached copy on the till. It is
  // a few hundred bytes on app launch, not per request.
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.type('application/javascript').send(clientConfigScript());
});

// Same reasoning for the PWA manifest: the installed app's name on a cashier's home screen
// comes from here, and a static one would name every client's till "Liquor Store POS".
app.get('/manifest.json', (_req, res) => {
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.json(manifest());
});

// ── Static React build (optional — present after `npm run build` / heroku-postbuild)
const buildDir = path.join(__dirname, '..', 'build');
const buildIndex = path.join(buildDir, 'index.html');
if (fs.existsSync(buildIndex)) {
  // Hashed assets (main.[hash].js/css) keep default caching; index.html must NOT be cached
  // so every app launch fetches the current shell → current bundle. Otherwise an installed
  // PWA can pin a stale index.html and run an old JS build (floors drift to different versions).
  app.use(express.static(buildDir, {
    setHeaders: (res, p) => {
      if (p.endsWith('index.html')) res.set('Cache-Control', 'no-store, must-revalidate');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.set('Cache-Control', 'no-store, must-revalidate');
    res.sendFile(buildIndex);
  });
} else {
  app.get('/', (_req, res) =>
    res.json({ status: 'api-only', note: 'No React build present. Run `npm run build` to serve the app.' }));
}

// JSON 404 for unmatched /api routes.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// Centralised error handler — never leak internals to the client, never lose them here.
// The response stays a bare { error: 'server' }; the stack goes to the log and, if a
// webhook is configured, to whoever is on call.
app.use((err, req, res, _next) => {
  // An over-sized body is rejected by express.json BEFORE any route sees it. That is the
  // caller's problem, not a server fault: reporting it as 500 both misleads the client and
  // pages the on-call channel for someone uploading a large picture.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: 'too_large' });
  }
  // Malformed JSON is likewise a 400, not a crash.
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid' });
  }
  const fields = {
    req: req.id,
    route: req.originalUrl ? req.originalUrl.split('?')[0] : null,
    method: req.method,
    user: (req.user && req.user.username) || null,
    error: (err && err.message) || String(err),
    code: err && err.code,
    stack: err && err.stack ? String(err.stack).split('\n').slice(0, 8).join(' | ') : null,
  };
  log.error('unhandled error', fields);
  alert('unhandled API error', { route: fields.route, error: fields.error, req: fields.req });
  res.status(500).json({ error: 'server' });
});

// A rejected promise with no catch, or a thrown error outside a request, would otherwise
// kill the container silently and let Docker restart it with nobody the wiser.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: (reason && reason.message) || String(reason) });
  alert('unhandled promise rejection', { error: (reason && reason.message) || String(reason) });
});
process.on('uncaughtException', (e) => {
  log.error('uncaught exception', { error: e.message, stack: String(e.stack).split('\n').slice(0, 8).join(' | ') });
  alert('uncaught exception — process is exiting', { error: e.message });
  // Let it die: the state is unknown. Docker's restart policy brings back a clean process.
  setTimeout(() => process.exit(1), 250);
});

// Bind a port only when this file is the entrypoint (`npm run server`). Required by
// supertest, which mounts `app` directly and needs no listener of its own — without this
// guard every test run would race the dev server for :3001.
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => log.info('api listening', { port: PORT, tz: process.env.STORE_TZ || 'Asia/Amman' }));
}

module.exports = app;
