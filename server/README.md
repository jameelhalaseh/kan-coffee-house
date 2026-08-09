# CashierPOS Sync Server

Local WebSocket server — connects two machines over WiFi, no internet needed.

## Setup (one time)

```bash
cd cashier-pos-server
npm install
node server.js
```

Server starts on port **3001**.

## Connect the POS app

1. Run the server on one machine (cashier machine recommended)
2. Find that machine's local IP:
   - **Windows**: open CMD → type `ipconfig` → look for **IPv4 Address** (e.g. 192.168.1.105)
   - **Mac/Linux**: open Terminal → type `ifconfig` → look for **inet** under en0
3. On **both machines**, open the POS app
4. Click the 🔌 icon in the top-right header
5. Enter: `ws://192.168.1.105:3001` (replace with your actual IP)
6. Click **Connect** — icon turns 🔗 green when connected

## What syncs

| Action | Syncs to other machine |
|--------|----------------------|
| Send order to kitchen | ✓ Instantly |
| Mark as Preparing / Ready / Served | ✓ Instantly |
| Cancel kitchen order | ✓ Instantly |
| Add time to overdue order | ✓ Instantly |
| Add new menu item | ✓ Instantly |
| Inventory changes | ✓ Instantly |

## Recommended setup

```
Cashier machine  ──┐
                   ├── WiFi router → server.js running on cashier machine
Kitchen screen   ──┘
```

- **Cashier machine**: runs server.js + uses all POS views
- **Kitchen screen**: connects to server, stays on Kitchen view
- Both see the same orders in real time

## Verify it's working

Open `http://localhost:3001` in a browser on the server machine — shows a live status page with connected client count and order count.
