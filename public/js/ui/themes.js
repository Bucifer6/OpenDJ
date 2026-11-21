// App themes. Each theme overrides CSS custom properties (see public/css/themes.css); canvases read them via cssVar().
export const THEMES = [
  { id: 'midnight', name: 'Midnight', desc: 'Default dark blue-grey', swatch: ['#0b0d10', '#191d23', '#3ea6ff', '#ff8a3d'] },
  { id: 'graphite', name: 'Graphite', desc: 'Neutral studio grey', swatch: ['#121212', '#1e1e1e', '#e0e0e0', '#ffb347'] },
  { id: 'club', name: 'Club Red', desc: 'Dark with red accents (low light)', swatch: ['#0c0708', '#1b1113', '#ff2e4d', '#ffb020'] },
  { id: 'neon', name: 'Neon', desc: 'Synthwave purple & cyan', swatch: ['#0b0614', '#1a1030', '#00e5ff', '#ff3df2'] },
  { id: 'ocean', name: 'Ocean', desc: 'Deep navy & teal', swatch: ['#06121a', '#0e2230', '#21d4c4', '#5aa9ff'] },
  { id: 'gold', name: 'Black & Gold', desc: 'Premium black with gold', swatch: ['#0a0a0a', '#181612', '#e8b84a', '#d0d0d0'] },
  { id: 'forest', name: 'Forest', desc: 'Dark green, easy on the eyes', swatch: ['#08100c', '#13211a', '#3ddc84', '#f2c94c'] },
  { id: 'light', name: 'Daylight', desc: 'Bright theme for outdoor & daytime gigs', swatch: ['#eef1f5', '#ffffff', '#0a6cff', '#e8590c'] },
  { id: 'contrast', name: 'High Contrast', desc: 'Maximum legibility (sunlight, accessibility)', swatch: ['#000000', '#000000', '#ffff00', '#00ffff'] },
];

let cache = new Map();
export function cssVar(name) {
  if (!cache.has(name)) cache.set(name, getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000');
  return cache.get(name);
}

export function applyTheme(settings) {
  const root = document.documentElement;
  const theme = THEMES.some((t) => t.id === settings.theme) ? settings.theme : 'midnight';
  root.classList.add('theme-switching');
  root.dataset.theme = theme;
  // optional custom accent colour on top of any theme
  if (settings.accentColor) root.style.setProperty('--accent', settings.accentColor); else root.style.removeProperty('--accent');
  // never scale beyond what keeps a usable 1100x700 effective window. Phones and small tablets (the compact
  // layouts in css/mobile.css) are laid out at their real size instead of being shrunk to fit the desktop layout.
  const want = (settings.uiScale || 100) / 100;
  const compact = innerWidth < 900 || innerHeight < 560;
  // Shrinking (< 100 %) stops at a 1100x700 effective window; enlarging (> 100 %) stops at 1280x700, so a larger
  // interface size never squeezes the desktop layout into its narrowest form (1600x900 at 125 % stays 1280 wide).
  const z = compact ? Math.max(0.5, Math.min(want, 1.5))
    : want > 1 ? Math.max(1, Math.min(want, Math.max(1, Math.min(innerWidth / 1280, innerHeight / 700))))
    : Math.max(0.5, Math.min(want, innerWidth / 1100, innerHeight / 700));
  root.classList.toggle('compact', compact);
  root.classList.toggle('touch', !!globalThis.matchMedia?.('(pointer: coarse)').matches);
  root.style.zoom = String(z);
  root.style.setProperty('--ui-zoom', String(z)); // layout heights divide by this so the page still fits the window
  root.classList.toggle('zoom-large', z > 1.05);
  // short / narrow desktop windows squeeze the desktop layout (css/performance.css); compact screens have their own
  const effH = compact ? Infinity : innerHeight / z;
  root.classList.toggle('h920', effH <= 920); root.classList.toggle('h860', effH <= 860); root.classList.toggle('h800', effH <= 800);
  const effW = compact ? Infinity : innerWidth / z;
  root.classList.toggle('w1500', effW <= 1500); root.classList.toggle('w1400', effW <= 1400); root.classList.toggle('w1300', effW <= 1300); root.classList.toggle('w1200', effW <= 1200);
  if (!applyTheme._resize) { applyTheme._resize = true; let t; addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => applyTheme(applyTheme._last), 150); }); }
  applyTheme._last = settings;
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  cache = new Map();
  window.dispatchEvent(new Event('opendj-theme'));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}
