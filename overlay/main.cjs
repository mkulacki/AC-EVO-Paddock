// Desktop overlay for the Paddock HUD: a transparent, always-on-top, click-through window over the game.
// Works when AC EVO runs in borderless/windowed mode (not exclusive fullscreen, not VR).
// Start with: npm run overlay   (Paddock itself must be running: npm start)
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
const path = require('node:path');

const port = Number(process.env.PORT) || 8080;
const url = `http://127.0.0.1:${port}/hud.html`;

app.disableHardwareAcceleration(); // transparent windows are more reliable without it on some GPUs

function create() {
  const { bounds } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    transparent: true, frame: false, resizable: false, movable: false, hasShadow: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // clicks go to the game except over the panel
  ipcMain.on('interactive', (_e, on) => win.setIgnoreMouseEvents(!on, { forward: true }));

  const load = () => win.loadURL(url).catch(() => setTimeout(load, 2000)); // wait for Paddock
  load();

  // Ctrl+Shift+H hides/shows the overlay
  globalShortcut.register('Control+Shift+H', () => (win.isVisible() ? win.hide() : win.showInactive()));
  console.log(`Paddock HUD overlay: ${url}  (Ctrl+Shift+H hide/show, close this window to quit)`);
}

app.whenReady().then(create);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
