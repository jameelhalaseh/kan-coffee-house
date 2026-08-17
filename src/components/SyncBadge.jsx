// The connection light on the till.
//
// A cashier has to be able to glance at one thing and know their sales are safe. Without it
// the offline queue is invisible: the till keeps taking money, the sales pile up locally,
// and nobody finds out until the totals do not match at cash-up — by which point the
// question "which sales are missing?" is being asked at midnight.
//
// So this is deliberately ALWAYS visible, which is not the usual rule for status chrome. A
// badge that is always on normally stops being read. The way it earns its place is by being
// quiet when things are fine — a small dot, muted colour, no motion — and loud only when
// there is something to do. Green is reassurance you can ignore; red is not ignorable.
//
// Tap it to retry immediately rather than waiting out the backoff.
import React, { useEffect, useState } from 'react';
import { C } from '../theme';
import { ARABIC } from '../client.config';
import { subscribe, getState, flush, deriveStatus, SYNCED, SYNCING, PENDING, OFFLINE, STALLED } from '../sync';

export function useSync() {
  const [s, setS] = useState(getState);
  useEffect(() => subscribe(setS), []);
  return s;
}

// Text lives here, not in sync.js: that module is pure logic and has no business knowing
// which language the shop runs in.
export function label(status, pending) {
  switch (status) {
    case SYNCING: return ARABIC ? 'جارٍ المزامنة…' : 'Syncing…';
    case OFFLINE: return pending
      ? (ARABIC ? `غير متزامن (${pending})` : `Not synced (${pending})`)
      : (ARABIC ? 'غير متصل' : 'Not connected');
    case PENDING: return ARABIC ? `بانتظار المزامنة (${pending})` : `Pending (${pending})`;
    // Names the action, not the state. By this point the till has stopped trying and the
    // only thing that changes anything is somebody tapping it.
    case STALLED: return pending === 1
      ? (ARABIC ? 'فشلت مزامنة فاتورة — اضغط' : 'Sale failed to sync — tap')
      : (ARABIC ? `فشلت مزامنة ${pending} فواتير — اضغط` : `${pending} sales failed to sync — tap`);
    default: return ARABIC ? 'متزامن' : 'Synced';
  }
}

const TONE = {
  [SYNCED]: { fg: C.green, dot: C.green },
  [SYNCING]: { fg: C.dim, dot: C.dim },
  [PENDING]: { fg: C.accent, dot: C.accent },
  [OFFLINE]: { fg: C.red, dot: C.red },
  [STALLED]: { fg: C.red, dot: C.red },
};

export default function SyncBadge() {
  const s = useSync();
  const status = deriveStatus(s);
  const tone = TONE[status] || TONE[SYNCED];
  const bad = status === OFFLINE || status === PENDING || status === STALLED;

  return (
    <button
      onClick={() => flush({ manual: true })}
      title={ARABIC ? 'اضغط لإعادة المحاولة الآن' : 'Tap to retry now'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        width: '100%', padding: '7px 10px', cursor: 'pointer',
        background: bad ? `${tone.fg}1a` : 'transparent',
        border: `1px solid ${bad ? tone.fg : C.line}`,
        borderRadius: 8, color: tone.fg,
        fontSize: 12, fontWeight: bad ? 800 : 600,
      }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: '50%', background: tone.dot, flex: '0 0 auto',
          // Only the syncing state moves. Motion on the resting state would make the thing
          // people are meant to stop noticing the most noticeable element on the screen.
          animation: status === SYNCING ? 'sync-pulse 1s ease-in-out infinite' : 'none',
        }}
      />
      <span>{label(status, s.pending)}</span>
    </button>
  );
}
