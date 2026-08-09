import React, { useState, useRef, useEffect } from 'react';
import api from '../api';
import { C, S } from '../theme';
import { ARABIC, STORE_NAME, toggleLang } from '../client.config';
import OnScreenKeyboard from '../components/OnScreenKeyboard';

function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState('username');   // which field the keyboard types into
  const [kb, setKb] = useState(true);                 // on-screen keyboard visible
  const [showLogo, setShowLogo] = useState(false);    // logo fades in when the bg video ends
  const videoRef = useRef(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.play?.().catch(() => {});                        // muted autoplay; ignore blocked promise
    let t;
    const arm = () => {
      clearTimeout(t);
      const secs = v.duration && isFinite(v.duration) ? v.duration : 6;
      t = setTimeout(() => setShowLogo(true), secs * 1000 + 200);   // fallback if 'ended' never fires
    };
    if (v.readyState >= 1) arm();
    else v.addEventListener('loadedmetadata', arm, { once: true });
    return () => clearTimeout(t);
  }, []);

  const submit = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setErr(''); setBusy(true);
    try {
      const u = await api.post('/auth/login', { username, password });
      onLogin(u);
    } catch (ex) {
      // 429 'locked' = too many failed attempts for this username. Say so plainly with the
      // wait — a cashier mid-queue needs to know it's a lockout, not a typo.
      if (ex.message === 'locked') {
        const mins = Math.max(1, Math.ceil(((ex.body && ex.body.retry_after_s) || 900) / 60));
        setErr(ARABIC
          ? `محاولات كثيرة خاطئة — حاول بعد ${mins} دقيقة`
          : `Too many failed attempts — try again in ${mins} min`);
      } else {
        setErr(ARABIC ? 'اسم المستخدم أو كلمة المرور غير صحيحة' : 'Invalid username or password');
      }
    } finally { setBusy(false); }
  };

  const setActiveValue = (fn) => (active === 'username' ? setUsername(fn) : setPassword(fn));
  const onKey = (ch) => setActiveValue((v) => v + ch);
  const onBackspace = () => setActiveValue((v) => v.slice(0, -1));

  const fieldStyle = (name) => ({ ...S.input, fontSize: 17, padding: '14px 14px', ...(active === name && kb ? { borderColor: C.accent, boxShadow: `0 0 0 2px ${C.accent}33` } : {}) });

  const base = process.env.PUBLIC_URL || '';
  const bgPoster = base + '/login-bg.png';
  const bgVideo = base + '/login-bg.mp4';
  const logoMark = base + '/logo-mark.png';
  return (
    <div dir="ltr" style={{
      position: 'relative', overflow: 'hidden',
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      fontFamily: ARABIC ? "'Cairo','DM Sans',system-ui,sans-serif" : "'DM Sans','Cairo',system-ui,sans-serif", padding: 'clamp(16px, 4vw, 64px)',
      background: '#0f1117',
    }}>
      {/* Supermarket checkout background video — plays once, then the logo fades in */}
      <video
        ref={videoRef}
        autoPlay muted playsInline loop
        poster={bgPoster}
        onEnded={() => setShowLogo(true)}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 0 }}
      >
        <source src={bgVideo} type="video/mp4" />
      </video>
      {/* Readability scrim */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
        background: 'linear-gradient(90deg, rgba(15,17,23,.10) 0%, rgba(15,17,23,.45) 50%, rgba(15,17,23,.85) 100%)' }} />
      {/* Logo reveal after the video ends */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, textAlign: 'center',
        paddingInlineEnd: 'min(40vw, 480px)',
        background: showLogo ? 'rgba(15,17,23,.55)' : 'rgba(15,17,23,0)',
        opacity: showLogo ? 1 : 0, transition: 'opacity 1.4s ease, background 1.4s ease' }}>
        <img src={logoMark} alt="حtech." style={{ width: 'min(38vw, 340px)', maxWidth: '80%', filter: 'drop-shadow(0 8px 30px rgba(0,0,0,.6))',
          transform: showLogo ? 'translateY(0)' : 'translateY(12px)', transition: 'transform 1.4s ease' }} />
        <div style={{ color: '#fff', fontWeight: 600, fontSize: 'clamp(15px, 2.2vw, 24px)', letterSpacing: '.01em',
          textShadow: '0 2px 16px rgba(0,0,0,.7)' }}>we bring your idea to life.</div>
      </div>
      <form onSubmit={submit} dir={ARABIC ? 'rtl' : 'ltr'} style={{ ...S.card, position: 'relative', zIndex: 2, width: 'min(94vw, 440px)', display: 'flex', flexDirection: 'column', gap: 14, backdropFilter: 'blur(6px)', background: 'rgba(26,28,37,.92)', boxShadow: '0 20px 60px rgba(0,0,0,.55)' }}>
        <div style={{ fontWeight: 800, fontSize: 30, color: C.accent, textAlign: 'center' }}>{STORE_NAME}</div>
        <div style={{ color: C.dim, fontSize: 14, textAlign: 'center', marginTop: -8 }}>{ARABIC ? 'تسجيل الدخول' : 'Sign in'}</div>
        <button type="button" onClick={toggleLang} style={{ ...S.btnGhost, alignSelf: 'center', padding: '6px 16px', fontSize: 13 }}>{ARABIC ? '🌐 English' : '🌐 عربي'}</button>
        <input style={fieldStyle('username')} placeholder={ARABIC ? 'اسم المستخدم' : 'Username'} value={username}
          onChange={(e) => setUsername(e.target.value)} onFocus={() => { setActive('username'); setKb(true); }}
          autoFocus autoCapitalize="off" autoComplete="off" />
        <input style={fieldStyle('password')} type="password" placeholder={ARABIC ? 'كلمة المرور' : 'Password'} value={password}
          onChange={(e) => setPassword(e.target.value)} onFocus={() => { setActive('password'); setKb(true); }} autoComplete="off" />
        {err && <div style={{ color: C.red, fontSize: 14 }}>{err}</div>}
        {process.env.REACT_APP_DEMO === '1' && (
          <div style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, fontSize: 12, color: C.dim, textAlign: 'center' }}>
            DEMO — no backend. Sign in: <b style={{ color: C.accent }}>admin</b> / any password<br />or <b style={{ color: C.accent }}>cashier</b> (limited views). Data is local to your browser.
          </div>
        )}
        <button type="submit" disabled={busy} style={{ ...S.btn, padding: '16px', fontSize: 18, opacity: busy ? 0.6 : 1 }}>{busy ? '…' : (ARABIC ? 'دخول' : 'Login')}</button>
        {!kb && <button type="button" onClick={() => setKb(true)} style={{ ...S.btnGhost, padding: '12px' }}>{ARABIC ? 'إظهار لوحة المفاتيح' : 'Show keyboard'}</button>}
        {kb && <OnScreenKeyboard onKey={onKey} onBackspace={onBackspace} onEnter={submit} onClose={() => setKb(false)} />}
      </form>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Sales — scan → cart → checkout
// ══════════════════════════════════════════════════════════════════════════════

export default Login;
export { Login };
