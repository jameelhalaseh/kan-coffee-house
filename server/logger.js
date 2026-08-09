// Structured logging + 5xx alerting for the API.
//
// The frontend has had Sentry since day one; the server had console.error and nothing else.
// A 500 inside the checkout transaction was invisible until a cashier picked up the phone.
//
// No new dependency, deliberately: this box runs one small container per client and the
// logs are already collected by Docker (and Caddy for the edge). What was missing is that
// they were unparseable prose and that nothing ever *told* anyone. So:
//   - one JSON object per line, greppable and machine-readable
//   - every request tagged with an id, echoed to the client, so a user's "it broke" maps to
//     an exact line
//   - 5xx responses POST to ALERT_WEBHOOK_URL (Slack/Discord/ntfy — any URL that takes JSON)
//
// NEVER log request bodies. They carry passwords on /auth/login and PII on /customers.
const crypto = require('crypto');

const SERVICE = process.env.SERVICE_NAME || 'liquor-pos';
const ALERT_URL = (process.env.ALERT_WEBHOOK_URL || '').trim();
const ALERT_MIN_GAP_MS = Number(process.env.ALERT_MIN_GAP_MS) || 5 * 60 * 1000;

// The suite makes thousands of requests; one JSON line each would bury the actual results.
// Set LOG_IN_TESTS=1 when debugging a test against real log output.
const SILENT = process.env.NODE_ENV === 'test' && process.env.LOG_IN_TESTS !== '1';

function line(level, msg, fields = {}) {
  if (SILENT) return;
  const rec = { ts: new Date().toISOString(), level, service: SERVICE, msg, ...fields };
  const out = JSON.stringify(rec);
  if (level === 'error') console.error(out);
  else console.log(out);
}

const log = {
  info: (msg, f) => line('info', msg, f),
  warn: (msg, f) => line('warn', msg, f),
  error: (msg, f) => line('error', msg, f),
};

// One alert per distinct fingerprint per window. A failing dependency produces the same
// error on every request, and an alert channel that fires 500 times gets muted by whoever
// owns the phone — which is worse than no alerting at all.
const lastSent = new Map();
function shouldSend(fingerprint) {
  const now = Date.now();
  const prev = lastSent.get(fingerprint) || 0;
  if (now - prev < ALERT_MIN_GAP_MS) return false;
  lastSent.set(fingerprint, now);
  // Bound the map: without this a long-lived process with varied errors leaks entries.
  if (lastSent.size > 500) {
    for (const [k, t] of lastSent) if (now - t > ALERT_MIN_GAP_MS) lastSent.delete(k);
  }
  return true;
}

async function alert(title, fields = {}) {
  if (!ALERT_URL) return;
  const fingerprint = `${fields.route || ''}|${String(fields.error || '').slice(0, 120)}`;
  if (!shouldSend(fingerprint)) return;

  const text = [`🚨 ${SERVICE}: ${title}`]
    .concat(Object.entries(fields).map(([k, v]) => `${k}: ${String(v).slice(0, 500)}`))
    .join('\n');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      // `text` suits Slack/Discord/ntfy; the full object is there for anything else.
      await fetch(ALERT_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, service: SERVICE, title, ...fields }),
      });
    } finally { clearTimeout(timer); }
  } catch (e) {
    // An alerting failure must never take down the request that triggered it.
    log.warn('alert delivery failed', { error: e.message });
  }
}

// Tag each request, time it, and log the outcome once the response is out the door.
function requestLogger(req, res, next) {
  const id = crypto.randomUUID().slice(0, 8);
  const started = process.hrtime.bigint();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const fields = {
      req: id,
      method: req.method,
      route: req.originalUrl.split('?')[0],   // query strings can carry filters, not secrets — still dropped
      status: res.statusCode,
      ms: Math.round(ms),
      user: (req.user && req.user.username) || null,
    };
    // 5xx is ours to fix; 4xx is the caller's and is normal traffic (a wrong password, a
    // duplicate barcode) so it stays at info.
    if (res.statusCode >= 500) log.error('request failed', fields);
    else if (ms > 2000) log.warn('slow request', fields);
    else log.info('request', fields);
  });

  next();
}

module.exports = { log, alert, requestLogger };
