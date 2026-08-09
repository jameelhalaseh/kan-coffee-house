// Pure helpers shared across the app — no React, no DOM (testable in plain Jest).
import { CURRENCY } from './client.config';

// 3-decimal money (JOD fils precision).
export const money = (n) => `${(Number(n) || 0).toFixed(3)} ${CURRENCY}`;

// Client-side unique id for orders / misc cart lines.
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const nowParts = () => {
  const d = new Date();
  return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 8) };
};

// Likely notes a customer hands over for `total` — next round 0.5/1/5/10/20/50 up, deduped.
export const cashSuggestions = (total) => {
  if (!(total > 0)) return [1, 5, 10, 20, 50];
  const ups = [0.5, 1, 5, 10, 20, 50].map((step) => Math.ceil(total / step) * step);
  return Array.from(new Set(ups.map((v) => Number(v.toFixed(2))))).filter((v) => v >= total).slice(0, 5);
};

// Deterministic accent hue per category — stable color identity for tiles/chips.
export const catHue = (cat) => {
  let h = 0;
  const s = String(cat || 'misc');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
};
export const catColor = (cat, a = 1) => `hsla(${catHue(cat)}, 62%, 58%, ${a})`;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Remaining returnable qty for a sale line, given the already-returned map
// (keyed by String(line.id), falling back to name for misc lines).
export const returnKey = (l) => (l.id != null ? String(l.id) : l.name);
export const remainingQty = (line, returnedMap) =>
  Math.max(0, (Number(line.qty) || 0) - ((returnedMap || {})[returnKey(line)] || 0));

// Sum already-returned quantities per line for one sale, from the full orders list.
export const returnedMapFor = (sale, orders) => {
  const map = {};
  (orders || [])
    .filter((o) => o.status === 'refund' && o.buyer === 'return of #' + sale.invoice_no)
    .forEach((o) => (o.items || []).forEach((l) => {
      map[returnKey(l)] = (map[returnKey(l)] || 0) + (Number(l.qty) || 0);
    }));
  return map;
};
