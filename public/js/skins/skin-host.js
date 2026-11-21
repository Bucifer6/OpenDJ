// Whole-layout controller skins. A skin is picked like any theme (Settings → Appearance, ids `compact-controller` and
// `all-in-one`): when that theme is active, its module draws the controller in place of the deck + mixer area
// (the standard decks stay built and running underneath, just hidden), and goes away again when another theme is
// picked. Also: when a controller with a bundled first-party mapping connects, offer its matching skin (once, never
// forced) and, for controllers with their own sound card, offer to route master / headphones to it.
const SKINS = {
  'compact-controller': { load: () => import('./compact-controller.js'), css: 'css/skin-compact.css', decks: 2, name: 'Compact Controller' },
  'all-in-one': { load: () => import('./all-in-one.js'), css: 'css/skin-allinone.css', decks: 4, name: 'All-in-One 4-Channel', minWidth: 900 },
};
export const SKIN_IDS = Object.keys(SKINS);

const cssLoaded = new Map();
function loadCss(href) {
  if (!cssLoaded.has(href)) {
    cssLoaded.set(href, new Promise((resolve) => {
      if (document.querySelector(`link[href="${href}"]`)) return resolve();
      const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
      l.onload = l.onerror = () => resolve();
      document.head.append(l);
    }));
  }
  return cssLoaded.get(href);
}

let current = null, currentId = null, seq = 0;

async function apply(app) {
  let id = SKINS[document.documentElement.dataset.theme] ? document.documentElement.dataset.theme : null;
  // skins that need a wide screen fall back to the standard layout on phones (with a note, once)
  if (id && SKINS[id].minWidth && document.documentElement.classList.contains('compact')) {
    if (!apply._noted?.has(id)) { (apply._noted ||= new Set()).add(id); app.toast?.(`The ${SKINS[id].name} skin needs a wider screen (a tablet in landscape or a computer): showing the standard layout here.`); }
    id = null;
  }
  if (id === currentId) return;
  const my = ++seq;
  if (current) { current.destroy(); current = null; }
  currentId = id;
  const area = app.deckArea;
  document.body.classList.toggle('skin-on', !!id);
  for (const k of SKIN_IDS) document.body.classList.toggle(`skin-${k}`, k === id);
  if (!id || !area) { area?.classList.remove('sk-host'); return; }
  const s = SKINS[id];
  await Promise.all([loadCss('css/skins.css'), loadCss(s.css)]);
  const mod = await s.load();
  if (my !== seq) return; // switched again while loading
  // the skin's deck count: compact = 2 decks; all-in-one = 4 decks with DECK SELECT layers
  if (s.decks === 2 && app.deckCount === 4) await app.setLayout?.('classic');
  if (s.decks === 4 && app.deckCount !== 4 && !document.documentElement.classList.contains('compact')) await app.setDeckCount?.(4);
  if (my !== seq) return;
  area.classList.add('sk-host');
  current = mod.mount(app, area);
  window.dispatchEvent(new CustomEvent('opendj-skin', { detail: { id } }));
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** A toast with actions (same look as the "new controller" offer). */
function offer(app, title, textMsg, actions, cls = '') {
  const host = app.toasts; if (!host) return null;
  const mk = (tag, c, t, onclick) => { const e = document.createElement(tag); if (c) e.className = c; if (t) e.textContent = t; if (onclick) e.addEventListener('click', onclick); return e; };
  const box = mk('div', `toast ctl-offer ${cls}`);
  const close = () => { box.classList.add('out'); setTimeout(() => box.remove(), 400); };
  const row = mk('div', 'ctl-offer-actions');
  for (const [label, fn, primary] of actions) row.append(mk('button', `btn sm${primary ? ' primary' : ''}`, label, () => { close(); fn?.(); }));
  box.append(mk('div', 'ctl-offer-title', title), mk('div', 'ctl-offer-text', textMsg), row);
  host.append(box);
  setTimeout(close, 30000);
  return box;
}

/** Bundled mapping connected: offer the matching skin once, and the controller's own audio outputs. */
export function onPreset(app, { device, preset }) {
  if (!preset) return;
  const skin = preset.skin && SKINS[preset.skin];
  const key = `opendj.skinOffer.${preset.id}`;
  if (skin && document.documentElement.dataset.theme !== preset.skin && !store.get(key)) {
    store.set(key, 'asked');
    offer(app, `${device} connected`, `Use the matching ${skin.name} skin? The decks and mixer are drawn like your controller and follow it as you play. You can switch back any time in Settings → Appearance.`, [
      [`Use ${skin.name} skin`, () => { app.setSetting('theme', preset.skin).then(() => import('../ui/themes.js').then((m) => m.applyTheme(app.settings))); }, true],
      ['No thanks'],
    ], 'skin-offer');
  }
  if (preset.audio?.builtIn) offerAudio(app, device, preset);
}

async function offerAudio(app, device, preset) {
  const key = `opendj.audioOffer.${preset.id}`;
  const s = app.settings || {};
  if (store.get(key) || s.cueMode === 'channels34' || s.cueMode === 'split') return;
  store.set(key, 'asked');
  const useIt = async () => {
    const outs = await app.engine.listOutputs?.() || [];
    const dev = outs.find((o) => preset.audio.deviceLabel?.test?.(o.label));
    if (!dev) {
      app.toast(`Pick "${device}" as the master output and "channels 3-4" for headphones in Settings → Audio (if the names are hidden, press "Show device names" there first).`);
      app.dialogs?.settings?.('audio');
      return;
    }
    await app.setSetting('masterDeviceId', dev.id);
    await app.setSetting('cueMode', 'channels34');
    await app.engine.applyOutputs?.();
    const chs = app.engine.ctx?.destination?.maxChannelCount || 2;
    if (chs < 4) {
      app.toast(`⚠ ${device} offers ${chs} output channels here, so the headphone cue can't use channels 3-4. Use "Split cue" (master left, cue right) or a second sound card in Settings → Audio.`);
    } else app.toast(`Master now plays on ${device} outputs 1-2, headphones on 3-4.`);
  };
  offer(app, `${device} has its own sound card`, 'Its MASTER and PHONES jacks play audio from OpenDJ. Send the master to outputs 1-2 and the headphone cue to 3-4?', [
    ['Use controller audio', useIt, true],
    ['Audio settings', () => app.dialogs?.settings?.('audio')],
    ['Not now'],
  ], 'audio-offer');
}

function init(app) {
  apply(app);
  window.addEventListener('opendj-theme', () => apply(app));
  if (app.midi) {
    app.midi.on('preset', (p) => onPreset(app, p));
    // controllers that were connected before this module loaded
    for (const inp of app.midi.inputs()) { const p = app.midi.presetOf?.(inp.name); if (p && inp.state !== 'disconnected') onPreset(app, { device: inp.name, preset: p }); }
  }
}

// wait for the app (index.html loads this module next to js/app.js)
(function wait() {
  const app = window.opendj;
  if (app?.ready) init(app); else setTimeout(wait, 100);
})();
