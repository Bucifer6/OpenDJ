// DVS UI: topbar button, per-deck ABS/REL/INT indicator and the setup / calibration panel.
import { icon } from '../ui/icons.js';
import { el, fmtTime } from '../util.js';
import { TIMECODES, RPM_FACTOR } from './timecode-defs.js';

const MODE_LABEL = { abs: 'ABS', rel: 'REL', int: 'INT' };
const MODE_TITLE = { abs: 'Absolute: the track position follows the record', rel: 'Relative: speed and direction follow the record, needle drops are ignored', int: 'Internal: the deck plays from software' };

function ensureCss() {
  if (document.querySelector('link[data-dvs-css]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: new URL('../../css/dvs.css', import.meta.url).href, 'data-dvs-css': '' }));
}

/** Topbar entry: opens the DVS panel; lit while the timecode input is running. */
export function dvsButton(app) {
  ensureCss();
  const b = el('button', { class: 'btn sm dvs-btn', title: 'DVS: control decks with timecode vinyl or CDs', onclick: () => openDvsPanel(app) }, icon('dvs'), el('span', { class: 'lbl' }, 'DVS'));
  const render = () => { const m = app.dvs; b.classList.toggle('active', !!m?.running); b.classList.toggle('error', !!m?.error); };
  app.dvs?.on('change', render); render();
  return b;
}

/** Per-deck mode badge (ABS / REL / INT). Click cycles the mode; hidden while DVS is off. */
export function dvsModeIndicator(app, deckIndex) {
  ensureCss();
  const b = el('button', { class: 'dvs-mode', title: '' });
  const dd = () => app.dvs?.decks[deckIndex];
  b.addEventListener('click', (e) => { e.stopPropagation(); if (app.shift) openDvsPanel(app); else dd()?.cycleMode(); });
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); openDvsPanel(app); });
  const render = () => {
    const d = dd();
    const on = !!(d && d.active);
    b.style.display = on ? '' : 'none';
    if (!on) return;
    const mode = d.mode, st = d.status;
    b.textContent = MODE_LABEL[mode];
    b.dataset.mode = mode;
    b.classList.toggle('nosig', mode !== 'int' && !st?.signal);
    b.classList.toggle('lock', mode === 'abs' && !!st?.lock);
    b.classList.toggle('warn', d.endWarning || d.leadIn);
    b.title = `DVS ${MODE_TITLE[mode]}${st ? ` · ${st.signal ? `${Math.round(st.quality * 100)}% quality` : 'no signal'}` : ''}${d.leadIn ? ' · lead-in' : ''}${d.endWarning ? ' · near the end of the record' : ''}\nClick: change mode · Right-click: DVS setup`;
  };
  if (app.dvs) {
    app.dvs.on('change', render);
    const d = dd(); d.on('change', render);
    let last = 0; d.on('status', () => { const now = performance.now(); if (now - last > 100) { last = now; render(); } });
  }
  render();
  return b;
}

/** Setup + calibration panel. */
export async function openDvsPanel(app) {
  ensureCss();
  const mgr = app.dvs;
  if (!mgr) { app.toast?.('DVS is not available'); return; }
  const s = mgr.settings;
  const sel = (value, options, onChange, cls = 'sel') => { const e = el('select', { class: cls }, ...options.map(([v, l]) => el('option', { value: v }, l))); e.value = String(value); e.addEventListener('change', () => onChange(e.value)); return e; };
  const chk = (value, label, onChange, title) => { const c = el('input', { type: 'checkbox', checked: !!value }); c.addEventListener('change', () => onChange(c.checked)); return el('label', { class: 'check', title }, c, ` ${label}`); };

  const inputs = await mgr.listInputs();
  const status = el('span', { class: 'dvs-status' });
  const enable = el('button', { class: 'btn dvs-enable' });
  enable.addEventListener('click', async () => { enable.disabled = true; try { await mgr.setEnabled(!mgr.running); } catch (e) { app.toast?.(`DVS: ${e.message}`); } enable.disabled = false; renderTop(); buildCards(); });
  const restart = async () => { if (mgr.running) { try { await mgr.start(); } catch (e) { app.toast?.(`DVS: ${e.message}`); } buildCards(); } renderTop(); };
  const devSel = sel(s.deviceId || '', [['', 'System default input'], ...inputs.filter((d) => d.id !== 'default').map((d) => [d.id, d.label])], async (v) => { await mgr.save({ deviceId: v }); restart(); });
  const chSel = sel(s.channelCount || 4, [2, 4, 6, 8].map((n) => [n, `${n} channels`]), async (v) => { await mgr.save({ channelCount: Number(v) }); restart(); });
  const unlock = el('button', { class: 'btn sm', title: 'Browsers only show device names after microphone permission was granted', onclick: async () => { try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); app.toast?.('Device names unlocked: reopen the DVS panel'); } catch (e) { app.toast?.(e.message); } } }, 'Show device names');
  const renderTop = () => {
    enable.textContent = mgr.running ? '● DVS ON' : 'Enable DVS';
    enable.classList.toggle('active', mgr.running);
    status.textContent = mgr.error ? `⚠ ${mgr.error}` : mgr.running ? `${mgr.deviceLabel || 'Input'} · ${mgr.channels} ch · ${mgr.ctx.sampleRate} Hz` : 'Off';
  };
  const top = el('div', { class: 'dvs-top' }, enable,
    el('label', { class: 'field' }, el('span', {}, 'Audio interface input'), devSel),
    el('label', { class: 'field' }, el('span', {}, 'Channels'), chSel), unlock, status);

  const cardsBox = el('div', { class: 'dvs-cards' });
  let cards = [];
  const buildCards = () => {
    const n = app.deckCount || 2;
    cards = [];
    cardsBox.replaceChildren(...Array.from({ length: n }, (_, i) => { const c = deckCard(app, mgr, i, sel, chk); cards.push(c); return c; }));
  };
  buildCards(); renderTop();

  const help = el('p', { class: 'hint dvs-help' },
    'Connect each turntable / CD player to a stereo input pair of your audio interface (set the interface to PHONO for turntables with a built-in phono preamp, LINE otherwise). ',
    'Play the record at normal speed and press Auto-calibrate: OpenDJ measures channel balance, phase, direction and 33/45 rpm. ',
    'ABS: track position follows the needle (needle drops jump). REL: only speed and direction. INT: the deck plays by itself. ',
    'Timecode position decoding (ABS) uses community-documented parameters that have not yet been verified with physical records; REL works with any 1 kHz / 2 kHz quadrature timecode.');
  const body = el('div', { class: 'dvs-panel' }, top, cardsBox, help);
  const offChange = mgr.on('change', () => renderTop());
  let raf = 0;
  const frame = () => { if (!body.isConnected) { cancelAnimationFrame(raf); return; } for (const c of cards) c.frame(); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
  await app.dialogs.modal('DVS — timecode vinyl / CD control', body, [{ label: 'Close', primary: true, value: true }], { wide: true });
  cancelAnimationFrame(raf); offChange();
}

function deckCard(app, mgr, i, sel, chk) {
  const dd = mgr.decks[i], s = dd.settings;
  const save = (patch) => mgr.saveDeck(i, patch);
  const pairs = Math.max(1, Math.floor(Math.max(mgr.channels || 0, mgr.settings.channelCount || 2) / 2));
  const modeBar = el('div', { class: 'seg dvs-modes' }, ...['abs', 'rel', 'int'].map((m) => el('button', { class: 'seg-btn', 'data-mode': m, title: MODE_TITLE[m], onclick: async () => { await dd.setMode(m); renderMode(); } }, MODE_LABEL[m])));
  const renderMode = () => { for (const b of modeBar.children) b.classList.toggle('active', b.dataset.mode === dd.mode); };
  renderMode();
  const reconnect = async () => { if (mgr.running) { dd.disconnect(); await dd.connect(); dd.applyConfig(); } };
  const scope = el('canvas', { class: 'dvs-scope', width: 150, height: 150, title: 'Lissajous: a clean, round circle means a good signal. It rotates anticlockwise when the record plays forwards.' });
  const num = (label) => { const v = el('b', {}, '–'); return [el('div', { class: 'dvs-num' }, el('span', {}, label), v), v]; };
  const [nSpeed, vSpeed] = num('Speed'), [nPitch, vPitch] = num('Pitch'), [nFreq, vFreq] = num('Carrier'), [nPos, vPos] = num('Position'), [nErr, vErr] = num('Bit errors');
  const meter = (label) => { const fill = el('i'); const txt = el('em'); return [el('div', { class: 'dvs-meter' }, el('span', {}, label), el('div', { class: 'dvs-bar' }, fill), txt), fill, txt]; };
  const [mLevel, fLevel, tLevel] = meter('Level'), [mQual, fQual, tQual] = meter('Quality');
  const state = el('div', { class: 'dvs-state' });
  const calRes = el('small', { class: 'hint dvs-cal' }, s.cal ? `Calibrated (right gain ×${s.cal.gR.toFixed(2)}, phase ${(Math.asin(s.cal.rho || 0) * 180 / Math.PI).toFixed(1)}°)` : '');
  const calBtn = el('button', { class: 'btn sm', title: 'Play the record forwards at normal speed, then click', onclick: async () => {
    calBtn.disabled = true; calRes.textContent = 'Measuring… keep the record playing forwards';
    try {
      const r = await dd.calibrate(1.5);
      calRes.textContent = `OK: ${r.rpm} rpm${r.flippedDirection ? ', direction reversed' : ''}, right gain ×${r.gainRight.toFixed(2)}, phase error ${r.phaseErrorDeg.toFixed(1)}°, level ${(20 * Math.log10(r.level || 1e-9)).toFixed(1)} dBFS`;
      rpmSel.value = String(r.rpm); revChk.querySelector('input').checked = dd.settings.invertPhase;
    } catch (e) { calRes.textContent = `⚠ ${e.message}`; }
    calBtn.disabled = false;
  } }, 'Auto-calibrate');
  const rpmSel = sel(s.rpm, [[33, '33⅓ rpm'], [45, '45 rpm']], (v) => save({ rpm: Number(v) }), 'sel tiny');
  const revChk = chk(s.invertPhase, 'Reverse direction', (v) => save({ invertPhase: v }), 'Use if the deck plays backwards when the record plays forwards');
  const card = el('div', { class: 'dvs-card', style: { '--deck-color': `var(--deck${i + 1})` } },
    el('div', { class: 'dvs-card-head' }, el('b', {}, `DECK ${i + 1}`), modeBar, state),
    el('div', { class: 'dvs-card-body' },
      scope,
      el('div', { class: 'dvs-cfg' },
        el('label', { class: 'field' }, el('span', {}, 'Inputs'), sel(s.pair, Array.from({ length: Math.max(pairs, s.pair + 1) }, (_, p) => [p, `In ${p * 2 + 1}-${p * 2 + 2}`]), async (v) => { await save({ pair: Number(v) }); reconnect(); })),
        el('label', { class: 'field' }, el('span', {}, 'Timecode'), sel(s.timecode, Object.values(TIMECODES).map((t) => [t.id, t.name]), (v) => save({ timecode: v }))),
        el('div', { class: 'row' },
          el('label', { class: 'field' }, el('span', {}, 'Platter'), rpmSel),
          el('label', { class: 'field' }, el('span', {}, 'Input'), sel(s.sensitivity, [['line', 'Line'], ['phono', 'Phono'], ['cd', 'CD (line)']], (v) => save({ sensitivity: v }), 'sel tiny'))),
        el('div', { class: 'row' }, chk(s.swap, 'Swap L/R', (v) => save({ swap: v })), revChk, chk(s.invertBits, 'Invert bits', (v) => save({ invertBits: v }), 'Try this if ABS mode never locks although the signal quality is good')),
        el('div', { class: 'row' }, calBtn), calRes),
      el('div', { class: 'dvs-stats' }, mLevel, mQual, nSpeed, nPitch, nFreq, nPos, nErr)));

  const g = scope.getContext('2d');
  card.frame = () => {
    const st = dd.status, W = scope.width, H = scope.height;
    g.fillStyle = '#07080a'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#1c2128'; g.lineWidth = 1; g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    g.beginPath(); g.arc(W / 2, H / 2, W * 0.36, 0, Math.PI * 2); g.stroke();
    renderMode();
    if (!dd.active || !st) { state.textContent = mgr.running ? 'no input on this pair' : 'off'; state.className = 'dvs-state off'; return; }
    // Lissajous, auto-scaled to the recent peak
    const sc = st.scope; let pk = 1e-4;
    for (let k = 0; k < sc.length; k++) pk = Math.max(pk, Math.abs(sc[k]));
    const k0 = (W * 0.42) / pk;
    g.strokeStyle = getComputedStyle(card).getPropertyValue('--deck-color').trim() || '#3ea6ff'; g.globalAlpha = 0.85; g.beginPath();
    for (let k = 0; k < sc.length; k += 2) { const x = W / 2 + sc[k] * k0, y = H / 2 - sc[k + 1] * k0; k ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke(); g.globalAlpha = 1;
    const db = 20 * Math.log10(Math.max(1e-6, st.peak));
    fLevel.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`; tLevel.textContent = db < -90 ? "−∞" : `${db.toFixed(0)} dB`;
    fLevel.classList.toggle('clip', st.peak > 0.98);
    fQual.style.width = `${Math.round(st.quality * 100)}%`; tQual.textContent = `${Math.round(st.quality * 100)}%`;
    fQual.style.background = st.quality > 0.8 ? 'var(--green)' : st.quality > 0.5 ? 'var(--amber)' : 'var(--red)';
    const rpmF = RPM_FACTOR[dd.settings.rpm] || 1;
    vSpeed.textContent = st.signal ? `${(st.velocity).toFixed(3)}×` : '–';
    vPitch.textContent = st.pitch ? `${(st.pitch / rpmF - 1) * 100 >= 0 ? '+' : ''}${((st.pitch / rpmF - 1) * 100).toFixed(2)}%` : '–';
    vFreq.textContent = st.signal ? `${Math.abs(st.carrierHz).toFixed(0)} Hz` : '–';
    const def = dd.def;
    vPos.textContent = st.lock && st.pos >= 0 ? fmtTime(st.pos / def.carrier) : def.bits ? (dd.mode === 'abs' ? 'searching' : '–') : 'n/a (relative timecode)';
    vErr.textContent = st.bitsRead ? `${(st.bitErrors / st.bitsRead * 100).toFixed(1)}%` : '–';
    const txt = !st.signal ? 'no signal (needle up / record stopped)' : dd.leadIn ? 'lead-in' : dd.endWarning ? 'near the end of the record!' : st.speed < -0.05 ? 'reverse' : 'playing';
    state.textContent = txt;
    state.className = `dvs-state ${!st.signal ? 'off' : dd.endWarning ? 'warn' : 'ok'}`;
  };
  return card;
}
