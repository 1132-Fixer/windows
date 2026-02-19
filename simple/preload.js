const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  checkZoomInstalled: () => ipcRenderer.invoke('check-zoom-installed'),
  quickResetReinstall: () => ipcRenderer.invoke('quick-reset-reinstall'),
  installZoomOnly: () => ipcRenderer.invoke('install-zoom-only'),
  onResetProgress: (callback) => ipcRenderer.on('reset-progress', (event, data) => callback(data)),
  quitApp: () => ipcRenderer.invoke('quit-app')
});
