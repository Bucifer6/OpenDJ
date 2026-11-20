// In-process network for tests: every transport gets a fake IPv4 endpoint; multicast reaches every attached transport
// (including the sender, like multicast loopback), unicast reaches the one with that endpoint. Optional latency/jitter
// and packet loss make the clock-offset measurement do real work.
export class MemoryNetwork {
  constructor({ latencyMs = 0, jitterMs = 0, loss = 0, rand = Math.random } = {}) {
    this.latencyMs = latencyMs; this.jitterMs = jitterMs; this.loss = loss; this.rand = rand;
    this.nodes = new Map(); this.seq = 1; this.sent = 0;
  }

  transport() {
    const net = this;
    const t = {
      address: `10.0.0.${net.seq++}`, port: 40000 + net.seq, handler: null,
      async start(onMessage) { t.handler = onMessage; net.nodes.set(`${t.address}:${t.port}`, t); },
      async stop() { net.nodes.delete(`${t.address}:${t.port}`); t.handler = null; },
      endpoints() { return [{ address: t.address, port: t.port }]; },
      endpointFor() { return { address: t.address, port: t.port }; },
      sendMulticast(build) { const buf = build({ address: t.address, port: t.port }); for (const n of [...net.nodes.values()]) net._deliver(n, buf, t); },
      send(buf, to) { const n = net.nodes.get(`${to.address}:${to.port}`); if (n) net._deliver(n, buf, t); },
    };
    return t;
  }

  _deliver(target, buf, from) {
    this.sent++;
    if (this.loss && this.rand() < this.loss) return;
    const copy = Buffer.from(buf);
    const delay = this.latencyMs + (this.jitterMs ? this.rand() * this.jitterMs : 0);
    const go = () => target.handler?.(copy, { address: from.address, port: from.port });
    if (delay > 0) setTimeout(go, delay); else queueMicrotask(go);
  }
}
