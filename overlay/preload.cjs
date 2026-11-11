const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trainerOverlay', {
  setInteractive: (on) => ipcRenderer.send('interactive', !!on),
});
