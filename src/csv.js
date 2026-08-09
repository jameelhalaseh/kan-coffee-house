// CSV catalogue import — pure parsing + row mapping. No React, no DOM, no network,
// so the whole validation surface is testable in plain Jest.
//
// The client parses and validates; the server re-validates and does the upsert. Parsing
// here (rather than uploading the raw file) keeps the endpoint a plain JSON route — no
// multipart dependency — and lets the cashier see exactly which lines are wrong BEFORE
// anything touches the catalogue.

// Every product column the importer understands, mapped from the header aliases a real
// spreadsheet is likely to use. Header matching is case/space/underscore-insensitive.
const HEADER_ALIASES = {
  barcode: 'barcode', code: 'barcode', sku: 'barcode', upc: 'barcode', ean: 'barcode',
  name: 'name', product: 'name', productname: 'name', item: 'name', description: 'name',
  price: 'price', sellprice: 'price', sellingprice: 'price', retail: 'price', retailprice: 'price',
  cost: 'cost', costprice: 'cost', buyprice: 'cost', purchaseprice: 'cost',
  stock: 'stock', qty: 'stock', quantity: 'stock', onhand: 'stock', count: 'stock',
  cat: 'cat', category: 'cat', dept: 'cat', department: 'cat', type: 'cat',
  unit: 'unit', uom: 'unit',
  active: 'active', enabled: 'active',
};

const REQUIRED_COLUMNS = ['name'];
export const IMPORT_COLUMNS = ['barcode', 'name', 'price', 'cost', 'stock', 'cat', 'unit', 'active'];

// Cap the import so a mis-picked 200k-row export cannot wedge the server in one request.
export const MAX_IMPORT_ROWS = 5000;

const normalizeHeader = (h) => String(h || '').replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_-]/g, '');

// ── Parser ────────────────────────────────────────────────────────────────────
// RFC 4180: comma-delimited, double-quoted fields, "" as an escaped quote inside a
// quoted field, CRLF or LF line endings. A UTF-8 BOM (what Excel writes, and what this
// app's own export writes) is stripped. Returns an array of string arrays; blank lines
// are dropped.
export function parseCsv(text) {
  const src = String(text == null ? '' : text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === ',') { endField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  endRow();
  return rows;
}

// ── Value coercion ────────────────────────────────────────────────────────────
// Spreadsheets emit money as "1,250.500", "JOD 12.5", "12.500 " and blanks. Anything that
// is not a finite non-negative number after cleaning is rejected rather than silently
// coerced to 0 — a bottle priced at 0 by a bad cell is a shrinkage hole.
function parseNumber(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return { ok: true, value: null };
  const cleaned = s.replace(/[^\d.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return { ok: false };
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: n };
}

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 't', 'active', 'نعم']);
const FALSY = new Set(['0', 'false', 'no', 'n', 'f', 'inactive', 'لا']);

function parseBool(raw, fallback) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === '') return { ok: true, value: fallback };
  if (TRUTHY.has(s)) return { ok: true, value: true };
  if (FALSY.has(s)) return { ok: true, value: false };
  return { ok: false };
}

// ── Header mapping ────────────────────────────────────────────────────────────
// Returns { columns, error }. `columns` maps a known field name → its column index.
export function mapHeader(headerRow) {
  const columns = {};
  (headerRow || []).forEach((h, idx) => {
    const field = HEADER_ALIASES[normalizeHeader(h)];
    // First occurrence wins, so a duplicate "Price" column cannot silently shadow the first.
    if (field && !(field in columns)) columns[field] = idx;
  });
  const missing = REQUIRED_COLUMNS.filter((f) => !(f in columns));
  if (missing.length) return { columns, error: `missing_column:${missing.join(',')}` };
  return { columns, error: null };
}

// ── Full file → import payload ────────────────────────────────────────────────
// Returns { items, errors, error }:
//   error  — the file itself is unusable (empty, no header, too many rows). Nothing importable.
//   errors — per-row problems: [{ line, message }]. Line numbers are 1-based FILE lines
//            (header = line 1) so the user can find the cell in Excel.
//   items  — the rows that passed, ready to POST to /api/products/import.
// A file with some bad rows still yields the good ones; the UI shows both and lets the
// user decide whether to import the valid subset.
export function parseProductCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { items: [], errors: [], error: 'empty_file' };

  const { columns, error: headerError } = mapHeader(rows[0]);
  if (headerError) return { items: [], errors: [], error: headerError };

  const body = rows.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { items: [], errors: [], error: `too_many_rows:${body.length}` };

  const items = [];
  const errors = [];
  const seenBarcodes = new Map();   // barcode → file line, to catch in-file duplicates

  body.forEach((cells, idx) => {
    const line = idx + 2;           // +1 for the header, +1 for 1-based numbering
    const cell = (field) => (field in columns ? cells[columns[field]] : undefined);
    const rowErrors = [];

    const name = String(cell('name') || '').trim();
    if (!name) rowErrors.push('name is required');

    const barcodeRaw = String(cell('barcode') || '').trim();
    const barcode = barcodeRaw === '' ? null : barcodeRaw;
    if (barcode) {
      if (!/^[\w.-]{1,64}$/.test(barcode)) rowErrors.push(`barcode "${barcode}" is not a valid code`);
      else if (seenBarcodes.has(barcode)) rowErrors.push(`barcode ${barcode} duplicates line ${seenBarcodes.get(barcode)}`);
    }

    const numbers = {};
    for (const field of ['price', 'cost', 'stock']) {
      const parsed = parseNumber(cell(field));
      if (!parsed.ok) rowErrors.push(`${field} "${String(cell(field)).trim()}" is not a valid number`);
      else numbers[field] = parsed.value == null ? 0 : parsed.value;
    }

    const unitRaw = String(cell('unit') || '').trim().toLowerCase();
    if (unitRaw && unitRaw !== 'ea' && unitRaw !== 'kg') rowErrors.push(`unit "${unitRaw}" must be ea or kg`);

    const activeParsed = parseBool(cell('active'), true);
    if (!activeParsed.ok) rowErrors.push(`active "${String(cell('active')).trim()}" must be yes or no`);

    if (rowErrors.length) { errors.push({ line, message: rowErrors.join('; ') }); return; }

    if (barcode) seenBarcodes.set(barcode, line);
    items.push({
      line,
      barcode,
      name,
      price: numbers.price,
      cost: numbers.cost,
      stock: numbers.stock,
      cat: String(cell('cat') || '').trim() || null,
      unit: unitRaw === 'kg' ? 'kg' : 'ea',
      active: activeParsed.value,
    });
  });

  return { items, errors, error: null };
}

// A blank template the user can download, fill in Excel, and re-upload.
export function importTemplateCsv() {
  return '﻿' + [
    IMPORT_COLUMNS.join(','),
    '6291234567890,Example Whiskey 700ml,24.500,17.000,12,Whiskey,ea,yes',
  ].join('\r\n') + '\r\n';
}
