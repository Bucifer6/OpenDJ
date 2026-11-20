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
  root.style.zoom = String((settings.uiScale || 100) / 100);
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  cache = new Map();
  window.dispatchEvent(new Event('opendj-theme'));
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}
