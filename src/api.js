// CashierPOS API client — replaces the Supabase client (src/db.js).
// Browser → fetch('/api/...') with a Bearer session token → Express → Postgres.
//
// Contract:
//   - Base URL from REACT_APP_API_URL (empty = same origin as the served build).
//   - The session token is held module-side; setToken() is called on login / session-restore
//     and cleared on logout. Every request attaches `Authorization: Bearer <token>`.
//   - A 2xx response resolves to the parsed JSON body (array, object, number, or null).
//   - A non-2xx response THROWS an Error whose `.status` is the HTTP code and `.body` is the
//     parsed error payload (e.g. { error: 'session' }) and whose `.message` is that error code.
//     Callers that previously inspected supabase's { data, error } now use try/catch.
const BASE = process.env.REACT_APP_API_URL || '';

let _token = null;
export function setToken(t) { _token = t || null; }
export function getToken() { return _token; }

// Fires when an AUTHENTICATED request returns 401 'session' (token expired/invalidated).
// The app registers a handler to show a blocking "session expired" overlay instead of
// letting staff keep working against a dead session. Guarded by _token so the pre-login
// validate call never triggers it.
let _onExpired = null;
export function setOnSessionExpired(fn) { _onExpired = fn; }

async function req(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(_token ? { Authorization: 'Bearer ' + _token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    if (res.status === 401 && data && data.error === 'session' && _token && _onExpired) {
      try { _onExpired(); } catch (_) { /* never let the handler mask the original error */ }
    }
    const err = new Error((data && data.error) || ('http_' + res.status));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

const realApi = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b),
  patch: (p, b) => req('PATCH', p, b),
  del: (p) => req('DELETE', p),
  setToken,
  getToken,
  setOnSessionExpired,
};

// DEMO build (GitHub Pages, no backend): swap in the in-browser mock API. Flag is set
// only for the Pages build (REACT_APP_DEMO=1); the real Heroku build keeps realApi.
// eslint-disable-next-line
const api = process.env.REACT_APP_DEMO === '1' ? require('./demoApi').default : realApi;

export { api };
export default api;
