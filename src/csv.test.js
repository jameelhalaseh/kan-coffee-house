import { parseCsv, mapHeader, parseProductCsv, importTemplateCsv, MAX_IMPORT_ROWS } from './csv';

// Convenience: build a CSV body under a standard header.
const withHeader = (...lines) => ['barcode,name,price,cost,stock,cat,size,low_at,active', ...lines].join('\r\n');

describe('parseCsv', () => {
  test('splits plain comma-delimited rows', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  test('handles CRLF and a trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  test('strips the UTF-8 BOM Excel writes', () => {
    expect(parseCsv('﻿name,price\nArak,12')).toEqual([['name', 'price'], ['Arak', '12']]);
  });

  test('keeps commas inside quoted fields', () => {
    expect(parseCsv('name,cat\n"Whiskey, 700ml",Spirits')).toEqual([
      ['name', 'cat'], ['Whiskey, 700ml', 'Spirits'],
    ]);
  });

  test('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsv('name\n"12"" bottle"')).toEqual([['name'], ['12" bottle']]);
  });

  test('preserves newlines inside quoted fields', () => {
    expect(parseCsv('name\n"line one\nline two"')).toEqual([['name'], ['line one\nline two']]);
  });

  test('drops blank lines', () => {
    expect(parseCsv('a\n\n\nb')).toEqual([['a'], ['b']]);
  });

  test('returns nothing for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv(null)).toEqual([]);
  });
});

describe('mapHeader', () => {
  test('maps canonical column names', () => {
    const { columns, error } = mapHeader(['barcode', 'name', 'price']);
    expect(error).toBeNull();
    expect(columns).toMatchObject({ barcode: 0, name: 1, price: 2 });
  });

  test('accepts real-world aliases, case and spacing insensitively', () => {
    const { columns, error } = mapHeader(['SKU', 'Product Name', 'Selling Price', 'Qty', 'Department']);
    expect(error).toBeNull();
    expect(columns).toEqual({ barcode: 0, name: 1, price: 2, stock: 3, cat: 4 });
  });

  test('rejects a file with no name column', () => {
    expect(mapHeader(['barcode', 'price']).error).toBe('missing_column:name');
  });

  test('first occurrence wins so a duplicate column cannot shadow the original', () => {
    expect(mapHeader(['name', 'price', 'Price']).columns.price).toBe(1);
  });

  test('ignores unrecognised columns instead of failing', () => {
    const { columns, error } = mapHeader(['name', 'shelf_location']);
    expect(error).toBeNull();
    expect(columns).toEqual({ name: 0 });
  });
});

describe('parseProductCsv — valid rows', () => {
  test('maps a full row to an import item', () => {
    const { items, errors, error } = parseProductCsv(withHeader('629123,Arak,12.500,8.000,20,Arak,750ml,4,yes'));
    expect(error).toBeNull();
    expect(errors).toEqual([]);
    expect(items).toEqual([{
      line: 2, barcode: '629123', name: 'Arak',
      price: 12.5, cost: 8, stock: 20, cat: 'Arak', unit: 'ea',
      size: '750ml', low_at: 4, active: true,
    }]);
  });

  test('defaults blank numbers to 0, blank active to true, blank size to null', () => {
    const { items } = parseProductCsv(withHeader(',Loose Item,,,,,,,'));
    expect(items[0]).toMatchObject({
      barcode: null, name: 'Loose Item', price: 0, cost: 0, stock: 0, cat: null,
      unit: 'ea', size: null, active: true,
    });
  });

  // A blank reorder point must not become 0. A product that only warns once it is already
  // gone reads as covered on every screen that shows the alert.
  test('a blank low_at falls back to 5, never to 0', () => {
    const { items } = parseProductCsv(withHeader(',Loose Item,,,,,,,'));
    expect(items[0].low_at).toBe(5);
  });

  test('accepts a reorder point of 0 when it is written down explicitly', () => {
    const { items, errors } = parseProductCsv(withHeader(',Clearance,1,1,1,Wine,,0,yes'));
    expect(errors).toEqual([]);
    expect(items[0].low_at).toBe(0);
  });

  test('rejects a negative or non-numeric reorder point', () => {
    expect(parseProductCsv(withHeader(',A,1,1,1,Wine,,-3,yes')).errors[0].message).toMatch(/low_at/);
    expect(parseProductCsv(withHeader(',B,1,1,1,Wine,,soon,yes')).errors[0].message).toMatch(/low_at/);
  });

  // Size is a label, not a measurement: whatever is on the shelf edge is valid.
  test('takes any size text, including one no preset covers', () => {
    const { items, errors } = parseProductCsv(withHeader(',Handle,1,1,1,Whiskey,1.75L,,yes'));
    expect(errors).toEqual([]);
    expect(items[0].size).toBe('1.75L');
  });

  test('accepts volume as a header alias for size, and reorder for low_at', () => {
    const { items, errors } = parseProductCsv(
      'name,volume,reorder\r\nBeer,330ml,24'
    );
    expect(errors).toEqual([]);
    expect(items[0]).toMatchObject({ size: '330ml', low_at: 24 });
  });

  test('strips currency symbols and thousands separators from money cells', () => {
    const { items, errors } = parseProductCsv(withHeader('629124,Bulk Case,"JOD 1,250.500",900,3,Wine,,,yes'));
    expect(errors).toEqual([]);
    expect(items[0].price).toBe(1250.5);
  });

  test('reads kg units and falsy active flags', () => {
    // `unit` is no longer a template column — the shop sells bottles, not weight — but the
    // parser still understands it, so an old export from this app re-imports unchanged.
    const { items } = parseProductCsv(
      'barcode,name,price,cost,stock,cat,unit,active\r\n629125,Olives,3.000,2.000,5,Deli,KG,no'
    );
    expect(items[0]).toMatchObject({ unit: 'kg', active: false });
  });

  test('numbers the lines against the file so the user can find the cell', () => {
    const { items } = parseProductCsv(withHeader('1,A,1,1,1,C,,,yes', '2,B,1,1,1,C,,,yes'));
    expect(items.map((i) => i.line)).toEqual([2, 3]);
  });
});

describe('parseProductCsv — rejected rows', () => {
  test('rejects a row with no name', () => {
    const { items, errors } = parseProductCsv(withHeader('629126,,5,3,1,Wine,,,yes'));
    expect(items).toEqual([]);
    expect(errors[0]).toMatchObject({ line: 2 });
    expect(errors[0].message).toMatch(/name is required/);
  });

  test('rejects an unparseable price rather than silently pricing it at zero', () => {
    const { items, errors } = parseProductCsv(withHeader('629127,Mystery,ask staff,3,1,Wine,,,yes'));
    expect(items).toEqual([]);
    expect(errors[0].message).toMatch(/price .* is not a valid number/);
  });

  test('rejects negative numbers', () => {
    const { errors } = parseProductCsv(withHeader('629128,Backwards,-5,3,1,Wine,,,yes'));
    expect(errors[0].message).toMatch(/price/);
  });

  test('rejects a barcode with illegal characters', () => {
    const { errors } = parseProductCsv(withHeader('62 91;29,Bad Code,5,3,1,Wine,,,yes'));
    expect(errors[0].message).toMatch(/not a valid code/);
  });

  test('catches a barcode duplicated within the same file and names the first line', () => {
    const { items, errors } = parseProductCsv(withHeader(
      '629130,First,5,3,1,Wine,,,yes',
      '629130,Second,6,3,1,Wine,,,yes',
    ));
    expect(items).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 3 });
    expect(errors[0].message).toMatch(/duplicates line 2/);
  });

  test('rejects an unknown unit', () => {
    const { errors } = parseProductCsv('barcode,name,price,cost,stock,cat,unit,active\r\n629131,Weird,5,3,1,Wine,litre,yes');
    expect(errors[0].message).toMatch(/must be ea or kg/);
  });

  test('rejects an unparseable active flag', () => {
    const { errors } = parseProductCsv(withHeader('629132,Maybe,5,3,1,Wine,,,perhaps'));
    expect(errors[0].message).toMatch(/must be yes or no/);
  });

  test('reports every problem on a row in one message', () => {
    const { errors } = parseProductCsv('barcode,name,price,cost,stock,cat,unit,active\r\n,,bad,3,1,Wine,litre,yes');
    expect(errors[0].message).toMatch(/name is required/);
    expect(errors[0].message).toMatch(/price/);
    expect(errors[0].message).toMatch(/unit/);
  });

  test('still returns the good rows when some rows are bad', () => {
    const { items, errors } = parseProductCsv(withHeader(
      '629133,Good One,5,3,1,Wine,,,yes',
      ',,,,,,,,',                                    // blank-but-present row → no name
      '629134,Good Two,6,3,1,Wine,,,yes',
    ));
    // The all-blank line is dropped by the parser as empty, so only the two goods remain.
    expect(items.map((i) => i.name)).toEqual(['Good One', 'Good Two']);
    expect(errors).toEqual([]);
  });
});

describe('parseProductCsv — file-level failures', () => {
  test('flags an empty file', () => {
    expect(parseProductCsv('').error).toBe('empty_file');
  });

  test('flags a missing required column', () => {
    expect(parseProductCsv('barcode,price\n629135,5').error).toBe('missing_column:name');
  });

  test('flags a header-only file as importable but empty', () => {
    const { items, errors, error } = parseProductCsv('name,price');
    expect(error).toBeNull();
    expect(items).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('refuses a file over the row cap', () => {
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `,Item ${i},1,1,1,Wine,,,yes`);
    expect(parseProductCsv(withHeader(...body)).error).toBe(`too_many_rows:${MAX_IMPORT_ROWS + 1}`);
  });
});

describe('importTemplateCsv', () => {
  test('round-trips through the parser as one valid row', () => {
    const { items, errors, error } = parseProductCsv(importTemplateCsv());
    expect(error).toBeNull();
    expect(errors).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'Example Whiskey', size: '700ml', low_at: 6 });
  });

  test('starts with a BOM so Arabic opens correctly in Excel', () => {
    expect(importTemplateCsv().charCodeAt(0)).toBe(0xfeff);
  });
});
