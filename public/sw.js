self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Purge any caches a previous SW version may have created so no stale bundle survives.
  const keys = await caches.keys();
  await Promise.all(keys.map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

const OFFLINE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>7T POS - offline</title><style>html,body{height:100%;margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:#0f1117;color:#e6e6e6;display:flex;align-items:center;justify-content:center}.b{text-align:center;padding:24px}.t{font-size:22px;font-weight:800;margin-bottom:8px}.s{color:#9aa0aa;font-size:14px;margin-bottom:20px}button{padding:11px 24px;border:0;border-radius:9px;background:#f0a830;color:#0f1117;font-weight:700;font-size:14px;cursor:pointer}</style></head><body><div class="b"><div class="t">No internet connection</div><div class="s">7T POS needs to reach the server. Check the connection and press Retry.</div><button onclick="location.reload()">Retry</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(
        () => new Response(OFFLINE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      )
    );
  }
});