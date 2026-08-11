// /api/category-images — user-uploaded artwork for product categories.
//
// The browser normalises every upload to a 512x512 transparent PNG before it is sent
// (src/imageNormalize.js), so the shop cannot produce a tile that is the wrong size or
// shape. THIS ROUTE DOES NOT TRUST THAT. The endpoint is reachable with a session and a
// curl command, so the bytes are re-validated here: real PNG signature, IHDR that actually
// says 512x512, and a hard byte ceiling. What we accept is what we later hand back to a
// browser as an image, so it has to be checked at the point it enters the database.
const router = require('express').Router();
const db = require('../db');
const { requireSession, requireAdmin } = require('../auth');
const { fail, dbError } = require('../validate');

const SIZE = 512;                       // must match imageNormalize.js
// A normalised 512x512 PNG is ~50-250KB. The ceiling sits at 1MB so the route's own check
// is the one that fires: base64 inflates by ~4/3, and anything much above this would be
// rejected by the 2mb express.json limit first, which is a blunter error further from the
// cause.
const MAX_BYTES = 1_000_000;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Normalise a category name to its storage key. Mirrors categoryImage() on the client —
// if these two ever disagree, an upload silently fails to appear on the tile.
const key = (name) => String(name || '').trim().toLowerCase();

// Validate that `buf` really is a PNG of exactly SIZE x SIZE.
//
// A PNG is an 8-byte signature followed by chunks; the first chunk must be IHDR, whose data
// begins with width and height as big-endian uint32. Checking the declared dimensions in
// the header (rather than believing the uploader) is what stops a 8000x8000 decompression
// bomb or a mis-sized image being stored and then handed to every till in the shop.
function validatePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) return 'not_png';
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return 'not_png';
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return 'not_png';
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== SIZE || height !== SIZE) return 'bad_size';
  return null;
}

// GET /api/category-images → [{ cat, updated_at }] for every category that has artwork.
// The client asks for this ONCE and then requests only the images that exist, instead of
// firing a 404 for each of the categories that do not.
router.get('/category-images', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'select cat, updated_at from category_images order by cat'
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// GET /api/category-images/:cat → the raw PNG.
//
// Served with a long max-age and an ETag: the bytes for a given version never change, and
// the client busts the URL with ?v=<updated_at> when it does. Without this every tile
// re-downloads its picture on every render of the shelf grid.
router.get('/category-images/:cat', requireSession, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'select mime, bytes, updated_at from category_images where cat = $1', [key(req.params.cat)]
    );
    if (!rows[0]) return fail(res, 'not_found', 404);
    const row = rows[0];
    const etag = `"${key(req.params.cat)}-${new Date(row.updated_at).getTime()}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Content-Type', row.mime || 'image/png');
    res.send(row.bytes);
  } catch (e) { next(e); }
});

// PUT /api/category-images/:cat  { data: "<base64 png>" }  (admin)
//
// base64 in JSON rather than multipart: a normalised tile is small enough to sit inside the
// 2mb express.json limit that already exists, so this adds no upload dependency and no new
// parser to the request path that also carries checkout.
router.put('/category-images/:cat', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const cat = key(req.params.cat);
    if (!cat || cat.length > 100) return fail(res, 'invalid', 400);

    const data = (req.body || {}).data;
    if (typeof data !== 'string' || !data) return fail(res, 'invalid', 400);
    // Accept a bare base64 payload or a full data: URL, so the client can send whatever
    // canvas.toDataURL gave it without string surgery at the call site.
    const b64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;

    let buf;
    try { buf = Buffer.from(b64, 'base64'); } catch (_) { return fail(res, 'invalid', 400); }
    if (buf.length > MAX_BYTES) return fail(res, 'too_large', 413);

    const bad = validatePng(buf);
    if (bad) return fail(res, bad, 400);

    await db.query(
      `insert into category_images (cat, mime, bytes, updated_at, updated_by)
       values ($1, 'image/png', $2, now(), $3)
       on conflict (cat) do update
         set bytes = excluded.bytes, mime = excluded.mime,
             updated_at = now(), updated_by = excluded.updated_by`,
      [cat, buf, req.user.username]
    );
    res.json({ ok: true, cat, bytes: buf.length });
  } catch (e) { dbError(res, next, e); }
});

// DELETE /api/category-images/:cat (admin) → fall back to the bundled artwork, or to the
// coloured letter badge if there is none. Deleting the picture never touches the category
// itself, which is why this is not gated the way category deletion is.
router.delete('/category-images/:cat', requireSession, requireAdmin, async (req, res, next) => {
  try {
    await db.query('delete from category_images where cat = $1', [key(req.params.cat)]);
    res.json({ ok: true });
  } catch (e) { dbError(res, next, e); }
});

module.exports = router;
module.exports.validatePng = validatePng;
