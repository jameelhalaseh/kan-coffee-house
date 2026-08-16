// Notifications.
//
// The old one was a single coloured pill: the next message REPLACED the one before it, so a
// save that succeeded and a sync that failed a half-second apart left only the second on
// screen and the cashier never learned about the first. These stack instead, newest at the
// bottom, oldest pushed up and out.
//
// Three things a till notification has to do that a coloured pill does not:
//   1. Say what KIND of thing happened before it is read — the icon and the accent stripe do
//      that from across the counter, colour alone does not (and colour alone is invisible to
//      a colour-blind cashier).
//   2. Stay long enough for a failure and get out of the way for a success. A red one lives
//      more than twice as long as a green one, and can be dismissed the moment it is read.
//   3. Show its own clock. The bar draining along the bottom edge is how you know it is about
//      to go, rather than wondering whether you missed one.
import React from 'react';
import { C } from '../theme';
import { ARABIC } from '../client.config';

// How long each kind stays. A failure that vanishes in 2.6s is a failure nobody read.
export const TOAST_MS = { red: 6000, green: 3000, info: 4000 };
const MAX = 4;              // beyond this the oldest is dropped: a wall of toasts is noise

const KINDS = {
  red: { color: C.red, icon: '✕', label: ARABIC ? 'خطأ' : 'Error' },
  green: { color: C.green, icon: '✓', label: ARABIC ? 'تم' : 'Done' },
  info: { color: C.blue, icon: 'i', label: ARABIC ? 'ملاحظة' : 'Notice' },
};
export const toastKind = (k) => KINDS[k] || KINDS.info;
export const toastCap = (list) => (list.length > MAX ? list.slice(list.length - MAX) : list);

export default function Toasts({ items, onDismiss }) {
  if (!items.length) return null;
  return (
    <div
      // aria-live so a screen reader announces a message the user may not be looking at.
      // 'polite': a toast never interrupts what is being read mid-sentence.
      aria-live="polite"
      // Its own direction: the app shell is always dir="ltr" (the nav rail is positional), so
      // without this an Arabic message would sit under a stripe on the wrong edge.
      dir={ARABIC ? 'rtl' : 'ltr'}
      style={{
        position: 'fixed', bottom: 20, insetInlineEnd: 20, zIndex: 1000,
        display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end',
        pointerEvents: 'none',       // the page under the stack stays clickable
        maxWidth: 'min(420px, calc(100vw - 32px))',
      }}>
      {items.map((t) => {
        const k = toastKind(t.kind);
        return (
          <div key={t.id} className="toast-in" onClick={() => onDismiss(t.id)}
            role="status"
            style={{
              pointerEvents: 'auto', cursor: 'pointer', position: 'relative',
              display: 'flex', alignItems: 'flex-start', gap: 12,
              background: C.panel, color: C.text,
              border: `1px solid ${C.line}`,
              // The accent is a stripe on the leading edge, not the whole background: white
              // text on a saturated fill is loud in a dark shop and unreadable in a bright
              // one, and it leaves no room for a second colour to mean anything.
              borderInlineStartWidth: 4, borderInlineStartColor: k.color, borderInlineStartStyle: 'solid',
              borderRadius: 12, padding: '12px 14px', minWidth: 260,
              boxShadow: C.shadowLg, overflow: 'hidden',
            }}>
            <span style={{
              flex: '0 0 auto', width: 24, height: 24, borderRadius: 999,
              display: 'grid', placeItems: 'center',
              background: k.color, color: C.accentText,
              fontSize: 13, fontWeight: 900, lineHeight: 1,
            }}>{k.icon}</span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 10.5, fontWeight: 800, letterSpacing: 1,
                textTransform: 'uppercase', color: k.color, marginBottom: 3,
              }}>{k.label}</div>
              {/* Wraps. A long message truncated to one line is a message nobody can act on. */}
              <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>
                {t.msg}
              </div>
            </div>

            {/* The clock. Its duration is the same value the timer in App uses, so what you
                see draining is the actual time left, not a decorative animation. */}
            <span style={{
              position: 'absolute', bottom: 0, insetInlineStart: 0, height: 3,
              background: k.color, opacity: .55, width: '100%',
              animation: `toast-drain ${t.ms}ms linear both`,
            }} />
          </div>
        );
      })}
    </div>
  );
}
