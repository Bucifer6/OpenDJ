// AI stems: DSP (FFT, Demucs STFT round trip, chunking + overlap-add), model runner, worklet mixing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fftPlan, demucsSpec, demucsISpec, planChunks, chunkInput, separateChunked, transitionWeight,
  interleaveInt16, floatToInt16, specFrames, BINS, STEMS, DEMUCS_SOURCES,
} from '../public/js/stems/stem-dsp.js';
import { createRunner, createStubSession, StubTensor } from '../public/js/stems/stems-model.js';
import { stemCoefficients, readStemMix, smoothGains, effectiveGains, isUnity, deckStemBytes } from '../public/js/stems/stem-mix.js';

const maxAbs = (a, b, from = 0, to = a.length) => { let m = 0; for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
function noise(n, seed = 1) { let s = seed; const o = new Float32Array(n); for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; o[i] = (s / 0x7fffffff - 0.5) * 0.8; } return o; }

test('stems: FFT matches a naive DFT', () => {
  const n = 64, p = fftPlan(n), x = noise(n, 3), y = noise(n, 4);
  const re = Float64Array.from(x), im = Float64Array.from(y);
  p.fft(re, im);
  for (const k of [0, 1, 5, 31, 32, 63]) {
    let sr = 0, si = 0;
    for (let t = 0; t < n; t++) { const a = -2 * Math.PI * k * t / n; sr += x[t] * Math.cos(a) - y[t] * Math.sin(a); si += x[t] * Math.sin(a) + y[t] * Math.cos(a); }
    assert.ok(Math.abs(re[k] - sr) < 1e-9 && Math.abs(im[k] - si) < 1e-9, `bin ${k}`);
  }
});

test('stems: Demucs spectrogram puts a sine in the right bin, both channels', () => {
  const n = 44100, mix = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) { mix[i] = Math.sin(2 * Math.PI * 1000 * i / 44100); mix[n + i] = 0.5 * Math.sin(2 * Math.PI * 3000 * i / 44100); }
  const le = specFrames(n), z = demucsSpec(mix, 2, n);
  assert.equal(z.length, 4 * BINS * le);
  const mag = (ch, f, t) => Math.hypot(z[((ch * 2) * BINS + f) * le + t], z[((ch * 2 + 1) * BINS + f) * le + t]);
  const peak = (ch) => { let best = 0, bi = 0; for (let f = 0; f < BINS; f++) { const m = mag(ch, f, 20); if (m > best) { best = m; bi = f; } } return bi; };
  assert.equal(peak(0), Math.round(1000 * 4096 / 44100));
  assert.equal(peak(1), Math.round(3000 * 4096 / 44100));
});

test('stems: ispec(spec(x)) reconstructs x away from the segment edges', () => {
  // band-limited test signal: HT-Demucs drops the Nyquist bin, so white noise would not come back exactly
  const n = 30000, mix = new Float32Array(2 * n), r = noise(64, 5);
  for (let i = 0; i < n; i++) for (let k = 0; k < 32; k++) { const f = 40 + k * 610; mix[i] += 0.03 * Math.sin(2 * Math.PI * f * i / 44100 + r[k] * 9); mix[n + i] += 0.03 * Math.cos(2 * Math.PI * (f + 13) * i / 44100 + r[k + 32] * 9); }
  const out = demucsISpec(demucsSpec(mix, 2, n), 1, 2, n);
  // HT-Demucs drops two STFT frames at each end, so the first/last ~1.5k samples are not exact (the time branch
  // and the overlap-add window cover them); the interior must be exact.
  // (residual ~1e-5 comes from the dropped Nyquist bin; verified identical against a numpy torch.stft reference)
  assert.ok(maxAbs(out, mix, 2048, n - 2048) < 1e-4, 'left channel');
  assert.ok(maxAbs(out, mix, n + 2048, 2 * n - 2048) < 1e-4, 'right channel');
});

test('stems: chunk plan covers the track with the Demucs stride', () => {
  const { stride, chunks } = planChunks(1000, 400, 0.25);
  assert.equal(stride, 300);
  assert.deepEqual(chunks.map((c) => [c.offset, c.length]), [[0, 400], [300, 400], [600, 400], [900, 100]]);
  assert.deepEqual(planChunks(50, 400).chunks, [{ offset: 0, length: 50 }]);
  const w = transitionWeight(400);
  assert.ok(w.every((v) => v > 0 && v <= 1));
  // short final chunk is centred, with real audio as context
  const L = Float32Array.from({ length: 1000 }, (_, i) => i), inp = chunkInput([L, L], 1000, 900, 100, 400);
  assert.equal(inp[150], 900); assert.equal(inp[249], 999); assert.equal(inp[250], 0); assert.equal(inp[0], 750);
});

for (const [len, seg] of [[3333, 1000], [1000, 1000], [3000, 1000], [250, 1000], [10007, 2048]]) {
  test(`stems: streaming overlap-add with an identity "model" sums back to the input (len ${len}, segment ${seg})`, async () => {
    const L = noise(len, len), R = noise(len, len + 1);
    const split = [0.1, 0.2, 0.3, 0.4];
    const got = [0, 1, 2, 3].map(() => [new Float32Array(len), new Float32Array(len)]);
    let expectFrame = 0, blocks = 0;
    await separateChunked({
      channels: [L, R], length: len, segment: seg, overlap: 0.25, sources: 4,
      runChunk: async (mix) => { const o = new Float32Array(4 * 2 * seg); for (let s = 0; s < 4; s++) for (let i = 0; i < 2 * seg; i++) o[s * 2 * seg + i] = mix[i] * split[s]; return o; },
      onBlock: ({ frame, frames, data }) => {
        assert.equal(frame, expectFrame, 'blocks arrive in order without gaps'); expectFrame += frames; blocks++;
        for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) got[s][c].set(data.subarray((s * 2 + c) * frames, (s * 2 + c + 1) * frames), frame);
      },
    });
    assert.equal(expectFrame, len, 'every frame delivered once');
    assert.equal(blocks, planChunks(len, seg).chunks.length);
    const sumL = new Float32Array(len), sumR = new Float32Array(len);
    for (let s = 0; s < 4; s++) for (let i = 0; i < len; i++) { sumL[i] += got[s][0][i]; sumR[i] += got[s][1][i]; }
    assert.ok(maxAbs(sumL, L) < 1e-5 && maxAbs(sumR, R) < 1e-5, 'stems sum to the input');
    assert.ok(maxAbs(got[3][0], L.map((v) => v * 0.4)) < 1e-5, 'each stem keeps its share');
  });
}

test('stems: cancellation stops between chunks', async () => {
  let n = 0;
  await assert.rejects(separateChunked({
    channels: [noise(5000), noise(5000)], length: 5000, segment: 1000, sources: 1,
    runChunk: async () => new Float32Array(2000), shouldStop: () => ++n > 2,
  }), { name: 'AbortError' });
});

test('stems: hybrid runner + stub model separates into bands that sum to the input', async () => {
  const seg = 16384, len = 40000;
  const session = createStubSession({ segment: seg });
  const runner = createRunner(session, StubTensor);
  assert.equal(runner.kind, 'hybrid'); assert.equal(runner.segment, seg);
  const L = new Float32Array(len), R = new Float32Array(len);
  for (let i = 0; i < len; i++) { const t = i / 44100; L[i] = 0.3 * Math.sin(2 * Math.PI * 100 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t); R[i] = 0.1 * Math.sin(2 * Math.PI * 6000 * t) + 0.2 * Math.sin(2 * Math.PI * 1000 * t); }
  const stems = DEMUCS_SOURCES.map(() => [new Float32Array(len), new Float32Array(len)]);
  await separateChunked({ channels: [L, R], length: len, segment: seg, sources: 4, runChunk: runner.runChunk,
    onBlock: ({ frame, frames, data }) => { for (let s = 0; s < 4; s++) for (let c = 0; c < 2; c++) stems[s][c].set(data.subarray((s * 2 + c) * frames, (s * 2 + c + 1) * frames), frame); } });
  const sum = new Float32Array(len);
  for (let s = 0; s < 4; s++) for (let i = 0; i < len; i++) sum[i] += stems[s][0][i];
  assert.ok(maxAbs(sum, L) < 1e-4, 'sum of stems = mix');
  const rms = (a, from = 5000, to = len - 5000) => { let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return Math.sqrt(e / (to - from)); };
  const bass = stems[DEMUCS_SOURCES.indexOf('bass')][0], voc = stems[DEMUCS_SOURCES.indexOf('vocals')][0], drums = stems[DEMUCS_SOURCES.indexOf('drums')][1];
  assert.ok(Math.abs(rms(bass) - 0.3 / Math.SQRT2) < 0.02, `100 Hz in bass (${rms(bass)})`);
  assert.ok(Math.abs(rms(voc) - 0.2 / Math.SQRT2) < 0.02, `1 kHz in vocals (${rms(voc)})`);
  assert.ok(Math.abs(rms(drums) - 0.1 / Math.SQRT2) < 0.02, `6 kHz in drums (${rms(drums)})`);
});

test('stems: waveform-model runner passes the graph output through', async () => {
  const seg = 100;
  const session = { inputNames: ['mix'], outputNames: ['stems'], inputMetadata: [{ name: 'mix', shape: [1, 2, seg] }],
    run: async (f) => ({ stems: new StubTensor('float32', new Float32Array(4 * 2 * seg).map((_, i) => f.mix.data[i % (2 * seg)] / 4), [1, 4, 2, seg]) }) };
  const r = createRunner(session, StubTensor);
  assert.equal(r.kind, 'waveform');
  const out = await r.runChunk(new Float32Array(2 * seg).fill(1));
  assert.equal(out.length, 800); assert.equal(out[799], 0.25);
});

test('stems: Int16 conversion rounds and clips', () => {
  assert.deepEqual([...floatToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))], [0, 32767, -32767, 32767, -32768, 16384]);
  const planar = Float32Array.from([0.5, 1, -0.5, -1]); // [C][n] = L:[0.5,1] R:[-0.5,-1]
  assert.deepEqual([...interleaveInt16(planar, 2, 2)], [16384, -16383, 32767, -32767]);
  assert.deepEqual(STEMS, ['vocals', 'drums', 'bass', 'other']);
});

// ---------------- worklet mixing (pure) ----------------
function hermite(buf, x) { // DeckProcessor.sample()
  const i = Math.floor(x), f = x - i, n = buf.length;
  if (i < 1 || i + 2 >= n) return (i >= 0 && i < n) ? buf[i] : 0;
  const y0 = buf[i - 1], y1 = buf[i], y2 = buf[i + 1], y3 = buf[i + 2];
  const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}
function deckFixture(n = 200) {
  const v = noise(n, 11).map((x) => x * 0.5), d = noise(n, 12).map((x) => x * 0.5), b = noise(n, 13).map((x) => x * 0.5), o = noise(n, 14).map((x) => x * 0.5);
  const q = (a) => floatToInt16(a);
  const [V, D, B] = [q(v), q(d), q(b)];
  const deq = (a) => Float32Array.from(a, (x) => x / 32767);
  // original = exact sum of the (quantised) stems + other
  const L = new Float32Array(n); for (let i = 0; i < n; i++) L[i] = deq(V)[i] + deq(D)[i] + deq(B)[i] + o[i];
  const R = L.map((x) => -x);
  const neg = (a) => Int16Array.from(a, (x) => Math.max(-32767, -x));
  return { L, R, stems: [{ L: V, R: neg(V) }, { L: D, R: neg(D) }, { L: B, R: neg(B) }], parts: [deq(V), deq(D), deq(B), o] };
}

test('stems: worklet mix with all stems on equals the original (Hermite-exact)', () => {
  const { L, R, stems } = deckFixture();
  const out = new Float32Array(2), coef = stemCoefficients([1, 1, 1, 1]);
  assert.deepEqual([...coef], [1, 0, 0, 0]);
  for (const x of [0, 0.5, 1.25, 77.3, 150.9, 197.5, 199, 199.5]) {
    readStemMix(L, R, stems, coef, x, L.length, out);
    assert.ok(Math.abs(out[0] - hermite(L, x)) < 1e-6 && Math.abs(out[1] - hermite(R, x)) < 1e-6, `x=${x}`);
  }
});

test('stems: worklet mix applies per-stem gains, other is the residual', () => {
  const { L, R, stems, parts } = deckFixture();
  const out = new Float32Array(2);
  for (const g of [[1, 0, 0, 0], [0, 1, 1, 1], [0, 0, 0, 1], [0.5, 1, 0, 0.25], [0, 0, 0, 0], [1, 1, 0, 1]]) {
    const coef = stemCoefficients(g);
    const ref = new Float32Array(L.length); for (let i = 0; i < L.length; i++) for (let s = 0; s < 4; s++) ref[i] += g[s] * parts[s][i];
    for (const x of [3, 3.5, 50.25, 120.75]) {
      readStemMix(L, R, stems, coef, x, L.length, out);
      assert.ok(Math.abs(out[0] - hermite(ref, x)) < 1e-5, `gains ${g} at ${x}: ${out[0]} vs ${hermite(ref, x)}`);
      assert.ok(Math.abs(out[1] + hermite(ref, x)) < 1e-4, `right channel, gains ${g}`);
    }
  }
});

test('stems: gain smoothing converges and snaps to exact targets', () => {
  const cur = Float32Array.from([1, 1, 1, 1]), target = Float32Array.from([0, 1, 0.5, 1]);
  const k = 1 - Math.exp(-1 / (0.005 * 48000));
  let n = 0; while (smoothGains(cur, target, k) && n < 1e5) n++;
  assert.deepEqual([...cur], [0, 1, 0.5, 1]);
  assert.ok(n > 100 && n < 48000 * 0.2, `ramp took ${n} samples`);
  assert.equal(smoothGains(cur, target, k), false);
  assert.ok(isUnity([1, 1, 1, 1]) && !isUnity(cur));
});

test('stems: effective gains combine mute, level and the channel VOC/INST knobs', () => {
  const g = effectiveGains({ levels: [1, 0.5, 1, 1], mute: [false, false, true, false] }, 0.5, 0.8);
  assert.deepEqual([...g].map((x) => +x.toFixed(4)), [0.5, 0.4, 0, 0.8]);
  // a 7-minute track at 48 kHz: original (Float32 stereo) + 3 Int16 stereo stems stays well under 600 MB
  const mb = deckStemBytes(7 * 60 * 48000) / 2 ** 20;
  assert.ok(mb < 400, `${mb.toFixed(0)} MB`);
});
