// Scratch samples (T9): 8 slots of short sounds a deck can swap to and scratch, then return to its track
// (deck.scratchSampleIn / scratchSampleReturn). Built-in sounds are synthesised here at run time (OpenDJ's own, MIT;
// listed in public/samples/CREDITS.json), so nothing copyrighted is bundled: no classic "ahh" / "fresh" record samples.
// Slots can also take a user file (dropped on the pad) or one of the CC0 vinyl one-shots of the downloadable Sonic Pi
// catalogue (audio/sample-catalog.js, credited there).
import { SAMPLE_CATALOG } from './sample-catalog.js';

/** Built-in sounds: id, name, renderer(sampleRate) -> [left, right] Float32Arrays. */
export const SCRATCH_SOUNDS = [
  { id: 'ahh', name: 'Ahh', render: (sr) => vowel(sr, [800, 1150, 2900], [80, 90, 120], 0.95) },
  { id: 'ooh', name: 'Ooh', render: (sr) => vowel(sr, [300, 870, 2240], [60, 80, 120], 0.95) },
  { id: 'stab', name: 'Stab', render: (sr) => stab(sr) },
  { id: 'tone', name: 'Tone', render: (sr) => tone(sr) },
  { id: 'kick', name: 'Kick', render: (sr) => kick(sr) },
  { id: 'snare', name: 'Snare', render: (sr) => snare(sr) },
  { id: 'bass', name: 'Bass', render: (sr) => bass(sr) },
  { id: 'noise', name: 'Sweep', render: (sr) => sweep(sr) },
];
/** CC0 vinyl one-shots from the downloadable catalogue that suit a scratch slot. */
export const SCRATCH_DOWNLOADS = SAMPLE_CATALOG.filter((s) => /^vinyl_(scratch|backspin|rewind)$/.test(s.id));

// ---------------------------------------------------------------- synthesis (deterministic)
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; }
const env = (i, n, sr, a = 0.01, r = 0.08) => Math.min(1, i / (a * sr), (n - i) / (r * sr));
function finish(x, peak = 0.7) { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m; return [x, x]; }
/** Two-pole resonator (band-pass) state machine. */
function resonator(f, bw, sr) {
  const r = Math.exp(-Math.PI * bw / sr), a1 = 2 * r * Math.cos(2 * Math.PI * f / sr), a2 = -r * r, g = 1 - r;
  let y1 = 0, y2 = 0;
  return (x) => { const y = g * x + a1 * y1 + a2 * y2; y2 = y1; y1 = y; return y; };
}
/** A sung vowel: a glottal pulse train through three formant resonators, slight vibrato, gliding pitch. */
function vowel(sr, F, B, secs) {
  const n = Math.round(secs * sr), out = new Float32Array(n), res = F.map((f, i) => resonator(f, B[i], sr));
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, f0 = 210 - 25 * (t / secs) + 3 * Math.sin(2 * Math.PI * 5.5 * t);
    ph += f0 / sr; if (ph >= 1) ph -= 1;
    const src = ph < 0.4 ? Math.sin(Math.PI * ph / 0.4) ** 2 : 0; // glottal pulse
    out[i] = (res[0](src) + 0.7 * res[1](src) + 0.25 * res[2](src)) * env(i, n, sr, 0.03, 0.15);
  }
  return finish(out);
}
function tone(sr) { const n = Math.round(0.6 * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / sr) * env(i, n, sr, 0.005, 0.005); return finish(x, 0.6); }
function stab(sr) {
  const n = Math.round(0.55 * sr), x = new Float32Array(n), fs = [261.63, 311.13, 392, 523.25]; let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr; let v = 0;
    for (const f of fs) for (const d of [-0.004, 0.004]) v += 2 * ((t * f * (1 + d)) % 1) - 1;
    const cut = 0.05 + 0.5 * Math.exp(-t * 9); lp += (v - lp) * cut;
    x[i] = lp * Math.exp(-t * 4) * env(i, n, sr, 0.003, 0.05);
  }
  return finish(x);
}
function kick(sr) { const n = Math.round(0.4 * sr), x = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const t = i / sr; ph += (45 + 120 * Math.exp(-t * 28)) / sr; x[i] = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 7) * env(i, n, sr, 0.001, 0.02); } return finish(x, 0.8); }
function snare(sr) {
  const n = Math.round(0.3 * sr), x = new Float32Array(n), r = rng(9), bp = resonator(3200, 2400, sr);
  for (let i = 0; i < n; i++) { const t = i / sr; x[i] = (bp(r()) * 2.2 * Math.exp(-t * 16) + 0.5 * Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 25)) * env(i, n, sr, 0.001, 0.02); }
  return finish(x);
}
function bass(sr) { const n = Math.round(0.8 * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / sr; x[i] = Math.tanh(2.5 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 2.2)) * env(i, n, sr, 0.004, 0.08); } return finish(x, 0.75); }
function sweep(sr) {
  const n = Math.round(1 * sr), x = new Float32Array(n), r = rng(3); let lp = 0;
  for (let i = 0; i < n; i++) { const t = i / sr, c = 0.01 + 0.4 * (t / 1) ** 2; lp += (r() - lp) * c; x[i] = lp * env(i, n, sr, 0.02, 0.1); }
  return finish(x, 0.5);
}

// ---------------------------------------------------------------- slot bank
export class ScratchSamples {
  constructor(engine) {
    this.engine = engine; this.ctx = engine.ctx;
    this.slots = SCRATCH_SOUNDS.map((s) => ({ id: s.id, name: s.name, builtin: true, buffer: null }));
    this.onChange = null;
  }
  /** The slot's AudioBuffer (built-in sounds are rendered on first use). */
  buffer(i) {
    const s = this.slots[i]; if (!s) return null;
    if (!s.buffer && s.builtin) {
      const def = SCRATCH_SOUNDS.find((x) => x.id === s.id); if (!def) return null;
      const sr = this.ctx.sampleRate, [L, R] = def.render(sr), b = this.ctx.createBuffer(2, L.length, sr);
      b.copyToChannel(L, 0); b.copyToChannel(R, 1); s.buffer = b;
    }
    return s.buffer;
  }
  /** Press a slot on a deck: swap to it, or back to the track when it is already playing there. */
  toggle(deck, i) {
    if (deck.scratchSample?.slot === i) return deck.scratchSampleReturn();
    const b = this.buffer(i); if (!b) return false;
    return deck.scratchSampleIn(b, this.slots[i].name, i);
  }
  setBuiltin(i, id) { const def = SCRATCH_SOUNDS.find((x) => x.id === id); if (!def || !this.slots[i]) return; this.slots[i] = { id, name: def.name, builtin: true, buffer: null }; this.onChange?.(); }
  async loadFile(i, file) {
    if (file.size > 30 * 1024 * 1024) throw new Error('Scratch samples must be short (under 30 MB)');
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    if (buf.duration > 30) throw new Error('Scratch samples must be 30 seconds or shorter');
    this.slots[i] = { id: `file:${file.name}`, name: String(file.name || 'Sample').replace(/\.[^.]+$/, '').slice(0, 40), builtin: false, buffer: buf };
    this.onChange?.();
  }
  async loadDownload(i, sample) {
    const res = await fetch(sample.url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    this.slots[i] = { id: `cc0:${sample.id}`, name: sample.name, builtin: false, buffer: buf, credit: `${sample.creator}, ${sample.license}` };
    this.onChange?.();
  }
}
