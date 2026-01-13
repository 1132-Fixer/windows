/**
 * 1132 Remover - Preload Script
 * Exposes safe IPC methods to renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // === RESET OPERATIONS ===
  fullReset: (options) => ipcRenderer.invoke('full-reset', options),
  quickReset: () => ipcRenderer.invoke('quick-reset'),
  audit: () => ipcRenderer.invoke('audit'),

  // === ZOOM OPERATIONS ===
  killZoom: () => ipcRenderer.invoke('kill-zoom'),
  launchZoom: () => ipcRenderer.invoke('launch-zoom'),
  checkZoom: () => ipcRenderer.invoke('check-zoom'),

  // === DIALOGS ===
  showConfirm: (message) => ipcRenderer.invoke('show-confirm-dialog', message),
  showError: (message) => ipcRenderer.invoke('show-error-dialog', message),
  showSuccess: (message) => ipcRenderer.invoke('show-success-dialog', message),

  // === APP CONTROL ===
  quitApp: () => ipcRenderer.invoke('quit-app'),
  getLogPath: () => ipcRenderer.invoke('get-log-path'),
  getAllLogs: () => ipcRenderer.invoke('get-all-logs'),
  openLogFolder: () => ipcRenderer.invoke('open-log-folder'),
  saveLog: (content) => ipcRenderer.invoke('save-log', content),

  // === EVENT LISTENERS ===
  onProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('reset-progress', handler);
    return () => ipcRenderer.removeListener('reset-progress', handler);
  },

  onLog: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  }
});
