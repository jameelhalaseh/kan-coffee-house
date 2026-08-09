// Audio feedback for the scanner. WebAudio only — no asset to ship or fail to load.
let _audioCtx = null;
function beep(ok = true) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const play = (freq, at, dur) => {
      const o = _audioCtx.createOscillator();
      const g = _audioCtx.createGain();
      o.type = 'square'; o.frequency.value = freq;
      o.connect(g); g.connect(_audioCtx.destination);
      const t = _audioCtx.currentTime + at;
      g.gain.setValueAtTime(0.08, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t); o.stop(t + dur);
    };
    if (ok) play(1500, 0, 0.08);
    else { play(300, 0, 0.14); play(300, 0.18, 0.14); }
  } catch (_) { /* audio unavailable (old browser / no user gesture yet) — silent */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// Root
// ══════════════════════════════════════════════════════════════════════════════

export { beep };
