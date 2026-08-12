// Exact decimal arithmetic for the reporting module.
//
// The spec is explicit: "Read them as decimals; never let a float representation reach the
// stored value." Binary floats cannot do that. 11.60 / 1.16 in IEEE-754 is
// 9.999999999999998, and r2() would still save 10.00 — but the same drift accumulated over
// a month of sums is what makes a tax filing disagree with the till by a piastre.
//
// So every money value is a BigInt scaled by 10^SCALE. Nine guard digits is far more than
// the two the reports display, which leaves room for the division in the tax extraction
// (a non-terminating quotient like 1/1.276) without the residue reaching the cent column.
//
// There is no dependency here on purpose. decimal.js exists in node_modules, but only as a
// transitive of a build tool — depending on it from product code would make the reports
// break the day that tool is swapped.

const SCALE = 9n;
const UNIT = 10n ** SCALE;

// Divide two BigInts, rounding HALF AWAY FROM ZERO — the same rule as r2(), applied at
// every intermediate step so a value never picks up a different rounding bias depending on
// which operation produced it. `den` must be positive.
function divRound(num, den) {
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

// Parse a decimal LITERAL — a string, a BigInt, or a number — into a scaled BigInt.
//
// Numbers go through String(n), which gives JS's shortest round-tripping representation:
// String(11.6) is "11.6", not "11.599999999999999". That is exactly the decimal the author
// wrote, so a test literal and a DB string parse identically. A number that is not a safe
// integer-scale value (Infinity, NaN) is rejected rather than silently becoming 0.
function parse(v) {
  if (v instanceof D) return v.v;
  if (typeof v === 'bigint') return v * UNIT;
  if (v === null || v === undefined || v === '') return 0n;

  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError(`not a decimal: ${v}`);
    s = String(v);
  } else {
    s = String(v).trim();
  }
  if (s === '' || s === '-' || s === '+') return 0n;

  // Exponent form ("1e-7") turns up in String(n) for very small numbers. Normalise it by
  // shifting the decimal point rather than going back through a float.
  const exp = s.match(/^([+-]?[\d.]+)[eE]([+-]?\d+)$/);
  if (exp) {
    const shift = Number(exp[2]);
    const base = parse(exp[1]);
    return shift >= 0
      ? base * 10n ** BigInt(shift)
      : divRound(base, 10n ** BigInt(-shift));
  }

  const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!m) throw new TypeError(`not a decimal: ${v}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] || '0';
  const frac = m[3] || '';

  // Pad or truncate the fraction to SCALE digits. Truncation only bites on input carrying
  // more than nine decimals, which no money source produces.
  const fracPadded = (frac + '0'.repeat(Number(SCALE))).slice(0, Number(SCALE));
  return sign * (BigInt(whole) * UNIT + BigInt(fracPadded));
}

class D {
  constructor(v) { this.v = typeof v === 'bigint' ? v : parse(v); }

  add(o) { return raw(this.v + parse(o)); }
  sub(o) { return raw(this.v - parse(o)); }
  mul(o) { return raw(divRound(this.v * parse(o), UNIT)); }

  div(o) {
    const d = parse(o);
    if (d === 0n) throw new RangeError('division by zero');
    // Normalise the sign onto the numerator so divRound's positive-denominator contract holds.
    return raw(d < 0n ? divRound(-this.v * UNIT, -d) : divRound(this.v * UNIT, d));
  }

  neg() { return raw(-this.v); }
  cmp(o) { const d = parse(o); return this.v < d ? -1 : this.v > d ? 1 : 0; }
  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  gt(o) { return this.cmp(o) > 0; }
  isZero() { return this.v === 0n; }
  isNeg() { return this.v < 0n; }

  // Round to `places` decimals, half away from zero, and return a D. This is the ONLY
  // place precision is dropped.
  round(places = 2) {
    const p = BigInt(places);
    if (p >= SCALE) return this;
    const step = 10n ** (SCALE - p);
    return raw(divRound(this.v, step) * step);
  }

  // Fixed-point string. Used for display and for handing a value to the database, so it
  // never goes back through a float on the way out.
  toFixed(places = 2) {
    const r = this.round(places).v;
    const neg = r < 0n;
    const a = neg ? -r : r;
    const whole = a / UNIT;
    const frac = (a % UNIT).toString().padStart(Number(SCALE), '0').slice(0, places);
    const sign = neg && (whole !== 0n || /[1-9]/.test(frac)) ? '-' : '';
    return places > 0 ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
  }

  toString() { return this.toFixed(2); }

  // Only for places that genuinely need a JS number (chart libraries, xlsx numeric cells).
  // Never feed the result back into money maths.
  toNumber() { return Number(this.toFixed(Number(SCALE))); }

  // Trimmed exact form — all significant decimals, no trailing zeros. Used for counts, and
  // as the last-resort JSON form.
  toTrimmed(maxDp = Number(SCALE)) {
    const s = this.toFixed(maxDp);
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }

  // NOTE: money is NOT serialised through here — reporting/money.js serialize() formats every
  // amount at the STORE's precision (3dp for JOD) before the response is written. This used to
  // be toFixed(2), which silently truncated 2.241 to "2.24" on its way to the browser: the
  // report then disagreed with the printed invoice by a fils on every third sale. If you find
  // yourself relying on this method for an amount, you are on the wrong path.
  toJSON() { return this.toTrimmed(); }
}

const raw = (v) => new D(v);
const d = (v) => (v instanceof D ? v : new D(v));

// Sum at FULL precision. §4 of the spec: sum unrounded, round at the edge — so this must
// never round per element.
const sum = (list, pick = (x) => x) =>
  list.reduce((acc, item) => acc.add(d(pick(item) ?? 0)), d(0));

module.exports = { D, d, sum, SCALE: Number(SCALE) };
