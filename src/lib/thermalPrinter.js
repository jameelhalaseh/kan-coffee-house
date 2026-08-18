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

// ── Transport ─────────────────────────────────────────────────────────────────
// Web Serial only: a USB printer with a virtual COM port (e.g. Epson TM), which is what Kan
// has. Web Serial needs a SECURE CONTEXT, so a real host must be HTTPS — `localhost` counts,
// which is why printing works in development.
//
// There was a second transport: POST the ESC/POS bytes to a local helper that RAW-printed to
// the Windows queue, for LAN printers with no COM port. It was gated to `BRIDGE_FLOOR =
// 'dealer'` - a floor from the two-restaurant ancestor - and this build has exactly one floor,
// `main` (server/floors.js). So every one of its branches was unreachable: getPrintMode()
// always returned 'serial' and bridgeAllowed() was always false. It has been removed along
// with its helper script and its CSP grant, rather than left as code that reads like a feature.

let _port = null;

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

export async function connectPrinter() {
  // Always open the picker so the user can switch/override the printer.
  if (!serialSupported()) throw new Error('Web Serial not supported in this browser');
  // Release any previously-open port before switching.
  if (_port && _port.readable) { try { await _port.close(); } catch {} }
  const port = await navigator.serial.requestPort();
  _port = port;
  await ensureOpen(port); // validate it opens; leave it open for printing
  return true;
}

export function isConnected() { return !!_port; }

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

async function writeBytes(bytes) {
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
export async function printReceiptHTML(bodyHTML, css, { kick = true } = {}) {
  const canvas = await rasterizeHTML(bodyHTML, css);
  const raster = canvasToEscpos(canvas);
  // Kick BEFORE feed+cut — some firmwares drop a kick that arrives after a partial cut.
  const bytes = [...INIT, ...raster, ...(kick ? DRAWER_KICK : []), ...FEED_CUT];
  await writeBytes(Uint8Array.from(bytes));
}

// Drawer only (no print) — e.g. a "no sale" open.
export async function openDrawer() {
  await writeBytes(Uint8Array.from([...INIT, ...DRAWER_KICK]));
}
