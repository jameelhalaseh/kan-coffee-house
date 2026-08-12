// Period selection (§3).
//
// [QUIRK — DO NOT "FIX"] Reports use the PLAIN CALENDAR DATE, not the 02:00 business day.
// The operational side of this system runs a 02:00 → 02:00 shift, so an order at 01:30
// belongs to the previous night's service. The financial reports deliberately do not follow
// that: a sale at 01:30 on the 12th reports under the 12th. Existing filings are built on
// this. There is NO shift offset anywhere in this file, and §8.8 is a test that keeps it
// that way.
//
// Filtering is a lexicographic STRING comparison on the `date` text column. That is only
// correct because dates are zero-padded YYYY-MM-DD — the format is load-bearing, not
// cosmetic.

const pad = (n) => String(n).padStart(2, '0');

// The device's current LOCAL calendar date. Local, not UTC: the report a manager opens at
// 00:30 in Amman must say today, not yesterday.
const isoDate = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const today = (now = new Date()) => isoDate(now);

// Shift a YYYY-MM-DD by whole days through the local calendar, so month lengths and DST
// transitions are handled by the platform rather than by arithmetic here.
function addDays(dateStr, days) {
  const [y, m, dd] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, dd);
  dt.setDate(dt.getDate() + days);
  return isoDate(dt);
}

const PRESETS = ['today', 'week', 'month', 'all', 'custom'];

/**
 * Resolve a preset into { preset, from, to, label, ready }.
 *
 * An empty bound means unbounded. A custom period with only one of the two dates filled is
 * NOT a half-open range — it renders nothing and prompts the user (ready: false), because a
 * half-filled custom range is a user who has not finished typing, not a request for
 * everything since the beginning of time.
 */
function resolvePeriod(preset, { from = '', to = '', now = new Date() } = {}) {
  const t = today(now);
  switch (preset) {
    case 'today':
      return { preset, from: t, to: t, label: t, ready: true };
    case 'week': {
      const f = addDays(t, -7);
      return { preset, from: f, to: t, label: `${f} → ${t}`, ready: true };
    }
    case 'month': {
      const f = `${t.slice(0, 7)}-01`;
      return { preset, from: f, to: t, label: t.slice(0, 7), ready: true };
    }
    case 'all':
      return { preset, from: '', to: '', label: 'All time', ready: true };
    case 'custom':
      if (!from || !to) {
        return { preset, from, to, label: '', ready: false, prompt: 'Pick both dates' };
      }
      return { preset, from, to, label: `${from} → ${to}`, ready: true };
    default:
      throw new RangeError(`unknown period preset: ${preset}`);
  }
}

// Is this row's date inside the window? Lexicographic on zero-padded text; '' = unbounded.
const inPeriod = (date, from, to) => {
  const s = String(date || '');
  if (from && s < from) return false;
  if (to && s > to) return false;
  return true;
};

// Filter rows of one store by period in one pass. Every report starts here.
const scope = (rows, floor, period) =>
  (rows || []).filter((r) => r && r.floor === floor && inPeriod(r.date, period.from, period.to));

module.exports = { today, isoDate, addDays, resolvePeriod, inPeriod, scope, PRESETS };
