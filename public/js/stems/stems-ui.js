// AI stems UI: deck stem controls, library menu items, model consent dialog, preparation progress panel,
// settings pane. Wiring (done by the app): setupStems(app) once after the layout exists,
// buildStemControls(app, deck) inside each deck, stemsMenuItems(app, tracks) in the track context menu.
import { el } from '../util.js';
import { icon } from '../ui/icons.js';
import { button, knob } from '../ui/controls.js';
import { StemsManager, stemsApi } from './stems.js';

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
    panel.hidden = !c && !modelMsg;
    if (modelMsg) { label.textContent = modelMsg.text; bar.style.width = `${modelMsg.pct}%`; queued.textContent = ''; return; }
    if (!c) return;
    const p = c.phase === 'separating' ? pct(c) : c.phase === 'loading model' && c.total ? pct(c) : null;
    const eta = c.phase === 'separating' && c.done > 0 ? Math.round(((performance.now() - c.started) / c.done) * (c.total - c.done) / 1000) : null;
    label.textContent = `Stems: ${c.title} — ${c.phase}${p != null ? ` ${p}%` : '…'}${eta != null ? ` (~${eta >= 90 ? `${Math.round(eta / 60)} min` : `${eta} s`} left)` : ''}`;
    bar.style.width = `${p ?? 0}%`;
    bar.classList.toggle('indeterminate', p == null);
    queued.textContent = stems.queue.length ? `${stems.queue.length} more queued` : '';
  };
  stems.on('progress', render); stems.on('queue', render);
  stems.on('model', (m) => {
    modelMsg = m.downloading ? { text: `Downloading the stems model… ${MB(m.received)}${m.total ? ` of ${MB(m.total)}` : ''}`, pct: m.total ? Math.floor((m.received / m.total) * 100) : 0 } : null;
    if (m.error) app.toast(`⚠ Stems model: ${m.error}`);
    render();
  });
  stems.on('finished', (r) => app.toast(`Stems ready: ${r.title}${r.ms ? ` (${(r.ms / 1000).toFixed(0)} s, ${r.backend}${r.threads > 1 ? ` ×${r.threads}` : ''})` : ''}`));
  stems.on('failed', (r) => app.toast(`⚠ Stems for "${r.title}" failed: ${r.message}`));
  stems.on('cancelled', () => app.toast('Stem preparation cancelled'));
  render();
  return stems;
}

/** One-time consent before the model download (size, source, licence). Resolves true to download. */
export async function consentDialog(app, m) {
  let host = ''; try { host = new URL(m.url).host; } catch { /* custom */ }
  const body = el('div', { class: 'stems-consent' },
    el('p', {}, 'AI stems split a track into vocals, drums, bass and melody so you can mute or solo each part on the deck. The separation runs on this computer (in the browser engine, using the GPU when available); your music is not uploaded anywhere.'),
    el('p', {}, 'The first time, OpenDJ needs to download the separation model once:'),
    el('dl', {},
      el('dt', {}, 'Model'), el('dd', {}, m.name),
      el('dt', {}, 'Download'), el('dd', {}, `${MB(m.downloadBytes || m.bytes)}${m.bytes && m.downloadBytes ? ` (${MB(m.bytes)} on disk)` : ''}`),
      el('dt', {}, 'From'), el('dd', {}, host || m.url),
      el('dt', {}, 'Licence'), el('dd', {}, m.licence),
      m.custom && !m.sha256 ? [el('dt', {}, 'Check'), el('dd', {}, 'No SHA-256 configured for this custom model: its integrity cannot be verified.')] : null),
    el('p', { class: 'muted' }, 'Preparing stems takes about as long as the track on a recent laptop with WebGPU, several times longer on CPU only. Stems are saved, so each track is prepared once.'));
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

/** "Prepare stems for playlist": queue every track of a playlist (ids in playlist order). */
export function prepareStemsForTracks(app, ids) { return stemsMenuItems(app, ids.map((id) => app.library.track(id)))[0]?.action(); }

/** Settings pane content (model status, download/delete, backend, auto-load). */
export function stemsSettingsPane(app) {
  const stems = setupStems(app);
  const info = el('div', { class: 'stems-settings-info' }, 'Checking…');
  const refresh = async () => {
    try {
      const st = await stems.status(), m = st.model;
      info.replaceChildren(
        el('div', {}, `Model: ${m.name} — ${m.ready ? `downloaded (${MB(m.bytes)}${m.verified ? ', SHA-256 verified' : ''})` : m.downloading ? 'downloading…' : `not downloaded (${MB(m.downloadBytes || m.bytes)})`}`),
        el('div', { class: 'muted' }, `Runtime: ${st.ort ? `ONNX Runtime Web ${st.ortVersion || ''}` : 'AI stems engine is missing from this app build — update or reinstall OpenDJ'} · stems saved as ${st.format.toUpperCase()} · ${globalThis.crossOriginIsolated ? 'multi-threaded' : 'single-threaded'} WASM, WebGPU ${'gpu' in navigator ? 'available' : 'not available'}`),
        el('div', { class: 'stems-settings-actions' },
          m.ready ? el('button', { class: 'btn sm', onclick: async () => { await fetch('/api/stems/model', { method: 'DELETE', credentials: 'same-origin' }); refresh(); } }, 'Delete model')
            : el('button', { class: 'btn sm', onclick: async () => { try { await stems.ensureModel(); } catch (e) { app.toast(`⚠ ${e.message}`); } refresh(); } }, 'Download model…')),
      );
    } catch (e) { info.textContent = `⚠ ${e.message}`; }
  };
  refresh();
  const sel = el('select', { class: 'inp', onchange: () => app.setSetting('stemsBackend', sel.value) },
    ...[['auto', 'Automatic (WebGPU, else CPU)'], ['wasm', 'CPU only (WASM)']].map(([v, l]) => el('option', { value: v, selected: (app.settings.stemsBackend || 'auto') === v }, l)));
  const auto = el('input', { type: 'checkbox', checked: app.settings.stemsAutoLoad !== false, onchange: () => app.setSetting('stemsAutoLoad', auto.checked) });
  return el('div', { class: 'stems-settings' }, info,
    el('label', { class: 'field' }, el('span', {}, 'Separation engine'), sel),
    el('label', { class: 'field check' }, auto, el('span', {}, 'Load prepared stems when a track is loaded')));
}

export { stemsApi };
