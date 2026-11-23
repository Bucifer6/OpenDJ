import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onsetCurve, audibleOffset, MIN_CONFIDENCE } from '../public/js/audio/beat-phase.js';

const SR = 44100;
/** A 4-on-the-floor kick track at `bpm` whose first kick is at `first` seconds, with hats and a pad on top. */
function kicks(seconds, bpm, first = 0, { pad = true } = {}) {
  const x = new Float32Array(Math.round(seconds * SR)), beat = 60 / bpm;
  let seed = 7;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    const k = t - first < 0 ? -1 : (t - first) % beat;
    let v = k >= 0 && k < 0.15 ? Math.sin(2 * Math.PI * (50 + 80 * Math.exp(-k * 40)) * k) * Math.exp(-k * 18) * 0.8 : 0;
    const h = (t - first + beat / 2) % beat;
    if (h >= 0 && h < 0.02) { seed = (seed * 1103515245 + 12345) >>> 0; v += (seed / 2 ** 31 - 1) * 0.1; }
    if (pad) v += 0.1 * Math.sin(2 * Math.PI * 220 * t) + 0.05 * Math.sin(2 * Math.PI * 330 * t);
    x[i] = v;
  }
  return x;
}
const sync = async (fn) => fn; // build without yielding in tests

test('beat phase: measures the audible offset between two decks to under a millisecond, both directions', async () => {
  const opts = { yieldFn: () => null };
  const a = await onsetCurve(kicks(20, 124, 0.1), null, SR, opts);
  for (const shiftMs of [-25, -8, -2, 0, 3, 12, 30]) {
    // the incoming track's kicks are on its own grid at 0.3 s; it plays from a position chosen so its kicks land
    // shiftMs after the outgoing ones (positive: incoming behind)
    const b = await onsetCurve(kicks(20, 124, 0.3), null, SR, opts);
    const outPos = 10.0, beat = 60 / 124;
    const phaseOut = ((outPos - 0.1) % beat) / beat;
    const inPos = 0.3 + 8 * beat + phaseOut * beat - shiftMs / 1000;
    const r = audibleOffset({ curve: a, pos: outPos, rate: 1 }, { curve: b, pos: inPos, rate: 1 });
    assert.ok(r && r.confidence > MIN_CONFIDENCE, JSON.stringify(r));
    assert.ok(Math.abs(r.offset * 1000 - shiftMs) < 1, `${shiftMs} ms measured as ${(r.offset * 1000).toFixed(2)} ms`);
  }
});

test('beat phase: works with the incoming deck tempo-matched (different BPM, different rate)', async () => {
  const opts = { yieldFn: () => null };
  const a = await onsetCurve(kicks(20, 128, 0), null, SR, opts);
  const b = await onsetCurve(kicks(24, 120, 0), null, SR, opts); // played at 128/120 to match
  const rate = 128 / 120, outPos = 9.0, beatOut = 60 / 128, beatIn = 60 / 120;
  const phase = (outPos % beatOut) / beatOut;
  const shift = 0.006; // 6 ms behind
  const inPos = 10 * beatIn + phase * beatIn - shift * rate;
  const r = audibleOffset({ curve: a, pos: outPos, rate: 1 }, { curve: b, pos: inPos, rate });
  assert.ok(r && Math.abs(r.offset - shift) < 0.001, JSON.stringify(r));
});

test('beat phase: no kicks (a pad only) or no data: not trusted', async () => {
  const opts = { yieldFn: () => null };
  const pad = await onsetCurve(kicks(10, 124, 0, { pad: true }).map((v, i) => 0.1 * Math.sin(2 * Math.PI * 220 * i / SR)), null, SR, opts);
  const r = audibleOffset({ curve: pad, pos: 5, rate: 1 }, { curve: pad, pos: 5.01, rate: 1 });
  assert.ok(!r || r.confidence < MIN_CONFIDENCE, JSON.stringify(r));
  assert.equal(audibleOffset({ curve: null, pos: 5, rate: 1 }, { curve: pad, pos: 5, rate: 1 }), null);
  assert.equal(audibleOffset({ curve: pad, pos: 0.5, rate: 1 }, { curve: pad, pos: 5, rate: 1 }), null, 'not enough played yet');
});

test('beat phase: the onset curve is built in slices', async () => {
  let yields = 0;
  const c = await onsetCurve(new Float32Array(SR * 4), null, SR, { slice: 500, yieldFn: async () => { yields++; } });
  assert.equal(c.env.length, Math.floor(SR * 4 / 64));
  assert.ok(yields >= 5);
  void sync;
});
