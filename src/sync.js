// Offline sales queue + connection state, for the whole app.
//
// This used to live inside SalesView, which had three consequences worth naming:
//
//   1. A cashier on History or Inventory could not see that sales were queued. The only
//      indicator was a button on the sales screen.
//   2. Retries fired on the browser's `online` event only. If the shop's wifi never dropped
//      but the SERVER was down — the likelier outage, and the one that lasts longer — that
//      event never fires, so queued sales sat there until somebody reloaded or tapped retry.
//   3. "Connected" was navigator.onLine, which reports whether the device has a network
//      interface, not whether our server is reachable. A router with no uplink reports
//      online. So did a dead VPS. The till claimed it was fine while nothing was going
//      through, which is the one lie a POS must not tell.
//
// Reachability here is therefore derived from what actually happens to requests: api.js
// reports every outcome, and a response — even a 500 — proves the server is there. Only a
// fetch that never completed means unreachable.
import api from './api';
import { PENDING_KEY } from './constants';

export const SYNCED = 'synced';     // queue empty AND the server is answering
export const SYNCING = 'syncing';   // actively flushing
export const PENDING = 'pending';   // queued, server reachable, waiting its turn
export const OFFLINE = 'offline';   // the server is not answering
export const STALLED = 'stalled';   // gave up retrying; a person has to intervene

// Backoff between automatic retries. Short at first because most outages are a few seconds
// of flaky wifi, then longer so a server that is genuinely down is not hammered by thirty
// tills at once. Capped: a till must never stop trying entirely.
export const RETRY_MS = [5000, 10000, 30000, 60000, 120000];
export const nextDelay = (attempt) => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];

// After this many consecutive failed flushes the till stops trying by itself.
//
// The cap is not about sparing the server — the backoff already does that. It is about the
// silent failure underneath: a sale the server keeps refusing (a 400 it will refuse forever,
// a row it will not accept) sits at the head of the queue and blocks every sale behind it,
// retrying every two minutes until closing time with nothing on screen that says anyone
// needs to look. Ten attempts is roughly fifteen minutes of backoff — long enough that no
// ordinary outage reaches it, short enough that a shop finds out during the shift rather
// than at cash-up.
//
// Stopping does NOT discard anything. The queue stays on disk, the badge turns red and says
// so, and tapping it starts over. That is the whole intervention.
export const MAX_ATTEMPTS = 10;

// The single rule for what the badge shows. Order matters and is the whole point:
// unreachable outranks a count, because an empty queue with a dead server is NOT "synced" —
// it is idle and disconnected, and showing green there would be the worst lie available.
export function deriveStatus({ pending, syncing, reachable, stalled }) {
  if (syncing) return SYNCING;
  // Outranks everything except an in-flight attempt: this is the one state the till will not
  // leave on its own, so it must not be dressed up as an outage that might still clear.
  if (stalled && pending > 0) return STALLED;
  if (reachable === false) return OFFLINE;
  if (pending > 0) return PENDING;
  return SYNCED;
}

export const readPending = () => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (_) { return []; }
};
const writePending = (list) => {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch (_) {}
};

// ── Store ────────────────────────────────────────────────────────────────────
// A module-level store with subscribers rather than a state library: this is the app's only
// genuinely global state, and it has to be writable from a plain module (api.js reporting a
// network result) as well as from components.
let state = {
  pending: readPending().length,
  syncing: false,
  // null until the first request tells us something. Not `true`: assuming a healthy server
  // before any evidence would flash a green "Synced" on a till that cannot reach anything.
  reachable: null,
  syncedTick: 0,        // bumps when a flush lands, so views can react once per flush
  lastSyncedCount: 0,
  // Automatic retries have been given up on; only a person restarts them. Separate from
  // `reachable` because the two are independent: a stalled queue usually sits in FRONT of a
  // server that is answering perfectly well and simply refusing one sale.
  stalled: false,
  stalledTick: 0,       // bumps once per stall, so the shell can raise exactly one alert
};

const listeners = new Set();
export const getState = () => state;
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function set(patch) {
  const next = { ...state, ...patch };
  // Skip the notify when nothing actually moved; every subscriber is a React re-render.
  const same = Object.keys(next).every((k) => next[k] === state[k]);
  if (same) return;
  state = next;
  listeners.forEach((fn) => { try { fn(state); } catch (_) {} });
}

// Called by api.js for every request outcome. `answered` is true when the server responded
// at all, including 4xx and 5xx.
export function reportNetworkResult(answered) {
  if (answered && state.reachable !== true) {
    set({ reachable: true });
    // Came back. Flush immediately rather than waiting out the current backoff — the whole
    // point of the queue is that it drains the moment it can. Treated as manual because a
    // server that has visibly returned is new evidence, and a queue that stalled during the
    // outage should not stay stuck once the thing it was waiting for is back.
    flush({ manual: true });
  } else if (!answered) {
    set({ reachable: false });
  }
}

// `reachable` is what the caller learned from the failure that made it queue: false when
// nothing answered, true when the server answered and the answer was a 5xx. Defaulted to
// false because an unreachable server is the older and commoner reason to be here, but it
// must be passed for a 5xx — otherwise the badge goes red claiming a disconnection while
// the server is plainly answering, and the whole point of the badge is that it does not lie.
export function enqueue(sale, { reachable = false } = {}) {
  const list = [...readPending(), sale];
  writePending(list);
  set({ pending: list.length, reachable });
  scheduleRetry();
}

let attempt = 0;
let timer = null;
export function scheduleRetry() {
  if (timer) return;
  if (attempt >= MAX_ATTEMPTS) {
    // Out of automatic attempts. Nothing is dropped — the queue is still on disk and still
    // counted; what stops is this module trying on its own. stalledTick bumps once per stall
    // so the shell raises one alert rather than one per attempt.
    if (!state.stalled) set({ stalled: true, stalledTick: state.stalledTick + 1 });
    return;
  }
  timer = setTimeout(() => { timer = null; flush(); }, nextDelay(attempt));
}
function clearRetry() { if (timer) { clearTimeout(timer); timer = null; } attempt = 0; }

// Serial, and stops at the first failure so invoice order is preserved and nothing is lost.
// Each sale takes a fresh invoice number at the moment it lands, not when it was rung.
// `manual` is a person asking: tapping the badge. It clears a stall and starts the attempt
// count over, which is the only way out of one. An automatic call never does this — that
// would turn the cap into a no-op.
export async function flush({ getInvoice, postOrder, manual = false } = {}) {
  if (state.syncing) return;
  if (manual) { clearRetry(); set({ stalled: false }); }
  else if (state.stalled) return;   // gave up; wait for a person
  let list = readPending();
  if (!list.length) { set({ syncing: false }); return; }

  // Never send a queued sale without a session. An unauthenticated flush 401s on the first
  // sale, which looks exactly like the server rejecting that sale — the queue stops, the
  // badge sits on "Pending", and nothing about the display suggests the real cause is that
  // nobody is logged in yet. The injected overrides skip this: tests supply their own
  // transport and have no token to set.
  const injected = getInvoice || postOrder;
  if (!injected && typeof api.getToken === 'function' && !api.getToken()) return;

  const nextInvoice = getInvoice || (() => api.get('/invoice/next?floor=main'));
  const send = postOrder || ((s, invoice_no) => api.post('/orders', { ...s, invoice_no }));

  set({ syncing: true });
  let synced = 0;
  try {
    while (list.length) {
      const sale = list[0];
      try {
        const invoice_no = await nextInvoice();
        await send(sale, invoice_no);
      } catch (ex) {
        // A response means the server is alive and rejected this specific sale; no response
        // means it is unreachable. Both stop the flush, but only one is an outage.
        const answered = ex && typeof ex.status === 'number';
        set({ reachable: answered });
        break;
      }
      list = list.slice(1);
      writePending(list);
      synced += 1;
    }
  } finally {
    const drained = list.length === 0 && synced > 0;
    set({
      pending: list.length,
      syncing: false,
      ...(synced ? { syncedTick: state.syncedTick + 1, lastSyncedCount: synced } : null),
      // An emptied queue is not stalled by definition, and leaving the flag set would keep
      // blocking automatic flushes for sales rung after the problem was over.
      ...(drained ? { reachable: true, stalled: false } : null),
    });
    if (list.length) { attempt += 1; scheduleRetry(); } else { clearRetry(); }
  }
}

// Called once from the shell. Wires api.js's outcome reporting, flushes anything left from a
// previous session, and keeps the browser's own online event as a hint — it is not the truth,
// but a cheap prompt to try again sooner.
let started = false;
export function start() {
  if (started) return () => {};
  started = true;
  // The demo build swaps in demoApi, which has no network to report on. Guarded rather than
  // required, so the demo keeps booting.
  if (typeof api.setOnNetworkResult === 'function') api.setOnNetworkResult(reportNetworkResult);
  // Manual: a stall is deliberately NOT persisted, so opening the app is itself the person
  // intervening. Whatever went wrong last session gets one fresh run of attempts.
  flush({ manual: true });
  const onOnline = () => flush({ manual: true });
  window.addEventListener('online', onOnline);
  return () => {
    window.removeEventListener('online', onOnline);
    clearRetry();
    started = false;
  };
}

// Test seam: the module holds process-wide state, so a suite needs a way back to zero.
export function _reset(next = {}) {
  clearRetry();
  state = {
    pending: 0, syncing: false, reachable: null, syncedTick: 0, lastSyncedCount: 0,
    stalled: false, stalledTick: 0, ...next,
  };
  listeners.clear();
  started = false;
}
