// App themes. Each theme overrides CSS custom properties (see public/css/themes.css); canvases read them via cssVar().
const BUILT_IN_THEMES = [
  { id: 'midnight', name: 'Midnight', desc: 'Default dark blue-grey', swatch: ['#0b0d10', '#191d23', '#3ea6ff', '#ff8a3d'] },
  { id: 'graphite', name: 'Graphite', desc: 'Neutral studio grey', swatch: ['#121212', '#1e1e1e', '#e0e0e0', '#ffb347'] },
  { id: 'club', name: 'Club Red', desc: 'Dark with red accents (low light)', swatch: ['#0c0708', '#1b1113', '#ff2e4d', '#ffb020'] },
  { id: 'neon', name: 'Neon', desc: 'Synthwave purple & cyan', swatch: ['#0b0614', '#1a1030', '#00e5ff', '#ff3df2'] },
  { id: 'ocean', name: 'Ocean', desc: 'Deep navy & teal', swatch: ['#06121a', '#0e2230', '#21d4c4', '#5aa9ff'] },
  { id: 'gold', name: 'Black & Gold', desc: 'Premium black with gold', swatch: ['#0a0a0a', '#181612', '#e8b84a', '#d0d0d0'] },
  { id: 'forest', name: 'Forest', desc: 'Dark green, easy on the eyes', swatch: ['#08100c', '#13211a', '#3ddc84', '#f2c94c'] },
  { id: 'light', name: 'Daylight', desc: 'Bright theme for outdoor & daytime gigs', swatch: ['#eef1f5', '#ffffff', '#0a6cff', '#e8590c'] },
  { id: 'contrast', name: 'High Contrast', desc: 'Maximum legibility (sunlight, accessibility)', swatch: ['#000000', '#000000', '#ffff00', '#00ffff'] },
  { id: 'cdj', name: 'Club Decks', desc: 'Media-player style decks, bright displays and a central mixer', swatch: ['#090c10', '#20262d', '#32c7dd', '#ffb64d'] },
  { id: 'vinyl', name: 'Vinyl Booth', desc: 'Turntable-inspired platters and warm analogue tones', swatch: ['#10100f', '#282725', '#d9b56d', '#e66a4b'] },
  { id: 'performance', name: 'Pad Performance', desc: 'Colour-coded pads and a modern performance controller', swatch: ['#101018', '#23232e', '#b276ff', '#3de0c1'] },
  { id: 'studio', name: 'Studio Mixer', desc: 'Brushed-metal mixer with classic channel colours', swatch: ['#111418', '#252b31', '#70a9d8', '#e6a759'] },
];

const THEME_CACHE_KEY = 'opendj-skin-catalog-v1';
const MAX_CATALOG_BYTES = 256 * 1024;
const SKIN_CATALOG_URL = 'https://raw.githubusercontent.com/Bucifer6/OpenDJ/main/public/skins/catalog.json';
const THEME_VARS = new Set([
  '--bg', '--panel', '--panel-2', '--panel-3', '--line', '--line-2', '--text', '--text-2', '--text-3',
  '--accent', '--on-accent', '--deck1', '--deck2', '--deck3', '--deck4', '--inset', '--deep', '--wave-bg',
  '--row-alt', '--hover', '--sel', '--sel-tree', '--topbar-1', '--topbar-2', '--knob-hi', '--knob-lo',
  '--knob-ring', '--platter-1', '--platter-2', '--platter-3', '--platter-4', '--fader-cap-1', '--fader-cap-2',
  '--wf-low', '--wf-mid', '--wf-high',
]);
const BUILT_IN_IDS = new Set(BUILT_IN_THEMES.map((t) => t.id));
export const THEMES = [...BUILT_IN_THEMES];
const skinVars = new Map();
const appliedSkinVars = new Set();

const lum = (hex) => {
  let h = hex.slice(1); if (h.length <= 4) h = [...h.slice(0, 3)].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => { const v = parseInt(h.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #rgb / #rrggbb colours. */
export function contrast(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

export function validateSkin(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const id = String(s.id || '');
  if (!(BUILT_IN_IDS.has(id) || /^remote-[a-z0-9]+(?:-[a-z0-9]+){0,5}$/.test(id))) return null;
  const vars = Object.fromEntries(Object.entries(s.vars || {}).filter(([k, v]) =>
    THEME_VARS.has(k) && typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v)));
  if (!Object.keys(vars).length) return null;
  // an unreadable skin (text the colour of the background) could lock a user out of Settings: refuse it
  for (const bg of ['--bg', '--panel']) if (vars['--text'] && vars[bg] && contrast(vars['--text'], vars[bg]) < 3) return null;
  const swatch = Array.isArray(s.swatch) ? s.swatch.filter((v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v)).slice(0, 4) : [];
  return {
    id, name: String(s.name || id).slice(0, 40), desc: String(s.desc || 'Downloadable OpenDJ skin').slice(0, 100),
    swatch: swatch.length ? swatch : [vars['--bg'] || '#101318', vars['--panel'] || '#20252c', vars['--accent'] || '#49aaff', vars['--deck2'] || '#f3a74f'],
    vars,
  };
}

function installSkinCatalog(list) {
  skinVars.clear();
  THEMES.splice(0, THEMES.length, ...BUILT_IN_THEMES);
  for (const raw of list.slice(0, 50)) {
    const skin = validateSkin(raw);
    if (!skin) continue;
    skinVars.set(skin.id, skin.vars);
    const index = THEMES.findIndex((t) => t.id === skin.id);
    if (index >= 0) THEMES[index] = { ...THEMES[index], name: skin.name, desc: skin.desc, swatch: skin.swatch };
    else THEMES.push({ id: skin.id, name: skin.name, desc: skin.desc, swatch: skin.swatch });
  }
}

try {
  const cached = JSON.parse(localStorage.getItem(THEME_CACHE_KEY) || 'null');
  if (Array.isArray(cached?.skins)) installSkinCatalog(cached.skins);
} catch { /* storage is optional */ }

export async function refreshSkinCatalog() {
  const ctl = new AbortController(), timeout = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(SKIN_CATALOG_URL, { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: ctl.signal });
    if (!res.ok) throw new Error(`Skin catalogue returned HTTP ${res.status}`);
    // colours only (validated below), and a size cap: a catalogue is a few KB
    if (Number(res.headers.get('content-length')) > MAX_CATALOG_BYTES) throw new Error('Skin catalogue is too large');
    const raw = await res.text();
    if (raw.length > MAX_CATALOG_BYTES) throw new Error('Skin catalogue is too large');
    let catalog; try { catalog = JSON.parse(raw); } catch { throw new Error('Skin catalogue is not valid JSON'); }
    if (catalog?.schema !== 1 || !Array.isArray(catalog.skins)) throw new Error('Skin catalogue format is not supported');
    const skins = catalog.skins.map(validateSkin).filter(Boolean).slice(0, 50);
    if (!skins.length) throw new Error('No valid skins were found in the catalogue');
    installSkinCatalog(skins);
    try { localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ schema: 1, version: Number(catalog.version) || 1, skins })); } catch { /* storage may be full or disabled */ }
    window.dispatchEvent(new Event('opendj-skins-updated'));
    return { count: skins.length, version: Number(catalog.version) || 1 };
  } finally { clearTimeout(timeout); }
}

let cache = new Map();
export function cssVar(name) {
  if (!cache.has(name)) cache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000');
  return cache.get(name);
}

export function applyTheme(settings) {
  const root = document.documentElement;
  const theme = THEMES.some((t) => t.id === settings.theme) ? settings.theme : 'midnight';
  root.classList.add('theme-switching');
  root.dataset.theme = BUILT_IN_IDS.has(theme) ? theme : 'midnight';
  for (const name of appliedSkinVars) root.style.removeProperty(name);
  appliedSkinVars.clear();
  for (const [name, value] of Object.entries(skinVars.get(theme) || {})) {
    root.style.setProperty(name, value); appliedSkinVars.add(name);
  }
  // optional custom accent colour on top of any theme
  if (settings.accentColor) root.style.setProperty('--accent', settings.accentColor); else root.style.removeProperty('--accent');
  // never scale beyond what keeps a usable 1100x700 effective window. Phones and small tablets (the compact
  // layouts in css/mobile.css) are laid out at their real size instead of being shrunk to fit the desktop layout.
  const want = (settings.uiScale || 100) / 100;
  const compact = innerWidth < 900 || innerHeight < 560;
  // touch tablets in landscape (iPad 1024-1366 px): the desktop layout, but never shrunk below 100 % and with
  // finger-sized controls (css/mobile.css html.tablet)
  const tablet = !compact && !!globalThis.matchMedia?.('(pointer: coarse)').matches && innerWidth <= 1366;
  // Shrinking (< 100 %) stops at a 1100x700 effective window; enlarging (> 100 %) stops at 1280x700, so a larger
  // interface size never squeezes the desktop layout into its narrowest form (1600x900 at 125 % stays 1280 wide).
  const z = compact ? Math.max(0.5, Math.min(want, 1.5))
    : tablet ? Math.max(1, Math.min(want, innerWidth / 1024, innerHeight / 700))
    : want > 1 ? Math.max(1, Math.min(want, Math.max(1, Math.min(innerWidth / 1280, innerHeight / 700))))
    : Math.max(0.5, Math.min(want, innerWidth / 1100, innerHeight / 700));
  root.classList.toggle('compact', compact);
  root.classList.toggle('tablet', tablet);
  root.classList.toggle('touch', !!globalThis.matchMedia?.('(pointer: coarse)').matches);
  root.style.zoom = String(z);
  root.style.setProperty('--ui-zoom', String(z)); // layout heights divide by this so the page still fits the window
  root.classList.toggle('zoom-large', z > 1.05);
  // short / narrow desktop windows squeeze the desktop layout (css/performance.css); compact screens have their own
  const effH = compact ? Infinity : innerHeight / z;
  root.classList.toggle('h1250', effH >= 1250 && effH !== Infinity); root.classList.toggle('h920', effH <= 920); root.classList.toggle('h860', effH <= 860); root.classList.toggle('h800', effH <= 800);
  const effW = compact ? Infinity : innerWidth / z;
  root.classList.toggle('w1500', effW <= 1500); root.classList.toggle('w1400', effW <= 1400); root.classList.toggle('w1300', effW <= 1300); root.classList.toggle('w1200', effW <= 1200);
  if (!applyTheme._resize) { applyTheme._resize = true; let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => applyTheme(applyTheme._last), 150); }); }
  applyTheme._last = settings;
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  cache = new Map();
  window.dispatchEvent(new Event('opendj-theme'));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}
