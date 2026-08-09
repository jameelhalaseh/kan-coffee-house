import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { Field } from '../components/ui';

// Receiving is the only legitimate way stock goes UP. No expiry field: a liquor store's
// stock does not date-expire, and a control staff must skip on every delivery is a control
// they learn to ignore.
function ReceiveView({ notify }) {
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [batches, setBatches] = useState([]);
  const [form, setForm] = useState({ product_id: '', supplier_id: '', qty: '', cost: '' });
  const [newSup, setNewSup] = useState({ name: '', phone: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/products').then(setProducts).catch(() => {});
    api.get('/suppliers').then(setSuppliers).catch(() => {});
    api.get('/batches').then(setBatches).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const receive = async () => {
    if (!form.product_id || !(Number(form.qty) > 0)) { notify(ARABIC ? 'اختر المنتج والكمية' : 'Pick product + qty', 'red'); return; }
    setBusy(true);
    try {
      await api.post('/batches', { product_id: Number(form.product_id), supplier_id: form.supplier_id ? Number(form.supplier_id) : null, qty: Number(form.qty), cost: Number(form.cost) || 0 });
      setForm({ product_id: '', supplier_id: '', qty: '', cost: '' });
      load();
      notify(ARABIC ? 'تم استلام البضاعة' : 'Stock received', 'green');
    } catch (_) { notify(ARABIC ? 'فشل' : 'Failed', 'red'); } finally { setBusy(false); }
  };
  const addSupplier = async () => {
    if (!newSup.name.trim()) return;
    try { await api.post('/suppliers', newSup); setNewSup({ name: '', phone: '' }); api.get('/suppliers').then(setSuppliers); notify(ARABIC ? 'تمت إضافة المورّد' : 'Supplier added', 'green'); }
    catch (ex) {
      // Name it, rather than a bare "Failed" against a list where the existing row is
      // already visible two inches below the input.
      notify(ex.message === 'exists'
        ? (ARABIC ? 'المورّد موجود مسبقاً' : 'That supplier already exists')
        : (ARABIC ? 'فشل' : 'Failed'), 'red');
    }
  };

  const sel = { ...S.input, appearance: 'auto' };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
      <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>📥 {ARABIC ? 'استلام بضاعة' : 'Receive stock'}</div>
        <Field label={ARABIC ? 'المنتج' : 'Product'}>
          <select style={sel} value={form.product_id} onChange={(e) => setForm({ ...form, product_id: e.target.value })}>
            <option value="">{ARABIC ? '— اختر —' : '— select —'}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label={ARABIC ? 'المورّد' : 'Supplier'}>
          <select style={sel} value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}>
            <option value="">{ARABIC ? '— بدون —' : '— none —'}</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 10 }}>
          <Field label={ARABIC ? 'الكمية' : 'Quantity'}><input style={S.input} type="number" step="0.001" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></Field>
          <Field label={ARABIC ? 'التكلفة/وحدة' : 'Cost/unit'}><input style={S.input} type="number" step="0.001" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></Field>
        </div>
        <button onClick={receive} disabled={busy} style={{ ...S.btn, padding: '14px', fontSize: 16, opacity: busy ? 0.6 : 1 }}>{ARABIC ? '＋ استلام وتحديث المخزون' : '＋ Receive & add to stock'}</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ ...S.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>🏷 {ARABIC ? 'الموردون' : 'Suppliers'}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={S.input} value={newSup.name} onChange={(e) => setNewSup({ ...newSup, name: e.target.value })} placeholder={ARABIC ? 'اسم المورّد' : 'Supplier name'} />
            <input style={{ ...S.input, maxWidth: 130 }} value={newSup.phone} onChange={(e) => setNewSup({ ...newSup, phone: e.target.value })} placeholder={ARABIC ? 'هاتف' : 'Phone'} />
            <button onClick={addSupplier} style={S.btn}>＋</button>
          </div>
          {suppliers.map((s) => (
            <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${C.line}`, fontSize: 14 }}>
              <span>{s.name}</span><span style={{ color: C.dim }}>{s.phone || ''}</span>
            </div>
          ))}
          {!suppliers.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا موردين' : 'No suppliers'}</div>}
        </div>

        <div style={{ ...S.card }}>
          <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 8 }}>{ARABIC ? 'آخر الاستلامات' : 'Recent receipts'}</div>
          {batches.slice(0, 12).map((b) => (
            <div key={b.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderTop: `1px solid ${C.line}`, fontSize: 13 }}>
              <span>{b.product} <span style={{ color: C.dim }}>×{Number(b.qty)}</span></span>
              <span style={{ color: C.dim }}>{b.supplier || '—'}</span>
            </div>
          ))}
          {!batches.length && <div style={{ color: C.dim, fontSize: 13 }}>{ARABIC ? 'لا شيء بعد' : 'Nothing yet'}</div>}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// History
// ══════════════════════════════════════════════════════════════════════════════
// "2026-08-08" → "Sat 8 Aug 2026" / "السبت ٨ أغسطس ٢٠٢٦". Day-name first: when someone is
// hunting a receipt they remember the day of the week, not the date.

export default ReceiveView;
export { ReceiveView };
