const { contextBridge, ipcRenderer } = require('electron');

// Channels here must stay in lockstep with IPC_INVOKE_CHANNELS /
// IPC_SEND_CHANNELS in src/main/electron-security.js. Main will not
// register any ipcMain.handle that is not on that allowlist.
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
  zoomOpenDownload: () => ipcRenderer.invoke('zoom-open-download'),
  zoomChooseInstaller: () => ipcRenderer.invoke('zoom-choose-installer'),
  zoomRunInstaller: () => ipcRenderer.invoke('zoom-run-installer'),
  onZoomInstallerDone: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('zoom-installer-done', handler);
    return () => ipcRenderer.removeListener('zoom-installer-done', handler);
  },
  installUpdateNow: () => ipcRenderer.invoke('install-update-now'),
  deferUpdate: () => ipcRenderer.invoke('defer-update'),
  openDownloadPage: () => ipcRenderer.invoke('open-download-page'),
  openWebsite: () => ipcRenderer.invoke('open-website'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  submitFeedback: (type, text, screenshot) => ipcRenderer.invoke('submit-feedback', type, text, screenshot),
  feedbackCapabilities: () => ipcRenderer.invoke('feedback-capabilities'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info')
});
