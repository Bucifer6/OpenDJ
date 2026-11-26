const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('opendjNative', {
  isElectron: true,
  // local Ollama planning: the main process validates everything and answers { ok, order, intro } / { ok: false, error }
  planSet: async (request) => { const r = await ipcRenderer.invoke('local-dj-plan', request); if (!r?.ok) throw new Error(r?.error || 'Local planning failed'); return { order: r.order, intro: r.intro, model: r.model }; },
  planModels: () => ipcRenderer.invoke('local-dj-models'),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  pickFiles: (filters) => ipcRenderer.invoke('pick-files', filters),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  setPowerLock: (on) => ipcRenderer.invoke('gig-power-lock', !!on),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
  // "Update now": the main process picks, downloads, verifies and runs the installer; the page can only ask
  update: {
    info: () => ipcRenderer.invoke('update-info'),
    download: () => ipcRenderer.invoke('update-download'),
    install: () => ipcRenderer.invoke('update-install'),
    cancel: () => ipcRenderer.invoke('update-cancel'),
    onProgress: (cb) => { const h = (_e, p) => cb({ received: Number(p?.received) || 0, total: Number(p?.total) || 0 }); ipcRenderer.on('update-progress', h); return () => ipcRenderer.removeListener('update-progress', h); },
  },
});
