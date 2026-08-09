// Thermal receipt rendering. Writes the document into a hidden iframe and calls print(),
// so it works with any OS-installed printer without a driver of our own.
import { STORE_NAME, ARABIC, BILL, SELLER, TAX_RATE } from './client.config';
import { escapeHtml } from './lib';

function printReceipt(sale) {
  const lines = (sale.items || []).map(
    (li) => `<tr><td>${escapeHtml(li.name)}</td><td style="text-align:center">${li.qty}</td>
      <td style="text-align:right">${(Number(li.price) || 0).toFixed(3)}</td>
      <td style="text-align:right">${((Number(li.price) || 0) * li.qty).toFixed(3)}</td></tr>`
  ).join('');
  const thanks = ARABIC ? (BILL.footerThanksAr || BILL.footerThanks) : BILL.footerThanks;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    *{font-family:'Courier New',monospace;color:#000} body{width:280px;margin:0 auto;padding:8px}
    h2{text-align:center;margin:4px 0;font-size:18px} .muted{text-align:center;font-size:11px;color:#333}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
    td,th{padding:2px 0} thead th{border-bottom:1px dashed #000;text-align:left}
    .tot{border-top:1px dashed #000;font-weight:bold;font-size:14px}
    .ftr{text-align:center;margin-top:10px;font-size:12px}</style></head><body>
    <h2>${escapeHtml(SELLER.name || STORE_NAME)}</h2>
    ${SELLER.location ? `<div class="muted">${escapeHtml(SELLER.location)}</div>` : ''}
    ${SELLER.taxNo ? `<div class="muted">Tax No: ${escapeHtml(SELLER.taxNo)}</div>` : ''}
    <div class="muted">Invoice ${BILL.invoicePrefix || ''}${sale.invoice_no ?? ''} — ${sale.date} ${sale.time}</div>
    <table><thead><tr><th>Item</th><th style="text-align:center">Qty</th>
      <th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${lines}</tbody>
      <tfoot>${Number(sale.tax) > 0 ? `
        <tr><td colspan="3">Subtotal</td>
          <td style="text-align:right">${(Number(sale.sub) || 0).toFixed(3)}</td></tr>
        <tr><td colspan="3">VAT ${Math.round(TAX_RATE * 100)}% (included)</td>
          <td style="text-align:right">${(Number(sale.tax) || 0).toFixed(3)}</td></tr>` : ''}
        <tr class="tot"><td colspan="3">TOTAL</td>
        <td style="text-align:right">${(Number(sale.total) || 0).toFixed(3)}</td></tr>
        <tr><td colspan="4" style="font-size:11px;padding-top:4px">Paid: ${escapeHtml(sale.pay || '')}</td></tr>
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
