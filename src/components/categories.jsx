// The two-step shelf browse (categories → items) used by both Sales and Inventory, so the
// cashier learns one navigation model instead of two.
import React, { useEffect, useState } from 'react';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { catColor } from '../lib';
import { artFor, loadCategoryArt, artLoaded, subscribe } from '../categoryArt';
import {
  productArtFor, loadProductArt, productArtLoaded, subscribe as subscribeProductArt,
} from '../productArt';

// Re-render the shelf when a category's artwork arrives or is replaced. The lookup itself
// lives in categoryArt.js — this hook only exists so React learns about it.
function useCategoryArt() {
  const [, bump] = useState(0);
  useEffect(() => {
    const off = subscribe(() => bump((n) => n + 1));
    if (!artLoaded()) loadCategoryArt();
    return off;
  }, []);
  return artFor;
}

// The same shape for the per-PRODUCT pictures on the item tiles. It lives here beside its
// category twin so both screens reach for one module rather than each growing its own.
// Returns a lookup that gives null for any product without an upload, which is the normal
// case and not a gap: the tile simply looks the way it did before.
function useProductArt() {
  const [, bump] = useState(0);
  useEffect(() => {
    const off = subscribeProductArt(() => bump((n) => n + 1));
    if (!productArtLoaded()) loadProductArt();
    return off;
  }, []);
  return productArtFor;
}

const ALL_CAT = 'all';
const NO_CAT = '';

// Build the card list from a product array: one card per category, plus an
// "Uncategorised" card only when something actually needs it.
function categoryCards(products) {
  const named = Array.from(new Set(products.map((p) => p.cat).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b))
    .map((c) => ({ key: c, name: c, count: products.filter((p) => p.cat === c).length }));
  const orphans = products.filter((p) => !p.cat).length;
  if (orphans) named.push({ key: NO_CAT, name: ARABIC ? 'بدون فئة' : 'Uncategorised', count: orphans, orphan: true });
  return named;
}

// Does this product belong in the current view? (search is handled by the caller)
const inCat = (p, cat) => (cat === ALL_CAT ? true : cat === NO_CAT ? !p.cat : p.cat === cat);

function CategoryGrid({ cards, total, onPick, emptyHint }) {
  const art = useCategoryArt();
  return (
    // 210px minimum, not 170: the tile now carries a photograph beside the name, and at
    // 170 the text column drops under what the longest category name needs.
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 12, alignContent: 'start' }}>
      {cards.map((c) => {
        const tileArt = c.orphan ? null : art(c.name);
        return (
          // LABEL LEFT, ARTWORK RIGHT — as flex SIBLINGS, so they cannot overlap.
          //
          // The first version floated the bottle over the card with 62% reserved for the
          // label and 46% for the art. That sums past 100%, and measuring glyph extents
          // showed the two longest names, "Accessories" and "Champagne", running under the
          // glass. Siblings make that impossible by construction rather than by arithmetic.
          //
          // The remaining question is only whether the longest name FITS beside the art, and
          // that was measured rather than guessed: "Accessories" renders 103px at 17px and
          // 97px at 16px in DM Sans 800. The numbers below are chosen against that budget —
          // at the ~221px tile a 210px grid minimum produces, the text column comes out near
          // 103px, which clears 16px with room rather than landing on the boundary.
          // A multi-word name wraps to a second line at a WORD boundary; it never breaks
          // mid-word, which is what "Accessorie/s" looked like when the column was 83px.
          <button key={c.key || 'none'} onClick={() => onPick(c.key)} className="rise" style={{
            display: 'flex', alignItems: 'stretch', gap: 10, height: 150, padding: 14,
            borderRadius: 14, border: `1px solid ${c.orphan ? C.line : catColor(c.name, 0.45)}`,
            background: c.orphan ? C.panel2 : `linear-gradient(150deg, ${catColor(c.name, 0.26)} 0%, ${C.panel2} 70%)`,
            color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', overflow: 'hidden',
          }}>
            <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
              {/* No artwork is a supported state: the category list is user-editable, so new
                  categories WILL appear with none. Fall back to the coloured letter badge. */}
              {tileArt ? <span /> : (
                <span style={{
                  width: 38, height: 38, borderRadius: 12, background: c.orphan ? C.line : catColor(c.name),
                  color: c.orphan ? C.dim : C.accentText,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18,
                }}>{c.orphan ? '?' : c.name.slice(0, 1)}</span>
              )}
              <span style={{ minWidth: 0 }}>
                <span style={{
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  fontSize: 16, fontWeight: 800, lineHeight: 1.2,
                }}>{c.name}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 12, color: C.dim }}>
                  {c.count} {ARABIC ? 'صنف' : c.count === 1 ? 'item' : 'items'}
                </span>
              </span>
            </span>
            {/* Bounded by clamp() rather than a bare percentage: the bottle grows with the
                tile on a wide counter monitor but can never eat the name's column on a
                narrow one. object-fit: contain keeps the whole bottle visible as the grid
                reflows — `cover` would fill the slot but decapitate every one of them. */}
            {tileArt && (
              <img src={tileArt} alt="" aria-hidden="true" draggable="false" style={{
                flex: '0 0 clamp(64px, 36%, 104px)', alignSelf: 'stretch', minWidth: 0,
                marginInlineEnd: -6, marginBlock: -6,
                objectFit: 'contain', objectPosition: 'center', pointerEvents: 'none',
                filter: 'drop-shadow(0 8px 16px rgba(0,0,0,.5))',
              }} />
            )}
          </button>
        );
      })}
      {!!cards.length && (
        <button onClick={() => onPick(ALL_CAT)} className="rise" style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10, height: 132, padding: '14px 16px',
          borderRadius: 14, border: `1px dashed ${C.line}`, background: C.panel2,
          color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit',
        }}>
          <span style={{ fontSize: 26, opacity: .5 }}>🗂</span>
          <span>
            <span style={{ display: 'block', fontSize: 17, fontWeight: 800 }}>{ARABIC ? 'كل الأصناف' : 'All items'}</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: C.dim }}>
              {total} {ARABIC ? 'صنف' : 'items'}
            </span>
          </span>
        </button>
      )}
      {!cards.length && (
        <div style={{ color: C.dim, fontSize: 15, gridColumn: '1/-1', padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 52, marginBottom: 12, opacity: .45 }}>📦</div>
          {emptyHint}
        </div>
      )}
    </div>
  );
}

// Breadcrumb above the drilled-in list. Back sits at the trailing edge (right in LTR,
// left in RTL) so it lands under the thumb on a counter tablet.
function CategoryHeader({ title, count, onBack, extra }) {
  return (
    // flexWrap so neither control can be pushed off a narrow counter screen, and a BACK
    // button at the leading edge. The trailing '‹ Categories' button below was the only way
    // back, and it was reported as missing twice by someone looking straight at it: people
    // look top-LEFT for back, the label said 'Categories' rather than 'Back', and the amber
    // fill read as a primary action. Both call the same handler; the trailing one stays
    // because on a counter tablet it is the one under the thumb.
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {onBack && (
        <button onClick={onBack} aria-label={ARABIC ? 'رجوع' : 'Back'} style={{
          ...S.btn, padding: '12px 18px', fontSize: 16, fontWeight: 800,
          background: C.accent, color: C.accentText, border: `1px solid ${C.accent}`,
          borderRadius: 12, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(240,168,48,.25)',
        }}>
          {ARABIC ? 'رجوع →' : '← Back'}
        </button>
      )}
      <span style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{title}</span>
      <span style={{ fontSize: 13, color: C.dim }}>
        {count} {ARABIC ? 'صنف' : count === 1 ? 'item' : 'items'}
      </span>
      {extra}
      {onBack && (
        <button onClick={onBack} style={{
          ...S.btnGhost, marginInlineStart: 'auto', padding: '14px 22px', fontSize: 17, fontWeight: 800,
          borderRadius: 12, whiteSpace: 'nowrap',
        }}>
          {ARABIC ? 'الأقسام ›' : '‹ Categories'}
        </button>
      )}
    </div>
  );
}

const catTitle = (cat) => (cat === ALL_CAT ? (ARABIC ? 'كل الأصناف' : 'All items')
  : cat === NO_CAT ? (ARABIC ? 'بدون فئة' : 'Uncategorised') : cat);


export { ALL_CAT, NO_CAT, categoryCards, inCat, CategoryGrid, CategoryHeader, catTitle, useProductArt };
