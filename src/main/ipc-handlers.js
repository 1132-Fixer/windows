/**
 * 1132 Fixer - IPC Handlers
 *
 * What actually fixes Error 1132:
 * Zoom's ban check reads system-level identifiers in real-time at sign-in.
 * It does NOT use cached HKCU registry or AppData values.
 * The critical vectors are: MachineGuid, volume serial, MAC address, computer name,
 * and cached fingerprint traces (telemetry DBs, CptService, Amcache, SRUM, etc.).
 *
 * Kill Zoom, wipe all traces, rotate IDs, relaunch.
 */

const { ipcMain, dialog } = require('electron');
const logger = require('./utils/logger');

const processKiller = require('./operations/process-killer');
const installer = require('./operations/installer');
const services = require('./operations/services');
const fingerprint = require('./operations/fingerprint');

let mainWindow = null;

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

function setMainWindow(window) {
  mainWindow = window;
  logger.setMainWindow(window);
}

function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('reset-progress', data);
  }
}

/**
 * Core fix — wipe fingerprint traces and rotate system identifiers.
 *
 * Flow:
 *  1. Kill Zoom processes + CptService
 *  2. Stop Zoom services
 *  3. Wipe device fingerprint traces (telemetry, CptService, registry, Amcache, etc.)
 *  4. Rotate MachineGuid
 *  5. Change volume serial
 *  6. Spoof MAC addresses
 *  7. Randomize computer name
 *  8. Relaunch Zoom
 */
async function performFullReset(options = {}) {
  const sessionStart = Date.now();
  logger.initLogger();
  logger.section('1132 FIX STARTED');

  const steps = {};

  try {
    // ── STEP 1: Kill Zoom ───────────────────────────
    sendProgress({ step: 'Killing Zoom processes...', percent: 5 });
    steps.kill = await processKiller.killAllZoomProcesses((p) => {
      sendProgress({ step: p.message, percent: 5 + (p.current / p.total) * 15 });
    });
    await new Promise(r => setTimeout(r, 1000));
    await processKiller.killAllZoomProcesses();

    // ── STEP 2: Stop services ───────────────────────
    sendProgress({ step: 'Stopping Zoom services...', percent: 25 });
    steps.services = await services.removeAllZoomServices((p) => {
      sendProgress({ step: p.message, percent: 25 + (p.current / p.total) * 10 });
    });

    // ── STEP 3: Wipe device fingerprint traces ─────
    sendProgress({ step: 'Wiping fingerprint traces...', percent: 35 });
    steps.fingerprint = await fingerprint.wipeDeviceFingerprint((p) => {
      sendProgress({ step: p.message, percent: 35 + (p.current / p.total) * 20 });
    });

    // ── STEP 4: Rotate MachineGuid ───────────────────
    sendProgress({ step: 'Rotating MachineGuid...', percent: 55 });
    steps.machineGuid = await fingerprint.rotateMachineGuid();

    // ── STEP 5: Change volume serial ─────────────────
    sendProgress({ step: 'Changing volume serial...', percent: 62 });
    steps.volumeSerial = await fingerprint.changeVolumeSerial();

    // ── STEP 6: Spoof MAC addresses ─────────────────
    sendProgress({ step: 'Spoofing MAC addresses...', percent: 70 });
    steps.macAddresses = await fingerprint.spoofMacAddresses();

    // ── STEP 7: Randomize computer name ─────────────
    sendProgress({ step: 'Randomizing computer name...', percent: 78 });
    steps.computerName = await fingerprint.randomizeComputerName();

    // ── STEP 8: Relaunch Zoom ───────────────────────
    if (options.launch !== false) {
      sendProgress({ step: 'Launching Zoom...', percent: 88 });
      steps.launch = await installer.launchZoom();
    }

    // ── DONE ────────────────────────────────────────
    sendProgress({ step: 'Complete', percent: 100 });

    const durationSec = Math.round((Date.now() - sessionStart) / 1000);
    logger.section('FIX COMPLETE');
    logger.ok(`Done in ${durationSec}s`, steps);
    logger.finalize();

    saveLastFix({ timestamp: new Date().toISOString(), success: true, durationSec });

    return { success: true, steps, logPath: logger.getLogPath() };

  } catch (error) {
    logger.error('Fix failed', { error: error.message, stack: error.stack });
    logger.finalize();

    saveLastFix({ timestamp: new Date().toISOString(), success: false, error: error.message });

    return { success: false, error: error.message, steps, logPath: logger.getLogPath() };
  }
}

function registerHandlers() {
  ipcMain.handle('full-reset', async (event, options = {}) => {
    return await performFullReset(options);
  });

  ipcMain.handle('launch-zoom', async () => {
    return await installer.launchZoom();
  });

  ipcMain.handle('show-confirm-dialog', async (event, message) => {
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '1132 Fixer',
      message,
      buttons: ['Yes', 'No'],
      defaultId: 1,
      cancelId: 1
    });
    return result.response === 0;
  });

  ipcMain.handle('get-version', () => require('electron').app.getVersion());

  ipcMain.handle('get-system-info', async () => {
    try {
      const os = require('os');
      const { app } = require('electron');

      let admin = false;
      try { require('child_process').execSync('net session', { stdio: 'ignore' }); admin = true; } catch (_) {}

      const lastFix = getLastFix();
      let lastFixText = 'Never';
      let lastFixStatus = null;
      if (lastFix && lastFix.timestamp) {
        const d = new Date(lastFix.timestamp);
        lastFixText = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        lastFixStatus = lastFix.success ? 'Completed' : 'Failed';
      }

      return { version: app.getVersion(), os: `Windows ${os.release()} (${os.arch()})`, admin, lastFix: lastFixText, lastFixStatus };
    } catch (err) {
      return { version: '?', os: 'Windows', admin: false, lastFix: '?', lastFixStatus: null };
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

  ipcMain.handle('quit-app', () => {
    logger.finalize();
    require('electron').app.quit();
  });
}

module.exports = { setMainWindow, registerHandlers, sendProgress };
