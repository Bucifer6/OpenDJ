// Mixer settings writes from the UI and controllers: settings.mixer is merged, saved, and applied to the engine.
// The legacy settings.crossfaderCurve is kept in step (nearest of smooth / constant / sharp) for code that still reads it.
import { legacyXfName } from '../audio/curves.js';

export function updateMixer(app, patch) {
  const next = { ...(app.settings.mixer || {}), ...patch };
  if ('xfCurve' in patch) { const leg = legacyXfName(next.xfCurve); if (app.settings.crossfaderCurve !== leg) app.setSetting('crossfaderCurve', leg); }
  app.setSetting('mixer', next); // sets app.settings (and engine.settings) synchronously, then saves
  app.engine.settings.mixer = next;
  app.engine.applyMixerConfig();
}
