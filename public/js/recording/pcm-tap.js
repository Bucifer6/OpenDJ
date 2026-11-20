// Shared master-output tap for recording and broadcasting. One AudioWorkletNode on engine.masterOut, any number of
// subscribers. Re-connects itself after Engine.applyOutputs() (which disconnects masterOut).
const loaded = new WeakSet();

export class PcmTap {
  /** @param {object} engine  the app's Engine (ctx, masterOut, on('outputs')) */
  constructor(engine, { chunkSeconds = 0.5 } = {}) {
    this.engine = engine; this.ctx = engine.ctx;
    this.chunkFrames = Math.round(this.ctx.sampleRate * chunkSeconds);
    this.subs = new Set(); this.node = null; this._cutId = 0; this._cuts = new Map();
  }
  get sampleRate() { return this.ctx.sampleRate; }
  async init() {
    if (this.node) return;
    if (!loaded.has(this.ctx)) { await this.ctx.audioWorklet.addModule(new URL('./tap-worklet.js', import.meta.url)); loaded.add(this.ctx); }
    this.node = new AudioWorkletNode(this.ctx, 'opendj-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { chunkFrames: this.chunkFrames } });
    // keep the node pulled by the graph through a muted path to the destination
    this.sink = this.ctx.createGain(); this.sink.gain.value = 0;
    this.node.connect(this.sink); this.sink.connect(this.ctx.destination);
    this.node.port.onmessage = (e) => this._onChunk(e.data);
    this.connect();
    this._offOutputs = this.engine.on?.('outputs', () => this.connect());
  }
  connect() { try { this.engine.masterOut.connect(this.node); } catch { /* connecting twice is harmless */ } }
  _onChunk(m) {
    for (const fn of [...this.subs]) { try { fn(m); } catch (e) { console.error(e); } }
    if (m.cut !== undefined && m.cut !== true) { const r = this._cuts.get(m.cut); this._cuts.delete(m.cut); r?.(); }
  }
  /** fn({ pcm: Float32Array, frames, peakL, peakR }) for every chunk until the returned function is called. */
  async subscribe(fn) {
    await this.init();
    this.subs.add(fn);
    if (this.subs.size === 1) this.node.port.postMessage({ cmd: 'on' });
    return () => this.unsubscribe(fn);
  }
  /** Deliver the partial chunk now (so a subscriber can leave without losing the tail). */
  cut() {
    if (!this.node || !this.subs.size) return Promise.resolve();
    const id = ++this._cutId;
    return new Promise((resolve) => { this._cuts.set(id, resolve); this.node.port.postMessage({ cmd: 'cut', id }); setTimeout(() => { this._cuts.delete(id); resolve(); }, 1000); });
  }
  unsubscribe(fn) {
    this.subs.delete(fn);
    if (!this.subs.size && this.node) this.node.port.postMessage({ cmd: 'off' });
  }
}

/** Float32 interleaved -> little-endian Int16 bytes (with clipping). */
export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const v = f32[i]; out[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767); }
  return out;
}

const taps = new WeakMap();
/** One tap per engine. */
export function tapFor(engine) { if (!taps.has(engine)) taps.set(engine, new PcmTap(engine)); return taps.get(engine); }
