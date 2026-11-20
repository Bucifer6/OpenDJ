// HTTP API for lighting. Registered from server/index.js with registerLightingRoutes({ route, library, emit }).
import { LightingEngine } from './engine.js';
import { TEMPLATES, EFFECTS, PHRASES, GROUPS, CHANNEL_KINDS, FIXTURE_TYPES } from './show.js';
import { hueDiscover, huePair, hueLights } from './outputs.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// The Hue bridge key is a bearer credential for the user's lights: the UI only learns that one exists.
export const HUE_REDACTED = '••••••';
const redact = (config) => {
  const hue = config?.outputs?.hue;
  return hue?.username ? { ...config, outputs: { ...config.outputs, hue: { ...hue, username: HUE_REDACTED } } } : config;
};

export function registerLightingRoutes({ route, library, emit = () => {}, fetch: f = globalThis.fetch }) {
  const engine = new LightingEngine({ config: library.settings.lighting, emit, fetch: f });
  const save = () => { library.updateSettings({ lighting: engine.config }); emit('lighting', { config: true }); };
  let saveT = null;
  const saveSoon = () => { clearTimeout(saveT); saveT = setTimeout(save, 800); saveT.unref?.(); };

  route('GET', '/api/lighting', () => ({
    config: redact(engine.config), live: engine.live, status: engine.status(),
    meta: { templates: TEMPLATES, effects: EFFECTS, phrases: PHRASES, groups: GROUPS, channels: CHANNEL_KINDS, types: FIXTURE_TYPES },
  }));
  route('PUT', '/api/lighting/config', async ({ body }) => {
    if (!body || typeof body !== 'object') throw bad('Expected a lighting config');
    const hue = body.outputs?.hue, cur = engine.config.outputs?.hue;
    if (hue && (hue.username === HUE_REDACTED || (!hue.username && cur?.username && hue.bridge === cur.bridge && !('username' in hue)))) {
      body = { ...body, outputs: { ...body.outputs, hue: { ...hue, username: cur?.username || '' } } };
    }
    engine.setConfig(body);
    save();
    return redact(engine.config);
 }, { bodyLimit: 8 * 2 ** 20 }); // rigs with many fixtures / cue lists
  // Renderer -> server music feed (10-20 Hz). Kept tiny.
  route('POST', '/api/lighting/state', async ({ body }) => { if (body && typeof body === 'object') engine.setState(body); return { ok: 1 }; });
  route('POST', '/api/lighting/live', async ({ body }) => {
    const r = engine.setLive(body);
    if (r.showChanged) saveSoon();
    return { live: engine.live, show: engine.config.show };
  });
  route('POST', '/api/lighting/test', async ({ body }) => { engine.test(Math.min(5000, Number(body?.ms) || 1000)); return { ok: true }; });
  route('GET', '/api/lighting/status', () => engine.status());
  // Live stream: ?preview=1 for the panel's fixture preview, ?dmx=<universe> for the renderer's USB DMX widget.
  route('GET', '/api/lighting/stream', ({ res, query }) => {
    engine.subscribe(res, { preview: query.get('preview') === '1', dmx: Number(query.get('dmx')) || 0 });
    return undefined;
  });
  route('GET', '/api/lighting/hue/discover', async () => hueDiscover({ fetch: f }));
  route('POST', '/api/lighting/hue/pair', async ({ body }) => {
    const bridge = String(body?.bridge || '').trim();
    if (!/^[\w.:-]+$/.test(bridge)) throw bad('Enter the bridge IP address');
    try {
      const username = await huePair(bridge, { fetch: f });
      engine.setConfig({ ...engine.config, outputs: { ...engine.config.outputs, hue: { ...engine.config.outputs.hue, bridge, username } } });
      save();
      return { username: username ? HUE_REDACTED : '' };
    } catch (e) { throw bad(e.message); }
  });
  route('GET', '/api/lighting/hue/lights', async () => {
    const h = engine.config.outputs.hue;
    if (!h.bridge || !h.username) throw bad('Pair with a Hue bridge first');
    try { return await hueLights(h.bridge, h.username, { fetch: f }); } catch (e) { throw bad(e.message, 502); }
  });
  return engine;
}
