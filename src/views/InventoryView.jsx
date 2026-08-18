import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { money, catColor } from '../lib';
import { ALL_CAT, categoryCards, inCat, CategoryGrid, CategoryHeader, catTitle, useProductArt } from '../components/categories';
import { ensureProductArt } from '../productArt';
import ProductModal from '../components/ProductModal';
import ImportModal from '../components/ImportModal';

function InventoryView({ isAdmin, notify }) {
  const [products, setProducts] = useState([]);
  // Same lookup the Sales shelf uses, so a product carries one picture across both screens.
  const productArt = useProductArt();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState(null);          // null = category grid; else the shelf you're in
  const [editing, setEditing] = useState(null);  // product or {cat} for new
  const [importing, setImporting] = useState(false);
  const load = useCallback(() => api.get('/products').then(setProducts).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const remove = async (p) => {
    if (!window.confirm((ARABIC ? 'حذف ' : 'Delete ') + p.name + '?')) return;
    try { await api.del('/products/' + p.id); setProducts((prev) => prev.filter((x) => x.id !== p.id)); }
    catch (ex) { notify(ARABIC ? 'فشل الحذف' : 'Delete failed', 'red'); }
  };

  // Same two-step browse as Sales: shelves first, then the rows on that shelf.
  // Searching cuts across every category. A new product is created straight into the
  // category you're standing in.
  const searching = q.trim().length > 0;
  const browsing = !searching && cat === null;
  const catCards = categoryCards(products);
  const rows = products.filter((p) => {
    if (searching) {
      const s = q.trim().toLowerCase();
      return (p.name || '').toLowerCase().includes(s) || (p.barcode || '').includes(q.trim());
    }
    if (cat === null) return false;
    return inCat(p, cat);
  });

  // Only the shelf on screen, never the whole catalogue — see ensureProductArt for what
  // fetching all 44 at once did to the renderer.
  const rowIds = rows.map((r) => r.id).join(',');
  useEffect(() => {
    if (browsing) return;
    rows.forEach((p) => ensureProductArt(p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowIds, browsing]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <input style={{ ...S.input, flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={ARABIC ? 'بحث عن منتج' : 'Search products'} />
        {/* Bulk import is admin-only for the same reason pricing is: it rewrites prices
            across the whole catalogue in one action. */}
        {isAdmin && <button onClick={() => setImporting(true)} style={S.btnGhost}>{ARABIC ? '⬆ استيراد CSV' : '⬆ Import CSV'}</button>}
        <button onClick={() => setEditing({ cat: cat && cat !== ALL_CAT ? cat : '' })} style={S.btn}>{ARABIC ? '+ منتج' : '+ Product'}</button>
      </div>

      {!browsing && (
        <CategoryHeader
          title={searching ? (ARABIC ? 'نتائج البحث' : 'Search results') : catTitle(cat)}
          count={rows.length}
          onBack={() => { setQ(''); setCat(null); }} />
      )}

      {browsing ? (
        <CategoryGrid cards={catCards} total={products.length} onPick={setCat}
          emptyHint={ARABIC ? 'لا منتجات بعد — اضغط + منتج' : 'No products yet — tap + Product'} />
      ) : (
      /* ITEM TILES, not a table.
         Same grain as the Sales shelf so staff learn one layout, but an inventory tile has to
         carry what the table columns did: SKU, category, price, stock against its own reorder
         point, and the two row actions. That is why it is taller and the grid minimum is wider
         than Sales' 185px — at 185 the SKU and the buttons collide.
         The card is a div, not a button: Edit and Del are real buttons and a button cannot be
         nested inside one. Tapping the card opens Edit, which is the action a tile is for on a
         touch screen; Del stops that propagation so it can never open the editor instead. */
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(235px, 1fr))', gap: 12, alignContent: 'start' }}>
        {rows.map((p) => {
          const tileArt = productArt(p.id);
          const low = Number(p.stock) <= Number(p.low_at ?? 5);
          return (
            <div key={p.id} className="rise" onClick={() => setEditing(p)} style={{
              display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px 12px',
              borderRadius: 12, border: `1px solid ${C.line}`, borderTop: `3px solid ${catColor(p.cat)}`,
              background: `linear-gradient(180deg, ${catColor(p.cat, 0.10)} 0%, ${C.panel2} 55%)`,
              color: C.text, cursor: 'pointer', textAlign: 'start',
            }}>
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, minHeight: 62 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{
                    fontSize: 15, fontWeight: 700, lineHeight: 1.25,
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                  }}>
                    {p.name}{p.size ? <span style={{ color: C.dim, fontWeight: 800 }}> · {p.size}</span> : ''}
                  </span>
                  <span style={{ fontSize: 11, color: C.dim, fontFamily: 'ui-monospace, monospace' }}>
                    {p.barcode || '—'}
                  </span>
                  <span style={{ fontSize: 11, color: C.dim }}>{p.cat || '—'}</span>
                </div>
                {/* contain, not cover: a decapitated cup is worse than a small one. */}
                {tileArt && (
                  <img src={tileArt} alt="" aria-hidden="true" draggable="false" style={{
                    flex: '0 0 clamp(50px, 26%, 78px)', alignSelf: 'stretch', minWidth: 0,
                    marginInlineEnd: -4, marginTop: -2,
                    objectFit: 'contain', objectPosition: 'center', pointerEvents: 'none',
                    filter: 'drop-shadow(0 6px 12px rgba(0,0,0,.45))',
                  }} />
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: C.accent, fontWeight: 800, fontSize: 16, fontVariantNumeric: 'tabular-nums' }}>
                  {money(p.price)}
                </span>
                {/* Red against THIS product's reorder point, not a shop-wide 5, and the point is
                    shown when stock is under it so the number explains itself — same rule the
                    table used. */}
                <span style={{ fontSize: 13, color: low ? C.red : C.dim, fontVariantNumeric: 'tabular-nums' }}>
                  {ARABIC ? 'مخزون' : 'stock'} <b style={{ color: low ? C.red : C.text, fontWeight: 800 }}>{Number(p.stock)}</b>
                  {low && <span style={{ color: C.dim }}> / {Number(p.low_at ?? 5)}</span>}
                </span>
              </div>

              {/* 44px minimum, per the design system: a mis-tap on Del is a deletion with a
                  customer waiting. */}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={(e) => { e.stopPropagation(); setEditing(p); }}
                  style={{ ...S.btnGhost, flex: 1, minHeight: 44, fontSize: 14, fontWeight: 700 }}>
                  {ARABIC ? 'تعديل' : 'Edit'}
                </button>
                {isAdmin && (
                  <button onClick={(e) => { e.stopPropagation(); remove(p); }}
                    style={{ ...S.btnGhost, flex: '0 0 88px', minHeight: 44, fontSize: 14, fontWeight: 700, color: C.red, borderColor: C.red }}>
                    {ARABIC ? 'حذف' : 'Del'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!rows.length && (
          <div style={{ color: C.dim, fontSize: 15, gridColumn: '1/-1', padding: 40, textAlign: 'center' }}>
            <div style={{ fontSize: 52, marginBottom: 12, opacity: .45 }}>📦</div>
            {rows.length === 0 && (searching
              ? (ARABIC ? 'لا نتائج مطابقة' : 'Nothing matches that search')
              : (ARABIC ? 'لا منتجات في هذه الفئة' : 'No products in this category'))}
          </div>
        )}
      </div>
      )}
      {editing && (
        <ProductModal initial={editing} editing={!!editing.id} notify={notify} isAdmin={isAdmin}
          onClose={() => setEditing(null)}
          onSaved={(p) => { setProducts((prev) => { const i = prev.findIndex((x) => x.id === p.id); return i >= 0 ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]; }); setEditing(null); }} />
      )}
      {importing && (
        <ImportModal notify={notify}
          onClose={() => setImporting(false)}
          onImported={() => { setImporting(false); load(); }} />
      )}
    </div>
  );
}

export default InventoryView;
export { InventoryView };
