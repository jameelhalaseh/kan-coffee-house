// Thermal receipt rendering. Writes the document into a hidden iframe and calls print(),
// so it works with any OS-installed printer without a driver of our own.
import { STORE_NAME, ARABIC, BILL, SELLER, TAX_RATE } from './client.config';
import { escapeHtml } from './lib';

function printReceipt(sale) {
  // One line per item: NAME on the left, what it cost on the right. The quantity and unit
  // price go underneath, and only when the quantity isn't 1.
  //
  // This used to be four columns — Item | Qty | Price | Total — on a 280px thermal roll.
  // Price and Total held the SAME number on every single-unit line, which is most of them,
  // so a quarter of the paper's width was spent restating the column beside it while long
  // product names were squeezed into what was left. The customer checks the name and the
  // amount; the arithmetic only earns its space when there is arithmetic to show.
  const lines = (sale.items || []).map((li) => {
    const qty = Number(li.qty) || 0;
    const price = Number(li.price) || 0;
    const detail = qty !== 1 ? `<div class="qty">${qty} × ${price.toFixed(3)}</div>` : '';
    return `<tr><td>${escapeHtml(li.name)}${detail}</td>
      <td class="amt">${(price * qty).toFixed(3)}</td></tr>`;
  }).join('');
  const thanks = ARABIC ? (BILL.footerThanksAr || BILL.footerThanks) : BILL.footerThanks;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{font-family:'Courier New',monospace;color:#000} body{width:280px;margin:0 auto;padding:8px}
    h2{text-align:center;margin:4px 0;font-size:18px} .muted{text-align:center;font-size:11px;color:#333}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
    td,th{padding:2px 0;vertical-align:top} thead th{border-bottom:1px dashed #000;text-align:left}
    /* Amounts in a column: right-aligned, never wrapped, and given only the width they
       need so the item name keeps the rest of the 280px. */
    .amt{text-align:right;white-space:nowrap;width:1%;padding-left:8px}
    .qty{font-size:11px;color:#333;padding-left:8px}
    .tot{border-top:1px dashed #000;font-weight:bold;font-size:14px}
    .ftr{text-align:center;margin-top:10px;font-size:12px}</style></head><body>
    <h2>${escapeHtml(SELLER.name || STORE_NAME)}</h2>
    ${SELLER.location ? `<div class="muted">${escapeHtml(SELLER.location)}</div>` : ''}
    ${SELLER.taxNo ? `<div class="muted">Tax No: ${escapeHtml(SELLER.taxNo)}</div>` : ''}
    <div class="muted">Invoice ${BILL.invoicePrefix || ''}${sale.invoice_no ?? ''} — ${sale.date} ${sale.time}</div>
    <table><thead><tr><th>Item</th><th class="amt">Total</th></tr></thead>
      <tbody>${lines}</tbody>
      <tfoot>${Number(sale.tax) > 0 ? `
        <tr><td>Subtotal</td>
          <td class="amt">${(Number(sale.sub) || 0).toFixed(3)}</td></tr>
        <tr><td>VAT ${Math.round(TAX_RATE * 100)}% (included)</td>
          <td class="amt">${(Number(sale.tax) || 0).toFixed(3)}</td></tr>` : ''}
        <tr class="tot"><td>TOTAL</td>
        <td class="amt">${(Number(sale.total) || 0).toFixed(3)}</td></tr>
        <tr><td colspan="2" style="font-size:11px;padding-top:4px">Paid: ${escapeHtml(sale.pay || '')}</td></tr>
      </tfoot></table>
    <div class="ftr">${escapeHtml(thanks || '')}</div></body></html>`;
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  const doc = frame.contentWindow.document;
  doc.open(); doc.write(html); doc.close();
  frame.contentWindow.focus();
  setTimeout(() => {
    frame.contentWindow.print();
    setTimeout(() => document.body.removeChild(frame), 1000);
  }, 250);
}
// ── Audio feedback (WebAudio, no assets) ─────────────────────────────────────────
// Success: one short high beep (scan accepted). Error: two low buzzes (unknown barcode).

export default printReceipt;
export { printReceipt };
