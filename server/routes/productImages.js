// /api/product-images — per-product artwork (see migration 0012).
//
// Deliberately a near-mirror of routes/categoryImages.js: same 512x512 transparent PNG,
// same base64-in-JSON upload, same admin gate, same immutable caching. Two subtly different
// upload paths for the same kind of asset is how one of them ends up with the weaker
// validation, so the PNG validator is IMPORTED from that route rather than re-implemented.
//
// The one real difference is the key: a product id, which must exist. An upload for a
// missing id is rejected here rather than being caught by the foreign key as a 500 — the
// caller gets a 404 that says what is wrong.
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireAdmin } = require('../auth');
const { fail, dbError } = require('../validate');
const { validatePng } = require('./categoryImages');

// Matches MAX_BYTES in categoryImages.js. A normalised 512x512 PNG is ~50-250KB; the
// ceiling sits below the 2mb express.json limit so this route's own check is the one that
// fires, with an error that names the cause.
const MAX_BYTES = 1_000_000;

// Product ids are serial integers. Anything else is a 400 rather than a Postgres cast error
// surfacing as a 500 — the same reasoning as the barcode validation in routes/products.js.
const productId = (raw) => {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 && n < 2_147_483_647 ? n : null;
};

// GET /api/product-images → [{ product_id, updated_at }] for every product that has artwork.
//
// The client asks for this ONCE and then fetches only the images that exist. With a 44-item
// catalogue the alternative — a request per product — is 44 requests of which most are 404s,
// against a rate limit sized for a whole shop.
router.get('/product-images', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'select product_id, updated_at from product_images order by product_id'
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/product-images/:id → the raw PNG.
//
// Long max-age + ETag: the bytes for a given version never change, and the client busts the
// URL with the manifest's updated_at when they do. Without this every tile re-downloads its
// picture on every render of the sales grid.
router.get('/product-images/:id', requireSession, async (req, res, next) => {
  try {
    const id = productId(req.params.id);
    if (!id) return fail(res, 'invalid', 400);
    const { rows } = await db.query(
      'select mime, bytes, updated_at from product_images where product_id = $1', [id]
    );
    if (!rows[0]) return fail(res, 'not_found', 404);
    const row = rows[0];
    const etag = `"p${id}-${new Date(row.updated_at).getTime()}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', row.mime || 'image/png');
    res.send(row.bytes);
  } catch (e) { next(e); }
});

// PUT /api/product-images/:id  { data: "<base64 png>" }  (admin)
//
// Admin-only for the same reason pricing is: the tile is what a barista aims at, so whoever
// controls the picture controls which product gets rung up. A mislabelled photo is a
// quieter version of the under-ringing this codebase already guards against.
router.put('/product-images/:id', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const id = productId(req.params.id);
    if (!id) return fail(res, 'invalid', 400);

    const data = (req.body || {}).data;
    if (typeof data !== 'string' || !data) return fail(res, 'invalid', 400);
    // Accept a bare base64 payload or a full data: URL, so the client can send whatever
    // canvas.toDataURL gave it without string surgery at the call site.
    const b64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;

    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { return fail(res, 'invalid', 400); }
    if (buf.length > MAX_BYTES) return fail(res, 'too_large', 413);

    // Re-validated server-side even though the browser normalises: this endpoint is
    // reachable with a session and a curl command, and what we accept here is handed back to
    // every till as an image.
    const bad = validatePng(buf);
    if (bad) return fail(res, bad, 400);

    // Check the product exists first, so a bad id is a 404 rather than a foreign-key
    // violation dressed up as a generic 'invalid'.
    const { rows } = await db.query('select id from products where id = $1', [id]);
    if (!rows[0]) return fail(res, 'not_found', 404);

    await db.query(
      `insert into product_images (product_id, mime, bytes, updated_at, updated_by)
       values ($1, 'image/png', $2, now(), $3)
       on conflict (product_id) do update
         set bytes = excluded.bytes, mime = excluded.mime,
             updated_at = now(), updated_by = excluded.updated_by`,
      [id, buf, req.user.username]
    );
    res.json({ ok: true, product_id: id, bytes: buf.length });
  } catch (e) { dbError(res, next, e); }
});

// DELETE /api/product-images/:id (admin) → the tile falls back to its category's artwork,
// then to the coloured letter badge. Removing the picture never touches the product itself.
router.delete('/product-images/:id', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const id = productId(req.params.id);
    if (!id) return fail(res, 'invalid', 400);
    await db.query('delete from product_images where product_id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

module.exports = router;
