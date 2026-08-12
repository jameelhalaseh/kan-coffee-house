// Theme tokens + base control styles.
//
// TWO THEMES: night (the original dark counter look) and day (light, for a shop with a window
// behind the till or a manager working on the reports in daylight).
//
// WHY THE SWITCH RELOADS THE PAGE
// C and S are plain objects read at import time, and ~370 call sites use them — including
// several that build a style constant at MODULE scope (StoreReportsView's TOTAL_ROW,
// ui.jsx's qtyBtn, AssistantView's row styles). Those are evaluated once, when the module is
// first imported, and a React context swap would never re-run them: half the app would turn
// light and the other half would stay dark, which is worse than not having the feature.
//
// So the theme is chosen HERE, at import, and switching persists the choice and reloads —
// exactly the pattern setLang() already uses for the AR/EN toggle in this codebase. A till
// changes theme roughly never; correctness is worth more than avoiding one reload.
const THEME_KEY = 'liquor_store_theme';

const PALETTES = {
  // The original. Unchanged, so nothing about the night look shifts by adding a day one.
  night: {
    bg: '#0f1117', panel: '#1a1c25', panel2: '#22252f', line: '#2c2f3a',
    text: '#e6e6e6', dim: '#9aa0aa', accent: '#f0a830', accentText: '#0f1117',
    green: '#3ecf8e', red: '#ff6b6b', blue: '#5b9dff',
    scrollThumb: '#2c2f3a', scrollThumbHover: '#3a3e4d',
  },
  // Day. Not the night palette inverted: the status colours are darkened until they carry
  // enough contrast on white (#3ecf8e on white is ~1.9:1 — unreadable), and the accent gold
  // keeps dark text on it, as it does on the night theme.
  day: {
    bg: '#f2f4f7', panel: '#ffffff', panel2: '#eef1f5', line: '#d6dae1',
    text: '#161922', dim: '#5b6472', accent: '#e09a22', accentText: '#161922',
    green: '#17915f', red: '#c0392b', blue: '#2b6cb0',
    scrollThumb: '#c3c9d2', scrollThumbHover: '#a8b0bc',
  },
};

const THEMES = Object.keys(PALETTES);

// First run follows the operating system, then the shop's explicit choice wins for good.
function initialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && THEMES.includes(saved)) return saved;
  } catch (_) { /* private mode: fall through to the OS preference */ }
  try {
    if (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: light)').matches) return 'day';
  } catch (_) { /* no matchMedia: fall through to night */ }
  return 'night';
}

export const THEME = initialTheme();
export const IS_DAY = THEME === 'day';

export const C = {
  ...PALETTES[THEME],
  // Elevation. A shadow tuned for dark panels (55% black) reads as a smudge on a white one,
  // because on dark it is mostly invisible and on light it is the strongest thing on screen.
  // Day gets a shorter, much lighter drop.
  shadow: THEME === 'day' ? '0 8px 24px rgba(19,24,38,.14)' : '0 12px 40px rgba(0,0,0,.55)',
  shadowLg: THEME === 'day' ? '0 18px 44px rgba(19,24,38,.20)' : '0 24px 60px rgba(0,0,0,.55)',
};

// Paint the document chrome to match: the <body> background and the scrollbars live in
// public/index.html as CSS variables, and the PWA title bar reads <meta name="theme-color">.
// Without this the app would sit on a dark page frame in day mode.
if (typeof document !== 'undefined') {
  const root = document.documentElement;
  root.dataset.theme = THEME;
  root.style.setProperty('--bg', C.bg);
  root.style.setProperty('--text', C.text);
  root.style.setProperty('--accent', C.accent);
  root.style.setProperty('--scroll-thumb', C.scrollThumb);
  root.style.setProperty('--scroll-thumb-hover', C.scrollThumbHover);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', C.bg);
}

export function setTheme(t) {
  const next = THEMES.includes(t) ? t : 'night';
  try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* nothing to do but proceed */ }
  // See the note at the top: a reload is what makes the module-scope styles correct.
  if (typeof window !== 'undefined') window.location.reload();
}

export function toggleTheme() { setTheme(IS_DAY ? 'night' : 'day'); }

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
