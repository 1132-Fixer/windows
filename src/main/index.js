/**
 * 1132 Eliminator - Main Process Entry Point
 * Zoom Error 1132 elimination tool - forensic device fingerprint purge
 *
 * CLI Mode: Run with --cli flag for headless operation
 *   --cli             Run in CLI mode (no GUI)
 *   --full-reset      Run full reset operation
 *   --reinstall       Enable Zoom reinstall (default: true)
 *   --no-reinstall    Disable Zoom reinstall
 *   --uninstall       Enable Zoom uninstall (default: true)
 *   --no-uninstall    Disable Zoom uninstall
 *   --json            Export session summary as JSON
 *   --self-test       Run self-test (dry run, no changes made)
 *   --list-presets    List available preset profiles
 *   --apply-preset X  Apply a preset profile (e.g., quiet-meetings)
 *
 * @version 3.0.0
 */

const { app, BrowserWindow, dialog, nativeTheme } = require('electron');

// Force dark mode always
nativeTheme.themeSource = 'dark';
const path = require('path');
const logger = require('./utils/logger');
const ipcHandlers = require('./ipc-handlers');
const { isElevated } = require('./utils/elevation');

// Keep reference to prevent garbage collection
let mainWindow = null;

// CLI mode flag
const cliMode = process.argv.includes('--cli');

/**
 * Create the main application window
 */
async function createWindow() {
  // Check for admin privileges - auto-elevate if not admin
  const admin = await isElevated();
  if (!admin && !process.argv.includes('--no-elevate')) {
    // Relaunch as admin via PowerShell Start-Process -Verb RunAs
    const { spawn } = require('child_process');
    const exePath = process.argv[0];
    const args = process.argv.slice(1).concat('--no-elevate');
    const psCmd = `Start-Process -FilePath '${exePath}' -ArgumentList '${args.join("' '")}' -Verb RunAs`;

    const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore'
    });
    ps.unref();
    app.quit();
    return;
  }

  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: '1132 Eliminator',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#0a0a0a',
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
    reinstall: !process.argv.includes('--no-reinstall'),
    exportJson: process.argv.includes('--json'),
    selfTest: process.argv.includes('--self-test')
  };

  logger.setSessionOptions(options);

  const sessionStart = Date.now();
  logger.initLogger();

  // Self-test mode
  if (options.selfTest) {
    logger.section('SELF-TEST MODE (DRY RUN)');
    console.log('Running self-test (no changes will be made)...');
    const selfTest = require('./operations/self-test');
    const results = await selfTest.runSelfTest();
    logger.setVerification(results);
    logger.setSessionSuccess(results.allPassed);

    console.log('');
    console.log('========================================');
    console.log('  SELF-TEST RESULTS');
    console.log('========================================');
    console.log(`  Zoom installed: ${results.zoomInstalled ? 'Yes' : 'No'}`);
    console.log(`  Registry entries: ${results.registryCount}`);
    console.log(`  Data folders: ${results.folderCount}`);
    console.log(`  Fingerprint files: ${results.fingerprintCount}`);
    console.log(`  Services running: ${results.serviceCount}`);
    console.log(`  All checks passed: ${results.allPassed}`);
    console.log(`  Log: ${logger.getLogPath()}`);
    if (options.exportJson) {
      const jsonPath = logger.exportSessionJson();
      console.log(`  JSON: ${jsonPath}`);
    }
    console.log('========================================');

    logger.finalize();
    app.exit(results.allPassed ? 0 : 1);
    return;
  }

  logger.section('CLI MODE - FULL RESET STARTED');
  logger.info('Options:', options);
  logger.info('CLI args:', process.argv.slice(2));

  const admin = await isElevated();
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
    logger.recordStep('kill', killResult);

    // Step 2: Uninstall
    if (options.uninstall) {
      console.log('[2/9] Uninstalling Zoom...');
      const uninstallResult = await uninstaller.uninstallZoom();
      steps.push({ name: 'uninstall', ...uninstallResult });
      logger.recordStep('uninstall', uninstallResult);
    }

    // Step 3: Remove services and tasks
    console.log('[3/9] Removing services and tasks...');
    const servicesResult = await services.cleanServicesAndTasks();
    steps.push({ name: 'services', ...servicesResult });
    logger.recordStep('services', servicesResult);

    // Step 4: Clean registry
    console.log('[4/9] Cleaning registry...');
    const registryResult = await registry.cleanRegistry();
    steps.push({ name: 'registry', ...registryResult });
    logger.recordStep('registry', registryResult);

    // Step 5: Wipe device fingerprint
    console.log('[5/9] Wiping device fingerprint...');
    const fingerprintResult = await fingerprint.wipeDeviceFingerprint();
    steps.push({ name: 'fingerprint', ...fingerprintResult });
    logger.recordStep('fingerprint', fingerprintResult);

    // Step 6: Delete folders
    console.log('[6/9] Deleting Zoom data...');
    const foldersResult = await folders.deleteAllZoomFolders();
    steps.push({ name: 'folders', ...foldersResult });
    logger.recordStep('folders', foldersResult);

    // Step 7: Clean recycle bin
    console.log('[7/9] Cleaning Recycle Bin...');
    const recycleBinResult = await fingerprint.cleanRecycleBin();
    steps.push({ name: 'recycleBin', ...recycleBinResult });
    logger.recordStep('recycleBin', recycleBinResult);

    // Step 8: Rebuild icon cache
    console.log('[8/9] Rebuilding icon cache...');
    const iconCacheResult = await fingerprint.rebuildIconCache();
    steps.push({ name: 'iconCache', ...iconCacheResult });
    logger.recordStep('iconCache', iconCacheResult);

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
        logger.recordStep('install', installResult);
        installer.cleanupInstaller(installerPath);
      } else {
        steps.push({ name: 'download', success: false, error: downloadResult.error });
        logger.recordStep('download', { success: false, error: downloadResult.error });
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

    logger.setVerification(verification);
    logger.setSessionSuccess(allClean);

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
    if (options.exportJson) {
      const jsonPath = logger.exportSessionJson();
      console.log(`  JSON: ${jsonPath}`);
    }
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
    logger.setSessionSuccess(false);

    console.error('');
    console.error('========================================');
    console.error('  RESET FAILED');
    console.error('========================================');
    console.error(`  Error: ${error.message}`);
    console.error(`  Log: ${logger.getLogPath()}`);
    if (options.exportJson) {
      const jsonPath = logger.exportSessionJson();
      console.error(`  JSON: ${jsonPath}`);
    }
    console.error('========================================');

    if (installerPath) {
      installer.cleanupInstaller(installerPath);
    }

    logger.finalize();
    app.exit(1);
  }
}

/**
 * Run preset operations from CLI
 */
async function runPresetMode() {
  const presets = require('./operations/presets');

  // List presets
  if (process.argv.includes('--list-presets')) {
    console.log('\nAvailable Presets:\n');
    for (const preset of presets.listPresets()) {
      console.log(`  ${preset.id}`);
      console.log(`    Name: ${preset.name}`);
      console.log(`    ${preset.description}\n`);
    }
    app.exit(0);
    return;
  }

  // Apply preset
  const applyIndex = process.argv.indexOf('--apply-preset');
  if (applyIndex !== -1) {
    const presetId = process.argv[applyIndex + 1];
    if (!presetId || presetId.startsWith('--')) {
      console.error('Error: --apply-preset requires a preset ID');
      console.error('Use --list-presets to see available presets');
      app.exit(1);
      return;
    }

    const result = presets.applyPreset(presetId);
    if (result.success) {
      console.log(`\nPreset "${presetId}" applied successfully!`);
      console.log(`Settings changed: ${result.applied.length}`);
      app.exit(0);
    } else {
      console.error(`\nFailed to apply preset: ${result.error}`);
      app.exit(1);
    }
    return;
  }
}

// App lifecycle
app.whenReady().then(() => {
  if (cliMode) {
    if (process.argv.includes('--full-reset') || process.argv.includes('--self-test')) {
      runCliMode();
    } else if (process.argv.includes('--list-presets') || process.argv.includes('--apply-preset')) {
      runPresetMode();
    } else {
      console.log('CLI Mode - Available options:');
      console.log('  --full-reset      Run full Zoom reset');
      console.log('  --self-test       Run self-test (dry run)');
      console.log('  --list-presets    List available presets');
      console.log('  --apply-preset X  Apply a preset profile');
      console.log('  --json            Export session as JSON');
      console.log('  --no-reinstall    Skip Zoom reinstall');
      console.log('  --no-uninstall    Skip Zoom uninstall');
      app.exit(0);
    }
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
    '1132 Eliminator - Error',
    `An unexpected error occurred:\n\n${error.message}\n\nCheck the log file for details.`
  );
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});
