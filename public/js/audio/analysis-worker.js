import { analyzeTrack, encodeWaveform } from './analysis-core.js';

self.onmessage = (e) => {
  const { id, mono, sampleRate } = e.data;
  try {
    const r = analyzeTrack(mono, sampleRate);
    const wave = encodeWaveform(r.waveform);
    self.postMessage({ id, result: { ...r, waveform: undefined }, wave }, [wave.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
