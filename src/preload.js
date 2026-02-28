/**
 * 1132 Fixer - Preload Script
 * Exposes safe IPC methods to renderer
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Reset
  fullReset: (options) => ipcRenderer.invoke('full-reset', options),

  // Zoom
  launchZoom: () => ipcRenderer.invoke('launch-zoom'),

  // Dialogs
  showConfirmDialog: (message) => ipcRenderer.invoke('show-confirm-dialog', message),

  // App
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Progress listener
  onProgress: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('reset-progress', handler);
    return () => ipcRenderer.removeListener('reset-progress', handler);
  },

  // Feedback
  submitFeedback: (type, text) => ipcRenderer.invoke('submit-feedback', type, text),

  // Auto-update
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  }
});
