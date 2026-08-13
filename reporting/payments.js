// How the shop takes money, for the server.
//
// This duplicates the list in src/client.config.js, and it has to: that file is an ES module
// the CRA bundle imports, and this is CommonJS running under Node. Requiring one from the
// other is not possible without a build step neither side currently needs.
//
// The duplication is made safe rather than merely apologised for — reporting/test/
// payments.test.js reads client.config.js as text and fails if the two lists disagree. A
// method the till can charge but the API rejects would break a sale at the worst possible
// moment, so the two are pinned together by a test rather than by hope.
//
//   cash — in the drawer
//   card — settled through the terminal
//   cliq — Jordan's instant bank transfer, settled before the customer leaves
const PAY_KEYS = ['cash', 'card', 'cliq'];

module.exports = { PAY_KEYS };
