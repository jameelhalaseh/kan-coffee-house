import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { catColor } from '../lib';
import { Field, Overlay } from './ui';

function ProductModal({ initial, onClose, onSaved, notify, editing }) {
  const [barcode, setBarcode] = useState(initial.barcode || '');
  const [name, setName] = useState(initial.name || '');
  const [price, setPrice] = useState(initial.price != null ? String(initial.price) : '');
  const [cat, setCat] = useState(initial.cat || '');
  const [stock, setStock] = useState(initial.stock != null ? String(initial.stock) : '');
  const [cost, setCost] = useState(initial.cost != null ? String(initial.cost) : '');
  const [unit, setUnit] = useState(initial.unit === 'kg' ? 'kg' : 'ea');
  const [cats, setCats] = useState([]);
  const [newCat, setNewCat] = useState(false);   // typing a category that doesn't exist yet
  const [busy, setBusy] = useState(false);
  const nameRef = useRef(null);

  useEffect(() => {
    api.get('/settings/categories').then((r) => {
      try { setCats(r && r.value ? JSON.parse(r.value) : []); } catch (_) {}
    }).catch(() => {});
    nameRef.current && nameRef.current.focus();
  }, []);

  // The chips: the configured list, plus this product's own category if it predates the list.
  const catOptions = Array.from(new Set([...cats, ...(initial.cat ? [initial.cat] : [])]));

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) { notify(ARABIC ? 'الاسم مطلوب' : 'Name required', 'red'); return; }
    if (!cat.trim()) { notify(ARABIC ? 'اختر فئة للمنتج' : 'Pick a category for this product', 'red'); return; }
    setBusy(true);
    const body = { barcode: barcode.trim() || null, name: name.trim(), price: Number(price) || 0, cat: cat.trim(), cost: Number(cost) || 0, stock: Number(stock) || 0, unit };
    // A brand-new category is added to the shared list so it shows up as a chip everywhere.
    // Non-admins can't write settings — the product still saves with the category either way.
    if (!cats.includes(body.cat)) {
      try { await api.put('/settings/categories', { value: JSON.stringify([...cats, body.cat]) }); } catch (_) {}
    }
    try {
      if (editing) {
        await api.put('/products/' + initial.id, body);
        onSaved({ ...initial, ...body });
      } else {
        const p = await api.post('/products', body);
        onSaved(p);
      }
    } catch (ex) {
      notify(ex.message === 'exists' ? (ARABIC ? 'باركود مكرر' : 'Barcode already exists')
        : ex.message === 'admin_only' ? (ARABIC ? 'تعديل السعر يتطلب صلاحية مدير' : 'Price changes need an admin')
        : (ARABIC ? 'فشل الحفظ' : 'Save failed'), 'red');
    } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={save} style={{ ...S.card, width: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{editing ? (ARABIC ? 'تعديل منتج' : 'Edit product') : (ARABIC ? 'منتج جديد' : 'New product')}</div>
        <Field label={ARABIC ? 'الباركود' : 'Barcode'}><input style={S.input} value={barcode} onChange={(e) => setBarcode(e.target.value)} /></Field>
        <Field label={ARABIC ? 'الاسم' : 'Name'}><input ref={nameRef} style={S.input} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={ARABIC ? 'تباع بـ' : 'Sold by'}>
          <div style={{ display: 'flex', gap: 8 }}>
            {[['ea', ARABIC ? 'بالقطعة' : 'Each'], ['kg', ARABIC ? 'بالوزن (كغ)' : 'Weight (kg)']].map(([v, lbl]) => (
              <button key={v} type="button" onClick={() => setUnit(v)} style={{ ...S.btnGhost, flex: 1, padding: '10px', ...(unit === v ? { background: C.blue, color: '#fff', borderColor: C.blue } : {}) }}>{lbl}</button>
            ))}
          </div>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label={unit === 'kg' ? (ARABIC ? 'السعر / كغ' : 'Price / kg') : (ARABIC ? 'السعر' : 'Price')}><input style={S.input} type="number" step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label={ARABIC ? 'الكمية' : 'Stock'}><input style={S.input} type="number" step="0.001" value={stock} onChange={(e) => setStock(e.target.value)} /></Field>
        </div>
        <Field label={ARABIC ? 'التكلفة' : 'Cost'}><input style={S.input} type="number" step="0.001" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>

        {/* Category is required — an uncategorised product is unreachable on the Sales
            screen now that it browses by shelf. Pick an existing one or name a new one. */}
        <Field label={ARABIC ? 'الفئة (مطلوبة)' : 'Category (required)'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            {catOptions.map((c) => {
              const on = !newCat && cat === c;
              return (
                <button key={c} type="button" onClick={() => { setNewCat(false); setCat(c); }} style={{
                  ...S.btnGhost, padding: '8px 12px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 7,
                  ...(on ? { background: catColor(c), color: C.accentText, borderColor: catColor(c), fontWeight: 800 } : {}),
                }}>
                  {!on && <span style={{ width: 8, height: 8, borderRadius: 4, background: catColor(c), display: 'inline-block' }} />}
                  {c}
                </button>
              );
            })}
            <button type="button" onClick={() => { setNewCat(true); setCat(''); }} style={{
              ...S.btnGhost, padding: '8px 12px', fontSize: 13, borderStyle: 'dashed',
              ...(newCat ? { borderColor: C.accent, color: C.accent, fontWeight: 800 } : {}),
            }}>＋ {ARABIC ? 'فئة جديدة' : 'New category'}</button>
          </div>
          {newCat && (
            <input style={{ ...S.input, marginTop: 8 }} autoFocus value={cat} onChange={(e) => setCat(e.target.value)}
              placeholder={ARABIC ? 'اسم الفئة الجديدة' : 'New category name'} />
          )}
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button type="submit" disabled={busy} style={{ ...S.btn, flex: 1, opacity: busy ? 0.6 : 1 }}>{ARABIC ? 'حفظ' : 'Save'}</button>
          <button type="button" onClick={onClose} style={S.btnGhost}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </form>
    </Overlay>
  );
}

export default ProductModal;
export { ProductModal };
