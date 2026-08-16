// Storage keys and channel names shared across modules. Kept in one place so a rename
// can't leave one reader looking at a key nobody writes any more.
export const TOKEN_KEY = 'dukkan_token';
// The last user /auth/validate confirmed. Read ONLY when the server cannot be reached at
// boot, so a till whose internet is down can still open its session instead of being thrown
// back to a login screen that also cannot reach the server. It grants nothing on its own:
// the token is the credential, and the API re-authorises every single request.
export const USER_KEY = 'dukkan_user';
export const HELD_KEY = 'dukkan_held_sales';      // parked carts
// The last catalogue the server sent. Read ONLY when /products cannot be fetched, so the
// sales screen has something to sell from during an outage — see src/catalog.js.
export const CATALOG_KEY = 'dukkan_catalog';
export const PENDING_KEY = 'dukkan_pending_sales'; // sales made offline, awaiting sync
export const PAD_KEY = 'dukkan_show_cash_pad';     // cash keypad visibility preference
export const BC_NAME = 'dukkan_pos';               // BroadcastChannel → customer display
export const DISPLAY_KEY = 'dukkan_display';       // localStorage fallback for that display
