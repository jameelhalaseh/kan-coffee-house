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
          <button key={c.key || 'none'} onClick={() => onPick(c.key)} className="rise" style={{
            position: 'relative',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 10, height: 132, padding: '14px 16px',
            borderRadius: 14, border: `1px solid ${c.orphan ? C.line : catColor(c.name, 0.45)}`,
            background: c.orphan ? C.panel2 : `linear-gradient(150deg, ${catColor(c.name, 0.26)} 0%, ${C.panel2} 70%)`,
            color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', overflow: 'hidden',
          }}>
            {/* The bottle sits on the trailing edge at full tile height, absolutely
                positioned so it never competes with the label for horizontal space — the
                tile is only ~170px wide at its narrowest and the name must stay readable.
                object-fit: contain is what guarantees the whole bottle is visible at every
                tile width; `cover` would fill the corner but decapitate it. */}
            {art && (
              <img src={art} alt="" aria-hidden="true" draggable="false" style={{
                position: 'absolute', insetInlineEnd: -6, top: 0, height: '100%', width: '46%',
                objectFit: 'contain', objectPosition: 'center', pointerEvents: 'none',
                filter: 'drop-shadow(0 6px 14px rgba(0,0,0,.45))',
              }} />
            )}
            {/* No artwork is a supported state: the category list is user-editable, so new
                categories WILL appear with none. Fall back to the coloured letter badge. */}
            {!art && (
              <span style={{
                width: 34, height: 34, borderRadius: 10, background: c.orphan ? C.line : catColor(c.name),
                color: c.orphan ? C.dim : '#0f1117',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 17,
              }}>{c.orphan ? '?' : c.name.slice(0, 1)}</span>
            )}
            {art && <span />}
            <span style={{ position: 'relative', maxWidth: '62%' }}>
              <span style={{ display: 'block', fontSize: 17, fontWeight: 800, lineHeight: 1.2 }}>{c.name}</span>
              <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: C.dim }}>
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
