/**
 * CashierPOS — Local Sync Server
 * Runs on your local WiFi network.
 * Both machines connect to this and share kitchen + menu state.
 * No internet required.
 */

const WebSocket = require('ws');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const PORT = process.env.PORT || 3001;

// ── Shared state (in memory) ──────────────────────
let state = {
  kq:   [],      // kitchen queue
  menu: [],      // menu items
  inv:  {},      // inventory
};

// ── HTTP server (serves a status page) ────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: wss.clients.size,
      orders: state.kq.length,
      menu: state.menu.length,
      uptime: Math.floor(process.uptime()) + 's',
    }));
    return;
  }

  // Status page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html>
<html>
<head>
  <title>CashierPOS Server</title>
  <meta http-equiv="refresh" content="3">
  <style>
    body { font-family: monospace; background: #0f1117; color: #e4e4e7; padding: 40px; }
    h1 { color: #f0a830; } .ok { color: #34d399; } .dim { color: #5a5c66; }
    .box { background: #16181f; border: 1px solid #23262f; border-radius: 8px; padding: 20px; margin: 16px 0; }
  </style>
</head>
<body>
  <h1>🍽️ CashierPOS Server</h1>
  <div class="box">
    <div class="ok">● Running on port ${PORT}</div>
    <div>Connected clients: <b id="c">${wss ? wss.clients.size : 0}</b></div>
    <div>Kitchen orders: <b>${state.kq.length}</b></div>
    <div>Menu items: <b>${state.menu.length}</b></div>
    <div class="dim">Auto-refreshes every 3 seconds</div>
  </div>
  <div class="box">
    <div class="dim">Set this IP in your POS app settings:</div>
    <div style="color:#f0a830;font-size:1.4em;margin-top:8px">ws://YOUR_IP:${PORT}</div>
    <div class="dim" style="margin-top:8px">Find your IP: run <b>ipconfig</b> (Windows) or <b>ifconfig</b> (Mac/Linux)</div>
  </div>
</body>
</html>`);
});

// ── WebSocket server ───────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

wss.on('connection', (ws) => {
  console.log(`[+] Client connected — total: ${wss.clients.size}`);

  // Send full state to new client
  ws.send(JSON.stringify({ type: 'FULL_STATE', ...state }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Kitchen queue ──
      case 'ORDER_ADD':
        // Add order if not already in queue
        if (!state.kq.find(o => o.oid === msg.order.oid)) {
          state.kq.unshift(msg.order);
        }
        broadcast({ type: 'ORDER_ADD', order: msg.order }, ws);
        log('ORDER_ADD', `Table ${msg.order.table} — ${msg.order.items?.length} items`);
        break;

      case 'ORDER_UPDATE':
        state.kq = state.kq.map(o =>
          o.oid === msg.oid ? { ...o, st: msg.st, sT: msg.sT } : o
        );
        broadcast({ type: 'ORDER_UPDATE', oid: msg.oid, st: msg.st, sT: msg.sT }, ws);
        log('ORDER_UPDATE', `${msg.oid.slice(0,8)} → ${msg.st}`);
        break;

      case 'ORDER_CANCEL':
        state.kq = state.kq.map(o =>
          o.oid === msg.oid ? { ...o, st: 'cancelled' } : o
        );
        broadcast({ type: 'ORDER_CANCEL', oid: msg.oid }, ws);
        log('ORDER_CANCEL', msg.oid.slice(0,8));
        break;

      case 'ORDER_TIME_ADD':
        state.kq = state.kq.map(o =>
          o.oid === msg.oid ? { ...o, addS: (o.addS || 0) + msg.seconds } : o
        );
        broadcast({ type: 'ORDER_TIME_ADD', oid: msg.oid, seconds: msg.seconds }, ws);
        break;

      // ── Menu & inventory ──
      case 'MENU_UPDATE':
        state.menu = msg.menu;
        broadcast({ type: 'MENU_UPDATE', menu: msg.menu }, ws);
        log('MENU_UPDATE', `${msg.menu.length} items`);
        break;

      case 'INV_UPDATE':
        state.inv = { ...state.inv, ...msg.inv };
        broadcast({ type: 'INV_UPDATE', inv: msg.inv }, ws);
        break;

      // ── Full state push (client can push its full state to server) ──
      case 'PUSH_STATE':
        if (msg.kq)   state.kq   = msg.kq;
        if (msg.menu) state.menu = msg.menu;
        if (msg.inv)  state.inv  = msg.inv;
        broadcast({ type: 'FULL_STATE', ...state }, ws);
        log('PUSH_STATE', 'Full state synced');
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[-] Client disconnected — total: ${wss.clients.size}`);
  });

  ws.on('error', (err) => {
    console.error('[!] WS error:', err.message);
  });
});

function log(type, detail) {
  const t = new Date().toTimeString().slice(0,8);
  console.log(`[${t}] ${type.padEnd(16)} ${detail}`);
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  🍽️  CashierPOS Sync Server');
  console.log('  ─────────────────────────────');
  console.log(`  Running on port ${PORT}`);
  console.log(`  Status page: http://localhost:${PORT}`);
  console.log(`  Health check: http://localhost:${PORT}/health`);
  console.log('');
  console.log('  ⚠  Find your local IP and enter it in the POS settings:');
  console.log('     Windows: run ipconfig → look for IPv4 Address');
  console.log('     Mac/Linux: run ifconfig → look for inet');
  console.log('');
});
