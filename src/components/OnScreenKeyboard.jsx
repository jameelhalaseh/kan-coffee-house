import React, { useState } from 'react';
import { C } from '../theme';
import { ARABIC } from '../client.config';

function OnScreenKeyboard({ onKey, onBackspace, onEnter, onClose }) {
  const [mode, setMode] = useState('num');   // 'num' (default) | 'abc'
  const [caps, setCaps] = useState(false);
  const key = (label, onTap, flex = 1, extra = {}) => (
    <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={onTap}
      style={{ flex, minWidth: 0, height: 56, borderRadius: 10, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 20, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', userSelect: 'none', ...extra }}>
      {label}
    </button>
  );
  const toggleKey = key(mode === 'num' ? 'ABC' : '123', () => setMode((m) => (m === 'num' ? 'abc' : 'num')), 1.4, { background: C.blue, color: '#fff', fontSize: 16 });
  const bottomRow = (
    <div style={{ display: 'flex', gap: 8 }}>
      {key(ARABIC ? 'إغلاق' : 'Hide', onClose, 1.4, { fontSize: 15 })}
      {key('␣', () => onKey(' '), 4)}
      {key(ARABIC ? 'دخول' : 'Enter', onEnter, 2, { background: C.green, color: C.accentText, fontSize: 16 })}
    </div>
  );

  if (mode === 'num') {
    const cell = (ch) => key(ch, () => onKey(ch));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
        {[['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']].map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8 }}>{r.map(cell)}</div>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          {toggleKey}
          {cell('0')}
          {key('⌫', onBackspace, 1.4, { background: C.red, color: '#fff' })}
        </div>
        {bottomRow}
      </div>
    );
  }

  const rows = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['z', 'x', 'c', 'v', 'b', 'n', 'm', '.', '_', '@'],
  ];
  const cell = (ch) => key(caps ? ch.toUpperCase() : ch, () => onKey(caps ? ch.toUpperCase() : ch));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8 }}>
          {i === 3 && key(caps ? '⇧' : '⇪', () => setCaps((c) => !c), 1.4, caps ? { background: C.accent, color: C.accentText } : {})}
          {r.map(cell)}
          {i === 3 && key('⌫', onBackspace, 1.4, { background: C.red, color: '#fff' })}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        {toggleKey}
        {key('␣', () => onKey(' '), 4)}
        {key(ARABIC ? 'دخول' : 'Enter', onEnter, 2, { background: C.green, color: C.accentText, fontSize: 16 })}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Login
// ══════════════════════════════════════════════════════════════════════════════

export default OnScreenKeyboard;
export { OnScreenKeyboard };
