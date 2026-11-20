export class Emitter {
  constructor() { this._l = new Map(); }
  on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); return () => this._l.get(ev)?.delete(fn); }
  emit(ev, ...a) { for (const fn of this._l.get(ev) || []) { try { fn(...a); } catch (e) { console.error(e); } } }
}
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const fmtTime = (s, neg = false) => {
  if (!isFinite(s)) return '--:--';
  const sign = neg ? '-' : ''; s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), t = Math.floor((s % 1) * 10);
  return `${sign}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${t}`;
};
export const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '');
export const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') e.innerHTML = v;
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
export const dbToGain = (db) => Math.pow(10, db / 20);
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Effective UI zoom (Settings → Interface size sets CSS zoom on <html>). Mouse coordinates and getBoundingClientRect()
 * are in window pixels, but style.left/top inside the zoomed page are multiplied by the zoom: divide by this first.
 */
export function uiZoom() { return parseFloat(document.documentElement.style.zoom) || 1; }
