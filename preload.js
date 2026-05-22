const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  runFix: () => ipcRenderer.invoke('run-fix'),
  createShortcut: () => ipcRenderer.invoke('create-shortcut'),
  showFixConfirm: () => ipcRenderer.invoke('show-fix-confirm'),
  showShortcutPrompt: () => ipcRenderer.invoke('show-shortcut-prompt'),
  shortcutExists: () => ipcRenderer.invoke('shortcut-exists'),
  isElevated: () => ipcRenderer.invoke('is-elevated'),
  preflight: () => ipcRenderer.invoke('preflight'),
  onFixLog: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on('fix-log', handler);
    return () => ipcRenderer.removeListener('fix-log', handler);
  },
  quitApp: () => ipcRenderer.invoke('quit-app'),
  submitFeedback: (type, text) => ipcRenderer.invoke('submit-feedback', type, text),
  getVersion: () => ipcRenderer.invoke('get-version'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info')
});
