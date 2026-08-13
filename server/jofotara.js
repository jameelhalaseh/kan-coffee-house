// JoFotara (فوترة) — Jordan's national e-invoicing system, run by the ISTD.
//
// Flow: build a UBL 2.1 Invoice XML for the sale → base64 it → POST as JSON to the ISTD
// endpoint with the taxpayer's Client-Id / Secret-Key → store the returned UUID + QR on
// the order so the receipt can print it.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ THE XML PROFILE BELOW IS UNVERIFIED.
// JoFotara has NO sandbox — the only way to validate a payload is to submit a real invoice
// with live credentials. This builder follows the publicly documented shape of the JoFotara
// UBL profile, but it MUST be checked against the ISTD technical manual (istd.gov.jo) and
// proven with one live past-dated test invoice before any client relies on it. Treat a
// rejection message from ISTD as the source of truth, not this file.
// ─────────────────────────────────────────────────────────────────────────────
//
// Config is all env — nothing client-specific is committed:
//   JOFOTARA_CLIENT_ID        from the ISTD portal
//   JOFOTARA_SECRET_KEY       from the ISTD portal
//   JOFOTARA_ACTIVITY_NUMBER  "income source sequence" tied to the registered activity
//   JOFOTARA_SELLER_TIN       the taxpayer's TIN, must match ISTD registration
//   JOFOTARA_SELLER_NAME      registered name, must match ISTD registration
//   JOFOTARA_TAXPAYER_TYPE    unregistered | standard | special   (default: unregistered)
//   JOFOTARA_BASE_URL         override for the submission endpoint

const crypto = require('crypto');

const CFG = () => ({
  clientId: (process.env.JOFOTARA_CLIENT_ID || '').trim(),
  secretKey: (process.env.JOFOTARA_SECRET_KEY || '').trim(),
  activityNumber: (process.env.JOFOTARA_ACTIVITY_NUMBER || '').trim(),
  sellerTin: (process.env.JOFOTARA_SELLER_TIN || '').trim(),
  sellerName: (process.env.JOFOTARA_SELLER_NAME || '').trim(),
  taxpayerType: (process.env.JOFOTARA_TAXPAYER_TYPE || 'unregistered').trim().toLowerCase(),
  url: (process.env.JOFOTARA_BASE_URL || 'https://backend.jofotara.gov.jo/core/invoices/').trim(),
});

// Configured = we have everything needed to even attempt a submission. The UI greys the
// button out on false rather than letting a cashier fire doomed requests at the authority.
function isConfigured() {
  const c = CFG();
  return !!(c.clientId && c.secretKey && c.activityNumber && c.sellerTin && c.sellerName);
}

// Invoice type code. Two digits for the payment terms + one for the tax registration:
//   01 = cash, 02 = receivable   |   1 = income, 2 = general sales, 3 = special sales
// e.g. a cash sale by a standard-sales-registered taxpayer = "012".
// ⚠ Verify this mapping against the ISTD manual before go-live.
//
// ⚠ CliQ IS FILED AS RECEIVABLE ('02'), THE SAME AS A CARD. That is this code keeping its
// existing rule — anything that is not physical cash is '02' — and NOT a judgement that it
// is the correct treatment. A CliQ transfer settles instantly, so a case can be made for
// '01'; making that call is the seller's, with their accountant, against the ISTD manual.
// It is written out here rather than left to fall through the `else` so the decision is
// visible to whoever checks, instead of being an accident of how the ternary was worded.
function invoiceTypeCode(order, taxpayerType) {
  const terms = String(order.pay || '').toLowerCase() === 'cash' ? '01' : '02';
  const reg = taxpayerType === 'standard' ? '2' : taxpayerType === 'special' ? '3' : '1';
  return terms + reg;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ISTD expects far more precision than JOD's 3 decimals; 9 keeps rounding noise out of
// their totals check. Values are emitted as plain decimal strings, never exponent notation.
const num = (v, dp = 9) => (Number(v) || 0).toFixed(dp);

// Build the UBL 2.1 Invoice document for one sale.
// A refund (negative total) is submitted as a credit note (type 381) referencing the
// original invoice number — ISTD does not accept negative quantities or prices.
function buildInvoiceXml(order, cfg) {
  const items = Array.isArray(order.items) ? order.items : [];
  const isCredit = Number(order.total) < 0 || order.status === 'refund';
  const uuid = order.jofotara_uuid || crypto.randomUUID();

  // Line amounts. For a credit note every figure is submitted positive; the document type
  // carries the sign.
  const lines = items.map((li, i) => {
    const qty = Math.abs(Number(li.qty) || 0);
    const price = Math.abs(Number(li.price) || 0);
    const lineTotal = qty * price;
    return { i: i + 1, name: li.name || 'Item', qty, price, lineTotal };
  });

  const netTotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const taxTotal = Math.abs(Number(order.tax) || 0);
  const grand = netTotal + taxTotal;

  // Tax subtotals are only expected from registered taxpayers. An unregistered taxpayer
  // submits net figures with no tax block at all.
  const registered = cfg.taxpayerType === 'standard' || cfg.taxpayerType === 'special';
  const taxPct = registered && netTotal > 0 ? (taxTotal / netTotal) * 100 : 0;

  const taxBlock = registered ? `
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="JO">${num(taxTotal, 3)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="JO">${num(netTotal, 3)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="JO">${num(taxTotal, 3)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID schemeID="UN/ECE 5305" schemeAgencyID="6">${taxTotal > 0 ? 'S' : 'Z'}</cbc:ID>
        <cbc:Percent>${num(taxPct, 2)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>` : '';

  const lineXml = lines.map((l) => `
  <cac:InvoiceLine>
    <cbc:ID>${l.i}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${num(l.qty, 3)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="JO">${num(l.lineTotal, 3)}</cbc:LineExtensionAmount>
    <cac:Item><cbc:Name>${esc(l.name)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="JO">${num(l.price, 3)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('');

  // Credit notes must point back at the invoice they reverse. Our refunds carry
  // buyer = 'return of #<invoice_no>'.
  const originalNo = isCredit ? (/^return of #(\d+)$/.exec(String(order.buyer || '')) || [])[1] : null;
  const billingRef = originalNo ? `
  <cac:BillingReference>
    <cac:InvoiceDocumentReference><cbc:ID>${esc(originalNo)}</cbc:ID></cac:InvoiceDocumentReference>
  </cac:BillingReference>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(order.invoice_no)}</cbc:ID>
  <cbc:UUID>${esc(uuid)}</cbc:UUID>
  <cbc:IssueDate>${esc(order.date)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode name="${invoiceTypeCode(order, cfg.taxpayerType)}">${isCredit ? '381' : '388'}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>JO</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>JO</cbc:TaxCurrencyCode>${billingRef}
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${esc(order.invoice_no)}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${esc(cfg.sellerTin)}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(cfg.sellerName)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PostalAddress><cac:Country><cbc:IdentificationCode>JO</cbc:IdentificationCode></cac:Country></cac:PostalAddress>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(order.buyer || 'Cash customer')}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:SellerSupplierParty>
    <cac:Party><cac:PartyIdentification><cbc:ID>${esc(cfg.activityNumber)}</cbc:ID></cac:PartyIdentification></cac:Party>
  </cac:SellerSupplierParty>${taxBlock}
  <cac:LegalMonetaryTotal>
    <cbc:TaxExclusiveAmount currencyID="JO">${num(netTotal, 3)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="JO">${num(grand, 3)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="JO">${num(grand, 3)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineXml}
</Invoice>`;
}

// Submit one order. Returns { ok, uuid, qr } or { ok:false, error }.
// Never throws on an ISTD rejection — the caller records the message against the sale so
// the accountant can see exactly what the authority objected to.
async function submitInvoice(order) {
  const cfg = CFG();
  if (!isConfigured()) return { ok: false, error: 'not_configured' };

  const uuid = order.jofotara_uuid || crypto.randomUUID();
  const xml = buildInvoiceXml({ ...order, jofotara_uuid: uuid }, cfg);

  let res;
  let body;
  try {
    res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': cfg.clientId,
        'Secret-Key': cfg.secretKey,
      },
      body: JSON.stringify({ invoice: Buffer.from(xml, 'utf8').toString('base64') }),
    });
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  } catch (e) {
    // Network/DNS/TLS failure — the invoice was never seen by ISTD, so a retry is safe.
    return { ok: false, uuid, error: 'network: ' + e.message };
  }

  if (!res.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: false, uuid, error: `HTTP ${res.status}: ${String(detail).slice(0, 500)}` };
  }

  // Response shape varies by ISTD release; accept the documented spellings.
  const qr = (body && (body.EINV_QR || body.qrCode || body.qr_code || body.qr)) || null;
  const returnedUuid = (body && (body.EINV_INV_UUID || body.uuid)) || uuid;
  return { ok: true, uuid: returnedUuid, qr, raw: body };
}

module.exports = { isConfigured, submitInvoice, buildInvoiceXml, invoiceTypeCode, CFG };
