// Settings → Controllers: every connected controller (MIDI, HID, gamepad), its mapping, MIDI learn, Mixxx mapping
// search/import, guided setup, MIDI clock output.
import { el } from '../util.js';
import { icon } from './icons.js';
import { describeKey } from '../midi/midi.js';
import { PRESETS } from '../midi/presets.js';
import { listMixxxMappings, matchMappings, downloadMixxxMapping } from '../midi/mixxx-online.js';
import { wizardSteps, detectMidiControl, entryFor } from '../midi/wizard.js';
import { ctlState, setDeckLayer } from '../midi/controller-extras.js';

/** replaceChildren that skips null/false (optional sections). */
const put = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const KIND_LABEL = { midi: 'MIDI', 'midi-out': 'MIDI out', hid: 'HID', gamepad: 'Gamepad' };

export function controllersPanel(app) {
  const midi = app.midi;
  const root = el('div', { class: 'form ctl-panel' });
  let selected = null;
  let view = 'map'; // 'map' | 'wizard'
  let search = null; // { status, error, results, query, busy }
  let wizard = null;
  const offs = [];
  let overlay = null, timer = null;

  const toast = (m) => app.toast(m);
  const devices = () => midi.devices();
  const current = () => devices().find((d) => d.key === selected) || null;
  const mapOf = (key) => midi.mappings[key] || null;

  // ---------- lifecycle: listeners live while the panel (or the dialog holding it) is open ----------
  const on = (ev, fn) => offs.push(midi.on(ev, (...a) => { if (root.isConnected) fn(...a); }));
  const cleanup = () => {
    offs.splice(0).forEach((f) => f()); clearInterval(timer);
    if (wizard) stopWizard(false);
    if (midi.learning) midi.cancelLearn();
  };
  timer = setInterval(() => {
    if (root.isConnected) { overlay = overlay || root.closest('.overlay'); tick(); return; }
    if (overlay ? !overlay.isConnected : root._wasConnected) cleanup();
  }, 200);

  // ---------- device list ----------
  const devList = el('div', { class: 'ctl-devices' });
  const detail = el('div', { class: 'ctl-detail' });

  function deviceSummary(d) {
    const m = mapOf(d.key);
    if (d.kind === 'midi-out') return 'Output only (MIDI clock / LEDs)';
    if (!m?.entries?.length) return 'Not mapped yet';
    const info = m.importInfo?.stats;
    return `${m.name}${m.source === 'mixxx' ? ' (Mixxx)' : ''} · ${m.entries.length} control${m.entries.length === 1 ? '' : 's'}${info?.unmapped ? ` · ${info.unmapped} unmapped` : ''}`;
  }
  function renderDevices() {
    const list = devices();
    if (!selected || !list.some((d) => d.key === selected)) selected = (list.find((d) => d.kind !== 'midi-out') || list[0])?.key || null;
    const cards = list.map((d) => el('button', {
      class: `ctl-card ${d.key === selected ? 'active' : ''} ${mapOf(d.key)?.entries?.length ? 'mapped' : ''}`, 'data-key': d.key,
      onclick: () => { if (wizard) return; selected = d.key; search = null; renderDevices(); renderDetail(); },
    },
    el('span', { class: `ctl-badge k-${d.kind}` }, KIND_LABEL[d.kind] || d.kind),
    el('span', { class: 'ctl-card-main' }, el('span', { class: 'ctl-card-name' }, d.name), el('span', { class: 'ctl-card-sub' }, deviceSummary(d))),
    el('span', { class: 'ctl-act', title: 'Activity' })));
    const hidBtn = midi.hid.supported ? el('button', { class: 'ctl-card ctl-add', onclick: connectHid },
      el('span', { class: 'ctl-badge k-hid' }, '+'), el('span', { class: 'ctl-card-main' }, el('span', { class: 'ctl-card-name' }, 'Connect HID device…'), el('span', { class: 'ctl-card-sub' }, 'Controllers that are not class-compliant MIDI'))) : null;
    put(devList, ...cards, hidBtn,
      list.length ? null : el('p', { class: 'hint ctl-empty' }, midi.unsupported ? 'Web MIDI is not available in this browser: use the OpenDJ desktop app, Chrome or Edge for MIDI controllers.' : midi.error ? `MIDI unavailable: ${midi.error}` : 'No controller detected. Plug in a MIDI controller, connect a HID device, or press a button on a gamepad.'));
  }
  async function connectHid() {
    try { const key = await midi.hid.request(); if (key) { selected = key; renderDevices(); renderDetail(); } } catch (e) { if (e.name !== 'NotFoundError') toast(e.message); }
  }
  function tick() {
    root._wasConnected = true;
    const now = performance.now();
    for (const c of devList.querySelectorAll('.ctl-card[data-key]')) c.classList.toggle('busy', now - (midi.deviceActivity.get(c.dataset.key) || -1e9) < 140);
  }

  // DECK SELECT: which decks the two sides of a 2-deck controller drive in 4-deck mode (also MIDI-learnable:
  // "Deck select: left / right")
  function deckLayers() {
    const st = ctlState(app);
    const side = (i, label) => el('span', { class: 'seg ctl-layer' }, label, ...[i, i + 2].map((d) => el('button', {
      class: `seg-btn ${st.layer[i] === d ? 'active' : ''}`, 'aria-pressed': String(st.layer[i] === d),
      onclick: () => { setDeckLayer(app, i, d); renderDetail(); },
    }, `Deck ${d + 1}`)));
    return el('div', { class: 'row ctl-layers', title: 'A 2-deck controller drives decks 1 and 2; switch a side to deck 3 or 4 here or with a mapped "Deck select" button' }, side(0, 'Left side '), side(1, 'Right side '));
  }

  // ---------- selected device ----------
  const monitor = el('div', { class: 'midi-monitor' }, 'Move a control on your controller…');
  const filterIn = el('input', { class: 'inp', type: 'search', placeholder: 'Filter functions…' });
  const mappedOnly = el('input', { type: 'checkbox' });
  const table = el('div', { class: 'midi-table ctl-table' });
  filterIn.addEventListener('input', () => renderTable());
  mappedOnly.addEventListener('change', () => renderTable());

  function renderTable() {
    const d = current();
    const dev = d && d.kind !== 'midi-out' ? d.key : null;
    const map = dev ? mapOf(dev) : null;
    const q = filterIn.value.trim().toLowerCase();
    const rows = midi.targets.filter((t) => (!q || t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)) && (!mappedOnly.checked || map?.entries.some((e) => e.target === t.id))); // all targets (a 500 cap hid the mixer + crossfader)
    put(table, ...rows.map((t) => {
      const entries = map?.entries.filter((e) => e.target === t.id) || [];
      const learning = midi.learning?.targetId === t.id && midi.learning?.deviceName === dev;
      const desc = entries.map((e) => describeKey(e.key) + (e.lsbKey ? ' (14-bit)' : '') + (e.rel && t.kind !== 'rel' ? ' (endless)' : '') + (e.invert ? ' ⇅' : '')).join(', ');
      return el('div', { class: `midi-row ${learning ? 'learning' : ''} ${entries.length ? 'is-mapped' : ''}` },
        el('span', { class: 'mr-label' }, t.label), el('span', { class: 'mr-kind' }, t.kind),
        el('span', { class: 'mr-map', title: desc }, desc || '—'),
        el('button', { class: 'btn xs', disabled: !dev, onclick: () => { learning ? midi.cancelLearn() : midi.learn(dev, t.id); renderTable(); } }, learning ? 'Listening…' : 'Learn'),
        entries.length ? el('button', { class: 'btn xs', title: 'Invert', onclick: () => { for (const e of entries) e.invert = !e.invert; midi.save(); renderTable(); } }, '⇅') : el('span'),
        entries.length ? el('button', { class: 'btn xs', title: 'Clear', onclick: () => { map.entries = map.entries.filter((e) => e.target !== t.id); midi.save(); renderTable(); renderDevices(); } }, icon('x')) : el('span'));
    }));
  }

  function importSummary(map) {
    const info = map?.importInfo;
    if (!info?.stats) return null;
    const s = info.stats;
    const parts = [`${s.mapped} control${s.mapped === 1 ? '' : 's'} mapped`];
    if (s.scriptedMapped) parts.push(`${s.scriptedMapped} of ${s.scripted} scripted functions matched by name`);
    if (s.outputs) parts.push(`${s.outputsMapped} LED${s.outputsMapped === 1 ? '' : 's'}`);
    return el('div', { class: 'ctl-summary' },
      el('div', {}, el('b', {}, map.name), info.author ? ` by ${info.author}` : '', map.source === 'mixxx' ? ' · from the Mixxx community library (GPL)' : ''),
      el('div', { class: 'ctl-summary-stats' }, parts.join(' · '), s.unmapped ? el('span', { class: 'ctl-warn' }, ` · ${s.unmapped} not mapped`) : null),
      s.unmapped ? el('details', {}, el('summary', {}, 'Show unmapped controls'), el('ul', { class: 'ctl-unmapped' }, ...(info.unmapped || []).map((u) => el('li', {}, u)))) : null,
      s.scripted ? el('p', { class: 'hint' }, 'Mixxx runs scripts for some controls (usually jog wheels and pads); OpenDJ guesses those from their names. If something feels wrong, fix it with Learn below.') : null);
  }

  function renderSearch() {
    if (!search) return null;
    const qIn = el('input', { class: 'inp', value: search.query, placeholder: 'Controller name, e.g. DDJ-400' });
    const go = () => runSearch(qIn.value);
    qIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    return el('div', { class: 'ctl-search' },
      el('div', { class: 'row' }, qIn, el('button', { class: 'btn', onclick: go, disabled: search.busy }, 'Search'), el('button', { class: 'btn', onclick: () => { search = null; renderDetail(); } }, 'Close')),
      search.status ? el('p', { class: `hint ${search.error ? 'ctl-err' : ''}` }, search.status) : null,
      search.results?.length ? el('div', { class: 'ctl-results' }, ...search.results.map((r) => el('div', { class: 'ctl-result' },
        el('span', { class: 'ctl-result-name' }, r.name), el('span', { class: 'ctl-result-file' }, r.file),
        el('button', { class: 'btn sm primary', disabled: search.busy, onclick: () => useMixxx(r.file) }, 'Use this mapping')))) : null,
      el('p', { class: 'hint' }, 'Mappings come from the Mixxx project (github.com/mixxxdj/mixxx, GPL) and are downloaded only when you choose one.'));
  }
  async function runSearch(query) {
    search = { ...(search || {}), query, busy: true, status: 'Looking up the Mixxx controller library…', error: false, results: [] };
    renderDetail();
    try {
      const items = await listMixxxMappings();
      let results = matchMappings(query, items);
      if (!results.length && query.trim()) { const q = query.trim().toLowerCase(); results = items.filter((i) => i.file.toLowerCase().includes(q)).slice(0, 8); }
      search = { ...search, busy: false, results, status: results.length ? `${results.length} possible match${results.length === 1 ? '' : 'es'} out of ${items.length} Mixxx mappings:` : `No Mixxx mapping matched "${query}". Try a shorter name (just the model), or use Guided setup.` };
    } catch (e) { search = { ...search, busy: false, error: true, status: e.message }; }
    renderDetail();
  }
  async function useMixxx(file) {
    const dev = selected;
    search = { ...search, busy: true, status: `Downloading ${file}…`, error: false };
    renderDetail();
    try {
      const xml = await downloadMixxxMapping(file);
      const m = midi.applyMixxx(dev, xml, file);
      toast(`Applied "${m.name}": ${m.importInfo.stats.mapped} controls mapped${m.importInfo.stats.unmapped ? `, ${m.importInfo.stats.unmapped} not mapped` : ''}`);
      search = null;
    } catch (e) { search = { ...search, busy: false, error: true, status: e.message }; }
    renderDevices(); renderDetail();
  }

  const fileIn = el('input', { type: 'file', accept: '.xml,.json,application/json,text/xml', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; fileIn.value = '';
    if (!f || !selected) return;
    try {
      const m = midi.importMapping(selected, await f.text(), f.name);
      const s = m.importInfo?.stats;
      toast(s ? `Imported "${m.name}": ${s.mapped} controls mapped, ${s.unmapped} not mapped` : `Imported "${m.name}" (${m.entries.length} controls)`);
    } catch (e) { toast(`Import failed: ${e.message}`); }
    renderDevices(); renderDetail();
  });

  const headSub = el('span', { class: 'ctl-head-sub' });
  const headText = (d) => { const m = mapOf(d.key); return `${KIND_LABEL[d.kind]}${d.hasOut && d.kind === 'midi' ? ' in + out (LEDs)' : ''} · ${m?.entries?.length ? `mapping "${m.name}" (${m.entries.length})` : 'no mapping yet'}`; };
  function renderDetail() {
    if (view === 'wizard') return renderWizard();
    const d = current();
    if (!d) { put(detail, ); return; }
    const map = mapOf(d.key);
    const isMidi = d.kind === 'midi';
    headSub.textContent = headText(d);
    const presetSel = el('select', { class: 'sel' }, el('option', { value: '' }, 'Built-in presets…'), ...PRESETS.map((p) => el('option', { value: p.name }, p.name)));
    presetSel.addEventListener('change', () => { if (presetSel.value) { midi.applyPreset(d.key, presetSel.value); toast(`Applied preset "${presetSel.value}"`); renderDevices(); renderDetail(); } });
    const actions = d.kind === 'midi-out' ? [] : [
      el('button', { class: 'btn primary', onclick: () => startWizard() }, 'Guided setup'),
      isMidi ? el('button', { class: 'btn', onclick: () => { search = { query: d.name }; runSearch(d.name); } }, 'Find Mixxx mapping') : null,
      isMidi ? el('button', { class: 'btn', title: 'Check or fix every control, see if the community has a mapping for this controller, and share yours', onclick: () => midi.openMapper(d.key) }, 'Controller Mapper') : null,
      el('button', { class: 'btn', onclick: () => fileIn.click() }, isMidi ? 'Import mapping file…' : 'Import…'),
      el('button', { class: 'btn', disabled: !map?.entries?.length, onclick: () => { const blob = new Blob([midi.exportMapping(d.key)], { type: 'application/json' }); const a = el('a', { href: URL.createObjectURL(blob), download: `${d.name.replace(/[^\w.-]+/g, '_')}.opendj-midi.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); } }, 'Export'),
      isMidi ? presetSel : null,
      isMidi ? el('button', { class: 'btn ctl-test-btn', onclick: () => import('./controller-test.js').then((m) => m.openControllerTest(app, d.key)), title: 'See every message the controller sends, which are mapped, and record a capture to send back' }, 'Controller test') : null,
      el('button', { class: 'btn danger', disabled: !map?.entries?.length, onclick: async () => { if (await (app.dialogs?.confirm?.(`Remove the mapping for ${d.name}?`) ?? true)) { midi.clearMapping(d.key); renderDevices(); renderDetail(); } } }, 'Clear'),
      d.kind === 'hid' ? el('button', { class: 'btn', onclick: async () => { await midi.hid.disconnect(d.key); selected = null; renderDevices(); renderDetail(); } }, 'Disconnect') : null,
    ];
    put(detail, 
      el('div', { class: 'ctl-head' }, el('h3', {}, d.name), headSub),
      actions.length ? el('div', { class: 'row ctl-actions' }, ...actions, fileIn) : null,
      isMidi && app.deckCount === 4 ? deckLayers() : null,
      renderSearch(),
      importSummary(map),
      isMidi ? el('p', { class: 'hint' }, 'Something not working right? Open the Controller Mapper to test each control, fix it, apply the fix here and send it to the OpenDJ community collection so it works for everyone.') : null,
      d.kind === 'midi-out' ? el('p', { class: 'hint' }, 'This port only receives. Choose it below to send MIDI clock, or connect the matching input to map its controls.') : null,
      d.kind === 'hid' ? el('p', { class: 'hint' }, 'HID: click Learn and move one control at a time. Buttons, faders, knobs and jog wheels are detected from the raw reports. LED feedback is not available for HID devices.') : null,
      d.kind === 'gamepad' ? el('p', { class: 'hint' }, 'Gamepad: map buttons to buttons, sticks or triggers to faders (absolute) or to the jog / browser (they move while you hold the stick over).') : null,
      d.kind === 'midi-out' ? null : monitor,
      d.kind === 'midi-out' ? null : el('div', { class: 'row ctl-filter' }, filterIn, el('label', { class: 'check' }, mappedOnly, ' Mapped only')),
      d.kind === 'midi-out' ? null : table);
    renderTable();
  }

  // ---------- guided setup ----------
  function startWizard() {
    const d = current(); if (!d) return;
    midi.cancelLearn();
    const steps = wizardSteps(Math.min(app.deckCount || 2, 4));
    wizard = { dev: d.key, kind: d.kind, steps, i: 0, assigned: new Map(), msgs: [], result: null, done: 0 };
    view = 'wizard';
    if (d.kind === 'midi') midi.suppress = d.key;
    midi.quietLearn = true;
    renderDevices();
    beginStep();
  }
  function stopWizard(save = true) {
    if (!wizard) return;
    clearTimeout(wizard.timer); clearTimeout(wizard.advance);
    if (midi.suppress === wizard.dev) midi.suppress = null;
    midi.quietLearn = false;
    if (midi.learning) midi.cancelLearn();
    const n = wizard.done;
    wizard = null; view = 'map';
    if (save) { midi.save(); if (n) toast(`Guided setup: ${n} control${n === 1 ? '' : 's'} mapped`); }
    if (root.isConnected) { renderDevices(); renderDetail(); }
  }
  function beginStep() {
    const w = wizard; if (!w) return;
    clearTimeout(w.timer); clearTimeout(w.advance);
    w.msgs = []; w.result = null; w.capturing = false;
    if (w.i >= w.steps.length) return stopWizard(true);
    if (w.kind !== 'midi') midi.learn(w.dev, w.steps[w.i].target); // HID & gamepads learn through their managers
    renderWizard();
  }
  function go(delta) { const w = wizard; if (!w) return; if (midi.learning) midi.cancelLearn(); w.i = Math.max(0, Math.min(w.steps.length, w.i + delta)); beginStep(); }
  function skipSection() {
    const w = wizard; if (!w) return;
    const sec = w.steps[w.i]?.section;
    let j = w.i; while (j < w.steps.length && w.steps[j].section === sec) j++;
    if (midi.learning) midi.cancelLearn();
    w.i = j; beginStep();
  }
  function assign(entry) {
    const w = wizard;
    const map = midi.mappingFor(w.dev);
    map.entries = map.entries.filter((e) => e.target !== entry.target && e.key !== entry.key);
    map.entries.push(entry);
    if (!w.assigned.has(w.i)) w.done++;
    w.assigned.set(w.i, entry);
    midi.save();
    w.result = entry;
    renderWizard();
    w.advance = setTimeout(() => { if (wizard === w) { w.i++; beginStep(); } }, 700);
  }
  function onWizardMessage(m) {
    const w = wizard;
    if (!w || w.kind !== 'midi' || m.device !== w.dev || w.result) return;
    const step = w.steps[w.i]; if (!step) return;
    const exclude = new Set([...w.assigned].filter(([i]) => i !== w.i).flatMap(([, e]) => [e.key, e.lsbKey].filter(Boolean)));
    if (exclude.has(m.key)) return;
    if (!w.capturing && m.isOff) return; // note-off of the previous step's button
    w.msgs.push(m);
    const now = m.t || performance.now();
    if (!w.capturing) { w.capturing = true; w.start = now; renderWizard(); }
    clearTimeout(w.timer);
    const finish = () => {
      if (wizard !== w || w.result) return;
      const det = detectMidiControl(w.msgs, { kind: step.kind, exclude });
      if (!det) { w.capturing = false; w.msgs = []; renderWizard(); return; }
      assign(entryFor(det, step));
    };
    if (step.kind === 'button') w.timer = setTimeout(finish, 220);
    else if (now - w.start > 1600) finish();
    else w.timer = setTimeout(finish, 650);
  }
  function renderWizard() {
    const w = wizard; if (!w) return;
    const step = w.steps[w.i];
    if (!step) return;
    const pct = Math.round((w.i / w.steps.length) * 100);
    const resultText = w.result ? `✓ ${describeKey(w.result.key)}${w.result.lsbKey ? ' (14-bit)' : ''}${w.result.rel ? ` · relative (${w.result.rel})` : ''}` : w.capturing ? 'Got it… keep moving, or let go' : 'Waiting for your controller…';
    const prev = w.assigned.get(w.i);
    put(detail, el('div', { class: 'ctl-wizard' },
      el('div', { class: 'ctl-wz-top' }, el('span', { class: 'ctl-wz-sec' }, step.section), el('span', { class: 'ctl-wz-count' }, `Step ${w.i + 1} of ${w.steps.length}`)),
      el('div', { class: 'ctl-wz-bar' }, el('div', { style: { width: `${pct}%` } })),
      el('div', { class: 'ctl-wz-kind' }, step.kind === 'button' ? 'BUTTON' : step.kind === 'rel' ? 'ENCODER / JOG' : 'FADER / KNOB'),
      el('h2', { class: 'ctl-wz-title' }, step.title),
      el('p', { class: 'ctl-wz-hint' }, step.hint),
      el('div', { class: `ctl-wz-detect ${w.result ? 'ok' : w.capturing ? 'busy' : ''}` }, resultText),
      prev && !w.result ? el('p', { class: 'hint' }, `Currently: ${describeKey(prev.key)}. Move the control again to replace it.`) : null,
      el('div', { class: 'row ctl-wz-nav' },
        el('button', { class: 'btn', disabled: w.i === 0, onclick: () => go(-1) }, '◀ Back'),
        el('button', { class: 'btn', onclick: () => go(1) }, 'Skip'),
        el('button', { class: 'btn', onclick: skipSection }, `Skip rest of ${step.section}`),
        el('span', { class: 'ctl-spacer' }),
        el('button', { class: 'btn', onclick: () => stopWizard(false) }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: () => stopWizard(true) }, 'Finish'))));
  }
  on('learning', (l) => {
    // HID / gamepad wizard steps complete through the managers' learn
    const w = wizard;
    if (w && w.kind !== 'midi' && !l && !w.result) {
      const step = w.steps[w.i];
      const e = midi.mappings[w.dev]?.entries.find((x) => x.target === step?.target);
      if (e) { if (!w.assigned.has(w.i)) w.done++; w.assigned.set(w.i, e); w.result = e; renderWizard(); w.advance = setTimeout(() => { if (wizard === w) { w.i++; beginStep(); } }, 700); }
      return;
    }
    if (!wizard) renderTable();
  });

  // ---------- footer: MIDI clock, gamepads ----------
  const clockSel = el('select', { class: 'sel' });
  const fillClock = () => {
    const names = midi.outputs().map((o) => o.name);
    const cur = app.settings.midiClockOutput || '';
    put(clockSel, el('option', { value: '' }, 'Off'), ...[...new Set([...names, cur].filter(Boolean))].map((n) => el('option', { value: n }, names.includes(n) ? n : `${n} (not connected)`)));
    clockSel.value = cur;
  };
  clockSel.addEventListener('change', () => { midi.setClockOutput(clockSel.value); app.setSetting('midiClockOutput', clockSel.value); });
  fillClock();

  on('message', (m) => { if (!wizard && m.device === selected) monitor.textContent = `${describeKey(m.key)} = ${m.value}${m.isOff ? ' (off)' : ''}`; onWizardMessage(m); });
  on('devices', () => { renderDevices(); if (!wizard) renderDetail(); fillClock(); });
  on('mappings', () => { if (wizard) return; renderDevices(); const d = current(); if (d) headSub.textContent = headText(d); });
  if (midi.hid) offs.push(midi.hid.on('report', (r) => { if (root.isConnected && !wizard && r.key === selected) monitor.textContent = `HID report ${r.reportId}: ${[...r.bytes.slice(0, 24)].map((b) => b.toString(16).padStart(2, '0')).join(' ')}${r.bytes.length > 24 ? ' …' : ''}`; }));

  renderDevices();
  // opened from the "new controller" offer: jump straight to search or guided setup
  const pending = midi.pendingAction;
  if (pending && devices().some((d) => d.key === pending.device)) {
    midi.pendingAction = null; selected = pending.device; renderDevices();
    if (pending.mode === 'wizard') startWizard(); else { search = { query: pending.device }; runSearch(pending.device); }
  } else renderDetail();

  root.append(
    el('p', { class: 'hint' }, 'Any MIDI DJ controller works: find its community mapping, run the guided setup, or click Learn next to a function and move the control. HID controllers and gamepads can be learned too.'),
    devList, detail,
    el('div', { class: 'ctl-footer' },
      el('label', { class: 'field' }, el('span', {}, 'Send MIDI clock (follows the master deck tempo) to'), clockSel),
      el('p', { class: 'hint' }, midi.gamepads.supported ? 'Gamepads show up here after you press one of their buttons.' : '')));
  root.destroy = cleanup;
  return root;
}
