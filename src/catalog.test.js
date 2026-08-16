// The cached catalogue — what lets a till keep selling with the server gone.
import { saveCatalog, readCatalog, catalogAgeHours, clearCatalog } from './catalog';
import { CATALOG_KEY } from './constants';

const PRODUCTS = [
  { id: 1, name: 'Johnnie Walker Black 700ml', price: 25.5, barcode: '5000267023656', cat: 'Whiskey', stock: 6 },
  { id: 2, name: 'Amstel 500ml', price: 1.9, barcode: '8712000023416', cat: 'Beer', stock: 48 },
];

beforeEach(() => localStorage.clear());

describe('saving', () => {
  test('round-trips the catalogue', () => {
    expect(saveCatalog(PRODUCTS)).toBe(true);
    expect(readCatalog().products).toEqual(PRODUCTS);
  });

  test('records when it was taken, so the cashier can be told how old it is', () => {
    saveCatalog(PRODUCTS);
    expect(typeof readCatalog().at).toBe('number');
  });

  test('refuses to overwrite a good copy with an empty one', () => {
    // An empty array is what a broken query or a half-migrated database returns, and caching
    // it would replace a working catalogue with nothing right before an outage.
    saveCatalog(PRODUCTS);
    expect(saveCatalog([])).toBe(false);
    expect(readCatalog().products).toHaveLength(2);
  });

  test('a storage failure is not fatal — the sale matters, the cache does not', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(saveCatalog(PRODUCTS)).toBe(false);
    spy.mockRestore();
  });
});

describe('reading defensively', () => {
  test.each([
    ['nothing stored', null],
    ['empty string', ''],
    ['truncated JSON', '{"products":[{"id":1,'],
    ['an empty list', '{"products":[]}'],
    ['not a list', '{"products":"everything"}'],
    ['rows with no name', '{"products":[{"id":1}]}'],
  ])('%s reads as no catalogue rather than crashing the till', (_label, raw) => {
    expect(readCatalog(raw)).toBeNull();
  });

  test('tolerates a bare array from an older shape of the app', () => {
    expect(readCatalog(JSON.stringify(PRODUCTS)).products).toEqual(PRODUCTS);
  });

  test('reads what was actually written to the key', () => {
    saveCatalog(PRODUCTS);
    expect(JSON.parse(localStorage.getItem(CATALOG_KEY)).products).toHaveLength(2);
  });
});

describe('age', () => {
  test('is reported in whole hours', () => {
    const now = Date.now();
    expect(catalogAgeHours(now - 3 * 3600000, now)).toBe(3);
  });

  test('a fresh copy is 0 hours, never negative on a clock skew', () => {
    const now = Date.now();
    expect(catalogAgeHours(now, now)).toBe(0);
    expect(catalogAgeHours(now + 60000, now)).toBe(0);
  });

  test('unknown when the copy predates timestamping', () => {
    expect(catalogAgeHours(null)).toBeNull();
  });
});

describe('clearing', () => {
  test('removes it', () => {
    saveCatalog(PRODUCTS);
    clearCatalog();
    expect(readCatalog()).toBeNull();
  });
});
