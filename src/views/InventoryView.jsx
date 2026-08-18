import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { money } from '../lib';
import { ALL_CAT, categoryCards, inCat, CategoryGrid, CategoryHeader, catTitle } from '../components/categories';
import { th, td } from '../components/ui';
import ProductModal from '../components/ProductModal';
import ImportModal from '../components/ImportModal';

function InventoryView({ isAdmin, notify }) {
  const [products, setProducts] = useState([]);
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
      <div style={S.card}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ color: C.dim, textAlign: ARABIC ? 'right' : 'left' }}>
            <th style={th}>{ARABIC ? 'الاسم' : 'Name'}</th><th style={th}>{ARABIC ? 'الباركود' : 'Barcode'}</th>
            <th style={th}>{ARABIC ? 'الفئة' : 'Category'}</th><th style={{ ...th, textAlign: 'right' }}>{ARABIC ? 'السعر' : 'Price'}</th>
            <th style={{ ...th, textAlign: 'right' }}>{ARABIC ? 'المخزون' : 'Stock'}</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={td}>{p.name}{p.size ? <span style={{ color: C.dim }}> · {p.size}</span> : ''}</td>
                <td style={{ ...td, color: C.dim, fontFamily: 'monospace' }}>{p.barcode || '—'}</td>
                <td style={{ ...td, color: C.dim }}>{p.cat || '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>{money(p.price)}</td>
                {/* Red against THIS product's reorder point, not a shop-wide 5. The point
                    itself is shown when stock is under it, so the number explains itself. */}
                <td style={{ ...td, textAlign: 'right', color: Number(p.stock) <= Number(p.low_at ?? 5) ? C.red : C.text }}>
                  {Number(p.stock)}
                  {Number(p.stock) <= Number(p.low_at ?? 5) && (
                    <span style={{ color: C.dim, fontSize: 12 }}> / {Number(p.low_at ?? 5)}</span>
                  )}
                </td>
                <td style={{ ...td, textAlign: 'end', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setEditing(p)} style={S.btnRow}>{ARABIC ? 'تعديل' : 'Edit'}</button>
                  {isAdmin && <button onClick={() => remove(p)} style={{ ...S.btnRow, color: C.red, marginInlineStart: 8 }}>{ARABIC ? 'حذف' : 'Del'}</button>}
                </td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} style={{ ...td, color: C.dim, textAlign: 'center', padding: 24 }}>{searching ? (ARABIC ? 'لا نتائج مطابقة' : 'Nothing matches that search') : (ARABIC ? 'لا منتجات في هذه الفئة' : 'No products in this category')}</td></tr>}
          </tbody>
        </table>
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
