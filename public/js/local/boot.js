// Imported first by api.js. In local mode (the mobile app, or ?local=1) it installs the shim right away and starts
// the on-device backend in the background; requests wait for it. In server mode it does nothing.
import { localMode, native } from './mode.js';
import { installShim } from './shim.js';

export const local = { enabled: localMode, native, backend: null, ready: null, error: null };

if (localMode) {
  local.ready = import('./index.js').then((m) => m.startLocal({ native })).then((b) => { local.backend = b; return b; }, (e) => {
    local.error = e;
    console.error('[opendj] the on-device backend could not start', e);
    const boot = document.getElementById('boot');
    if (boot) boot.textContent = `OpenDJ could not open its storage: ${e.message}`;
    throw e;
  });
  installShim(local.ready);
}
