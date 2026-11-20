// Sample pads: built-in synthesised one-shots (no copyrighted audio) plus user-loaded samples.

function synth(ctx, seconds, fn) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < len; i++) { const t = i / ctx.sampleRate; const v = fn(t, i, seconds); L[i] = v; R[i] = v; }
  return buf;
}
const sq = (x) => (Math.sin(x) >= 0 ? 1 : -1);

const BUILTIN = [
  { name: 'Air Horn', make: (c) => synth(c, 1.6, (t, _i, d) => { const env = Math.min(1, t * 40) * (t > d - 0.25 ? (d - t) / 0.25 : 1); const pulse = (t % 0.4) < 0.3 ? 1 : 0.2; return 0.25 * env * pulse * (sq(2 * Math.PI * 466 * t) * 0.5 + sq(2 * Math.PI * 587 * t) * 0.35 + sq(2 * Math.PI * 698 * t) * 0.25); }) },
  { name: 'Siren', make: (c) => synth(c, 2.5, (t) => { const f = 700 + 400 * Math.sin(2 * Math.PI * 1.6 * t); return 0.3 * Math.sin(2 * Math.PI * f * t + 3 * Math.sin(2 * Math.PI * 1.6 * t)) * Math.min(1, t * 10) * Math.min(1, (2.5 - t) * 4); }) },
  { name: 'Laser', make: (c) => synth(c, 0.5, (t) => 0.35 * sq(2 * Math.PI * (3000 * Math.exp(-t * 9) + 100) * t) * Math.exp(-t * 5)) },
  { name: 'Kick', make: (c) => synth(c, 0.5, (t) => 0.9 * Math.sin(2 * Math.PI * (50 + 120 * Math.exp(-t * 35)) * t) * Math.exp(-t * 7)) },
  { name: 'Clap', make: (c) => synth(c, 0.4, (t) => { const bursts = [0, 0.012, 0.024, 0.04]; let e = 0; for (const b of bursts) if (t >= b) e = Math.max(e, Math.exp(-(t - b) * (b === 0.04 ? 18 : 120))); return 0.6 * (Math.random() * 2 - 1) * e; }) },
  { name: 'Rewind', make: (c) => synth(c, 1.2, (t) => { const f = 2000 * (1.2 - t) + 80; return 0.3 * (Math.random() * 0.5 + Math.sin(2 * Math.PI * f * t)) * Math.sin(Math.PI * t / 1.2); }) },
  { name: 'Riser', make: (c) => synth(c, 4, (t) => 0.25 * (Math.random() * 2 - 1) * (t / 4) ** 2 + 0.15 * Math.sin(2 * Math.PI * (200 + 1600 * (t / 4) ** 2) * t) * (t / 4)) },
  { name: 'Impact', make: (c) => synth(c, 2.5, (t) => 0.8 * (Math.sin(2 * Math.PI * (40 + 60 * Math.exp(-t * 6)) * t) * Math.exp(-t * 1.6) + (Math.random() * 2 - 1) * Math.exp(-t * 12) * 0.4)) },
];

export class Sampler {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.out = ctx.createGain(); this.out.gain.value = 0.8; this.out.connect(destination);
    this.slots = BUILTIN.map((b) => ({ name: b.name, buffer: b.make(ctx), builtin: true, playing: null, mode: 'oneshot' }));
  }
  setVolume(v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  async loadFile(i, file) {
    const buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
    this.slots[i] = { name: file.name.replace(/\.[^.]+$/, ''), buffer: buf, builtin: false, playing: null, mode: 'oneshot' };
  }
  trigger(i, { velocity = 1, when = 0, choke = true } = {}) {
    const s = this.slots[i]; if (!s?.buffer) return;
    if (s.playing && choke) { try { s.playing.stop(when || 0); } catch { /* ended */ } }
    const src = this.ctx.createBufferSource(); src.buffer = s.buffer;
    const g = this.ctx.createGain(); g.gain.value = velocity;
    src.connect(g); g.connect(this.out); src.start(when || 0);
    s.playing = src; src.onended = () => { if (s.playing === src) s.playing = null; };
  }
  stop(i) { const s = this.slots[i]; if (s?.playing) { s.playing.stop(); s.playing = null; } }
}
