const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('opendjNative', {
  isElectron: true,
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  pickFiles: (filters) => ipcRenderer.invoke('pick-files', filters),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return null; } },
});
