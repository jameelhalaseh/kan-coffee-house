// Shared dark theme tokens + base control styles (extracted from App.jsx so other
// views can import them without a circular App dependency).
export const C = {
  bg: '#0f1117', panel: '#1a1c25', panel2: '#22252f', line: '#2c2f3a',
  text: '#e6e6e6', dim: '#9aa0aa', accent: '#f0a830', accentText: '#0f1117',
  green: '#3ecf8e', red: '#ff6b6b', blue: '#5b9dff',
};

export const S = {
  btn: { padding: '10px 16px', borderRadius: 9, border: 'none', background: C.accent, color: C.accentText, fontWeight: 700, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit' },
  btnGhost: { padding: '9px 14px', borderRadius: 9, border: `1px solid ${C.line}`, background: 'transparent', color: C.text, fontWeight: 600, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  input: { padding: '10px 12px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel2, color: C.text, fontSize: 14, fontFamily: 'inherit', outline: 'none', width: '100%', boxSizing: 'border-box' },
  card: { background: C.panel, borderRadius: 12, border: `1px solid ${C.line}`, padding: 16 },

  // Actions that live inside a table row (Print, Return, Edit, Del). These were 5–6px of
  // vertical padding — roughly 26px tall — against the 44px minimum a fingertip needs. On a
  // counter touchscreen with a customer waiting, that undersize is the main source of
  // mis-taps, and a mis-tap on "Return" is a refund dialog you have to back out of.
  btnRow: {
    minHeight: 44, minWidth: 44, padding: '0 16px',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 9, border: `1px solid ${C.line}`, background: 'transparent',
    color: C.text, fontWeight: 600, fontSize: 14, cursor: 'pointer', fontFamily: 'inherit',
  },
};
