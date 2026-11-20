// Video panel: live preview of the video mix + controls (transitions, per-deck FX, overlay, YouTube, outputs).
// setupVideo(app) → { openPanel, openOutputWindow, toggleMixer }
import { el } from '../util.js';
import { VideoMixer, RESOLUTIONS } from './mixer.js';
import { TRANSITIONS, FX, parseYouTube } from './video-core.js';
import { YouTubeSource, searchYouTube } from './youtube.js';
import { OutputManager } from './output.js';

const POS = [['tl', 'Top left'], ['tr', 'Top right'], ['bl', 'Bottom left'], ['br', 'Bottom right'], ['cc', 'Centre']];

export function setupVideo(app) {
  if (app.video?.api) return app.video.api;
  const mixer = new VideoMixer(app);
  const youtube = new YouTubeSource(app);
  mixer.extra = youtube;
  const outputs = new OutputManager(mixer, youtube);
  let panel = null, ui = null;

  // jukebox volume follows the crossfader / master volume
  app.engine.on('master', () => youtube.applyAudio());
  youtube.on('error', (m) => app.toast(`YouTube: ${m}`));

  function ensurePanel() {
    if (panel) return panel;
    ui = buildPanel();
    panel = ui.root;
    document.body.append(panel);
    return panel;
  }

  function openPanel({ dock } = {}) {
    ensurePanel();
    if (dock != null) ui.setDock(dock);
    panel.hidden = false;
    ui.stage.prepend(mixer.canvas);
    ui.setCollapsed(false);
    ui.startLive();
    return panel;
  }

  function closePanel() {
    if (!panel || panel.hidden) return;
    if (youtube.videoId) { youtube.stop(); app.toast('YouTube player closed with the video panel'); }
    panel.hidden = true;
    mixer.removeOutput('panel');
    mixer.host.append(mixer.canvas);
    ui.stopLive();
  }

  function toggleMixer() { if (panel && !panel.hidden) closePanel(); else openPanel(); }

  async function openOutputWindow(opts = {}) {
    try { const w = await outputs.open(opts); ui?.renderOutputs(); return w; }
    catch (e) { app.toast(e.message); return null; }
  }
  outputs.onClose = () => ui?.renderOutputs();

  // ------------------------------------------------------------------ panel
  function buildPanel() {
    const ytMount = el('div', { class: 'vid-yt' });
    youtube.attach(ytMount);
    const stage = el('div', { class: 'vid-stage', title: 'Video mix preview' }, ytMount, el('div', { class: 'vid-stage-empty' }, 'Nothing playing'));
    const ytAttr = el('div', { class: 'vid-yt-attr', hidden: true });
    const meters = el('div', { class: 'vid-meters' });
    const fpsEl = el('span', { class: 'vid-fps' });
    const dockBtn = el('button', { class: 'btn xs', title: 'Small preview / full panel', onclick: () => setDock(!root.classList.contains('dock')) }, '⇲');
    const colBtn = el('button', { class: 'btn xs', title: 'Collapse', onclick: () => setCollapsed(!root.classList.contains('collapsed')) }, '▾');
    const popBtn = el('button', { class: 'btn xs', title: 'Pop-out output window (projector / second screen)', onclick: () => openOutputWindow() }, '⧉ OUT');
    const head = el('div', { class: 'vid-head' },
      el('b', {}, 'VIDEO'), fpsEl, el('span', { class: 'tb-spacer' }), popBtn, dockBtn, colBtn,
      el('button', { class: 'btn xs', title: 'Close', 'aria-label': 'Close video panel', onclick: closePanel }, '✕'));
    const tabsDef = { mix: ['Mix', mixTab], fx: ['FX', fxTab], overlay: ['Overlay', overlayTab], youtube: ['YouTube', ytTab], output: ['Output', outputTab] };
    const tabBar = el('div', { class: 'tabs' });
    const pane = el('div', { class: 'vid-pane' });
    let cur = 'mix';
    const show = (k) => { cur = k; pane.replaceChildren(tabsDef[k][1]()); for (const b of tabBar.children) b.classList.toggle('active', b.dataset.k === k); };
    for (const [k, [label]] of Object.entries(tabsDef)) tabBar.append(el('button', { class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
    const controls = el('div', { class: 'vid-controls' }, tabBar, pane);
    const root = el('div', { class: 'vid-panel', hidden: true, role: 'region', 'aria-label': 'Video mixer' }, head, stage, ytAttr, meters, controls);
    show('mix');

    // drag the header to move the panel
    let drag = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = root.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; head.setPointerCapture(e.pointerId);
    });
    head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const x = Math.max(0, Math.min(innerWidth - 120, e.clientX - drag.dx)), y = Math.max(0, Math.min(innerHeight - 40, e.clientY - drag.dy));
      Object.assign(root.style, { left: `${x}px`, top: `${y}px`, right: 'auto' });
    });
    head.addEventListener('pointerup', () => { drag = null; });

    function setDock(on) { root.classList.toggle('dock', on); dockBtn.textContent = on ? '⇱' : '⇲'; dockBtn.title = on ? 'Expand to the full video panel' : 'Dock as a small preview'; }
    function setCollapsed(on) {
      root.classList.toggle('collapsed', on); colBtn.textContent = on ? '▸' : '▾';
      // preview hidden → stop rendering for it (the pop-out keeps its own output reference)
      if (on && !youtube.videoId) mixer.removeOutput('panel'); else if (!root.hidden) mixer.addOutput('panel');
    }

    // ---- live status (meters, fps, YouTube attribution) at 5 Hz; the canvas itself is the mixer's
    let liveT = null;
    const meterEls = [];
    function buildMeters() {
      meters.replaceChildren(); meterEls.length = 0;
      for (let i = 0; i < mixer.deckCount; i++) {
        const bar = el('i'), lbl = el('span', { class: 'vid-m-lbl' });
        meterEls.push({ bar, lbl });
        meters.append(el('div', { class: 'vid-m', style: `--deck-color: var(--deck${i + 1})` }, el('b', {}, String(i + 1)), lbl, el('span', { class: 'vid-m-bar' }, bar)));
      }
      const yb = el('i'), yl = el('span', { class: 'vid-m-lbl' }, 'YouTube');
      meterEls.push({ bar: yb, lbl: yl, yt: true });
      meters.append(el('div', { class: 'vid-m yt', hidden: true }, el('b', {}, '▶'), yl, el('span', { class: 'vid-m-bar' }, yb)));
    }
    function live() {
      if (meterEls.length !== mixer.deckCount + 1) buildMeters();
      const w = mixer.weights;
      let any = false;
      for (let i = 0; i < mixer.deckCount; i++) {
        const l = mixer.layers[i], m = meterEls[i];
        const a = w[i]?.alpha || 0; any ||= a > 0.01;
        m.bar.style.width = `${Math.round(a * 100)}%`;
        m.lbl.textContent = l.kind === 'video' ? `Video${l.lastDecision ? ` ${l.lastDecision.mode === 'locked' || l.lastDecision.mode === 'nudge' ? `±${Math.round(Math.abs(l.drift) * 1000)}ms` : l.lastDecision.mode}` : ''}` : l.kind === 'visual' ? 'Visualizer' : '—';
      }
      const ym = meterEls[mixer.deckCount];
      ym.bar.parentElement.parentElement.hidden = !youtube.videoId;
      ym.bar.style.width = `${Math.round((youtube.videoId ? youtube.weight : 0) * 100)}%`;
      any ||= youtube.videoId && youtube.weight > 0.01;
      stage.classList.toggle('empty', !any && !mixer.config.overlay.text && !mixer.logoImg);
      fpsEl.textContent = mixer.running ? `${mixer.rendererKind === 'webgl2' ? 'GL' : '2D'} · ${mixer.stats.fps} fps${outputs.isOpen ? ' · OUT' : ''}` : 'paused';
      ytAttr.hidden = !youtube.videoId;
      ytMount.classList.toggle('pip', !!youtube.videoId && !youtube.showInMix);
      if (cur === 'output') renderOutputs();
    }
    function startLive() { clearInterval(liveT); live(); liveT = setInterval(live, 200); }
    function stopLive() { clearInterval(liveT); liveT = null; }

    function renderYtAttr() {
      if (!youtube.videoId) { ytAttr.replaceChildren(); return; }
      ytAttr.replaceChildren(
        el('span', { class: 'vid-yt-logo' }, '▶ YouTube'),
        el('span', { class: 'vid-yt-title' }, youtube.meta.title || youtube.videoId, youtube.meta.channel ? ` · ${youtube.meta.channel}` : ''),
        el('a', { href: `https://www.youtube.com/watch?v=${youtube.videoId}`, target: '_blank', rel: 'noopener', class: 'vid-yt-link' }, 'Watch on YouTube'));
    }
    youtube.on('load', () => { renderYtAttr(); if (cur === 'youtube') show('youtube'); });
    youtube.on('meta', renderYtAttr);

    // ---- tabs
    function mixTab() {
      const sel = el('select', { class: 'sel', onchange: () => mixer.setTransition(sel.value) }, ...TRANSITIONS.map((t) => el('option', { value: t.id, selected: t.id === mixer.config.transition }, t.name)));
      const rows = [];
      for (let i = 0; i < mixer.deckCount; i++) {
        const l = mixer.layers[i];
        const ms = el('select', { class: 'sel tiny', onchange: () => mixer.setMode(i, ms.value) },
          el('option', { value: 'auto', selected: l.mode === 'auto' }, 'Video, else visualizer'),
          el('option', { value: 'visual', selected: l.mode === 'visual' }, 'Visualizer only'),
          el('option', { value: 'off', selected: l.mode === 'off' }, 'Off (black)'));
        rows.push(el('div', { class: 'vid-deckrow', style: `--deck-color: var(--deck${i + 1})` }, el('b', {}, `Deck ${i + 1}`), ms));
      }
      return el('div', { class: 'form' },
        el('label', { class: 'field' }, el('span', {}, 'Transition'), sel),
        el('p', { class: 'hint' }, 'Crossfade follows the audio: each layer’s opacity is its channel fader² × crossfader gain (A/B/THRU, same curve as the audio). The other transitions use the crossfader to move from side A to side B.'),
        el('h3', {}, 'Layers'), ...rows,
        el('p', { class: 'hint' }, 'Video files play muted in sync with the deck (audio always comes from the deck). Tracks without video show cover art with audio-reactive visuals.'));
    }

    function fxTab() {
      const rows = [];
      for (let i = 0; i < mixer.deckCount; i++) {
        const btns = FX.map((f) => {
          const ok = mixer.supportsFx(f.id);
          const b = el('button', { class: `btn xs ${mixer.config.fx[i][f.id] ? 'active' : ''}`, disabled: !ok, title: ok ? f.name : `${f.name} needs WebGL2`, onclick: () => { const on = !mixer.config.fx[i][f.id]; mixer.setFx(i, f.id, on); b.classList.toggle('active', on); } }, f.name);
          return b;
        });
        rows.push(el('div', { class: 'vid-fxrow', style: `--deck-color: var(--deck${i + 1})` }, el('b', {}, String(i + 1)), el('div', { class: 'vid-fxbtns' }, ...btns)));
      }
      return el('div', { class: 'form' }, ...rows,
        el('p', { class: 'hint' }, `Pulse and strobe follow the deck’s beat grid. Renderer: ${mixer.rendererKind === 'webgl2' ? 'WebGL2 (all effects)' : '2D canvas (no RGB shift / kaleidoscope)'}. Strobe flashes; use with care around photosensitive audiences.`));
    }

    function overlayTab() {
      const o = mixer.config.overlay;
      const posSel = (val, cb) => { const s = el('select', { class: 'sel', onchange: () => cb(s.value) }, ...POS.map(([v, n]) => el('option', { value: v, selected: v === val }, n))); return s; };
      const text = el('input', { class: 'inp', value: o.text, placeholder: 'DJ name, venue, hashtag…', maxlength: 80 });
      text.addEventListener('input', () => mixer.setOverlay({ text: text.value }));
      const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,image/webp,image/gif', style: { display: 'none' } });
      file.addEventListener('change', () => {
        const f = file.files[0]; file.value = '';
        if (!f) return;
        if (f.size > 1.5 * 1024 * 1024) { app.toast('Logo image is too large (max 1.5 MB)'); return; }
        const r = new FileReader(); r.onload = () => { mixer.setLogo(String(r.result)); show('overlay'); }; r.readAsDataURL(f);
      });
      const lt = el('input', { type: 'checkbox', checked: o.lowerThird, onchange: () => mixer.setOverlay({ lowerThird: lt.checked }) });
      const hold = el('input', { class: 'inp', type: 'number', min: 2, max: 60, value: o.hold || 8, style: { width: '70px' }, onchange: () => mixer.setOverlay({ hold: Math.max(2, Math.min(60, Number(hold.value) || 8)) }) });
      return el('div', { class: 'form' },
        el('div', { class: 'row' }, el('label', { class: 'field', style: { flex: 1 } }, el('span', {}, 'Text overlay'), text), el('label', { class: 'field' }, el('span', {}, 'Position'), posSel(o.textPos, (v) => mixer.setOverlay({ textPos: v })))),
        el('div', { class: 'row' },
          el('label', { class: 'field', style: { flex: 1 } }, el('span', {}, 'Logo'),
            el('div', { class: 'row' }, el('button', { class: 'btn sm', onclick: () => file.click() }, o.logo ? 'Replace image…' : 'Upload image…'), o.logo ? el('button', { class: 'btn sm', onclick: () => { mixer.setLogo(''); show('overlay'); } }, 'Remove') : null, o.logo ? el('img', { class: 'vid-logo-thumb', src: o.logo, alt: 'Logo' }) : null)),
          el('label', { class: 'field' }, el('span', {}, 'Position'), posSel(o.logoPos, (v) => mixer.setOverlay({ logoPos: v }))), file),
        el('h3', {}, 'Now playing'),
        el('label', { class: 'vid-check' }, lt, 'Show “Artist – Title” lower third when a new track becomes the main layer'),
        el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', {}, 'Seconds'), hold), el('button', { class: 'btn sm', onclick: () => {
          const i = mixer.layers.findIndex((l, k) => k < mixer.deckCount && l.deck.playing && (mixer.weights[k]?.alpha || 0) > 0.2);
          const t = i >= 0 ? mixer.layers[i].deck.track : null;
          mixer.showNowPlaying(t ? `${t.artist ? `${t.artist} – ` : ''}${t.title || ''}` : youtube.title());
        } }, 'Show now')));
    }

    function ytTab() {
      const key = app.settings.youtubeApiKey || '';
      const url = el('input', { class: 'inp', placeholder: 'YouTube URL or video ID' });
      const load = async (id, opts = {}) => {
        try { await youtube.load(id, opts); } catch (e) { app.toast(`YouTube: ${e.message}`); }
      };
      const doUrl = () => { const r = parseYouTube(url.value); if (!r) { app.toast('That doesn’t look like a YouTube link or video ID'); return; } load(r.id, { start: r.start }); };
      url.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUrl(); });
      const results = el('div', { class: 'vid-yt-results' });
      const q = el('input', { class: 'inp', placeholder: 'Search YouTube', type: 'search' });
      let next = null, lastQ = '';
      const search = async (more = false) => {
        const query = more ? lastQ : q.value.trim();
        if (!query) return;
        try {
          const r = await searchYouTube(query, app.settings.youtubeApiKey, { pageToken: more ? next : undefined });
          lastQ = query; next = r.next;
          if (!more) results.replaceChildren();
          results.querySelector('.vid-yt-more')?.remove();
          for (const it of r.items) {
            results.append(el('button', { class: 'vid-yt-item', title: `${it.title} · ${it.channel}`, onclick: () => load(it.id, { title: it.title, channel: it.channel }) },
              el('img', { src: it.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
              el('span', { class: 'vid-yt-meta' }, el('b', {}, it.title), el('small', {}, it.channel, it.live ? ' · LIVE' : ''))));
          }
          if (!r.items.length && !more) results.append(el('p', { class: 'hint' }, 'No results'));
          if (next) results.append(el('button', { class: 'btn sm vid-yt-more', onclick: () => search(true) }, 'More results'));
        } catch (e) { app.toast(e.message); }
      };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
      const keyIn = el('input', { class: 'inp', type: 'password', value: key, placeholder: 'YouTube Data API v3 key', autocomplete: 'off' });
      const saveKey = async () => { await app.setSetting('youtubeApiKey', keyIn.value.trim()); app.toast(keyIn.value.trim() ? 'YouTube API key saved' : 'YouTube API key removed'); show('youtube'); };
      const keyBox = el('details', { class: 'vid-yt-key', open: !key },
        el('summary', {}, key ? 'YouTube API key' : 'Search needs your own YouTube Data API key'),
        el('div', { class: 'row' }, keyIn, el('button', { class: 'btn sm', onclick: saveKey }, 'Save')),
        el('p', { class: 'hint' }, 'Create a key in the Google Cloud console (YouTube Data API v3). It is stored in your OpenDJ settings and only sent to googleapis.com. Pasting links works without a key.'));

      // current player controls
      let current = null;
      if (youtube.videoId) {
        const side = el('select', { class: 'sel tiny', onchange: () => youtube.setSide(side.value) }, ...['A', 'THRU', 'B'].map((s) => el('option', { value: s, selected: youtube.xfAssign === s }, s)));
        const vol = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: youtube.volume, class: 'vid-range', oninput: () => youtube.setVolume(Number(vol.value)) });
        const mix = el('input', { type: 'checkbox', checked: youtube.showInMix, onchange: () => youtube.setShowInMix(mix.checked) });
        const juke = el('input', { type: 'checkbox', checked: youtube.jukebox, onchange: () => youtube.setJukebox(juke.checked) });
        current = el('div', { class: 'vid-yt-current' },
          el('div', { class: 'row' }, el('button', { class: 'btn sm', onclick: () => youtube.play() }, '▶ Play'), el('button', { class: 'btn sm', onclick: () => youtube.pause() }, '❚❚ Pause'), el('button', { class: 'btn sm', onclick: () => youtube.stop() }, '■ Close')),
          el('label', { class: 'vid-check' }, mix, 'Show in the video mix (muted visuals layer)'),
          el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', {}, 'Crossfader side'), side), el('label', { class: 'field', style: { flex: 1 } }, el('span', {}, 'Level (like a channel fader)'), vol)),
          el('label', { class: 'vid-check juke' }, juke, el('span', {}, el('b', {}, 'YouTube jukebox audio'), ' — plays YouTube’s own sound, volume follows its crossfader side. ', el('em', {}, 'No EQ/FX/sync: YouTube audio can’t be processed.'))));
      }
      return el('div', { class: 'form' },
        el('p', { class: 'hint' }, 'YouTube plays through the official YouTube player. Nothing is downloaded and its audio never enters the mixer.'),
        el('div', { class: 'row' }, url, el('button', { class: 'btn sm', onclick: doUrl }, 'Load')),
        current,
        key ? el('div', { class: 'row' }, q, el('button', { class: 'btn sm', onclick: () => search() }, 'Search')) : null,
        results, keyBox);
    }

    const outBox = el('div');
    function renderOutputs() {
      const open = outputs.isOpen;
      const can = OutputManager.canUseScreens;
      const resSel = el('select', { class: 'sel', onchange: () => mixer.setResolution(resSel.value) }, ...Object.keys(RESOLUTIONS).map((k) => el('option', { value: k, selected: k === mixer.config.resolution }, `${k} (${RESOLUTIONS[k].join('×')})`)));
      outBox.replaceChildren(el('div', { class: 'form' },
        el('div', { class: 'row' },
          open ? el('button', { class: 'btn sm active', onclick: () => { outputs.close(); renderOutputs(); } }, 'Close output window') : el('button', { class: 'btn sm primary', onclick: () => openOutputWindow() }, '⧉ Pop-out output window'),
          el('button', { class: 'btn sm', disabled: !can, title: can ? 'Open the output on another screen' : 'Needs the Window Management API (Chrome / Edge / Electron)', onclick: () => openOutputWindow({ secondScreen: true }) }, '⛶ Fullscreen on second screen')),
        el('p', { class: 'hint' }, open ? 'Output window is open. Double-click it (or press F) for full screen.' : 'Drag the output window to a projector or second screen, then double-click it for full screen.'),
        el('label', { class: 'field' }, el('span', {}, 'Output resolution'), resSel),
        el('p', { class: 'hint' }, `Renderer: ${mixer.rendererKind === 'webgl2' ? 'WebGL2' : '2D canvas'} · ${mixer.running ? `${mixer.stats.fps} fps` : 'idle (no output visible)'}`)));
      return outBox;
    }
    function outputTab() { return renderOutputs(); }

    setDock(false);
    return { root, stage, setDock, setCollapsed, startLive, stopLive, renderOutputs: () => { if (cur === 'output') renderOutputs(); }, show };
  }

  const api = { openPanel, openOutputWindow, toggleMixer, closePanel, mixer, youtube, outputs };
  app.video = { api, mixer, youtube, outputs };
  return api;
}

export { VideoMixer };
