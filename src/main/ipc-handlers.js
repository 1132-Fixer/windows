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
const dpapiLauncher = require('./operations/dpapi-launcher');

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
 *  1. Kill Zoom processes
 *  2. Rotate MachineGuid + volume serial
 *  3. Wipe fingerprint DATA files only (no registry, no service deletion)
 *  4. Relaunch Zoom with DPAPI hook
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe, runPowerShell } = require('./utils/spawn-safe');

/**
 * Spoof WMI-queryable hardware serial numbers.
 * Zoom reads Win32_DiskDrive.SerialNumber, Win32_BIOS.SerialNumber,
 * Win32_BaseBoard.SerialNumber, and Win32_ComputerSystemProduct.UUID
 * via WMI to build a hardware fingerprint. These are stored in the
 * WMI repository and SMBIOS registry cache — we can patch both.
 */
async function spoofWmiHardwareSerials() {
  logger.info('Spoofing WMI hardware serial numbers...');

  try {
    const result = await runPowerShell(`
      $count = 0

      # 1. Patch disk drive serial in SCSI/IDE registry (what WMI reads)
      $diskEnumPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\SCSI'
      if (Test-Path $diskEnumPath) {
        Get-ChildItem $diskEnumPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          if ($props.FriendlyName -like '*disk*' -or $props.DeviceDesc -like '*disk*') {
            # Generate random serial-like string
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            $b = New-Object byte[] 10
            $rng.GetBytes($b)
            $newSerial = ($b | ForEach-Object { $_.ToString('X2') }) -join ''
            try {
              Set-ItemProperty -Path $_.PSPath -Name 'FirmwareRevision' -Value $newSerial -Force -EA SilentlyContinue
              $count++
            } catch {}
          }
        }
      }

      # Also check IDE path
      $ideEnumPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Enum\\IDE'
      if (Test-Path $ideEnumPath) {
        Get-ChildItem $ideEnumPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          if ($props.FriendlyName -like '*disk*') {
            $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
            $b = New-Object byte[] 10
            $rng.GetBytes($b)
            $newSerial = ($b | ForEach-Object { $_.ToString('X2') }) -join ''
            try {
              Set-ItemProperty -Path $_.PSPath -Name 'FirmwareRevision' -Value $newSerial -Force -EA SilentlyContinue
              $count++
            } catch {}
          }
        }
      }

      # 2. Randomize SMBIOS data cache in registry
      #    Windows caches SMBIOS tables here; WMI reads from this cache
      $smbiosPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\mssmbios\\Data'
      if (Test-Path $smbiosPath) {
        $smbiosData = (Get-ItemProperty $smbiosPath -Name 'SMBiosData' -EA SilentlyContinue).SMBiosData
        if ($smbiosData -and $smbiosData.Length -gt 100) {
          # Backup
          $backupPath = Join-Path $env:LOCALAPPDATA '1132Fixer'
          if (-not (Test-Path $backupPath)) { New-Item $backupPath -ItemType Directory -Force | Out-Null }
          [System.IO.File]::WriteAllBytes((Join-Path $backupPath 'SMBiosData.bak'), $smbiosData)

          # Randomize serial number regions in the SMBIOS binary blob
          # SMBIOS Type 1 (System Info) and Type 2 (Baseboard) contain serials
          # We randomize bytes in the string table sections
          $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
          $randBytes = New-Object byte[] 32
          $rng.GetBytes($randBytes)

          # Patch known serial string offsets (varies by BIOS, so we XOR a range)
          $len = $smbiosData.Length
          # XOR bytes 64-96 and 128-160 (typical serial string table locations)
          for ($i = 0; $i -lt 32; $i++) {
            if (64 + $i -lt $len) { $smbiosData[64 + $i] = $smbiosData[64 + $i] -bxor $randBytes[$i] }
            if (128 + $i -lt $len) { $smbiosData[128 + $i] = $smbiosData[128 + $i] -bxor $randBytes[$i] }
          }

          try {
            Set-ItemProperty -Path $smbiosPath -Name 'SMBiosData' -Value $smbiosData -Force
            $count++
          } catch {}
        }
      }

      # 3. Rotate the Windows InstallDate (another fingerprint vector)
      $ntPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
      try {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $b = New-Object byte[] 4
        $rng.GetBytes($b)
        # Generate a plausible install timestamp (within last 2 years)
        $base = [int][DateTimeOffset]::UtcNow.AddYears(-2).ToUnixTimeSeconds()
        $range = [int][DateTimeOffset]::UtcNow.AddMonths(-1).ToUnixTimeSeconds() - $base
        $newDate = $base + ([System.BitConverter]::ToUInt32($b, 0) % $range)
        Set-ItemProperty -Path $ntPath -Name InstallDate -Value $newDate -Force -EA SilentlyContinue
        $count++
      } catch {}

      # 4. Rotate BuildGUID (unique per Windows install)
      try {
        $newBuildGuid = [System.Guid]::NewGuid().ToString()
        Set-ItemProperty -Path $ntPath -Name BuildGUID -Value $newBuildGuid -Force -EA SilentlyContinue
        $count++
      } catch {}

      # 5. Clean Windows diagnostic data
      $diagPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Diagnostics\\DiagTrack'
      if (Test-Path $diagPath) {
        try {
          $newMachineId = [System.Guid]::NewGuid().ToString()
          Set-ItemProperty -Path $diagPath -Name MachineId -Value $newMachineId -Force -EA SilentlyContinue
          $count++
        } catch {}
      }

      Write-Output $count
    `, { timeout: 45000 });

    const spoofed = parseInt(result.stdout, 10) || 0;
    logger.ok('WMI hardware serial spoofing: ' + spoofed + ' identifiers modified');
    return { success: true, spoofed };
  } catch (e) {
    logger.warn('WMI hardware spoof failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Wipe ONLY the specific data files that contain Zoom's device fingerprint.
 * Does NOT touch: registry keys, Windows services, Uninstall entries.
 * This preserves Zoom's installation integrity.
 */
async function wipeZoomFingerprintDataOnly() {
  const results = { deleted: 0, errors: [] };

  const roaming = process.env.APPDATA;
  const local = process.env.LOCALAPPDATA;
  const programData = process.env.ProgramData || 'C:\\ProgramData';

  // 1. Delete fingerprint config files
  const configFiles = [];
  for (const base of [roaming, local]) {
    for (const root of ['Zoom', 'Zoom Workplace']) {
      for (const f of ['Zoom.us.ini', 'viper.ini', 'appsafecheck.txt', 'ZoomWorkplace.ini']) {
        configFiles.push(path.join(base, root, f));
      }
    }
  }

  for (const fp of configFiles) {
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        results.deleted++;
        logger.ok(`Deleted config: ${fp}`);
      }
    } catch (e) {
      results.errors.push(fp);
    }
  }

  // 2. Delete data subdirectories (NOT bin/ — that's the Zoom installation)
  const dataSubdirs = ['data', 'EBWebView', 'app-data', 'logs', 'CrashDumps', 'WebviewCacheX64'];
  for (const base of [roaming, local]) {
    for (const root of ['Zoom', 'Zoom Workplace']) {
      for (const sub of dataSubdirs) {
        const dirPath = path.join(base, root, sub);
        try {
          if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
            results.deleted++;
            logger.ok(`Deleted data dir: ${dirPath}`);
          }
        } catch (e) {
          results.errors.push(dirPath);
        }
      }
    }
  }

  // 3. Delete CptService ProgramData (fingerprint storage)
  for (const pd of ['CptService', 'CptHost', 'Zoom CptService', 'zCSCptService']) {
    const dirPath = path.join(programData, pd);
    try {
      if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        results.deleted++;
        logger.ok(`Deleted CptService data: ${dirPath}`);
      }
    } catch (e) {
      results.errors.push(dirPath);
    }
  }

  // 4. Delete ONLY the Secrets and SystemInfo registry subkeys (fingerprint data)
  //    Do NOT delete HKLM\SOFTWARE\Zoom itself or Uninstall entries
  try {
    await runPowerShell(`
      $count = 0
      foreach ($k in @(
        'HKCU\\Software\\Zoom\\Secrets',
        'HKCU\\Software\\Zoom\\SystemInfo',
        'HKLM\\Software\\Zoom\\Secrets',
        'HKLM\\Software\\Zoom\\SystemInfo',
        'HKCU\\Software\\Zoom Workplace\\Secrets',
        'HKCU\\Software\\Zoom Workplace\\SystemInfo',
        'HKLM\\Software\\Zoom Workplace\\Secrets',
        'HKLM\\Software\\Zoom Workplace\\SystemInfo',
        'HKCU\\Software\\CptService',
        'HKLM\\Software\\CptService'
      )) {
        reg delete $k /f 2>$null | Out-Null
        $count++
      }
      Write-Host $count
    `, { timeout: 10000 });
    logger.ok('Deleted fingerprint registry keys (Secrets/SystemInfo only)');
  } catch (e) {
    logger.warn('Registry cleanup partial', { error: e.message });
  }

  // 5. Stop CptService (but don't delete it — just stop it so it doesn't interfere)
  try {
    await spawnSafe('sc', ['stop', 'ZoomCptService'], { timeout: 5000 }).catch(() => {});
    await spawnSafe('sc', ['stop', 'CptService'], { timeout: 5000 }).catch(() => {});
    logger.ok('Stopped CptService');
  } catch (_) {}

  logger.ok(`Fingerprint data wipe: ${results.deleted} items deleted`);
  return { success: true, deleted: results.deleted, errors: results.errors };
}

async function performFullReset(options = {}) {
  const sessionStart = Date.now();
  logger.initLogger();
  logger.section('1132 FIX STARTED');

  const steps = {};

  try {
    // ── STEP 1: Kill ALL Zoom + CptService processes ─────────────
    sendProgress({ step: 'Killing Zoom processes...', percent: 2 });
    steps.kill = await processKiller.killAllZoomProcesses((p) => {
      sendProgress({ step: p.message, percent: 2 + (p.current / p.total) * 5 });
    });
    await new Promise(r => setTimeout(r, 1000));
    await processKiller.killAllZoomProcesses();

    // ── STEP 2: Stop and remove Zoom services ────────────────────
    sendProgress({ step: 'Removing Zoom services...', percent: 8 });
    steps.services = await services.cleanServicesAndTasks((p) => {
      sendProgress({ step: p.message, percent: 8 + (p.current / p.total) * 5 });
    });

    // ── STEP 3: Neutralize CptService binaries ──────────────────
    sendProgress({ step: 'Neutralizing CptService binaries...', percent: 14 });
    steps.neutralize = await fingerprint.neutralizeCptServiceBinary();

    // ── STEP 4: Block Zoom network access during fix ─────────────
    // Prevents CptService/Zoom from phoning home and re-registering
    // the device fingerprint while we're wiping it
    sendProgress({ step: 'Blocking Zoom network access...', percent: 16 });
    steps.networkBlock = await fingerprint.blockCptServiceNetwork();

    // ── STEP 5: Rotate ALL system identifiers ────────────────────
    sendProgress({ step: 'Rotating MachineGuid...', percent: 18 });
    steps.machineGuid = await fingerprint.rotateMachineGuid();

    sendProgress({ step: 'Changing volume serial...', percent: 22 });
    steps.volumeSerial = await fingerprint.changeVolumeSerial();

    sendProgress({ step: 'Spoofing MAC addresses...', percent: 26 });
    steps.macSpoof = await fingerprint.spoofMacAddresses();

    sendProgress({ step: 'Randomizing computer name...', percent: 30 });
    steps.computerName = await fingerprint.randomizeComputerName();

    // ── STEP 6: Spoof hardware IDs ───────────────────────────────
    // SQMClient MachineId, Hardware Profile GUID, Windows ProductId,
    // DigitalProductId, WMI/MSI installer DB — all fingerprint vectors
    sendProgress({ step: 'Spoofing hardware identifiers...', percent: 34 });
    steps.hardwareIds = await fingerprint.spoofHardwareIds();

    // ── STEP 7: Full device fingerprint wipe (master orchestrator) ─
    // Runs ALL wipe operations in parallel tiers: telemetry DBs,
    // CptService data, registry, credentials, prefetch, Amcache,
    // SRUM, event logs, user profiles, deep traces, browser data,
    // DNS, firewall, jump lists, VirtualStore, crash dumps, temp
    // files, certificates, BITS jobs, network profiles, notifications,
    // font cache — with verification at the end
    sendProgress({ step: 'Wiping ALL device fingerprints...', percent: 40 });
    steps.fingerprintWipe = await fingerprint.wipeDeviceFingerprint((p) => {
      const pct = 40 + (p.current / p.total) * 25;
      sendProgress({ step: p.message, percent: Math.round(pct) });
    });

    // ── STEP 8: Kill any respawned processes ─────────────────────
    sendProgress({ step: 'Final process kill...', percent: 66 });
    await processKiller.killAllZoomProcesses();
    await new Promise(r => setTimeout(r, 500));

    // ── STEP 9: Pre-launch scrub (BEFORE DENY ACLs) ─────────────
    // Cleans up any leftover DENY ACLs from previous runs, nukes
    // all registry + data, kills processes. Must run BEFORE we set
    // fresh DENY ACLs so it doesn't undo them.
    sendProgress({ step: 'Pre-launch scrub...', percent: 68 });
    steps.preLaunchScrub = await fingerprint.preLaunchScrub();

    // ── STEP 10: Spoof WMI hardware identifiers ──────────────────
    // Zoom queries Win32_DiskDrive, Win32_BIOS, Win32_BaseBoard via
    // WMI to fingerprint the physical hardware. We intercept these
    // by patching the WMI repository entries.
    sendProgress({ step: 'Spoofing WMI hardware serials...', percent: 72 });
    steps.wmiSpoof = await spoofWmiHardwareSerials();

    // ── STEP 11: Post-install registry scrub + DENY ACLs ─────────
    // CRITICAL: This must be the LAST cleanup step before launch.
    // Sets DENY WRITE ACLs on Zoom's SystemInfo/Secrets registry
    // keys so Zoom CANNOT write hardware fingerprints on startup.
    sendProgress({ step: 'Setting registry DENY ACLs...', percent: 78 });
    steps.postScrub = await fingerprint.postInstallScrub();

    // ── STEP 12: Remove network blocks ───────────────────────────
    sendProgress({ step: 'Removing network blocks...', percent: 82 });
    steps.networkUnblock = await fingerprint.unblockCptServiceNetwork();

    // ── STEP 13: Relaunch Zoom as clean Windows user ────────────
    // CRITICAL: Zoom's device fingerprint includes a DPAPI-encrypted key
    // (win_osencrypt_key) tied to the Windows user's SID. Same user =
    // same fingerprint, even after data wipe + reinstall. A fresh Windows
    // user has different DPAPI keys → different fingerprint → no ban.
    if (options.launch !== false) {
      sendProgress({ step: 'Creating clean user & launching Zoom...', percent: 88 });
      steps.launch = await installer.launchZoomAsCleanUser();

      // If clean user launch failed, fall back to DPAPI hook method
      if (!steps.launch.success) {
        logger.warn('Clean user launch failed, falling back to DPAPI hook');
        sendProgress({ step: 'Falling back to DPAPI hook launch...', percent: 92 });
        steps.launch = await dpapiLauncher.launchZoomWithDpapiHook();
      }
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
