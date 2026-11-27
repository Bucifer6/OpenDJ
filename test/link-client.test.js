// Renderer-side Link helpers (public/js/link/link-core.js): clock mapping, tempo ratio, phase locking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateOffset, tempoRatio, beatScale, phaseError, heardPosition, deckBeats, linkBeatAt, followPlan, audioLagSec } from '../public/js/link/link-core.js';
import { LinkClient, linkMidiTargets } from '../public/js/link/link.js';

const near = (a, b, eps = 1e-9, m = '') => assert.ok(Math.abs(a - b) <= eps, `${m} ${a} ≈ ${b}`);

test('clock offset: the sample with the smallest round trip wins', () => {
  const off = 5_000_000;
  const best = estimateOffset([
    { t0: 0, t1: 9000, server: 4000 + off + 1500 },  // slow, asymmetric
    { t0: 20000, t1: 20400, server: 20200 + off },   // fast, symmetric
    { t0: 30000, t1: 29000, server: 0 },             // clock went backwards: ignored
  ]);
  near(best.offset, off); assert.equal(best.rtt, 400);
});

test('tempo ratio allows half / double time; beat scale tells how deck beats map to Link beats', () => {
  near(tempoRatio(128, 126), 128 / 126);
  near(tempoRatio(174, 87.5), 174 / 87.5 / 2); // deck stays near its tempo, plays in half time
  near(tempoRatio(85, 170), 85 / 170 * 2);
  assert.equal(beatScale(174, 87.5), 2); assert.equal(beatScale(85, 170), 0.5); assert.equal(beatScale(128, 126), 1);
  assert.equal(tempoRatio(0, 120), 1);
});

test('phase error wraps into [−q/2, q/2)', () => {
  near(phaseError(4.1, 3.9), 0.2); near(phaseError(0.1, 3.9), 0.2); near(phaseError(3.9, 0.1), -0.2);
  near(phaseError(10.5, 8.5, 1), 0); near(phaseError(2, 0, 4), -2);
});

test('heard position, deck beats from downbeat, Link beat extrapolation', () => {
  near(heardPosition(10, 1.1, 0.05), 10 - 0.055); assert.equal(heardPosition(10, 1.1, 0.05, false), 10);
  near(deckBeats({ bpm: 120, gridOffset: 0.1, track: { downbeat: 2.1 } }, 4.1), 4); // bar phase from the downbeat
  near(deckBeats({ bpm: 120, gridOffset: 0.1, track: {} }, 1.1), 2);
  near(linkBeatAt({ beat: 10, host: 1_000_000, bpm: 120 }, 1_500_000, 0), 11);
  near(linkBeatAt({ beat: 10, host: 1_000_000, bpm: 120 }, 500_000, 1_500_000), 12);
});

test('follow plan: tempo to Link, hard seek for large errors, gentle bend for small ones', () => {
  // deck at 125 BPM (0 %), Link at 128: tempo +2.4 %
  let p = followPlan({ linkBpm: 128, linkBeat: 8, deckBpm: 125, deckTempo: 0, deckPos: 30, deckBeat: 8, playing: true });
  near(p.tempo, (128 / 125 - 1) * 100, 1e-9); assert.equal(p.seek, null); assert.equal(p.bend, 0);
  // deck half a beat late → seek forward by half a beat of track time
  p = followPlan({ linkBpm: 120, linkBeat: 8.5, deckBpm: 120, deckTempo: 0, deckPos: 30, deckBeat: 8, playing: true });
  assert.equal(p.tempo, null); near(p.seek, 30.25, 1e-9);
  // 2 % of a beat early → small negative bend, no seek
  p = followPlan({ linkBpm: 120, linkBeat: 8, deckBpm: 120, deckTempo: 0, deckPos: 30, deckBeat: 8.02, playing: true });
  assert.equal(p.seek, null); assert.ok(p.bend < 0 && p.bend > -0.03, `bend ${p.bend}`);
  // paused: tempo only
  p = followPlan({ linkBpm: 120, linkBeat: 8.5, deckBpm: 120, deckTempo: 3, deckPos: 30, deckBeat: 8, playing: false });
  near(p.tempo, 0); assert.equal(p.seek, null);
  // half time deck: deck beat 4 = Link beat 8 → in phase
  p = followPlan({ linkBpm: 174, linkBeat: 8, deckBpm: 87, deckTempo: 0, deckPos: 30, deckBeat: 4, playing: true });
  assert.equal(p.seek, null); assert.equal(p.bend, 0);
  // bar phase: one beat off in a 4-beat bar is corrected (a beat-only sync would miss it)
  p = followPlan({ linkBpm: 120, linkBeat: 9, deckBpm: 120, deckTempo: 0, deckPos: 30, deckBeat: 8, playing: true, quantum: 4 });
  near(p.seek, 30.5, 1e-9);
});

test('simulated follow loop converges a drifting deck onto Link phase', () => {
  // deck at 124 BPM, Link at 126, deck starts 0.3 beat late; run the 20 Hz plan for 4 s of virtual time
  const deck = { bpm: 124, tempo: 0, bend: 0, pos: 10 - 0.3 * 60 / 124, gridOffset: 0, track: {} };
  let link = 10 * 124 / 60, seeks = 0;
  for (let i = 0; i < 80; i++) {
    const dt = 0.05;
    const p = followPlan({ linkBpm: 126, linkBeat: link, deckBpm: deck.bpm, deckTempo: deck.tempo, deckPos: deck.pos, deckBeat: deckBeats(deck, deck.pos), playing: true });
    if (p.tempo != null) deck.tempo = p.tempo;
    if (p.seek != null) { deck.pos = p.seek; seeks++; }
    deck.bend = p.bend;
    deck.pos += dt * (1 + deck.tempo / 100) * (1 + deck.bend);
    link += dt * 126 / 60;
  }
  assert.equal(seeks, 1, 'one hard seek, then only bends');
  const err = phaseError(link, deckBeats(deck, deck.pos));
  assert.ok(Math.abs(err) < 0.01, `phase error ${err}`);
  near(deck.bpm * (1 + deck.tempo / 100), 126, 1e-9);
});

test('audio lag: output timestamp first, latency properties as fallback', () => {
  const ctx = { currentTime: 10, getOutputTimestamp: () => ({ contextTime: 9.95, performanceTime: 1000 }), outputLatency: 0.2, baseLatency: 0.01 };
  near(audioLagSec(ctx, 1010), 10 - (9.95 + 0.01));
  near(audioLagSec({ currentTime: 1, outputLatency: 0.02, baseLatency: 0.005 }), 0.025);
  assert.equal(audioLagSec(null), 0);
});

test('Link MIDI targets call the client', () => {
  const calls = [];
  const app = { link: { state: { enabled: false }, prefs: { follow: true, lead: false }, toggle: () => calls.push('toggle'), setFollow: (v) => calls.push(['follow', v]), setLead: (v) => calls.push(['lead', v]), pushPhase: () => calls.push('push') } };
  const t = Object.fromEntries(linkMidiTargets(app).map((x) => [x.id, x]));
  t['link.toggle'].handler(true); t['link.toggle'].handler(false); t['link.follow'].handler(true); t['link.lead'].handler(true); t['link.pushPhase'].handler(true);
  assert.deepEqual(calls, ['toggle', ['follow', false], ['lead', true], 'push']);
  assert.equal(t['link.follow'].led(), true);
});

test('LinkClient does not run background polling timers while Link is disabled', () => {
  const client = new LinkClient({ engine: { decks: [], on() {} } });
  client._syncTimers();
  assert.equal(client._clockT || null, null, 'no 10 s clock-sync timer while disabled');
  assert.equal(client._loopT || null, null, 'no 20 Hz follow timer while disabled');
  assert.equal(client._beatT || null, null, 'no 20 Hz beat timer while disabled');
  client.dispose();
});
