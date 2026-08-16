import {
  money, cashSuggestions, catColor, escapeHtml, remainingQty, returnedMapFor,
  nowParts, todayInStore, splitInclusiveTax, storeTimeOf, storeDateOf, isServerFault,
} from './lib';

// Checkout used to send `tax: 0, sub: total` and never import TAX_RATE, so a shop
// documented as charging 16% VAT recorded none of it.
describe('splitInclusiveTax', () => {
  test('carves the VAT out of the total instead of adding it on top', () => {
    // 72.000 inclusive of 16% → net 62.069, VAT 9.931. The customer still pays 72.000.
    const { net, tax } = splitInclusiveTax(72, 0.16);
    expect(tax).toBe(9.931);
    expect(net).toBe(62.069);
  });

  test('net + tax always reconstructs the total exactly', () => {
    for (const total of [0.5, 7.35, 23, 41, 185, 1250.5]) {
      const { net, tax } = splitInclusiveTax(total, 0.16);
      expect(net + tax).toBeCloseTo(total, 3);
    }
  });

  test('rounds to fils, so no float noise reaches the tax column', () => {
    const { net, tax } = splitInclusiveTax(23, 0.16);
    expect(Number.isInteger(tax * 1000)).toBe(true);
    expect(Number.isInteger(net * 1000)).toBe(true);
  });

  test('a zero rate means no tax and the whole total is net', () => {
    expect(splitInclusiveTax(50, 0)).toEqual({ net: 50, tax: 0 });
  });

  test('handles an empty cart', () => {
    expect(splitInclusiveTax(0, 0.16)).toEqual({ net: 0, tax: 0 });
  });
});

// The store clock. `date` used to come from toISOString() (UTC) while `time` came from
// toTimeString() (the terminal's clock) — two different clocks, so a 01:00 sale in Amman
// was stamped with yesterday's date. Both halves now come from one pass in STORE_TZ.
describe('nowParts', () => {
  test('stamps date and time from the same clock', () => {
    // 2026-06-20 01:30 in Amman (UTC+3) === 2026-06-19 22:30 UTC.
    const p = nowParts(new Date('2026-06-19T22:30:00Z'));
    expect(p.date).toBe('2026-06-20');
    expect(p.time).toBe('01:30:00');
  });

  test('does not roll the date over until local midnight', () => {
    const before = nowParts(new Date('2026-06-22T20:59:00Z'));  // 23:59 local
    const after = nowParts(new Date('2026-06-22T21:01:00Z'));   // 00:01 local, next day
    expect(before.date).toBe('2026-06-22');
    expect(before.time).toBe('23:59:00');
    expect(after.date).toBe('2026-06-23');
    expect(after.time).toBe('00:01:00');
  });

  test('renders local midnight as 00, never 24', () => {
    expect(nowParts(new Date('2026-06-22T21:00:00Z')).time).toBe('00:00:00');
  });

  test('emits zero-padded, parseable strings', () => {
    const p = nowParts(new Date('2026-01-05T06:07:08Z'));
    expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(p.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  test('todayInStore agrees with the date half', () => {
    expect(todayInStore()).toBe(nowParts().date);
  });
});

// History orders by created_at but used to print the client-written `time` column. When an
// imported or pre-fix row disagreed, a 12:00 sale appeared above a 22:52 one.
describe('store clock read from created_at', () => {
  test('renders the timestamp in the store timezone, not UTC', () => {
    expect(storeTimeOf('2026-08-08T19:52:00Z')).toBe('22:52');
    expect(storeDateOf('2026-08-08T19:52:00Z')).toBe('2026-08-08');
  });

  test('a post-midnight sale reads as the next trading day', () => {
    expect(storeDateOf('2026-08-08T21:30:00Z')).toBe('2026-08-09');
    expect(storeTimeOf('2026-08-08T21:30:00Z')).toBe('00:30');
  });

  test('ordering by created_at now matches the time shown', () => {
    const rows = [
      { created_at: '2026-08-08T19:53:12Z', time: '12:00' },   // legacy row: columns disagree
      { created_at: '2026-08-08T19:52:00Z', time: '22:52' },
    ];
    expect(rows.map((r) => storeTimeOf(r.created_at, r.time))).toEqual(['22:53', '22:52']);
  });

  test('falls back to the stored text when there is no timestamp', () => {
    expect(storeTimeOf(null, '14:09:00')).toBe('14:09');
    expect(storeDateOf(undefined, '2026-08-08')).toBe('2026-08-08');
  });

  test('survives a malformed timestamp', () => {
    expect(storeTimeOf('not-a-date', '09:15:00')).toBe('09:15');
  });
});

describe('money', () => {
  test('formats to 3 decimals with currency', () => {
    expect(money(7.5)).toBe('7.500 JOD');
  });
  test('treats null/undefined/NaN as zero', () => {
    expect(money(null)).toBe('0.000 JOD');
    expect(money(undefined)).toBe('0.000 JOD');
    expect(money('abc')).toBe('0.000 JOD');
  });
});

describe('cashSuggestions', () => {
  test('suggests the notes a customer would hand over', () => {
    // total 7.350 → half-dinar round-up 7.5, dinar 8, then 10, 20, 50
    expect(cashSuggestions(7.35)).toEqual([7.5, 8, 10, 20, 50]);
  });
  test('every suggestion covers the total', () => {
    for (const total of [0.25, 3.999, 12.001, 49.5]) {
      cashSuggestions(total).forEach((s) => expect(s).toBeGreaterThanOrEqual(total));
    }
  });
  test('dedupes when round-ups collide', () => {
    const s = cashSuggestions(10); // 10 is exact for 0.5/1/5/10 steps
    expect(new Set(s).size).toBe(s.length);
    expect(s[0]).toBe(10);
  });
  test('falls back to standard notes for zero/invalid totals', () => {
    expect(cashSuggestions(0)).toEqual([1, 5, 10, 20, 50]);
    expect(cashSuggestions(-3)).toEqual([1, 5, 10, 20, 50]);
  });
});

describe('catColor', () => {
  test('same category always maps to the same color', () => {
    expect(catColor('dairy')).toBe(catColor('dairy'));
  });
  test('different categories get different hues (for common names)', () => {
    expect(catColor('dairy')).not.toBe(catColor('snacks'));
  });
});

describe('escapeHtml', () => {
  test('escapes all five HTML special characters', () => {
    expect(escapeHtml(`<b a="x" b='y'>&`)).toBe('&lt;b a=&quot;x&quot; b=&#39;y&#39;&gt;&amp;');
  });
  test('null/undefined become empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('returns clamping', () => {
  const sale = { invoice_no: 7, items: [{ id: 1, name: 'Milk', qty: 3, price: 1 }, { id: 2, name: 'Bread', qty: 2, price: 0.5 }] };
  const refund = { status: 'refund', buyer: 'return of #7', items: [{ id: 1, name: 'Milk', qty: 2, price: 1 }] };

  test('remaining = sold minus already returned', () => {
    const map = returnedMapFor(sale, [sale, refund]);
    expect(remainingQty(sale.items[0], map)).toBe(1);   // 3 sold − 2 returned
    expect(remainingQty(sale.items[1], map)).toBe(2);   // untouched
  });
  test('never negative even if data over-counts', () => {
    const map = { 1: 99 };
    expect(remainingQty(sale.items[0], map)).toBe(0);
  });
  test('ignores refunds that belong to other invoices', () => {
    const other = { ...refund, buyer: 'return of #8' };
    const map = returnedMapFor(sale, [sale, other]);
    expect(remainingQty(sale.items[0], map)).toBe(3);
  });
});

// The predicate that decides whether a failed checkout is queued or thrown away. It got this
// wrong for every 5xx, which is the single likeliest outage a shop will actually meet: the
// server up, its database restarting.
describe('isServerFault', () => {
  test.each([
    ['nothing answered at all', {}],
    ['a 500', { status: 500 }],
    ['a 502 from the reverse proxy', { status: 502 }],
    ['a 503 while the database is starting', { status: 503 }],
    ['a 504 gateway timeout', { status: 504 }],
  ])('%s is the server side failing, so the sale is kept', (_label, ex) => {
    expect(isServerFault(ex)).toBe(true);
  });

  test.each([
    ['a 400 bad payload', { status: 400 }],
    ['a 401 expired session', { status: 401 }],
    ['a 403', { status: 403 }],
    ['a 404', { status: 404 }],
    ['a 409 invoice clash', { status: 409 }],
    ['a 429 rate limit', { status: 429 }],
  ])('%s is about the request, so it is not queued', (_label, ex) => {
    expect(isServerFault(ex)).toBe(false);
  });

  test('no error object at all is not treated as an outage', () => {
    // Queueing on a null would let any unrelated bug in the checkout path silently bank a
    // sale the server never heard of.
    expect(isServerFault(null)).toBe(false);
    expect(isServerFault(undefined)).toBe(false);
  });

  test('a 409 stays excluded — it has its own retry path', () => {
    // invoice_taken is handled by re-fetching a number and sending again immediately.
    // Queueing it instead would park a sale that could have gone through on the spot.
    expect(isServerFault({ status: 409, message: 'invoice_taken' })).toBe(false);
  });
});
