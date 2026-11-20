// Broadcast status text (pure, unit-tested).
export const hms = (s) => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`; };

/**
 * " · 1:23 · 128 kbps · 3 listeners" for an output that is ON AIR. Until bytes actually flow (the first seconds:
 * the encoder is starting, the server is accepting) it says "connecting…" instead of a misleading "0 kbps".
 */
export function liveDetail(o) {
  if (o.state !== 'live') return '';
  const flowing = (o.bytes || 0) > 0 && (o.kbps || 0) > 0;
  const rate = flowing ? `${o.kbps} kbps` : 'connecting…';
  const listeners = o.listeners != null ? ` · ${o.listeners} listener${o.listeners === 1 ? '' : 's'}` : '';
  return ` · ${hms(o.uptime)} · ${rate}${flowing ? listeners : ''}`;
}
