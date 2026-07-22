const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runFix: () => ipcRenderer.invoke('run-fix'),
  createShortcut: () => ipcRenderer.invoke('create-shortcut'),
  shortcutExists: () => ipcRenderer.invoke('shortcut-exists'),
  isElevated: () => ipcRenderer.invoke('is-elevated'),
  preflight: () => ipcRenderer.invoke('preflight'),
  preflightScan: () => ipcRenderer.invoke('preflight-scan'),
  supportReport: (context) => ipcRenderer.invoke('support-report', context),
  onFixLog: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('fix-log', handler);
    return () => ipcRenderer.removeListener('fix-log', handler);
  },
  onUpdateStatus: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
  installUpdateNow: () => ipcRenderer.invoke('install-update-now'),
  deferUpdate: () => ipcRenderer.invoke('defer-update'),
  openDownloadPage: () => ipcRenderer.invoke('open-download-page'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  submitFeedback: (type, text) => ipcRenderer.invoke('submit-feedback', type, text),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info')
});
