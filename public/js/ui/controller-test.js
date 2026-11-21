// "Controller test": a live view of what a MIDI controller sends, for owners checking a bundled mapping on their own
// unit (we have no device to test with). Shows every incoming message decoded, which function it hits (or that it is
// unmapped), a checklist of the mapping's controls with seen / unverified marks, an LED check, and a recorder that
// saves a JSON capture to send back so a wrong mapping entry can be fixed.
import { el } from '../util.js';
import { describeKey, msgKey } from '../midi/midi.js';

const hex = (b) => b.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');

/** Decode raw MIDI bytes to the mapping key used by midi.js (null for clock / SysEx / other). */
export function decodeMidi(data) {
  const [status, d1 = 0, d2 = 0] = data, cmd = status & 0xf0, ch = status & 0x0f;
  if (cmd === 0x90 || cmd === 0x80) return { key: msgKey('note', ch, d1), value: cmd === 0x80 ? 0 : d2, off: cmd === 0x80 || d2 === 0 };
  if (cmd === 0xb0) return { key: msgKey('cc', ch, d1), value: d2, off: false };
  if (cmd === 0xe0) return { key: msgKey('pitch', ch, 0), value: (d2 << 7) | d1, off: false };
  return null;
}

/** A capture file (JSON) that the owner can send back: device, mapping and the timed raw messages. */
export function buildCapture({ device, mapping, events, startedAt, notes = '' }) {
  return {
    opendjCapture: 1, device, startedAt, notes,
    mapping: mapping ? { name: mapping.name, presetId: mapping.presetId || null, entries: mapping.entries?.length || 0 } : null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    events: events.map((e) => ({ t: Math.round(e.t * 10) / 10, data: e.data })),
  };
}

export function openControllerTest(app, device = null) {
  const midi = app.midi;
  if (!document.querySelector('link[href="css/skins.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'css/skins.css' }));
  document.querySelector('.overlay.ctltest-overlay')?.remove();
  const names = () => midi.inputs().map((i) => i.name);
  let dev = device && names().includes(device) ? device : names().find((n) => midi.mappings[n]?.entries?.length) || names()[0] || null;
  const seen = new Map(); // key -> last value
  const unmapped = new Map(); // key -> count
  let rec = null; // { startedAt, t0, events }
  const log = [];

  const devSel = el('select', { class: 'sel ctltest-dev', 'aria-label': 'Controller' });
  const renderDevSel = () => {
    const list = names();
    devSel.replaceChildren(...(list.length ? list : ['']).map((n) => el('option', { value: n }, n || 'No MIDI controller connected')));
    if (dev) devSel.value = dev;
  };
  devSel.addEventListener('change', () => { dev = devSel.value; seen.clear(); unmapped.clear(); log.length = 0; render(); });
  const status = el('div', { class: 'ctltest-status' });
  const logEl = el('div', { class: 'ctltest-log', role: 'log', 'aria-live': 'off' });
  const listEl = el('div', { class: 'ctltest-list' });
  const unmappedEl = el('div', { class: 'ctltest-unmapped' });
  const recBtn = el('button', { class: 'btn sm ctltest-rec', onclick: () => toggleRec() }, 'Record a capture');
  const ledBtn = el('button', { class: 'btn sm', onclick: () => flashLeds(), title: 'Lights every mapped button and pad for a second, then restores the LEDs' }, 'Flash all LEDs');
  const resetBtn = el('button', { class: 'btn sm', onclick: () => { seen.clear(); unmapped.clear(); log.length = 0; render(); } }, 'Reset checklist');

  const mapping = () => (dev ? midi.mappings[dev] : null);
  const targetLabel = (id) => midi.byId.get(id)?.label || id;
  const entriesFor = (key) => (mapping()?.entries || []).filter((e) => e.key === key || e.lsbKey === key);

  function onRaw(m) {
    if (m.device !== dev) return;
    if (rec) rec.events.push({ t: m.t - rec.t0, data: m.data });
    const dec = decodeMidi(m.data);
    let what = 'SysEx / system message';
    if (dec) {
      const hits = entriesFor(dec.key);
      if (hits.length) { seen.set(dec.key, dec.value); for (const h of hits) if (h.lsbKey === dec.key) seen.set(h.key, seen.get(h.key) ?? 0); }
      else unmapped.set(dec.key, (unmapped.get(dec.key) || 0) + 1);
      what = hits.length ? hits.map((h) => `${targetLabel(h.target)}${h.lsbKey === dec.key ? ' (fine)' : ''}${h.unverified ? ' · unverified' : ''}`).join(', ') : 'not mapped';
      what = `${describeKey(dec.key)} = ${dec.value} → ${what}`;
    }
    log.unshift({ bytes: hex(m.data), what, mapped: !!dec && entriesFor(dec.key).length > 0, rec: !!rec });
    if (log.length > 80) log.length = 80;
    scheduleRender();
  }
  let raf = 0;
  const scheduleRender = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };

  function render() {
    renderDevSel();
    const map = mapping();
    const entries = map?.entries || [];
    const uniq = [...new Map(entries.map((e) => [e.key, e])).values()];
    const seenN = uniq.filter((e) => seen.has(e.key)).length;
    const unv = uniq.filter((e) => e.unverified || e.interpreted), unvSeen = unv.filter((e) => seen.has(e.key)).length;
    status.textContent = !dev ? 'Connect your controller with USB: it shows up here.'
      : !entries.length ? `${dev}: no mapping yet. Messages are still shown below.`
      : `${map.name}: ${seenN} of ${uniq.length} mapped controls seen${unv.length ? ` · ${unv.length} with an inferred function (${unvSeen} seen)` : ''}${unmapped.size ? ` · ${unmapped.size} unmapped message${unmapped.size === 1 ? '' : 's'}` : ''}${rec ? ` · recording (${rec.events.length} messages)` : ''}`;
    logEl.replaceChildren(...log.map((l) => el('div', { class: `ctltest-row ${l.mapped ? 'ok' : 'miss'}` }, el('code', {}, l.bytes), el('span', {}, l.what))));
    if (!log.length) logEl.append(el('div', { class: 'ctltest-empty' }, 'Move a control on your controller…'));
    listEl.replaceChildren(...uniq.map((e) => el('div', { class: `ctltest-item ${seen.has(e.key) ? 'seen' : ''} ${e.unverified ? 'unv' : ''} ${e.interpreted ? 'inf' : ''}`, title: e.unverified ? 'Not yet confirmed: if this control does nothing, record a capture and send it to us' : e.interpreted ? 'Message from the manufacturer chart; the function is read from the silkscreen (tell us if it does something else)' : e.verified ? 'From the manufacturer chart' : '' },
      el('span', { class: 'ctltest-tick', 'aria-hidden': 'true' }, seen.has(e.key) ? '✓' : '·'),
      el('span', { class: 'ctltest-name' }, targetLabel(e.target)),
      el('code', {}, describeKey(e.key)),
      e.unverified ? el('span', { class: 'ctltest-badge' }, 'unverified') : e.interpreted ? el('span', { class: 'ctltest-badge inf' }, 'function inferred') : null)));
    unmappedEl.replaceChildren(...[...unmapped].map(([key, n]) => el('span', { class: 'chip' }, `${describeKey(key)} ×${n}`)));
    unmappedEl.hidden = !unmapped.size;
    recBtn.textContent = rec ? 'Stop and save capture' : 'Record a capture';
    recBtn.classList.toggle('active', !!rec);
  }

  function toggleRec() {
    if (!rec) { rec = { startedAt: new Date().toISOString(), t0: performance.now(), events: [] }; render(); return; }
    const cap = buildCapture({ device: dev, mapping: mapping(), events: rec.events, startedAt: rec.startedAt });
    rec = null;
    const blob = new Blob([JSON.stringify(cap, null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${String(dev || 'controller').replace(/[^\w.-]+/g, '_')}-capture.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    app.toast?.(`Capture saved (${cap.events.length} messages). Attach it to a GitHub issue "Controller mapping: ${dev}".`);
    render();
  }

  function flashLeds() {
    const outs = midi.outputs().filter((o) => midi.mappingForOutput(o) === mapping());
    if (!outs.length) { app.toast?.('This controller has no MIDI output port: it cannot show LEDs'); return; }
    const notes = (mapping()?.entries || []).filter((e) => e.key.startsWith('note:') && !e.noLed).map((e) => e.key.split(':').map((x, i) => (i ? +x : x)));
    for (const o of outs) for (const [, ch, n] of notes) try { o.send([0x90 | ch, n, 127]); } catch { /* */ }
    setTimeout(() => { midi.ledState.clear(); for (const o of outs) for (const [, ch, n] of notes) try { o.send([0x90 | ch, n, 0]); } catch { /* */ } midi.updateLeds(); }, 1000);
  }

  const offRaw = midi.on('raw', onRaw);
  const offDev = midi.on('devices', () => { if (!dev) dev = names()[0] || null; render(); });
  const body = el('div', { class: 'ctltest' },
    el('p', { class: 'hint' }, 'Press every button, turn every knob and move every fader once. Each control should turn green in the checklist. If one does nothing in OpenDJ or hits the wrong function, record a capture (press Record, work through the controls, press Stop) and attach the file to a GitHub issue so we can fix the mapping.'),
    el('div', { class: 'ctltest-bar' }, devSel, recBtn, ledBtn, resetBtn),
    status,
    el('div', { class: 'ctltest-cols' },
      el('section', {}, el('h3', {}, 'Incoming messages'), logEl),
      el('section', {}, el('h3', {}, 'Mapped controls'), listEl)),
    el('h3', {}, 'Messages without a mapping'), unmappedEl);
  render();
  const p = app.dialogs.modal('Controller test', body, [{ label: 'Close', value: null }], { wide: true, cls: 'ctltest-modal' });
  [...document.querySelectorAll('.overlay')].at(-1)?.classList.add('ctltest-overlay');
  p.then(() => { offRaw(); offDev(); if (raf) cancelAnimationFrame(raf); });
  return p;
}
