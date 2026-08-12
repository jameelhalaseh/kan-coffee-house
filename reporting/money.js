// Money model (§2 and §4).
//
// Prices are TAX-INCLUSIVE. The net figures are backed out ONCE, at checkout — for this build
// that is splitInclusiveTax() in src/lib.js, whose result is frozen onto the order row. THIS
// MODULE NEVER RECOMPUTES TAX. It sums the stored sub / tax / total and nothing else.
//
// That is a deliberate deletion, not an omission: an earlier version of this file carried its
// own extraction (net = gross / (1+svc)(1+vat), discount on the net base) written for a
// restaurant with a 10% service charge. This shop has no service charge and rounds to 3
// decimals, so keeping that function would have meant two disagreeing definitions of the same
// number, one of them dead. The live one is in src/lib.js.
//
// §4 — round at the EDGE. Sum at full precision; round when a cell is written.
const { d } = require('./decimal');
const { store } = require('./stores');

// Round half away from zero to `dp` decimals. Half away from zero, not Math.round (which is
// asymmetric for negatives) and not banker's rounding.
const roundTo = (n, dp = 3) => d(n).round(dp);

// The shop's own precision. JOD is a 3-decimal currency and this build's receipts, invoices
// and stored order rows are all 3dp, so a report that rounded to 2 would print a total the
// customer's invoice contradicts.
const roundFor = (floor, n) => roundTo(n, store(floor).dp);

// r2 is kept because §4 names it, and because a 2dp currency would need exactly this.
const r2 = (n) => roundTo(n, 2);

// Display: fixed decimals plus the currency label.
const fmt = (n, floor) => {
  const s = store(floor);
  return `${d(n).toFixed(s.dp)} ${s.currency}`;
};

// Keys whose value is a COUNT, not an amount. "6 items" must not be serialised as "6.000".
const COUNT_KEYS = new Set(['itemsSold', 'qty', 'orders']);

/**
 * Serialise a report for JSON at the store's precision.
 *
 * This is the EDGE that §4 talks about: everything upstream sums at full precision, and the
 * amounts are rounded exactly once — here, on the way out. Sending a raw D would let the
 * browser see 30.0015 and round it a second time, differently.
 *
 * Amounts become fixed-precision STRINGS, never numbers: JSON.parse would turn 2.241 back
 * into a float in the client, which is the whole thing this module exists to avoid.
 */
function serialize(value, dp, key = null) {
  const { D } = require('./decimal');
  if (value instanceof D) return COUNT_KEYS.has(key) ? value.toTrimmed(3) : value.toFixed(dp);
  if (Array.isArray(value)) return value.map((v) => serialize(v, dp, key));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v, dp, k);
    return out;
  }
  return value;
}

module.exports = { roundTo, roundFor, r2, fmt, serialize, COUNT_KEYS };
