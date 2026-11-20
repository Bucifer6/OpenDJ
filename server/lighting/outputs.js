// Network outputs: Art-Net, sACN, WLED, OSC (UDP) and Philips Hue (local bridge REST).
// Each output gets every rendered frame via send(frame, now) and decides itself what (and how often) to send.
import dgram from 'node:dgram';
import { encodeArtDmx, artPortAddress, nextArtSeq, encodeSacn, nextSacnSeq, sacnMulticastAddress, encodeOsc, encodeWled } from './protocols.js';

const KEEPALIVE_MS = 1000; // resend unchanged DMX at least this often (receivers time out after ~2.5 s)

/** One lazily-bound UDP socket shared by the UDP outputs. Sends before the bind completes are queued. */
export class Udp {
  constructor({ createSocket = dgram.createSocket } = {}) { this.createSocket = createSocket; this.sock = null; this.ready = false; this.queue = []; this.error = null; }
  _open() {
    if (this.sock) return;
    const s = this.sock = this.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => { this.error = e.message; });
    s.bind(0, () => {
      try { s.setBroadcast(true); s.setMulticastTTL(8); } catch { /* not supported */ }
      s.unref?.();
      this.ready = true;
      for (const [b, p, h] of this.queue.splice(0)) this.send(b, p, h);
    });
  }
  send(buf, port, host) {
    this._open();
    if (!this.ready) { if (this.queue.length < 64) this.queue.push([buf, port, host]); return; }
    this.sock.send(buf, port, host, (e) => { this.error = e ? e.message : null; });
  }
  close() { try { this.sock?.close(); } catch { /* closed */ } this.sock = null; this.ready = false; this.queue = []; }
}

const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

class DmxOutput {
  constructor(udp) { this.udp = udp; this.last = new Map(); this.seq = new Map(); this.packets = 0; }
  shouldSend(key, data, now) {
    const l = this.last.get(key);
    if (l && l.t + KEEPALIVE_MS > now && same(l.data, data)) return false;
    this.last.set(key, { t: now, data: Uint8Array.from(data) });
    return true;
  }
}

export class ArtNetOutput extends DmxOutput {
  constructor(cfg, udp) { super(udp); this.cfg = cfg; }
  send(frame, now) {
    const { host, port, net, subnet, universe } = this.cfg;
    for (const [u, data] of frame.universes) {
      if (!this.shouldSend(u, data, now)) continue;
      const portAddress = artPortAddress(net, subnet, universe) + (u - 1);
      const seq = nextArtSeq(this.seq.get(u) || 0); this.seq.set(u, seq);
      this.udp.send(encodeArtDmx(data, { portAddress, sequence: seq }), port, host);
      this.packets++;
    }
  }
}

export class SacnOutput extends DmxOutput {
  constructor(cfg, udp) { super(udp); this.cfg = cfg; this.cid = Buffer.from(cfg.cid, 'hex'); }
  send(frame, now) {
    const c = this.cfg;
    for (const [u, data] of frame.universes) {
      if (!this.shouldSend(u, data, now)) continue;
      const universe = c.universe + (u - 1);
      const seq = this.seq.has(u) ? nextSacnSeq(this.seq.get(u)) : 0; this.seq.set(u, seq);
      const pkt = encodeSacn(data, { universe, sequence: seq, priority: c.priority, sourceName: c.sourceName, cid: this.cid });
      this.udp.send(pkt, c.port, c.multicast || !c.host ? sacnMulticastAddress(universe) : c.host);
      this.packets++;
    }
  }
}

export class WledOutput {
  constructor(cfg, fixtures, udp) { this.cfg = cfg; this.fixtures = fixtures.filter((f) => f.type === 'wled-strip' && f.host); this.udp = udp; this.last = new Map(); this.packets = 0; }
  send(frame, now) {
    for (const f of this.fixtures) {
      const px = frame.pixels.get(f.id); if (!px) continue;
      const l = this.last.get(f.id);
      if (l && l.t + KEEPALIVE_MS > now && same(l.px, px)) continue;
      this.last.set(f.id, { t: now, px: Uint8Array.from(px) });
      for (const pkt of encodeWled(px, { timeout: this.cfg.timeout })) { this.udp.send(pkt, this.cfg.port, f.host); this.packets++; }
    }
  }
}

/**
 * OSC: /beat i (beat in bar 1..4) on every beat, /downbeat on bar starts, /bpm f, /phrase s f (type, energy) on change,
 * /level f and /color f f f at up to 20 Hz.
 */
export class OscOutput {
  constructor(cfg, udp) { this.cfg = cfg; this.udp = udp; this.prev = {}; this.t = { level: 0, color: 0, bpm: 0 }; this.packets = 0; }
  _send(path, args) { this.udp.send(encodeOsc(this.cfg.prefix + path, args), this.cfg.port, this.cfg.host); this.packets++; }
  send(frame, now) {
    const m = frame.music, p = this.prev;
    if (m.playing && m.beatIndex !== p.beat) {
      this._send('/beat', [m.barBeat + 1]);
      if (m.barBeat === 0) this._send('/downbeat', [1]);
    }
    p.beat = m.playing ? m.beatIndex : null;
    if (Math.abs(m.bpm - (p.bpm || 0)) > 0.01 || now - this.t.bpm > 1000) { this._send('/bpm', [{ f: m.bpm }]); p.bpm = m.bpm; this.t.bpm = now; }
    const ph = m.playing ? m.phrase : 'stopped';
    if (ph !== p.phrase) { this._send('/phrase', [ph || 'none', { f: m.phraseEnergy }]); p.phrase = ph; }
    if (now - this.t.level >= 50) { this._send('/level', [{ f: m.level }]); this.t.level = now; }
    const c = frame.color.map((x) => Math.round(x * 1000) / 1000);
    if (now - this.t.color >= 50 && !same(c, p.color)) { this._send('/color', c.map((f) => ({ f }))); p.color = c; this.t.color = now; }
  }
}

/** Token bucket: `rate` tokens per second, burst of `burst`. */
export class RateLimiter {
  constructor(rate, burst = 1) { this.rate = rate; this.burst = burst; this.tokens = burst; this.t = null; }
  take(now) {
    if (this.t == null) this.t = now;
    this.tokens = Math.min(this.burst, this.tokens + (now - this.t) / 1000 * this.rate);
    this.t = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

const hueDiff = (a, b) => !b || a.on !== b.on || Math.abs(a.bri - b.bri) > 6 || Math.abs(a.sat - b.sat) > 10
  || Math.min(Math.abs(a.hue - b.hue), 65536 - Math.abs(a.hue - b.hue)) > 600;

/**
 * Philips Hue: the bridge handles ~10 light commands per second in total, so lights are updated round-robin,
 * only when their colour changed noticeably, through a shared rate limiter, with transitiontime smoothing.
 */
export class HueOutput {
  constructor(cfg, fixtures, { fetch: f = globalThis.fetch } = {}) {
    this.cfg = cfg; this.fetch = f;
    this.lights = fixtures.filter((x) => x.type === 'hue-light' && x.hueId);
    this.limiter = new RateLimiter(Math.min(10, cfg.rate || 10), 2);
    this.sent = new Map(); this.rr = 0; this.inflight = 0; this.packets = 0; this.error = null;
  }
  send(frame, now) {
    if (!this.cfg.bridge || !this.cfg.username || !this.lights.length) return;
    for (let k = 0; k < this.lights.length; k++) {
      const f = this.lights[(this.rr + k) % this.lights.length];
      const st = frame.hue.get(f.id);
      if (!st || !hueDiff(st, this.sent.get(f.id))) continue;
      if (this.inflight >= 3 || !this.limiter.take(now)) return;
      this.rr = (this.rr + k + 1) % this.lights.length;
      this.sent.set(f.id, st);
      const body = st.on ? { on: true, bri: st.bri, hue: st.hue, sat: st.sat, transitiontime: this.cfg.transition } : { on: false, transitiontime: this.cfg.transition };
      this.inflight++; this.packets++;
      Promise.resolve().then(() => this.fetch(`http://${this.cfg.bridge}/api/${this.cfg.username}/lights/${encodeURIComponent(f.hueId)}/state`, {
        method: 'PUT', body: JSON.stringify(body), signal: AbortSignal.timeout(2000),
      })).then(() => { this.error = null; }, (e) => { this.error = e.message; this.sent.delete(f.id); }).finally(() => { this.inflight--; });
      return; // at most one command per frame
    }
  }
}

// ---------------------------------------------------------------- Hue bridge helpers
export async function hueDiscover({ fetch: f = globalThis.fetch } = {}) {
  const r = await f('https://discovery.meethue.com/', { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Hue discovery failed (${r.status})`);
  return (await r.json()).map((b) => ({ id: b.id, ip: b.internalipaddress }));
}
export async function huePair(bridge, { fetch: f = globalThis.fetch } = {}) {
  const r = await f(`http://${bridge}/api`, { method: 'POST', body: JSON.stringify({ devicetype: 'opendj#app' }), signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  const ok = j?.[0]?.success?.username;
  if (ok) return ok;
  const err = j?.[0]?.error;
  throw new Error(err?.type === 101 ? 'Press the link button on the Hue bridge, then click Pair again within 30 seconds.' : (err?.description || 'Pairing failed'));
}
export async function hueLights(bridge, username, { fetch: f = globalThis.fetch } = {}) {
  const r = await f(`http://${bridge}/api/${username}/lights`, { signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  if (Array.isArray(j) && j[0]?.error) throw new Error(j[0].error.description);
  return Object.entries(j || {}).map(([id, l]) => ({ id, name: l.name, type: l.type, color: !!l.state?.hue || /color/i.test(l.type || '') }));
}
