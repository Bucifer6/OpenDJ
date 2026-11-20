// AudioWorklet: taps the master output and posts interleaved stereo Float32 chunks (~0.5 s) to the main thread.
// Loaded with ctx.audioWorklet.addModule() by pcm-tap.js. Messages in: { cmd: 'on' | 'off' | 'cut', id }.
// Messages out: { pcm: Float32Array (interleaved L/R), frames, peakL, peakR, cut?: id }.
class OpenDjPcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.size = Math.max(128, (options.processorOptions && options.processorOptions.chunkFrames) || 24000);
    this.on = false; this.n = 0; this.pl = 0; this.pr = 0;
    this.buf = new Float32Array(this.size * 2);
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.cmd === 'on') { this.on = true; }
      else if (m.cmd === 'off') { this.flush(m.id); this.on = false; }
      else if (m.cmd === 'cut') { this.flush(m.id); }
    };
  }
  flush(id) {
    const pcm = this.buf.slice(0, this.n * 2);
    this.port.postMessage({ pcm, frames: this.n, peakL: this.pl, peakR: this.pr, cut: id ?? true }, [pcm.buffer]);
    this.n = 0; this.pl = 0; this.pr = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!this.on) return true;
    const l = inp && inp[0], r = inp && (inp[1] || inp[0]);
    const len = l ? l.length : 128; // no input connected: record silence so the timeline keeps going
    for (let i = 0; i < len; i++) {
      const a = l ? l[i] : 0, b = r ? r[i] : 0;
      this.buf[this.n * 2] = a; this.buf[this.n * 2 + 1] = b;
      const aa = a < 0 ? -a : a, bb = b < 0 ? -b : b;
      if (aa > this.pl) this.pl = aa; if (bb > this.pr) this.pr = bb;
      if (++this.n === this.size) {
        const pcm = this.buf;
        this.port.postMessage({ pcm, frames: this.n, peakL: this.pl, peakR: this.pr }, [pcm.buffer]);
        this.buf = new Float32Array(this.size * 2); this.n = 0; this.pl = 0; this.pr = 0;
      }
    }
    return true;
  }
}
registerProcessor('opendj-pcm-tap', OpenDjPcmTap);
