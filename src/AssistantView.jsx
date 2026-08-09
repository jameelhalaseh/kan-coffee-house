/* eslint-disable */
// AI Assistant view (admin only). Two panels:
//   - Insights: deterministic alerts from GET /ai/insights — low stock, dead stock, top
//     sellers. Works without any AI key.
//   - Chat: talks to POST /ai/chat (NVIDIA-backed). Hidden behind "not configured" note
//     until NVIDIA_API_KEY is set on the server.
import React, { useState, useEffect, useRef } from 'react';
import api from './api';
import { ARABIC } from './client.config';
import { C, S } from './theme';

const L = ARABIC ? {
  title: 'المساعد الذكي',
  refresh: 'تحديث',
  lowStock: 'مخزون منخفض',
  deadStock: 'مخزون راكد (٣٠ يوم بدون مبيعات)',
  topSellers: 'الأكثر مبيعاً (٧ أيام)',
  none: 'لا يوجد',
  chatTitle: 'اسأل المساعد',
  placeholder: 'اكتب سؤالك… مثال: ماذا يجب أن أطلب هذا الأسبوع؟',
  send: 'إرسال',
  thinking: 'يفكر…',
  notConfigured: 'الدردشة غير مفعّلة — أضف NVIDIA_API_KEY على الخادم. التنبيهات أعلاه تعمل بدون مفتاح.',
  error: 'تعذر الحصول على رد. حاول مجدداً.',
  q1: 'ماذا يجب أن أعيد طلبه؟',
  q2: 'ما هو المخزون الراكد الذي يجب تصريفه؟',
  q3: 'أعطني توصيات لتحسين المخزون',
} : {
  title: 'AI Assistant',
  refresh: 'Refresh',
  lowStock: 'Low stock',
  deadStock: 'Dead stock (no sales in 30 days)',
  topSellers: 'Top sellers (7 days)',
  none: 'None',
  chatTitle: 'Ask the assistant',
  placeholder: 'Type a question… e.g. What should I reorder this week?',
  send: 'Send',
  thinking: 'Thinking…',
  notConfigured: 'Chat is not enabled — set NVIDIA_API_KEY on the server. The alerts above work without a key.',
  error: 'Could not get a reply. Try again.',
  q1: 'What should I reorder?',
  q2: 'Which dead stock should I clear out?',
  q3: 'Give me recommendations to improve my inventory',
};

const h3 = { margin: '0 0 10px', fontSize: 14, color: C.dim, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 };
const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: `1px solid ${C.line}`, fontSize: 13 };

function Card({ title, accent, children }) {
  return (
    <div style={{ ...S.card, borderTop: `3px solid ${accent || C.line}` }}>
      <h3 style={h3}>{title}</h3>
      {children}
    </div>
  );
}

function List({ rows, render }) {
  if (!rows || rows.length === 0) return <div style={{ color: C.dim, fontSize: 13 }}>{L.none}</div>;
  return <div>{rows.map((r, i) => <div key={r.id ?? r.name ?? i} style={rowStyle}>{render(r)}</div>)}</div>;
}

export default function AssistantView({ notify }) {
  const [insights, setInsights] = useState(null);
  const [status, setStatus] = useState(null);           // { configured, model }
  const [messages, setMessages] = useState([]);         // [{ role, content }]
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const chatEndRef = useRef(null);

  const load = async () => {
    try {
      const [ins, st] = await Promise.all([api.get('/ai/insights'), api.get('/ai/status')]);
      setInsights(ins); setStatus(st);
    } catch (e) {
      notify(ARABIC ? 'تعذر تحميل التنبيهات' : 'Failed to load insights', 'red');
    }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { chatEndRef.current && chatEndRef.current.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);

  const send = async (text) => {
    const q = String(text || input).trim();
    if (!q || busy) return;
    const next = [...messages, { role: 'user', content: q }];
    setMessages(next); setInput(''); setBusy(true);
    try {
      const r = await api.post('/ai/chat', { messages: next.slice(-12) });
      setMessages([...next, { role: 'assistant', content: r.reply }]);
    } catch (e) {
      setMessages(next);
      notify(e.message === 'ai_not_configured' ? L.notConfigured : L.error, 'red');
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{L.title}</h2>
        <button onClick={load} style={S.btnGhost}>{L.refresh}</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14, marginBottom: 20 }}>
        <Card title={L.lowStock} accent={C.red}>
          <List rows={insights && insights.low_stock} render={(r) => (<>
            <span>{r.name}{r.cat ? <span style={{ color: C.dim }}> · {r.cat}</span> : null}</span>
            <b style={{ color: C.red }}>{Number(r.stock)} {r.unit === 'kg' ? 'kg' : ''}</b>
          </>)} />
        </Card>

        <Card title={L.deadStock}>
          <List rows={insights && insights.dead_stock} render={(r) => (<>
            <span>{r.name}</span><span style={{ color: C.dim }}>{Number(r.stock)}</span>
          </>)} />
        </Card>

        <Card title={L.topSellers} accent={C.green}>
          <List rows={insights && insights.top_sellers_7d} render={(r) => (<>
            <span>{r.name}</span><b style={{ color: C.green }}>{Number(r.units)}</b>
          </>)} />
        </Card>
      </div>

      <div style={S.card}>
        <h3 style={h3}>{L.chatTitle}{status && status.configured ? <span style={{ color: C.dim, fontWeight: 400, textTransform: 'none' }}> · {status.model}</span> : null}</h3>
        {status && !status.configured && (
          <div style={{ color: C.accent, fontSize: 13, marginBottom: 10 }}>{L.notConfigured}</div>
        )}
        <div style={{ maxHeight: 340, overflowY: 'auto', marginBottom: 10 }}>
          {messages.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '6px 0' }}>
              <div style={{
                maxWidth: '80%', padding: '8px 12px', borderRadius: 10, fontSize: 13, whiteSpace: 'pre-wrap',
                background: m.role === 'user' ? C.accent : C.panel2,
                color: m.role === 'user' ? C.accentText : C.text,
              }}>{m.content}</div>
            </div>
          ))}
          {busy && <div style={{ color: C.dim, fontSize: 13 }}>{L.thinking}</div>}
          <div ref={chatEndRef} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {[L.q1, L.q2, L.q3].map((q) => (
            <button key={q} onClick={() => send(q)} disabled={busy || !(status && status.configured)}
              style={{ ...S.btnGhost, fontSize: 12, opacity: status && status.configured ? 1 : 0.5 }}>{q}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
            placeholder={L.placeholder}
            disabled={!(status && status.configured)}
            style={{ ...S.input, flex: 1 }}
          />
          <button onClick={() => send()} disabled={busy || !(status && status.configured)} style={S.btn}>{L.send}</button>
        </div>
      </div>
    </div>
  );
}
