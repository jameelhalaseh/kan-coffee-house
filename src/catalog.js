// The last catalogue the server gave us, kept so the till can still sell without it.
//
// WHY
// Everything else about offline worked — the shell loads, the session survives, sales queue
// and drain — but the sales screen said "No products", because the catalogue comes from
// /api/products and that request fails with the server down. A till that cannot show a
// product cannot ring one, so the queue it carries was unreachable in normal use. This is
// the piece that makes the rest of it worth having.
//
// WHAT IS AND IS NOT SAFE TO SERVE STALE
// Names, barcodes, categories and prices are stable — a shop does not reprice mid-outage,
// and selling at yesterday's price is vastly better than not selling.
//
// STOCK IS DIFFERENT and is deliberately not trusted here: a cached count is a guess the
// moment anybody else sells anything, and it goes further out of date every minute the
// outage lasts. It is kept only so the screen has something to render, and callers are
// expected to treat it as indicative. The server recomputes stock properly when the queued
// sale lands, which is the only number that ever mattered.
import { CATALOG_KEY } from './constants';

// A shop with a few thousand lines is well inside the ~5MB localStorage budget, but a write
// that fails (quota, private mode, a locked profile) must never break a checkout — the
// catalogue is a convenience and the sale is not.
export function saveCatalog(products) {
  if (!Array.isArray(products) || !products.length) return false;
  try {
    localStorage.setItem(CATALOG_KEY, JSON.stringify({ at: Date.now(), products }));
    return true;
  } catch (_) {
    return false;
  }
}

// Defensive on the way out: this is localStorage, so it can be absent, truncated by a full
// quota, or left over from an older shape of the app. Anything unreadable reads as "no
// catalogue" rather than crashing the sales screen at the counter.
export function readCatalog(raw) {
  const text = raw !== undefined ? raw : safeGet();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    // Tolerate the bare array an earlier version might have written, as well as the wrapper.
    const products = Array.isArray(parsed) ? parsed : parsed && parsed.products;
    if (!Array.isArray(products) || !products.length) return null;
    if (!products.every((p) => p && (p.id !== undefined) && p.name !== undefined)) return null;
    return { products, at: (parsed && parsed.at) || null };
  } catch (_) {
    return null;
  }
}

function safeGet() {
  try { return localStorage.getItem(CATALOG_KEY); } catch (_) { return null; }
}

// How old the cached copy is, in whole hours — for telling the cashier what they are looking
// at rather than letting them assume it is live.
export function catalogAgeHours(at, now = Date.now()) {
  if (!at) return null;
  return Math.max(0, Math.floor((now - at) / 3600000));
}

export function clearCatalog() {
  try { localStorage.removeItem(CATALOG_KEY); } catch (_) {}
}
