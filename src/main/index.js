/**
 * 1132 Remover - Main Process Entry Point
 * Electron app for complete Zoom reset and device fingerprint wipe
 *
 * @version 3.0.0
 */

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const logger = require('./utils/logger');
const ipcHandlers = require('./ipc-handlers');

// Keep reference to prevent garbage collection
let mainWindow = null;

/**
 * Check if running as administrator
 * @returns {Promise<boolean>}
 */
async function isAdmin() {
  try {
    const { spawnSafe } = require('./utils/spawn-safe');
    const result = await spawnSafe('net', ['session'], { timeout: 5000 });
    return result.exitCode === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Create the main application window
 */
async function createWindow() {
  // Check for admin privileges
  const admin = await isAdmin();
  if (!admin) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: '1132 Remover',
      message: 'Administrator privileges required',
      detail: 'This application requires administrator privileges to fully clean Zoom data. Some operations may fail without elevation.',
      buttons: ['Continue Anyway', 'Exit'],
      defaultId: 1
    });

    if (result.response === 1) {
      app.quit();
      return;
    }
  }

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: '1132 Remover',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#0D1117',
    show: false, // Don't show until ready
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Set up IPC handlers
  ipcHandlers.setMainWindow(mainWindow);
  ipcHandlers.registerHandlers();

  // Load the HTML file
  mainWindow.loadFile(path.join(__dirname, '../../index.html'));

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Open DevTools in development
    if (process.argv.includes('--dev') || process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  });

  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Prevent navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
    }
  });

  // Log app start
  logger.initLogger();
  logger.info('Application started', {
    version: app.getVersion(),
    admin,
    platform: process.platform,
    arch: process.arch
  });
}

// App lifecycle
app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  logger.finalize();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error: error.message, stack: error.stack });

  dialog.showErrorBox(
    '1132 Remover - Error',
    `An unexpected error occurred:\n\n${error.message}\n\nCheck the log file for details.`
  );
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
