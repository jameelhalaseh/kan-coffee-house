// Storage keys and channel names shared across modules. Kept in one place so a rename
// can't leave one reader looking at a key nobody writes any more.
export const TOKEN_KEY = 'dukkan_token';
export const HELD_KEY = 'dukkan_held_sales';      // parked carts
export const PENDING_KEY = 'dukkan_pending_sales'; // sales made offline, awaiting sync
export const PAD_KEY = 'dukkan_show_cash_pad';     // cash keypad visibility preference
export const BC_NAME = 'dukkan_pos';               // BroadcastChannel → customer display
export const DISPLAY_KEY = 'dukkan_display';       // localStorage fallback for that display
