// Small shared primitives. Deliberately dumb: layout and styling only, no data access, so
// any screen can use them without dragging state along.
import React from 'react';
import { C, S } from '../theme';
import { ARABIC } from '../client.config';

function Centered({ children }) {
  return <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg, color: C.dim, fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif" }}>{children}</div>;
}

// ── Customer-facing display (open ?display=1 on a 2nd screen) ────────────────────
// Mirrors the live cart from the Sales screen via BroadcastChannel (+ localStorage fallback).

const qtyBtn = { width: 42, height: 42, borderRadius: 9, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 22, lineHeight: '1', cursor: 'pointer', fontWeight: 700 };

// ── Numeric keypad (touch) — drives a numeric string field ──────────────────────
function NumPad({ onKey, onClear, onBackspace }) {
  const k = (label, fn, extra = {}) => (
    <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={fn}
      style={{ height: 56, borderRadius: 10, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 22, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', ...extra }}>{label}</button>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => k(d, () => onKey(d)))}
      {k('.', () => onKey('.'))}
      {k('0', () => onKey('0'))}
      {k('⌫', onBackspace, { background: C.red, color: '#fff' })}
      {k('C', onClear, { gridColumn: '1 / -1', background: C.line })}
    </div>
  );
}

// ── Edit a cart line: set quantity + override price via keypad ───────────────────

function Field({ label, children }) {
  return <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: C.dim, fontWeight: 700 }}>{label}{children}</label>;
}
function Overlay({ children, onClose }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 900, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV catalogue import (admin) — pick file → preview → confirm
// ══════════════════════════════════════════════════════════════════════════════
// The client never posts a file: src/csv.js parses and validates in the browser, the user
// sees exactly which lines are wrong, and only the valid rows are sent as JSON. The server
// re-validates everything and imports in one transaction.

const th = { padding: '6px 8px', fontWeight: 700, fontSize: 12 };
const td = { padding: '8px' };

function Stat({ label, value, accent }) {
  return (
    <div style={S.card}>
      <div style={{ color: C.dim, fontSize: 12, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4, color: accent ? C.accent : C.text }}>{value}</div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Settings — change password, (admin) users + categories
// ══════════════════════════════════════════════════════════════════════════════

export { Centered, Field, Overlay, NumPad, Stat, qtyBtn, th, td };
