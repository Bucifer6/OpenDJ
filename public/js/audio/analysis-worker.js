import { analyzeTrack, encodeWaveform } from './analysis-core.js';

self.onmessage = (e) => {
  const { id, sampleRate, left, right } = e.data;
  try {
    // deck loads and background analysis send the mono mix; left / right (mixed down here) are still accepted
    let mono = e.data.mono;
    if (!mono) { mono = left; if (right) for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] + right[i]) * 0.5; }
    const r = analyzeTrack(mono, sampleRate);
    const wave = encodeWaveform(r.waveform);
    self.postMessage({ id, result: { ...r, waveform: undefined }, wave }, [wave.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
