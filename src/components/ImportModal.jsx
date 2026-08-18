import React, { useState, useRef } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';
import { parseProductCsv, importTemplateCsv, MAX_IMPORT_ROWS } from '../csv';
import { Field, Overlay } from './ui';

function ImportModal({ onClose, onImported, notify }) {
  const [parsed, setParsed] = useState(null);     // { items, errors, error }
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState('upsert');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    try {
      setParsed(parseProductCsv(await file.text()));
    } catch (_) {
      setParsed({ items: [], errors: [], error: 'unreadable_file' });
    }
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([importTemplateCsv()], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'catalogue_template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  // File-level failures get a plain sentence; the raw code is useless to a shopkeeper.
  const fileError = (code) => {
    if (!code) return null;
    if (code === 'empty_file') return ARABIC ? 'الملف فارغ' : 'That file is empty';
    if (code === 'unreadable_file') return ARABIC ? 'تعذّر قراءة الملف' : 'That file could not be read';
    if (code.startsWith('missing_column:')) {
      const cols = code.split(':')[1];
      return ARABIC ? `عمود مفقود: ${cols}` : `Missing required column: ${cols}`;
    }
    if (code.startsWith('too_many_rows:')) {
      return ARABIC ? `صفوف أكثر من الحد (${MAX_IMPORT_ROWS})` : `Too many rows — the limit is ${MAX_IMPORT_ROWS}`;
    }
    return ARABIC ? 'ملف غير صالح' : 'Invalid file';
  };

  const run = async () => {
    if (!parsed || !parsed.items.length) return;
    setBusy(true);
    try {
      // `line` is a UI-only field for error reporting — strip it before sending.
      const items = parsed.items.map(({ line, ...rest }) => rest);
      const r = await api.post('/products/import', { items, mode });
      notify(ARABIC
        ? `تم الاستيراد: ${r.created} جديد، ${r.updated} محدّث`
        : `Imported ${r.created} new, ${r.updated} updated`, 'green');
      onImported();
    } catch (ex) {
      notify(ex.message === 'not_admin' ? (ARABIC ? 'الاستيراد يتطلب صلاحية مدير' : 'Import needs an admin')
        : ex.message === 'exists' ? (ARABIC ? 'باركود مكرر في الملف' : 'A barcode in this file already exists')
        : ex.message === 'too_many_rows' ? (ARABIC ? 'عدد الصفوف كبير جداً' : 'Too many rows')
        : (ARABIC ? 'فشل الاستيراد — لم يتغيّر شيء' : 'Import failed — nothing was changed'), 'red');
    } finally { setBusy(false); }
  };

  const err = parsed && fileError(parsed.error);

  return (
    <Overlay onClose={busy ? () => {} : onClose}>
      <div style={{ ...S.card, width: 460, maxWidth: '92vw', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>{ARABIC ? 'استيراد كتالوج (CSV)' : 'Import catalogue (CSV)'}</div>

        <div style={{ fontSize: 13, color: C.dim, lineHeight: 1.5 }}>
          {ARABIC
            ? 'الأعمدة: barcode, name, price, cost, stock, cat, size, low_at, active — الاسم فقط إلزامي.'
            : 'Columns: barcode, name, price, cost, stock, cat, size, low_at, active — only name is required.'}
          {' '}
          <button type="button" onClick={downloadTemplate}
            style={{ background: 'none', border: 'none', padding: 0, color: C.accent, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, textDecoration: 'underline' }}>
            {ARABIC ? 'تنزيل نموذج' : 'Download template'}
          </button>
        </div>

        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={pick} style={{ display: 'none' }} />
        <button type="button" onClick={() => fileRef.current && fileRef.current.click()} style={{ ...S.btnGhost, padding: '14px', borderStyle: 'dashed' }}>
          {fileName || (ARABIC ? '📁 اختر ملف CSV' : '📁 Choose a CSV file')}
        </button>

        {err && (
          <div style={{ ...S.card, background: 'transparent', borderColor: C.red, color: C.red, fontSize: 13, padding: 12 }}>{err}</div>
        )}

        {parsed && !parsed.error && (
          <>
            <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
              <span style={{ color: C.green, fontWeight: 800 }}>
                {parsed.items.length} {ARABIC ? 'صف صالح' : 'valid'}
              </span>
              {parsed.errors.length > 0 && (
                <span style={{ color: C.red, fontWeight: 800 }}>
                  {parsed.errors.length} {ARABIC ? 'صف به خطأ (سيتم تجاهله)' : 'with errors (skipped)'}
                </span>
              )}
            </div>

            {parsed.errors.length > 0 && (
              <div style={{ maxHeight: 130, overflowY: 'auto', fontSize: 12, color: C.dim, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {parsed.errors.slice(0, 50).map((e) => (
                  <div key={e.line}><b style={{ color: C.red }}>{ARABIC ? 'سطر' : 'Line'} {e.line}</b> — {e.message}</div>
                ))}
                {parsed.errors.length > 50 && <div>… {parsed.errors.length - 50} {ARABIC ? 'أخرى' : 'more'}</div>}
              </div>
            )}

            <Field label={ARABIC ? 'الصفوف ذات الرمز الموجود' : 'Rows whose SKU already exists'}>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['upsert', ARABIC ? 'تحديث' : 'Update them'], ['insert', ARABIC ? 'رفض الملف' : 'Reject the file']].map(([v, lbl]) => (
                  <button key={v} type="button" onClick={() => setMode(v)} style={{ ...S.btnGhost, flex: 1, padding: '10px', ...(mode === v ? { background: C.blue, color: '#fff', borderColor: C.blue } : {}) }}>{lbl}</button>
                ))}
              </div>
            </Field>

            {/* Overwriting prices across the whole catalogue is the point of this screen,
                so say it out loud before the button is pressed. */}
            {mode === 'upsert' && parsed.items.length > 0 && (
              <div style={{ fontSize: 12, color: C.dim }}>
                {ARABIC
                  ? 'سيتم استبدال السعر والتكلفة والمخزون للمنتجات المطابقة.'
                  : 'Price, cost and stock will be overwritten for matching products.'}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="button" onClick={run} disabled={busy || !parsed || !!parsed.error || !parsed.items.length}
            style={{ ...S.btn, flex: 1, opacity: (busy || !parsed || !!parsed.error || !parsed.items.length) ? 0.5 : 1 }}>
            {busy ? (ARABIC ? 'جارٍ الاستيراد…' : 'Importing…')
              : parsed && parsed.items.length ? (ARABIC ? `استيراد ${parsed.items.length}` : `Import ${parsed.items.length}`)
              : (ARABIC ? 'استيراد' : 'Import')}
          </button>
          <button type="button" onClick={onClose} disabled={busy} style={S.btnGhost}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </div>
    </Overlay>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Inventory
// ══════════════════════════════════════════════════════════════════════════════

export default ImportModal;
export { ImportModal };
