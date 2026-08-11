// Category tile artwork.
//
// Every file is a 512×512 RGBA PNG with a transparent background and the subject scaled to a
// uniform 440px height, so thirteen separately-generated photographs carry the same visual
// weight on the shelf grid. Transparent rather than a flat dark square because each tile is
// a gradient from its own accent colour down to #22252F — a baked-in background would show
// as a rectangular seam floating on the card.
//
// Imported statically (not require.context) so webpack fingerprints each file, the CRA
// service worker precaches them, and the shelves still render with no network — this till
// keeps selling offline, and a blank grid is not an acceptable offline state.
//
// KEYED BY LOWERCASED CATEGORY NAME. The category list is user-editable, so a category with
// no artwork here is normal and must fall back to the coloured letter badge — see
// categoryImage() below, which is the only way this map should be read.
import whiskey from './whiskey.png';
import vodka from './vodka.png';
import gin from './gin.png';
import rum from './rum.png';
import tequila from './tequila.png';
import brandy from './brandy.png';
import arak from './arak.png';
import liqueur from './liqueur.png';
import wine from './wine.png';
import beer from './beer.png';

const IMAGES = { whiskey, vodka, gin, rum, tequila, brandy, arak, liqueur, wine, beer };

// Resolve a category name to its artwork, or null when there is none.
// Matching is lowercased+trimmed only — deliberately loose enough to survive "Whiskey" vs
// "whiskey", but not so clever that it guesses. No artwork is a supported state, not a bug.
export function categoryImage(cat) {
  if (!cat) return null;
  return IMAGES[String(cat).trim().toLowerCase()] || null;
}

export default IMAGES;
