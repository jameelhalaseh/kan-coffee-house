// Store registry.
//
// This build is the SINGLE-STORE coffee house (server/floors.js → ['main']). The module was
// written against a two-store restaurant (gg 16% / dealer 8%); those shops are gone, and with
// them the store picker. What survives is the scoping itself: every query still carries the
// floor, so the reports keep working unchanged if a second branch is ever added.
//
// The seller identity mirrors src/client.config.js (the receipt's header) — a report and a
// receipt from the same shop must not disagree about who issued them.
const { d } = require('./decimal');
const { FLOORS: SERVER_FLOORS, DEFAULT_FLOOR } = require('../server/floors');

const STORES = {
  main: {
    key: 'main',
    name: 'Liquor Store',
    legalName: 'Liquor Store',
    location: 'Amman, Jordan',
    // Placeholder, exactly as it is on the receipt today. Whoever supplies the real
    // registration number changes it in ONE place: here and client.config's seller block.
    taxNo: '1234567',
    vat: d('0.16'),
    // No service charge in an off-licence. The extraction in money.js still supports it, so
    // the SVC path is dormant rather than deleted — flipping this to true is all it takes.
    service: false,
    currency: 'JOD',
    // JOD is a THREE-decimal currency and this shop's receipts, invoices and stored order
    // rows are all 3dp. §4's r2 was written for a 2dp currency; using it here would round
    // 2.241 to 2.24 on the report while the printed invoice says 2.241. Rounding precision
    // is therefore a property of the store, not a constant.
    dp: 3,
  },
};

const FLOORS = Object.keys(STORES);

// Guard: the reporting registry and the server's own floor list must not drift apart. If a
// branch is added to server/floors.js without an identity here, the report would either
// throw at request time or silently label the new branch with this one's tax number.
for (const f of SERVER_FLOORS) {
  if (!STORES[f]) {
    throw new Error(
      `reporting/stores.js has no identity for floor '${f}' (declared in server/floors.js)`);
  }
}

// Resolve a floor key to its store. Unknown keys throw rather than defaulting.
function store(floor) {
  const s = STORES[floor];
  if (!s) throw new RangeError(`unknown floor: ${floor}`);
  return s;
}

const vatRate = (floor) => store(floor).vat;
const decimals = (floor) => store(floor).dp;
const onFloor = (rows, floor) => (rows || []).filter((r) => r && r.floor === floor);

module.exports = { STORES, FLOORS, DEFAULT_FLOOR, store, vatRate, decimals, onFloor };
