// Automix queue panel: the next transition drawn as a timeline (faders, who owns the bass, the swap, where the
// incoming track lands, planned tricks), the checker's verdict, one-tap nudges, a headphone preview, and the party
// controls (energy, keep the vibe, never play, tricks). docs/PRO_DJ_AUTOMIX_RESEARCH.md P3.4, P6.
import { el, fmtTime } from '../util.js';
import { STYLE_LABEL } from '../automix.js';
import { renderTransition, playPreview } from '../automix-preview.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const W = 320, H = 74;

/** SVG timeline of a preview plan (AutoMix.previewPlan()). */
export function timelineSvg(p) {
  const bar = p.beatLen * 4, end = p.end, from = p.begin - 4 * bar, to = end + 4 * bar;
  const x = (sec) => ((sec - from) / Math.max(1e-6, to - from)) * W;
  const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'am-tl', role: 'img', 'aria-label': `Next transition: ${STYLE_LABEL[p.style] || p.style}` });
  // phrase grid (every 4 bars, stronger every 8)
  for (let b = Math.ceil((from - p.begin) / bar / 4) * 4; p.begin + b * bar <= to; b += 4) s.append(svg('line', { x1: x(p.begin + b * bar), x2: x(p.begin + b * bar), y1: 0, y2: H, class: b % 8 ? 'am-tl-grid' : 'am-tl-grid strong' }));
  // decks: outgoing (top) until the end, incoming (bottom) from the start
  s.append(svg('rect', { x: 0, y: 6, width: x(end), height: 18, class: 'am-tl-out' }));
  s.append(svg('rect', { x: x(p.drop ?? p.begin), y: 44, width: W - x(p.drop ?? p.begin), height: 18, class: 'am-tl-in' }));
  if (p.lanes) {
    const pts = (key, y0) => p.lanes.map((L) => `${x(p.begin + L.k * p.len).toFixed(1)},${(y0 - (L[key] ?? 0) / 0.8 * 16).toFixed(1)}`).join(' ');
    s.append(svg('polyline', { points: pts('outVol', 24), class: 'am-tl-vol out' }), svg('polyline', { points: pts('inVol', 62), class: 'am-tl-vol in' }));
    // who owns the low band
    for (let i = 0; i < p.lanes.length - 1; i++) {
      const L = p.lanes[i], a = x(p.begin + L.k * p.len), b = x(p.begin + p.lanes[i + 1].k * p.len);
      const owner = (L.inLow ?? 0) > -0.5 && (L.inVol ?? 0) > 0.05 ? 'in' : 'out';
      s.append(svg('rect', { x: a, y: 30, width: Math.max(0.5, b - a), height: 8, class: `am-tl-bass ${owner}` }));
    }
  }
  const mark = (sec, cls, label) => { const g = svg('g', { class: cls }); g.append(svg('line', { x1: x(sec), x2: x(sec), y1: 2, y2: H - 2 })); const tt = svg('title'); tt.textContent = label; g.append(tt); s.append(g); };
  if (p.kSwap != null && p.lanes) mark(p.begin + p.kSwap * p.len, 'am-tl-swap', 'Bass swap');
  if (p.drop != null) mark(p.drop, 'am-tl-swap', 'Drop');
  if (p.landing != null && p.lanes) mark(p.begin + (p.landing - p.inStart) / (p.innRate / p.outRate), 'am-tl-land', 'Incoming main part lands here');
  for (const t of p.tricks || []) if (t.at >= from && t.at <= to) { const tri = svg('path', { d: `M${x(t.at) - 4},${H} L${x(t.at) + 4},${H} L${x(t.at)},${H - 7} Z`, class: 'am-tl-trick' }); const tt = svg('title'); tt.textContent = t.label; tri.append(tt); s.append(tri); }
  if (p.position >= from && p.position <= to) s.append(svg('line', { x1: x(p.position), x2: x(p.position), y1: 0, y2: H, class: 'am-tl-head' }));
  return s;
}

/** The preview / party-control box for the automix queue panel: { el, render() }. */
export function buildPreviewBox(app) {
  const a = app.automix;
  const tl = el('div', { class: 'am-tl-wrap' }), verdict = el('div', { class: 'am-check hint' }), plan = el('div', { class: 'am-plan hint' });
  const tricksLine = el('div', { class: 'am-tricks hint' });
  let playing = null, lastKey = '', lastDraw = 0;
  const previewBtn = el('button', { class: 'btn sm', title: 'Render the next transition and play it in the headphones (the crowd keeps hearing the master)' }, 'Preview ♪');
  previewBtn.addEventListener('click', async () => {
    if (playing) { playing.stop(); return; }
    const p = a.previewPlan(); if (!p) { app.toast?.('No transition planned yet'); return; }
    previewBtn.disabled = true; previewBtn.textContent = 'Rendering…';
    try {
      const buf = await renderTransition(app.engine.ctx, p, { gains: a.opts.levelMatch !== false ? p.gains : {} });
      const toMaster = !a.enabled && !app.engine.decks.some((d) => d.playing);
      playing = playPreview(app.engine, buf, { toMaster });
      app.toast?.(playing.where === 'headphones' ? 'Preview playing in the headphones (cue)' : 'Preview playing');
      previewBtn.textContent = 'Stop preview';
      playing.done.then(() => { playing = null; previewBtn.textContent = 'Preview ♪'; });
    } catch (e) { app.toast?.(`Preview failed: ${e.message}`); previewBtn.textContent = 'Preview ♪'; }
    finally { previewBtn.disabled = false; }
  });
  const nudge = (kind, label, title) => el('button', { class: 'btn xs', title, onclick: () => { a.nudge(kind); lastKey = ''; } }, label);
  const nudges = el('div', { class: 'am-nudges' },
    nudge('earlier', '◀ phrase', 'Start the transition a phrase earlier'), nudge('later', 'phrase ▶', 'Start the transition a phrase later'),
    nudge('shorter', 'shorter', 'Shorter transition (fewer bars)'), nudge('longer', 'longer', 'Longer transition (more bars)'),
    nudge('reset', 'reset', 'Back to the planned transition'), previewBtn);
  // party controls (settings.automix: energyBias, vibeLock, banned, tricks)
  const amSet = (patch) => app.setSetting('automix', { ...app.settings.automix, ...patch });
  const energyLbl = el('span', { class: 'hint' });
  const vibe = el('input', { type: 'checkbox' });
  vibe.addEventListener('change', () => amSet({ vibeLock: vibe.checked }));
  const tricks = el('select', { class: 'sel sm', title: 'Tricks inside tracks: bass teases, filter builds, loop rolls, pause drops, rewinds' },
    el('option', { value: 'off' }, 'Tricks: off'), el('option', { value: 'subtle' }, 'Tricks: subtle'), el('option', { value: 'party' }, 'Tricks: party'));
  tricks.addEventListener('change', () => amSet({ tricks: tricks.value }));
  const party = el('div', { class: 'am-party' },
    el('button', { class: 'btn xs', title: 'Less energy: the next picks aim lower', onclick: () => amSet({ energyBias: Math.max(-2, (Number(a.opts.energyBias) || 0) - 0.5) }) }, 'Energy −'),
    energyLbl,
    el('button', { class: 'btn xs', title: 'More energy: the next picks aim higher', onclick: () => amSet({ energyBias: Math.min(2, (Number(a.opts.energyBias) || 0) + 0.5) }) }, 'Energy +'),
    el('label', { class: 'check', title: 'Stay close to the style of what is playing' }, vibe, ' Keep this vibe'),
    el('button', { class: 'btn xs', title: 'Never play the next track (in any automix set); it is taken out of the queue', onclick: () => {
      const n = a.nextTrack(); if (!n) return;
      amSet({ banned: [...new Set([...(a.opts.banned || []), String(n.id)])] });
      a.remove(a.idx); app.toast?.(`Never playing "${n.title}" again (Settings → Automix to undo)`);
    } }, 'Never play next'),
    tricks);
  const box = el('div', { class: 'am-preview' }, tl, verdict, tricksLine, nudges, plan, party);
  const render = () => {
    const now = performance.now();
    energyLbl.textContent = ` ${(Number(a.opts.energyBias) || 0) > 0 ? '+' : ''}${Number(a.opts.energyBias) || 0} `;
    vibe.checked = !!a.opts.vibeLock; tricks.value = a.opts.tricks || 'subtle';
    if (!a.enabled || a.transition) { if (lastKey !== 'off') { tl.replaceChildren(); verdict.textContent = a.transition ? 'Mixing now…' : ''; tricksLine.textContent = ''; plan.textContent = ''; lastKey = 'off'; } return; }
    if (now - lastDraw < 400) return;
    lastDraw = now;
    const p = a.previewPlan();
    if (!p) { tl.replaceChildren(); verdict.textContent = ''; return; }
    tl.replaceChildren(timelineSvg(p));
    const key = `${p.style}|${p.begin}|${p.len}|${JSON.stringify(p.nudge)}|${p.check?.issues?.join()}|${p.tricks.length}|${p.upcoming.map((t) => t.id).join()}`;
    if (key === lastKey) return;
    lastKey = key;
    const c = p.check;
    verdict.textContent = `${STYLE_LABEL[p.style] || p.style}${p.doubleDrop ? ' (double drop)' : ''} in ${fmtTime(p.beginsIn).slice(0, 5)} · `
      + (c ? (c.ok ? `check OK (level ±${Math.max(c.metrics.bumpLu, c.metrics.dipLu)} LU)` : `check: ${c.issues.join(', ')}`) : 'drop transition')
      + (p.nudge ? ' · nudged' : '');
    tricksLine.textContent = p.tricks.length ? `Tricks planned: ${p.tricks.map((t) => t.label).join(', ')}` : '';
    plan.textContent = p.upcoming.length ? `Planned: ${p.upcoming.map((t) => t.title).join(' → ')}` : '';
  };
  return { el: box, render };
}
