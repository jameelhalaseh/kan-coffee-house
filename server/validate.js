// Minimal request-validation helpers (no external dep for Phase 1).
// Keeps routes terse while returning consistent { error } bodies.

// Send a logical error body with an HTTP status. Error codes mirror the original
// Supabase RPC contract exactly (e.g. 'session', 'wrong_old', 'too_short', 'not_admin').
function fail(res, code, status = 400) {
  return res.status(status).json({ error: code });
}

// Returns the first missing/blank key from `obj`, or null if all present.
function missingField(obj, keys) {
  for (const k of keys) {
    const v = obj == null ? undefined : obj[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return k;
  }
  return null;
}

// Map a Postgres constraint violation to a 4xx (so the client's error toast fires) instead of a
// 500. Returns true if it handled the error; otherwise call next(e). 23505=unique, 23514=check,
// 23503=fk, 22P02=invalid_text_representation.
function dbError(res, next, e) {
  const map = { '23505': ['exists', 409], '23514': ['invalid', 400], '23503': ['invalid', 400], '23502': ['invalid', 400], '22P02': ['invalid', 400] };
  const hit = e && map[e.code];
  if (hit) return res.status(hit[1]).json({ error: hit[0] });
  return next(e);
}

module.exports = { fail, missingField, dbError };
