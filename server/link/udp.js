// Real network transport for LinkNode: one socket bound to 0.0.0.0:20808 that joins the Link multicast group on every
// IPv4 interface (receives alive/byebye), plus one unicast socket per interface (sends multicast with that interface,
// receives unicast responses, answers / sends measurement pings; its address:port is the advertised measurement
// endpoint). Interfaces are rescanned every 30 s (Wi-Fi changes, cables plugged in).
import dgram from 'node:dgram';
import os from 'node:os';
import { MULTICAST_ADDR, MULTICAST_PORT } from './protocol.js';

/** Non-internal IPv4 interface addresses (plus loopback when asked). */
export function ipv4Interfaces({ loopback = false, nets = os.networkInterfaces() } = {}) {
  const out = [];
  for (const [name, list] of Object.entries(nets || {})) {
    for (const a of list || []) {
      const fam = a.family === 4 ? 'IPv4' : a.family;
      if (fam !== 'IPv4') continue;
      if (a.internal && !loopback) continue;
      out.push({ name, address: a.address, netmask: a.netmask || '255.255.255.0', internal: !!a.internal });
    }
  }
  return out;
}

const ipNum = (ip) => String(ip).split('.').reduce((n, p) => (n * 256) + (Number(p) & 255), 0) >>> 0;
export const sameSubnet = (a, b, mask) => ((ipNum(a) & ipNum(mask)) >>> 0) === ((ipNum(b) & ipNum(mask)) >>> 0);

export class UdpTransport {
  /**
   * @param {object} [o]
   * @param {string[]} [o.interfaces]  fixed interface addresses (default: every IPv4 interface, rescanned)
   * @param {number} [o.port]          multicast port (20808)
   * @param {string} [o.group]         multicast group (224.76.78.75)
   * @param {boolean} [o.loopback]     also use 127.0.0.1 when there is no network
   */
  constructor({ interfaces = null, port = MULTICAST_PORT, group = MULTICAST_ADDR, loopback = true, log = null } = {}) {
    this.fixed = interfaces; this.port = port; this.group = group; this.loopback = loopback; this.log = log;
    this.mc = null; this.uni = new Map(); // address -> { socket, address, port, netmask }
    this.onMessage = null; this.errors = [];
  }

  _wanted() {
    if (this.fixed) return this.fixed.map((address) => ({ address, netmask: address.startsWith('127.') ? '255.0.0.0' : '255.255.255.0' }));
    const list = ipv4Interfaces();
    if (!list.length && this.loopback) return [{ address: '127.0.0.1', netmask: '255.0.0.0' }];
    return list;
  }

  async start(onMessage) {
    this.onMessage = onMessage;
    this.mc = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.mc.on('error', (e) => this._err('multicast socket', e));
    this.mc.on('message', (buf, r) => this.onMessage?.(buf, { address: r.address, port: r.port }));
    await new Promise((resolve, reject) => {
      this.mc.once('error', reject);
      this.mc.bind(this.port, '0.0.0.0', () => { this.mc.off('error', reject); resolve(); });
    });
    try { this.mc.setMulticastLoopback(true); } catch { /* */ }
    await this._scan();
    this._scanT = setInterval(() => this._scan().catch(() => {}), 30000);
    this._scanT.unref?.();
  }

  async _scan() {
    const wanted = this._wanted();
    const keep = new Set(wanted.map((w) => w.address));
    for (const [addr, u] of this.uni) {
      if (keep.has(addr)) continue;
      try { this.mc?.dropMembership(this.group, addr); } catch { /* gone */ }
      try { u.socket.close(); } catch { /* */ }
      this.uni.delete(addr);
    }
    for (const w of wanted) {
      if (this.uni.has(w.address)) continue;
      try { this.mc.addMembership(this.group, w.address); } catch (e) { this._err(`join group on ${w.address}`, e); }
      const s = dgram.createSocket({ type: 'udp4' });
      s.on('error', (e) => this._err(`socket ${w.address}`, e));
      s.on('message', (buf, r) => this.onMessage?.(buf, { address: r.address, port: r.port, iface: w.address }));
      try {
        await new Promise((resolve, reject) => { s.once('error', reject); s.bind(0, w.address, () => { s.off('error', reject); resolve(); }); });
        try { s.setMulticastInterface(w.address); } catch { /* */ }
        try { s.setMulticastLoopback(true); s.setMulticastTTL(1); } catch { /* */ }
        this.uni.set(w.address, { socket: s, address: w.address, port: s.address().port, netmask: w.netmask });
      } catch (e) { this._err(`bind ${w.address}`, e); try { s.close(); } catch { /* */ } }
    }
  }

  _err(what, e) {
    const msg = `${what}: ${e.message}`;
    this.errors.push(msg); if (this.errors.length > 20) this.errors.shift();
    this.log?.warn?.(`[link] ${msg}`);
  }

  endpoints() { return [...this.uni.values()].map((u) => ({ address: u.address, port: u.port })); }

  /** Our measurement endpoint on the interface that reaches `to`. */
  endpointFor(to) { const u = this._pick(to); return u ? { address: u.address, port: u.port } : null; }

  _pick(to) {
    const list = [...this.uni.values()];
    if (to?.iface && this.uni.has(to.iface)) return this.uni.get(to.iface);
    return list.find((u) => to?.address && sameSubnet(u.address, to.address, u.netmask)) || list.find((u) => !u.address.startsWith('127.')) || list[0];
  }

  /** build(endpoint) → Buffer, sent to the group once per interface (each advertising its own endpoint). */
  sendMulticast(build) {
    for (const u of this.uni.values()) {
      const buf = build({ address: u.address, port: u.port });
      this._pending = (this._pending || 0) + 1;
      u.socket.send(buf, this.port, this.group, (e) => { this._pending--; if (e) this._err(`send on ${u.address}`, e); });
    }
  }

  send(buf, to) {
    const u = this._pick(to);
    if (!u) return;
    u.socket.send(buf, to.port, to.address, (e) => { if (e) this._err(`send to ${to.address}`, e); });
  }

  async stop() {
    clearInterval(this._scanT);
    // let a final byebye leave before the sockets close
    for (let i = 0; i < 20 && this._pending > 0; i++) await new Promise((r) => setTimeout(r, 10));
    for (const u of this.uni.values()) { try { u.socket.close(); } catch { /* */ } }
    this.uni.clear();
    if (this.mc) { const mc = this.mc; this.mc = null; await new Promise((r) => { try { mc.close(r); } catch { r(); } }); }
  }
}
