import React, { useState, useEffect, useRef } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { catColor } from '../lib';
import { Field, Overlay } from './ui';
import normalizeCategoryImage from '../imageNormalize';
import {
  productArtFor, refreshProductArt, loadProductArt, productArtLoaded, subscribe as subscribeProductArt,
} from '../productArt';

// The shelf's usual bottles. Not an enum — see the free-text box beside them.
const SIZE_PRESETS = ['500ml', '750ml', '1L'];

// ── This product's own picture ────────────────────────────────────────────────
// Inline in the product form rather than its own modal: the category version is a modal
// because it is reached from a list of categories with nothing else to edit, whereas this is
// one more field on a product you already have open. A modal inside a modal would be worse.
//
// Only rendered for a product that already EXISTS and only for an admin — an image needs an
// id to hang on, and the tile is what a barista aims at, so whoever controls the picture
// controls which product gets rung up. That is the same reasoning that makes pricing
// admin-only in routes/products.js.
function ProductImageField({ productId, notify }) {
  const [preview, setPreview] = useState(null);   // { dataUrl, hasTransparency, bytes }
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const fileRef = useRef(null);

  useEffect(() => {
    const off = subscribeProductArt(() => bump((n) => n + 1));
    if (!productArtLoaded()) loadProductArt();
    return off;
  }, []);

  const current = productArtFor(productId);
  const shown = (preview && preview.dataUrl) || current;

  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      // The same normaliser the category tiles use: trims to the subject, scales it to a
      // consistent size and centres it on a 512x512 transparent canvas. The shop never picks
      // a size or a format, so it cannot produce one that the server will reject.
      setPreview(await normalizeCategoryImage(file));
    } catch (ex) {
      const msg = {
        not_an_image: ARABIC ? 'الملف ليس صورة' : 'That file is not an image',
        source_too_large: ARABIC ? 'الصورة كبيرة جداً' : 'That image is too large',
        blank: ARABIC ? 'الصورة فارغة' : 'That image is empty',
      }[ex.message] || (ARABIC ? 'تعذّر قراءة الصورة' : 'Could not read that image');
      notify(msg, 'red');
    } finally { setBusy(false); }
  };

  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await api.put(`/product-images/${productId}`, { data: preview.dataUrl });
      await refreshProductArt(productId);
      setPreview(null);
      notify(ARABIC ? 'تم حفظ الصورة' : 'Image saved', 'green');
    } catch (ex) {
      notify(ex.message === 'too_large' ? (ARABIC ? 'الصورة كبيرة جداً' : 'Image too large')
        : (ARABIC ? 'فشل الحفظ' : 'Save failed'), 'red');
    } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(`/product-images/${productId}`);
      await refreshProductArt(productId);
      setPreview(null);
      notify(ARABIC ? 'تمت إزالة الصورة' : 'Image removed', 'green');
    } catch (_) { notify(ARABIC ? 'فشل' : 'Failed', 'red'); } finally { setBusy(false); }
  };

  return (
    <Field label={ARABIC ? 'صورة المنتج' : 'Product picture'}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        {/* Previewed on the same gradient the real tile uses, so a picture that will look
            wrong on the shelf looks wrong here too. */}
        <div style={{
          flex: '0 0 96px', height: 96, borderRadius: 12, border: `1px solid ${C.line}`,
          background: `linear-gradient(180deg, ${catColor('x', 0.10)} 0%, ${C.panel2} 55%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        }}>
          {shown
            ? <img src={shown} alt="" style={{ maxWidth: '86%', maxHeight: '86%', objectFit: 'contain' }} />
            : <span style={{ fontSize: 26, opacity: .4 }}>🖼</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
            onChange={(e) => { pick(e.target.files && e.target.files[0]); e.target.value = ''; }} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}
              style={{ ...S.btnGhost, padding: '8px 12px', fontSize: 13 }}>
              {ARABIC ? 'اختر صورة' : 'Choose image'}
            </button>
            {preview && (
              <button type="button" disabled={busy} onClick={save}
                style={{ ...S.btn, padding: '8px 14px', fontSize: 13 }}>
                {ARABIC ? 'حفظ الصورة' : 'Save picture'}
              </button>
            )}
            {current && !preview && (
              <button type="button" disabled={busy} onClick={remove}
                style={{ ...S.btnGhost, padding: '8px 12px', fontSize: 13, borderColor: C.red, color: C.red }}>
                {ARABIC ? 'إزالة' : 'Remove'}
              </button>
            )}
          </div>
          {/* THE WARNING THAT MATTERS. The tile is a colour gradient, so a picture that still
              has its own background lands on it as a rectangular block. The browser cannot
              cut a background out — but it can say so before the shop saves 44 of them. */}
          {preview && !preview.hasTransparency && (
            <div style={{ fontSize: 12, color: C.accent, lineHeight: 1.45 }}>
              {ARABIC
                ? 'هذه الصورة لا تحتوي على خلفية شفافة، وستظهر كمستطيل على البطاقة. استخدم صورة PNG بخلفية مزالة.'
                : 'This image has no transparent background, so it will show as a rectangle on the tile. Use a cut-out PNG.'}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: C.dim }}>
            {ARABIC ? 'يُحوَّل تلقائياً إلى 512×512 PNG شفاف.' : 'Normalised automatically to a 512×512 transparent PNG.'}
          </div>
        </div>
      </div>
    </Field>
  );
}

function ProductModal({ initial, onClose, onSaved, notify, editing, isAdmin }) {
  const [barcode, setBarcode] = useState(initial.barcode || '');
  const [name, setName] = useState(initial.name || '');
  const [price, setPrice] = useState(initial.price != null ? String(initial.price) : '');
  const [cat, setCat] = useState(initial.cat || '');
  const [stock, setStock] = useState(initial.stock != null ? String(initial.stock) : '');
  const [cost, setCost] = useState(initial.cost != null ? String(initial.cost) : '');
  const [size, setSize] = useState(initial.size || '');
  const [lowAt, setLowAt] = useState(initial.low_at != null ? String(initial.low_at) : '5');
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
    // unit is pinned to 'ea': an off-licence sells bottles, not weight. The column and the
    // kg checkout path stay for any legacy weighed row, but this form no longer creates one.
    const body = {
      barcode: barcode.trim() || null, name: name.trim(), price: Number(price) || 0,
      cat: cat.trim(), cost: Number(cost) || 0, stock: Number(stock) || 0, unit: 'ea',
      size: size.trim() || null, low_at: Number(lowAt) >= 0 ? Number(lowAt) : 5,
    };
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
      notify(ex.message === 'exists' ? (ARABIC ? 'رمز مكرر' : 'That SKU already exists')
        : ex.message === 'admin_only' ? (ARABIC ? 'تعديل السعر يتطلب صلاحية مدير' : 'Price changes need an admin')
        : (ARABIC ? 'فشل الحفظ' : 'Save failed'), 'red');
    } finally { setBusy(false); }
  };

  return (
    <Overlay onClose={onClose}>
      <form onSubmit={save} style={{ ...S.card, width: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{editing ? (ARABIC ? 'تعديل منتج' : 'Edit product') : (ARABIC ? 'منتج جديد' : 'New product')}</div>
        <Field label={ARABIC ? 'الرمز (SKU)' : 'SKU'}><input style={S.input} value={barcode} onChange={(e) => setBarcode(e.target.value)} /></Field>
        <Field label={ARABIC ? 'الاسم' : 'Name'}><input ref={nameRef} style={S.input} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        {/* Size, not weight. The presets are the shelf's common bottles; the box below takes
            anything else (1.75L, 200ml, a 6-pack) because an off-licence always has one. Blank
            is fine — a size is a label, and nothing computes with it. */}
        <Field label={ARABIC ? 'الحجم (اختياري)' : 'Size (optional)'}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
            {SIZE_PRESETS.map((v) => {
              const on = size.trim().toLowerCase() === v.toLowerCase();
              return (
                <button key={v} type="button" onClick={() => setSize(on ? '' : v)} style={{
                  ...S.btnGhost, padding: '8px 14px', fontSize: 13,
                  ...(on ? { background: C.blue, color: '#fff', borderColor: C.blue, fontWeight: 800 } : {}),
                }}>{v}</button>
              );
            })}
          </div>
          <input style={{ ...S.input, marginTop: 8 }} value={size} onChange={(e) => setSize(e.target.value)}
            placeholder={ARABIC ? 'أو اكتب حجماً آخر' : 'or type another size'} maxLength={24} />
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label={ARABIC ? 'السعر' : 'Price'}><input style={S.input} type="number" step="0.001" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
          <Field label={ARABIC ? 'الكمية' : 'Stock'}><input style={S.input} type="number" step="0.001" value={stock} onChange={(e) => setStock(e.target.value)} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label={ARABIC ? 'التكلفة' : 'Cost'}><input style={S.input} type="number" step="0.001" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>
          {/* The reorder point, per product. It used to be a hard-coded 5 for the whole shop,
              which warns too late on a fast-moving crate and nags forever on a slow bottle. */}
          <Field label={ARABIC ? 'تنبيه عند' : 'Low at'}>
            <input style={S.input} type="number" step="1" min="0" value={lowAt}
              onChange={(e) => setLowAt(e.target.value)} />
          </Field>
        </div>

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
        {/* Needs an id to attach to, so it only appears once the product exists — a quick-add
            from the till has nothing to hang a picture on yet. Saved independently of the
            form's own Save, because it is a separate request to a separate endpoint and
            pretending otherwise would mean one button that half-fails. */}
        {editing && isAdmin && initial.id && (
          <ProductImageField productId={initial.id} notify={notify} />
        )}
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
