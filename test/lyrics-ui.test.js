// Renderer-side lyrics pieces that run without a DOM: editor model, karaoke drawing + video mixer hook, karaoke mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, lyricStateAt } from '../public/js/lyrics/lrc.js';
import { linesFromLyrics, tapLine, linesToLyrics } from '../public/js/lyrics/editor.js';
import { drawKaraoke, installKaraokeOverlay } from '../public/js/lyrics/karaoke-overlay.js';
import { LyricsManager, lyricsMidiTargets, outputLagSec } from '../public/js/lyrics/lyrics.js';

/** Minimal 2D context that records text draws and clip widths. */
function fakeCtx() {
  const ops = [];
  const g = {
    ops, font: '', fillStyle: '', textAlign: '', textBaseline: '', shadowColor: '', shadowBlur: 0,
    save() { ops.push(['save']); }, restore() { ops.push(['restore']); },
    measureText: (s) => ({ width: String(s).length * 10 }),
    fillText(s, x, y) { ops.push(['text', s, this.fillStyle, x, y]); },
    fillRect() {}, beginPath() {}, arc() {}, fill() { ops.push(['dot']); },
    rect(x, y, w) { ops.push(['clip', w]); }, clip() {}, clearRect() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  return g;
}

test('editor model: tap-to-sync sets times, shifts word stamps, plain lines become synced', () => {
  let lines = linesFromLyrics({ synced: [], plain: 'one\ntwo\nthree' });
  assert.deepEqual(lines.map((l) => l.t), [null, null, null]);
  lines = tapLine(lines, 0, 10.0004); lines = tapLine(lines, 1, 12.5);
  assert.deepEqual(lines.map((l) => l.t), [10, 12.5, null]);
  let out = linesToLyrics(lines);
  assert.deepEqual(out.synced.map((l) => [l.t, l.text]), [[10, 'one'], [12.5, 'two']]);
  assert.equal(out.plain, 'one\ntwo\nthree');
  // re-tapping a line with word timing moves its words along
  const w = linesFromLyrics(parseLrc('[00:05.00]<00:05.00>a <00:05.50>b'));
  const moved = tapLine(w, 0, 6);
  assert.deepEqual(moved[0].words.map((x) => x.t), [6, 6.5]);
  out = linesToLyrics([]);
  assert.deepEqual(out, { synced: [], plain: '' });
});

test('karaoke drawing: current line white with a sung clip in the deck colour, next line dimmed', () => {
  const lyr = parseLrc('[00:10.00]Hello world\n[00:14.00]Next one');
  const g = fakeCtx();
  assert.equal(drawKaraoke(g, 1280, 720, { state: lyricStateAt(lyr, 12), color: '#ff8a3d' }), true);
  const texts = g.ops.filter((o) => o[0] === 'text');
  assert.deepEqual(texts.map((t) => [t[1], t[2]]), [['Hello world', '#ffffff'], ['Hello world', '#ff8a3d'], ['Next one', 'rgba(255,255,255,.62)']]);
  const clip = g.ops.find((o) => o[0] === 'clip');
  assert.ok(clip[1] > 0.4 * 110 && clip[1] < 0.6 * 110 + 8, `wipe width ${clip[1]}`); // halfway through the line
  // word timing: clip ends after the sung words
  const lw = parseLrc('[00:10.00]<00:10.00>aa <00:11.00>bb <00:12.00>cc<00:13.00>');
  const g2 = fakeCtx();
  drawKaraoke(g2, 1280, 720, { state: lyricStateAt(lw, 11.5) });
  const c2 = g2.ops.find((o) => o[0] === 'clip')[1];
  assert.ok(c2 > 30 && c2 < 60, `word clip ${c2}`); // "aa " (30) + half of "bb " (15) plus 4 px margin
  assert.equal(drawKaraoke(fakeCtx(), 1280, 720, { state: null }), false);
});

test('karaoke overlay hooks VideoMixer.paintOverlay without changing mixer.js', () => {
  const calls = [];
  const og = fakeCtx();
  const mixer = {
    overlay: { width: 1280, height: 720 }, og, overlayDirty: false, _overlayChanged: false,
    paintOverlay(now) { calls.push(['orig', now, this.overlayDirty]); const was = this.overlayDirty; this.overlayDirty = false; if (was) this._overlayChanged = true; return false; },
  };
  let frame = null;
  const k = installKaraokeOverlay(mixer, () => frame);
  assert.equal(mixer.paintOverlay(1), false, 'nothing to show');
  frame = { state: lyricStateAt(parseLrc('[00:00.00]la'), 0.5) };
  assert.equal(mixer.paintOverlay(2), true, 'karaoke makes the overlay visible');
  assert.equal(calls.at(-1)[2], true, 'overlay forced dirty so the base layer is redrawn under the lyrics');
  assert.equal(mixer._overlayChanged, true);
  assert.ok(og.ops.some((o) => o[0] === 'text' && o[1] === 'la'));
  frame = null;
  mixer.paintOverlay(3);
  assert.equal(calls.at(-1)[2], true, 'one more redraw clears the lyrics');
  assert.equal(installKaraokeOverlay(mixer, () => null), k, 'idempotent');
  k.uninstall();
  assert.equal(mixer._karaoke, undefined);
});

function fakeApp() {
  const chState = () => ({ vocal: 0.8, volume: 1 });
  const channels = [0, 1].map(() => { const c = { state: chState(), sets: [], set(k, v) { this.state[k] = v; this.sets.push([k, v]); } }; return c; });
  const decks = [0, 1].map((index) => ({ index, track: { id: `t${index}` }, position: 12, rate: 1, playing: true, on() {} }));
  return { engine: { decks, channels, ctx: { currentTime: 0, outputLatency: 0, baseLatency: 0 }, master: decks[0] }, deckCount: 2 };
}

test('karaoke mode: quick-stems VOC knob down and restored; AI vocal stem muted when stems are loaded', () => {
  globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
  const app = fakeApp();
  const m = new LyricsManager(app);
  m.renderRow = () => {}; m.load = async () => null;
  m.setKaraoke(0, true);
  assert.deepEqual(app.engine.channels[0].sets, [['vocal', 0]]);
  assert.ok(m.karaoke.has(0));
  m.setKaraoke(0, false);
  assert.deepEqual(app.engine.channels[0].sets.at(-1), ['vocal', 0.8], 'restores the previous VOC level');
  // deck with AI stems (feature-detected)
  const d1 = app.engine.decks[1];
  const mutes = [];
  Object.assign(d1, { stemsReady: true, stemMute: [false, false, false, false], setStemMute: (i, on) => { d1.stemMute[i] = on; mutes.push([i, on]); } });
  m.toggleKaraoke(1);
  assert.deepEqual(mutes, [[0, true]]);
  m.toggleKaraoke(1);
  assert.deepEqual(mutes.at(-1), [0, false]);
});

test('video karaoke frame comes from the karaoke deck and follows the heard position', () => {
  const app = fakeApp();
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '#123456' });
  globalThis.document ??= { documentElement: {} };
  const m = new LyricsManager(app);
  m.cache.set('t1', parseLrc('[00:10.00]first\n[00:12.00]second\n[00:20.00]third'));
  assert.equal(m.videoFrame(), null, 'no karaoke deck, video "auto" → nothing');
  m.karaoke.add(1);
  const f = m.videoFrame();
  assert.equal(f.state.line.text, 'second'); assert.equal(f.state.next.text, 'third');
  app.engine.ctx.outputLatency = 0.5; app.engine.decks[1].rate = 2; // 1 s of track time still in the pipeline
  assert.equal(m.videoFrame().state.line.text, 'first');
  assert.equal(outputLagSec({ currentTime: 1, outputLatency: 0.1, baseLatency: 0 }), 0.1);
});

test('lyrics MIDI targets', () => {
  const calls = [];
  const app = { lyrics: { karaoke: new Set([1]), prefs: { video: 'auto' }, toggleKaraoke: (d) => calls.push(['k', d]), openEditor: (d) => calls.push(['e', d]), savePrefs() {} } };
  const t = Object.fromEntries(lyricsMidiTargets(app).map((x) => [x.id, x]));
  t['deck1.karaoke'].handler(true); t['deck3.lyricsEditor'].handler(true); t['deck1.karaoke'].handler(false);
  assert.deepEqual(calls, [['k', 0], ['e', 2]]);
  assert.equal(t['deck2.karaoke'].led(), true);
  t['lyrics.video'].handler(true); assert.equal(app.lyrics.prefs.video, 'on');
});
