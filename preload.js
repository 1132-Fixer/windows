const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  scanFiles: () => ipcRenderer.invoke('scan-files'),
  deleteFiles: (filePaths) => ipcRenderer.invoke('delete-files', filePaths),
  launchZoom: () => ipcRenderer.invoke('launch-zoom'),
  showConfirmDialog: (message) => ipcRenderer.invoke('show-confirm-dialog', message),
  showSuccess: (count) => ipcRenderer.invoke('show-success', count),
  quitApp: () => ipcRenderer.invoke('quit-app')
});
