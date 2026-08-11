// Normalise an uploaded image into the exact shape a category tile expects.
//
// Runs the same pipeline the thirteen bundled images were processed with offline, so a
// shop's own picture sits on the shelf at the same size and the same visual weight as the
// ones that shipped:
//
//   1. trim to the subject (the alpha bounding box, ignoring faint halo)
//   2. scale that subject to SUBJECT px on its longest side
//   3. centre it on a SIZE x SIZE transparent canvas
//   4. export PNG
//
// The user never picks a size, a shape or a format, so they cannot get it wrong. A 4000px
// phone photo, a 64px icon and a screenshot all come out as the same 512x512 PNG.
//
// Step 1 is what makes a set look deliberate rather than assembled: two photographs of the
// same bottle, one shot tight and one shot loose in a big empty frame, would otherwise land
// on the tile at completely different sizes.
export const SIZE = 512;              // must match SIZE in server/routes/categoryImages.js
const SUBJECT = 440;                  // subject's longest side, matching the bundled set
const ALPHA_FLOOR = 32;               // below this is halo/anti-aliasing, not subject
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

export class ImageNormalizeError extends Error {}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new ImageNormalizeError('unreadable')); };
    img.src = url;
  });
}

// The alpha bounding box: the smallest rectangle containing every pixel solid enough to be
// part of the subject. Returns null when the image is fully opaque (an ordinary photo with
// a background) — there is no subject to isolate, so the whole frame is used.
function alphaBounds(ctx, w, h) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = w, minY = h, maxX = -1, maxY = -1, transparent = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = data[(y * w + x) * 4 + 3];
      if (a < ALPHA_FLOOR) { transparent++; continue; }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;                        // nothing solid at all
  const ratio = transparent / (w * h);
  // A handful of transparent pixels is just a rounded corner, not a cut-out. Only treat
  // this as a subject-on-transparency when a real portion of the frame is empty.
  if (ratio < 0.02) return { box: null, hasAlpha: false };
  return { box: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, hasAlpha: true };
}

/**
 * @param {File|Blob} file
 * @returns {Promise<{ dataUrl: string, blob: Blob, hasTransparency: boolean, bytes: number }>}
 *
 * `hasTransparency` is passed back so the UI can WARN rather than silently produce a bad
 * tile: the cards are a colour gradient, so a picture that still has its own background
 * shows up as a rectangular block floating on the card. We cannot cut a background out in
 * the browser, but we can tell the user before they save it.
 */
export async function normalizeCategoryImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new ImageNormalizeError('not_an_image');
  if (file.size > MAX_SOURCE_BYTES) throw new ImageNormalizeError('source_too_large');

  const img = await loadImage(file);
  const sw = img.naturalWidth;
  const sh = img.naturalHeight;
  if (!sw || !sh) throw new ImageNormalizeError('unreadable');

  // Draw the source at its own size first so the alpha scan sees real pixels.
  const src = document.createElement('canvas');
  src.width = sw; src.height = sh;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);

  let bounds;
  try {
    bounds = alphaBounds(sctx, sw, sh);
  } catch (_) {
    // getImageData throws on a cross-origin source. Not reachable for a user-picked file,
    // but failing soft to "use the whole frame" beats failing the upload.
    bounds = { box: null, hasAlpha: false };
  }
  if (bounds === null) throw new ImageNormalizeError('blank');

  const crop = (bounds && bounds.box) || { x: 0, y: 0, w: sw, h: sh };
  const hasTransparency = Boolean(bounds && bounds.hasAlpha);

  const scale = Math.min(SUBJECT / crop.w, SUBJECT / crop.h);
  const dw = Math.max(1, Math.round(crop.w * scale));
  const dh = Math.max(1, Math.round(crop.h * scale));

  const out = document.createElement('canvas');
  out.width = SIZE; out.height = SIZE;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(img, crop.x, crop.y, crop.w, crop.h,
    Math.round((SIZE - dw) / 2), Math.round((SIZE - dh) / 2), dw, dh);

  const dataUrl = out.toDataURL('image/png');
  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  return { dataUrl, blob, hasTransparency, bytes: blob ? blob.size : 0 };
}

export default normalizeCategoryImage;
