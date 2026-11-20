// Generic HID controller support (WebHID) with learn-by-diff.
//
// HID DJ controllers send fixed-layout input reports. We don't need a per-device driver: in learn mode we watch the
// reports while the user moves one control and work out which bits/bytes changed:
//   single bit toggling            → button        key hid:<reportId>:bit:<byte>:<bit>
//   byte/word counting with wrap   → relative (jog) key hid:<reportId>:u8|u16le|u16be:<byte>   rel 'counter'
//   byte resting at 0, ±small      → relative (encoder sending deltas)                         rel 'delta'
//   byte/word sweeping             → absolute (fader/knob), 8 or 16 bit, little/big endian      max = full scale
// Mappings are stored with the MIDI ones under the device key `hid:VVVV:PPPP` (vendor/product id).
import { Emitter, clamp } from '../util.js';

const h4 = (n) => (n >>> 0).toString(16).padStart(4, '0').toUpperCase();
export const hidDeviceKey = (d) => `hid:${h4(d.vendorId)}:${h4(d.productId)}`;
const REMEMBER = 'opendj.hidDevices';

/** Parse an entry key `hid:<reportId>:<fmt>:<offset>[:<bit>]`. */
export function parseHidKey(key) {
  const [, rid, fmt, off, bit] = String(key).split(':');
  return { reportId: +rid, fmt, offset: +off, bit: bit == null ? null : +bit };
}
export function describeHidKey(key) {
  const k = parseHidKey(key);
  if (k.fmt === 'bit') return `HID r${k.reportId} byte ${k.offset} bit ${k.bit}`;
  return `HID r${k.reportId} ${k.fmt === 'u8' ? 'byte' : k.fmt === 'u16le' ? '16-bit LE' : '16-bit BE'} @${k.offset}`;
}

/** Read the raw value a key refers to from one report (bytes exclude the report id). */
export function readHid(bytes, k) {
  const o = k.offset;
  if (o >= bytes.length) return null;
  if (k.fmt === 'bit') return (bytes[o] >> k.bit) & 1;
  if (k.fmt === 'u8') return bytes[o];
  if (o + 1 >= bytes.length) return null;
  if (k.fmt === 'u16le') return bytes[o] | (bytes[o + 1] << 8);
  if (k.fmt === 'u16be') return (bytes[o] << 8) | bytes[o + 1];
  return null;
}

const popcount = (x) => { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; };

/** Byte offsets that change on their own (counters, sensors) in a stretch of reports recorded while idle. */
export function noisyBytes(frames) {
  const s = new Set();
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    for (let o = 0; o < Math.min(a.length, b.length); o++) if (a[o] !== b[o]) s.add(o);
  }
  return s;
}

/**
 * Work out which control moved from a sequence of reports (Uint8Arrays of one report id).
 * opts.hint: 'button' | 'abs' | 'rel' (the kind of target being learned), opts.noise: Set of byte offsets to ignore.
 * Returns { fmt, offset, bit?, mode: 'button'|'abs'|'rel', rel?: 'counter'|'delta', max? } or null.
 */
export function classifyHid(frames, { hint = null, noise = new Set() } = {}) {
  if (!frames || frames.length < 2) return null;
  const len = Math.min(...frames.map((f) => f.length));
  const transitions = new Array(len).fill(0), masks = new Array(len).fill(0);
  for (let i = 1; i < frames.length; i++) for (let o = 0; o < len; o++) {
    if (noise.has(o)) continue;
    const x = frames[i][o] ^ frames[i - 1][o];
    if (x) { transitions[o]++; masks[o] |= x; }
  }
  const changed = [];
  for (let o = 0; o < len; o++) if (transitions[o]) changed.push(o);
  if (!changed.length) return null;

  // ---- buttons: one bit flipping
  const bitCands = changed.filter((o) => popcount(masks[o]) === 1);
  const wantButton = hint === 'button' || (!hint && changed.length === bitCands.length && bitCands.length <= 2 && bitCands.every((o) => transitions[o] <= 6));
  if (wantButton) {
    if (bitCands.length) {
      const o = bitCands.reduce((a, b) => (transitions[b] > transitions[a] ? b : a));
      return { fmt: 'bit', offset: o, bit: Math.log2(masks[o]), mode: 'button' };
    }
    if (hint === 'button') { // pressure-sensitive pad: a whole byte that rises from 0
      const o = changed.reduce((a, b) => (transitions[b] > transitions[a] ? b : a));
      return { fmt: 'u8', offset: o, mode: 'button', max: 255 };
    }
  }

  // ---- values: the low byte jumps around, its high byte (a changed neighbour) moves in small steps
  const meanStep = (o) => { let sum = 0, n = 0; for (let i = 1; i < frames.length; i++) { const d = Math.abs(frames[i][o] - frames[i - 1][o]); if (d) { sum += Math.min(d, 256 - d); n++; } } return n ? sum / n : 0; };
  const lo = changed.reduce((a, b) => (transitions[b] > transitions[a] || (transitions[b] === transitions[a] && meanStep(b) > meanStep(a)) ? b : a));
  let fmt = 'u8', offset = lo;
  const hiCand = [lo + 1, lo - 1].filter((o) => o >= 0 && o < len && transitions[o] > 0 && meanStep(o) <= 8 && meanStep(o) < meanStep(lo));
  if (hiCand.length && meanStep(lo) >= 2) {
    const hi = hiCand.reduce((a, b) => (meanStep(b) < meanStep(a) ? b : a));
    if (hi === lo + 1) { fmt = 'u16le'; offset = lo; } else { fmt = 'u16be'; offset = hi; }
  }
  const k = { fmt, offset };
  const vals = frames.map((f) => readHid(f, k));
  const bits = fmt === 'u8' ? 8 : 16, range = 2 ** bits;
  const diffs = [];
  for (let i = 1; i < vals.length; i++) if (vals[i] !== vals[i - 1]) diffs.push(vals[i] - vals[i - 1]);
  const small = range / 16;
  const signed = vals.map((v) => (v >= range / 2 ? v - range : v));
  // encoder that reports a signed delta and rests at 0
  const steps = [];
  for (let i = 1; i < vals.length; i++) { let d = vals[i] - vals[i - 1]; if (d > range / 2) d -= range; if (d < -range / 2) d += range; if (d) steps.push(d); }
  const oneWay = steps.length >= 3 && (steps.every((d) => d > 0) || steps.every((d) => d < 0));
  const isDelta = !oneWay && signed.every((v) => Math.abs(v) <= small) && signed.some((v) => v !== 0) && (signed.includes(0) || signed.some((v) => v < 0) && signed.some((v) => v > 0) || new Set(signed).size <= 3);
  const wraps = diffs.some((d) => Math.abs(d) > range / 2);
  if (hint !== 'abs' && isDelta && (hint === 'rel' || bits === 8)) return { ...k, mode: 'rel', rel: 'delta' };
  if (hint === 'rel' || (!hint && wraps)) return { ...k, mode: 'rel', rel: 'counter' };
  // absolute: scale to the smallest common full-scale that covers what we saw
  const maxSeen = Math.max(...vals);
  const max = bits === 8 ? 255 : maxSeen <= 1023 ? 1023 : maxSeen <= 4095 ? 4095 : 65535;
  return { ...k, mode: 'abs', max };
}

/** Value decoding for playback. prev: previous raw value (for counters). Returns button 0/1, abs 0..1 or rel delta. */
export function decodeHid(entry, raw, prev) {
  const k = parseHidKey(entry.key);
  const range = k.fmt === 'u8' ? 256 : k.fmt === 'bit' ? 2 : 65536;
  if (entry.mode === 'button' || k.fmt === 'bit') return raw > 0 ? 1 : 0;
  if (entry.mode === 'rel') {
    if (entry.rel === 'delta') return raw >= range / 2 ? raw - range : raw;
    if (prev == null) return 0;
    let d = raw - prev;
    if (d > range / 2) d -= range;
    if (d < -range / 2) d += range;
    return d;
  }
  return clamp(raw / (entry.max || range - 1), 0, 1);
}

export class HidManager extends Emitter {
  constructor(midi) {
    super();
    this.midi = midi;
    this.devices = new Map(); // HIDDevice -> { key, name }
    this.prev = new Map();    // `${key}#${reportId}` -> Uint8Array
    this.history = new Map(); // `${key}#${reportId}` -> [{ t, bytes }]
    this.learnBuf = null;
  }
  get supported() { return typeof navigator !== 'undefined' && !!navigator.hid; }
  remembered() { try { return JSON.parse(localStorage.getItem(REMEMBER) || '[]'); } catch { return []; } }
  remember(key) { try { const r = new Set(this.remembered()); r.add(key); localStorage.setItem(REMEMBER, JSON.stringify([...r])); } catch { /* storage blocked */ } }
  forget(key) { try { localStorage.setItem(REMEMBER, JSON.stringify(this.remembered().filter((k) => k !== key))); } catch { /* ignore */ } }

  async init() {
    if (!this.supported) return;
    navigator.hid.addEventListener('connect', (e) => { if (this.remembered().includes(hidDeviceKey(e.device))) this.attach(e.device); });
    navigator.hid.addEventListener('disconnect', (e) => this.detach(e.device));
    // re-open devices the user picked before (permission persists)
    const known = this.remembered();
    for (const d of await navigator.hid.getDevices()) if (known.includes(hidDeviceKey(d))) await this.attach(d);
  }
  /** Ask the user to pick a HID device (browser chooser, or OpenDJ's chooser in the desktop app). */
  async request() {
    if (!this.supported) throw new Error('WebHID is not available. Use the OpenDJ desktop app, Chrome or Edge.');
    const picked = await navigator.hid.requestDevice({ filters: [] });
    let n = 0;
    for (const d of picked) if (await this.attach(d)) n++;
    if (picked.length && !n) throw new Error('That device could not be opened (keyboards and mice are reserved by the system).');
    return picked.length ? hidDeviceKey(picked[0]) : null;
  }
  async attach(d) {
    if (this.devices.has(d)) return true;
    try { if (!d.opened) await d.open(); } catch (e) { console.warn('HID open failed', d.productName, e); return false; }
    const key = hidDeviceKey(d);
    this.devices.set(d, { key, name: d.productName || key });
    d.addEventListener('inputreport', (e) => this.onReport(key, e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength)));
    this.remember(key);
    this.midi.emit('devices');
    return true;
  }
  detach(d) { if (this.devices.delete(d)) this.midi.emit('devices'); }
  async disconnect(key) {
    for (const [d, info] of this.devices) if (info.key === key) { try { await d.close(); } catch { /* ignore */ } this.devices.delete(d); }
    this.forget(key); this.midi.emit('devices');
  }
  list() {
    const seen = new Map();
    for (const info of this.devices.values()) if (!seen.has(info.key)) seen.set(info.key, info);
    return [...seen.values()];
  }

  /** Feed one input report. Public so tests / the e2e script can drive it without hardware. */
  onReport(key, reportId, data) {
    const bytes = Uint8Array.from(data);
    const id = `${key}#${reportId}`;
    const prev = this.prev.get(id);
    this.prev.set(id, bytes);
    const now = performance.now();
    if (!prev || prev.some((b, i) => b !== bytes[i]) || prev.length !== bytes.length) this.midi.touch(key);
    const hist = this.history.get(id) || [];
    hist.push({ t: now, bytes }); while (hist.length > 64 || (hist.length && now - hist[0].t > 1500)) hist.shift();
    this.history.set(id, hist);
    this.emit('report', { key, reportId, bytes });

    const L = this.midi.learning;
    if (L && L.deviceName === key) { this.learnFrame(key, reportId, bytes, now); return; }
    if (this.midi.suppress === key) return;
    if (!prev) return;
    const map = this.midi.mappings[key];
    if (!map) return;
    for (const e of map.entries) {
      if (!e.key.startsWith(`hid:${reportId}:`)) continue;
      const k = e._k || (Object.defineProperty(e, '_k', { value: parseHidKey(e.key), enumerable: false }), e._k);
      const raw = readHid(bytes, k), old = readHid(prev, k);
      if (raw == null) continue;
      if (raw === old && !(e.mode === 'rel' && e.rel === 'delta' && raw !== 0)) continue;
      const v = decodeHid(e, raw, old);
      const t = this.midi.byId.get(e.target);
      if (!t) continue;
      if (t.kind === 'rel' || e.mode !== 'rel') this.midi.dispatch(e, v);
      else this.midi.nudge(e, t, v / 128);
    }
  }

  learnFrame(key, reportId, bytes, now) {
    const L = this.midi.learning;
    if (!this.learnBuf || this.learnBuf.target !== L.targetId || this.learnBuf.key !== key) {
      // reports seen in the last second while idle tell us which bytes are noise
      const noise = new Map();
      for (const [id, hist] of this.history) if (id.startsWith(`${key}#`)) noise.set(+id.split('#')[1], noisyBytes(hist.filter((h) => now - h.t > 120).map((h) => h.bytes)));
      this.learnBuf = { key, target: L.targetId, frames: new Map(), noise, first: null };
    }
    const B = this.learnBuf;
    if (!B.frames.has(reportId)) { const base = this.history.get(`${key}#${reportId}`); B.frames.set(reportId, base && base.length > 1 ? [base[base.length - 2].bytes] : []); }
    const fr = B.frames.get(reportId);
    const last = fr[fr.length - 1];
    if (!last || last.some((b, i) => b !== bytes[i])) {
      const noise = B.noise.get(reportId) || new Set();
      if (last && B.first == null && last.some((b, i) => b !== bytes[i] && !noise.has(i))) B.first = now;
      fr.push(bytes);
    }
    if (B.first == null) return;
    const t = this.midi.byId.get(L.targetId);
    const wait = t?.kind === 'button' ? 250 : 900;
    if (now - B.first < wait) { if (!B.timer) B.timer = setTimeout(() => this.finishLearn(), wait + 50); return; }
    this.finishLearn();
  }
  finishLearn() {
    const B = this.learnBuf; this.learnBuf = null;
    const L = this.midi.learning;
    if (!B || !L || B.target !== L.targetId) return;
    clearTimeout(B.timer);
    const t = this.midi.byId.get(L.targetId);
    let best = null;
    for (const [rid, frames] of B.frames) {
      const r = classifyHid(frames, { hint: t?.kind, noise: B.noise.get(rid) || new Set() });
      if (r && (!best || frames.length > best.n)) best = { r, rid, n: frames.length };
    }
    if (!best) return; // nothing usable: keep listening
    const r = best.r;
    const entry = { key: `hid:${best.rid}:${r.fmt}:${r.offset}${r.fmt === 'bit' ? `:${r.bit}` : ''}`, target: L.targetId, mode: r.mode };
    if (r.rel) entry.rel = r.rel;
    if (r.max) entry.max = r.max;
    this.midi.completeLearn(B.key, entry);
  }
}
