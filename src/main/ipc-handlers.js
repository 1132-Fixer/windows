/**
 * 1132 Remover - IPC Handlers
 * All Electron IPC handlers for renderer communication
 */

const { ipcMain, dialog, shell } = require('electron');
const logger = require('./utils/logger');

// Import operations
const processKiller = require('./operations/process-killer');
const uninstaller = require('./operations/uninstaller');
const registry = require('./operations/registry');
const fingerprint = require('./operations/fingerprint');
const folders = require('./operations/folders');
const services = require('./operations/services');
const installer = require('./operations/installer');

let mainWindow = null;

/**
 * Set the main window reference
 * @param {BrowserWindow} window
 */
function setMainWindow(window) {
  mainWindow = window;
  logger.setMainWindow(window);
}

/**
 * Send progress update to renderer
 * @param {Object} data - Progress data
 */
function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reset-progress', data);
  }
}

/**
 * Register all IPC handlers
 */
function registerHandlers() {
  // === FULL RESET ===
  ipcMain.handle('full-reset', async (event, options = {}) => {
    const sessionStart = Date.now();
    logger.initLogger();
    logger.section('FULL RESET STARTED');
    logger.info('Options:', options);

    const steps = [];
    let installerPath = null;

    try {
      // Step 1: Kill processes
      sendProgress({ step: 'Stopping Zoom processes', percent: 5 });
      const killResult = await processKiller.killAllZoomProcesses((p) => {
        sendProgress({ step: p.message, percent: 5 + (p.current / p.total) * 10 });
      });
      steps.push({ name: 'kill', ...killResult });

      // Step 2: Uninstall (if option enabled)
      if (options.uninstall !== false) {
        sendProgress({ step: 'Uninstalling Zoom', percent: 15 });
        const uninstallResult = await uninstaller.uninstallZoom((p) => {
          sendProgress({ step: p.message, percent: 15 + (p.current / p.total) * 10 });
        });
        steps.push({ name: 'uninstall', ...uninstallResult });
      }

      // Step 3: Remove services and tasks
      sendProgress({ step: 'Removing services', percent: 25 });
      const servicesResult = await services.cleanServicesAndTasks((p) => {
        sendProgress({ step: p.message, percent: 25 + (p.current / p.total) * 5 });
      });
      steps.push({ name: 'services', ...servicesResult });

      // Step 4: Clean registry
      sendProgress({ step: 'Cleaning registry', percent: 35 });
      const registryResult = await registry.cleanRegistry((p) => {
        sendProgress({ step: p.message, percent: 35 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'registry', ...registryResult });

      // Step 5: Wipe device fingerprint (CRITICAL)
      sendProgress({ step: 'Wiping device fingerprint', percent: 50 });
      const fingerprintResult = await fingerprint.wipeDeviceFingerprint((p) => {
        sendProgress({ step: p.message, percent: 50 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'fingerprint', ...fingerprintResult });

      // Step 6: Delete folders
      sendProgress({ step: 'Deleting Zoom data', percent: 65 });
      const foldersResult = await folders.deleteAllZoomFolders((p) => {
        sendProgress({ step: p.message, percent: 65 + (p.current / p.total) * 10 });
      });
      steps.push({ name: 'folders', ...foldersResult });

      // Step 7: Final cleanup (AFTER folder deletion)
      // Recycle bin may contain items from folder deletion
      sendProgress({ step: 'Cleaning Recycle Bin', percent: 76 });
      const recycleBinResult = await fingerprint.cleanRecycleBin();
      steps.push({ name: 'recycleBin', ...recycleBinResult });

      // Step 8: Rebuild icon cache (restarts Explorer, do last before reinstall)
      sendProgress({ step: 'Rebuilding icon cache', percent: 78 });
      const iconCacheResult = await fingerprint.rebuildIconCache();
      steps.push({ name: 'iconCache', ...iconCacheResult });

      // Step 9: Reinstall (if option enabled)
      if (options.reinstall !== false) {
        // Download
        sendProgress({ step: 'Downloading Zoom', percent: 80 });
        const downloadResult = await installer.downloadZoomInstaller((p) => {
          sendProgress({ step: p.message, percent: 80 + (p.percent / 100) * 10 });
        });

        if (downloadResult.success) {
          installerPath = downloadResult.path;

          // Install
          sendProgress({ step: 'Installing Zoom', percent: 90 });
          const installResult = await installer.installZoom(installerPath, (p) => {
            sendProgress({ step: p.message, percent: 92 });
          });
          steps.push({ name: 'install', ...installResult });

          // Cleanup installer
          installer.cleanupInstaller(installerPath);
        } else {
          steps.push({ name: 'download', success: false, error: downloadResult.error });
        }
      }

      // Step 10: Verification
      // Note: If reinstall was enabled, skip folder/process checks (Zoom will exist)
      sendProgress({ step: 'Verifying cleanup', percent: 98 });
      const verification = {
        registry: await registry.verifyRegistryClean(),
        fingerprint: await fingerprint.verifyFingerprintWipe(),
        folders: options.reinstall !== false
          ? { clean: true, skipped: true, reason: 'Reinstall enabled' }
          : await folders.verifyFoldersDeleted(),
        processes: options.reinstall !== false
          ? { clean: true, skipped: true, reason: 'Reinstall enabled' }
          : { clean: !(await processKiller.isZoomRunning()) }
      };

      const allClean = verification.registry.clean &&
                       verification.fingerprint.clean &&
                       verification.folders.clean &&
                       verification.processes.clean;

      sendProgress({ step: 'Complete', percent: 100 });

      logger.section('RESET COMPLETE');
      logger.info('Verification:', verification);

      // Session summary - self-describing log footer
      const sessionDuration = Date.now() - sessionStart;
      logger.ok('Session completed', {
        success: true,
        durationMs: sessionDuration,
        durationSec: Math.round(sessionDuration / 1000),
        uninstall: options.uninstall !== false,
        reinstall: options.reinstall !== false,
        stepsCompleted: steps.length,
        allClean
      });

      logger.finalize();

      return {
        success: true,
        steps,
        verification,
        allClean,
        logPath: logger.getLogPath()
      };

    } catch (error) {
      // Session summary on failure
      const sessionDuration = Date.now() - sessionStart;
      logger.error('Reset failed', { error: error.message, stack: error.stack });
      logger.warn('Session ended with error', {
        success: false,
        durationMs: sessionDuration,
        durationSec: Math.round(sessionDuration / 1000),
        stepsCompleted: steps.length,
        failedAt: steps.length > 0 ? steps[steps.length - 1].name : 'startup'
      });
      logger.finalize();

      // Cleanup on error
      if (installerPath) {
        installer.cleanupInstaller(installerPath);
      }

      return {
        success: false,
        error: error.message,
        steps,
        logPath: logger.getLogPath()
      };
    }
  });

  // === QUICK RESET (current user only, no reinstall) ===
  ipcMain.handle('quick-reset', async () => {
    return ipcMain.handle('full-reset', { uninstall: false, reinstall: false });
  });

  // === AUDIT (read-only scan) ===
  ipcMain.handle('audit', async () => {
    logger.initLogger();
    logger.section('AUDIT SCAN');

    try {
      const processes = await processKiller.findZoomProcesses();
      const folders = await folders.scanZoomFolders();
      const services = await services.findZoomServices();
      const tasks = await services.findZoomTasks();
      const zoomInstalled = await installer.isZoomInstalled();

      const result = {
        processes: { count: processes.length, items: processes },
        folders: { count: folders.paths.length, items: folders.paths, totalSize: folders.totalSize },
        services: { count: services.length, items: services },
        tasks: { count: tasks.length, items: tasks },
        installed: zoomInstalled
      };

      logger.info('Audit complete', result);
      return { success: true, ...result };
    } catch (error) {
      logger.error('Audit failed', { error: error.message });
      return { success: false, error: error.message };
    }
  });

  // === KILL ZOOM ===
  ipcMain.handle('kill-zoom', async () => {
    const result = await processKiller.killAllZoomProcesses();
    return result;
  });

  // === LAUNCH ZOOM ===
  ipcMain.handle('launch-zoom', async () => {
    return await installer.launchZoom();
  });

  // === CHECK ZOOM INSTALLED ===
  ipcMain.handle('check-zoom', async () => {
    return await installer.isZoomInstalled();
  });

  // === DIALOG HELPERS ===
  ipcMain.handle('show-confirm-dialog', async (event, message) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '1132 Remover',
      message: message,
      buttons: ['Yes', 'No'],
      defaultId: 1,
      cancelId: 1
    });
    return result.response === 0;
  });

  ipcMain.handle('show-error-dialog', async (event, message) => {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '1132 Remover - Error',
      message: message,
      buttons: ['OK']
    });
  });

  ipcMain.handle('show-success-dialog', async (event, message) => {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '1132 Remover - Success',
      message: message,
      buttons: ['OK']
    });
  });

  // === APP CONTROL ===
  ipcMain.handle('quit-app', () => {
    logger.finalize();
    require('electron').app.quit();
  });

  ipcMain.handle('get-log-path', () => {
    return logger.getLogPath();
  });

  ipcMain.handle('get-all-logs', () => {
    return logger.getAllLogFiles();
  });

  // === OPEN LOG FOLDER ===
  ipcMain.handle('open-log-folder', async () => {
    const logDir = logger.getLogDir();
    if (logDir) {
      await shell.openPath(logDir);
      return { success: true, path: logDir };
    }
    return { success: false, error: 'Log directory not found' };
  });

  // === SAVE LOG TO CUSTOM LOCATION ===
  ipcMain.handle('save-log', async (event, logContent) => {
    const fs = require('fs');
    const path = require('path');

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Operation Log',
      defaultPath: path.join(require('os').homedir(), 'Desktop', `1132-Eliminator-Log-${Date.now()}.txt`),
      filters: [
        { name: 'Text Files', extensions: ['txt', 'log'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    });

    if (!result.canceled && result.filePath) {
      try {
        fs.writeFileSync(result.filePath, logContent);
        return { success: true, path: result.filePath };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
    return { success: false, error: 'Save cancelled' };
  });
}

module.exports = {
  setMainWindow,
  registerHandlers,
  sendProgress
};
