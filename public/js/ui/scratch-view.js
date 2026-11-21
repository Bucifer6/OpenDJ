// Scratch view (T8): one deck full screen for phones and tablets: a big platter (multitouch: scratch with one finger,
// hold the record with a second), a vertical crossfader strip on the thumb side, a CUT button (a momentary transformer
// gate through the crossfader), the scratch-sample pads (T9), play / cue and the touch-to-sound latency.
// Opens from the deck header's SCRATCH button, or a double-tap on a deck header on touch screens.
import { el } from '../util.js';
import { jogWheel, button } from './controls.js';
import { icon } from './icons.js';
import { haptics } from './haptics.js';
import { deckOptions } from '../audio/vinyl.js';
import { DECK_COLORS } from './deck-ui.js';

let open = null;
export const scratchViewOpen = () => open;

/** Crossfader position that opens (v = 1) or closes (v = 0) this deck's channel; THRU channels use the channel fader. */
function stripApi(app, deck) {
  const eng = app.engine, ch = eng.channels[deck.index];
  const side = () => ch.state.xfAssign;
  return {
    get: () => (side() === 'A' ? (1 - (eng.crossfader || 0)) / 2 : side() === 'B' ? ((eng.crossfader || 0) + 1) / 2 : ch.state.volume),
    set: (v) => {
      v = Math.max(0, Math.min(1, v));
      if (side() === 'A') eng.setCrossfader(1 - 2 * v); else if (side() === 'B') eng.setCrossfader(2 * v - 1); else ch.set('volume', v);
    },
  };
}

export function openScratchView(app, deck) {
  if (open) open.close();
  const eng = app.engine, opt = deckOptions(app.settings);
  const strip = stripApi(app, deck);
  const jog = jogWheel(deck, { skin: () => (deckOptions(app.settings).platterSkin === 'minimal' ? 'vinyl' : deckOptions(app.settings).platterSkin), haptics });
  jog.classList.add('sv-jog');
  jog.style.setProperty('--deck-color', DECK_COLORS[deck.index]);

  // crossfader strip: vertical, top = this deck fully open
  const thumb = el('div', { class: 'sv-strip-thumb' });
  const track = el('div', { class: 'sv-strip', role: 'slider', 'aria-label': 'Crossfader (this deck open at the top)', 'aria-orientation': 'vertical', tabindex: 0 }, el('div', { class: 'sv-strip-slot' }), thumb);
  let dragId = null, lastEdge = null, rect = null;
  const render = () => { const v = strip.get(); track.style.setProperty('--v', v.toFixed(4)); track.setAttribute('aria-valuenow', v.toFixed(2)); };
  const setFrom = (e) => {
    const r = rect || track.getBoundingClientRect();
    const v = 1 - (e.clientY - r.top) / r.height;
    strip.set(v);
    const edge = v <= 0.02 ? 'closed' : v >= 0.98 ? 'open' : null;
    if (edge && edge !== lastEdge) haptics.impact('light', 'full'); // cut edge
    lastEdge = edge; render();
  };
  track.addEventListener('pointerdown', (e) => { dragId = e.pointerId; track.setPointerCapture(e.pointerId); rect = track.getBoundingClientRect(); setFrom(e); e.preventDefault(); });
  track.addEventListener('pointermove', (e) => { if (e.pointerId === dragId) setFrom(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) track.addEventListener(ev, (e) => { if (e.pointerId === dragId) { dragId = null; rect = null; } });
  track.addEventListener('keydown', (e) => { const d = { ArrowUp: 0.05, ArrowDown: -0.05 }[e.key]; if (d) { strip.set(strip.get() + d); render(); e.preventDefault(); } });

  // CUT: hold to close the channel (transformer), release to open it again
  let saved = null;
  const cut = button('CUT', {
    cls: 'sv-cut', title: 'Hold to cut this deck out (transformer); tap rhythmically for transforms',
    down: () => { saved ??= strip.get(); strip.set(0); render(); haptics.impact('light', 'full'); },
    up: () => { if (saved != null) { strip.set(saved > 0.05 ? saved : 1); saved = null; render(); } },
  });

  // scratch samples
  const bank = app.scratchSamples;
  const pads = bank ? bank.slots.map((s, n) => {
    const b = el('button', { class: 'pad sv-pad', 'data-slot': n }, el('span', { class: 'pad-label' }, s.name));
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); eng.resume(); if (deck.track || deck.scratchSample) bank.toggle(deck, n); renderPads(); });
    return b;
  }) : [];
  const ret = button('TRACK', { cls: 'sm sv-return', click: () => { deck.scratchSampleReturn(); renderPads(); }, title: 'Back to the track' });
  const renderPads = () => pads.forEach((b, n) => { b.firstChild.textContent = bank.slots[n].name; b.classList.toggle('lit', true); b.style.setProperty('--pad-color', deck.scratchSample?.slot === n ? '#ffffff' : '#22d3ee'); ret.disabled = !deck.scratchSample; });

  const play = button(el('span', { class: 'play-glyph' }, icon('play'), icon('pause')), { cls: 'btn-play big', title: 'Play / pause', down: () => { eng.resume(); deck.togglePlay(); }, active: () => deck.playing });
  const cue = button('CUE', { cls: 'btn-cue big', down: () => deck.cueDown(), up: () => deck.cueUp() });
  const title = el('div', { class: 'sv-title' });
  const lat = Math.round(((eng.ctx.baseLatency || 0) + (eng.ctx.outputLatency || 0)) * 1000 + 16); // + about a frame of touch input
  const latency = el('div', { class: `sv-latency${lat > 45 ? ' warn' : ''}`, title: 'Estimated touch-to-sound latency: audio output latency plus about one frame of touch input' },
    `≈ ${lat} ms touch-to-sound${lat > 45 ? ' · use wired headphones for tighter scratching (Bluetooth adds latency)' : ''}`);
  const close = el('button', { class: 'btn sm icon-only sv-close', title: 'Close scratch view (Esc)', 'aria-label': 'Close scratch view', onclick: () => api.close() }, icon('x'));
  const left = opt.scratchHand === 'left';
  const view = el('div', { class: `scratch-view${left ? ' left-hand' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': `Deck ${deck.index + 1} scratch view`, style: { '--deck-color': DECK_COLORS[deck.index] } },
    el('div', { class: 'sv-head' }, el('span', { class: 'sv-num' }, String(deck.index + 1)), title, latency, close),
    el('div', { class: 'sv-body' },
      el('div', { class: 'sv-platter' }, jog),
      el('div', { class: 'sv-fader' }, track, cut),
    ),
    el('div', { class: 'sv-foot' }, el('div', { class: 'sv-transport' }, cue, play), el('div', { class: 'sv-pads' }, ...pads), ret),
  );
  let raf = 0;
  const frame = (now) => {
    jog.draw(now); play.render();
    const t = deck.track; const txt = t ? `${t.title || 'Untitled'}${deck.scratchSample ? '' : t.artist ? ` — ${t.artist}` : ''}` : 'No track loaded';
    if (title._t !== txt) { title._t = txt; title.textContent = txt; }
    if (dragId == null && saved == null) render();
    raf = requestAnimationFrame(frame);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); api.close(); } };
  const api = {
    deck, el: view,
    close() {
      cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey, true);
      if (saved != null) { strip.set(saved); saved = null; }
      if (deck.scratching) deck.jogPositionEnd?.(performance.now());
      view.remove(); document.body.classList.remove('scratch-view-open'); open = null;
    },
  };
  document.addEventListener('keydown', onKey, true);
  document.body.append(view); document.body.classList.add('scratch-view-open');
  render(); renderPads(); raf = requestAnimationFrame(frame);
  open = api;
  return api;
}
