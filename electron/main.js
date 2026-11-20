// Electron shell: starts the local library/stream server and opens the UI.
import { app, BrowserWindow, dialog, ipcMain, session, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;

// Let audio start without a click (DJ software needs it) and keep timers precise when the window is hidden.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

async function createWindow() {
  server = await start({ port: 0, dataDir: path.join(app.getPath('userData'), 'library') });
  const allowed = new Set(['midi', 'midiSysex', 'media', 'speaker-selection', 'hid', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
  session.defaultSession.setDevicePermissionHandler(() => true);

  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0b0d10', title: 'OpenDJ', show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));
  await win.loadURL(server.url);
}

ipcMain.handle('pick-folder', async (_e, title) => {
  const r = await dialog.showOpenDialog({ title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-files', async (_e, filters) => {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { server?.shutdown(); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
