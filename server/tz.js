// The shop's clock.
//
// `created_at` is timestamptz (UTC on the wire). "Which trading day was this sale?" is a
// question about the SHOP's clock, not UTC — and the two disagree for three hours every
// night in Jordan (UTC+3), which is exactly when an off-licence is busiest. Grouping by
// `created_at::date` therefore filed every sale rung between midnight and 03:00 under the
// previous day, in History, the daily chart and the Z-report alike.
//
// STORE_TZ must match `store.timezone` in src/client.config.js: the browser stamps
// date/time at checkout, the server groups by this zone, and a mismatch would split one
// night's takings across two days.
const STORE_TZ = (process.env.STORE_TZ || 'Asia/Amman').trim();

// Reject anything that isn't a plain IANA zone name before it reaches SQL. The value is
// operator-supplied (env), never user-supplied, but it IS interpolated into the query text
// — Postgres has no parameter slot for AT TIME ZONE — so it gets validated once at boot.
if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(STORE_TZ)) {
  throw new Error(`STORE_TZ is not a valid IANA timezone name: ${STORE_TZ}`);
}

const TZ_LITERAL = `'${STORE_TZ}'`;

// SQL for "the trading date of `col`", as a DATE in the store's zone.
//   tradingDate('created_at')  →  (created_at at time zone 'Asia/Amman')::date
const tradingDate = (col = 'created_at') => `((${col} at time zone ${TZ_LITERAL})::date)`;

// The store's current trading date as YYYY-MM-DD. Mirrors todayInStore() in src/lib.js so
// a default computed on the server matches one computed in the browser. 'en-CA' is the
// shortest way to get ISO ordering out of Intl.
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const todayInStore = (at = new Date()) => dateFormatter.format(at);

// ── Index-friendly day windows ────────────────────────────────────────────────
// `tradingDate('created_at') = $1` is correct but wraps the indexed column in a function,
// so Postgres seq-scans: EXPLAIN showed 145 rows discarded to return 6. Fine at 151 rows,
// not fine at the ~36k a shop doing 100 sales a day reaches inside a year — and every
// History load and Z-report pays it.
//
// An expression index can't rescue it either: `AT TIME ZONE` on a timestamptz is STABLE,
// not IMMUTABLE (the tz database can change under it), so Postgres refuses to index it.
//
// So resolve the trading date to a half-open UTC instant range HERE, and let SQL do a plain
// `created_at >= $1 and created_at < $2` range scan on idx_orders_main_created. Identical
// rows, index used.

// What does STORE_TZ's clock read at a given instant, as a UTC-based timestamp? The gap
// between that and the instant itself is the zone's offset then — which is how we invert
// "local wall time" back to "UTC instant" without hardcoding +03:00 or assuming DST rules.
const offsetFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

function offsetMsAt(instant) {
  const p = {};
  for (const { type, value } of offsetFormatter.formatToParts(instant)) p[type] = value;
  const hour = p.hour === '24' ? '00' : p.hour;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asUtc - instant.getTime();
}

// Local wall-clock midnight of `isoDate` in STORE_TZ, as a UTC Date.
function localMidnightUtc(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // One correction pass resolves the offset; a second settles the rare case where the guess
  // and the true instant sit on opposite sides of a DST transition. (Jordan has been on a
  // fixed UTC+3 since 2022, but this must not silently break for a client in a zone that
  // still shifts.)
  let t = guess - offsetMsAt(new Date(guess));
  t = guess - offsetMsAt(new Date(t));
  return new Date(t);
}

// Half-open [start, end) covering one trading day. End is the NEXT day's local midnight,
// computed rather than start+24h, so a DST day of 23 or 25 hours still comes out whole.
function dayRangeUtc(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + 1);
  return {
    start: localMidnightUtc(isoDate),
    end: localMidnightUtc(next.toISOString().slice(0, 10)),
  };
}

module.exports = { STORE_TZ, tradingDate, todayInStore, dayRangeUtc, localMidnightUtc };
