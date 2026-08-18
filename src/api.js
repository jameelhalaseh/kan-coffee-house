// API client for the POS. One fetch wrapper, one place the Bearer token is attached.
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

// Every request reports whether the SERVER ANSWERED — true for any response at all, 4xx and
// 5xx included, false only when the fetch itself never completed. src/sync.js turns that into
// the connection light on the till.
//
// This is reported here, at the one place every call passes through, because the alternative
// (navigator.onLine) answers a different question: whether the device has a network
// interface. A router with no uplink says online, and so does a dead server. Only the
// outcome of a real request to OUR server knows.
let _onNetworkResult = null;
export function setOnNetworkResult(fn) { _onNetworkResult = fn; }
function reportNetwork(answered) {
  if (_onNetworkResult) { try { _onNetworkResult(answered); } catch (_) { /* never break a request */ } }
}

async function req(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + '/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(_token ? { Authorization: 'Bearer ' + _token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // No response at all: DNS, refused, timed out, aeroplane mode. Rethrown unchanged so
    // callers keep seeing an error with no `.status`, which is how they tell the two apart.
    reportNetwork(false);
    throw e;
  }
  reportNetwork(true);
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

// Binary GET. Category artwork is served from an AUTHENTICATED endpoint, and an <img> tag
// cannot carry an Authorization header — so the bytes are fetched here and the caller turns
// them into an object URL. Shares the 401-session handling above; everything else about it
// is deliberately minimal, because it is the only non-JSON response in the API.
async function getBlob(path) {
  let res;
  try {
    res = await fetch(BASE + '/api' + path, {
      headers: { ...(_token ? { Authorization: 'Bearer ' + _token } : {}) },
    });
  } catch (e) {
    reportNetwork(false);
    throw e;
  }
  reportNetwork(true);
  if (!res.ok) {
    if (res.status === 401 && _token && _onExpired) {
      try { _onExpired(); } catch (_) { /* never let the handler mask the original error */ }
    }
    const err = new Error('http_' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.blob();
}

const realApi = {
  get: (p) => req('GET', p),
  getBlob,
  post: (p, b) => req('POST', p, b),
  put: (p, b) => req('PUT', p, b),
  patch: (p, b) => req('PATCH', p, b),
  // DELETE carries an optional body: voiding an order (DELETE /orders/:id) records a
  // void_reason, which the server reads from req.body. Existing callers pass nothing and are
  // unaffected — `undefined` sends no body at all.
  del: (p, b) => req('DELETE', p, b),
  setToken,
  getToken,
  setOnSessionExpired,
  setOnNetworkResult,
};

// DEMO build (GitHub Pages, no backend): swap in the in-browser mock API. Flag is set
// only for the Pages build (REACT_APP_DEMO=1); every real build keeps realApi.
// eslint-disable-next-line
const api = process.env.REACT_APP_DEMO === '1' ? require('./demoApi').default : realApi;

export { api };
export default api;
