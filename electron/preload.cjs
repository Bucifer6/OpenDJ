const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('opendjNative', {
  isElectron: true,
  planSet: request => ipcRenderer.invoke('local-dj-plan', request),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  pickFiles: (filters) => ipcRenderer.invoke('pick-files', filters),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
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
