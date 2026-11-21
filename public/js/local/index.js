// Starts the on-device backend: picks the storage for this platform (Capacitor Filesystem in the app, OPFS in
// browsers), loads the vendor bundle (music-metadata, fast-xml-parser, Capacitor core) and wires native plugins.
import { createLocalBackend } from './backend.js';
import { IdbKV } from './storage/kv.js';
import { createFileStore } from './storage/fs.js';
import { capacitorFetch } from './sources.js';
import { setNativeShare, makeNativeShare } from './share.js';
import { startMobileRuntime } from './mobile-runtime.js';
import { APP_VERSION } from '../platform.js';

const canPlayType = (type) => { try { return document.createElement('audio').canPlayType(type) !== ''; } catch { return false; } };

export async function startLocal({ native = false } = {}) {
  const vendor = await import('../../vendor/opendj-vendor.js');
  const kv = new IdbKV('opendj');
  let fs, http = globalThis.fetch.bind(globalThis), download = null, plugins = {};
  if (native) {
    const { Capacitor, registerPlugin, CapacitorHttp } = vendor;
    for (const n of ['Filesystem', 'Share', 'FilePicker', 'FileTransfer', 'KeepAwake', 'App', 'OpenDJAudio']) plugins[n] = registerPlugin(n);
    fs = await createFileStore({ native: { Filesystem: plugins.Filesystem, convertFileSrc: (u) => Capacitor.convertFileSrc(u) } });
    http = capacitorFetch(CapacitorHttp);
    download = async ({ url, headers, dest, onProgress }) => {
      const sub = onProgress ? await plugins.FileTransfer.addListener('progress', (p) => { if (p.url === url) onProgress(p.bytes, p.contentLength); }).catch(() => null) : null;
      try { await plugins.FileTransfer.downloadFile({ url, path: fs.fileUri(dest), headers, progress: !!onProgress }); } finally { sub?.remove?.(); }
    };
    setNativeShare(makeNativeShare({ fs, Share: plugins.Share }));
  } else {
    fs = await createFileStore();
  }
  const platform = { native, os: native ? vendor.Capacitor.getPlatform() : 'web' };
  const backend = await createLocalBackend({
    kv, fs, mm: vendor, XMLParser: vendor.XMLParser, http, download, canPlayType, platform, version: APP_VERSION,
    getEngine: () => globalThis.opendj?.engine,
  });
  backend.plugins = plugins;
  backend.platform = platform;
  if (native) {
    // Native picker imports: the plugin copies the picked file into app storage (no trip through the JS bridge);
    // if that fails, the file is streamed in through the WebView's file server instead.
    backend.nativeImport = {
      copyFile: (file, dest) => plugins.FilePicker.copyFile({ from: file.path, to: fs.fileUri(dest), overwrite: true }),
      readBlob: async (file) => (await fetch(file.webPath || vendor.Capacitor.convertFileSrc(file.path))).blob(),
    };
    backend.pickFiles = async ({ types } = {}) => (await plugins.FilePicker.pickFiles({ types, limit: 0 })).files || [];
    backend.pickText = async ({ types } = {}) => {
      const [f] = (await plugins.FilePicker.pickFiles({ types, limit: 1 })).files || [];
      return f ? { name: f.name, text: await (await fetch(f.webPath || vendor.Capacitor.convertFileSrc(f.path))).text() } : null;
    };
  }
  // keep the data safe when the app is backgrounded / the page is closed
  const flush = () => { backend.flush().catch(() => {}); };
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  startMobileRuntime({ plugins, native, os: platform.os });
  return backend;
}
