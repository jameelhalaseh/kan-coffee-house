// Per-client configuration, resolved at RUNTIME from the environment.
//
// WHY THIS FILE EXISTS
// src/client.config.js used to hold each shop's name, tax rate and receipt identity as
// literals, which made the CRA bundle client-specific: every shop needed its own `npm ci`
// and its own React build on the VPS, and therefore its own image. At fifteen shops that is
// fifteen builds peaking at 2-4GB each; onboarding shop number twenty-five meant forty
// minutes of watching webpack. One image that reads its identity at boot turns that into a
// pull and a restart.
//
// The browser gets this through GET /client-config.js (see server/index.js), which assigns
// window.__CLIENT__ before the bundle runs. It is a real file rather than an inline <script>
// because the CSP allows script-src 'self' only — deliberately, since the session token
// lives in localStorage. Serving config as a script SOURCE keeps that guarantee intact.
//
// ANYTHING NOT SET HERE FALLS BACK to the defaults baked into src/client.config.js, so a
// deployment that sets nothing behaves exactly as the Liquor Store build always did, and a
// static demo build with no server at all still boots.
const { DEFAULT_FLOOR } = require('./floors');

// The views this build can show. Kept in step with VIEWS in src/client.config.js by
// server/test/clientConfig.test.js, which reads that file as text — the same way
// reporting/test/payments.test.js pins the payment list. A view offered here that the
// bundle cannot render is a blank screen with a nav button pointing at it.
const KNOWN_VIEWS = ['sales', 'inventory', 'receive', 'history', 'reports', 'storereports', 'assistant', 'settings'];

// A trimmed env string, or the fallback when unset/blank. Blank is treated as unset on
// purpose: `CLIENT_SELLER_TAX_NO=` in a .env means "I haven't filled this in yet", not
// "print an empty tax number".
function str(name, fallback) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

// Misconfiguration here is not cosmetic, so it stops the boot rather than being quietly
// papered over. A tax rate that falls back to 16% because someone typed "sixteen" prints a
// wrong VAT line on every receipt that shop issues, and nobody finds out from the app —
// they find out from the tax authority. Refusing to start is loud, immediate, and shows up
// in the container's restart loop; a silent default does not.
function fail(name, value, expected) {
  throw new Error(
    `${name}="${value}" is not valid — expected ${expected}. ` +
    'Fix it in this client\'s .env; the API will not start with an invalid store identity.'
  );
}

function pct(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) fail(name, raw, 'a number between 0 and 100');
  return n;
}

function lang(name, fallback) {
  const v = str(name, fallback);
  if (v !== 'en' && v !== 'ar') fail(name, v, "'en' or 'ar'");
  return v;
}

function views(name, fallback) {
  const raw = str(name, null);
  if (raw === null) return fallback;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((v) => !KNOWN_VIEWS.includes(v));
  if (unknown.length) fail(name, raw, `a comma-separated subset of: ${KNOWN_VIEWS.join(', ')}`);
  if (!list.includes('sales')) fail(name, raw, "a list including 'sales' — a till that cannot sell is not a till");
  return list;
}

// Build the object the browser receives. Only keys the operator actually set are worth
// sending, but sending the whole shape is simpler to reason about and costs ~400 bytes on a
// no-store response — the client merges it over its own defaults either way.
function clientConfig() {
  // The AI assistant is hidden when there is no key to talk to, rather than shipping a nav
  // button that opens a view which can only apologise. Explicit CLIENT_VIEWS still wins.
  const defaultViews = process.env.NVIDIA_API_KEY
    ? KNOWN_VIEWS
    : KNOWN_VIEWS.filter((v) => v !== 'assistant');

  return {
    storeName: str('CLIENT_STORE_NAME', 'Kan Coffee House'),
    currency: str('CLIENT_CURRENCY', 'JOD'),
    locale: { default: lang('CLIENT_LANG', 'en') },
    store: {
      // NOT configurable, and served from the server's own registry on purpose. This key
      // names a PHYSICAL table (orders_<key>, see server/floors.js) that a migration
      // created. An env var here would let a shop point its till at orders_shop2, which
      // does not exist, and every checkout would 400 with the customer at the counter.
      key: DEFAULT_FLOOR,
      taxPct: pct('CLIENT_TAX_PCT', 16),
      // Read from the SERVER's clock setting, never set separately for the browser. These
      // were two values in two files that had to agree: the browser stamps date/time at
      // checkout and the server groups reports by this zone, so a mismatch files a night's
      // takings under two different trading days. Now there is one value and no way to
      // disagree with it.
      timezone: str('STORE_TZ', 'Asia/Amman'),
    },
    bill: {
      footerThanks: str('CLIENT_BILL_FOOTER', 'See you again soon!'),
      footerThanksAr: str('CLIENT_BILL_FOOTER_AR', 'نراكم قريباً'),
      invoicePrefix: str('CLIENT_INVOICE_PREFIX', 'KC'),
      seller: {
        name: str('CLIENT_SELLER_NAME', str('CLIENT_STORE_NAME', 'Kan Coffee House')),
        location: str('CLIENT_SELLER_LOCATION', 'Amman, Jordan'),
        // EMPTY FALLBACK, CHANGED FROM THE TEMPLATE'S '1234567'.
        // A placeholder tax number is worse than none: it prints on every receipt the
        // shop issues, it looks like a real registration, and nothing in the app flags
        // it. Empty renders no tax line at all — visibly incomplete, which is the
        // correct signal while Kan's real number is still outstanding.
        // Set CLIENT_SELLER_TAX_NO before Kan issues a single real receipt.
        taxNo: str('CLIENT_SELLER_TAX_NO', ''),
      },
      // Left empty unless the shop asserts it. This line states which regulation the
      // business invoices under — the owner's claim to make, not ours to fill in.
      legalNote: str('CLIENT_LEGAL_NOTE', ''),
      legalNoteAr: str('CLIENT_LEGAL_NOTE_AR', ''),
    },
    views: views('CLIENT_VIEWS', defaultViews),
  };
}

// The response body. JSON.stringify handles quoting and unicode (shop names and receipt
// footers are routinely Arabic); the < escape means this stays inert even if someone later
// inlines it into HTML, where "</script>" inside a string would otherwise end the block.
function clientConfigScript() {
  const json = JSON.stringify(clientConfig()).replace(/</g, '\\u003c');
  return `window.__CLIENT__=${json};\n`;
}

// The PWA manifest carries the shop's name too — without this every installed till on every
// client's phone is called "Liquor Store POS", including on the home screen.
function manifest() {
  const cfg = clientConfig();
  return {
    id: '/',
    name: `${cfg.storeName} POS`,
    short_name: cfg.storeName,
    description: `${cfg.storeName} point-of-sale terminal`,
    start_url: '.',
    scope: '.',
    display: 'standalone',
    background_color: '#0f1117',
    theme_color: '#0f1117',
    orientation: 'any',
    icons: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

module.exports = { clientConfig, clientConfigScript, manifest, KNOWN_VIEWS };
