/**
 * 1132 Fixer - Main Process Entry Point
 * Zoom Error 1132 fix tool - device fingerprint reset
 *
 * @version 5.0.3
 */

const { app, BrowserWindow, dialog, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');

// Force dark mode always
nativeTheme.themeSource = 'dark';
const path = require('path');
const logger = require('./utils/logger');
const ipcHandlers = require('./ipc-handlers');
const { isElevated } = require('./utils/elevation');

// Auto-updater config
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = logger;

// Single instance lock - prevent multiple windows
// After auto-update, the old process may still be exiting when NSIS relaunches us.
// Retry once after a delay so we don't silently quit during an update relaunch.
let gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // Old process may still hold the lock — wait and retry once
  setTimeout(() => {
    gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
    }
  }, 3000);
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Keep reference to prevent garbage collection
let mainWindow = null;

/**
 * Create the main application window
 */
async function createWindow() {
  // Check admin status (Windows manifest requires admin via UAC)
  const admin = await isElevated();

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: '1132 Fixer',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#0a0e1a',
    autoHideMenuBar: true,
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

  // Check for updates after window is ready (non-blocking)
  setupAutoUpdater();
}

/**
 * Set up auto-updater events and check for updates
 */
function setupAutoUpdater() {
  autoUpdater.on('update-available', (info) => {
    logger.info('Update available', { version: info.version });
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'available',
        version: info.version
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'downloading',
        percent: Math.round(progress.percent)
      });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info('Update downloaded, auto-installing', { version: info.version });
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'ready',
        version: info.version
      });
    }
    // Auto-restart after brief delay to show the banner
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true);
    }, 2000);
  });

  autoUpdater.on('error', (err) => {
    logger.warn('Auto-update error', { error: err.message });
    if (mainWindow) {
      mainWindow.webContents.send('update-status', {
        status: 'error',
        error: err.message
      });
    }
  });

  // Check for updates (silent, non-blocking)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);
}

// App lifecycle
app.whenReady().then(async () => {
  // Enforce admin — relaunch elevated if needed
  const admin = await isElevated();
  if (!admin) {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const os = require('os');

    // Write a temp VBS script to relaunch elevated (avoids PowerShell quoting issues)
    const exe = process.execPath;
    const args = process.argv.slice(1).join(' ');
    const vbs = path.join(os.tmpdir(), '1132-elevate.vbs');
    fs.writeFileSync(vbs,
      'Set UAC = CreateObject("Shell.Application")\r\n' +
      'UAC.ShellExecute "' + exe.replace(/"/g, '""') + '", "' + args.replace(/"/g, '""') + '", "", "runas", 1\r\n'
    );

    try {
      spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
    } catch (_) {
      // UAC declined or failed
    }

    // Give VBS a moment to trigger UAC, then exit this non-elevated instance
    setTimeout(() => app.exit(0), 500);
    return;
  }

  createWindow();
});

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
    '1132 Fixer - Error',
    `An unexpected error occurred:\n\n${error.message}\n\nCheck the log file for details.`
  );
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
