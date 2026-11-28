// Show engine: keeps the beat clock fed by the renderer, renders frames at `fps` and drives the outputs.
import { normalizeConfig, renderFrame, LIVE_DEFAULTS, musicAt } from './show.js';
import { Udp, ArtNetOutput, SacnOutput, WledOutput, OscOutput, HueOutput } from './outputs.js';

const PREVIEW_MS = 66; // ~15 fps preview to the panel

export class LightingEngine {
  constructor({ config, emit = () => {}, now = Date.now, fetch: f = globalThis.fetch, udp } = {}) {
    this.emit = emit; this.now = now; this.fetch = f;
    this.udp = udp || new Udp();
    this.live = { ...LIVE_DEFAULTS };
    this.state = null;
    this.subs = new Set();
    this.outputs = {};
    this.frames = 0;
    this.setConfig(config);
  }

  setConfig(cfg) {
    this.config = normalizeConfig(cfg);
    const o = this.config.outputs, fx = this.config.fixtures;
    this.outputs = {};
    if (o.artnet.enabled) this.outputs.artnet = new ArtNetOutput(o.artnet, this.udp);
    if (o.sacn.enabled) this.outputs.sacn = new SacnOutput(o.sacn, this.udp);
    if (o.wled.enabled) this.outputs.wled = new WledOutput(o.wled, fx, this.udp);
    if (o.osc.enabled) this.outputs.osc = new OscOutput(o.osc, this.udp);
    if (o.hue.enabled) this.outputs.hue = new HueOutput(o.hue, fx, { fetch: this.fetch });
    this._schedule();
    return this.config;
  }

  /** Music state from the renderer. Small corrections are smoothed so the extrapolated clock never jumps back. */
  setState(s) {
    const now = this.now();
    const next = {
      playing: !!s.playing, bpm: Number(s.bpm) || 0, beat: Number(s.beat) || 0, at: Number(s.at) || now,
      barOffset: s.barOffset | 0, phrase: s.phrase || null, phraseBeat: Number(s.phraseBeat) || 0, phraseLen: Number(s.phraseLen) || 0,
      phraseEnergy: Number.isFinite(+s.phraseEnergy) ? +s.phraseEnergy : 0.7, level: Number(s.level) || 0, key: s.key || null, energy: Number(s.energy) || 5,
    };
    if (Math.abs(next.at - now) > 5000) next.at = now; // clocks of renderer and server disagree: trust arrival time
    const prev = this.state;
    if (prev?.playing && next.playing && Math.abs(prev.bpm - next.bpm) < 0.5) {
      const predicted = musicAt(prev, next.at).beat;
      const err = next.beat - predicted;
      if (Math.abs(err) < 0.1) { next.beat = predicted + err * 0.35; next.phraseBeat -= err * 0.65; } // PLL-style slew
    }
    this.state = next;
    this._schedule();
  }

  setLive(patch = {}) {
    const p = patch || {};
    for (const k of ['blackout', 'strobe', 'full']) if (k in p) this.live[k] = !!p[k];
    if ('color' in p) this.live.color = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : null;
    if ('freeze' in p) {
      this.live.freeze = !!p.freeze;
      this.frozen = this.live.freeze ? { state: this.state, t: this.now() } : null;
    }
    let showChanged = false;
    for (const k of ['auto', 'master', 'speed', 'manualEffect']) if (k in p) { this.config.show[k] = p[k]; showChanged = true; }
    if (showChanged) this.config = normalizeConfig(this.config);
    this.tick();
    return { live: this.live, showChanged };
  }

  /** Full-white flash on all outputs for `ms`. */
  test(ms = 1000) { this.live.test = this.now() + ms; this._schedule(true); this.tick(); }

  get running() { return !!this.timer; }
  _schedule(force = false) {
    const want = this.config.enabled || force || this.live.test > this.now() || this.subs.size > 0;
    if (want && !this.timer) {
      this.timer = setInterval(() => this.tick(), Math.round(1000 / this.config.fps));
      this.timer.unref?.();
    } else if (!want && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  render(now = this.now()) {
    const live = { ...this.live, test: this.live.test > now };
    const show = { ...this.config, live };
    if (this.live.freeze && this.frozen) return renderFrame(show, this.frozen.state, this.frozen.t);
    return renderFrame(show, this.state, now);
  }

  tick() {
    const now = this.now();
    const testing = this.live.test > now;
    if (!testing && this.live.test) { this.live.test = 0; this._schedule(); }
    const frame = this.render(now);
    this.lastFrame = frame; this.frames++;
    if (this.config.enabled || testing) {
      for (const [k, o] of Object.entries(this.outputs)) {
        try { o.send(frame, now); } catch (e) { o.error = e.message; this.emit('lighting', { error: `${k}: ${e.message}` }); }
      }
    }
    if (this.subs.size) this._stream(frame, now, testing);
    return frame;
  }

  status() {
    const o = {};
    for (const [k, out] of Object.entries(this.outputs)) o[k] = { packets: out.packets || 0, error: out.error || (['artnet', 'sacn', 'wled', 'osc'].includes(k) ? this.udp.error : null) || null };
    const m = this.lastFrame?.music;
    return { running: this.running, frames: this.frames, outputs: o, effect: this.lastFrame?.effect || null, bpm: m?.bpm || 0, phrase: m?.phrase || null, playing: !!m?.playing, usb: [...this.subs].some((s) => s.dmx) };
  }

  // ---------------------------------------------------------------- live stream (preview + USB DMX frames)
  /** res: an HTTP response. opts: { preview: bool, dmx: universe|0 } */
  subscribe(res, { preview = false, dmx = 0 } = {}) {
    const sub = { res, preview, dmx, tp: 0, td: 0, last: null };
    this.subs.add(sub);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ fixtures: this.config.fixtures.map((f) => ({ id: f.id, name: f.name, type: f.type, group: f.group, pixels: f.pixels || 0 })) })}\n\n`);
    const drop = () => { this.subs.delete(sub); this._schedule(); };
    res.on('close', drop); res.on('error', drop);
    this._schedule();
    return sub;
  }

  _stream(frame, now, testing) {
    let previewMsg = null;
    let previewStatusMsg = null;
    const dmxCache = new Map();
    for (const s of this.subs) {
      if (s.res.destroyed || s.res.writableEnded || s.res.writableLength > 262144) {
        this.subs.delete(s);
        try { s.res.destroy(); } catch { /* */ }
        continue;
      }
      if (s.preview && now - s.tp >= PREVIEW_MS) {
        s.tp = now;
        const needStatus = now - (s.ts || 0) > 1000;
        if (needStatus) s.ts = now;
        if (needStatus ? !previewStatusMsg : !previewMsg) {
          const px = {};
          for (const [id, p] of frame.pixels) { // downsample strips to <= 48 cells for the preview
            const n = p.length / 3, k = Math.min(48, n), cells = [];
            for (let i = 0; i < k; i++) { const j = Math.floor((i + 0.5) * n / k) * 3; cells.push(((p[j] << 16) | (p[j + 1] << 8) | p[j + 2]).toString(16).padStart(6, '0')); }
            px[id] = cells.join('');
          }
          const m = frame.music;
          const base = { l: frame.looks, px, effect: frame.effect, playing: m.playing, bpm: Math.round(m.bpm * 10) / 10, beat: m.barBeat, phrase: m.phrase, live: this.live };
          if (needStatus) previewStatusMsg = `event: preview\ndata: ${JSON.stringify({ ...base, status: this.status() })}\n\n`;
          else previewMsg = `event: preview\ndata: ${JSON.stringify(base)}\n\n`;
        }
        s.res.write(needStatus ? previewStatusMsg : previewMsg);
      }
      if (s.dmx && (this.config.enabled || testing) && this.config.outputs.usbdmx.enabled) {
        const data = frame.universes.get(s.dmx) || new Uint8Array(512);
        const changed = !s.last || data.some((v, i) => v !== s.last[i]);
        if (changed || now - s.td > 1000) {
          s.td = now;
          if (!s.last) s.last = new Uint8Array(512);
          s.last.set(data);
          let b64 = dmxCache.get(s.dmx);
          if (!b64) { b64 = `event: dmx\ndata: ${Buffer.from(data.buffer, data.byteOffset, 512).toString('base64')}\n\n`; dmxCache.set(s.dmx, b64); }
          s.res.write(b64);
        }
      }
    }
  }

  close() { clearInterval(this.timer); this.timer = null; this.udp.close(); for (const s of this.subs) s.res.end(); this.subs.clear(); }
}
