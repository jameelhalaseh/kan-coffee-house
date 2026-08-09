import React, { useState } from 'react';
import api from '../api';
import { S } from '../theme';
import { ARABIC } from '../client.config';
import { Overlay } from './ui';

function ChangePasswordModal({ onClose, notify }) {
  const [oldPw, setOld] = useState(''); const [newPw, setNew] = useState(''); const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (newPw.length < 8) { notify(ARABIC ? 'كلمة المرور 8 أحرف على الأقل' : 'Password must be 8+ chars', 'red'); return; }
    if (newPw !== confirm) { notify(ARABIC ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match', 'red'); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { old: oldPw, new: newPw });
      notify(ARABIC ? 'تم تغيير كلمة المرور' : 'Password changed', 'green');
      onClose();
    } catch (ex) {
      notify(ex.message === 'wrong_old' ? (ARABIC ? 'كلمة المرور الحالية خاطئة' : 'Current password wrong') : (ARABIC ? 'فشل' : 'Failed'), 'red');
    } finally { setBusy(false); }
  };
  return (
    <Overlay onClose={onClose}>
      <form onSubmit={submit} style={{ ...S.card, width: 340, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>🔑 {ARABIC ? 'تغيير كلمة المرور' : 'Change password'}</div>
        <input style={S.input} type="password" value={oldPw} onChange={(e) => setOld(e.target.value)} placeholder={ARABIC ? 'كلمة المرور الحالية' : 'Current password'} autoFocus />
        <input style={S.input} type="password" value={newPw} onChange={(e) => setNew(e.target.value)} placeholder={ARABIC ? 'كلمة مرور جديدة (8+)' : 'New password (8+)'} />
        <input style={S.input} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={ARABIC ? 'تأكيد كلمة المرور' : 'Confirm new password'} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" disabled={busy} style={{ ...S.btn, flex: 1, padding: '13px', opacity: busy ? 0.6 : 1 }}>{ARABIC ? 'حفظ' : 'Save'}</button>
          <button type="button" onClick={onClose} style={{ ...S.btnGhost, padding: '13px' }}>{ARABIC ? 'إلغاء' : 'Cancel'}</button>
        </div>
      </form>
    </Overlay>
  );
}

// Categories — chip manager: colored chips (same color identity as tiles), tap ✕ to
// remove, type + add. Saves immediately on every change.

export default ChangePasswordModal;
export { ChangePasswordModal };
