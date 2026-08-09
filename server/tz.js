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

module.exports = { STORE_TZ, tradingDate, todayInStore };
