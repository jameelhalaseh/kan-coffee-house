// Hand-rolled SVG charts for the Reports screen. No charting dependency: these are a few
// dozen lines each and stay inside the app's own palette.
import React from 'react';
import { C } from '../theme';
import { CURRENCY } from '../client.config';
import { money } from '../lib';

function Donut({ slices, size = 170 }) {
  const total = slices.reduce((s, x) => s + (Number(x.value) || 0), 0);
  if (!(total > 0)) return <div style={{ color: C.dim, fontSize: 13 }}>—</div>;
  const R = 60, CX = 75, CY = 75, W = 26;
  let angle = -Math.PI / 2;
  const arcs = slices.filter((s) => Number(s.value) > 0).map((s) => {
    const frac = Number(s.value) / total;
    const a0 = angle, a1 = angle + frac * 2 * Math.PI;
    angle = a1;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a) => `${CX + R * Math.cos(a)} ${CY + R * Math.sin(a)}`;
    // Full-circle arcs collapse in SVG; nudge the end a hair.
    const end = frac >= 0.999 ? a1 - 0.001 : a1;
    return { ...s, frac, d: `M ${p(a0)} A ${R} ${R} 0 ${large} 1 ${p(end)}` };
  });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
      <svg width={size} height={size} viewBox="0 0 150 150">
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill="none" stroke={a.color} strokeWidth={W} strokeLinecap="butt">
            <title>{`${a.label}: ${money(a.value)} (${Math.round(a.frac * 100)}%)`}</title>
          </path>
        ))}
        <text x={CX} y={CY - 4} textAnchor="middle" fill={C.text} fontSize="15" fontWeight="800">{total.toFixed(2)}</text>
        <text x={CX} y={CY + 14} textAnchor="middle" fill={C.dim} fontSize="9">{CURRENCY}</text>
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {arcs.sort((a, b) => b.frac - a.frac).map((a, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ width: 11, height: 11, borderRadius: 3, background: a.color, flexShrink: 0 }} />
            <span style={{ color: C.text }}>{a.label}</span>
            <span style={{ color: C.dim }}>{Math.round(a.frac * 100)}% · {money(a.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Smooth spline (Catmull-Rom → cubic bezier) with filled area. points: [{label, value}].
function Spline({ points, color = C.green, height = 150 }) {
  if (points.length < 2) return <div style={{ color: C.dim, fontSize: 13 }}>{points.length ? '—' : '—'}</div>;
  const W = 600, H = 130, PAD = 8;
  const max = Math.max(...points.map((p) => Number(p.value) || 0), 0.001);
  const xy = points.map((p, i) => [
    PAD + (i / (points.length - 1)) * (W - 2 * PAD),
    H - PAD - ((Number(p.value) || 0) / max) * (H - 2 * PAD),
  ]);
  let d = `M ${xy[0][0]} ${xy[0][1]}`;
  for (let i = 0; i < xy.length - 1; i++) {
    const p0 = xy[i - 1] || xy[i], p1 = xy[i], p2 = xy[i + 1], p3 = xy[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p2[0]} ${p2[1]}`;
  }
  const area = `${d} L ${xy[xy.length - 1][0]} ${H} L ${xy[0][0]} ${H} Z`;
  return (
    <div>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="splineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#splineFill)" />
        <path d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
        {xy.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="3.5" fill={color}>
            <title>{`${points[i].label}: ${money(points[i].value)}`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim }}>
        <span>{points[0].label}</span>
        {points.length > 2 && <span>{points[Math.floor(points.length / 2)].label}</span>}
        <span>{points[points.length - 1].label}</span>
      </div>
    </div>
  );
}

// Scatter plot. points: [{label, x, y, color?}] — hover a dot for details.
function Scatter({ points, xLabel, yLabel, height = 210 }) {
  if (!points.length) return <div style={{ color: C.dim, fontSize: 13 }}>—</div>;
  const W = 600, H = 190, PAD = 34;
  const maxX = Math.max(...points.map((p) => p.x), 0.001);
  const maxY = Math.max(...points.map((p) => p.y), 0.001);
  const sx = (v) => PAD + (v / maxX) * (W - PAD - 12);
  const sy = (v) => H - PAD + 10 - (v / maxY) * (H - PAD - 6);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={PAD} y1={sy(maxY * f)} x2={W - 8} y2={sy(maxY * f)} stroke={C.line} strokeWidth="1" strokeDasharray="4 4" />
      ))}
      <line x1={PAD} y1={sy(0)} x2={W - 8} y2={sy(0)} stroke={C.line} strokeWidth="1.5" />
      <line x1={PAD} y1={sy(0)} x2={PAD} y2={sy(maxY)} stroke={C.line} strokeWidth="1.5" />
      <text x={W - 10} y={sy(0) + 16} textAnchor="end" fill={C.dim} fontSize="10">{xLabel}</text>
      <text x={PAD - 4} y={sy(maxY) - 6} textAnchor="start" fill={C.dim} fontSize="10">{yLabel}</text>
      {points.map((p, i) => (
        <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="5.5" fill={p.color || C.blue} fillOpacity="0.75" stroke={p.color || C.blue}>
          <title>{`${p.label}\n${xLabel}: ${p.x}\n${yLabel}: ${Number(p.y).toFixed(3)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Minimal CSS bar chart — no chart library (bundle stays tiny). data: [{label, value}].
function Bars({ data, color = C.accent, height = 130, fmt = (v) => v }) {
  const max = Math.max(...data.map((d) => Number(d.value) || 0), 0.001);
  if (!data.length) return <div style={{ color: C.dim, fontSize: 13 }}>—</div>;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height }}>
      {data.map((d, i) => (
        <div key={i} title={`${d.label}: ${fmt(d.value)}`} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }}>
          <div style={{ width: '100%', height: `${Math.max(2, (Number(d.value) / max) * 82)}%`, background: Number(d.value) > 0 ? color : C.line, borderRadius: '4px 4px 0 0', transition: 'height .25s' }} />
          <span style={{ fontSize: 10, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden', maxWidth: '100%' }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

export { Donut, Spline, Scatter, Bars };
