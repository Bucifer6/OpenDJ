// Demo library generator: synthesises a dozen FICTIONAL dance-music tracks (invented artists, titles, albums)
// as tagged MP3s with embedded cover art, so README screenshots are reproducible without real music.
//
//   node scripts/demo/make-demo-library.mjs [outDir] [--force] [--only=<n>]
//
// outDir defaults to <os tmp>/opendj-demo-library. Existing MP3s are kept unless --force is given.
// Needs ffmpeg (node_modules/ffmpeg-static, else OPENDJ_FFMPEG or ffmpeg on PATH) and Playwright's Chromium for
// the cover art. Everything is generated locally: no samples, images or fonts are downloaded.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SR = 44100;

// ------------------------------------------------------------------ the (fictional) catalogue
export const TRACKS = [
  { artist: 'Nova Kline', title: 'Midnight Transit', album: 'Night Lines', genre: 'House', year: 2025, bpm: 124, key: [9, 'minor'], style: 'house', seed: 11 },
  { artist: 'Solace Theory', title: 'Glass Horizon', album: 'Glass Horizon EP', genre: 'House', year: 2026, bpm: 122, key: [5, 'minor'], style: 'house', seed: 23 },
  { artist: 'Kairo Vance', title: 'Pressure Index', album: 'Pressure Index', genre: 'Tech House', year: 2025, bpm: 126, key: [7, 'minor'], style: 'techhouse', seed: 37 },
  { artist: 'Lumen Drift', title: 'Copper Skyline', album: 'Rooftop Sessions Vol. 2', genre: 'Tech House', year: 2024, bpm: 125, key: [2, 'minor'], style: 'techhouse', seed: 41 },
  { artist: 'Hollow Atlas', title: 'Iron Meridian', album: 'Meridian', genre: 'Techno', year: 2026, bpm: 130, key: [4, 'minor'], style: 'techno', seed: 53 },
  { artist: 'Vexa Moreau', title: 'Static Bloom', album: 'Static Bloom', genre: 'Techno', year: 2025, bpm: 132, key: [0, 'minor'], style: 'techno', seed: 67 },
  { artist: 'Orbital Fern', title: 'Signal Fire', album: 'Signal Fire / Undertow', genre: 'Drum & Bass', year: 2025, bpm: 174, key: [6, 'minor'], style: 'dnb', seed: 71 },
  { artist: 'Rhea Calder', title: 'Liquid Coastline', album: 'Tidal Memory', genre: 'Drum & Bass', year: 2024, bpm: 172, key: [11, 'minor'], style: 'dnb', seed: 83 },
  { artist: 'The Velvet Arcade', title: 'Saturday Satellite', album: 'Mirrorball Stories', genre: 'Disco', year: 2024, bpm: 118, key: [5, 'major'], style: 'disco', seed: 97 },
  { artist: 'Marisol Vega & The Neon Choir', title: 'Golden Hour Fever', album: 'Golden Hour', genre: 'Disco', year: 2026, bpm: 116, key: [7, 'major'], style: 'disco', seed: 101 },
  { artist: 'Dex Halloway', title: 'Concrete Lullaby', album: 'Paper Streetlights', genre: 'Hip-Hop', year: 2025, bpm: 100, key: [1, 'minor'], style: 'hiphop', seed: 113 },
  { artist: 'Kito Marrow', title: 'Late Night Ledger', album: 'Ledger', genre: 'Hip-Hop', year: 2026, bpm: 96, key: [10, 'minor'], style: 'hiphop', seed: 127 },
];

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const keyName = ([pc, mode]) => NOTE[pc] + (mode === 'minor' ? 'm' : '');

// ------------------------------------------------------------------ small DSP toolkit
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); }; }
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

class Biquad {
  constructor(type, f, q = 0.707) { this.type = type; this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(f, q); }
  set(f, q = this.q) {
    this.q = q; f = Math.max(10, Math.min(f, SR * 0.45));
    const w = 2 * Math.PI * f / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
    let b0, b1, b2;
    if (this.type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (this.type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = a; b1 = 0; b2 = -a; } // band-pass (0 dB peak)
    const a0 = 1 + a;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = -2 * c / a0; this.a2 = (1 - a) / a0;
  }
  run(x) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}

class Bus {
  constructor(n, stereo = true) { this.L = new Float32Array(n); this.R = stereo ? new Float32Array(n) : this.L; this.n = n; }
  add(start, mono, gain = 1, pan = 0) { // pan -1..1, equal power
    const gl = gain * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = gain * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    const s0 = Math.round(start * SR);
    for (let i = 0; i < mono.length; i++) { const k = s0 + i; if (k < 0) continue; if (k >= this.n) break; this.L[k] += mono[i] * gl; if (this.R !== this.L) this.R[k] += mono[i] * gr; }
  }
}

// ------------------------------------------------------------------ instruments (return mono Float32Arrays)
function kick(r, { len = 0.42, hi = 140, lo = 46, drop = 32, decay = 7, click = 0.35 } = {}) {
  const n = Math.round(len * SR), out = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = lo + hi * Math.exp(-t * drop); ph += 2 * Math.PI * f / SR;
    const env = Math.exp(-t * decay) * Math.min(1, t * 2000);
    out[i] = Math.tanh(1.6 * Math.sin(ph) * env) + click * (r() * 2 - 1) * Math.exp(-t * 350);
  }
  return out;
}
function noiseHit(r, { len, decay, type = 'hp', f = 7000, q = 0.8, bursts = null, tone = 0, toneF = 190, toneDecay = 22 }) {
  const n = Math.round(len * SR), out = new Float32Array(n), flt = new Biquad(type, f, q);
  for (let i = 0; i < n; i++) {
    const t = i / SR; let env;
    if (bursts) { env = 0; for (const b of bursts) if (t >= b) env = Math.max(env, Math.exp(-(t - b) * (b === bursts.at(-1) ? decay : 160))); }
    else env = Math.exp(-t * decay);
    env *= Math.min(1, t * 4000);
    out[i] = flt.run(r() * 2 - 1) * env + tone * Math.sin(2 * Math.PI * toneF * t) * Math.exp(-t * toneDecay);
  }
  return out;
}
const clap = (r) => noiseHit(r, { len: 0.35, decay: 16, type: 'bp', f: 1300, q: 0.9, bursts: [0, 0.011, 0.022] });
const snare = (r, bright = 1) => noiseHit(r, { len: 0.3, decay: 15, type: 'bp', f: 2400 * bright, q: 0.6, tone: 0.55, toneF: 185 });
const hatC = (r) => noiseHit(r, { len: 0.06, decay: 70, f: 8000 });
const hatO = (r) => noiseHit(r, { len: 0.32, decay: 10, f: 7500 });
const shaker = (r) => noiseHit(r, { len: 0.08, decay: 45, type: 'bp', f: 6000, q: 1.2 });
const crash = (r) => noiseHit(r, { len: 2.4, decay: 1.6, f: 4500, q: 0.5 });
function rim(r) { return noiseHit(r, { len: 0.06, decay: 60, type: 'bp', f: 1800, q: 4, tone: 0.5, toneF: 820, toneDecay: 70 }); }

// band-limited enough at bass/chord pitches; light polyBLEP on the saw keeps the highs clean
function saw(ph, dt) { let v = 2 * ph - 1; if (ph < dt) { const t = ph / dt; v -= t + t - t * t - 1; } else if (ph > 1 - dt) { const t = (ph - 1) / dt; v -= t * t + t + t + 1; } return v; }

function synthNote(freq, len, o) {
  const { wave = 'saw', voices = 1, detune = 0, cutoff = 2000, envAmt = 0, envDecay = 8, q = 0.9, attack = 0.005, release = 0.08, decay = 0, sub = 0, drive = 1, vibrato = 0 } = o;
  const n = Math.round((len + release) * SR), out = new Float32Array(n), flt = new Biquad('lp', cutoff, q);
  const phases = Array.from({ length: voices }, (_, v) => (v * 0.37) % 1);
  const dets = Array.from({ length: voices }, (_, v) => voices === 1 ? 1 : Math.pow(2, ((v / (voices - 1)) * 2 - 1) * detune / 1200));
  let subPh = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if ((i & 31) === 0) flt.set(cutoff + envAmt * Math.exp(-t * envDecay));
    const vib = vibrato ? 1 + vibrato * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, t * 2) : 1;
    let s = 0;
    for (let v = 0; v < voices; v++) {
      const dt = freq * dets[v] * vib / SR; let ph = phases[v] + dt; if (ph >= 1) ph -= 1; phases[v] = ph;
      s += wave === 'saw' ? saw(ph, dt) : wave === 'square' ? (ph < 0.5 ? 1 : -1) : wave === 'tri' ? 4 * Math.abs(ph - 0.5) - 1 : Math.sin(2 * Math.PI * ph);
    }
    s /= Math.sqrt(voices);
    if (sub) { subPh += freq / 2 / SR; s += sub * Math.sin(2 * Math.PI * subPh); }
    let env = Math.min(1, t / attack);
    if (decay) env *= Math.exp(-t * decay);
    if (t > len) env *= Math.max(0, 1 - (t - len) / release);
    const y = flt.run(s) * env;
    out[i] = drive > 1 ? Math.tanh(y * drive) / Math.tanh(drive) : y;
  }
  return out;
}
function keys(freq, len) { // electric-piano-ish: sine + decaying bell harmonics + tremolo
  const n = Math.round((len + 0.3) * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, rel = t > len ? Math.max(0, 1 - (t - len) / 0.3) : 1;
    const v = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 1.2) + 0.35 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 4) + 0.12 * Math.sin(2 * Math.PI * freq * 7 * t) * Math.exp(-t * 18);
    out[i] = v * rel * (1 + 0.15 * Math.sin(2 * Math.PI * 4.5 * t)) * Math.min(1, t * 300);
  }
  return out;
}
function sub808(freq, len) {
  const n = Math.round((len + 0.1) * SR), out = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = freq * (1 + 1.2 * Math.exp(-t * 40)); ph += 2 * Math.PI * f / SR;
    const rel = t > len ? Math.max(0, 1 - (t - len) / 0.1) : 1;
    out[i] = Math.tanh(2.2 * Math.sin(ph)) * 0.8 * Math.exp(-t * 0.9) * rel * Math.min(1, t * 1500);
  }
  return out;
}
function riser(r, len, { from = 300, to = 7000 } = {}) {
  const n = Math.round(len * SR), out = new Float32Array(n), flt = new Biquad('bp', from, 2.5);
  for (let i = 0; i < n; i++) { const k = i / n; if ((i & 31) === 0) flt.set(from * Math.pow(to / from, k * k)); out[i] = flt.run(r() * 2 - 1) * k * k * 2.2; }
  return out;
}
function impact(len = 1.6) { const n = Math.round(len * SR), out = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { const t = i / SR; ph += 2 * Math.PI * (38 + 60 * Math.exp(-t * 8)) / SR; out[i] = Math.sin(ph) * Math.exp(-t * 2.4); } return out; }

// ------------------------------------------------------------------ arrangement
const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };
const PROGRESSIONS = {
  minor: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [0, 2, 3, 4]],
  major: [[0, 4, 5, 3], [1, 4, 0, 5], [0, 3, 4, 3], [0, 5, 3, 4]],
};
const STRUCTURES = {
  default: [['intro', 16], ['build', 8], ['drop', 32], ['breakdown', 16], ['build', 8], ['drop', 32], ['outro', 16]],
  dnb: [['intro', 32], ['build', 8], ['drop', 32], ['breakdown', 16], ['build', 8], ['drop', 32], ['outro', 16]],
  hiphop: [['intro', 8], ['build', 4], ['drop', 24], ['breakdown', 8], ['build', 4], ['drop', 24], ['outro', 8]],
};

export function renderTrack(def) {
  const r = rng(def.seed);
  const beat = 60 / def.bpm, bar = beat * 4, step = beat / 4;
  const structure = STRUCTURES[def.style] || STRUCTURES.default;
  const bars = structure.reduce((a, [, b]) => a + b, 0);
  const total = bars * bar + 2.5;
  const N = Math.ceil(total * SR);
  const drums = new Bus(N), bass = new Bus(N, false), music = new Bus(N), fx = new Bus(N);
  const [pc, mode] = def.key, scale = SCALES[mode];
  const prog = PROGRESSIONS[mode][def.seed % 4];
  const rootMidi = 36 + pc; // bass octave
  const chordOf = (deg, size = 3) => Array.from({ length: size }, (_, k) => { const d = deg + 2 * k; return 12 * Math.floor(d / 7) + scale[d % 7]; });
  const swing = def.style === 'hiphop' ? 0.12 : def.style === 'disco' ? 0.08 : 0;
  const at = (barIdx, s) => barIdx * bar + s * step + (s % 2 === 1 ? swing * step : 0);
  // pre-rendered one-shots (slight variants so repeats don't look cloned)
  const K = def.style === 'techno' ? kick(r, { decay: 6, hi: 160, lo: 44, click: 0.45 }) : def.style === 'hiphop' ? kick(r, { len: 0.5, decay: 5, hi: 110, lo: 50 }) : def.style === 'dnb' ? kick(r, { len: 0.3, decay: 10, hi: 170, lo: 52 }) : kick(r);
  const CL = [clap(r), clap(r)], SN = [snare(r), snare(r, 1.2)], HC = [hatC(r), hatC(r), hatC(r)], HO = hatO(r), SH = shaker(r), CR = crash(r), RM = rim(r);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const kickTimes = [];

  let b0 = 0;
  for (let si = 0; si < structure.length; si++) {
    const [sec, len] = structure[si];
    const isDrop = sec === 'drop', second = si > 3;
    for (let bi = 0; bi < len; bi++) {
      const B = b0 + bi, chord = prog[Math.floor(B / (def.style === 'hiphop' ? 1 : 2)) % 4];
      const lastBars = len - bi; // bars until the section ends
      const fill = isDrop && bi % 8 === 7; // drum fill / variation every 8 bars
      // ---------------- drums
      const kicks = sec === 'breakdown' ? [] : sec === 'build' && lastBars <= 1 ? [] :
        def.style === 'dnb' ? [0, 10] : def.style === 'hiphop' ? (bi % 2 ? [0, 8, 14] : [0, 8]) : [0, 4, 8, 12];
      if (!(sec === 'intro' && def.style === 'dnb' && bi < 8)) for (const s of kicks) { drums.add(at(B, s), K, def.style === 'hiphop' ? 0.9 : 1); kickTimes.push(at(B, s)); }
      const backbeat = sec === 'intro' ? bi >= 8 : sec !== 'breakdown';
      if (backbeat) {
        if (def.style === 'dnb' || def.style === 'hiphop') { for (const s of [4, 12]) drums.add(at(B, s), pick(SN), 0.75); if (def.style === 'dnb' && isDrop) drums.add(at(B, 7), SN[0], 0.18); }
        else if (def.style === 'disco') for (const s of [4, 12]) { drums.add(at(B, s), pick(SN), 0.5); drums.add(at(B, s), pick(CL), 0.35); }
        else if (def.style !== 'techno' || isDrop || sec === 'outro') for (const s of [4, 12]) drums.add(at(B, s), pick(CL), 0.75);
      }
      if (sec !== 'breakdown') {
        const sixteenths = def.style === 'techhouse' || def.style === 'disco' || (def.style === 'dnb' && isDrop) || (isDrop && def.style === 'techno');
        for (let s = 0; s < 16; s++) {
          const off = s % 4 === 2;
          if (def.style === 'hiphop') { if (s % 2 === 0) drums.add(at(B, s), pick(HC), s % 4 === 0 ? 0.42 : 0.26); continue; }
          if (def.style === 'dnb') { if (s % 4 === 0) drums.add(at(B, s), RM, 0.3, 0.2); if (s % 2 === 0) drums.add(at(B, s), pick(HC), s % 4 === 0 ? 0.36 : 0.22); else if (isDrop) drums.add(at(B, s), pick(HC), 0.12); continue; }
          if (off && def.style !== 'dnb') drums.add(at(B, s), HO, sec === 'intro' && bi < 4 ? 0.18 : 0.36);
          else if (sixteenths || s % 2 === 0) drums.add(at(B, s), pick(HC), s % 2 ? 0.16 : 0.24);
        }
        if ((def.style === 'techhouse' || def.style === 'house') && (isDrop || sec === 'outro')) for (const s of [3, 7, 11, 15]) drums.add(at(B, s), SH, 0.14, 0.4);
        if (def.style === 'techhouse' && isDrop) for (const s of [6, 14]) drums.add(at(B, s), RM, 0.2, -0.3);
      }
      if (fill) for (let s = 12; s < 16; s++) drums.add(at(B, s), pick(SN), 0.25 + 0.08 * (s - 12));
      // snare roll in builds
      if (sec === 'build') {
        const density = lastBars > 4 ? 4 : lastBars > 2 ? 2 : 1; // steps between hits
        for (let s = 0; s < 16; s += density) drums.add(at(B, s), SN[s % 2], 0.12 + 0.5 * ((len - lastBars) * 16 + s) / (len * 16));
      }
      if (bi === 0 && (isDrop || (sec === 'outro'))) { drums.add(at(B, 0), CR, 0.45); fx.add(at(B, 0), impact(), isDrop ? 0.6 : 0.3); }
      // ---------------- bass
      const bassOn = isDrop || (sec === 'build') || (sec === 'intro' && bi >= len / 2 && def.style !== 'dnb') || (sec === 'outro' && bi < len / 2);
      if (bassOn) {
        const root = rootMidi + chordOf(chord)[0], f = mtof(root), f8 = mtof(root + 12);
        if (def.style === 'house') for (const s of [2, 6, 10, 14]) bass.add(at(B, s), synthNote(s === 14 && bi % 2 ? f8 : f, step * 1.6, { cutoff: 380, envAmt: 1400, envDecay: 18, voices: 2, detune: 8, sub: 0.6 }), 0.34);
        else if (def.style === 'techhouse') for (const [s, o] of [[2, 0], [3, 0], [6, 12], [7, 0], [10, 0], [11, 7], [14, 0]]) bass.add(at(B, s), synthNote(mtof(root + o), step * 0.8, { wave: 'square', cutoff: 300, envAmt: 1800, envDecay: 26, q: 2.5, sub: 0.7 }), 0.32);
        else if (def.style === 'techno') for (let s = 0; s < 16; s++) { if (s % 4 === 0) continue; bass.add(at(B, s), synthNote(f / 2 * 2, step * 0.7, { wave: 'sine', cutoff: 200, decay: 12, drive: 2 }), 0.35); if (s % 4 === 2 && isDrop) bass.add(at(B, s), synthNote(f8, step * 0.5, { cutoff: 500, envAmt: 2500, envDecay: 35, q: 4 }), 0.12); }
        else if (def.style === 'dnb') { const notes = [[0, 8], [8, 6], [14, 2]]; for (const [s, l] of notes) bass.add(at(B, s), synthNote(f / 2 * 2 * (s === 6 ? 1.5 ** 0 : 1), step * l, { voices: 3, detune: 22, cutoff: 260 + 400 * (bi % 4) / 4, envAmt: 600, envDecay: 6, sub: 0.9, drive: 2.5 }), 0.4); }
        else if (def.style === 'disco') for (let s = 0; s < 16; s += 2) bass.add(at(B, s), synthNote(s % 4 ? f8 : f, step * 1.4, { cutoff: 600, envAmt: 2200, envDecay: 22, sub: 0.5 }), 0.36);
        else if (def.style === 'hiphop') for (const s of kicks) bass.add(at(B, s), sub808(f / 2 * 2, s === 0 ? step * 6 : step * 3), 0.55);
      }
      // ---------------- harmony
      const notes = chordOf(chord, def.style === 'disco' || def.style === 'hiphop' ? 4 : 3).map((x) => 60 + pc + x - (pc > 5 ? 12 : 0));
      const padBar = sec === 'breakdown' || (sec === 'intro' && def.style === 'dnb' && bi >= 16) || (def.style === 'dnb' && isDrop);
      if (padBar && bi % (def.style === 'hiphop' ? 1 : 2) === 0) for (const [k, m] of notes.entries()) music.add(B * bar, synthNote(mtof(m), bar * (def.style === 'hiphop' ? 1 : 2) - 0.05, { voices: 3, detune: 14, cutoff: 900 + (sec === 'breakdown' ? 1400 * bi / len : 600), attack: 0.35, release: 0.8, vibrato: def.style === 'disco' ? 0.004 : 0 }), sec === 'breakdown' ? 0.17 : 0.11, (k - 1.5) * 0.4);
      if ((isDrop || (sec === 'build' && def.style !== 'techno')) && !padBar) {
        if (def.style === 'house') for (const s of [0, 3, 6, 10]) for (const [k, m] of notes.entries()) music.add(at(B, s), synthNote(mtof(m), step * 1.2, { voices: 2, detune: 10, cutoff: 700, envAmt: 3500, envDecay: 14, release: 0.12 }), 0.16, (k - 1) * 0.35);
        else if (def.style === 'techhouse' && (bi % 2 === 0)) for (const [k, m] of notes.entries()) music.add(at(B, 6), synthNote(mtof(m), step * 2, { voices: 2, detune: 12, cutoff: 500, envAmt: 3000, envDecay: 10, q: 3 }), 0.12, (k - 1) * 0.5);
        else if (def.style === 'disco') { for (const s of [2, 6, 10, 14]) for (const [k, m] of notes.entries()) music.add(at(B, s), keys(mtof(m), step * 1.5), 0.08, (k - 1.5) * 0.3); if (second) for (const [k, m] of notes.entries()) music.add(B * bar, synthNote(mtof(m + 12), bar - 0.05, { voices: 3, detune: 10, cutoff: 3500, attack: 0.15, release: 0.3, vibrato: 0.004 }), 0.05, (k - 1.5) * 0.5); }
        else if (def.style === 'hiphop') for (const [k, m] of notes.entries()) music.add(B * bar + k * 0.012, keys(mtof(m), bar * 0.9), 0.12, (k - 1.5) * 0.3);
      }
      if (def.style === 'hiphop' && sec === 'breakdown') for (const [k, m] of notes.entries()) music.add(B * bar, keys(mtof(m), bar * 0.9), 0.1, (k - 1.5) * 0.3);
      // arpeggio: breakdowns, techno drops and second drops
      const arpOn = (sec === 'breakdown' && bi >= 4) || (isDrop && (second || def.style === 'techno')) || (def.style === 'techno' && sec === 'build');
      if (arpOn && def.style !== 'hiphop') {
        const pat = [0, 1, 2, 1, 3, 2, 1, 2];
        for (let s = 0; s < 16; s += def.style === 'dnb' ? 2 : 1) {
          const n = notes[pat[s % 8] % notes.length] + (s >= 8 && def.style !== 'techno' ? 12 : 0);
          music.add(at(B, s), synthNote(mtof(n + 12), step * 0.6, { wave: def.style === 'techno' ? 'saw' : 'square', cutoff: 600 + (def.style === 'techno' ? 1600 * (0.5 + 0.5 * Math.sin(B / 3)) : 900), envAmt: 2500, envDecay: 25, q: def.style === 'techno' ? 6 : 1.2, release: 0.05 }), 0.07, s % 2 ? 0.55 : -0.55);
        }
      }
    }
    // risers into each drop
    if (sec === 'build') fx.add(b0 * bar, riser(r, len * bar), 0.18);
    if (sec === 'breakdown') fx.add(b0 * bar, riser(r, 4 * bar, { from: 6000, to: 400 }), 0.05);
    b0 += len;
  }

  // ---------------- mix: sidechain pump, build filter sweeps, soft clip, normalise
  const duck = new Float32Array(N).fill(1);
  if (def.style !== 'hiphop' && def.style !== 'dnb') for (const t of kickTimes) { const s0 = Math.round(t * SR); for (let i = 0; i < 0.25 * SR && s0 + i < N; i++) duck[s0 + i] = Math.min(duck[s0 + i], 1 - 0.55 * Math.exp(-i / SR / 0.09)); }
  const sweep = new Float32Array(N).fill(20000); // low-pass on bass + music during builds
  b0 = 0;
  for (const [sec, len] of structure) {
    if (sec === 'build') for (let i = Math.round(b0 * bar * SR); i < Math.round((b0 + len) * bar * SR) && i < N; i++) { const k = (i / SR - b0 * bar) / (len * bar); sweep[i] = 250 * Math.pow(60, k); }
    b0 += len;
  }
  const lpL = new Biquad('lp', 20000), lpR = new Biquad('lp', 20000), lpB = new Biquad('lp', 20000);
  const outL = new Float32Array(N), outR = new Float32Array(N);
  let peak = 0;
  for (let i = 0; i < N; i++) {
    if ((i & 63) === 0) { lpL.set(sweep[i]); lpR.set(sweep[i]); lpB.set(Math.min(sweep[i] * 1.5, 20000)); }
    const d = duck[i];
    const b = lpB.run(bass.L[i]) * d;
    let l = drums.L[i] * 0.8 + b + lpL.run(music.L[i]) * d + fx.L[i];
    let rr = drums.R[i] * 0.8 + b + lpR.run(music.R[i]) * d + fx.R[i];
    l = Math.tanh(l * 1.3); rr = Math.tanh(rr * 1.3);
    outL[i] = l; outR[i] = rr; peak = Math.max(peak, Math.abs(l), Math.abs(rr));
  }
  const g = 0.94 / (peak || 1);
  for (let i = 0; i < N; i++) { outL[i] *= g; outR[i] *= g; }
  // short fade out at the very end
  for (let i = 0; i < SR; i++) { const k = N - 1 - i, f = i / SR; outL[k] *= f; outR[k] *= f; }
  return { L: outL, R: outR, seconds: total };
}

function writeWav(file, { L, R }) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}

// ------------------------------------------------------------------ cover art (generative, rendered in Chromium)
const PALETTES = {
  house: [['#ff6b6b', '#4b1d6b', '#ffd166'], ['#06d6a0', '#073b4c', '#ffd166']],
  techhouse: [['#f72585', '#3a0ca3', '#4cc9f0'], ['#fb8500', '#023047', '#8ecae6']],
  techno: [['#e5e5e5', '#111111', '#ff2e2e'], ['#9ef01a', '#0b090a', '#d9d9d9']],
  dnb: [['#00f5d4', '#0d1b2a', '#f15bb5'], ['#4361ee', '#10002b', '#4cc9f0']],
  disco: [['#ffbe0b', '#8338ec', '#ff006e'], ['#ff99c8', '#3d348b', '#fcf6bd']],
  hiphop: [['#e9c46a', '#264653', '#e76f51'], ['#f4a261', '#1d1d1d', '#2a9d8f']],
};
function coverHtml(def, idx) {
  const pal = PALETTES[def.style][idx % 2];
  return `<!doctype html><html><head><style>html,body{margin:0;background:#000}canvas{display:block}</style></head><body><canvas id="c" width="600" height="600"></canvas><script>{ // block scope: setContent() reuses the window
  const def = ${JSON.stringify({ ...def, pal })};
  let s = def.seed * 9301 + 49297; const r = () => (s = (s * 9301 + 49297) % 233280) / 233280;
  const c = document.getElementById('c').getContext('2d'), W = 600, [A, BG, C] = def.pal;
  const g = c.createLinearGradient(0, 0, W, W); g.addColorStop(0, BG); g.addColorStop(1, '#000'); c.fillStyle = g; c.fillRect(0, 0, W, W);
  const style = def.style;
  if (style === 'techno') { // concentric rings + scanlines
    for (let i = 26; i > 0; i--) { c.beginPath(); c.arc(300, 270, i * 11, 0, Math.PI * 2); c.strokeStyle = i % 3 ? A + '55' : C; c.lineWidth = i % 3 ? 1.5 : 3; c.stroke(); }
    for (let y = 0; y < W; y += 4) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(0, y, W, 1); }
  } else if (style === 'dnb') { // flowing waves
    for (let k = 0; k < 28; k++) { c.beginPath(); for (let x = 0; x <= W; x += 6) { const y = 120 + k * 13 + Math.sin(x / (40 + k * 2) + k * 0.6) * (20 + k * 1.5) + Math.sin(x / 13 + k) * 3; x ? c.lineTo(x, y) : c.moveTo(x, y); } c.strokeStyle = k % 4 ? A + '66' : C; c.lineWidth = k % 4 ? 1.2 : 2.4; c.stroke(); }
  } else if (style === 'disco') { // sunburst + mirrorball dots
    for (let i = 0; i < 36; i++) { c.beginPath(); c.moveTo(300, 330); const a0 = i / 36 * Math.PI * 2, a1 = a0 + Math.PI / 36; c.arc(300, 330, 700, a0, a1); c.closePath(); c.fillStyle = i % 2 ? A + '33' : C + '22'; c.fill(); }
    for (let y = -6; y <= 6; y++) for (let x = -6; x <= 6; x++) { const d = Math.hypot(x, y); if (d > 6) continue; c.fillStyle = r() > 0.5 ? '#ffffff' : A; c.globalAlpha = 0.35 + 0.65 * r(); c.fillRect(300 + x * 15 - 6, 300 + y * 15 - 6, 12, 12); } c.globalAlpha = 1;
  } else if (style === 'hiphop') { // stacked blocks, risograph feel
    for (let i = 0; i < 9; i++) { c.fillStyle = [A, C, '#f1faee'][i % 3]; c.globalAlpha = 0.85; const w = 80 + r() * 260, h = 30 + r() * 110; c.fillRect(40 + r() * (W - 80 - w), 40 + r() * 360, w, h); } c.globalAlpha = 1;
    for (let i = 0; i < 9000; i++) { c.fillStyle = 'rgba(0,0,0,' + (r() * 0.25) + ')'; c.fillRect(r() * W, r() * W, 1.5, 1.5); }
  } else { // house / tech house: gradient orbs + grid
    for (let i = 0; i < 6; i++) { const x = r() * W, y = r() * 420, rad = 80 + r() * 200; const rg = c.createRadialGradient(x, y, 0, x, y, rad); rg.addColorStop(0, (i % 2 ? A : C) + 'cc'); rg.addColorStop(1, (i % 2 ? A : C) + '00'); c.fillStyle = rg; c.fillRect(0, 0, W, W); }
    c.strokeStyle = 'rgba(255,255,255,0.08)'; c.lineWidth = 1; for (let x = 0; x <= W; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, W); c.stroke(); c.beginPath(); c.moveTo(0, x); c.lineTo(W, x); c.stroke(); }
    if (style === 'techhouse') { c.save(); c.translate(300, 260); c.rotate(Math.PI / 4); c.strokeStyle = C; c.lineWidth = 6; c.strokeRect(-110, -110, 220, 220); c.restore(); }
  }
  // typography
  c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(0, 440, W, 160);
  c.fillStyle = '#fff'; c.font = '800 46px "Inter Display", Inter, "DejaVu Sans", sans-serif'; c.textBaseline = 'alphabetic';
  const title = def.title.toUpperCase(); let fs = 46; while (c.measureText(title).width > 540 && fs > 20) { fs -= 2; c.font = '800 ' + fs + 'px "Inter Display", Inter, sans-serif'; }
  c.fillText(title, 30, 510);
  c.fillStyle = A; c.font = '500 24px Inter, "DejaVu Sans", sans-serif'; c.fillText(def.artist, 30, 548);
  c.fillStyle = 'rgba(255,255,255,0.55)'; c.font = '400 15px "JetBrains Mono", monospace'; c.fillText(def.genre.toUpperCase() + '  ·  ' + def.bpm + ' BPM  ·  ' + def.year, 30, 578);
  }</script></body></html>`;
}

async function makeCovers(defs, dir) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } });
  const files = [];
  for (const [i, def] of defs.entries()) {
    await page.setContent(coverHtml(def, def.i ?? i));
    const f = path.join(dir, `cover-${i}.jpg`);
    await page.locator('canvas').screenshot({ path: f, type: 'jpeg', quality: 90 });
    files.push(f);
  }
  await browser.close();
  return files;
}

export function ffmpegPath() {
  if (process.env.OPENDJ_FFMPEG) return process.env.OPENDJ_FFMPEG;
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch { /* not installed */ }
  return 'ffmpeg';
}
export const fileName = (def) => (def.file || `${def.artist} - ${def.title}.mp3`).replace(/[\\/:*?"<>|]/g, '_');

/**
 * Render `tracks` (default: the fictional catalogue above) into outDir. Other scripts pass their own definitions
 * (same fields as TRACKS; optional `file` name and `comment`), e.g. scripts/review-pack/build-review-pack.mjs.
 */
export async function makeDemoLibrary(outDir = path.join(os.tmpdir(), 'opendj-demo-library'), { force = false, only = null, log = console.log, tracks = TRACKS } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const defs = tracks.map((t, i) => ({ ...t, i })).filter((t) => only == null || t.i === only);
  const todo = defs.filter((d) => force || !fs.existsSync(path.join(outDir, fileName(d))));
  if (!todo.length) { log(`demo library up to date in ${outDir}`); return outDir; }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opendj-demo-work-'));
  const covers = await makeCovers(todo, work);
  const ff = ffmpegPath();
  for (const [k, def] of todo.entries()) {
    const t0 = Date.now();
    const audio = renderTrack(def);
    const wav = path.join(work, `t${def.i}.wav`);
    writeWav(wav, audio);
    const out = path.join(outDir, fileName(def));
    const meta = { title: def.title, artist: def.artist, album_artist: def.artist, album: def.album, genre: def.genre, date: String(def.year), track: String(def.i + 1), TBPM: String(def.bpm), TKEY: keyName(def.key), comment: def.comment || 'Fictional demo track synthesised by OpenDJ scripts/demo/make-demo-library.mjs' };
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-i', covers[k], '-map', '0', '-map', '1', '-c:a', 'libmp3lame', '-b:a', '192k', '-c:v', 'mjpeg', '-id3v2_version', '3',
      ...Object.entries(meta).flatMap(([key, v]) => ['-metadata', `${key}=${v}`]), '-metadata:s:v', 'title=Album cover', '-metadata:s:v', 'comment=Cover (front)', out];
    const res = spawnSync(ff, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (res.status !== 0) throw new Error(`ffmpeg failed for ${def.title}`);
    fs.rmSync(wav);
    log(`  ${fileName(def)}  ${Math.floor(audio.seconds / 60)}:${String(Math.round(audio.seconds % 60)).padStart(2, '0')}  ${def.bpm} BPM ${keyName(def.key)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  return outDir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith('--'));
  const only = args.find((a) => a.startsWith('--only='));
  const dir = await makeDemoLibrary(outDir ? path.resolve(outDir) : undefined, { force: args.includes('--force'), only: only ? Number(only.slice(7)) : null });
  console.log(`demo library: ${dir}`);
}
