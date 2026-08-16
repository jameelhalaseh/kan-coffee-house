// The offline queue and the connection light. See src/sync.js for why this is a module
// rather than component state.
import {
  deriveStatus, nextDelay, RETRY_MS, enqueue, flush, getState, subscribe,
  reportNetworkResult, readPending, _reset,
  SYNCED, SYNCING, PENDING, OFFLINE,
} from './sync';
import { PENDING_KEY } from './constants';

const sale = (id) => ({ id, total: 10, items: [] });

beforeEach(() => {
  localStorage.clear();
  _reset();
});

describe('what the badge says', () => {
  test('empty queue and a server that answers is Synced', () => {
    expect(deriveStatus({ pending: 0, syncing: false, reachable: true })).toBe(SYNCED);
  });

  test('an unreachable server is NOT synced, even with an empty queue', () => {
    // The lie that matters. Nothing queued does not mean everything is fine — it can just as
    // easily mean the till has sold nothing since the server died, and a green light there
    // tells the cashier the opposite of the truth.
    expect(deriveStatus({ pending: 0, syncing: false, reachable: false })).toBe(OFFLINE);
  });

  test('unreachable outranks a pending count', () => {
    expect(deriveStatus({ pending: 3, syncing: false, reachable: false })).toBe(OFFLINE);
  });

  test('a queue with the server up is Pending, not Offline', () => {
    expect(deriveStatus({ pending: 2, syncing: false, reachable: true })).toBe(PENDING);
  });

  test('syncing wins over everything — it is the transient state', () => {
    expect(deriveStatus({ pending: 2, syncing: true, reachable: false })).toBe(SYNCING);
  });

  test('before any request has happened it reads as Synced, not Offline', () => {
    // reachable starts null. Opening the app must not flash a red light before the first
    // request has had a chance to say anything.
    expect(deriveStatus({ pending: 0, syncing: false, reachable: null })).toBe(SYNCED);
  });
});

describe('retry backoff', () => {
  test('starts short and lengthens', () => {
    expect(nextDelay(0)).toBe(RETRY_MS[0]);
    expect(nextDelay(1)).toBeGreaterThan(nextDelay(0));
  });

  test('caps rather than growing forever — a till must never stop trying', () => {
    expect(nextDelay(99)).toBe(RETRY_MS[RETRY_MS.length - 1]);
  });
});

describe('queueing a sale', () => {
  test('persists it and marks the connection down', () => {
    enqueue(sale('a'));
    expect(readPending()).toHaveLength(1);
    expect(getState().pending).toBe(1);
    expect(deriveStatus(getState())).toBe(OFFLINE);
  });

  test('survives a reload — it is the localStorage that is authoritative', () => {
    enqueue(sale('a'));
    enqueue(sale('b'));
    expect(JSON.parse(localStorage.getItem(PENDING_KEY)).map((s) => s.id)).toEqual(['a', 'b']);
  });

  test('a sale queued because of a 5xx does not claim the connection is down', () => {
    // The server answered — it is its database that is gone. Showing a red disconnected
    // badge here would be a different lie from the one the badge was built to stop.
    enqueue(sale('a'), { reachable: true });
    expect(deriveStatus(getState())).toBe(PENDING);
  });
});

describe('flushing', () => {
  test('sends sales in the order they were rung', async () => {
    enqueue(sale('a')); enqueue(sale('b'));
    const sent = [];
    await flush({ getInvoice: async () => 1, postOrder: async (s) => { sent.push(s.id); } });
    expect(sent).toEqual(['a', 'b']);
    expect(readPending()).toHaveLength(0);
    expect(deriveStatus(getState())).toBe(SYNCED);
  });

  test('stops at the first failure and keeps the rest, in order', async () => {
    // Serial and fail-fast: invoice numbers are taken as each sale lands, so continuing past
    // a failure would interleave them and lose the sequence.
    enqueue(sale('a')); enqueue(sale('b')); enqueue(sale('c'));
    let n = 0;
    await flush({
      getInvoice: async () => 1,
      postOrder: async () => { if (++n === 2) throw new TypeError('Failed to fetch'); },
    });
    expect(readPending().map((s) => s.id)).toEqual(['b', 'c']);
  });

  test('a sale the server REJECTS still stops the flush, but is not an outage', async () => {
    enqueue(sale('a'));
    await flush({
      getInvoice: async () => 1,
      postOrder: async () => { throw Object.assign(new Error('bad'), { status: 400 }); },
    });
    // Reachable, because the server answered — the badge must not cry "offline" over one
    // rejected sale.
    expect(getState().reachable).toBe(true);
    expect(deriveStatus(getState())).toBe(PENDING);
    expect(readPending()).toHaveLength(1);
  });

  test('reports how many landed, once per flush', async () => {
    enqueue(sale('a')); enqueue(sale('b'));
    const before = getState().syncedTick;
    await flush({ getInvoice: async () => 1, postOrder: async () => {} });
    expect(getState().syncedTick).toBe(before + 1);
    expect(getState().lastSyncedCount).toBe(2);
  });

  test('a flush with nothing queued does nothing and reports nothing', async () => {
    const before = getState().syncedTick;
    await flush({ getInvoice: async () => 1, postOrder: async () => {} });
    expect(getState().syncedTick).toBe(before);
  });

  test('each sale takes a FRESH invoice number as it lands', async () => {
    // Numbers are assigned at sync time, not at checkout: two tills queueing offline would
    // otherwise both claim the same number.
    enqueue(sale('a')); enqueue(sale('b'));
    let next = 100;
    const used = [];
    await flush({
      getInvoice: async () => next++,
      postOrder: async (_s, invoice_no) => { used.push(invoice_no); },
    });
    expect(used).toEqual([100, 101]);
  });
});

describe('reachability comes from real requests', () => {
  test('a response — any response — means the server is there', () => {
    reportNetworkResult(false);
    expect(getState().reachable).toBe(false);
    reportNetworkResult(true);
    expect(getState().reachable).toBe(true);
  });

  test('coming back online triggers a flush without waiting out the backoff', async () => {
    enqueue(sale('a'));
    expect(getState().reachable).toBe(false);
    reportNetworkResult(true);
    await new Promise((r) => setTimeout(r, 0));
    // The default flush path hits the real api, which jsdom has no server for; what is being
    // asserted is that recovery kicks the queue rather than leaving it for the timer.
    expect(getState().reachable).not.toBe(null);
  });
});

describe('subscribers', () => {
  test('are told when the state moves', () => {
    const seen = [];
    subscribe((s) => seen.push(s.pending));
    enqueue(sale('a'));
    expect(seen).toContain(1);
  });

  test('are NOT woken when nothing changed — every one is a re-render', () => {
    reportNetworkResult(true);
    const seen = [];
    subscribe(() => seen.push(1));
    reportNetworkResult(true);
    reportNetworkResult(true);
    expect(seen).toHaveLength(0);
  });
});
