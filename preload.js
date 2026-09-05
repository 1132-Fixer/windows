const { contextBridge, ipcRenderer } = require('electron');

// This preload runs sandboxed (src/main/electron-security.js): `require` here
// resolves only Electron's shim modules, never a file in this repository.
// The compact presentation shell therefore loads as a page script from
// index.html (src/preload/compact-shell.js, before renderer.js). Requiring
// it from here threw "module not found" and aborted the whole preload, so
// no window.electronAPI existed and every packaged 6.2.0–6.3.1 start ended
// on "Unable to complete".

// Channels here must stay in lockstep with IPC_INVOKE_CHANNELS /
// IPC_SEND_CHANNELS in src/main/electron-security.js. Main will not
// register any ipcMain.handle that is not on that allowlist.
contextBridge.exposeInMainWorld('electronAPI', {
  runFix: async () => {
    document.documentElement.dataset.fixOutcome = 'running';
    try {
      const result = await ipcRenderer.invoke('run-fix');
      document.documentElement.dataset.fixOutcome = result && result.cancelled
        ? 'cancelled'
        : result && result.cancelTooLate
          ? 'cancel-too-late'
          : result && result.success
            ? 'success'
            : 'error';
      return result;
    } catch (error) {
      document.documentElement.dataset.fixOutcome = 'error';
      throw error;
    }
  },
  createShortcut: () => ipcRenderer.invoke('create-shortcut'),
  launchZoomHelper: () => ipcRenderer.invoke('launch-zoom-helper'),
  shortcutExists: () => ipcRenderer.invoke('shortcut-exists'),
  isElevated: () => ipcRenderer.invoke('is-elevated'),
  startupStatus: () => ipcRenderer.invoke('startup-status'),
  relaunchElevated: () => ipcRenderer.invoke('relaunch-elevated'),
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
  // Explore modal: destination KEY only — the URL mapping lives in the main
  // process; arbitrary URLs cannot ride through this bridge.
  openExploreDestination: (key) => ipcRenderer.invoke('open-explore-destination', key),
  // Completed-repair "Explore Our Products": the destination lives in main
  // (src/main/config.js) and opens in the default browser; the renderer
  // only asks whether it is available and asks to open it.
  productsPageAvailable: () => ipcRenderer.invoke('products-page-available'),
  openProductsPage: () => ipcRenderer.invoke('open-products-page'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  submitFeedback: (type, text, screenshot) => ipcRenderer.invoke('submit-feedback', type, text, screenshot),
  feedbackCapabilities: () => ipcRenderer.invoke('feedback-capabilities'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info')
});
