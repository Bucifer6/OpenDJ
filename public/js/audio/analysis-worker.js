import { analyzeTrack, encodeWaveform } from './analysis-core.js';

self.onmessage = (e) => {
  const { id, sampleRate, left, right } = e.data;
  try {
    // background analysis sends the channels and lets the worker mix down (keeps that loop off the main thread)
    let mono = e.data.mono;
    if (!mono) { mono = left; if (right) for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] + right[i]) * 0.5; }
    const r = analyzeTrack(mono, sampleRate);
    const wave = encodeWaveform(r.waveform);
    self.postMessage({ id, result: { ...r, waveform: undefined }, wave }, [wave.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
