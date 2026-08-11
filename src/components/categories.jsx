// The two-step shelf browse (categories → items) used by both Sales and Inventory, so the
// cashier learns one navigation model instead of two.
import React from 'react';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { catColor } from '../lib';
import { categoryImage } from '../assets/categories';

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
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 12, alignContent: 'start' }}>
      {cards.map((c) => {
        const art = c.orphan ? null : categoryImage(c.name);
        return (
          // ARTWORK ABOVE, LABEL BELOW — they are stacked siblings, never overlapping layers.
          //
          // Two earlier attempts failed the same way. Floating the bottle over the card and
          // reserving 62%/46% for label/art sums past 100%, so "Accessories" and "Champagne"
          // ran under the glass. Making them side-by-side flex siblings fixed the overlap but
          // left a ~83px text column, too narrow for "Accessories" at 17px — it broke
          // mid-word — while squeezing the bottle down to 63px.
          //
          // Stacking removes the competition instead of rationing it: the name gets the full
          // card width, and the artwork gets the full card width too. Categories are
          // user-named, so a name longer than any percentage you pick will always exist.
          <button key={c.key || 'none'} onClick={() => onPick(c.key)} className="rise" style={{
            display: 'flex', flexDirection: 'column', gap: 8, height: 168, padding: '12px 16px 14px',
            borderRadius: 14, border: `1px solid ${c.orphan ? C.line : catColor(c.name, 0.45)}`,
            background: c.orphan ? C.panel2 : `linear-gradient(150deg, ${catColor(c.name, 0.26)} 0%, ${C.panel2} 70%)`,
            color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', overflow: 'hidden',
          }}>
            {/* object-fit: contain is what keeps the whole bottle visible as the grid
                reflows — the tile is minmax(170px, 1fr) so its width changes constantly,
                and `cover` would fill the slot but decapitate every bottle. */}
            {art ? (
              <img src={art} alt="" aria-hidden="true" draggable="false" style={{
                flex: 1, minHeight: 0, width: '100%',
                objectFit: 'contain', objectPosition: 'center', pointerEvents: 'none',
                filter: 'drop-shadow(0 8px 16px rgba(0,0,0,.5))',
              }} />
            ) : (
              // No artwork is a supported state: the category list is user-editable, so new
              // categories WILL appear with none. Fall back to the coloured letter badge.
              <span style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={{
                  width: 46, height: 46, borderRadius: 14, background: c.orphan ? C.line : catColor(c.name),
                  color: c.orphan ? C.dim : '#0f1117',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 22,
                }}>{c.orphan ? '?' : c.name.slice(0, 1)}</span>
              </span>
            )}
            <span style={{ minWidth: 0 }}>
              {/* Wraps at word boundaries to a second line, then clips. Never mid-word. */}
              <span style={{
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                fontSize: 17, fontWeight: 800, lineHeight: 1.2,
              }}>{c.name}</span>
              <span style={{ display: 'block', marginTop: 3, fontSize: 12, color: C.dim }}>
                {c.count} {ARABIC ? 'صنف' : c.count === 1 ? 'item' : 'items'}
              </span>
            </span>
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 17, fontWeight: 800, color: C.text }}>{title}</span>
      <span style={{ fontSize: 13, color: C.dim }}>
        {count} {ARABIC ? 'صنف' : count === 1 ? 'item' : 'items'}
      </span>
      {extra}
      {onBack && (
        <button onClick={onBack} style={{
          ...S.btn, marginInlineStart: 'auto', padding: '14px 22px', fontSize: 17, fontWeight: 800,
          background: C.accent, color: C.accentText, border: `1px solid ${C.accent}`,
          borderRadius: 12, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(240,168,48,.25)',
        }}>
          {ARABIC ? 'الأقسام ›' : '‹ Categories'}
        </button>
      )}
    </div>
  );
}

const catTitle = (cat) => (cat === ALL_CAT ? (ARABIC ? 'كل الأصناف' : 'All items')
  : cat === NO_CAT ? (ARABIC ? 'بدون فئة' : 'Uncategorised') : cat);


export { ALL_CAT, NO_CAT, categoryCards, inCat, CategoryGrid, CategoryHeader, catTitle };
