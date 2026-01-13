const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Zoom user management
  checkZoomUser: () => ipcRenderer.invoke('check-zoom-user'),
  createZoomUser: () => ipcRenderer.invoke('create-zoom-user'),
  deleteZoomUser: () => ipcRenderer.invoke('delete-zoom-user'),
  launchZoomAsUser: () => ipcRenderer.invoke('launch-zoom-as-user'),
  resetZoomUser: () => ipcRenderer.invoke('reset-zoom-user'),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Full Reset with options
  fullReset: (options) => ipcRenderer.invoke('full-reset', options),
  onResetProgress: (callback) => ipcRenderer.on('reset-progress', (event, data) => callback(data)),

  // Legacy functions
  scanFiles: () => ipcRenderer.invoke('scan-files'),
  deleteFiles: (filePaths) => ipcRenderer.invoke('delete-files', filePaths),
  killZoom: () => ipcRenderer.invoke('kill-zoom'),
  launchZoom: () => ipcRenderer.invoke('launch-zoom'),
  showConfirmDialog: (message) => ipcRenderer.invoke('show-confirm-dialog', message)
});
