// Haptic feedback for the touch platter and scratch view (T8). Native apps use @capacitor/haptics (Taptic Engine on
// iPhone, the vibrator on Android); browsers fall back to navigator.vibrate where it exists (Android Chrome; iOS
// Safari has none); desktop is a no-op. Levels: 'off' | 'subtle' | 'full' | 'auto' (subtle on phones, off elsewhere).
// Every call is throttled (40 calls a second at most) and never throws.
import { platform } from '../platform.js';

const MIN_GAP_MS = 25; // 40 Hz
let plugin = null, pluginTried = false, last = 0, level = 'auto';
/** Test hook / mock: receives every call that passes the level and throttle checks. */
export const hapticsLog = { calls: 0, sink: null };

export const isPhone = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && Math.min(screen?.width || 0, screen?.height || 0) < 820;
/** The level in effect: 'off' | 'subtle' | 'full'. */
export function hapticsLevel() { return level === 'auto' ? (isPhone() ? 'subtle' : 'off') : level; }
export function setHapticsLevel(l) { level = ['off', 'subtle', 'full', 'auto'].includes(l) ? l : 'auto'; }

async function nativePlugin() {
  if (pluginTried) return plugin;
  pluginTried = true;
  if (!platform.native) return null;
  try {
    const { registerPlugin, Capacitor } = await import('../../vendor/opendj-vendor.js');
    if (Capacitor?.isPluginAvailable && !Capacitor.isPluginAvailable('Haptics')) return null; // app built without it
    plugin = registerPlugin('Haptics');
  } catch { plugin = null; }
  return plugin;
}

function send(kind, arg, min = 'subtle') {
  const lv = hapticsLevel();
  if (lv === 'off' || (min === 'full' && lv !== 'full')) return false;
  const now = performance.now();
  if (now - last < MIN_GAP_MS) return false;
  last = now;
  hapticsLog.calls++; hapticsLog.sink?.(kind, arg);
  if (plugin || (platform.native && !pluginTried)) {
    nativePlugin().then((p) => {
      if (!p) return;
      try {
        const r = kind === 'tick' ? p.selectionChanged?.() : p.impact?.({ style: arg === 'medium' ? 'MEDIUM' : arg === 'heavy' ? 'HEAVY' : 'LIGHT' });
        r?.catch?.(() => {});
      } catch { /* no haptic engine */ }
    });
    return true;
  }
  try { navigator.vibrate?.(kind === 'tick' ? 4 : arg === 'medium' ? 12 : 7); } catch { /* not allowed */ }
  return true;
}

export const haptics = {
  /** A groove tick while scratching (every 1/16 turn). */
  tick: () => send('tick', null),
  /**
   * A bump: crossing a hot cue while touching ('light', Subtle and Full); beats, crossfader cut edges and scratch-view
   * downbeats pass min 'full' (Full only).
   */
  impact: (style = 'light', min = 'subtle') => send('impact', style, min),
};
