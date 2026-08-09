import { money, cashSuggestions, catColor, escapeHtml, remainingQty, returnedMapFor } from './lib';

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
