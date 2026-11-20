// "Export to CDJ USB" dialog: writes a rekordbox device library (export.pdb + analysis files) to a USB stick
// so Pioneer CDJ / XDJ players can browse the playlists and play with grids, cues, loops and waveforms.
import { el } from '../util.js';
import { api, toLogin } from '../api.js';

async function call(method, url, body) {
  const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { toLogin(); throw new Error('Login required'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const fmtBytes = (n) => (n == null ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Open the export dialog.
 * @param {object} app  the OpenDJ app (needs app.dialogs, app.library.playlists, app.toast)
 * @param {string[]} [playlistIds] preselected playlists
 */
export async function openCdjExport(app, playlistIds = []) {
  const pls = [...(app.library?.playlists || [])].sort((a, b) => `${a.folder || ''}/${a.name}`.localeCompare(`${b.folder || ''}/${b.name}`));
  const checks = pls.map((p) => {
    const c = el('input', { type: 'checkbox', checked: playlistIds.includes(p.id) });
    c.dataset.id = p.id;
    c.addEventListener('change', () => { invalidate(); });
    return el('label', { class: 'check' }, c, el('span', { class: 'cdj-pl-name' }, p.folder ? el('span', { class: 'cdj-pl-folder' }, `${p.folder} / `) : null, p.name), el('span', { class: 'cdj-pl-count' }, String(p.trackIds?.length ?? 0)));
  });
  const selected = () => checks.map((c) => c.querySelector('input')).filter((c) => c.checked).map((c) => c.dataset.id);
  const setAll = (v) => { for (const c of checks) c.querySelector('input').checked = v; invalidate(); };

  const target = el('input', { class: 'inp cdj-target', placeholder: 'USB stick (root folder)' });
  const drives = await api.drives().catch(() => []);
  const driveCards = drives.filter((d) => d.kind !== 'home').map((d) => el('button', { class: 'drive-card', type: 'button', onclick: () => { target.value = d.path; onTarget(); } }, el('div', { class: 'drive-icon' }, '⛁'), el('div', {}, d.name)));
  const existing = el('div', { class: 'cdj-existing hint' });
  const modeUpdate = el('input', { type: 'radio', name: 'cdj-mode', value: 'update', checked: true });
  const modeReplace = el('input', { type: 'radio', name: 'cdj-mode', value: 'replace' });
  const modeRow = el('div', { class: 'cdj-mode', hidden: true },
    el('label', { class: 'check' }, modeUpdate, ' Add to the existing export (keeps its tracks, playlists and history)'),
    el('label', { class: 'check' }, modeReplace, ' Replace it (new database; audio already on the stick is reused)'));
  const profile = el('select', { class: 'sel' },
    el('option', { value: 'nxs2' }, 'CDJ-3000 / CDJ-2000NXS2 / XDJ-XZ, RX2, RX3, 1000MK2'),
    el('option', { value: 'legacy' }, 'Older: CDJ-2000NXS / CDJ-2000 / CDJ-900NXS / XDJ-1000, RX (no FLAC/ALAC, ≤ 48 kHz)'));
  const opt = (label, checked, title) => { const c = el('input', { type: 'checkbox', checked }); return [c, el('label', { class: 'check', title }, c, ` ${label}`)]; };
  const [artwork, artworkRow] = opt('Album art', true, 'Needs FFmpeg to make the 80×80 / 240×240 JPEGs players show');
  const [phrases, phrasesRow] = opt('Phrase analysis (CDJ-3000 lighting / phrase display)', true);
  const [analyze, analyzeRow] = opt('Analyse tracks OpenDJ has not analysed yet (waveform, BPM; needs FFmpeg)', true);
  const [threeBand, threeBandRow] = opt('CDJ-3000 3-band waveforms (.2EX, experimental)', false, 'Format partly undocumented; leave off unless you want to try it');
  for (const c of [artwork, phrases, analyze, threeBand]) c.addEventListener('change', () => invalidate());
  profile.addEventListener('change', () => invalidate());
  modeUpdate.addEventListener('change', () => invalidate()); modeReplace.addEventListener('change', () => invalidate());

  const estimateBox = el('div', { class: 'cdj-estimate' });
  const progressBar = el('div', { class: 'cdj-bar-fill' });
  const progressText = el('div', { class: 'cdj-progress-text' });
  const progress = el('div', { class: 'cdj-progress', hidden: true }, el('div', { class: 'cdj-bar' }, progressBar), progressText);
  const resultBox = el('div', { class: 'cdj-result' });

  const form = el('div', { class: 'form cdj-form' },
    el('p', { class: 'hint' }, 'Writes a rekordbox device library (like rekordbox\'s Export mode) so Pioneer CDJ / XDJ players can browse your playlists and play tracks with beat grids, hot cues, memory cues, loops, colours and waveforms. Use a FAT32 or exFAT stick (HFS+ for Mac-formatted sticks on CDJ-3000).'),
    el('div', { class: 'cdj-head' }, el('h3', {}, 'Playlists'), el('span', {},
      el('button', { class: 'btn sm', type: 'button', onclick: () => setAll(true) }, 'All'), ' ',
      el('button', { class: 'btn sm', type: 'button', onclick: () => setAll(false) }, 'None'))),
    el('div', { class: 'check-list cdj-playlists' }, ...(checks.length ? checks : [el('span', { class: 'hint' }, 'No playlists yet: create one first.')])),
    el('h3', {}, 'USB stick'),
    driveCards.length ? el('div', { class: 'drive-grid' }, ...driveCards) : null,
    el('div', { class: 'row' }, target, el('button', { class: 'btn', type: 'button', onclick: async () => { const p = await app.dialogs.pickFolder('USB stick'); if (p) { target.value = p; onTarget(); } } }, 'Browse…')),
    existing, modeRow,
    el('h3', {}, 'Players'), profile,
    el('div', { class: 'cdj-options' }, artworkRow, phrasesRow, analyzeRow, threeBandRow),
    el('div', { class: 'row' }, el('button', { class: 'btn', type: 'button', onclick: () => estimate() }, 'Check size'), estimateBox),
    progress, resultBox);
  target.addEventListener('change', () => onTarget());

  function body() {
    return {
      targetDir: target.value.trim(), playlistIds: selected(), mode: modeReplace.checked ? 'replace' : 'update', profile: profile.value,
      artwork: artwork.checked, phrases: phrases.checked, analyzeMissing: analyze.checked, threeBand: threeBand.checked,
    };
  }
  function invalidate() { estimateBox.replaceChildren(); }

  async function onTarget() {
    invalidate(); existing.replaceChildren(); modeRow.hidden = true;
    if (!target.value.trim()) return;
    try {
      const r = await call('GET', `/api/cdj/inspect?targetDir=${encodeURIComponent(target.value.trim())}`);
      if (!r.exists) { existing.textContent = 'No rekordbox export on this stick yet: a new one will be created.'; return; }
      if (r.error) { existing.textContent = `There is an export.pdb on this stick, but it could not be read (${r.error}). It will be replaced.`; return; }
      existing.textContent = `This stick already has a ${r.byOpenDJ ? 'OpenDJ' : 'rekordbox'} export: ${plural(r.tracks, 'track')}, ${plural(r.playlists.length, 'playlist')}.`;
      modeRow.hidden = false;
    } catch (e) { existing.textContent = e.message; }
  }

  async function estimate() {
    const b = body();
    if (!b.playlistIds.length || !b.targetDir) { app.toast('Choose playlists and the USB stick'); return null; }
    estimateBox.replaceChildren(el('span', { class: 'hint' }, 'Checking…'));
    try {
      const r = await call('POST', '/api/cdj/estimate', b);
      const lines = [
        `${plural(r.tracks, 'track')}: ${r.copy} to copy, ${r.convert} to convert, ${r.reuse} already on the stick.`,
        `Needs about ${fmtBytes(r.bytesNeeded)}${r.freeBytes != null ? `, ${fmtBytes(r.freeBytes)} free` : ''}.`,
      ];
      estimateBox.replaceChildren(el('div', {}, ...lines.map((l) => el('div', {}, l))),
        ...(r.warnings || []).map((w) => el('div', { class: 'cdj-warn' }, w)),
        r.skipped?.length ? skippedList(r.skipped) : null);
      return r;
    } catch (e) { estimateBox.replaceChildren(el('div', { class: 'cdj-warn' }, e.message)); return null; }
  }

  const skippedList = (list) => el('details', { class: 'cdj-skipped' }, el('summary', {}, `${plural(list.length, 'track')} will be left out`),
    el('ul', {}, ...list.slice(0, 200).map((s) => el('li', {}, el('b', {}, s.title), ` — ${s.reason}`))));

  let es = null; let running = null; let pollTimer = null;
  const setBusy = (busy) => {
    for (const x of form.querySelectorAll('input, select, .cdj-form button')) x.disabled = busy;
    const ov = [...document.querySelectorAll('.overlay')].at(-1);
    const primary = ov?.querySelector('.modal-foot .btn.primary');
    if (primary) { primary.textContent = busy ? 'Cancel export' : 'Export'; primary.classList.toggle('danger', busy); }
  };
  const showProgress = (p) => {
    if (!p || (running && p.jobId && p.jobId !== running)) return;
    progress.hidden = false;
    const pct = p.total ? Math.round((100 * (p.done || 0)) / p.total) : 0;
    progressBar.style.width = `${p.phase === 'done' ? 100 : pct}%`;
    const what = { start: 'Starting…', tracks: 'Copying and analysing', convert: 'Converting', analyze: 'Analysing', database: 'Writing the rekordbox database…', done: 'Done', error: 'Failed', cancelled: 'Cancelled' }[p.phase] || p.phase;
    progressText.textContent = `${what}${p.total && !['database', 'done', 'error', 'cancelled'].includes(p.phase) ? ` ${p.done || 0}/${p.total}` : ''}${p.track ? ` · ${p.track}` : ''}`;
    if (p.phase === 'done') finish(p.result);
    if (p.phase === 'error' || p.phase === 'cancelled') finish(null, p.message || what);
  };
  function finish(result, error) {
    if (!running) return;
    running = null; clearInterval(pollTimer); setBusy(false);
    if (error) { resultBox.replaceChildren(el('div', { class: 'cdj-warn' }, error)); return; }
    const r = result || {};
    resultBox.replaceChildren(
      el('div', { class: 'cdj-ok' }, `Exported ${plural(r.exported?.length || 0, 'playlist')} (${plural(r.written || 0, 'track')}; ${r.copied || 0} copied, ${r.converted || 0} converted). The stick now holds ${plural(r.totalTracksOnDevice || 0, 'track')}.`),
      el('div', { class: 'hint' }, 'Eject the stick safely before unplugging it.'),
      ...(r.warnings || []).map((w) => el('div', { class: 'cdj-warn' }, w)),
      r.skipped?.length ? skippedList(r.skipped) : null);
    app.toast?.('CDJ export finished');
  }

  async function start() {
    if (running) { await call('POST', '/api/cdj/cancel').catch(() => {}); return; }
    const b = body();
    if (!b.playlistIds.length || !b.targetDir) { app.toast('Choose playlists and the USB stick'); return; }
    resultBox.replaceChildren();
    try {
      es ||= api.events({ 'cdj-export': showProgress });
      const r = await call('POST', '/api/cdj/export', b);
      running = r.jobId; setBusy(true); showProgress({ phase: 'start', jobId: r.jobId });
      // fallback when the event stream is unavailable (proxies, hosted mode)
      pollTimer = setInterval(async () => {
        try {
          const s = await call('GET', '/api/cdj/status');
          if (s.running?.jobId === running) showProgress({ ...s.running.progress, jobId: running });
          else if (s.last?.id === running) s.last.error ? finish(null, s.last.error) : finish(s.last.result);
        } catch { /* keep trying */ }
      }, 1500);
    } catch (e) { resultBox.replaceChildren(el('div', { class: 'cdj-warn' }, e.message)); }
  }

  if (target.value) onTarget();
  await app.dialogs.modal('Export to CDJ USB (rekordbox)', form, [
    { label: 'Close', value: null },
    { label: 'Export', primary: true, action: async () => { await start(); return false; } },
  ], { wide: true });
  clearInterval(pollTimer);
  es?.close();
  if (running) app.toast?.('The CDJ export keeps running in the background');
}
