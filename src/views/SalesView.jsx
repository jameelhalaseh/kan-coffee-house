import React, { useState, useEffect, useRef, useCallback } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC, STORE_NAME, DEFAULT_FLOOR, TAX_RATE } from '../client.config';
import {
  money, r3, splitInclusiveTax, uid, nowParts, cashSuggestions, catColor,
} from '../lib';
import { HELD_KEY, PENDING_KEY, PAD_KEY, BC_NAME, DISPLAY_KEY } from '../constants';
import printReceipt from '../receipt';
import { beep } from '../sound';
import { Overlay, NumPad, qtyBtn } from '../components/ui';
import { categoryCards, inCat, CategoryGrid, CategoryHeader, catTitle } from '../components/categories';
import ProductModal from '../components/ProductModal';


const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (_) { return []; } };
// Network failure = fetch rejected before a response (our api errors always carry .status).
const isNetworkError = (ex) => ex && ex.status === undefined;

// ── Category browsing (shared by Sales and Inventory) ─────────────────────────
// Both screens use the same two-step model: pick a shelf, then work inside it.
//   cat === null → the grid below is showing
//   cat === 'all' → every product      cat === '' → products with no category
//   otherwise     → that category name
// ALL_CAT/NO_CAT are the sentinel values so neither screen invents its own.

function SalesView({ user, notify }) {
  const [products, setProducts] = useState([]);
  const [cart, setCart] = useState([]);          // [{id,barcode,name,price,qty}]
  // ONE query box, not two. There used to be a scan field and a separate search field
  // stacked on top of each other doing overlapping jobs, and the scanner's target was the
  // one that didn't say "search" — new staff picked wrong daily. Now: typing filters the
  // tiles live, Enter treats what you typed as a barcode. A scanner bursts characters and
  // sends Enter, so it lands on the barcode path without anyone aiming at anything.
  const [scan, setScan] = useState('');
  // null = browsing the category grid; 'all' or a category name = viewing that shelf's items.
  const [cat, setCat] = useState(null);
  const [pay, setPay] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [newProduct, setNewProduct] = useState(null); // {barcode} → modal
  const [editLine, setEditLine] = useState(null);      // cart line → qty/price keypad
  const [quickItem, setQuickItem] = useState(false);   // open-price misc item modal
  const [weighItem, setWeighItem] = useState(null);    // kg product → weight keypad
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(() => { try { return JSON.parse(localStorage.getItem(HELD_KEY)) || []; } catch (_) { return []; } });
  const [showHeld, setShowHeld] = useState(false);
  const [lastAdded, setLastAdded] = useState(null);   // {name, price, qty} → green flash in bill
  const [receipt, setReceipt] = useState(null);       // completed sale → print-or-skip popup
  const [showPad, setShowPad] = useState(() => localStorage.getItem(PAD_KEY) === '1');   // cash keypad, hidden by default
  const scanRef = useRef(null);
  const flashTimer = useRef(null);
  const flash = useCallback((line) => {
    setLastAdded(line);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setLastAdded(null), 1800);
  }, []);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const loadProducts = useCallback(async () => {
    try { setProducts(await api.get('/products')); } catch (_) {}
  }, []);
  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { scanRef.current && scanRef.current.focus(); }, []);
  const persistHeld = (list) => { setHeld(list); localStorage.setItem(HELD_KEY, JSON.stringify(list)); };

  const addToCart = useCallback((p, qty = 1) => {
    setCart((prev) => {
      const i = prev.findIndex((l) => l.id === p.id);
      if (i >= 0) { const next = [...prev]; next[i] = { ...next[i], qty: next[i].qty + qty }; return next; }
      return [...prev, { id: p.id, barcode: p.barcode, name: p.name, price: Number(p.price) || 0, qty, unit: p.unit || 'ea' }];
    });
    beep(true);
    flash({ name: p.name, price: Number(p.price) || 0, qty });
  }, [flash]);
  const refocus = () => scanRef.current && scanRef.current.focus();

  // Add a catalogue product: weighed (kg) products open the weight keypad; others add directly.
  const addProduct = (p) => {
    if (p.unit === 'kg') { setWeighItem(p); return; }
    addToCart(p); refocus();
  };

  const onScan = async (code) => {
    const c = String(code || '').trim();
    if (!c) return;
    setScan('');
    const local = products.find((p) => p.barcode && p.barcode === c);
    if (local) { addProduct(local); return; }
    try {
      const p = await api.get('/products/barcode/' + encodeURIComponent(c));
      setProducts((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
      addProduct(p);
    } catch (ex) {
      if (ex.status === 404) { beep(false); setNewProduct({ barcode: c }); }
      else { beep(false); notify(ARABIC ? 'تعذّر البحث' : 'Lookup failed', 'red'); }
    }
  };

  // ── Scanner hardening ───────────────────────────────────────────────────────
  // USB barcode scanners are keyboards: they burst characters fast and end with Enter.
  // If focus wandered off the scan input (cashier tapped a tile, closed a modal…), we
  // still capture the burst globally: keystrokes <100ms apart accumulate; Enter fires
  // the scan. Slow (human) typing outside an input is ignored, as is typing in inputs.
  const onScanRef = useRef(null);
  onScanRef.current = onScan;
  const modalOpenRef = useRef(false);
  modalOpenRef.current = !!(newProduct || editLine || quickItem || weighItem || showHeld || receipt);
  useEffect(() => {
    let buf = '';
    let lastTs = 0;
    const onKeyDown = (e) => {
      if (modalOpenRef.current) return;
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const now = Date.now();
      if (now - lastTs > 100) buf = '';       // gap too slow → human keys, restart buffer
      lastTs = now;
      if (e.key === 'Enter') {
        if (buf.length >= 4) { e.preventDefault(); onScanRef.current(buf); }
        buf = '';
      } else if (e.key.length === 1) {
        buf += e.key;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const setQty = (id, qty) => setCart((prev) => prev.flatMap((l) => (l.id === id ? (qty <= 0 ? [] : [{ ...l, qty }]) : [l])));
  const setLine = (id, patch) => setCart((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id) => setCart((prev) => prev.filter((l) => l.id !== id));
  const addCustom = ({ name, price, qty }) => setCart((prev) => [...prev, { id: 'misc-' + uid(), barcode: null, name, price: Number(price) || 0, qty: Number(qty) || 1, custom: true }]);

  const total = cart.reduce((s, l) => s + l.price * l.qty, 0);
  // Shelf prices in Jordan are VAT-INCLUSIVE, so the tax is extracted from the total rather
  // than added on top — the customer pays exactly the marked price. Checkout used to send
  // `tax: 0, sub: total` and never imported TAX_RATE at all, so every sale was recorded as
  // carrying no VAT: wrong on the receipt, wrong in the Z-report, and wrong on anything
  // filed with the ISTD. (If this client's prices are ever quoted NET of VAT, this is the
  // one place to change — and every shelf price rises by the rate.)
  const { net: netAmount, tax: taxAmount } = splitInclusiveTax(total, TAX_RATE);
  const change = pay === 'cash' && tendered ? (Number(tendered) - total) : null;

  // Push the live cart to the customer-facing display (2nd screen).
  useEffect(() => {
    const payload = { items: cart.map((l) => ({ name: l.name, price: l.price, qty: l.qty })), total, change, store: STORE_NAME };
    try { localStorage.setItem(DISPLAY_KEY, JSON.stringify(payload)); } catch (_) {}
    try { const bc = new BroadcastChannel(BC_NAME); bc.postMessage(payload); bc.close(); } catch (_) {}
  }, [cart, total, change]);
  const openDisplay = () => window.open(window.location.pathname + '?display=1', 'dukkan_customer', 'width=900,height=700');

  // Hold the current cart for later; clear the screen for the next customer.
  const holdSale = () => {
    if (!cart.length) return;
    persistHeld([...held, { id: uid(), items: cart, total, ts: new Date().toLocaleTimeString().slice(0, 5) }]);
    setCart([]); setTendered('');
    notify(ARABIC ? 'تم تعليق الفاتورة' : 'Sale held', 'green');
  };
  const resumeSale = (h) => {
    if (cart.length && !window.confirm(ARABIC ? 'استبدال الفاتورة الحالية؟' : 'Replace current bill?')) return;
    setCart(h.items); persistHeld(held.filter((x) => x.id !== h.id)); setShowHeld(false);
  };

  // ── Offline sales queue ────────────────────────────────────────────────────
  // A checkout that can't reach the server is stored locally (without an invoice
  // number) and synced automatically when the connection returns. Sync is serial
  // and stops on the first failure, so order is preserved and nothing is lost.
  const [pending, setPending] = useState(readPending);
  const persistPending = (list) => { setPending(list); localStorage.setItem(PENDING_KEY, JSON.stringify(list)); };
  const syncingRef = useRef(false);

  const syncPending = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    try {
      let list = readPending();
      let synced = 0;
      while (list.length) {
        const s = list[0];
        try {
          const invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
          await api.post('/orders', { ...s, invoice_no });
        } catch (ex) { break; }   // still unreachable (or rejected) — retry on next online event
        list = list.slice(1);
        synced += 1;
        localStorage.setItem(PENDING_KEY, JSON.stringify(list));
      }
      setPending(list);
      if (synced) {
        notify(ARABIC ? `تمت مزامنة ${synced} فاتورة معلّقة` : `Synced ${synced} offline sale${synced > 1 ? 's' : ''}`, 'green');
        loadProducts();
      }
    } finally { syncingRef.current = false; }
  }, [notify, loadProducts]);

  useEffect(() => {
    syncPending();   // flush anything left over from a previous session
    window.addEventListener('online', syncPending);
    return () => window.removeEventListener('online', syncPending);
  }, [syncPending]);

  const checkout = async () => {
    if (!cart.length || busy) return;
    setBusy(true);
    const { date, time } = nowParts();
    const sale = { id: uid(), floor: DEFAULT_FLOOR, items: cart, sub: r3(netAmount), tax: r3(taxAmount), svc: 0, disc: 0, total, pay, waiter: user.username, status: 'paid', date, time };
    // Sale is committed at this point — the popup only decides whether to print.
    const finish = (s) => { setReceipt({ ...s, change }); setCart([]); setTendered(''); setPay('cash'); };
    try {
      let invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
      try {
        // Server commits the order + stock deduction + stock log in ONE transaction.
        await api.post('/orders', { ...sale, invoice_no });
      } catch (ex) {
        if (ex.message === 'invoice_taken') {
          // Another terminal took this number — grab a fresh one and retry once.
          invoice_no = await api.get('/invoice/next?floor=' + DEFAULT_FLOOR);
          await api.post('/orders', { ...sale, invoice_no });
        } else throw ex;
      }
      finish({ ...sale, invoice_no });
      loadProducts();
      notify(ARABIC ? `تمت الفاتورة #${invoice_no}` : `Sale #${invoice_no} done`, 'green');
    } catch (ex) {
      if (isNetworkError(ex)) {
        // No server — keep the sale locally, print an OFFLINE receipt, move on.
        persistPending([...readPending(), sale]);
        finish({ ...sale, invoice_no: ARABIC ? 'غير متصل' : 'OFFLINE' });
        notify(ARABIC ? 'لا اتصال — حُفظت الفاتورة محلياً وستُزامن تلقائياً' : 'Offline — sale saved locally, will sync automatically', 'green');
      } else {
        notify(ex.message === 'invoice_taken' ? (ARABIC ? 'تعارض رقم الفاتورة، أعد المحاولة' : 'Invoice clash — retry') : (ARABIC ? 'فشل الدفع' : 'Checkout failed'), 'red');
      }
    } finally { setBusy(false); }
  };

  // Browse model: pick a category first, then its items. Searching cuts across every
  // category (you shouldn't have to guess the shelf to find a bottle), and a barcode scan
  // never touches this — it resolves straight to the product.
  const q = scan.trim();
  const searching = q.length > 0;
  const catCards = categoryCards(products);
  const browsing = !searching && cat === null;
  const tiles = products.filter((p) => {
    if (searching) {
      const s = q.toLowerCase();
      return (p.name || '').toLowerCase().includes(s) || (p.barcode || '').includes(q);
    }
    if (cat === null) return false;                 // category grid is showing instead
    return inCat(p, cat);
  });

  return (
    <div dir="ltr" style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* Left: scan + tap-to-add product tiles */}
      <div dir={ARABIC ? 'rtl' : 'ltr'} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <input ref={scanRef} style={{ ...S.input, width: '100%', fontSize: 18, padding: '14px', paddingInlineEnd: scan ? 44 : 14, letterSpacing: 1 }}
              value={scan} onChange={(e) => setScan(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onScan(scan);
                if (e.key === 'Escape') setScan('');
              }}
              placeholder={ARABIC ? '🔍 امسح الباركود أو ابحث بالاسم' : '🔍 Scan barcode or search by name'} inputMode="search" />
            {/* Clearing by hand is otherwise a long press on Backspace mid-queue. */}
            {scan && (
              <button onClick={() => { setScan(''); refocus(); }} aria-label={ARABIC ? 'مسح' : 'Clear'}
                style={{
                  position: 'absolute', insetInlineEnd: 6, top: '50%', transform: 'translateY(-50%)',
                  width: 32, height: 32, borderRadius: 8, border: 'none', background: 'transparent',
                  color: C.dim, fontSize: 18, cursor: 'pointer', fontFamily: 'inherit',
                }}>✕</button>
            )}
          </div>
          <button onClick={() => setQuickItem(true)} style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 }}>
            ＋ {ARABIC ? 'صنف يدوي' : 'Quick item'}
          </button>
          <button onClick={openDisplay} title={ARABIC ? 'شاشة الزبون' : 'Customer screen'} style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 }}>🖥</button>
          {!!held.length && (
            <button onClick={() => setShowHeld(true)} style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700 }}>
              ⏸ {ARABIC ? 'المعلّقة' : 'Held'} ({held.length})
            </button>
          )}
          {!!pending.length && (
            <button onClick={syncPending} title={ARABIC ? 'مبيعات بانتظار المزامنة — اضغط للمحاولة' : 'Sales waiting to sync — tap to retry'}
              style={{ ...S.btnGhost, whiteSpace: 'nowrap', fontSize: 15, fontWeight: 700, borderColor: C.red, color: C.red }}>
              ⇪ {pending.length}
            </button>
          )}
        </div>

        {/* Breadcrumb — only once you're inside a category (or searching across all of them). */}
        {!browsing && (
          <CategoryHeader
            title={searching ? (ARABIC ? 'نتائج البحث' : 'Search results') : catTitle(cat)}
            count={tiles.length}
            onBack={searching ? null : () => setCat(null)} />
        )}

        {browsing ? (
          /* Step 1 — the shelves. Tapping one drills into its items. */
          <CategoryGrid cards={catCards} total={products.length} onPick={setCat}
            emptyHint={ARABIC ? 'لا منتجات — أضفها من المخزون' : 'No products — add them in Inventory'} />
        ) : (
        /* Step 2 — the items on that shelf (or the search hits across all of them). */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(185px, 1fr))', gap: 12, alignContent: 'start' }}>
          {tiles.map((p) => (
            <button key={p.id} onClick={() => addProduct(p)} className="rise" style={{
              display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 6, height: 112, padding: '10px 12px 12px',
              borderRadius: 12, border: `1px solid ${C.line}`, borderTop: `3px solid ${catColor(p.cat)}`,
              background: `linear-gradient(180deg, ${catColor(p.cat, 0.10)} 0%, ${C.panel2} 55%)`,
              color: C.text, cursor: 'pointer', textAlign: 'start', fontFamily: 'inherit', overflow: 'hidden',
            }}>
              <span style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.25, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {p.name}{p.unit === 'kg' ? ' ⚖' : ''}
              </span>
              <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                <span style={{ color: C.accent, fontWeight: 800, fontSize: 16 }}>{money(p.price)}{p.unit === 'kg' ? (ARABIC ? '/كغ' : '/kg') : ''}</span>
                {/* A bare red pill reading "2" on a product tile reads as "2 in the cart",
                    which is the opposite of what it means. Say the word: it costs a few
                    pixels and removes the guess. Out of stock is worth its own wording —
                    the cashier should stop reaching for the shelf, not just hurry. */}
                {Number(p.stock) <= 0
                  ? <span style={{ fontSize: 11, color: '#fff', background: C.red, fontWeight: 800, borderRadius: 8, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                      {ARABIC ? 'نفد' : 'Out'}
                    </span>
                  : Number(p.stock) <= 5
                    ? <span title={ARABIC ? 'كمية منخفضة' : 'Low stock'}
                        style={{ fontSize: 11, color: C.red, border: `1px solid ${C.red}`, fontWeight: 800, borderRadius: 8, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                        {ARABIC ? `${Number(p.stock)} متبقٍ` : `${Number(p.stock)} left`}
                      </span>
                    : <span style={{ fontSize: 11, color: C.dim }}>{p.cat || ''}</span>}
              </span>
            </button>
          ))}
          {!tiles.length && (
            <div style={{ color: C.dim, fontSize: 15, gridColumn: '1/-1', padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 52, marginBottom: 12, opacity: .45 }}>{searching ? '🔍' : '📦'}</div>
              {searching
                ? (ARABIC ? 'لا نتائج مطابقة' : 'Nothing matches that search')
                : (ARABIC ? 'لا منتجات — أضفها من المخزون' : 'No products — add them in Inventory')}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Right: bill */}
      <div dir={ARABIC ? 'rtl' : 'ltr'} style={{ ...S.card, flex: '0 0 400px', width: 400, position: 'sticky', top: 16, padding: 0, overflow: 'hidden', boxShadow: '0 10px 40px rgba(0,0,0,.35)' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.accent}, #d98f1c)`, color: C.accentText, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 800, fontSize: 20 }}>🧾 {ARABIC ? 'الفاتورة' : 'Bill'}</span>
          <span style={{ background: 'rgba(15,17,23,.25)', borderRadius: 20, padding: '3px 12px', fontWeight: 800, fontSize: 14 }}>
            {cart.reduce((s, l) => s + l.qty, 0)} {ARABIC ? 'صنف' : 'items'}
          </span>
        </div>
        {lastAdded && (
          <div className="rise" style={{ background: 'rgba(62,207,142,.14)', borderBottom: `2px solid ${C.green}`, color: C.green, padding: '10px 18px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 800, fontSize: 17 }}>
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>✓ {lastAdded.name}{lastAdded.qty !== 1 ? ` × ${lastAdded.qty}` : ''}</span>
            <span style={{ flexShrink: 0 }}>{money(lastAdded.price * lastAdded.qty)}</span>
          </div>
        )}
        <div style={{ padding: 18 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '38vh', overflow: 'auto' }}>
          {!cart.length && (
            <div style={{ color: C.dim, fontSize: 15, padding: '34px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 44, marginBottom: 10, opacity: .5 }}>🛒</div>
              {ARABIC ? 'اضغط أو امسح منتجاً للبدء' : 'Tap or scan a product to start'}
            </div>
          )}
          {cart.map((l) => (
            <div key={l.id} className="rise" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px dashed ${C.line}` }}>
              <button onClick={() => setEditLine(l)} style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', textAlign: 'start', cursor: 'pointer', color: C.text, fontFamily: 'inherit', padding: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name} <span style={{ fontSize: 12, color: C.dim }}>✎</span></div>
                <div style={{ fontSize: 13, color: C.accent, fontWeight: 700 }}>{money(l.price)} × {l.qty} = {money(l.price * l.qty)}</div>
              </button>
              <button onClick={() => setQty(l.id, l.qty - 1)} style={qtyBtn}>−</button>
              <span style={{ minWidth: 28, textAlign: 'center', fontWeight: 800, fontSize: 16 }}>{l.qty}</span>
              <button onClick={() => setQty(l.id, l.qty + 1)} style={qtyBtn}>+</button>
              <button onClick={() => removeLine(l.id)} style={{ ...qtyBtn, color: C.red, borderColor: C.red }}>×</button>
            </div>
          ))}
        </div>
        <div style={{ margin: '14px 0', background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 16px' }}>
          {/* "How much is the tax?" is a question cashiers get asked at the counter. It used
              to be unanswerable without printing the receipt first. */}
          {TAX_RATE > 0 && total > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, fontSize: 14, color: C.dim }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{ARABIC ? 'المجموع الفرعي' : 'Subtotal'}</span><span>{money(netAmount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{ARABIC ? `ضريبة ${Math.round(TAX_RATE * 100)}% (مشمولة)` : `VAT ${Math.round(TAX_RATE * 100)}% (incl.)`}</span>
                <span>{money(taxAmount)}</span>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 26, fontWeight: 800 }}>
            <span style={{ fontSize: 17, color: C.dim }}>{ARABIC ? 'المجموع' : 'Total'}</span><span style={{ color: C.accent }}>{money(total)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {['cash', 'card'].map((m) => (
            <button key={m} onClick={() => setPay(m)} style={{ ...S.btnGhost, flex: 1, padding: '14px', fontSize: 16, ...(pay === m ? { background: C.blue, color: '#fff', borderColor: C.blue } : {}) }}>
              {m === 'cash' ? (ARABIC ? '💵 نقدي' : '💵 Cash') : (ARABIC ? '💳 بطاقة' : '💳 Card')}
            </button>
          ))}
        </div>
        {pay === 'cash' && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ ...S.input, fontSize: 20, fontWeight: 800, padding: '12px 14px', textAlign: 'center', color: tendered ? C.text : C.dim }}>
              {tendered || (ARABIC ? 'المبلغ المدفوع' : 'Cash given')}
            </div>
            {/* Smart suggestions: exact + the likely notes handed over (≥ total, deduped) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, marginTop: 8 }}>
              <button onClick={() => setTendered(total.toFixed(3))} style={{ ...S.btnGhost, padding: '12px', fontWeight: 800, borderColor: C.green, color: C.green }}>{ARABIC ? 'بالضبط' : 'Exact'}</button>
              {cashSuggestions(total).map((d) => (
                <button key={d} onClick={() => setTendered(String(d))} style={{ ...S.btnGhost, padding: '12px', fontWeight: 700 }}>{d}</button>
              ))}
            </div>
            {/* Touch keypad — optional; collapsed by default (suggestion buttons cover most cases) */}
            <button onClick={() => { const v = !showPad; setShowPad(v); localStorage.setItem(PAD_KEY, v ? '1' : '0'); }}
              style={{ ...S.btnGhost, width: '100%', padding: '9px', marginTop: 8, fontSize: 13, color: C.dim }}>
              {showPad ? (ARABIC ? '▲ إخفاء لوحة الأرقام' : '▲ Hide keypad') : (ARABIC ? '▼ إظهار لوحة الأرقام' : '▼ Show keypad')}
            </button>
            {showPad && (
              <div className="rise" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginTop: 8 }}>
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'].map((d) => (
                  <button key={d} onClick={() => setTendered((v) => (d === '.' && v.includes('.') ? v : v + d))}
                    style={{ ...S.btnGhost, padding: '13px 0', fontSize: 18, fontWeight: 800 }}>{d}</button>
                ))}
                <button onClick={() => setTendered((v) => v.slice(0, -1))} style={{ ...S.btnGhost, padding: '13px 0', fontSize: 18, color: C.red }}>⌫</button>
              </div>
            )}
            {change != null && change >= 0 && (
              <div style={{ background: 'rgba(62,207,142,.12)', border: `1px solid ${C.green}`, borderRadius: 10, padding: '10px 14px', marginTop: 8, display: 'flex', justifyContent: 'space-between', color: C.green, fontSize: 19, fontWeight: 800 }}>
                <span>{ARABIC ? 'الباقي' : 'Change'}</span><span>{money(change)}</span>
              </div>
            )}
            {change != null && change < 0 && <div style={{ color: C.red, fontSize: 15, marginTop: 8, fontWeight: 700 }}>{ARABIC ? 'ناقص' : 'Short'}: {money(-change)}</div>}
          </div>
        )}
        <button onClick={checkout} disabled={!cart.length || busy} style={{ ...S.btn, width: '100%', padding: '18px', fontSize: 19, opacity: (!cart.length || busy) ? 0.5 : 1 }}>
          {busy ? '…' : (ARABIC ? '✓ إتمام وطباعة' : '✓ Pay & Print')}
        </button>
        {!!cart.length && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={holdSale} style={{ ...S.btnGhost, flex: 1, padding: '12px' }}>⏸ {ARABIC ? 'تعليق' : 'Hold'}</button>
            <button onClick={() => { setCart([]); setTendered(''); }} style={{ ...S.btnGhost, flex: 1, padding: '12px', color: C.red }}>✕ {ARABIC ? 'إلغاء' : 'Clear'}</button>
          </div>
        )}
        </div>
      </div>

      {newProduct && (
        <ProductModal initial={newProduct} notify={notify}
          onClose={() => { setNewProduct(null); scanRef.current && scanRef.current.focus(); }}
          onSaved={(p) => { setProducts((prev) => [...prev, p]); addToCart(p); setNewProduct(null); scanRef.current && scanRef.current.focus(); }} />
      )}

      {showHeld && (
        <Overlay onClose={() => setShowHeld(false)}>
          <div style={{ ...S.card, width: 360, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>⏸ {ARABIC ? 'الفواتير المعلّقة' : 'Held sales'}</div>
            {!held.length && <div style={{ color: C.dim }}>{ARABIC ? 'لا شيء' : 'None'}</div>}
            {held.map((h) => (
              <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: `1px solid ${C.line}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700 }}>{money(h.total)} <span style={{ color: C.dim, fontSize: 12 }}>· {h.items.length} {ARABIC ? 'صنف' : 'items'} · {h.ts}</span></div>
                </div>
                <button onClick={() => resumeSale(h)} style={{ ...S.btn, padding: '8px 14px' }}>{ARABIC ? 'استئناف' : 'Resume'}</button>
                <button onClick={() => persistHeld(held.filter((x) => x.id !== h.id))} style={{ ...S.btnGhost, padding: '8px 10px', color: C.red }}>×</button>
              </div>
            ))}
          </div>
        </Overlay>
      )}

      {editLine && (
        <LineEditModal line={editLine}
          onClose={() => setEditLine(null)}
          onApply={(qty, price) => { if (qty <= 0) removeLine(editLine.id); else setLine(editLine.id, { qty, price }); setEditLine(null); }}
          onRemove={() => { removeLine(editLine.id); setEditLine(null); }} />
      )}
      {quickItem && (
        <QuickItemModal notify={notify} onClose={() => setQuickItem(false)}
          onAdd={(it) => { addCustom(it); setQuickItem(false); }} />
      )}
      {weighItem && (
        <WeightModal product={weighItem} notify={notify}
          onClose={() => { setWeighItem(null); refocus(); }}
          onAdd={(kg) => { addToCart(weighItem, kg); setWeighItem(null); refocus(); }} />
      )}
      {receipt && <ReceiptModal sale={receipt} onClose={() => { setReceipt(null); refocus(); }} />}
    </div>
  );
}

// Post-payment popup: bill summary + "Print" or paperless "Done". The sale is already
// saved — this only decides whether paper comes out.

function ReceiptModal({ sale, onClose }) {
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 380, display: 'flex', flexDirection: 'column', gap: 0, padding: 0, overflow: 'hidden' }}>
        <div style={{ background: `linear-gradient(135deg, ${C.green}, #2aa872)`, color: '#0f1117', padding: '16px 20px', textAlign: 'center' }}>
          <div style={{ fontSize: 34, lineHeight: 1 }}>✓</div>
          <div style={{ fontWeight: 800, fontSize: 19, marginTop: 4 }}>{ARABIC ? 'تم الدفع' : 'Payment complete'}</div>
          <div style={{ fontSize: 13, fontWeight: 700, opacity: 0.75 }}>{ARABIC ? 'فاتورة' : 'Invoice'} #{sale.invoice_no} · {sale.date} {String(sale.time).slice(0, 5)}</div>
        </div>
        <div style={{ padding: '14px 20px', maxHeight: '38vh', overflow: 'auto' }}>
          {(sale.items || []).map((l, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderBottom: `1px dashed ${C.line}`, fontSize: 14 }}>
              <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{l.name} <span style={{ color: C.dim }}>× {l.qty}</span></span>
              <span style={{ flexShrink: 0, fontWeight: 700 }}>{money(l.price * l.qty)}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, fontWeight: 800, fontSize: 19 }}>
            <span>{ARABIC ? 'المجموع' : 'Total'}</span><span style={{ color: C.accent }}>{money(sale.total)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 4, fontSize: 14, color: C.dim }}>
            <span>{sale.pay === 'cash' ? (ARABIC ? '💵 نقدي' : '💵 Cash') : (ARABIC ? '💳 بطاقة' : '💳 Card')}</span>
            {sale.change != null && sale.change >= 0 && <span style={{ color: C.green, fontWeight: 800 }}>{ARABIC ? 'الباقي' : 'Change'}: {money(sale.change)}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, padding: '0 20px 18px' }}>
          <button onClick={() => { printReceipt(sale); onClose(); }} style={{ ...S.btnGhost, flex: 1, padding: '16px', fontSize: 16, fontWeight: 800 }}>
            🖨 {ARABIC ? 'طباعة' : 'Print'}
          </button>
          <button onClick={onClose} autoFocus style={{ ...S.btn, flex: 1.4, padding: '16px', fontSize: 16, background: C.green }}>
            🌿 {ARABIC ? 'تم — بدون طباعة' : 'Done — no paper'}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Weighed item: enter weight in kg on a keypad; line qty = weight, price = per-kg ──
function WeightModal({ product, onClose, onAdd, notify }) {
  const [kg, setKg] = useState('');
  const onKey = (ch) => setKg((v) => (ch === '.' && v.includes('.') ? v : v + ch));
  const w = Number(kg) || 0;
  const submit = () => { if (!(w > 0)) { notify(ARABIC ? 'أدخل الوزن' : 'Enter weight', 'red'); return; } onAdd(w); };
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>⚖ {product.name}</div>
        <div style={{ color: C.dim, fontSize: 13 }}>{money(product.price)}{ARABIC ? ' / كغ' : ' / kg'}</div>
        <div style={{ ...S.input, fontSize: 22, fontWeight: 800, textAlign: 'center' }}>{kg || '0'} {ARABIC ? 'كغ' : 'kg'}</div>
        <div style={{ textAlign: 'center', color: C.accent, fontWeight: 800, fontSize: 20 }}>= {money(w * (Number(product.price) || 0))}</div>
        <NumPad onKey={onKey} onClear={() => setKg('')} onBackspace={() => setKg((v) => v.slice(0, -1))} />
        <button onClick={submit} style={{ ...S.btn, padding: '14px', fontSize: 16 }}>{ARABIC ? 'إضافة للفاتورة' : 'Add to bill'}</button>
      </div>
    </Overlay>
  );
}
// ── Edit a cart line: set quantity + override price via keypad ───────────────────
function LineEditModal({ line, onClose, onApply, onRemove }) {
  const [field, setField] = useState('qty');
  const [qty, setQty] = useState(String(line.qty));
  const [price, setPrice] = useState(String(line.price));
  const set = field === 'qty' ? setQty : setPrice;
  const onKey = (ch) => set((v) => (ch === '.' && v.includes('.') ? v : (v === '0' && ch !== '.' ? ch : v + ch)));
  const tab = (name, label, val) => (
    <button type="button" onClick={() => setField(name)} style={{ flex: 1, padding: '12px', borderRadius: 8, border: `1px solid ${field === name ? C.accent : C.line}`, background: field === name ? C.accent : C.panel2, color: field === name ? C.accentText : C.text, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
      <div style={{ fontSize: 12 }}>{label}</div><div style={{ fontSize: 18 }}>{val || '0'}</div>
    </button>
  );
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{line.name}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {tab('qty', ARABIC ? 'الكمية' : 'Qty', qty)}
          {tab('price', ARABIC ? 'السعر' : 'Price', price)}
        </div>
        <NumPad onKey={onKey} onClear={() => set('')} onBackspace={() => set((v) => v.slice(0, -1))} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onApply(Number(qty) || 0, Number(price) || 0)} style={{ ...S.btn, flex: 1, padding: '14px', fontSize: 16 }}>{ARABIC ? 'حفظ' : 'Save'}</button>
          <button onClick={onRemove} style={{ ...S.btnGhost, padding: '14px', color: C.red }}>{ARABIC ? 'حذف' : 'Remove'}</button>
        </div>
      </div>
    </Overlay>
  );
}

// ── Open-price "misc" item: type a name + price for something with no barcode ────
function QuickItemModal({ onClose, onAdd, notify }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const onKey = (ch) => setPrice((v) => (ch === '.' && v.includes('.') ? v : v + ch));
  const submit = () => {
    if (!name.trim()) { notify(ARABIC ? 'الاسم مطلوب' : 'Name required', 'red'); return; }
    if (!(Number(price) > 0)) { notify(ARABIC ? 'السعر مطلوب' : 'Price required', 'red'); return; }
    onAdd({ name: name.trim(), price: Number(price), qty: 1 });
  };
  return (
    <Overlay onClose={onClose}>
      <div style={{ ...S.card, width: 320, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>{ARABIC ? 'صنف يدوي' : 'Quick item'}</div>
        <input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder={ARABIC ? 'الاسم' : 'Name'} autoFocus />
        <div style={{ ...S.input, fontSize: 20, fontWeight: 800, textAlign: 'center', color: C.accent }}>{price || '0'}</div>
        <NumPad onKey={onKey} onClear={() => setPrice('')} onBackspace={() => setPrice((v) => v.slice(0, -1))} />
        <button onClick={submit} style={{ ...S.btn, padding: '14px', fontSize: 16 }}>{ARABIC ? 'إضافة للفاتورة' : 'Add to bill'}</button>
      </div>
    </Overlay>
  );
}

// ── Add/Edit product modal (shared by Sales quick-add + Inventory) ──────────────

export default SalesView;
export { SalesView };
