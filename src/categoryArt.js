// Resolves the artwork for a category tile, in priority order:
//
//   1. the shop's own uploaded image   (GET /api/category-images/:cat)
//   2. the bundled artwork             (src/assets/categories)
//   3. nothing — the caller draws the coloured letter badge
//
// WHY UPLOADED IMAGES ARE FETCHED AS BLOBS RATHER THAN SET AS AN <img src>
// The endpoint requires a session, and an <img> tag cannot carry an Authorization header —
// pointing src straight at /api/category-images/whiskey would just 401. So each image is
// fetched with the Bearer token and turned into an object URL. Keeping the route
// authenticated is the right trade: the alternative is a public endpoint that enumerates a
// shop's category names to anyone who asks.
//
// Object URLs are cached for the life of the page and revoked when a category's image is
// replaced, so switching screens does not leak one per render.
import api from './api';
import { categoryImage as bundledImage } from './assets/categories';

const objectUrls = new Map();   // cat (lowercased) → blob: URL
let manifest = new Map();       // cat (lowercased) → updated_at, i.e. "who has an upload"
let loaded = false;
const listeners = new Set();

const key = (cat) => String(cat || '').trim().toLowerCase();

function notify() { listeners.forEach((fn) => { try { fn(); } catch (_) { /* a bad listener must not stop the rest */ } }); }

function revoke(cat) {
  const url = objectUrls.get(cat);
  if (url) { URL.revokeObjectURL(url); objectUrls.delete(cat); }
}

// Pull the bytes for one category and publish its object URL.
async function fetchOne(cat) {
  try {
    const blob = await api.getBlob(`/category-images/${encodeURIComponent(cat)}`);
    revoke(cat);
    objectUrls.set(cat, URL.createObjectURL(blob));
    notify();
  } catch (_) {
    // A missing or unreadable upload is not an error worth surfacing — the tile simply
    // falls back to the bundled artwork or the letter badge.
  }
}

// Load the manifest once per page, then fetch only the images that actually exist rather
// than firing a 404 for every category without one.
export async function loadCategoryArt() {
  try {
    const rows = await api.get('/category-images');
    manifest = new Map((rows || []).map((r) => [key(r.cat), r.updated_at]));
    loaded = true;
    notify();
    await Promise.all([...manifest.keys()].map(fetchOne));
  } catch (_) {
    loaded = true;   // offline or unauthorised: fall back to bundled artwork silently
    notify();
  }
}

// Re-read one category after an upload or delete, so the tile updates without a reload.
export async function refreshCategoryArt(cat) {
  const k = key(cat);
  try {
    const rows = await api.get('/category-images');
    manifest = new Map((rows || []).map((r) => [key(r.cat), r.updated_at]));
  } catch (_) { /* keep whatever manifest we had */ }
  if (manifest.has(k)) await fetchOne(k);
  else { revoke(k); notify(); }
}

// The single lookup every tile goes through.
export function artFor(cat) {
  const k = key(cat);
  return objectUrls.get(k) || bundledImage(k) || null;
}

// True when this category is showing the shop's own upload rather than a bundled image.
export const hasUpload = (cat) => manifest.has(key(cat));
export const artLoaded = () => loaded;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
