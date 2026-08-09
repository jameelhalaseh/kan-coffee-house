import React, { useState, useEffect } from 'react';
import { C } from '../theme';
import { ARABIC, STORE_NAME } from '../client.config';
import { money } from '../lib';
import { BC_NAME, DISPLAY_KEY } from '../constants';

function CustomerDisplay() {
  const [state, setState] = useState(() => { try { return JSON.parse(localStorage.getItem(DISPLAY_KEY)) || null; } catch (_) { return null; } });
  useEffect(() => {
    let bc;
    try { bc = new BroadcastChannel(BC_NAME); bc.onmessage = (e) => setState(e.data); } catch (_) {}
    const onStorage = (e) => { if (e.key === 'dukkan_display' && e.newValue) { try { setState(JSON.parse(e.newValue)); } catch (_) {} } };
    window.addEventListener('storage', onStorage);
    return () => { if (bc) bc.close(); window.removeEventListener('storage', onStorage); };
  }, []);
  const items = (state && state.items) || [];
  const total = (state && state.total) || 0;
  return (
    <div dir={ARABIC ? 'rtl' : 'ltr'} style={{ minHeight: '100vh', background: C.bg, color: C.text, fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif", display: 'flex', flexDirection: 'column', padding: 28 }}>
      <div style={{ fontWeight: 800, fontSize: 40, color: C.accent, textAlign: 'center', marginBottom: 18 }}>{STORE_NAME}</div>
      <div style={{ flex: 1, overflow: 'auto', maxWidth: 720, width: '100%', margin: '0 auto' }}>
        {!items.length && <div style={{ color: C.dim, fontSize: 26, textAlign: 'center', marginTop: 80 }}>{ARABIC ? 'أهلاً بك' : 'Welcome'}</div>}
        {items.map((l, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0', borderBottom: `1px solid ${C.line}`, fontSize: 26 }}>
            <span>{l.name} <span style={{ color: C.dim, fontSize: 20 }}>× {l.qty}</span></span>
            <span style={{ fontWeight: 700 }}>{money(l.price * l.qty)}</span>
          </div>
        ))}
      </div>
      <div style={{ maxWidth: 720, width: '100%', margin: '0 auto', borderTop: `2px solid ${C.accent}`, paddingTop: 16, display: 'flex', justifyContent: 'space-between', fontSize: 48, fontWeight: 800 }}>
        <span>{ARABIC ? 'المجموع' : 'Total'}</span><span style={{ color: C.accent }}>{money(total)}</span>
      </div>
      {state && state.change != null && state.change >= 0 && (
        <div style={{ maxWidth: 720, width: '100%', margin: '6px auto 0', display: 'flex', justifyContent: 'space-between', fontSize: 30, color: C.green, fontWeight: 700 }}>
          <span>{ARABIC ? 'الباقي' : 'Change'}</span><span>{money(state.change)}</span>
        </div>
      )}
    </div>
  );
}


export default CustomerDisplay;
export { CustomerDisplay };
