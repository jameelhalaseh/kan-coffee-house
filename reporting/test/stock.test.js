// §5.7 Stock — the arithmetic, with no database in sight.
//
// The property under test throughout is the identity a stock take is judged by:
//
//     opening + received − sold + returned + adjusted  =  closing
//
// It holds by construction, so proving it holds proves little on its own. What these tests
// actually pin is that each movement is counted ONCE, from the right source, on the right
// side of the period boundary — which is where a stock report goes wrong in practice.
const { stockReport } = require('../stock');

const P = (over = {}) => ({
  id: 1, name: 'Arak', size: '750ml', cat: 'Arak', barcode: '629',
  cost: '6', price: '10', stock: '12', low_at: '5', active: true, ...over,
});
const AUG = { from: '2026-08-01', to: '2026-08-31', label: 'August' };

const sale = (date, qty, over = {}) => ({
  floor: 'main', date, status: 'paid',
  items: [{ id: 1, name: 'Arak', qty, price: '10' }], ...over,
});
const receipt = (date, qty, over = {}) => ({
  product_id: 1, date, qty, cost: '6', supplier: 'Amman Drinks', ...over,
});
const adjust = (date, from, to, over = {}) => ({
  item_id: '1', kind: 'adjust', date, old_qty: from, new_qty: to, changed_by: 'owner', ...over,
});

const only = (rep) => rep.rows[0];
const balances = (r) => Number(r.opening.toTrimmed()) + Number(r.received.toTrimmed())
  - Number(r.sold.toTrimmed()) + Number(r.returned.toTrimmed()) + Number(r.adjusted.toTrimmed())
  === Number(r.closing.toTrimmed());

describe('opening and closing balances', () => {
  test('walks back from the shelf count rather than forward from zero', () => {
    // 12 on the shelf now; 10 came in and 3 went out inside August, so August opened with 5.
    const r = only(stockReport([P({ stock: '12' })], [sale('2026-08-05', 3)],
      [receipt('2026-08-03', '10')], [], 'main', AUG));
    expect(r.opening.toTrimmed()).toBe('5');
    expect(r.closing.toTrimmed()).toBe('12');
    expect(balances(r)).toBe(true);
  });

  test('movements AFTER the period are undone to reach the closing balance', () => {
    // This is the case a naive report gets wrong: it shows today's shelf count as the
    // closing balance of a period that ended weeks ago.
    const r = only(stockReport([P({ stock: '12' })],
      [sale('2026-08-05', 3), sale('2026-09-20', 4)], [], [], 'main', AUG));
    expect(r.closing.toTrimmed()).toBe('16');   // the 4 sold in September go back on
    expect(r.opening.toTrimmed()).toBe('19');
    expect(r.stockNow.toTrimmed()).toBe('12');  // and the shelf figure is reported as-is
  });

  test('movements BEFORE the period are ignored entirely', () => {
    const r = only(stockReport([P({ stock: '12' })],
      [sale('2026-07-15', 99), sale('2026-08-05', 3)], [], [], 'main', AUG));
    expect(r.sold.toTrimmed()).toBe('3');
    expect(r.opening.toTrimmed()).toBe('15');
  });

  test('a product that never moved reports the shelf count on both sides', () => {
    const r = only(stockReport([P({ stock: '7' })], [], [], [], 'main', AUG));
    expect(r.opening.toTrimmed()).toBe('7');
    expect(r.closing.toTrimmed()).toBe('7');
    expect(r.dead).toBe(true);
  });
});

describe('each movement is counted once, from the right source', () => {
  test('a delivery brings its supplier, unit cost and what the shop paid', () => {
    const r = only(stockReport([P()], [], [receipt('2026-08-03', '10')], [], 'main', AUG));
    expect(r.received.toTrimmed()).toBe('10');
    expect(r.purchases.toFixed(3)).toBe('60.000');
    expect(r.suppliers).toEqual(['Amman Drinks']);
    expect(r.lastReceived).toBe('2026-08-03');
    expect(r.receipts[0]).toMatchObject({ date: '2026-08-03', supplier: 'Amman Drinks' });
    expect(r.receipts[0].unitCost.toFixed(3)).toBe('6.000');
    expect(r.receipts[0].lineCost.toFixed(3)).toBe('60.000');
  });

  test('a manual correction carries its before, after, and who made it', () => {
    const r = only(stockReport([P()], [], [], [adjust('2026-08-06', '6', '5')], 'main', AUG));
    expect(r.adjusted.toTrimmed()).toBe('-1');
    expect(r.adjustments[0]).toMatchObject({ kind: 'adjust', by: 'owner' });
    expect(r.adjustments[0].fromQty.toTrimmed()).toBe('6');
    expect(r.adjustments[0].toQty.toTrimmed()).toBe('5');
  });

  test('a refund puts the goods back and is not counted as a sale', () => {
    const rep = stockReport([P()], [
      sale('2026-08-05', 3),
      { floor: 'main', date: '2026-08-06', status: 'refund', buyer: 'return of #1',
        items: [{ id: 1, name: 'Arak', qty: 1, price: '10' }] },
    ], [], [], 'main', AUG);
    const r = only(rep);
    expect(r.sold.toTrimmed()).toBe('3');
    expect(r.returned.toTrimmed()).toBe('1');
    expect(balances(r)).toBe(true);
  });

  test('a voided sale moves nothing — the goods went out and came straight back', () => {
    const r = only(stockReport([P({ stock: '12' })], [
      sale('2026-08-05', 3),
      sale('2026-08-06', 50, { voided_at: '2026-08-06T10:00:00Z' }),
    ], [], [], 'main', AUG));
    expect(r.sold.toTrimmed()).toBe('3');
    expect(r.opening.toTrimmed()).toBe('15');
  });

  test('an open-price quick item is not a stock movement', () => {
    // It has no product behind it, so there is nothing for it to be a movement OF.
    const rep = stockReport([P()], [{
      floor: 'main', date: '2026-08-05', status: 'paid',
      items: [{ id: 'misc-abc', name: 'Bag', qty: 1, price: '0.100' }],
    }], [], [], 'main', AUG);
    expect(only(rep).sold.toTrimmed()).toBe('0');
    expect(rep.orphans).toEqual([]);
  });

  test('a delivery and its stock-log row are not both counted', () => {
    // Receiving writes a batch AND a 'restock' log row. The report reads deliveries from
    // batches only; if a 'restock' row ever reached the adjustments bucket the shop would
    // appear to have received twice what it did.
    const r = only(stockReport([P()], [], [receipt('2026-08-03', '10')],
      [{ item_id: '1', kind: 'restock', date: '2026-08-03', old_qty: '5', new_qty: '15' }],
      'main', AUG));
    expect(r.received.toTrimmed()).toBe('10');
    expect(r.adjusted.toTrimmed()).toBe('0');
  });

  test('a sale reaching the adjustments bucket is ignored, not double-counted', () => {
    // Same rule, other direction. A report that counts a sale twice still BALANCES, which
    // makes it the hardest kind of wrong to notice.
    const r = only(stockReport([P()], [sale('2026-08-05', 3)], [],
      [{ item_id: '1', kind: 'sale', date: '2026-08-05', old_qty: '15', new_qty: '12' }],
      'main', AUG));
    expect(r.sold.toTrimmed()).toBe('3');
    expect(r.adjusted.toTrimmed()).toBe('0');
  });
});

describe('money', () => {
  test('revenue is net of line discounts, and profit is against unit cost', () => {
    const r = only(stockReport([P({ cost: '6' })], [{
      floor: 'main', date: '2026-08-05', status: 'paid',
      items: [{ id: 1, qty: 3, price: '10', disc: '1.500' }],
    }], [], [], 'main', AUG));
    expect(r.revenue.toFixed(3)).toBe('28.500');
    expect(r.discount.toFixed(3)).toBe('1.500');
    expect(r.cogs.toFixed(3)).toBe('18.000');
    expect(r.profit.toFixed(3)).toBe('10.500');
  });

  test('cost of goods sold is net of returns', () => {
    const r = only(stockReport([P({ cost: '6' })], [
      sale('2026-08-05', 3),
      { floor: 'main', date: '2026-08-06', status: 'refund',
        items: [{ id: 1, qty: 1, price: '10' }] },
    ], [], [], 'main', AUG));
    expect(r.cogs.toFixed(3)).toBe('12.000');    // 2 units, not 3
  });

  test('stock value uses the shelf count and closing value uses the closing balance', () => {
    const r = only(stockReport([P({ stock: '12', cost: '6' })],
      [sale('2026-09-20', 4)], [], [], 'main', AUG));
    expect(r.stockValue.toFixed(3)).toBe('72.000');    // 12 now
    expect(r.closingValue.toFixed(3)).toBe('96.000');  // 16 at the end of August
  });
});

describe('flags and totals', () => {
  test('low, out and no-movement are judged against the product own reorder point', () => {
    const rep = stockReport([
      P({ id: 1, name: 'Low One', stock: '4', low_at: '10' }),
      P({ id: 2, name: 'Out One', stock: '0' }),
      P({ id: 3, name: 'Fine One', stock: '40', low_at: '5' }),
    ], [{ floor: 'main', date: '2026-08-05', status: 'paid', items: [{ id: 3, qty: 1, price: '10' }] }],
    [], [], 'main', AUG);
    expect(rep.rows.map((r) => [r.low, r.out, r.dead])).toEqual([
      [true, false, true], [true, true, false], [false, false, false],
    ]);
    expect(rep.kpi).toMatchObject({ products: 3, lowCount: 1, outCount: 1 });
  });

  test('movement against a deleted product is surfaced, not silently dropped', () => {
    // A total that quietly omits stock which moved is a total that lies.
    const rep = stockReport([P({ id: 1 })], [{
      floor: 'main', date: '2026-08-05', status: 'paid',
      items: [{ id: 99, name: 'Deleted Bottle', qty: 2, price: '10' }],
    }], [], [], 'main', AUG);
    expect(rep.orphans).toHaveLength(1);
    expect(rep.orphans[0].id).toBe('99');
    expect(rep.orphans[0].sold.toTrimmed()).toBe('2');
  });

  test('totals are summed at full precision from the rows source', () => {
    const rep = stockReport([
      P({ id: 1, stock: '10', cost: '0.3335' }),
      P({ id: 2, stock: '10', cost: '0.3335' }),
      P({ id: 3, stock: '10', cost: '0.3335' }),
    ], [], [], [], 'main', AUG);
    // 3 × r3(3.335) would be 10.005; the total is r3(3 × 3.335) = 10.005 either way here,
    // but it is computed from the unrounded source, per §4.
    expect(rep.totals.stockValue.toFixed(3)).toBe('10.005');
    expect(rep.totals.stockNow.toTrimmed()).toBe('30');
  });

  test('a store other than the one asked for contributes nothing', () => {
    const rep = stockReport([P()], [
      sale('2026-08-05', 3),
      { ...sale('2026-08-05', 99), floor: 'gg' },
    ], [], [], 'main', AUG);
    expect(only(rep).sold.toTrimmed()).toBe('3');
  });
});
