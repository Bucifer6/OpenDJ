// Electron shell: starts the local library/stream server and opens the UI.
import { app, BrowserWindow, dialog, ipcMain, session, shell, Menu } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let appOrigin = '';
// IPC calls are only accepted from OpenDJ's own top-level page.
const trusted = (e) => { try { return new URL(e.senderFrame.url).origin === appOrigin; } catch { return false; } };

// Let audio start without a click (DJ software needs it) and keep timers precise when the window is hidden.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

async function createWindow() {
  server = await start({ port: 0, dataDir: process.env.OPENDJ_DATA || path.join(app.getPath('userData'), 'library') });
  appOrigin = new URL(server.url).origin;
  const allowed = new Set(['midi', 'midiSysex', 'media', 'speaker-selection', 'hid', 'clipboard-sanitized-write', 'fullscreen', 'serial', 'window-management']);
  // Only OpenDJ's own pages get device permissions, never embedded frames (e.g. the YouTube player).
  const own = (url) => { try { return new URL(url).origin === appOrigin; } catch { return false; } };
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && own(details?.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => allowed.has(perm) && own(origin));
  session.defaultSession.setDevicePermissionHandler((details) => own(details.origin) && ['hid', 'serial'].includes(details.deviceType));
  setupHidChooser(session.defaultSession);
  // USB DMX (Enttec DMX USB Pro-compatible) via Web Serial: prefer FTDI / Enttec / DMX ports
  session.defaultSession.on('select-serial-port', (e, ports, _wc, cb) => {
    e.preventDefault();
    const dmx = ports.filter((x) => /\b(0403|1027)\b|ftdi|enttec|dmx/i.test(`${x.vendorId} ${x.displayName} ${x.portName}`));
    const cands = dmx.length ? dmx : ports;
    if (cands.length <= 1) return cb(cands[0]?.portId || '');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const list = cands.slice(0, 12);
    dialog.showMessageBox(win, { type: 'question', title: 'Connect USB DMX interface', message: 'Choose the serial port of your DMX interface', buttons: [...list.map((x) => x.displayName || x.portName), 'Cancel'], cancelId: list.length, noLink: true })
      .then((r) => cb(r.response < list.length ? list[r.response].portId : ''));
  });

  const win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#0b0d10', title: 'OpenDJ', show: false,
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  // Same-origin pop-ups (video output window) open inside the app; web links open in the browser; everything else is refused.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (own(url)) return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#000', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } } };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  const guard = (e, url) => { if (!own(url)) { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); } };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-redirect', guard);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]));
  await win.loadURL(server.url);
}

// WebHID device chooser (navigator.hid.requestDevice). Chromium shows its own picker; Electron leaves it to us.
// Keyboards, mice and security keys are skipped. One candidate is picked directly, several get a native chooser.
const HID_SKIP = (d) => (d.collections || []).some((c) => (c.usagePage === 1 && (c.usage === 2 || c.usage === 6)) || c.usagePage === 0xf1d0);
function setupHidChooser(ses) {
  let pending = null; // { callback, timer, win }
  const finish = (id) => { if (!pending) return; clearTimeout(pending.timer); const cb = pending.callback; pending = null; cb(id || ''); };
  const choose = async (list, win) => {
    const seen = new Set();
    const cands = list.filter((d) => !HID_SKIP(d)).filter((d) => { const k = `${d.vendorId}:${d.productId}:${d.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!cands.length) return false;
    if (cands.length === 1) { finish(cands[0].deviceId); return true; }
    const label = (d) => `${d.name || 'HID device'} (${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')})`;
    const r = await dialog.showMessageBox(win, { type: 'question', title: 'Connect HID controller', message: 'Choose the controller to connect', buttons: [...cands.slice(0, 12).map(label), 'Cancel'], cancelId: Math.min(cands.length, 12), noLink: true });
    finish(r.response < Math.min(cands.length, 12) ? cands[r.response].deviceId : '');
    return true;
  };
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    finish('');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    pending = { callback, win, timer: setTimeout(() => finish(''), 15000) };
    choose(details.deviceList || [], win).then((ok) => { if (!ok && pending) pending.waiting = true; });
  });
  // the device list can be empty at first: pick the first suitable device that shows up
  ses.on('hid-device-added', (_e, details) => { if (pending?.waiting && details?.device && !HID_SKIP(details.device)) finish(details.device.deviceId); });
}

ipcMain.handle('pick-folder', async (e, title) => {
  if (!trusted(e)) return null;
  const r = await dialog.showOpenDialog({ title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('pick-files', async (e, filters) => {
  if (!trusted(e)) return [];
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'], filters });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('reveal', (e, p) => { if (trusted(e) && typeof p === 'string') shell.showItemInFolder(p); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { server?.shutdown(); app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
