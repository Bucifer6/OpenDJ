// Synthetic dance tracks for the analysis tests (shared, so importing it doesn't re-run a test file).
const SR = 22050;
const BPM = 124;

/**
 * Synthetic dance track: `lead` s of silence, `pickup` beats of hi-hats, then sections of whole bars.
 * Section voices: kick (4/4), bass (off-beat 8ths), hats (8ths), pad (Am chord). gain may be a function of 0..1 progress.
 */
export function synthTrack(sections, { lead = 0.3, pickup = 2, tail = 1, sr = SR, bpm = BPM } = {}) {
  const beat = 60 / bpm, bar = 4 * beat;
  const downbeat = lead + pickup * beat;
  const totalBars = sections.reduce((s, x) => s + x.bars, 0);
  const n = Math.ceil((downbeat + totalBars * bar + tail) * sr);
  const x = new Float32Array(n);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const add = (from, to, v) => {
    const i0 = Math.max(0, Math.floor(from * sr)), i1 = Math.min(n, Math.floor(to * sr));
    for (let i = i0; i < i1; i++) x[i] += v(i / sr - from, i / sr);
  };
  const hats = (t0, t1, g) => {
    for (let t = t0; t < t1 - 1e-6; t += beat / 2) {
      let prev = 0;
      add(t, t + 0.04, (u) => { const r = rnd(); const h = r - prev; prev = r; return 0.12 * g(t) * h * Math.exp(-u * 90); });
    }
  };
  if (pickup) hats(lead, downbeat, () => 1);
  let t = downbeat;
  for (const s of sections) {
    const t1 = t + s.bars * bar, ts = t;
    const g = (tt) => (typeof s.gain === 'function' ? s.gain((tt - ts) / (t1 - ts)) : s.gain ?? 1);
    if (s.hats) hats(t, t1, g);
    if (s.pad) add(t, t1, (u, tt) => s.pad * g(tt) * (Math.sin(2 * Math.PI * 220 * tt) + Math.sin(2 * Math.PI * 261.63 * tt) + Math.sin(2 * Math.PI * 329.63 * tt)));
    for (let b = t; b < t1 - 1e-6; b += beat) {
      const gb = g(b);
      if (s.kick) add(b, b + 0.25, (u) => 0.8 * gb * Math.sin(2 * Math.PI * (50 * u + 100 * (1 - Math.exp(-u * 40)) / 40)) * Math.exp(-u * 18));
      if (s.bass) add(b + beat / 2, b + beat * 0.95, (u) => 0.35 * gb * Math.sin(2 * Math.PI * 55 * u) * Math.min(1, u * 200) * Math.exp(-u * 3));
    }
    t = t1;
  }
  return { mono: x, downbeat, bar, beat };
}
