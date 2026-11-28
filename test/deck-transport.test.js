import test from 'node:test';
import assert from 'node:assert/strict';
import { Deck } from '../public/js/audio/deck.js';
import { Engine } from '../public/js/audio/engine.js';
import { api } from '../public/js/api.js';
import { encodeWaveform } from '../public/js/audio/analysis-core.js';

test('a cached track can play while heavy analysis is pending, and a late response cannot update an ejected track', { timeout: 2000 }, async (t) => {
  const samples = new Float32Array(64);
  const band = new Uint8Array([10]);
  t.mock.method(api, 'waveform', async () => encodeWaveform({ rate: 1, peak: band, low: band, mid: band, high: band }).buffer);
  let finishAnalysis;
  t.mock.method(api, 'trackAnalysis', () => new Promise((resolve) => { finishAnalysis = resolve; }));
  const posted = [];
  const deck = Object.assign(Object.create(Deck.prototype), {
    index: 0,
    engine: { settings: {}, channels: [{ setAutoGain() {} }], prefetched: new Map([['cached', new ArrayBuffer(1)]]) },
    ctx: {
      sampleRate: 48000, currentTime: 0,
      async decodeAudioData() {
        return { sampleRate: 48000, duration: 1, numberOfChannels: 1, getChannelData: () => samples };
      },
    },
    node: { port: { postMessage: (message) => posted.push(message) } },
    _loadSeq: 0, tempo: 0, bend: 0, stemMacro: [1, 1],
    emit() {},
  });
  const track = { id: 'cached', analyzed: true, bpm: 120, phrases: [] };
  assert.equal(await deck.load(track), true);
  assert.equal(deck.loading, false);
  assert.equal(deck.bpm, 120);
  assert.ok(deck.waveform && posted.some((message) => message.type === 'load'));
  deck.eject();
  finishAnalysis({ tempoMap: [{ time: 0, bpm: 120, beat: 0 }] });
  await Promise.resolve();
  assert.equal(track.tempoMap, undefined);
  assert.equal(deck.track, null);
});

test('the master remains a ready deck while the other deck loads or is ejected', () => {
  const engine = Object.assign(Object.create(Engine.prototype), {
    master: null, settings: {}, emit() {},
    channels: [{ state: { volume: 0.8 } }, { state: { volume: 0.8 } }],
  });
  const deck = (index, playing) => Object.assign(Object.create(Deck.prototype), {
    engine, index, playing, track: {}, bpm: 120, ctx: { sampleRate: 48000 },
    isMaster: false, _loadSeq: 0, emit() {}, post() {},
  });
  const first = deck(0, true), second = deck(1, false);
  engine.decks = [first, second];
  first.setMaster();
  second.loading = true;
  second.setMaster();
  assert.equal(engine.master, first);
  assert.equal(second.isMaster, false);
  second.loading = false;
  second.setMaster();
  assert.equal(engine.master, second);
  second.eject();
  assert.equal(engine.master, first);
  assert.equal(first.isMaster, true);
  assert.equal(second.isMaster, false);
});

test('a queued position report with the same timestamp cannot undo a newer seek', () => {
  const d = Object.assign(Object.create(Deck.prototype), { sr: 48000, ctx: { currentTime: 10 }, _pos: 6.6, _seekGuard: 10, _seekSeq: 4, playing: false, emit() {} });
  const report = { type: 'pos', frame: 5 * 48000, shadow: 5 * 48000, time: 10, rate: 0, playing: false, seekSeq: 3 };
  d.onWorklet(report); assert.equal(d._pos, 6.6);
  d.onWorklet({ ...report, frame: 6.6 * 48000, seekSeq: 4 }); assert.equal(d._pos, 6.6);
  d.onWorklet({ ...report, frame: 8 * 48000, seekSeq: 4 }); assert.equal(d._pos, 8);
});

test('a position report from the end of a worklet block reads exactly at any audio time, also before it arrived', () => {
  // the report says: frame F was reached at audio time 10.008 s (end of the block); the main thread's clock still
  // reads 10 s. Two decks reporting at different block ends must still agree on where they are now.
  const deck = (time, frame) => {
    const d = Object.assign(Object.create(Deck.prototype), { sr: 48000, ctx: { currentTime: 10 }, track: {}, duration: 300, _seekGuard: 0, _seekSeq: 0, playing: true, emit() {} });
    d.onWorklet({ type: 'pos', frame, shadow: frame, time, rate: 1, playing: true });
    return d;
  };
  const at = 10, posAt10 = 50; // both decks are at 50 s at audio time 10 s
  const a = deck(at + 0.008, (posAt10 + 0.008) * 48000), b = deck(at + 128 * 3 / 48000, (posAt10 + 128 * 3 / 48000) * 48000);
  assert.ok(Math.abs(a.positionAt(at) - posAt10) < 1e-9, `deck a: ${a.positionAt(at)}`);
  assert.ok(Math.abs(b.positionAt(at) - posAt10) < 1e-9, `deck b: ${b.positionAt(at)}`);
  assert.ok(Math.abs(a.positionAt(at) - b.positionAt(at)) < 1e-9, 'the two agree: no phantom phase offset of whole blocks');
});

test('tempo RESET: a playing deck glides back to 0 % (Settings → Decks), a second press or a stopped deck resets at once', () => {
  const posted = [];
  const mk = (extra = {}) => Object.assign(Object.create(Deck.prototype), { sr: 48000, ctx: { currentTime: 10 }, track: {}, bpm: 128, tempo: 6, tempoRange: 8, bend: 0, rateMul: 1, playing: true, syncOn: false,
    engine: { settings: { deckOptions: {} }, onTempoChange() {} }, post: (type, m) => posted.push({ type, ...m }), emit() {} }, extra);
  const d = mk();
  d.resetTempoGlide();
  const ramp = posted.find((m) => m.type === 'rateRamp');
  assert.ok(d.gliding && ramp && Math.abs(ramp.to - 1) < 1e-9, 'a glide to 0 % was started on the audio thread');
  assert.ok(Math.abs(ramp.dur - (2 * 16 * (60 / 128)) / (1.06 + 1)) < 1e-9, `over 16 beats by default (${ramp.dur.toFixed(2)} s)`);
  assert.equal(d.tempo, 6, 'the fader moves with the glide, not at once');
  d.resetTempoGlide();
  assert.equal(d.tempo, 0, 'pressed again during the glide: 0 % at once'); assert.equal(d.gliding, false);
  const stopped = mk({ playing: false }); stopped.resetTempoGlide();
  assert.equal(stopped.tempo, 0, 'a stopped deck resets at once');
  posted.length = 0;
  const instant = mk({ engine: { settings: { deckOptions: { tempoResetBeats: 0 } }, onTempoChange() {} } }); instant.resetTempoGlide();
  assert.equal(instant.tempo, 0, '"Jump to 0 % at once" setting'); assert.ok(!posted.some((m) => m.type === 'rateRamp'));
  const eight = mk({ engine: { settings: { deckOptions: { tempoResetBeats: 8 } }, onTempoChange() {} } }); eight.resetTempoGlide();
  assert.ok(Math.abs(posted.find((m) => m.type === 'rateRamp').dur - (2 * 8 * (60 / 128)) / 2.06) < 1e-9, '8 beats when set');
});

test('half/double-time alignPhase and sync play keep 88↔176 BPM decks locked with zero IPC drift', () => {
  const posted = [];
  const mkDeck = (extra = {}) => Object.assign(Object.create(Deck.prototype), {
    sr: 48000, ctx: { currentTime: 10 }, track: { id: 't' }, duration: 300,
    bpm: 176, gridOffset: 0, tempo: 0, tempoRange: 8, bend: 0, rateMul: 1, reverse: false,
    playing: false, syncOn: true, isMaster: false, _pos: 0, _t: 10, _rate: 0, _seekGuard: 0, _seekSeq: 0,
    vinyl: { start: 0, stop: 0, quartz: false },
    post: (type, m) => posted.push({ type, ...m }), emit() {},
  }, extra);

  const mBeat = 60 / 88;
  const master = mkDeck({ bpm: 88, playing: true, isMaster: true, _pos: 10 * mBeat + 0.25 * mBeat, _rate: 1 });
  const eng = { settings: { syncMode: 'beat' }, masterDeck: () => master, onTempoChange() {}, onDeckPlay() {} };
  master.engine = eng;
  const slave = mkDeck({ bpm: 176, engine: eng, _pos: 20 * (60 / 176) + 0.5 * (60 / 176) });

  // Already in phase (master 0.25 == slave 0.50 at 2x): alignPhase must NOT jump slave by 85 ms!
  const beforePos = slave._pos;
  slave.alignPhase(10);
  assert.ok(Math.abs(slave._pos - beforePos) < 1e-9, `expected no shift, moved by ${(slave._pos - beforePos) * 1000} ms`);

  // Lagged by 20 ms: alignPhase shifts forward by 20 ms and forwards refT to worklet seek
  posted.length = 0;
  slave._pos = beforePos - 0.02;
  slave.play();
  const seekMsg = posted.find((m) => m.type === 'seek');
  const playMsg = posted.find((m) => m.type === 'play');
  assert.ok(seekMsg && playMsg, 'posted seek and play');
  assert.equal(seekMsg.at, playMsg.at, 'seek and play share the same audio timestamp');
  assert.ok(Math.abs(slave._pos - beforePos) < 1e-6, `aligned to exact beat (${slave._pos} vs ${beforePos})`);
});

test('syncTargetRatio honors elastic tempoMap local BPM', () => {
  const mk = (extra) => Object.assign(Object.create(Deck.prototype), {
    sr: 48000, ctx: { currentTime: 10 }, track: {}, duration: 300,
    bpm: 120, gridOffset: 0, tempo: 0, bend: 0, rateMul: 1, playing: false, _pos: 20, _t: 10, _rate: 0,
  }, extra);
  const master = mk({ bpm: 126, tempo: 0 });
  const slave = mk({ bpm: 120, track: { tempoMap: [{ time: 0, bpm: 120, beat: 0 }, { time: 15, bpm: 126, beat: 30 }] } });
  // At pos=20 s, slave's local BPM is already 126 -> ratio should be 1.0 (0% tempo), not 126/120 (+5%)
  assert.ok(Math.abs(slave.syncTargetRatio(master) - 1) < 1e-9);
});

test('Engine.tick continuous manual sync keeper pulls lagged synced deck back into phase (including 88↔176)', () => {
  let now = 10;
  const mkDeck = (extra) => Object.assign(Object.create(Deck.prototype), {
    sr: 48000, ctx: { get currentTime() { return now; } }, track: { id: 'x' }, duration: 300,
    bpm: 176, gridOffset: 0, tempo: 0, tempoRange: 8, bend: 0, rateMul: 1, reverse: false,
    playing: true, syncOn: true, isMaster: false, loading: false, scratching: false, _pos: 0, _t: 10, _rate: 1,
    post() {}, emit() {},
  }, extra);
  const m = mkDeck({ index: 0, bpm: 88, isMaster: true, syncOn: false, _pos: 10 * (60 / 88) });
  const s = mkDeck({ index: 1, bpm: 176, _pos: 20 * (60 / 176) - 0.015 }); // 15 ms behind
  const ch = () => ({ setBeatSec() {}, setClock() {}, state: { volume: 0.8 } });
  const eng = Object.assign(Object.create(Engine.prototype), {
    ctx: { get currentTime() { return now; } },
    settings: { syncMode: 'beat' },
    decks: [m, s, null, null],
    channels: [ch(), ch(), ch(), ch()],
    fxBuses: [],
    master: m,
    emit() {},
  });
  m.engine = eng; s.engine = eng;

  eng.tick();
  assert.ok(s.bend > 0 && s._syncBend, `expected positive sync bend, got ${s.bend}`);

  // Once aligned inside 3 ms, sync bend clears
  now += 0.3;
  m._t = now; s._t = now;
  s._pos = 20 * (60 / 176);
  eng.tick();
  assert.equal(s.bend, 0);
  assert.equal(s._syncBend, false);

  // Automix driving suppresses manual sync keeper
  now += 0.3;
  m._t = now; s._t = now;
  s._pos = 20 * (60 / 176) - 0.02;
  eng.automixDriving = true;
  eng.tick();
  assert.equal(s.bend, 0, 'yields when Automix drives phase');
});
