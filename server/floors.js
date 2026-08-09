// Server-side store registry. This is a single-store grocery build (Dukkan), so there is
// exactly one "floor": `main` → physical orders table `orders_main`. The generic orders
// route + app_next_invoice() resolve the table from this list, so nothing downstream
// needs to know there is only one store.
//
// Each key must be a SQL-safe identifier (lowercase letters, digits, underscore; starts
// with a letter) because it builds the physical table name `orders_<key>`.

const FLOORS = ['main'];

// store key → physical orders table. Returns a FIXED constant or null — the key is
// whitelisted against FLOORS, never interpolated raw into SQL.
const ordersTable = (floor) => (FLOORS.includes(floor) ? 'orders_' + floor : null);

// Default store used when an incoming row omits/blanks its floor.
const DEFAULT_FLOOR = FLOORS[0];

module.exports = { FLOORS, ordersTable, DEFAULT_FLOOR };
