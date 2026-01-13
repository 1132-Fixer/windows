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
const prefManager = require('./operations/pref-manager');
const selfTest = require('./operations/self-test');
const zoomPrefs = require('../shared/zoom-prefs');

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

  // ========================================
  // ZOOM PREFERENCE MANAGEMENT
  // ========================================

  // Get preference options schema for UI
  ipcMain.handle('get-zoom-pref-options', () => {
    return prefManager.getPrefOptions();
  });

  // Get user's saved preferences
  ipcMain.handle('get-user-zoom-prefs', () => {
    return prefManager.loadUserPrefs();
  });

  // Save user preferences
  ipcMain.handle('set-user-zoom-prefs', async (event, prefs) => {
    const validation = zoomPrefs.validatePreferences(prefs);
    if (!validation.valid) {
      return { success: false, errors: validation.errors };
    }
    return prefManager.saveUserPrefs(prefs);
  });

  // Get current Zoom preferences (from zoomus.conf)
  ipcMain.handle('get-current-zoom-prefs', () => {
    return prefManager.getCurrentPrefs();
  });

  // Apply preferences to Zoom
  ipcMain.handle('apply-zoom-prefs', async (event, options = {}) => {
    return await prefManager.applyPreferences(options);
  });

  // Verify preferences after Zoom launch
  ipcMain.handle('verify-zoom-prefs', async (event, options = {}) => {
    return await prefManager.verifyPreferences(options);
  });

  // Apply and verify (full cycle)
  ipcMain.handle('apply-and-verify-prefs', async (event, options = {}) => {
    return await prefManager.applyAndVerify(options);
  });

  // Get last preference diff
  ipcMain.handle('get-last-zoom-pref-diff', () => {
    return prefManager.getLastDiff();
  });

  // Detect Zoom version
  ipcMain.handle('detect-zoom-version', async () => {
    return await zoomPrefs.detectZoomVersion();
  });

  // List available templates
  ipcMain.handle('list-zoom-pref-templates', () => {
    return zoomPrefs.listTemplates();
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
  // RESET WITH PREFERENCES (ONE-CLICK MODE)
  // ========================================

  ipcMain.handle('full-reset-with-prefs', async (event, options = {}) => {
    const sessionStart = Date.now();
    logger.initLogger();
    logger.section('FULL RESET WITH PREFERENCES');
    logger.info('Options:', options);

    // Default options for one-click mode
    const resetOptions = {
      uninstall: options.uninstall !== false,
      reinstall: options.reinstall !== false,
      applyPrefs: options.applyPrefs !== false,
      verifyPrefs: options.verifyPrefs !== false,
      launchForVerification: options.launchForVerification !== false
    };

    try {
      // Run standard reset first (reuse full-reset logic)
      sendProgress({ step: 'Running reset...', percent: 5 });

      // Step 1-8: Standard reset operations
      const killResult = await processKiller.killAllZoomProcesses();
      sendProgress({ step: 'Stopped processes', percent: 10 });

      if (resetOptions.uninstall) {
        await uninstaller.uninstallZoom();
        sendProgress({ step: 'Uninstalled Zoom', percent: 20 });
      }

      await services.cleanServicesAndTasks();
      sendProgress({ step: 'Cleaned services', percent: 25 });

      await registry.cleanRegistry();
      sendProgress({ step: 'Cleaned registry', percent: 40 });

      await fingerprint.wipeDeviceFingerprint();
      sendProgress({ step: 'Wiped fingerprint', percent: 55 });

      await folders.deleteAllZoomFolders();
      sendProgress({ step: 'Deleted folders', percent: 65 });

      await fingerprint.cleanRecycleBin();
      sendProgress({ step: 'Cleaned recycle bin', percent: 70 });

      await fingerprint.rebuildIconCache();
      sendProgress({ step: 'Rebuilt icon cache', percent: 75 });

      // Step 9: Reinstall
      let installResult = null;
      if (resetOptions.reinstall) {
        sendProgress({ step: 'Downloading Zoom...', percent: 78 });
        const downloadResult = await installer.downloadZoomInstaller((p) => {
          sendProgress({ step: `Downloading: ${p.percent}%`, percent: 78 + (p.percent / 100) * 10 });
        });

        if (downloadResult.success) {
          sendProgress({ step: 'Installing Zoom...', percent: 88 });
          installResult = await installer.installZoom(downloadResult.path);
          installer.cleanupInstaller(downloadResult.path);
        }
      }

      // Step 10: Apply preferences (NEW)
      let prefResult = null;
      if (resetOptions.applyPrefs && resetOptions.reinstall) {
        sendProgress({ step: 'Applying preferences...', percent: 92 });
        prefResult = await prefManager.applyPreferences({ snapshot: true });
        logger.ok('Preferences applied', prefResult);
      }

      // Step 11: Launch for verification (NEW)
      let verifyResult = null;
      if (resetOptions.verifyPrefs && resetOptions.launchForVerification && prefResult?.success) {
        sendProgress({ step: 'Launching Zoom for verification...', percent: 94 });
        await installer.launchZoom();

        // Wait a bit then verify
        await new Promise(r => setTimeout(r, 2000));
        sendProgress({ step: 'Verifying preferences...', percent: 96 });
        verifyResult = await prefManager.verifyPreferences();
        logger.ok('Preference verification complete', verifyResult);
      }

      // Step 12: Final verification
      sendProgress({ step: 'Verifying cleanup...', percent: 98 });
      const verification = {
        registry: await registry.verifyRegistryClean(),
        fingerprint: await fingerprint.verifyFingerprintWipe(),
        folders: resetOptions.reinstall
          ? { clean: true, skipped: true, reason: 'Reinstall enabled' }
          : await folders.verifyFoldersDeleted(),
        processes: resetOptions.reinstall
          ? { clean: true, skipped: true, reason: 'Reinstall enabled' }
          : { clean: !(await processKiller.isZoomRunning()) },
        preferences: prefResult ? { applied: true, ...prefResult } : null,
        prefVerification: verifyResult
      };

      const allClean = verification.registry.clean &&
                       verification.fingerprint.clean &&
                       verification.folders.clean;

      sendProgress({ step: 'Complete', percent: 100 });

      const sessionDuration = Date.now() - sessionStart;
      logger.section('RESET WITH PREFERENCES COMPLETE');
      logger.ok('Session completed', {
        success: true,
        durationMs: sessionDuration,
        allClean,
        prefsApplied: prefResult?.success || false,
        prefsVerified: verifyResult?.success || false,
        zoomChangedKeys: verifyResult?.summary?.modified || 0
      });

      logger.finalize();

      return {
        success: true,
        verification,
        prefResult,
        verifyResult,
        allClean,
        logPath: logger.getLogPath()
      };

    } catch (error) {
      const sessionDuration = Date.now() - sessionStart;
      logger.error('Reset with prefs failed', { error: error.message });
      logger.finalize();

      return {
        success: false,
        error: error.message,
        logPath: logger.getLogPath()
      };
    }
  });
}

module.exports = {
  setMainWindow,
  registerHandlers,
  sendProgress
};
