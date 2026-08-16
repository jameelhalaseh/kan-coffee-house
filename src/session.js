// What to do when restoring a session at boot fails.
//
// This lives outside App.jsx so it can be tested without rendering the app, because the
// wrong answer here has two expensive shapes and neither announces itself:
//
//   too eager to log out  — the shop's internet drops, a till reloads, and the cashier is
//                           thrown onto a login screen that cannot reach the server either.
//                           The till is dead for the whole outage, and the offline sales
//                           queue never gets used, because you must be signed in to reach
//                           the sales screen at all.
//   too eager to stay in  — a revoked or expired session keeps working locally, and staff
//                           who should have been signed out are still ringing sales.
//
// src/api.js sets `status` on any error the server actually responded with; a fetch that
// never completed (DNS, refused connection, timeout, aeroplane mode) throws without one.
// That is the whole discriminator, and it is why this is decided on `status` rather than on
// navigator.onLine — which reports the LAN, not whether your server is reachable, and is
// cheerfully true on a router with no uplink.

export const SESSION_LOGOUT = 'logout';   // the server rejected us; clear everything
export const SESSION_OFFLINE = 'offline'; // unreachable; reopen the last confirmed session
export const SESSION_LOGIN = 'login';     // nothing to restore; show the login screen

// `err`    — what api.get('/auth/validate') threw
// `cached` — the parsed USER_KEY value, or null
export function sessionAction(err, cached) {
  // A response arrived and it was not a success: expired, revoked, account deleted. The
  // server is the authority whenever it can be reached, and it has spoken.
  if (err && typeof err.status === 'number') return SESSION_LOGOUT;

  // Nobody answered. Reopen only if this browser has completed a login before — a cached
  // user is evidence the server once confirmed this identity. Without one there is nothing
  // to restore and nothing useful to do offline.
  if (cached && cached.username) return SESSION_OFFLINE;

  return SESSION_LOGIN;
}

// Parse the cached user defensively: it is localStorage, so it can be absent, truncated by a
// full quota, or edited by hand. Anything unreadable is treated as "no cached user", which
// falls through to the login screen rather than restoring a half-object into the shell.
export function readCachedUser(raw) {
  if (!raw) return null;
  try {
    const u = JSON.parse(raw);
    return u && typeof u === 'object' && u.username ? u : null;
  } catch (_) {
    return null;
  }
}
