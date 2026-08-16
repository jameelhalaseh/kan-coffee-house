// Pure helpers shared across the app — no React, no DOM (testable in plain Jest).
import { CURRENCY, STORE_TZ } from './client.config';

// 3-decimal money (JOD fils precision).
export const money = (n) => `${(Number(n) || 0).toFixed(3)} ${CURRENCY}`;
// Bare amount, no currency suffix. For columns of figures (cart lines, the bill breakdown)
// where the unit is stated once at the total and repeating it on every row is noise.
export const amount = (n) => (Number(n) || 0).toFixed(3);

// Round to fils before storing. Extracting VAT from a total produces values like
// 9.93103448…; persisting that puts binary-float noise into the tax column and makes a
// month of returns fail to add up against the filed figure by a few fils.
export const r3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

// Split a VAT-INCLUSIVE total into { net, tax }. Shelf prices in Jordan include VAT, so the
// customer pays the marked price and the tax is carved out of it — never added on top.
export const splitInclusiveTax = (total, rate) => {
  const t = Number(total) || 0;
  const r = Number(rate) || 0;
  if (r <= 0) return { net: r3(t), tax: 0 };
  const tax = r3(t - t / (1 + r));
  return { net: r3(t - tax), tax };
};

// Client-side unique id for orders / misc cart lines.
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// The trading date + wall-clock time a sale is stamped with.
//
// This used to read `date` from toISOString() (UTC) and `time` from toTimeString() (the
// terminal's local clock). Those are different clocks: at 01:00 in Amman the pair came out
// as date 2026-08-08 / time 01:00:00 — a receipt dated yesterday, and a sale filed to the
// wrong trading day in History and the Z-report. For a shop whose best hours run past
// midnight that mis-files three hours of takings every single night.
//
// Both halves now come from ONE formatting pass in the store's own timezone, so they can
// never disagree, and the day rolls over when the shop's clock says it does.
const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: STORE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

export const nowParts = (at = new Date()) => {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(at)) p[type] = value;
  // Intl renders midnight as "24" in some engines; normalise so the string always parses.
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}:${p.second}`,
  };
};

// The shop's current trading date (YYYY-MM-DD) — what History opens on.
export const todayInStore = () => nowParts().date;

// Read a stored row's clock from its `created_at` timestamp rather than its `date`/`time`
// text columns. Those columns are written by the till at checkout and are what the receipt
// prints, but `created_at` is what every list is ORDERED by — so when the two disagree (an
// imported row, or anything written before the timezone fix) History showed a 12:00 sale
// sitting above a 22:52 one and looked broken. Sorting and display now read the same field.
export const storePartsOf = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : nowParts(d);
};
export const storeTimeOf = (ts, fallback = '') => {
  const p = storePartsOf(ts);
  return p ? p.time.slice(0, 5) : String(fallback || '').slice(0, 5);
};
export const storeDateOf = (ts, fallback = '') => {
  const p = storePartsOf(ts);
  return p ? p.date : String(fallback || '');
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

// Is a failed request the server's fault rather than this request's?
//
// Two shapes of outage look completely different to fetch and have to be treated the same:
//   - no response at all (.status undefined) — the server is unreachable
//   - a 5xx — the server is running but something behind it, in practice its database, is not
//
// The second used to count as a rejection, because the only test was "did anything answer".
// So a Postgres restart during trading — a normal Tuesday — gave the cashier "Checkout
// failed" and threw the sale away, which is the exact case the offline queue exists for.
//
// A 4xx is deliberately excluded: that is the server rejecting THIS request on its merits
// (401 session gone, 409 invoice clash, 400 bad payload), and retrying it unchanged would
// only fail the same way while blocking everything queued behind it.
export const isServerFault = (ex) => !!ex && (ex.status === undefined || ex.status >= 500);
