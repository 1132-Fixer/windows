/**
 * 1132 Eliminator - IPC Handlers
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
const settingsBackup = require('./operations/settings-backup');
const selfTest = require('./operations/self-test');
const snapshot = require('./operations/snapshot');

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
/**
 * Core full-reset logic (extracted so quick-reset can reuse it)
 */
async function performFullReset(options = {}) {
    const sessionStart = Date.now();
    logger.initLogger();
    logger.section('FULL RESET STARTED');
    logger.info('Options:', options);

    const steps = [];
    let installerPath = null;

    try {
      // Step 0: Save Zoom settings before purge (for restore after reinstall)
      if (options.reinstall !== false) {
        sendProgress({ step: 'Saving Zoom settings...', percent: 2 });
        const backupResult = settingsBackup.saveZoomSettings();
        logger.info('Settings backup', backupResult);
      }

      // Step 1: Kill processes (includes stopping services first)
      sendProgress({ step: 'Stopping Zoom processes', percent: 5 });
      const killResult = await processKiller.killAllZoomProcesses((p) => {
        sendProgress({ step: p.message, percent: 5 + (p.current / p.total) * 8 });
      });
      steps.push({ name: 'kill', ...killResult });

      // Step 2: DELETE services and tasks IMMEDIATELY (prevents auto-restart)
      // CRITICAL: Must happen right after process kill, before any other operations
      sendProgress({ step: 'Removing services', percent: 13 });
      const servicesResult = await services.cleanServicesAndTasks((p) => {
        sendProgress({ step: p.message, percent: 13 + (p.current / p.total) * 5 });
      });
      steps.push({ name: 'services', ...servicesResult });

      // Step 2b: Second process sweep - catch any processes that respawned during service deletion
      sendProgress({ step: 'Final process sweep', percent: 18 });
      await processKiller.killAllZoomProcesses();

      // Step 3: Uninstall (if option enabled)
      if (options.uninstall !== false) {
        sendProgress({ step: 'Uninstalling Zoom', percent: 20 });
        const uninstallResult = await uninstaller.uninstallZoom((p) => {
          sendProgress({ step: p.message, percent: 20 + (p.current / p.total) * 10 });
        });
        steps.push({ name: 'uninstall', ...uninstallResult });
      }

      // Step 4: Delete ALL folders FIRST (includes fingerprint data folders)
      // CRITICAL: Delete data before fingerprint wipe - folders contain the DBs
      sendProgress({ step: 'Deleting Zoom data', percent: 30 });
      const foldersResult = await folders.deleteAllZoomFolders((p) => {
        sendProgress({ step: p.message, percent: 30 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'folders', ...foldersResult });

      // Step 5: Clean registry (after folders to ensure no regeneration)
      sendProgress({ step: 'Cleaning registry', percent: 45 });
      const registryResult = await registry.cleanRegistry((p) => {
        sendProgress({ step: p.message, percent: 45 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'registry', ...registryResult });

      // Step 6: Wipe system fingerprints (Amcache, SRUM, Prefetch, etc.)
      // These are Windows-level traces, not Zoom folder data
      sendProgress({ step: 'Wiping system fingerprints', percent: 60 });
      const fingerprintResult = await fingerprint.wipeDeviceFingerprint((p) => {
        sendProgress({ step: p.message, percent: 60 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'fingerprint', ...fingerprintResult });

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
        sendProgress({ step: 'Downloading Zoom from zoom.us...', percent: 80 });
        logger.info('Starting Zoom download...');

        try {
          const downloadResult = await installer.downloadZoomInstaller((p) => {
            sendProgress({ step: `Downloading: ${p.percent}%`, percent: 80 + (p.percent / 100) * 10 });
          });

          if (downloadResult.success) {
            installerPath = downloadResult.path;
            logger.ok('Download complete', { path: installerPath });

            // Install
            sendProgress({ step: 'Installing Zoom (please wait)...', percent: 90 });
            logger.info('Starting Zoom installation...');

            const installResult = await installer.installZoom(installerPath, (p) => {
              sendProgress({ step: p.message || 'Installing...', percent: 92 });
            });

            if (installResult.success) {
              logger.ok('Zoom installed successfully');

              // Restore saved settings before Zoom launches
              sendProgress({ step: 'Restoring Zoom settings...', percent: 94 });
              const restoreResult = await settingsBackup.restoreZoomSettings();
              logger.info('Settings restore', restoreResult);

              sendProgress({ step: 'Zoom installed with settings restored', percent: 95 });
            } else {
              logger.error('Zoom installation failed', { error: installResult.error });
              sendProgress({ step: 'Installation failed: ' + (installResult.error || 'Unknown error'), percent: 95 });
            }

            steps.push({ name: 'install', ...installResult });

            // Cleanup installer
            installer.cleanupInstaller(installerPath);
          } else {
            logger.error('Zoom download failed', { error: downloadResult.error });
            sendProgress({ step: 'Download failed: ' + (downloadResult.error || 'Unknown error'), percent: 90 });
            steps.push({ name: 'download', success: false, error: downloadResult.error });
          }
        } catch (downloadError) {
          logger.error('Download/install exception', { error: downloadError.message });
          sendProgress({ step: 'Error: ' + downloadError.message, percent: 90 });
          steps.push({ name: 'download', success: false, error: downloadError.message });
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
}

function registerHandlers() {
  // === FULL RESET ===
  ipcMain.handle('full-reset', async (event, options = {}) => {
    return await performFullReset(options);
  });

  // === QUICK RESET (current user only, no reinstall) ===
  ipcMain.handle('quick-reset', async () => {
    return await performFullReset({ uninstall: false, reinstall: false });
  });

  // === AUDIT (read-only scan) ===
  ipcMain.handle('audit', async () => {
    logger.initLogger();
    logger.section('AUDIT SCAN');

    try {
      const processList = await processKiller.findZoomProcesses();
      const folderScan = await folders.scanZoomFolders();
      const serviceList = await services.findZoomServices();
      const taskList = await services.findZoomTasks();
      const zoomInstalled = await installer.isZoomInstalled();

      const result = {
        processes: { count: processList.length, items: processList },
        folders: { count: folderScan.paths.length, items: folderScan.paths, totalSize: folderScan.totalSize },
        services: { count: serviceList.length, items: serviceList },
        tasks: { count: taskList.length, items: taskList },
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

  // ========================================
  // ZOOM SETTINGS BACKUP
  // ========================================

  ipcMain.handle('has-settings-backup', () => {
    return settingsBackup.hasBackup();
  });

  ipcMain.handle('save-zoom-settings', () => {
    return settingsBackup.saveZoomSettings();
  });

  ipcMain.handle('restore-zoom-settings', async () => {
    return await settingsBackup.restoreZoomSettings();
  });

  // ========================================
  // SELF-TEST MODE
  // ========================================

  ipcMain.handle('run-self-test', async () => {
    logger.initLogger();
    const results = await selfTest.runSelfTest();
    logger.finalize();
    return results;
  });

  // ========================================
  // PERSISTENCE SNAPSHOTS & MONITORING
  // ========================================

  // Take a persistence snapshot (before/after comparison)
  ipcMain.handle('take-snapshot', async (event, label = 'Snapshot') => {
    return await snapshot.takeSnapshot(label);
  });

  // List all saved snapshots
  ipcMain.handle('list-snapshots', () => {
    return snapshot.listSnapshots();
  });

  // Compare two snapshots (before/after diff)
  ipcMain.handle('compare-snapshots', async (event, { beforePath, afterPath }) => {
    const before = snapshot.loadSnapshot(beforePath);
    const after = snapshot.loadSnapshot(afterPath);

    if (!before || !after) {
      return { success: false, error: 'Failed to load one or both snapshots' };
    }

    const result = snapshot.compareSnapshots(before, after);
    return { success: true, ...result };
  });

  // Quick persistence check (are any Zoom artifacts present?)
  ipcMain.handle('check-persistence', async () => {
    return await snapshot.checkPersistence();
  });

  // ========================================
  // RESET WITH SETTINGS RESTORE (ONE-CLICK MODE)
  // ========================================

  ipcMain.handle('full-reset-with-prefs', async (event, options = {}) => {
    // Settings backup/restore is now handled inside performFullReset
    return await performFullReset(options);
  });
}

module.exports = {
  setMainWindow,
  registerHandlers,
  sendProgress
};
