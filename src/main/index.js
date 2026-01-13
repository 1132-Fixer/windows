/**
 * 1132 Remover - Main Process Entry Point
 * Electron app for complete Zoom reset and device fingerprint wipe
 *
 * CLI Mode: Run with --cli flag for headless operation
 *   --cli             Run in CLI mode (no GUI)
 *   --full-reset      Run full reset operation
 *   --reinstall       Enable Zoom reinstall (default: true)
 *   --no-reinstall    Disable Zoom reinstall
 *   --uninstall       Enable Zoom uninstall (default: true)
 *   --no-uninstall    Disable Zoom uninstall
 *
 * @version 1.0.0
 */

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const logger = require('./utils/logger');
const ipcHandlers = require('./ipc-handlers');

// Keep reference to prevent garbage collection
let mainWindow = null;

// CLI mode flag
const cliMode = process.argv.includes('--cli');

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

/**
 * Run CLI mode (headless operation)
 */
async function runCliMode() {
  // Import operations directly
  const processKiller = require('./operations/process-killer');
  const uninstaller = require('./operations/uninstaller');
  const registry = require('./operations/registry');
  const fingerprint = require('./operations/fingerprint');
  const folders = require('./operations/folders');
  const services = require('./operations/services');
  const installer = require('./operations/installer');

  // Parse CLI options
  const options = {
    uninstall: !process.argv.includes('--no-uninstall'),
    reinstall: !process.argv.includes('--no-reinstall')
  };

  const sessionStart = Date.now();
  logger.initLogger();
  logger.section('CLI MODE - FULL RESET STARTED');
  logger.info('Options:', options);
  logger.info('CLI args:', process.argv.slice(2));

  const admin = await isAdmin();
  logger.info('Running as admin:', admin);

  if (!admin) {
    logger.warn('Not running as administrator - some operations may fail');
  }

  const steps = [];
  let installerPath = null;

  try {
    // Step 1: Kill processes
    console.log('[1/9] Stopping Zoom processes...');
    const killResult = await processKiller.killAllZoomProcesses();
    steps.push({ name: 'kill', ...killResult });

    // Step 2: Uninstall
    if (options.uninstall) {
      console.log('[2/9] Uninstalling Zoom...');
      const uninstallResult = await uninstaller.uninstallZoom();
      steps.push({ name: 'uninstall', ...uninstallResult });
    }

    // Step 3: Remove services and tasks
    console.log('[3/9] Removing services and tasks...');
    const servicesResult = await services.cleanServicesAndTasks();
    steps.push({ name: 'services', ...servicesResult });

    // Step 4: Clean registry
    console.log('[4/9] Cleaning registry...');
    const registryResult = await registry.cleanRegistry();
    steps.push({ name: 'registry', ...registryResult });

    // Step 5: Wipe device fingerprint
    console.log('[5/9] Wiping device fingerprint...');
    const fingerprintResult = await fingerprint.wipeDeviceFingerprint();
    steps.push({ name: 'fingerprint', ...fingerprintResult });

    // Step 6: Delete folders
    console.log('[6/9] Deleting Zoom data...');
    const foldersResult = await folders.deleteAllZoomFolders();
    steps.push({ name: 'folders', ...foldersResult });

    // Step 7: Clean recycle bin
    console.log('[7/9] Cleaning Recycle Bin...');
    const recycleBinResult = await fingerprint.cleanRecycleBin();
    steps.push({ name: 'recycleBin', ...recycleBinResult });

    // Step 8: Rebuild icon cache
    console.log('[8/9] Rebuilding icon cache...');
    const iconCacheResult = await fingerprint.rebuildIconCache();
    steps.push({ name: 'iconCache', ...iconCacheResult });

    // Step 9: Reinstall
    if (options.reinstall) {
      console.log('[9/9] Downloading and installing Zoom...');
      const downloadResult = await installer.downloadZoomInstaller((p) => {
        if (p.percent) process.stdout.write(`\r  Download: ${p.percent}%`);
      });
      console.log(''); // newline after progress

      if (downloadResult.success) {
        installerPath = downloadResult.path;
        const installResult = await installer.installZoom(installerPath);
        steps.push({ name: 'install', ...installResult });
        installer.cleanupInstaller(installerPath);
      } else {
        steps.push({ name: 'download', success: false, error: downloadResult.error });
      }
    }

    // Verification
    console.log('Verifying cleanup...');
    const verification = {
      registry: await registry.verifyRegistryClean(),
      fingerprint: await fingerprint.verifyFingerprintWipe(),
      folders: options.reinstall
        ? { clean: true, skipped: true, reason: 'Reinstall enabled' }
        : await folders.verifyFoldersDeleted(),
      processes: options.reinstall
        ? { clean: true, skipped: true, reason: 'Reinstall enabled' }
        : { clean: !(await processKiller.isZoomRunning()) }
    };

    const allClean = verification.registry.clean &&
                     verification.fingerprint.clean &&
                     verification.folders.clean &&
                     verification.processes.clean;

    // Session summary
    const sessionDuration = Date.now() - sessionStart;
    logger.section('RESET COMPLETE');
    logger.info('Verification:', verification);
    logger.ok('Session completed', {
      success: true,
      durationMs: sessionDuration,
      durationSec: Math.round(sessionDuration / 1000),
      uninstall: options.uninstall,
      reinstall: options.reinstall,
      stepsCompleted: steps.length,
      allClean
    });

    console.log('');
    console.log('========================================');
    console.log('  RESET COMPLETE');
    console.log('========================================');
    console.log(`  Duration: ${Math.round(sessionDuration / 1000)}s`);
    console.log(`  All Clean: ${allClean}`);
    console.log(`  Log: ${logger.getLogPath()}`);
    console.log('========================================');

    logger.finalize();
    app.exit(allClean ? 0 : 1);

  } catch (error) {
    const sessionDuration = Date.now() - sessionStart;
    logger.error('Reset failed', { error: error.message, stack: error.stack });
    logger.warn('Session ended with error', {
      success: false,
      durationMs: sessionDuration,
      stepsCompleted: steps.length
    });

    console.error('');
    console.error('========================================');
    console.error('  RESET FAILED');
    console.error('========================================');
    console.error(`  Error: ${error.message}`);
    console.error(`  Log: ${logger.getLogPath()}`);
    console.error('========================================');

    if (installerPath) {
      installer.cleanupInstaller(installerPath);
    }

    logger.finalize();
    app.exit(1);
  }
}

// App lifecycle
app.whenReady().then(() => {
  if (cliMode && process.argv.includes('--full-reset')) {
    runCliMode();
  } else {
    createWindow();
  }
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
    '1132 Remover - Error',
    `An unexpected error occurred:\n\n${error.message}\n\nCheck the log file for details.`
  );
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
