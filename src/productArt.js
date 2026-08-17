// Resolves the artwork for a PRODUCT tile, in priority order:
//
//   1. the shop's own uploaded image for this product  (GET /api/product-images/:id)
//   2. nothing — the caller falls back to the category artwork it already drew
//
// There is no bundled per-product set and there never will be: a product list is the one
// thing that is entirely the shop's, so shipping stock photos of "Espresso" would be
// guessing at someone else's menu. A product with no upload is not a gap to fill, it is the
// normal case, and the tile it already had is the right answer.
//
// WHY BLOBS RATHER THAN <img src>
// Same reason as categoryArt.js: the endpoint requires a session and an <img> tag cannot
// carry an Authorization header, so pointing src at /api/product-images/12 would just 401.
// Each image is fetched with the Bearer token and turned into an object URL — which is why
// the CSP allows blob: in img-src.
//
// Object URLs live for the page and are revoked when an image is replaced, so switching
// screens does not leak one per render.
import api from './api';

const objectUrls = new Map();   // product id (number) → blob: URL
let manifest = new Map();       // product id (number) → updated_at, i.e. "who has an upload"
let loaded = false;
const listeners = new Set();

const key = (id) => Number(id);

function notify() {
  listeners.forEach((fn) => { try { fn(); } catch (_) { /* one bad listener must not stop the rest */ } });
}

function revoke(id) {
  const url = objectUrls.get(id);
  if (url) { URL.revokeObjectURL(url); objectUrls.delete(id); }
}

// Pull the bytes for one product and publish its object URL.
async function fetchOne(id) {
  try {
    const blob = await api.getBlob(`/product-images/${id}`);
    revoke(id);
    objectUrls.set(id, URL.createObjectURL(blob));
    notify();
  } catch (_) {
    // A missing or unreadable upload is not worth surfacing — the tile falls back to its
    // category artwork, which is what it showed before anyone uploaded anything.
  }
}

// Load the manifest once per page, then fetch only the images that exist.
//
// The fetches run in parallel, and each response is `immutable` with a year-long max-age, so
// this costs one request per product-with-artwork on the FIRST load of a session and nothing
// afterwards — including across screen changes, because the browser serves them from its own
// HTTP cache rather than coming back here.
export async function loadProductArt() {
  try {
    const rows = await api.get('/product-images');
    manifest = new Map((rows || []).map((r) => [key(r.product_id), r.updated_at]));
    loaded = true;
    notify();
    await Promise.all([...manifest.keys()].map(fetchOne));
  } catch (_) {
    loaded = true;   // offline or unauthorised: every tile keeps its category artwork
    notify();
  }
}

// Re-read one product after an upload or delete, so its tile updates without a reload.
export async function refreshProductArt(id) {
  const k = key(id);
  try {
    const rows = await api.get('/product-images');
    manifest = new Map((rows || []).map((r) => [key(r.product_id), r.updated_at]));
  } catch (_) { /* keep whatever manifest we had */ }
  if (manifest.has(k)) await fetchOne(k);
  else { revoke(k); notify(); }
}

// The single lookup every tile goes through. Returns null when this product has no picture,
// which is the caller's cue to use what it was using before.
export function productArtFor(id) {
  return objectUrls.get(key(id)) || null;
}

// True when this product has an uploaded image (whether or not its bytes have arrived yet).
export const hasProductArt = (id) => manifest.has(key(id));
export const productArtLoaded = () => loaded;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
