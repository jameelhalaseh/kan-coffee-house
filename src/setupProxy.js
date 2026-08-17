// DEV-SERVER ONLY. Not bundled, not used by `npm run build`, never runs in production —
// there, Express serves the React build and the API from one origin, so nothing to proxy.
//
// WHY THIS FILE EXISTS RATHER THAN `"proxy"` IN package.json
//
// public/index.html loads `<script src="/client-config.js">` before the bundle, and the API
// answers that path with `window.__CLIENT__ = {…}` — this shop's real name, tax rate,
// invoice prefix and nav views, read from .env at boot.
//
// The plain `"proxy": "…"` shorthand is not enough. CRA configures webpack-dev-server's
// historyApiFallback with `disableDotRule: true`, which makes it rewrite even a path ending
// in `.js` to index.html whenever the request accepts `*/*` — which is exactly what a
// browser's classic `<script src>` sends. So the browser received index.html, tried to parse
// HTML as JavaScript, and threw `SyntaxError: Unexpected token '<'`.
//
// The failure was quiet and therefore dangerous: index.html loads that script with no
// integrity check and the app falls back to the literals in src/client.config.js when
// window.__CLIENT__ is absent. The page still rendered "Kan Coffee House" — because those
// fallbacks happen to hold Kan's values — while silently ignoring .env entirely. The
// visible symptom was CLIENT_VIEWS being ignored, so the nav showed every view including
// the AI Assistant this shop deliberately switched off.
//
// setupProxy.js is mounted ahead of historyApiFallback, so these paths are forwarded before
// the rewrite can touch them.
const { createProxyMiddleware } = require('http-proxy-middleware');

// Where the API is listening in local development. 3003 for this shop (3001 and 3002 are
// taken by other projects on this machine) — see PORT in .env.
const API = process.env.REACT_APP_DEV_API_ORIGIN || 'http://localhost:3003';

// Only paths the API owns. Everything else stays with the dev server so hot reload,
// source maps and the websocket keep working.
const API_PATHS = [
  '/client-config.js',  // window.__CLIENT__ — the whole point of this file
  '/api',               // the REST API
  '/healthz',           // liveness
  '/brand',             // per-client artwork, if the branding code is ever added
];

module.exports = function (app) {
  app.use(
    createProxyMiddleware(API_PATHS, {
      target: API,
      changeOrigin: false,   // the API is same-host in dev; keep the Host header honest
      logLevel: 'warn',
      // A dev server that silently swallows a dead API is how you end up debugging the
      // React app for an hour when the problem is that `npm run server` is not running.
      onError(err, req, res) {
        const msg = `[setupProxy] ${req.method} ${req.url} -> ${API} failed: ${err.code || err.message}. Is \`npm run server\` running?`;
        console.error(msg);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(msg);
      },
    })
  );
};
