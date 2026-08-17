// ──────────────────────────────────────────────────────────────────────────
// CLIENT CONFIG — single source of truth for everything client-specific.
//
// Kan Coffee House build: a single-store, counter-service cafe POS. There are no
// floors/tables and no barcode scanner — the app is a catalogue + category-chip sales
// screen. The store key is fixed to "main" (mirrors server/floors.js); it names the
// orders_main table and is the invoice-numbering key.
//
// WHERE THE VALUES COME FROM
// The literals below are DEFAULTS, not the answer. The API serves this shop's real identity
// at runtime as window.__CLIENT__ (server/clientConfig.js → GET /client-config.js, loaded by
// public/index.html before the bundle), and it is merged over these.
//
// That indirection is what makes one image serve every client: a shop is an .env file, not
// its own React build. Editing the literals here changes the FALLBACK for every deployment
// that sets nothing — which is the demo build, the test suite, and a fresh checkout. To
// change one shop, set its env vars; to change what a brand-new shop starts as, edit here.
// ──────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  storeName: "Kan Coffee House",
  currency: "JOD",
  // English by default; the AR⇄EN toggle in Settings still works at runtime.
  locale: { default: "en", arabic: false },
  // Single store. Standard Jordanian sales tax → 16% VAT on the receipt.
  // Menu prices are TAX-INCLUSIVE (Espresso 2.00 = 1.72 net + 0.28 VAT).
  //
  // `timezone` is the shop's own clock, and it decides which trading day a sale belongs to.
  // The server sends its own STORE_TZ down in window.__CLIENT__ rather than this being set
  // twice: the browser stamps date/time at checkout and the server groups reports by the
  // same zone, so a mismatch used to split a night's takings across two trading days. This
  // value is only what a server-less build (demo, tests) falls back to.
  store: { key: "main", taxPct: 16, timezone: "Asia/Amman" },
  bill: {
    footerThanks: "See you again soon!",
    footerThanksAr: "نراكم قريباً",
    invoicePrefix: "KC",
    // Seller identity printed on the receipt header.
    //
    // taxNo IS DELIBERATELY EMPTY. The owner had not supplied Kan's registered tax number
    // at intake, and the template's old "1234567" placeholder must never reach a real
    // receipt — a wrong tax number prints on every invoice the shop ever issues and
    // nothing in the app would say so. Set CLIENT_SELLER_TAX_NO in the shop's env before
    // Kan issues a single real receipt. See CLIENT_INTAKE.md, open blocker #1.
    seller: { name: "Kan Coffee House", location: "Amman, Jordan", taxNo: "" },
    // Optional legal line at the foot of the bill, e.g. the Jordanian invoicing-regulation
    // declaration ("صدرت هذه الفاتورة وفق أحكام المادة 5 من نظام تنظيم شؤون الفوترة").
    //
    // EMPTY ON PURPOSE. That sentence is a legal statement about THIS business — which
    // regulation it invoices under — so it is the owner's to assert, not something to be
    // filled in on their behalf. Set it in the shop's env and it appears on the bill view;
    // leave it blank and the line is not rendered at all.
    legalNote: "",
    legalNoteAr: "",
  },
};

// What the server sent, or nothing. Missing is the normal case for the demo build and the
// jsdom tests, so it is a fallback path rather than an error path.
const RUNTIME = (typeof window !== "undefined" && window.__CLIENT__) || {};

// Merged one level at a time rather than with a generic deep-merge. The shape is small and
// fixed, and being explicit means a stray key in the runtime payload cannot invent config
// the app never reads — while a key the server DOES send always lands where it is expected.
// `pick` tests for null/undefined, NOT falsiness: taxPct 0 is a real answer (a tax-free
// shop) and legalNote "" is a deliberate value. A `||` here would silently discard both and
// hand a zero-rated shop a 16% VAT line.
const pick = (runtime, fallback) => (runtime === undefined || runtime === null ? fallback : runtime);

export const CLIENT = {
  storeName: pick(RUNTIME.storeName, DEFAULTS.storeName),
  currency: pick(RUNTIME.currency, DEFAULTS.currency),
  locale: { ...DEFAULTS.locale, ...(RUNTIME.locale || {}) },
  store: { ...DEFAULTS.store, ...(RUNTIME.store || {}) },
  bill: {
    ...DEFAULTS.bill,
    ...(RUNTIME.bill || {}),
    seller: { ...DEFAULTS.bill.seller, ...((RUNTIME.bill || {}).seller || {}) },
  },
};

// ── Derived constants (consumed by App.jsx) ───────────────────────────────────
export const STORE_NAME = CLIENT.storeName;
export const CURRENCY = CLIENT.currency;

// public/index.html ships a static <title> because a shell served to every client cannot
// know whose it is. Correct it as soon as the real name is known — otherwise every shop's
// browser tab, and every "add to home screen" prompt, reads "Liquor Store POS".
if (typeof document !== "undefined") document.title = `${STORE_NAME} POS`;

// ── Language (runtime toggle, persisted) ──────────────────────────────────────
// Default from config; user can switch AR⇄EN at runtime. Every UI string is an
// `ARABIC ? ar : en` ternary, so flipping this + reloading re-renders the whole app.
const LANG_KEY = "kan_coffee_lang";
const defaultLang = CLIENT.locale.arabic ? "ar" : (CLIENT.locale.default || "en");
let _lang = defaultLang;
try { _lang = localStorage.getItem(LANG_KEY) || defaultLang; } catch (_) {}
export const ARABIC = _lang === "ar";
export const LANG = _lang;
export function setLang(l) {
  try { localStorage.setItem(LANG_KEY, l); } catch (_) {}
  if (typeof window !== "undefined") window.location.reload();
}
export function toggleLang() { setLang(ARABIC ? "en" : "ar"); }
export const DEFAULT_FLOOR = CLIENT.store.key;       // "main" — the orders table + invoice key
export const STORE_TZ = CLIENT.store.timezone || "Asia/Amman";
export const TAX_RATE = (CLIENT.store.taxPct || 0) / 100;
export const BILL = CLIENT.bill;
export const SELLER = CLIENT.bill.seller;

// Nav views available in this build. `reports` is server-enforced (allowed_views).
// "storereports" is the financial reporting module (reporting/): invoice-level sales, the
// expense ledger, profit & loss and receipts, with an Excel export. Kept separate from
// "reports" — which is the operational view (top products, ABC, dead stock, Z-report) — so
// neither page has to be two things at once. It rides on the same `reports` grant.
// How the shop takes money. ONE list, because a payment method that exists on the till
// but not in the receipt editor — or reaches the reports under a key nothing has a label
// for — is worse than not having it at all.
//
// `settled` marks money that is in hand the moment the sale is rung: cash in the drawer,
// a CliQ transfer that has already landed. It is what decides whether the till asks for a
// tendered amount and works out change, and nothing else should be re-deriving that from
// the key.
export const PAYMENTS = [
  { key: "cash", en: "Cash", ar: "نقدي", icon: "💵", settled: true },
  { key: "card", en: "Card", ar: "بطاقة", icon: "💳", settled: false },
  // CliQ — Jordan's instant bank transfer. The customer pays from their phone and the
  // money arrives before they leave the counter, so there is no change to give and no
  // slip to reconcile at close.
  { key: "cliq", en: "CliQ", ar: "كليك", icon: "📲", settled: true },
];

export const PAY_KEYS = PAYMENTS.map((p) => p.key);
const PAY_BY_KEY = Object.fromEntries(PAYMENTS.map((p) => [p.key, p]));

// A payment method reads as a WORD on a bill, never as a database key. Anything unknown
// (a legacy row, 'refund') falls through unchanged rather than becoming an empty cell.
export function payLabel(key, { icon = false } = {}) {
  const p = PAY_BY_KEY[String(key || "").toLowerCase()];
  if (!p) return String(key || "");
  const word = ARABIC ? p.ar : p.en;
  return icon ? `${p.icon} ${word}` : word;
}

export const isSettledPayment = (key) => {
  const p = PAY_BY_KEY[String(key || "").toLowerCase()];
  return !!(p && p.settled);
};

// The full catalogue of views this build can render. A shop may show fewer (the server
// sends `views` — e.g. `assistant` is dropped when there is no NVIDIA_API_KEY, rather than
// shipping a nav button that opens a view which can only apologise), but never more: an
// unknown key here would be a nav tab routing to nothing. server/test/clientConfig.test.js
// pins the server's KNOWN_VIEWS to this list by reading this file as text, the same way
// reporting/test/payments.test.js pins the payment methods.
export const ALL_VIEWS = ["sales", "inventory", "receive", "history", "reports", "storereports", "assistant", "settings"];

// What Kan sees when the server has NOT told us (no window.__CLIENT__): the demo build on
// GitHub Pages, and the jsdom tests.
//
// This used to fall back to ALL_VIEWS, which quietly re-enabled the AI Assistant this shop
// switched off — the nav offered a button opening a view that can only apologise, in the very
// build a client is shown. `assistant` is omitted here for the same reason it is omitted from
// CLIENT_VIEWS in .env. A live deployment still overrides this with its own env.
const DEFAULT_VIEWS = ["sales", "inventory", "receive", "history", "reports", "storereports", "settings"];

export const VIEWS = Array.isArray(RUNTIME.views) && RUNTIME.views.length
  ? ALL_VIEWS.filter((v) => RUNTIME.views.includes(v))
  : ALL_VIEWS.filter((v) => DEFAULT_VIEWS.includes(v));
export const VIEW_LABELS = {
  sales: ARABIC ? "البيع" : "Sales",
  inventory: ARABIC ? "المخزون" : "Inventory",
  receive: ARABIC ? "استلام" : "Receive",
  history: ARABIC ? "السجل" : "History",
  reports: ARABIC ? "التقارير" : "Reports",
  storereports: ARABIC ? "المالية" : "Financials",
  assistant: ARABIC ? "المساعد الذكي" : "AI Assistant",
  settings: ARABIC ? "الإعدادات" : "Settings",
};
