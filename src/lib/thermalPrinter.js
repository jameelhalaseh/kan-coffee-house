// Thermal printer + cash drawer over Web Serial (Windows + Epson TM via USB Virtual Port).
//
// Flow: rasterize the on-screen receipt DOM -> monochrome bitmap at the printer's dot
// width -> ESC/POS raster (GS v 0) -> append DRAWER_KICK -> write to the COM port the
// Epson "TM Virtual Port Driver" exposes for the USB printer.
//
// Why raster (not ESC/POS text): receipts are Arabic; the printer's codepages can't
// render Arabic faithfully, so we print an image of exactly what's on screen.
//
// Setup per register (one-time): install Epson "TM Virtual Port Driver", which makes the
// USB printer appear as a COMx port; then click Connect once to grant Web Serial access.
import { toCanvas } from 'html-to-image';

// 80mm head = 576 dots; 58mm = 384. Override via setPrinterWidth() or localStorage.
let WIDTH_DOTS = Number((typeof localStorage !== 'undefined' && localStorage.getItem('pos_print_width')) || 576) || 576;
export const setPrinterWidth = (n) => { WIDTH_DOTS = Number(n) || 576; };
export const getPrinterWidth = () => WIDTH_DOTS;

// ESC/POS drawer kick: ESC p m t1 t2 — pops the drawer wired into the printer's RJ-11.
const DRAWER_KICK = [0x1b, 0x70, 0x00, 0x19, 0xfa];
const INIT = [0x1b, 0x40];                 // ESC @  (reset)
const FEED_CUT = [0x0a, 0x0a, 0x0a, 0x1d, 0x56, 0x42, 0x00]; // feed 3 + partial cut

export const serialSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

// ── Transport mode ────────────────────────────────────────────────────────────
// 'serial' = Web Serial (USB printer w/ virtual COM, e.g. Epson TM).
// 'bridge' = POST ESC/POS bytes to a local helper that RAW-prints to the Windows
//            printer queue — for LAN / generic USB printers with no COM port.
const LS = (typeof localStorage !== 'undefined') ? localStorage : { getItem: () => null, setItem: () => {} };
// Bridge (network) printing is allowed ONLY on the Dealer floor. Every other floor is
// hard-forced to USB serial, so toggling can never affect GG.
const BRIDGE_FLOOR = 'dealer';
export const getPrintMode = (floor) => {
  if (floor && floor !== BRIDGE_FLOOR) return 'serial';
  return LS.getItem('pos_print_mode') || 'serial';
};
export const setPrintMode = (m) => LS.setItem('pos_print_mode', m === 'bridge' ? 'bridge' : 'serial');
export const bridgeAllowed = (floor) => floor === BRIDGE_FLOOR;
export const getBridgeUrl = () => LS.getItem('pos_bridge_url') || 'http://localhost:9110';
export const setBridgeUrl = (u) => LS.setItem('pos_bridge_url', u || 'http://localhost:9110');
export const getBridgePrinter = () => LS.getItem('pos_bridge_printer') || ''; // '' = default printer
export const setBridgePrinter = (n) => LS.setItem('pos_bridge_printer', n || '');

let _port = null;
let _bridgeOk = false;

function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

// Reuse an already-granted port (survives reloads) or prompt once. Must be called from a
// user gesture the first time (Chrome requirement for requestPort).
export async function ensurePort(prompt = false) {
  if (!serialSupported()) throw new Error('Web Serial not supported in this browser');
  if (_port) return _port;
  const granted = await navigator.serial.getPorts();
  if (granted && granted.length) { _port = granted[0]; return _port; }
  if (!prompt) throw new Error('No printer connected — click Connect first');
  _port = await navigator.serial.requestPort();
  return _port;
}

// Open the port only if it isn't already open — repeated open() on an open port throws
// "The port is already open." We keep the port open across jobs and just re-take the writer.
async function ensureOpen(port) {
  if (!port.readable) {
    try { await port.open({ baudRate: 9600 }); }
    catch (e) { if (!/already open/i.test(e.message || '')) throw e; }
  }
}

export async function connectPrinter(floor) {
  if (getPrintMode(floor) === 'bridge') {
    // Validate the local bridge is running.
    const r = await fetch(getBridgeUrl() + '/health', { method: 'GET' }).catch(() => null);
    if (!r || !r.ok) throw new Error('Bridge not reachable at ' + getBridgeUrl() + ' — is the print helper running?');
    _bridgeOk = true;
    return true;
  }
  // Always open the picker so the user can switch/override the printer.
  if (!serialSupported()) throw new Error('Web Serial not supported in this browser');
  // Release any previously-open port before switching.
  if (_port && _port.readable) { try { await _port.close(); } catch {} }
  const port = await navigator.serial.requestPort();
  _port = port;
  await ensureOpen(port); // validate it opens; leave it open for printing
  return true;
}

export function isConnected(floor) { return getPrintMode(floor) === 'bridge' ? _bridgeOk : !!_port; }

// text/plain keeps the request "simple" (no CORS preflight); the bridge base64-decodes it.
async function writeBytesBridge(bytes) {
  const url = getBridgeUrl() + '/print' + (getBridgePrinter() ? ('?printer=' + encodeURIComponent(getBridgePrinter())) : '');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bytesToB64(bytes) });
  if (!r.ok) throw new Error('Bridge print failed (' + r.status + ')');
  _bridgeOk = true;
}

// Serialize jobs so two prints (or print + drawer) never race the same port open/writer.
let _chain = Promise.resolve();
function serialize(fn) {
  const run = _chain.then(fn, fn);
  _chain = run.catch(() => {});
  return run;
}

async function writeBytesSerial(bytes) {
  return serialize(async () => {
    const port = await ensurePort(false);
    await ensureOpen(port);
    const writer = port.writable.getWriter();
    try {
      const CHUNK = 4096;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        await writer.write(bytes.subarray(i, i + CHUNK));
      }
    } finally {
      try { writer.releaseLock(); } catch {} // keep the port + writable open for the next job
    }
  });
}

async function writeBytes(bytes, floor) {
  if (getPrintMode(floor) === 'bridge') return writeBytesBridge(bytes);
  return writeBytesSerial(bytes);
}

// Logical render width (CSS px); upscaled to the printer's dot width via pixelRatio.
const CONTENT_W = 384;

// Render an offscreen white/black copy of receipt markup, then rasterize at the printer
// dot width. The receipt CSS targets the `body` selector, so we re-scope `body{` to the
// wrapper class `.__rcp` — otherwise none of the layout/font rules apply and the capture
// comes out blank.
async function rasterizeHTML(bodyHTML, css) {
  const scoped = String(css).replace(/(^|[},])\s*body\b/g, '$1 .__rcp');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;background:#fff;';
  host.innerHTML =
    `<style>${scoped}</style>` +
    `<div class="__rcp" style="width:${CONTENT_W}px;max-width:none;margin:0;background:#fff;color:#000">${bodyHTML}</div>`;
  document.body.appendChild(host);
  try {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }
    const target = host.firstElementChild.nextElementSibling; // the .__rcp div
    const canvas = await toCanvas(target, {
      pixelRatio: WIDTH_DOTS / CONTENT_W,
      backgroundColor: '#ffffff',
    });
    if (!canvas.width || !canvas.height) throw new Error('empty receipt capture');
    return canvas;
  } finally {
    document.body.removeChild(host);
  }
}

// Canvas -> ESC/POS raster bytes (GS v 0), bands of <=255 rows for firmware safety.
function canvasToEscpos(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, w, h);
  const bytesPerRow = Math.ceil(w / 8);
  const out = [];
  const BAND = 255;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const rows = Math.min(BAND, h - y0);
    const xL = bytesPerRow & 0xff, xH = (bytesPerRow >> 8) & 0xff;
    const yL = rows & 0xff, yH = (rows >> 8) & 0xff;
    out.push(0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH);
    for (let y = 0; y < rows; y++) {
      for (let bx = 0; bx < bytesPerRow; bx++) {
        let byte = 0;
        for (let bit = 0; bit < 8; bit++) {
          const x = bx * 8 + bit;
          if (x >= w) continue;
          const idx = ((y0 + y) * w + x) * 4;
          const a = data[idx + 3];
          // luminance; transparent treated as white
          const lum = a === 0 ? 255 : (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
          if (lum < 128) byte |= (0x80 >> bit); // dark dot -> print bit
        }
        out.push(byte);
      }
    }
  }
  return out;
}

// Print receipt image (+ optional drawer kick). Throws on failure so the caller can fall back.
export async function printReceiptHTML(bodyHTML, css, { kick = true, floor } = {}) {
  const canvas = await rasterizeHTML(bodyHTML, css);
  const raster = canvasToEscpos(canvas);
  // Kick BEFORE feed+cut — some firmwares drop a kick that arrives after a partial cut.
  const bytes = [...INIT, ...raster, ...(kick ? DRAWER_KICK : []), ...FEED_CUT];
  await writeBytes(Uint8Array.from(bytes), floor);
}

// Drawer only (no print) — e.g. a "no sale" open.
export async function openDrawer(floor) {
  await writeBytes(Uint8Array.from([...INIT, ...DRAWER_KICK]), floor);
}
