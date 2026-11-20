// Lighting panel: Live pads + preview, fixture patch, outputs, show settings.
import { el } from '../util.js';
import { api } from '../api.js';

const SWATCHES = ['#ff0000', '#ff7a00', '#ffd400', '#00ff3c', '#00e5ff', '#0040ff', '#a000ff', '#ff00b4', '#ffffff'];
const PHRASE_LABEL = { intro: 'Intro', verse: 'Verse', buildup: 'Build-up', drop: 'Drop', breakdown: 'Breakdown', outro: 'Outro' };

const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('p', { class: 'hint' }, hint) : null);
const select = (value, options, onchange, attrs = {}) => {
  const s = el('select', { class: 'sel', ...attrs, onchange: () => onchange(s.value) }, ...options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = String(value ?? '');
  return s;
};
const input = (value, onchange, attrs = {}) => {
  const i = el('input', { class: 'inp', value: value ?? '', ...attrs });
  i.addEventListener(attrs.type === 'color' ? 'input' : 'change', () => onchange(attrs.type === 'number' ? Number(i.value) : i.value, i));
  return i;
};
const check = (label, value, onchange) => {
  const c = el('input', { type: 'checkbox', checked: !!value, onchange: () => onchange(c.checked) });
  return el('label', { class: 'lt-check' }, c, el('span', {}, label));
};

function nextAddress(fixtures, count, universe = 1) {
  for (let u = universe; u < universe + 64; u++) {
    const end = fixtures.filter((f) => f.channels?.length && f.universe === u).reduce((m, f) => Math.max(m, f.address + f.channels.length - 1), 0);
    if (end + count <= 512) return { universe: u, address: end + 1 };
  }
  return { universe, address: 1 };
}
function overlaps(fixtures) {
  const bad = new Set();
  const dmx = fixtures.filter((f) => f.channels?.length);
  for (let i = 0; i < dmx.length; i++) for (let j = i + 1; j < dmx.length; j++) {
    const a = dmx[i], b = dmx[j];
    if (a.universe === b.universe && a.address <= b.address + b.channels.length - 1 && b.address <= a.address + a.channels.length - 1) { bad.add(a.id); bad.add(b.id); }
  }
  for (const f of dmx) if (f.address + f.channels.length - 1 > 512) bad.add(f.id);
  return bad;
}
const newId = () => 'fx' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

export function openLightingPanel(L, tab = 'live') {
  const app = L.app;
  const meta = L.meta || { templates: [], effects: {}, phrases: [], groups: ['all'], channels: [] };
  const cfg = structuredClone(L.config);
  const toast = (m) => app.toast?.(m);
  let saveT = null;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try { const s = await L.saveConfig(cfg); cfg.outputs.sacn.cid = s.outputs.sacn.cid; } catch (e) { toast(`Lighting: ${e.message}`); }
    }, 300);
  };
  const flush = async () => { if (saveT) { clearTimeout(saveT); saveT = null; await L.saveConfig(cfg).catch(() => {}); } };
  const live = async (patch) => {
    try { const r = await L.setLive(patch); Object.assign(cfg.show, r.show); renderPads(); } catch (e) { toast(e.message); }
  };
  let status = null, lastPreview = null;

  // ---------------------------------------------------------------- Live
  const stage = el('div', { class: 'lt-stage' });
  const pads = el('div', { class: 'lt-pads' });
  const fxPads = el('div', { class: 'lt-fxpads' });
  const swatches = el('div', { class: 'lt-swatches' });
  const statusLine = el('div', { class: 'lt-status' }, '—');
  const enableBtn = el('button', { class: 'btn lt-enable', onclick: async () => { cfg.enabled = !cfg.enabled; await flush(); await L.setEnabled(cfg.enabled).catch((e) => toast(e.message)); renderPads(); } });
  const master = el('input', { type: 'range', min: 0, max: 100, value: Math.round(cfg.show.master * 100), class: 'lt-range' });
  master.addEventListener('input', () => live({ master: master.value / 100 }));
  const speed = el('div', { class: 'seg' });

  const pad = (label, cls, attrs) => el('button', { class: `lt-pad ${cls || ''}`, ...attrs }, label);
  const padAuto = pad('AUTO', 'auto', { onclick: () => live({ auto: !cfg.show.auto }), title: 'Follow the music: effects chosen by phrase' });
  const padBlack = pad('BLACKOUT', 'black', { onclick: () => live({ blackout: !L.live.blackout }) });
  const padStrobe = pad('STROBE', 'strobe', { title: 'Hold' });
  const strobe = (on) => (e) => { e.preventDefault(); if (!!L.live.strobe !== on) live({ strobe: on }); };
  padStrobe.addEventListener('pointerdown', (e) => { padStrobe.setPointerCapture?.(e.pointerId); strobe(true)(e); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) padStrobe.addEventListener(ev, strobe(false));
  const padFull = pad('FULL', 'full', { onclick: () => live({ full: !L.live.full }) });
  const padFreeze = pad('FREEZE', 'freeze', { onclick: () => live({ freeze: !L.live.freeze }) });
  pads.append(padAuto, padBlack, padStrobe, padFull, padFreeze);
  for (const [k, label] of Object.entries(meta.effects)) {
    fxPads.append(el('button', { class: 'lt-fx', 'data-k': k, onclick: () => live({ auto: false, manualEffect: k }) }, label));
  }
  for (const c of SWATCHES) swatches.append(el('button', { class: 'lt-swatch', 'data-c': c, style: { background: c }, title: c, onclick: () => live({ color: L.live.color === c ? null : c }) }));
  swatches.append(el('button', { class: 'btn sm lt-swatch-auto', onclick: () => live({ color: null }) }, 'Auto colour'));
  for (const [v, l] of [[0.5, '½×'], [1, '1×'], [2, '2×']]) speed.append(el('button', { class: 'seg-btn', 'data-v': v, onclick: () => live({ speed: v }) }, l));

  function renderPads() {
    enableBtn.textContent = cfg.enabled ? '● Lighting on' : '○ Lighting off';
    enableBtn.classList.toggle('active', cfg.enabled);
    padAuto.classList.toggle('on', !!cfg.show.auto);
    padBlack.classList.toggle('on', !!L.live.blackout);
    padStrobe.classList.toggle('on', !!L.live.strobe);
    padFull.classList.toggle('on', !!L.live.full);
    padFreeze.classList.toggle('on', !!L.live.freeze);
    const cur = lastPreview?.effect;
    for (const b of fxPads.children) { b.classList.toggle('on', !cfg.show.auto && b.dataset.k === cfg.show.manualEffect); b.classList.toggle('playing', b.dataset.k === cur); }
    for (const b of swatches.querySelectorAll('.lt-swatch')) b.classList.toggle('on', b.dataset.c === L.live.color);
    for (const b of speed.children) b.classList.toggle('active', Number(b.dataset.v) === cfg.show.speed);
    master.value = Math.round(cfg.show.master * 100);
  }

  function buildStage() {
    stage.replaceChildren();
    if (!cfg.fixtures.length) { stage.append(el('p', { class: 'hint lt-empty' }, 'No fixtures patched yet. Add lights in the Fixtures tab (DMX pars, WLED strips, Hue bulbs).')); return; }
    cfg.fixtures.forEach((f, i) => {
      if (f.type === 'wled-strip') {
        const cells = el('div', { class: 'lt-strip-cells' }, ...Array.from({ length: Math.min(48, f.pixels || 1) }, () => el('i')));
        stage.append(el('div', { class: 'lt-node strip', 'data-i': i, 'data-id': f.id, title: f.name }, cells, el('small', {}, f.name)));
      } else {
        stage.append(el('div', { class: `lt-node ${f.type}`, 'data-i': i, 'data-id': f.id, title: `${f.name} (${f.type})` }, el('div', { class: 'lt-bulb' }), el('small', {}, f.name)));
      }
    });
  }
  function paintPreview(d) {
    lastPreview = d;
    for (const n of stage.children) {
      const i = Number(n.dataset.i); if (Number.isNaN(i)) continue;
      if (n.classList.contains('strip')) {
        const hex = d.px?.[n.dataset.id]; if (!hex) continue;
        const cells = n.firstChild.children;
        for (let k = 0; k < cells.length; k++) cells[k].style.background = '#' + hex.slice(k * 6, k * 6 + 6);
      } else {
        const c = d.l?.[i]; if (!c) continue;
        const b = n.firstChild, rgb = `rgb(${c[0]},${c[1]},${c[2]})`, lum = Math.max(...c) / 255;
        b.style.background = rgb;
        b.style.boxShadow = lum > 0.05 ? `0 0 ${6 + lum * 22}px ${2 + lum * 6}px rgba(${c[0]},${c[1]},${c[2]},${0.25 + lum * 0.5})` : 'none';
      }
    }
    if (d.status) status = d.status;
    const parts = [];
    parts.push(d.playing ? `${d.bpm.toFixed(1)} BPM · beat ${d.beat + 1}` : 'Not playing');
    if (d.phrase) parts.push(PHRASE_LABEL[d.phrase] || d.phrase);
    parts.push(`Effect: ${meta.effects[d.effect] || d.effect}`);
    const outs = status ? Object.entries(status.outputs) : [];
    if (outs.length) parts.push(outs.map(([k, o]) => `${k}${o.error ? ' ⚠' : ''}`).join(', '));
    if (L.usb.connected) parts.push(`USB DMX ${L.usb.frames} frames`);
    statusLine.textContent = parts.join('  ·  ');
    for (const b of fxPads.children) b.classList.toggle('playing', b.dataset.k === d.effect);
    renderOutputStatus();
  }

  const liveTab = () => {
    buildStage(); renderPads();
    return el('div', { class: 'lt-live' },
      el('div', { class: 'lt-top' }, enableBtn, statusLine),
      stage,
      pads,
      el('div', { class: 'lt-sub' }, 'Manual effects (turns Auto off)'), fxPads,
      el('div', { class: 'lt-sub' }, 'Colour'), swatches,
      el('div', { class: 'lt-sliders' }, field('Intensity', master), field('Speed', speed)),
      cfg.enabled ? null : el('p', { class: 'hint' }, 'Lighting is off: the preview runs, but nothing is sent to your lights. Turn it on above.'),
    );
  };

  // ---------------------------------------------------------------- Fixtures
  const fixturesTab = () => {
    const wrap = el('div', { class: 'form' });
    const render = () => {
      const bad = overlaps(cfg.fixtures);
      const rows = cfg.fixtures.map((f, i) => {
        const dmx = f.type !== 'wled-strip' && f.type !== 'hue-light';
        const chans = input(f.channels.join(' '), (v) => { f.channels = v.split(/[\s,]+/).filter(Boolean); save(); render(); }, { title: `Channel functions in order: ${meta.channels.join(', ')}, =N (fixed value)` });
        return el('tr', { class: bad.has(f.id) ? 'lt-bad' : '' },
          el('td', {}, String(i + 1)),
          el('td', {}, input(f.name, (v) => { f.name = v; save(); })),
          el('td', { class: 'lt-type' }, f.type),
          el('td', {}, dmx ? input(f.universe, (v) => { f.universe = Math.max(1, v | 0); save(); render(); }, { type: 'number', min: 1, class: 'inp lt-num' }) : '—'),
          el('td', {}, dmx ? input(f.address, (v) => { f.address = Math.min(512, Math.max(1, v | 0)); save(); render(); }, { type: 'number', min: 1, max: 512, class: 'inp lt-num' }) : '—'),
          el('td', {}, dmx ? chans
            : f.type === 'wled-strip' ? el('div', { class: 'lt-inline' }, input(f.host, (v) => { f.host = v.trim(); save(); }, { placeholder: 'WLED IP' }), input(f.pixels, (v) => { f.pixels = Math.max(1, v | 0); save(); }, { type: 'number', min: 1, class: 'inp lt-num', title: 'LED count' }))
              : input(f.hueId, (v) => { f.hueId = v.trim(); save(); }, { placeholder: 'Hue light id' })),
          el('td', {}, select(f.group, meta.groups.map((g) => [g, g]), (v) => { f.group = v; save(); })),
          el('td', {}, el('button', { class: 'btn sm', title: 'Remove', onclick: () => { cfg.fixtures.splice(i, 1); save(); render(); } }, '✕')));
      });
      const tpl = select(meta.templates[0]?.id, meta.templates.map((t) => [t.id, t.name]), () => {});
      const count = el('input', { class: 'inp lt-num', type: 'number', min: 1, max: 64, value: 1 });
      const group = select('all', meta.groups.map((g) => [g, g]), () => {});
      const add = () => {
        const t = meta.templates.find((x) => x.id === tpl.value);
        for (let k = 0; k < Math.max(1, Math.min(64, count.value | 0)); k++) {
          const n = cfg.fixtures.filter((f) => f.type === t.type).length + 1;
          const f = { id: newId(), name: `${t.name.replace(/\s*\(.*\)$/, '')} ${n}`, type: t.type, channels: [...t.channels], group: group.value, universe: 1, address: 1 };
          if (t.channels.length) Object.assign(f, nextAddress(cfg.fixtures, t.channels.length));
          if (t.type === 'wled-strip') Object.assign(f, { host: '', pixels: t.pixels || 60 });
          if (t.type === 'hue-light') f.hueId = '';
          cfg.fixtures.push(f);
        }
        save(); render();
      };
      const readdress = () => {
        const placed = [];
        for (const f of cfg.fixtures) { if (f.channels?.length) Object.assign(f, nextAddress(placed, f.channels.length)); placed.push(f); }
        save(); render();
      };
      wrap.replaceChildren(...[
        el('div', { class: 'row lt-addbar' }, field('Template', tpl), field('Count', count), field('Group', group),
          el('button', { class: 'btn primary', onclick: add }, 'Add fixtures'),
          el('button', { class: 'btn', onclick: readdress, title: 'Pack all DMX fixtures from address 1 in patch order' }, 'Auto-address all')),
        cfg.fixtures.length
          ? el('div', { class: 'lt-table-wrap' }, el('table', { class: 'lt-table' },
            el('thead', {}, el('tr', {}, ...['#', 'Name', 'Type', 'Univ', 'Addr', 'Channels / device', 'Group', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, ...rows)))
          : el('p', { class: 'hint' }, 'No fixtures yet. Pick a template and click Add: addresses are assigned automatically.'),
        bad.size ? el('p', { class: 'hint lt-warn' }, '⚠ Highlighted fixtures overlap another fixture\'s channels or run past channel 512.') : null,
        el('p', { class: 'hint' }, 'Patch order is chase order. Left/right groups are used by the left/right effect. Channel functions: dim r g b w strobe rate pan tilt speed mode none, or =N for a fixed value (e.g. =255 to open a shutter).'),
      ].filter(Boolean));
    };
    render();
    return wrap;
  };

  // ---------------------------------------------------------------- Outputs
  const statusEls = {};
  function renderOutputStatus() {
    for (const [k, node] of Object.entries(statusEls)) {
      const o = status?.outputs?.[k];
      if (k === 'usbdmx') node.textContent = L.usb.connected ? `Connected (${L.usb.name}) · ${L.usb.frames} frames${L.usb.error ? ' · ' + L.usb.error : ''}` : (L.usb.error || 'Not connected');
      else node.textContent = !cfg.outputs[k]?.enabled ? 'Off' : o ? (o.error ? `⚠ ${o.error}` : `${o.packets} packets sent`) : (cfg.enabled ? 'Starting…' : 'Lighting is off');
    }
  }
  const card = (key, title, body, { test = true } = {}) => {
    const o = cfg.outputs[key];
    statusEls[key] = el('span', { class: 'lt-out-status' });
    return el('section', { class: 'lt-out' },
      el('div', { class: 'lt-out-head' },
        check(title, o.enabled, (v) => { o.enabled = v; save(); renderOutputStatus(); }),
        statusEls[key],
        test ? el('button', { class: 'btn sm', onclick: async () => { await flush(); await L.test(1000).catch((e) => toast(e.message)); } }, 'Send test flash') : null),
      body);
  };
  const num = (obj, k, attrs = {}) => input(obj[k], (v) => { obj[k] = v; save(); }, { type: 'number', class: 'inp lt-num', ...attrs });
  const txt = (obj, k, attrs = {}) => input(obj[k], (v) => { obj[k] = v.trim(); save(); }, attrs);

  const outputsTab = () => {
    const o = cfg.outputs;
    const hueStatus = el('span', { class: 'hint' }, o.hue.username ? 'Paired ✓' : 'Not paired');
    const bridge = txt(o.hue, 'bridge', { placeholder: 'Bridge IP, e.g. 192.168.1.20' });
    const hueBody = el('div', { class: 'form' },
      el('div', { class: 'row' }, field('Bridge', bridge),
        el('button', { class: 'btn', onclick: async () => {
          try { const list = await api.hueDiscover(); if (!list.length) return toast('No Hue bridge found on this network'); o.hue.bridge = bridge.value = list[0].ip; save(); toast(`Found Hue bridge ${list[0].ip}`); } catch (e) { toast(`Discovery: ${e.message}`); }
        } }, 'Discover'),
        el('button', { class: 'btn', onclick: async () => {
          await flush();
          try { const r = await api.huePair(o.hue.bridge); o.hue.username = r.username; hueStatus.textContent = 'Paired ✓'; L.config.outputs.hue.username = r.username; toast('Hue bridge paired'); } catch (e) { toast(e.message); }
        } }, 'Pair (press link button first)'), hueStatus),
      el('div', { class: 'row' },
        field('Updates / second (max 10)', num(o.hue, 'rate', { min: 1, max: 10 })),
        field('Transition (×100 ms)', num(o.hue, 'transition', { min: 0, max: 20 })),
        el('button', { class: 'btn', onclick: async () => {
          await flush();
          try {
            const lights = await api.hueLights(); let added = 0;
            for (const l of lights) if (!cfg.fixtures.some((f) => f.type === 'hue-light' && f.hueId === l.id)) { cfg.fixtures.push({ id: newId(), name: l.name, type: 'hue-light', hueId: l.id, group: 'all', channels: [], universe: 1, address: 1 }); added++; }
            save(); toast(`Added ${added} Hue light(s) to the patch`);
          } catch (e) { toast(e.message); }
        } }, 'Import lights')),
      el('p', { class: 'hint' }, 'Hue bulbs change colour on the beat and follow the energy; the bridge only takes about 10 commands a second, so they cannot strobe or chase fast.'));

    const strips = cfg.fixtures.filter((f) => f.type === 'wled-strip');
    const usbBtn = el('button', { class: 'btn', onclick: async () => {
      try {
        await flush();
        if (L.usb.connected) await L.disconnectUsb(); else await L.connectUsb();
        usbBtn.textContent = L.usb.connected ? 'Disconnect' : 'Connect widget…'; renderOutputStatus();
      } catch (e) { toast(`USB DMX: ${e.message}`); }
    } }, L.usb.connected ? 'Disconnect' : 'Connect widget…');
    const midiOuts = (app.midi?.outputs?.() || []).map((x) => [x.name, x.name]);

    const body = el('div', { class: 'form' },
      card('artnet', 'Art-Net', el('div', { class: 'row' },
        field('Target IP (broadcast or node)', txt(o.artnet, 'host')), field('Port', num(o.artnet, 'port')),
        field('Net', num(o.artnet, 'net', { min: 0, max: 127 })), field('Subnet', num(o.artnet, 'subnet', { min: 0, max: 15 })), field('Universe', num(o.artnet, 'universe', { min: 0, max: 15 })))),
      card('sacn', 'sACN / E1.31', el('div', { class: 'row' },
        check('Multicast', o.sacn.multicast, (v) => { o.sacn.multicast = v; save(); }),
        field('Unicast IP (when multicast is off)', txt(o.sacn, 'host')), field('First universe', num(o.sacn, 'universe', { min: 1 })), field('Priority', num(o.sacn, 'priority', { min: 0, max: 200 })))),
      card('wled', 'WLED (LED strips)', el('div', { class: 'form' },
        strips.length ? el('div', { class: 'lt-inline-list' }, ...strips.map((f) => el('div', { class: 'row' }, el('b', { class: 'lt-strip-name' }, f.name), field('IP', txt(f, 'host', { placeholder: '192.168.1.50' })), field('LEDs', num(f, 'pixels', { min: 1, max: 1500 })))))
          : el('p', { class: 'hint' }, 'No WLED strips patched.'),
        el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { cfg.fixtures.push({ id: newId(), name: `WLED strip ${strips.length + 1}`, type: 'wled-strip', host: '', pixels: 60, group: 'all', channels: [], universe: 1, address: 1 }); save(); show('outputs'); } }, 'Add WLED strip'),
          field('UDP port', num(o.wled, 'port'))),
        el('p', { class: 'hint' }, 'Uses WLED realtime UDP (DRGB / DNRGB). WLED returns to its own effects 2 s after the music stops.'))),
      card('hue', 'Philips Hue', hueBody),
      card('osc', 'OSC (QLC+, Resolume, TouchDesigner, MagicQ)', el('div', { class: 'form' }, el('div', { class: 'row' },
        field('Host', txt(o.osc, 'host')), field('Port', num(o.osc, 'port')), field('Address prefix', txt(o.osc, 'prefix'))),
        el('p', { class: 'hint' }, `Sends ${o.osc.prefix}/beat i (1–4), /downbeat, /bpm f, /phrase s f, /level f, /color f f f.`))),
      card('usbdmx', 'USB DMX (Enttec DMX USB Pro compatible)', el('div', { class: 'row' },
        field('Universe', num(o.usbdmx, 'universe', { min: 1 })), usbBtn,
        L.serialSupported ? null : el('p', { class: 'hint' }, 'Web Serial is not available here: use the desktop app, Chrome or Edge.'))),
      card('midi', 'MIDI notes (for lighting software)', el('div', { class: 'row' },
        field('MIDI output', select(o.midi.output, [['', midiOuts.length ? 'Choose…' : 'No MIDI outputs'], ...midiOuts], (v) => { o.midi.output = v; save(); })),
        field('Channel', num(o.midi, 'channel', { min: 1, max: 16 })), field('Beat note', num(o.midi, 'beatNote', { min: 0, max: 127 })),
        field('Downbeat note', num(o.midi, 'downbeatNote', { min: 0, max: 127 })), field('Phrase notes from', num(o.midi, 'phraseNote', { min: 0, max: 121 }))), { test: false }),
    );
    renderOutputStatus();
    return body;
  };

  // ---------------------------------------------------------------- Show
  const showTab = () => {
    const s = cfg.show;
    const effectOpts = Object.entries(meta.effects).map(([k, l]) => [k, l]);
    const palette = el('div', { class: 'row' }, ...s.palette.map((c, i) => input(c, (v) => { s.palette[i] = v; save(); }, { type: 'color', class: 'lt-color' })));
    return el('div', { class: 'form' },
      el('h3', {}, 'Effect per phrase (Auto mode)'),
      el('div', { class: 'lt-map' }, ...meta.phrases.map((p) => field(PHRASE_LABEL[p] || p, select(s.map[p], effectOpts, (v) => { s.map[p] = v; save(); })))),
      el('h3', {}, 'Colour'),
      el('div', { class: 'row' }, field('Colour source', select(s.colorMode, [['key', 'Track key (Camelot wheel → hue)'], ['energy', 'Energy (blue → red)'], ['palette', 'Fixed palette']], (v) => { s.colorMode = v; save(); }))),
      field('Palette (fixed palette mode)', palette),
      el('h3', {}, 'Behaviour'),
      el('div', { class: 'row' },
        field('When the music stops', select(s.idle, [['dim', 'Dim colour cycle'], ['wash', 'Colour wash'], ['blackout', 'Blackout']], (v) => { s.idle = v; save(); })),
        field('Latency offset (ms)', input(s.latencyMs, (v) => { s.latencyMs = v; save(); }, { type: 'number', class: 'inp lt-num', min: -500, max: 500 })),
        field('Frame rate', select(cfg.fps, [[25, '25 fps'], [30, '30 fps'], [40, '40 fps'], [44, '44 fps']], (v) => { cfg.fps = Number(v); save(); }))),
      el('p', { class: 'hint' }, 'A positive latency offset fires the lights earlier, to make up for slow fixtures or networks. Audio output latency is already compensated.'),
      check('Strobe accents on drop downbeats', s.strobeAccents, (v) => { s.strobeAccents = v; save(); }),
      el('p', { class: 'hint' }, 'Phrases come from the track analysis (intro, verse, build-up, drop, breakdown, outro). Without phrase data the show uses the Verse effect.'),
    );
  };

  // ---------------------------------------------------------------- tabs + stream
  const tabs = { live: ['Live', liveTab], fixtures: ['Fixtures', fixturesTab], outputs: ['Outputs', outputsTab], show: ['Show', showTab] };
  const tabBar = el('div', { class: 'tabs' });
  const pane = el('div', { class: 'tab-pane' });
  function show(k) {
    for (const key of Object.keys(statusEls)) delete statusEls[key];
    pane.replaceChildren(tabs[k][1]());
    for (const b of tabBar.children) b.classList.toggle('active', b.dataset.k === k);
  }
  for (const [k, [label]] of Object.entries(tabs)) tabBar.append(el('button', { class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
  show(tabs[tab] ? tab : 'live');

  const es = new EventSource(api.lightingStreamUrl({ preview: true }));
  es.addEventListener('preview', (e) => { try { const d = JSON.parse(e.data); if (d.live) Object.assign(L.live, d.live); paintPreview(d); } catch { /* ignore */ } });
  const offLive = L.on('live', renderPads);

  const root = el('div', { class: 'lt-panel' }, tabBar, pane);
  return app.dialogs.modal('Lighting', root, [{ label: 'Close', primary: true, value: true }], { wide: true })
    .then(async (v) => { es.close(); offLive(); await flush(); return v; });
}
