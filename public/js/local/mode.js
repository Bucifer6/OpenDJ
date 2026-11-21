// Which backend the UI talks to, decided once at startup:
//   - inside the iOS / Android app (Capacitor native platform): the on-device backend (public/js/local/)
//   - with ?local=1 in a desktop browser: the same on-device backend (OPFS + IndexedDB), for testing without a phone
//   - otherwise: the OpenDJ HTTP server, as before (desktop app, `npm run web`, Docker)
const params = new URLSearchParams(globalThis.location?.search || '');
const cap = globalThis.Capacitor;

export const native = !!cap?.isNativePlatform?.();
export const os = native ? (cap.getPlatform?.() || 'native') : 'web';
export const localMode = native || params.get('local') === '1';
