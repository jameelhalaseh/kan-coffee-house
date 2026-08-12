// Minimal .xlsx writer — a real OOXML workbook in a real ZIP, with no dependency.
//
// The spec calls for an Excel workbook with one sheet per report. Pulling in SheetJS or
// ExcelJS for that would add a large third-party surface to a build whose CSP and dependency
// list are deliberately tight, to emit what is a few hundred lines of XML. Everything here
// is the documented minimum Excel will open: content types, one relationship chain, and a
// sheet per report.
//
// Cells are written as inline strings or as numbers. There is no shared string table and no
// styling — a report is read, filtered and re-totalled by an accountant, not admired.
const zlib = require('zlib');

// ── ZIP container ─────────────────────────────────────────────────────────────
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Build a ZIP archive from [{ name, data }]. Deflated, no data descriptors, no zip64 — a
// workbook of a month of receipts is comfortably inside every one of those limits.
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(8, 8);               // method: deflate
    local.writeUInt16LE(0, 10);              // time  — fixed, so exports are byte-reproducible
    local.writeUInt16LE(0x21, 12);           // date  — 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);            // offset of this entry's local header
    central.push(Buffer.concat([cd, name]));

    offset += local.length + name.length + deflated.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, cdBuf, end]);
}

// ── OOXML ─────────────────────────────────────────────────────────────────────
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // Control characters are not legal in XML and would make Excel refuse the whole file.
  // A note field typed on a touchscreen keyboard has produced them before.
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

// A1, B1 ... Z1, AA1 ...
function ref(col, row) {
  let s = '';
  let n = col + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s + (row + 1);
}

// A cell is a string, a number, null, or { v, t:'n'|'s' }. Numbers are written as NUMERIC
// cells so the accountant can re-total the column in Excel — a money figure exported as text
// is the single most common complaint about POS exports.
function cellXml(value, col, row) {
  if (value === null || value === undefined || value === '') return '';
  const isObj = typeof value === 'object' && value !== null && 'v' in value;
  const v = isObj ? value.v : value;
  const numeric = isObj ? value.t === 'n' : typeof v === 'number';
  const at = ref(col, row);
  if (numeric) {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return `<c r="${at}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    return `<c r="${at}"><v>${n}</v></c>`;
  }
  return `<c r="${at}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

const sheetXml = (rows) =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
  (rows || []).map((cells, r) =>
    `<row r="${r + 1}">${(cells || []).map((c, i) => cellXml(c, i, r)).join('')}</row>`).join('') +
  '</sheetData></worksheet>';

// Excel rejects a sheet name over 31 chars or containing : \ / ? * [ ], and rejects a
// workbook with two sheets of the same name. Report names are short, but the store name is
// user-editable, so this is enforced rather than assumed.
function safeSheetName(name, taken) {
  let base = String(name || 'Sheet').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  let n = 2;
  while (taken.has(out)) { const suffix = ` (${n++})`; out = base.slice(0, 31 - suffix.length) + suffix; }
  taken.add(out);
  return out;
}

/** Build an .xlsx Buffer from [{ name, rows }]. */
function writeWorkbook(sheets) {
  const taken = new Set();
  const named = (sheets || []).map((s) => ({ name: safeSheetName(s.name, taken), rows: s.rows }));
  if (!named.length) named.push({ name: 'Sheet1', rows: [] });

  const files = [
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        named.map((_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'xl/workbook.xml',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        named.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named.map((_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        '</Relationships>',
    },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];

  return zip(files);
}

module.exports = { writeWorkbook, zip, crc32, ref, safeSheetName };
