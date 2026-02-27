/**
 * 1132 Eliminator - Preload Script
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

  // === ZOOM PREFERENCES ===
  getPrefOptions: () => ipcRenderer.invoke('get-zoom-pref-options'),
  getUserPrefs: () => ipcRenderer.invoke('get-user-zoom-prefs'),
  setUserPrefs: (prefs) => ipcRenderer.invoke('set-user-zoom-prefs', prefs),
  getCurrentPrefs: () => ipcRenderer.invoke('get-current-zoom-prefs'),
  applyPrefs: (options) => ipcRenderer.invoke('apply-zoom-prefs', options),
  verifyPrefs: (options) => ipcRenderer.invoke('verify-zoom-prefs', options),
  applyAndVerify: (options) => ipcRenderer.invoke('apply-and-verify-prefs', options),
  getLastPrefDiff: () => ipcRenderer.invoke('get-last-zoom-pref-diff'),
  detectZoomVersion: () => ipcRenderer.invoke('detect-zoom-version'),
  listPrefTemplates: () => ipcRenderer.invoke('list-zoom-pref-templates'),

  // === SELF-TEST ===
  runSelfTest: () => ipcRenderer.invoke('run-self-test'),

  // === PERSISTENCE SNAPSHOTS & MONITORING ===
  takeSnapshot: (label) => ipcRenderer.invoke('take-snapshot', label),
  listSnapshots: () => ipcRenderer.invoke('list-snapshots'),
  compareSnapshots: (beforePath, afterPath) => ipcRenderer.invoke('compare-snapshots', { beforePath, afterPath }),
  checkPersistence: () => ipcRenderer.invoke('check-persistence'),

  // === ONE-CLICK MODE ===
  fullResetWithPrefs: (options) => ipcRenderer.invoke('full-reset-with-prefs', options),

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
