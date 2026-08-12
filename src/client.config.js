// ──────────────────────────────────────────────────────────────────────────
// CLIENT CONFIG — single source of truth for everything client-specific.
//
// Liquor Store build: a single-store, barcode-driven retail POS. There are no
// floors/tables — the app is a catalogue + scan-to-cart sales screen. The store key is
// fixed to "main" (mirrors server/floors.js); it names the orders_main table and is the
// invoice-numbering key.
// ──────────────────────────────────────────────────────────────────────────

export const CLIENT = {
  storeName: "Liquor Store",
  currency: "JOD",
  // English by default; the AR⇄EN toggle in Settings still works at runtime.
  locale: { default: "en", arabic: false },
  // Single store. Alcohol is taxable here → 16% VAT on the receipt.
  //
  // `timezone` is the shop's own clock, and it decides which trading day a sale belongs to.
  // It must match STORE_TZ in the server env — the browser stamps date/time at checkout and
  // the server groups reports by the same zone, so a mismatch splits a night's takings
  // across two days. An off-licence sells hardest between 21:00 and 02:00, and Jordan is
  // UTC+3, so "just use UTC" files every post-midnight sale under yesterday.
  store: { key: "main", taxPct: 16, timezone: "Asia/Amman" },
  bill: {
    footerThanks: "Please drink responsibly. Thank you!",
    footerThanksAr: "نرجو الشرب بمسؤولية. شكراً لكم",
    invoicePrefix: "LQ",
    // Seller identity printed on the receipt header.
    seller: { name: "Liquor Store", location: "Amman, Jordan", taxNo: "1234567" },
    // Optional legal line at the foot of the bill, e.g. the Jordanian invoicing-regulation
    // declaration ("صدرت هذه الفاتورة وفق أحكام المادة 5 من نظام تنظيم شؤون الفوترة").
    //
    // EMPTY ON PURPOSE. That sentence is a legal statement about THIS business — which
    // regulation it invoices under — so it is the owner's to assert, not something to be
    // filled in on their behalf. Set it here and it appears on the bill view; leave it blank
    // and the line is not rendered at all.
    legalNote: "",
    legalNoteAr: "",
  },
};

// ── Derived constants (consumed by App.jsx) ───────────────────────────────────
export const STORE_NAME = CLIENT.storeName;
export const CURRENCY = CLIENT.currency;

// ── Language (runtime toggle, persisted) ──────────────────────────────────────
// Default from config; user can switch AR⇄EN at runtime. Every UI string is an
// `ARABIC ? ar : en` ternary, so flipping this + reloading re-renders the whole app.
const LANG_KEY = "liquor_store_lang";
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
export const VIEWS = ["sales", "inventory", "receive", "history", "reports", "storereports", "assistant", "settings"];
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
