// Desktop app: runs the Paddock server in-process and shows the UI in its own window (like Content Manager).
// Closing the window keeps it in the tray, so laps are still recorded. The desktop overlay is built in.
//   dev:       npm run app
//   package:   npm run dist   ->  builds dist\win-unpacked, then desktop/deploy.mjs installs it to
//              ..\AC EVO Paddock\  (portable; data\ sits next to the .exe and survives updates)
const { app, BrowserWindow, Tray, Menu, dialog, shell, ipcMain, globalShortcut, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BASE = app.isPackaged ? path.dirname(app.getPath('exe')) : ROOT;
const DATA = path.resolve(process.env.ACEVO_DATA || path.join(BASE, 'data'));
const ICON = path.join(__dirname, 'icon.ico');
const STATE_FILE = path.join(DATA, 'window.json');
const LOG_FILE = path.join(DATA, 'logs', 'paddock.log');

// ------------------------------------------------------------------ portable: everything under data\
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
process.env.ACEVO_DATA = DATA;
app.setPath('userData', path.join(DATA, 'electron')); // browser storage, cache: not in %APPDATA%
app.setAppUserModelId('local.acevo.paddock');

// ------------------------------------------------------------------ log file (a packaged app has no console)
try { fs.renameSync(LOG_FILE, LOG_FILE.replace(/\.log$/, '.prev.log')); } catch { /* first run */ }
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    try { orig(...a); } catch { /* no console attached */ }
    logStream.write(`${new Date().toISOString().slice(11, 23)} ${level === 'log' ? '' : level.toUpperCase() + ' '}${a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
  };
}
process.on('uncaughtException', (e) => console.error('uncaught:', e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e));

// ------------------------------------------------------------------ one instance only
if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.on('second-instance', () => showMain());

let win = null, overlay = null, tray = null, quitting = false, baseUrl = '';
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* defaults */ }
const saveState = () => { try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* ignore */ } };

// ------------------------------------------------------------------ main window
function boundsVisible(b) {
  return b && screen.getAllDisplays().some(({ workArea: w }) => b.x < w.x + w.width - 100 && b.x + b.width > w.x + 100 && b.y >= w.y - 20 && b.y < w.y + w.height - 100);
}
function createMain() {
  const b = boundsVisible(state.bounds) ? state.bounds : { width: 1500, height: 940 };
  win = new BrowserWindow({
    ...b, minWidth: 900, minHeight: 600, show: false, icon: ICON, title: 'AC EVO Paddock',
    backgroundColor: '#08090b', autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  if (state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(baseUrl);

  // links that open a new window (AI summary, HUD in browser, external sites) go to the default browser
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(baseUrl)) { e.preventDefault(); shell.openExternal(url); } });
  win.webContents.on('render-process-gone', (_e, d) => { console.error('UI process gone:', d.reason); if (!quitting) setTimeout(() => win?.reload(), 1000); });

  // no menu bar: keep the useful browser shortcuts
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const wc = win.webContents, ctrl = i.control || i.meta;
    if (i.key === 'F5' || (ctrl && i.key.toLowerCase() === 'r')) wc.reload();
    else if (i.key === 'F12' || (ctrl && i.shift && i.key.toLowerCase() === 'i')) wc.toggleDevTools();
    else if (i.key === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (ctrl && (i.key === '=' || i.key === '+')) wc.setZoomLevel(wc.getZoomLevel() + 0.5);
    else if (ctrl && i.key === '-') wc.setZoomLevel(wc.getZoomLevel() - 0.5);
    else if (ctrl && i.key === '0') wc.setZoomLevel(0);
    else if (ctrl && i.key.toLowerCase() === 'f') wc.executeJavaScript('document.querySelector("input[type=search],.search input")?.focus()').catch(() => {});
    else return;
    e.preventDefault();
  });

  const remember = () => { state.maximized = win.isMaximized(); if (!state.maximized && !win.isMinimized() && !win.isFullScreen()) state.bounds = win.getBounds(); };
  win.on('resize', remember); win.on('move', remember);
  win.on('close', (e) => {
    remember(); saveState();
    if (quitting) return;
    e.preventDefault(); win.hide(); // keep recording in the tray
    if (!state.trayHintShown) {
      state.trayHintShown = true; saveState();
      tray?.displayBalloon({ iconType: 'info', title: 'AC EVO Paddock is still running', content: 'Laps keep being recorded. Right-click the tray icon to quit.' });
    }
  });
}
function showMain() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

// ------------------------------------------------------------------ desktop overlay (transparent, click-through)
// Works when AC EVO runs borderless/windowed (not exclusive fullscreen, not VR). Ctrl+Shift+H hides/shows it.
ipcMain.on('interactive', (_e, on) => overlay?.setIgnoreMouseEvents(!on, { forward: true }));
function setOverlay(on) {
  if (!on) { overlay?.destroy(); return; }
  if (overlay) return;
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, resizable: false, movable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(ROOT, 'overlay', 'preload.cjs'), contextIsolation: true },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadURL(`${baseUrl}hud.html`);
  globalShortcut.register('Control+Shift+H', () => (overlay.isVisible() ? overlay.hide() : overlay.showInactive()));
  overlay.on('closed', () => { overlay = null; globalShortcut.unregister('Control+Shift+H'); state.overlay = false; saveState(); updateTray(); });
  state.overlay = true; saveState(); updateTray();
}

// ------------------------------------------------------------------ in-game HUD install (src/tools/install-mod.js)
function installHud(remove) {
  const args = [path.join(ROOT, 'src', 'tools', 'install-mod.js'), ...(remove ? ['--remove'] : [])];
  execFile(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }, (err, stdout, stderr) => {
    const text = `${stdout}${stderr}`.trim();
    console.log(`[install-mod] ${text}`);
    dialog.showMessageBox(win?.isVisible() ? win : null, {
      type: err ? 'error' : stderr ? 'warning' : 'info', title: 'Paddock HUD',
      message: err ? 'Could not change the in-game HUD' : remove ? 'In-game HUD removed' : 'In-game HUD installed', detail: text,
    });
  });
}

// ------------------------------------------------------------------ tray
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open AC EVO Paddock', click: showMain },
    { label: 'Desktop overlay', type: 'checkbox', checked: !!overlay, click: (m) => setOverlay(m.checked) },
    { type: 'separator' },
    { label: 'In-game HUD', submenu: [
      { label: 'Install / update (game must be closed)', click: () => installHud(false) },
      { label: 'Remove', click: () => installHud(true) },
    ] },
    { label: 'Open data folder', click: () => shell.openPath(DATA) },
    { label: 'Open log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}
function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip('AC EVO Paddock');
  tray.on('click', showMain);
  tray.on('double-click', showMain);
  updateTray();
}

// ------------------------------------------------------------------ startup
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stay in the tray */ });

app.whenReady().then(async () => {
  console.log(`AC EVO Paddock desktop ${app.getVersion()} (Electron ${process.versions.electron}), data: ${DATA}`);
  // "Developer: restart" in the page (src/server.js restartApp): start the whole app again
  globalThis.__trainerRelaunch = () => { quitting = true; saveState(); app.relaunch(); app.exit(0); };
  let port;
  try {
    const server = await import(pathToFileURL(path.join(ROOT, 'src', 'server.js')).href);
    port = await server.ready;
  } catch (e) {
    console.error('server failed to start:', e);
    const busy = e.code === 'EADDRINUSE';
    dialog.showErrorBox('AC EVO Paddock could not start', busy
      ? `Port ${e.port || ''} is already in use.\n\nIs Paddock already running from start.bat / npm start? Close it and start the app again.`
      : `${e.message}\n\nDetails are in ${LOG_FILE}`);
    quitting = true; app.exit(1); return;
  }
  baseUrl = `http://127.0.0.1:${port}/`;
  createTray();
  createMain();
  if (state.overlay) setOverlay(true);
});
