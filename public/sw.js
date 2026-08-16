// Service worker — keeps the till usable when the server is not.
//
// WHAT THIS USED TO DO
// It cached nothing. It intercepted navigations, tried the network, and on failure served a
// hardcoded "No internet connection — press Retry" page. That is an offline NOTICE, not
// offline capability: a shop whose connection dropped got a dead end the moment anyone
// reloaded, and the app's own offline sales queue was unreachable behind it, because you
// have to load the app to use it. It also deleted every cache on activate, so nothing could
// accumulate even by accident.
//
// WHAT IT DOES NOW
// Caches the app shell as it is fetched, and serves it when the network is gone. A till that
// has loaded the app once keeps loading it — logged in, with its queue — through an outage.
//
// WHAT IT DELIBERATELY DOES NOT CACHE
// /api/*. Ever. Prices, stock levels and sales are the things a POS must never show a stale
// copy of: a cashier selling from a cached catalogue at yesterday's prices, or reading a
// stock figure that has since gone to zero, is worse off than one who can see the connection
// is down. Those requests are left to fail, which is also what tells src/sync.js the server
// is unreachable so the badge can go red.
const VERSION = 'v2';
const CACHE = `pos-shell-${VERSION}`;

// Fetched at install so the shell survives an outage that begins before the first reload.
// Only the entry point: everything hashed under /static/ is picked up as it is requested,
// because its filenames contain a build hash this file cannot know in advance.
const PRECACHE = ['/', '/manifest.json'];

// Last resort, for a browser that has never successfully loaded the app — there is nothing
// cached to fall back to and nothing useful it can do offline.
const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>7T POS - offline</title><style>html,body{height:100%;margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e6e6e6;display:flex;align-items:center;justify-content:center}.b{text-align:center;padding:24px}.t{font-size:22px;font-weight:800;margin-bottom:8px}.s{color:#9aa0aa;font-size:14px;margin-bottom:20px}button{padding:11px 24px;border:0;border-radius:9px;background:#f0a830;color:#0f1117;font-weight:700;font-size:14px;cursor:pointer}</style></head><body><div class="b"><div class="t">No internet connection</div><div class="s">7T POS could not be loaded on this device yet. Connect once, and it will keep working offline afterwards.</div><button onclick="location.reload()">Retry</button></div></body></html>`;

self.addEventListener('install', (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // Individually, not addAll: addAll rejects the whole install if any single request fails,
  // and an install that fails leaves the shop with the old do-nothing worker.
  await Promise.all(PRECACHE.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'reload' });
      if (res.ok) await cache.put(url, res);
    } catch (_) { /* offline at install time; it will be cached on first successful fetch */ }
  }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Only OTHER versions. The previous worker deleted every cache on every activate, which is
  // why nothing could ever be served offline.
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

const isStatic = (p) => p.startsWith('/static/');

async function putIfOk(request, res) {
  // Only real, complete, same-origin successes. An opaque or partial response cached here
  // would be served back as though it were the page.
  if (!res || !res.ok || res.type !== 'basic' || res.status === 206) return res;
  const cache = await caches.open(CACHE);
  cache.put(request, res.clone()).catch(() => {});
  return res;
}

// Network wins when it can, cache covers when it cannot. Used for the shell and the config,
// so a deploy is picked up on the next load rather than being pinned by the cache.
async function networkFirst(request, fallbackKey) {
  try {
    return await putIfOk(request, await fetch(request));
  } catch (_) {
    const hit = await caches.match(request) || (fallbackKey && await caches.match(fallbackKey));
    if (hit) return hit;
    throw new Error('offline and uncached');
  }
}

// For /static/: the filename contains a build hash, so its contents can never change under
// that name. Going to the network first for it would be a round trip to be told nothing.
async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  return putIfOk(request, await fetch(request));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;                        // never cache a sale
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;             // fonts, print bridge, Sentry
  if (url.pathname.startsWith('/api/')) return;                // see the note at the top
  if (request.headers.has('range')) return;                    // video seeking (login-bg.mp4)

  // A navigation is the whole point: this is the reload during an outage that used to hit a
  // dead end. Falls back to the cached shell, and only then to the notice.
  if (request.mode === 'navigate') {
    event.respondWith(
      networkFirst(request, '/').catch(
        () => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      )
    );
    return;
  }

  if (isStatic(url.pathname)) { event.respondWith(cacheFirst(request)); return; }

  // Everything else same-origin: /client-config.js, icons, images, the manifest. Network
  // first so a shop's renamed identity or a new icon is picked up, cache when it is not
  // reachable. client-config.js matters here — without it the bundle falls back to the
  // built-in defaults and an offline till would show the wrong shop's name on its receipts.
  event.respondWith(networkFirst(request).catch(() => caches.match(request)));
});
