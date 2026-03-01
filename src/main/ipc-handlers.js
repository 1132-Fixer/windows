/**
 * 1132 Fixer - IPC Handlers
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

// Persistent last-fix tracking
const LAST_FIX_FILE = require('path').join(process.env.LOCALAPPDATA || '', '1132-Remover', 'last-fix.json');

function saveLastFix(data) {
  try {
    const fs = require('fs');
    const dir = require('path').dirname(LAST_FIX_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LAST_FIX_FILE, JSON.stringify(data, null, 2));
  } catch (_) {}
}

function getLastFix() {
  try {
    const fs = require('fs');
    if (fs.existsSync(LAST_FIX_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_FIX_FILE, 'utf8'));
    }
  } catch (_) {}
  return null;
}

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

      // Step 4: Clean registry FIRST (reference order: registry before folders)
      // Registry keys can trigger folder recreation, so kill them first
      sendProgress({ step: 'Cleaning registry', percent: 30 });
      const registryResult = await registry.cleanRegistry((p) => {
        sendProgress({ step: p.message, percent: 30 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'registry', ...registryResult });

      // Step 5: Delete ALL Zoom data folders (after registry is clean)
      sendProgress({ step: 'Deleting Zoom data', percent: 45 });
      const foldersResult = await folders.deleteAllZoomFolders((p) => {
        sendProgress({ step: p.message, percent: 45 + (p.current / p.total) * 15 });
      });
      steps.push({ name: 'folders', ...foldersResult });

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

      // Step 9: Spoof hardware identifiers (BEFORE reinstall)
      // Zoom reads MachineGuid + MAC addresses at first launch to fingerprint device
      sendProgress({ step: 'Rotating hardware identifiers...', percent: 79 });
      const machineGuidResult = await fingerprint.rotateMachineGuid();
      steps.push({ name: 'machineGuid', ...machineGuidResult });

      sendProgress({ step: 'Spoofing network identifiers...', percent: 80 });
      const macSpoofResult = await fingerprint.spoofMacAddresses();
      steps.push({ name: 'macSpoof', ...macSpoofResult });

      // Step 9b: Randomize computer name
      sendProgress({ step: 'Randomizing computer name...', percent: 81 });
      const compNameResult = await fingerprint.randomizeComputerName();
      steps.push({ name: 'computerName', ...compNameResult });

      // Step 9c: Change volume serial number
      sendProgress({ step: 'Changing volume serial...', percent: 82 });
      const volSerialResult = await fingerprint.changeVolumeSerial();
      steps.push({ name: 'volumeSerial', ...volSerialResult });

      // Step 10: Reinstall (if option enabled)
      if (options.reinstall !== false) {
        // Download
        sendProgress({ step: 'Downloading Zoom from zoom.us...', percent: 84 });
        logger.info('Starting Zoom download...');

        try {
          const downloadResult = await installer.downloadZoomInstaller((p) => {
            sendProgress({ step: `Downloading: ${p.percent}%`, percent: 84 + (p.percent / 100) * 5 });
          });

          if (downloadResult.success) {
            installerPath = downloadResult.path;
            logger.ok('Download complete', { path: installerPath });

            // Install
            sendProgress({ step: 'Installing Zoom (please wait)...', percent: 89 });
            logger.info('Starting Zoom installation...');

            const installResult = await installer.installZoom(installerPath, (p) => {
              sendProgress({ step: p.message || 'Installing...', percent: 91 });
            });

            if (installResult.success) {
              logger.ok('Zoom installed successfully');

              // CRITICAL: Kill Zoom if it auto-started after install
              // Zoom MSI sometimes auto-launches — we MUST prevent it from running
              // under the banned JG user. It should ONLY run under ghost user.
              sendProgress({ step: 'Preventing auto-start...', percent: 92 });
              await processKiller.killAllZoomProcesses();

              // Post-install scrub: remove hardware fingerprints recreated by installer
              sendProgress({ step: 'Scrubbing post-install fingerprints...', percent: 93 });
              const scrubResult = await fingerprint.postInstallScrub();
              logger.info('Post-install scrub', scrubResult);
              steps.push({ name: 'postInstallScrub', ...scrubResult });

              // Kill Zoom again (post-install scrub takes time, Zoom may have respawned)
              await processKiller.killAllZoomProcesses();

              // Remove auto-start Run entries so Zoom doesn't auto-launch under JG
              try {
                const { runPowerShell } = require('./utils/spawn-safe');
                await runPowerShell(`
                  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'Zoom' -Force -EA SilentlyContinue
                  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ZoomUMX' -Force -EA SilentlyContinue
                  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ZoomWorkplace' -Force -EA SilentlyContinue
                  Remove-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'Zoom' -Force -EA SilentlyContinue
                  Remove-ItemProperty -Path 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ZoomCptService' -Force -EA SilentlyContinue
                `, { timeout: 5000 });
                logger.ok('Removed Zoom auto-start entries');
              } catch (_) {}

              // Restore saved settings before Zoom launches
              sendProgress({ step: 'Restoring Zoom settings...', percent: 94 });
              const restoreResult = await settingsBackup.restoreZoomSettings();
              logger.info('Settings restore', restoreResult);

              sendProgress({ step: 'Zoom installed. Launch via app only.', percent: 95 });
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

      // Step 11: Verification
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

      // Persist last-fix data for system info panel
      saveLastFix({
        timestamp: new Date().toISOString(),
        success: true,
        durationSec: Math.round(sessionDuration / 1000),
        allClean
      });

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

      // Persist last-fix data for system info panel
      saveLastFix({
        timestamp: new Date().toISOString(),
        success: false,
        error: error.message,
        durationSec: Math.round((Date.now() - sessionStart) / 1000)
      });

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
  // Startup: remove stale HKLM DENY ACLs from previous fixer versions
  // Previous versions set Everyone DENY on HKLM Zoom keys which breaks the MSI installer.
  // The DENY covers ReadPermissions (via WriteKey), so simple Get-Acl/Set-Acl fails.
  // We must use .NET TakeOwnership privilege escalation to bypass the DACL.
  // This runs on app startup (as admin via UAC manifest).
  (async () => {
    try {
      const { runPowerShell } = require('./utils/spawn-safe');
      await runPowerShell(`
        # Enable SeTakeOwnershipPrivilege so we can bypass DENY ACLs
        $privType = @'
using System;
using System.Runtime.InteropServices;
public class AclPriv {
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool AdjustTokenPrivileges(IntPtr h, bool d, ref TP n, int b, IntPtr p, IntPtr r);
    [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Auto)]
    static extern bool LookupPrivilegeValue(string s, string n, out LUID l);
    [DllImport("advapi32.dll", SetLastError=true)]
    static extern bool OpenProcessToken(IntPtr h, uint a, out IntPtr t);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [StructLayout(LayoutKind.Sequential)] public struct TP { public uint C; public LUID L; public uint A; }
    [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Lo; public int Hi; }
    public static void Enable(string p) {
        IntPtr t; OpenProcessToken(GetCurrentProcess(), 0x28, out t);
        TP tp; tp.C = 1; tp.A = 2; LookupPrivilegeValue(null, p, out tp.L);
        AdjustTokenPrivileges(t, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    }
}
'@
        try { Add-Type $privType -EA SilentlyContinue } catch {}
        try { [AclPriv]::Enable('SeTakeOwnershipPrivilege') } catch {}
        try { [AclPriv]::Enable('SeRestorePrivilege') } catch {}

        $adminSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')

        foreach ($keyPath in @('SOFTWARE\\Zoom', 'SOFTWARE\\Zoom Workplace',
                               'SOFTWARE\\ZoomUMX', 'SOFTWARE\\CptService',
                               'SOFTWARE\\ZoomVideoComm')) {
          try {
            # Open with TakeOwnership right — bypasses DACL entirely
            $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($keyPath,
              [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
              [System.Security.AccessControl.RegistryRights]::TakeOwnership)
            if ($key) {
              # Take ownership as Administrators
              $acl = $key.GetAccessControl([System.Security.AccessControl.AccessControlSections]::None)
              $acl.SetOwner($adminSid)
              $key.SetAccessControl($acl)
              $key.Close()

              # Reopen with ChangePermissions
              $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($keyPath,
                [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
                [System.Security.AccessControl.RegistryRights]::ChangePermissions)
              if ($key) {
                $acl = $key.GetAccessControl()
                $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
                  $acl.RemoveAccessRule($_) | Out-Null
                }
                $acl.AddAccessRule((New-Object System.Security.AccessControl.RegistryAccessRule(
                  $adminSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
                $key.SetAccessControl($acl)
                $key.Close()
              }

              # Now delete cleanly
              Remove-Item "HKLM:\\$keyPath" -Recurse -Force -EA SilentlyContinue
            }
          } catch {
            # Fallback: try reg.exe
            reg delete "HKLM\\$keyPath" /f 2>$null | Out-Null
          }
        }
      `, { timeout: 15000 }).catch(() => {});
    } catch (_) {}
  })();

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
  // Clean Room Launch — wipe ALL Zoom fingerprint data, then launch fresh.
  // Registry DENY ACLs prevent Zoom from persisting device identity.
  ipcMain.handle('launch-zoom', async () => {
    try {
      logger.info('Attempting clean room launch (wipe + launch)...');
      const cleanResult = await installer.launchZoomCleanRoom();
      if (cleanResult.success) return cleanResult;
      logger.warn('Clean room launch failed, trying fallback', { error: cleanResult.error });
    } catch (e) {
      logger.warn('Clean room launch error, trying fallback', { error: e.message });
    }

    // Fallback: pre-launch scrub + normal launch
    try {
      await fingerprint.preLaunchScrub();
    } catch (e) {
      logger.warn('Pre-launch scrub failed', { error: e.message });
    }
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
      title: '1132 Fixer',
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
      title: '1132 Fixer - Error',
      message: message,
      buttons: ['OK']
    });
  });

  ipcMain.handle('show-success-dialog', async (event, message) => {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '1132 Fixer - Success',
      message: message,
      buttons: ['OK']
    });
  });

  // === APP CONTROL ===
  ipcMain.handle('get-version', () => require('electron').app.getVersion());

  ipcMain.handle('get-system-info', async () => {
    try {
      const os = require('os');
      const { app } = require('electron');

      // Reliable synchronous admin check via net session
      let admin = false;
      try {
        require('child_process').execSync('net session', { stdio: 'ignore' });
        admin = true;
      } catch (_) {
        admin = false;
      }

      // Read persistent last-fix data from disk
      const lastFix = getLastFix();
      let lastFixText = 'Never';
      let lastFixStatus = null;
      if (lastFix && lastFix.timestamp) {
        const d = new Date(lastFix.timestamp);
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        lastFixText = `${dateStr}, ${timeStr}`;
        lastFixStatus = lastFix.success ? 'Completed' : 'Failed';
      }

      // Recent errors from current log session
      let recentErrors = [];
      try {
        if (typeof logger.getRecentErrors === 'function') {
          recentErrors = logger.getRecentErrors(3);
        }
      } catch (_) {}

      return {
        version: app.getVersion(),
        os: `Windows ${os.release()} (${os.arch()})`,
        admin,
        lastFix: lastFixText,
        lastFixStatus,
        errors: recentErrors.length > 0 ? recentErrors.join('; ') : 'None'
      };
    } catch (err) {
      return { version: '?', os: 'Windows', admin: false, lastFix: '?', lastFixStatus: null, errors: err.message };
    }
  });

  ipcMain.handle('install-update', () => {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall(true, true);
  });

  ipcMain.handle('retry-update', () => {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.checkForUpdates().catch(() => {});
  });

  ipcMain.handle('force-restart', () => {
    const { app } = require('electron');
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('submit-feedback', async (event, type, text) => {
    try {
      const version = require('electron').app.getVersion();
      const os = require('os');
      const https = require('https');

      const title = `[${type}] ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`;
      const body = `**Type:** ${type}\n**App Version:** ${version}\n**OS:** Windows ${os.release()}\n\n---\n\n${text}`;

      const config = require('./config');
      const token = config.GH_ISSUES_TOKEN;
      if (!token) {
        logger.warn('No GH_ISSUES_TOKEN configured');
        return { success: false, error: 'Feedback service not configured' };
      }

      const label = type === 'User Rating' ? 'user-rating' : type.toLowerCase().replace(' ', '-');
      const postData = JSON.stringify({ title, body, labels: [label] });

      return new Promise((resolve) => {
        const req = https.request({
          hostname: 'api.github.com',
          path: `/repos/${config.GH_ISSUES_REPO}/issues`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': `1132Fixer/${version}`,
            'Accept': 'application/vnd.github+json',
            'Content-Length': Buffer.byteLength(postData)
          }
        }, (res) => {
          let data = '';
          res.on('data', (chunk) => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 201) {
              logger.info('Feedback submitted successfully');
              resolve({ success: true });
            } else {
              logger.warn('Feedback submission failed', { status: res.statusCode, body: data });
              resolve({ success: false, error: 'Submission failed' });
            }
          });
        });
        req.on('error', (err) => {
          logger.error('Feedback submission error', { error: err.message });
          resolve({ success: false, error: 'Network error' });
        });
        req.write(postData);
        req.end();
      });
    } catch (err) {
      logger.error('Feedback handler error', { error: err.message });
      return { success: false, error: err.message };
    }
  });

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
      defaultPath: path.join(require('os').homedir(), 'Desktop', `1132-Fixer-Log-${Date.now()}.txt`),
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
