// /api/ai/* — owner's AI assistant (admin only).
// Two layers:
//   1. Deterministic insights (GET /ai/insights) — low stock, dead stock, top sellers.
//      Pure SQL, works with no API key, never wrong.
//   2. LLM chat (POST /ai/chat) — proxies to NVIDIA's OpenAI-compatible API
//      (integrate.api.nvidia.com). The server injects a live inventory snapshot into the
//      system prompt so the model answers from real data, not guesses. The NVIDIA key
//      lives ONLY in the server env (NVIDIA_API_KEY) — it is never sent to the browser.
const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireSession, requireAdmin } = require('../auth');
const { fail } = require('../validate');

const gate = [requireSession, requireAdmin];

const NVIDIA_BASE = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const NVIDIA_MODEL = process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct';
const LOW_STOCK_DEFAULT = Number(process.env.AI_LOW_STOCK_THRESHOLD) || 5;

// ── Data gathering (shared by /insights and the chat system prompt) ─────────────
// No expiry dimension: spirits, wine and beer do not carry a use-by date, so the alert was
// permanently empty here (see migration 0007).
async function gatherInsights({ lowThreshold = LOW_STOCK_DEFAULT } = {}) {
  const [low, dead, top] = await Promise.all([
    // Products at/under the reorder threshold.
    db.query(
      `select id, barcode, name, cat, stock, unit from products
        where active and coalesce(stock,0) <= $1
        order by stock asc, name limit 100`,
      [lowThreshold]
    ),
    // Dead stock: on the shelf but not sold in the last 30 days.
    db.query(
      `select p.id, p.name, p.cat, p.stock from products p
        where p.active and coalesce(p.stock,0) > 0
          and not exists (
            select 1 from orders_main o, jsonb_array_elements(coalesce(o.items,'[]'::jsonb)) li
             where o.created_at >= now() - interval '30 days' and li->>'name' = p.name)
        order by p.stock desc limit 50`
    ),
    // Best sellers over the last 7 days (what to keep stocked).
    db.query(
      `select li->>'name' as name, sum((li->>'qty')::numeric) as units
         from orders_main o, jsonb_array_elements(coalesce(o.items,'[]'::jsonb)) li
        where o.created_at >= now() - interval '7 days'
        group by li->>'name' order by units desc limit 20`
    ),
  ]);

  return {
    generated_at: new Date().toISOString(),
    low_stock_threshold: lowThreshold,
    low_stock: low.rows,
    dead_stock: dead.rows,
    top_sellers_7d: top.rows,
  };
}

// ── GET /ai/status → is the LLM configured? (UI shows chat vs. insights-only) ────
router.get('/ai/status', ...gate, (req, res) => {
  res.json({ configured: Boolean(process.env.NVIDIA_API_KEY), model: NVIDIA_MODEL });
});

// ── GET /ai/insights?threshold=5 → deterministic alerts, no LLM involved ─────────
router.get('/ai/insights', ...gate, async (req, res, next) => {
  try {
    const lowThreshold = Number.isFinite(Number(req.query.threshold)) && Number(req.query.threshold) >= 0
      ? Number(req.query.threshold) : LOW_STOCK_DEFAULT;
    res.json(await gatherInsights({ lowThreshold }));
  } catch (e) { next(e); }
});

// ── POST /ai/chat { messages:[{role,content}] } → { reply } ─────────────────────
// Throttled: LLM calls are slow + metered; 20/5min per IP is plenty for one owner.
const chatLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function buildSystemPrompt(snapshot) {
  return [
    'You are the inventory assistant for a small liquor store (Dukkan POS).',
    'Answer briefly and practically for the store owner. Reply in the language the owner writes in (Arabic or English).',
    'Use ONLY the live data below — never invent stock numbers or products.',
    'When asked for recommendations: suggest reorder quantities from top sellers vs. low stock,',
    'and point out dead stock tying up money.',
    '',
    'LIVE INVENTORY SNAPSHOT (JSON):',
    JSON.stringify(snapshot),
  ].join('\n');
}

router.post('/ai/chat', ...gate, chatLimiter, async (req, res, next) => {
  try {
    if (!process.env.NVIDIA_API_KEY) return fail(res, 'ai_not_configured', 503);

    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length === 0 || messages.length > 30) return fail(res, 'invalid', 400);
    // Only user/assistant turns from the client; the system prompt is server-built.
    const clean = messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!clean.length || clean[clean.length - 1].role !== 'user') return fail(res, 'invalid', 400);

    const snapshot = await gatherInsights();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let resp;
    try {
      resp = await fetch(`${NVIDIA_BASE}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model: NVIDIA_MODEL,
          messages: [{ role: 'system', content: buildSystemPrompt(snapshot) }, ...clean],
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });
    } finally { clearTimeout(timer); }

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[ai] NVIDIA API error', resp.status, detail.slice(0, 500));
      return fail(res, 'ai_upstream', 502);
    }
    const data = await resp.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content : null;
    if (!reply) return fail(res, 'ai_upstream', 502);
    res.json({ reply, model: NVIDIA_MODEL });
  } catch (e) {
    if (e && e.name === 'AbortError') return fail(res, 'ai_timeout', 504);
    next(e);
  }
});

module.exports = router;
