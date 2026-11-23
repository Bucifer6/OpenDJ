// AI stems UI: deck stem controls, library menu items, model consent dialog, preparation progress panel,
// settings pane. Wiring (done by the app): setupStems(app) once after the layout exists,
// buildStemControls(app, deck) inside each deck, stemsMenuItems(app, tracks) in the track context menu.
import { el } from '../util.js';
import { icon } from '../ui/icons.js';
import { button, knob } from '../ui/controls.js';
import { StemsManager, stemsApi, backendName } from './stems.js';

const LABELS = [['VOC', 'Vocals'], ['DRM', 'Drums'], ['BASS', 'Bass'], ['MEL', 'Melody / other']];
const MB = (b) => `${Math.round((b || 0) / 1048576)} MB`;
const pct = (c) => (c?.total ? Math.floor((c.done / c.total) * 100) : 0);

/** Create app.stems (once) with the consent dialog and the progress panel. */
export function setupStems(app) {
  if (app.stems) return app.stems;
  const stems = app.stems = new StemsManager(app);
  stems.confirmDownload = (m) => consentDialog(app, m);

  const bar = el('div', { class: 'stems-bar-fill' });
  const label = el('div', { class: 'stems-panel-label' });
  const queued = el('div', { class: 'stems-panel-queue' });
  const panel = el('div', { class: 'stems-panel', role: 'status', 'aria-live': 'polite', hidden: true },
    el('div', { class: 'stems-panel-row' }, label, button(icon('x'), { cls: 'xs', title: 'Cancel stem preparation (Shift: cancel the whole queue)', click: (e) => (e.shiftKey ? stems.cancelAll() : stems.cancel()) })),
    el('div', { class: 'stems-bar' }, bar), queued);
  document.body.append(panel);
  let modelMsg = null;
  const render = () => {
    const c = stems.current;
    panel.hidden = (!c || c.background) && !modelMsg; // background preparation stays quiet (Settings > AI stems shows it)
    if (modelMsg) { label.textContent = modelMsg.text; bar.style.width = `${modelMsg.pct}%`; queued.textContent = ''; return; }
    if (!c) return;
    const p = c.phase === 'separating' ? pct(c) : c.phase === 'loading model' && c.total ? pct(c) : null;
    const eta = c.phase === 'separating' && c.done > 0 ? Math.round(((performance.now() - c.started) / c.done) * (c.total - c.done) / 1000) : null;
    const on = c.backend ? ` · ${backendName(c.backend)}` : '';
    label.textContent = `Stems: ${c.title} — ${c.phase}${p != null ? ` ${p}%` : '…'}${eta != null ? ` (~${eta >= 90 ? `${Math.round(eta / 60)} min` : `${eta} s`} left)` : ''}${on}`;
    if (c.phase === 'separating' && !c.background) cpuNotice(c.backend);
    bar.style.width = `${p ?? 0}%`;
    bar.classList.toggle('indeterminate', p == null);
    queued.textContent = stems.queue.length ? `${stems.queue.length} more queued` : '';
  };
  // once a session: separation on the CPU takes minutes per track, so say so, and how to have stems ready in time
  let cpuNoticed = false;
  const cpuNotice = (backend) => {
    if (cpuNoticed || !['cpu', 'wasm'].includes(backend)) return;
    cpuNoticed = true;
    const per = perTrackMinutes(stems);
    const why = stems._status?.native?.gpuFailed ? ' (the graphics card could not be used for stems on this computer)' : '';
    app.toast(`AI stems are being prepared on the CPU${why}: about ${per} min per track. To have them ready when you mix, prepare them ahead: playlist ⋯ → Prepare AI stems, or Automix → Prepare stems for this set.`, { duration: 12000 });
  };
  stems.on('progress', render); stems.on('queue', render);
  stems.on('model', (m) => {
    modelMsg = m.downloading ? { text: `Downloading the stems model… ${MB(m.received)}${m.total ? ` of ${MB(m.total)}` : ''}`, pct: m.total ? Math.floor((m.received / m.total) * 100) : 0 } : null;
    if (m.error) app.toast(`⚠ Stems model: ${m.error}`);
    render();
  });
  stems.on('finished', (r) => app.toast(`Stems ready: ${r.title}${r.ms ? ` (${(r.ms / 1000).toFixed(0)} s, ${backendName(r.backend)}${r.threads > 1 ? ` ×${r.threads}` : ''})` : ''}`));
  stems.on('failed', (r) => app.toast(`⚠ Stems for "${r.title}" failed: ${r.message}`));
  stems.on('cancelled', () => app.toast('Stem preparation cancelled'));
  render();
  stems.status().catch(() => {}); // which engine, and the server's queue (another device may be preparing already)

  // Prepare ahead on the server: Automix's next two tracks, and any track loaded on a deck (first in line)
  let aheadT = null;
  app.automix?.on('state', () => {
    clearTimeout(aheadT);
    aheadT = setTimeout(() => {
      const a = app.automix;
      if (!a?.enabled) return;
      const next = a.queue.slice(a.idx, a.idx + 2).map((t) => t?.id).filter(Boolean);
      if (next.length) stems.prefetch(next);
    }, 800);
  });
  for (const d of app.engine?.decks || []) d.on('load', () => { if (d.track?.id && !d.track.stems?.ready) stems.prefetch([d.track.id], { front: true }); });
  return stems;
}

/**
 * Minutes a 4-minute track takes to separate here, from the last finished run (ms per second of audio), else a
 * typical CPU figure. Shown in notices and next to "Prepare stems".
 */
export function perTrackMinutes(stems, seconds = 240) {
  const r = stems.lastRun || stems._status?.native?.last;
  const ratio = r?.ms > 0 && r.seconds > 0 ? r.ms / 1000 / r.seconds : 0.5;
  return Math.max(1, Math.round((ratio * seconds) / 60 * 2) / 2);
}

/** One-time consent before the model download (size, source, licence). Resolves true to download. */
export async function consentDialog(app, m) {
  let host = ''; try { host = new URL(m.url).host; } catch { /* custom */ }
  const body = el('div', { class: 'stems-consent' },
    el('p', {}, 'AI stems split a track into vocals, drums, bass and melody so you can mute or solo each part on the deck. The separation runs on the computer running OpenDJ (its GPU when it has one), or in this browser when that computer cannot; your music is not uploaded anywhere else.'),
    el('p', {}, 'The first time, OpenDJ needs to download the separation model once:'),
    el('dl', {},
      el('dt', {}, 'Model'), el('dd', {}, m.name),
      el('dt', {}, 'Download'), el('dd', {}, `${MB(m.downloadBytes || m.bytes)}${m.bytes && m.downloadBytes ? ` (${MB(m.bytes)} on disk)` : ''}`),
      el('dt', {}, 'From'), el('dd', {}, host || m.url),
      el('dt', {}, 'Licence'), el('dd', {}, m.licence),
      m.custom && !m.sha256 ? [el('dt', {}, 'Check'), el('dd', {}, 'No SHA-256 configured for this custom model: its integrity cannot be verified.')] : null),
    el('p', { class: 'muted' }, 'Preparing stems takes from a few seconds per track with a graphics card to about as long as the track on CPU only. Automix prepares its next tracks ahead. Stems are saved, so each track is prepared once.'));
  return !!(await app.dialogs.modal('Download the AI stems model?', body, [{ label: 'Not now', value: false }, { label: `Download ${MB(m.downloadBytes || m.bytes)}`, primary: true, value: true }]));
}

/** Deck stem controls: 4 stem mute buttons with level knobs, Acapella / Instrumental, vocal echo, prepare. */
export function buildStemControls(app, deck) {
  const stems = setupStems(app);
  const parts = [];
  const stemBtns = LABELS.map(([short, long], i) => {
    const b = button(short, {
      cls: `xs stem-btn stem-${i}`, title: `${long}: click to mute / unmute, Shift-click to solo`,
      click: (e) => { if (e.shiftKey) { deck.stemMute = deck.stemMute.map((_, k) => k !== i); deck.postStemGains(); } else deck.toggleStem(i); },
      active: () => !deck.stemMute[i],
    });
    const k = knob({ min: 0, max: 1, def: 1, bipolar: false, size: 'xs', get: () => deck.stemLevels[i], set: (v) => deck.setStemLevel(i, v), title: `${long} level` });
    parts.push(b, k);
    return el('div', { class: 'stem-cell' }, b, k);
  });
  const acap = button('ACAP', { cls: 'xs stem-macro', title: 'Acapella: vocals only (click again for all stems)', click: () => deck.stemAcapella(), active: () => deck.isAcapella });
  const inst = button('INST', { cls: 'xs stem-macro', title: 'Instrumental: everything but the vocals (click again for all stems)', click: () => deck.stemInstrumental(), active: () => deck.isInstrumental });
  const fx = button('V.ECHO', { cls: 'xs stem-macro', title: 'Stem FX: beat-synced echo on the vocals only', click: () => deck.setStemFx(!deck.stemFxOn), active: () => deck.stemFxOn });
  parts.push(acap, inst, fx);
  const status = el('span', { class: 'stems-status' });
  let runtimeAvailable = null, modelReady = false, modelDownloading = false;
  const prep = button('CHECKING AI…', { cls: 'xs stems-prep', title: 'Install the AI stems engine once, then prepare tracks here', click: async () => {
    if (runtimeAvailable === false) return app.toast('The AI stems engine is missing from this OpenDJ build. Update or reinstall OpenDJ.');
    if (modelDownloading) return;
    if (!modelReady) {
      try {
        const ok = await stems.ensureModel();
        if (ok) modelReady = true;
        render();
      } catch (e) { app.toast(`⚠ ${e.message}`); }
      return;
    }
    if (!deck.track) return app.toast('Load a track on this deck, then prepare its stems.');
    if (stems.current?.id === deck.track.id) return stems.cancel();
    stems.enqueue([deck.track.id], { force: !!deck.track.stems?.ready }).catch((e) => app.toast(`⚠ ${e.message}`));
  } });
  const root = el('div', { class: 'deck-stems', 'data-deck': deck.index }, el('div', { class: 'stems-row' }, ...stemBtns), el('div', { class: 'stems-row' }, acap, inst, fx, status, prep));

  const render = () => {
    const t = deck.track, ready = deck.stemsReady;
    const preparing = t && stems.current?.id === t.id, queued = t && stems.queue.includes(t.id);
    root.classList.toggle('ready', !!ready);
    root.classList.toggle('no-stems', !ready);
    for (const p of parts) { p.render?.(); if (p.tagName === 'BUTTON') p.disabled = !ready; } // knobs: greyed out by CSS (.no-stems)
    status.textContent = !t ? '' : ready ? 'AI STEMS' : deck.stemsLoading ? 'loading stems…' : preparing ? `${stems.current.phase} ${pct(stems.current) || ''}${stems.current.total ? '%' : ''}` : queued ? 'queued' : deck.stemsError ? `⚠ ${deck.stemsError}` : '';
    status.title = ready ? 'AI stems loaded: VOC / INST knobs on the mixer now control the stems' : '';
    prep.hidden = !!ready || !!deck.stemsLoading || !!queued || (!!t && !!t.stems?.ready && !deck.stemsError) || (!t && modelReady);
    prep.textContent = runtimeAvailable === null ? 'CHECKING AI…' : runtimeAvailable === false ? 'UPDATE APP' : modelDownloading ? 'INSTALLING…' : preparing ? 'CANCEL' : modelReady ? (t ? 'PREPARE STEMS' : 'STEMS READY') : 'INSTALL STEMS';
    prep.title = runtimeAvailable === false ? 'Update or reinstall OpenDJ to include its AI stems engine' : modelReady ? (t ? 'Prepare this track into vocals, drums, bass and melody' : 'AI stems engine installed; load a track to prepare stems') : 'Install the AI stems engine once; its model is downloaded to this computer';
    prep.disabled = runtimeAvailable === null || modelDownloading || (!modelReady && runtimeAvailable === false);
  };
  stems.status().then((st) => {
    runtimeAvailable = !!st.ort;
    modelReady = !!st.model?.ready;
    modelDownloading = !!st.model?.downloading;
    render();
  }).catch(() => { runtimeAvailable = false; render(); });
  stems.on('model', (m) => {
    if (m.ready) modelReady = true;
    if ('downloading' in m) modelDownloading = !!m.downloading;
    if (m.error) modelDownloading = false;
    render();
  });
  deck.on('stems', render); deck.on('load', render); deck.on('loaded', render); deck.on('state', () => { for (const p of parts) p.render?.(); });
  // once a session: separation on the CPU takes minutes per track, so say so, and how to have stems ready in time
  let cpuNoticed = false;
  const cpuNotice = (backend) => {
    if (cpuNoticed || !['cpu', 'wasm'].includes(backend)) return;
    cpuNoticed = true;
    const per = perTrackMinutes(stems);
    const why = stems._status?.native?.gpuFailed ? ' (the graphics card could not be used for stems on this computer)' : '';
    app.toast(`AI stems are being prepared on the CPU${why}: about ${per} min per track. To have them ready when you mix, prepare them ahead: playlist ⋯ → Prepare AI stems, or Automix → Prepare stems for this set.`, { duration: 12000 });
  };
  stems.on('progress', render); stems.on('queue', render); stems.on('track', render);
  render();
  root.render = render;
  return root;
}

/** Items for the library track context menu. */
export function stemsMenuItems(app, tracks) {
  const stems = setupStems(app);
  const ids = tracks.filter(Boolean).map((t) => t.id);
  if (!ids.length) return [];
  const have = tracks.filter((t) => t?.stems?.ready);
  const busy = ids.filter((id) => stems.current?.id === id || stems.queue.includes(id));
  const items = [];
  const todo = ids.length - have.length;
  const run = (list, opts) => stems.enqueue(list, opts).then((n) => n && list.length > 1 && app.toast(`${n} track(s) queued for AI stems`)).catch((e) => app.toast(`⚠ ${e.message}`));
  if (todo) items.push({ label: ids.length > 1 ? `Prepare AI stems (${todo} track${todo > 1 ? 's' : ''})` : 'Prepare AI stems', action: () => run(ids) });
  if (have.length) items.push({ label: have.length > 1 ? `Prepare stems again (${have.length})` : 'Prepare stems again', action: () => run(have.map((t) => t.id), { force: true }) });
  if (busy.length) items.push({ label: 'Cancel stem preparation', action: () => busy.forEach((id) => stems.cancel(id)) });
  if (have.length) items.push({ label: have.length > 1 ? `Delete stems (${have.length})` : 'Delete stems', action: async () => { for (const t of have) await stems.remove(t.id).catch((e) => app.toast(`⚠ ${e.message}`)); } });
  return items;
}

/** Settings pane content (model status, download/delete, backend, auto-load). */
export function stemsSettingsPane(app) {
  const stems = setupStems(app);
  const info = el('div', { class: 'stems-settings-info' }, 'Checking…');
  const refresh = async () => {
    try {
      const st = await stems.status(), m = st.model;
      info.replaceChildren(
        el('div', {}, `Model: ${m.name} — ${m.ready ? `downloaded (${MB(m.bytes)}${m.verified ? ', SHA-256 verified' : ''})` : m.downloading ? 'downloading…' : `not downloaded (${MB(m.downloadBytes || m.bytes)})`}`),
        el('div', { class: 'muted' }, st.native?.installed
          ? `Server engine: ONNX Runtime ${st.native.version}${st.native.backend ? ` · ${backendName(st.native.backend)}${st.native.threads > 1 ? ` ×${st.native.threads}` : ''}` : ' (GPU when available, else CPU)'}${st.native.last ? ` · last track ${Math.round(st.native.last.ms / 1000)} s for ${Math.round(st.native.last.seconds)} s of audio` : ''}`
          : `Server engine: not available (${st.native?.reason || 'old server'}) — this browser separates instead`),
        st.native?.gpuFailed ? el('div', { class: 'stems-gpu-off', 'data-stems': 'gpu-off' },
          el('span', { class: 'muted' }, `Graphics card not used for stems (${backendName(st.native.gpuFailed.backend) || st.native.gpuFailed.backend}): ${st.native.gpuFailed.message} — separating on the CPU instead. `),
          el('button', { class: 'btn sm', onclick: async () => {
            await fetch('/api/stems/gpu/retry', { method: 'POST', credentials: 'same-origin' });
            stems.webgpuVerdict(null); stems.gpuFailed = false; stems.gpuVerified = false; // this window's WebGPU too
            app.toast('The graphics card will be tried again for the next track'); refresh();
          } }, 'Try the graphics card again')) : null,
        st.native?.gpuFailed && stems.browserGpu ? el('div', { class: 'muted', 'data-stems': 'webgpu' }, `Tracks you ask for are separated in this window on the graphics card (WebGPU${stems.webgpuVerdict() === 'ok' ? ', checked against the CPU' : ', checked against the CPU on first use'}); the server's CPU keeps preparing the background tracks.`) : null,
        el('div', { class: 'muted' }, `Browser engine: ${st.ort ? `ONNX Runtime Web ${st.ortVersion || ''}` : 'missing from this app build — update or reinstall OpenDJ'} · ${globalThis.crossOriginIsolated ? 'multi-threaded' : 'single-threaded'} WASM, WebGPU ${'gpu' in navigator ? 'available' : 'not available'} · stems saved as ${st.format.toUpperCase()}`),
        el('div', { class: 'stems-settings-actions' },
          m.ready ? el('button', { class: 'btn sm', onclick: async () => { await fetch('/api/stems/model', { method: 'DELETE', credentials: 'same-origin' }); refresh(); } }, 'Delete model')
            : el('button', { class: 'btn sm', onclick: async () => { try { await stems.ensureModel(); } catch (e) { app.toast(`⚠ ${e.message}`); } refresh(); } }, 'Download model…')),
      );
    } catch (e) { info.textContent = `⚠ ${e.message}`; }
  };
  refresh();
  const where = el('select', { class: 'inp', onchange: () => { app.setSetting('stemsEngine', where.value); stems.status().then(refresh, () => {}); } },
    ...[['auto', 'Automatic: the OpenDJ server, or this window\'s graphics card when the server cannot use one'], ['server', 'Always the OpenDJ server'], ['browser', 'Always this browser']].map(([v, l]) => el('option', { value: v, selected: (app.settings.stemsEngine || 'auto') === v }, l)));
  const sel = el('select', { class: 'inp', onchange: () => app.setSetting('stemsBackend', sel.value) },
    ...[['auto', 'Automatic (GPU, else CPU)'], ['wasm', 'CPU only']].map(([v, l]) => el('option', { value: v, selected: (app.settings.stemsBackend || 'auto') === v }, l)));
  const auto = el('input', { type: 'checkbox', checked: app.settings.stemsAutoLoad !== false, onchange: () => app.setSetting('stemsAutoLoad', auto.checked) });
  const ahead = el('input', { type: 'checkbox', checked: app.settings.stemsAutoPrepare !== false, onchange: () => app.setSetting('stemsAutoPrepare', ahead.checked) });
  const kick = () => fetch('/api/stems/background', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json()).then((s) => { stems.serverState(s); bgRender(); }).catch(() => {});
  const bgBox = el('input', { type: 'checkbox', checked: app.settings.stemsBackground === true, onchange: async () => { await app.setSetting('stemsBackground', bgBox.checked); kick(); } });
  const cap = el('input', { class: 'inp', type: 'number', min: 1, max: 4000, step: 1, value: app.settings.stemsCacheGB || 40, style: 'width:6em', onchange: async () => { await app.setSetting('stemsCacheGB', Number(cap.value) || 40); kick(); } });
  const quality = el('select', { class: 'inp', onchange: () => app.setSetting('stemsOverlap', Number(quality.value)) },
    ...[['0.25', 'Best (overlap 25 %)'], ['0.1', 'Faster (about 15 % quicker, overlap 10 %)']].map(([v, l]) => el('option', { value: v, selected: Math.abs((Number(app.settings.stemsOverlap) || 0.25) - Number(v)) < 0.01 }, l)));
  const bgInfo = el('div', { class: 'muted' });
  const bgRender = () => {
    const b = stems.background;
    bgInfo.textContent = !b ? '' : !b.enabled ? 'Off: stems are prepared only for loaded tracks, the next Automix tracks and the ones you pick.'
      : `${b.remaining ? `${b.remaining} track(s) left` : 'Every track has stems'}${b.done ? ` · ${b.done} prepared this session` : ''}${b.failed ? ` · ${b.failed} skipped` : ''}${b.cacheBytes != null ? ` · cache ${MB(b.cacheBytes)} of ${MB(b.capBytes)}` : ''}${b.full ? ' (full: raise the limit or delete stems)' : ''}`;
  };
  stems.on('queue', bgRender); bgRender();
  return el('div', { class: 'stems-settings' }, info,
    el('label', { class: 'field' }, el('span', {}, 'Separate on'), where),
    el('label', { class: 'field' }, el('span', {}, 'Separation hardware'), sel),
    el('label', { class: 'field' }, el('span', {}, 'Quality'), quality),
    el('label', { class: 'check' }, auto, el('span', {}, 'Load prepared stems when a track is loaded')),
    el('label', { class: 'check' }, ahead, el('span', {}, 'Prepare stems ahead for Automix and loaded tracks (server engine)')),
    el('label', { class: 'check' }, bgBox, el('span', {}, 'Prepare stems for the whole library in the background, most played first (server engine; saved, done once per track)')),
    el('label', { class: 'field' }, el('span', {}, 'Stem cache limit (GB)'), cap),
    bgInfo);
}

export { stemsApi };
