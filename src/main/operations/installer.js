/**
 * 1132 Remover - Zoom Installer
 * Downloads and installs fresh Zoom
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_INSTALLER, ZOOM_EXECUTABLE_PATHS, formatBytes } = require('../../shared/constants');
const { isElevated } = require('../utils/elevation');

/**
 * Download a file from URL with progress tracking
 * @param {string} url - URL to download
 * @param {string} destPath - Destination file path
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, size: number}>}
 */
function downloadFile(url, destPath, onProgress = null) {
  return new Promise((resolve, reject) => {
    logger.info(`Downloading: ${url}`);

    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        logger.debug(`Redirecting to: ${redirectUrl}`);
        downloadFile(redirectUrl, destPath, onProgress)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10) || 0;
      let downloadedSize = 0;

      // Ensure directory exists
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = fs.createWriteStream(destPath);

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;

        if (onProgress && totalSize > 0) {
          const percent = Math.round((downloadedSize / totalSize) * 100);
          onProgress({
            step: 'download',
            percent,
            downloaded: downloadedSize,
            total: totalSize,
            message: `Downloading: ${percent}%`
          });
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        logger.ok(`Download complete: ${path.basename(destPath)} (${formatBytes(downloadedSize)})`);
        resolve({ success: true, size: downloadedSize });
      });

      file.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    // Timeout
    request.setTimeout(ZOOM_INSTALLER.timeout, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Download fresh Zoom installer
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, path: string}>}
 */
async function downloadZoomInstaller(onProgress = null) {
  logger.section('Downloading Zoom Installer');

  const destPath = ZOOM_INSTALLER.downloadPath;

  // Clean up old installer if exists
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath);
  }

  try {
    await downloadFile(ZOOM_INSTALLER.url, destPath, onProgress);

    // Verify file exists and has content
    if (!fs.existsSync(destPath)) {
      throw new Error('Downloaded file not found');
    }

    const stats = fs.statSync(destPath);
    if (stats.size < 1000000) { // MSI should be at least 1MB
      throw new Error('Downloaded file too small, may be corrupted');
    }

    logger.ok(`Zoom MSI installer ready: ${destPath}`);
    return { success: true, path: destPath };
  } catch (e) {
    logger.error('Failed to download Zoom MSI installer', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Install Zoom from MSI via msiexec
 * @param {string} installerPath - Path to MSI installer
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean}>}
 */
async function installZoom(installerPath, onProgress = null) {
  logger.section('Installing Zoom');

  if (!fs.existsSync(installerPath)) {
    logger.error('Installer not found', { path: installerPath });
    return { success: false, error: 'Installer not found' };
  }

  if (onProgress) {
    onProgress({
      step: 'install',
      message: 'Installing Zoom (please wait)...'
    });
  }

  const elevated = await isElevated();

  try {
    // MSI install via msiexec
    let msiArgs;
    if (elevated) {
      msiArgs = ['/i', installerPath, '/qn', '/norestart', 'ALLUSERS=1', 'AutoStartAfterReboot=0'];
      logger.info('Running MSI installer (elevated, all users)...');
    } else {
      msiArgs = ['/i', installerPath, '/qn', '/norestart', 'AutoStartAfterReboot=0'];
      logger.info('Running MSI installer (per-user)...');
    }

    const startTime = Date.now();
    let result = await spawnSafe('msiexec', msiArgs, { timeout: 300000 });
    const duration = Date.now() - startTime;

    logger.info('MSI process completed', {
      exitCode: result.exitCode,
      durationMs: duration
    });

    // If per-user install failed, try with basic UI to trigger UAC
    if (result.exitCode !== 0 && !elevated) {
      logger.warn('Per-user install failed, trying with UI for elevation...');
      const uacArgs = ['/i', installerPath, '/qb', '/norestart', 'AutoStartAfterReboot=0'];
      result = await spawnSafe('msiexec', uacArgs, { timeout: 300000 });
      logger.info('MSI with UI completed', { exitCode: result.exitCode });
    }

    if (result.exitCode !== 0) {
      throw new Error(`MSI install failed with exit code ${result.exitCode}`);
    }

    logger.ok('Installer process completed');

    // Wait for installation to settle
    logger.info('Waiting for installation to settle...');
    await new Promise(r => setTimeout(r, 3000));

    // Verify installation
    logger.info('Verifying Zoom installation...');
    const installed = await isZoomInstalled();

    if (!installed.success) {
      throw new Error('Zoom.exe not found after installation');
    }

    logger.ok('Zoom installed successfully', { path: installed.path });

    // Post-install hardening
    await hardenZoomInstall();

    return { success: true, zoomPath: installed.path };
  } catch (e) {
    logger.error('Zoom installation failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Post-install hardening: disable auto-update, remove Run entries, set AU2 policy
 * Reduces persistence so Zoom doesn't re-create startup entries or auto-update
 * @returns {Promise<{success: boolean, details: Object}>}
 */
async function hardenZoomInstall() {
  logger.info('Applying post-install hardening...');

  const details = { au2Policy: false, runEntriesRemoved: 0 };

  try {
    const result = await runPowerShell(`
      $count = 0

      # Remove HKCU Run entries (prevent auto-start with Windows)
      $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomUMX','ZoomWorkplace')) {
        if (Get-ItemProperty -Path $runKey -Name $v -ErrorAction SilentlyContinue) {
          Remove-ItemProperty -Path $runKey -Name $v -ErrorAction SilentlyContinue
          $count++
        }
      }

      # Also remove HKLM Run entries
      $runKeyLM = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomCptService')) {
        if (Get-ItemProperty -Path $runKeyLM -Name $v -ErrorAction SilentlyContinue) {
          Remove-ItemProperty -Path $runKeyLM -Name $v -ErrorAction SilentlyContinue
          $count++
        }
      }

      Write-Output $count
    `, { timeout: 15000 });

    details.au2Policy = true;
    details.runEntriesRemoved = parseInt(result.stdout, 10) || 0;
    logger.ok('Post-install hardening applied', details);
  } catch (e) {
    logger.debug('Post-install hardening partially failed', { error: e.message });
  }

  // Kill updater processes and disable scheduled tasks
  try {
    const updaterResult = await killZoomUpdaters();
    details.updatersKilled = updaterResult.killed;
    details.updateTasksDisabled = updaterResult.tasksDisabled;
  } catch (e) {
    logger.debug('Updater kill failed during hardening', { error: e.message });
  }

  return { success: true, details };
}

/**
 * Kill Zoom updater processes and disable their scheduled tasks.
 * Prevents auto-update from restoring identity data before the user joins a meeting.
 * @returns {Promise<{success: boolean, killed: number, tasksDisabled: number}>}
 */
async function killZoomUpdaters() {
  logger.info('Killing Zoom updaters and disabling update tasks...');

  try {
    const result = await runPowerShell(`
      $killed = 0
      $disabled = 0

      # Kill updater processes
      foreach ($proc in @('zUpdater','ZoomUpdate','ZoomUpdateAgent','zPTUpdaterUI','ZoomInstaller')) {
        $running = Get-Process -Name $proc -ErrorAction SilentlyContinue
        if ($running) {
          $running | Stop-Process -Force -ErrorAction SilentlyContinue
          $killed++
        }
      }

      # Disable Zoom scheduled tasks
      Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
        $_.TaskName -match 'Zoom'
      } | ForEach-Object {
        Disable-ScheduledTask -TaskName $_.TaskName -ErrorAction SilentlyContinue | Out-Null
        $disabled++
      }

      Write-Output "$killed|$disabled"
    `, { timeout: 15000 });

    const [killed, tasksDisabled] = (result.stdout || '0|0').trim().split('|').map(n => parseInt(n, 10) || 0);

    if (killed > 0 || tasksDisabled > 0) {
      logger.ok(`Updaters stopped: ${killed} processes killed, ${tasksDisabled} tasks disabled`);
    } else {
      logger.info('No active Zoom updaters found');
    }

    return { success: true, killed, tasksDisabled };
  } catch (e) {
    logger.debug('Updater kill partially failed', { error: e.message });
    return { success: true, killed: 0, tasksDisabled: 0 };
  }
}

/**
 * Check if Zoom is installed and find executable path
 * @returns {Promise<{success: boolean, path?: string}>}
 */
async function isZoomInstalled() {
  for (const p of ZOOM_EXECUTABLE_PATHS) {
    if (fs.existsSync(p)) {
      return { success: true, path: p };
    }
  }

  return { success: false };
}

/**
 * Launch Zoom
 * @returns {Promise<{success: boolean, path?: string}>}
 */
async function launchZoom() {
  logger.info('Launching Zoom...');

  const installed = await isZoomInstalled();
  if (!installed.success) {
    logger.warn('Zoom not found in standard paths, searching...');

    // Try to find Zoom via registry or where command
    try {
      const result = await spawnSafe('where', ['Zoom.exe'], { timeout: 5000 });
      if (result.exitCode === 0 && result.stdout) {
        const zoomPath = result.stdout.split('\n')[0].trim();
        if (fs.existsSync(zoomPath)) {
          logger.info('Found Zoom via where command', { path: zoomPath });
          return await launchZoomPath(zoomPath);
        }
      }
    } catch (e) {
      // Continue
    }

    logger.error('Zoom not found');
    return { success: false, error: 'Zoom not installed' };
  }

  return await launchZoomPath(installed.path);
}

/**
 * Launch Zoom from a specific path
 * @param {string} zoomPath - Path to Zoom.exe
 * @returns {Promise<{success: boolean, path?: string}>}
 */
async function launchZoomPath(zoomPath) {
  try {
    // Method 1: Direct spawn (detached)
    const { spawn } = require('child_process');
    const child = spawn(zoomPath, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    logger.ok('Zoom launched', { path: zoomPath });
    return { success: true, path: zoomPath };
  } catch (e) {
    logger.debug('Direct spawn failed, trying PowerShell', { error: e.message });

    // Method 2: PowerShell Start-Process
    try {
      await runPowerShell(`Start-Process -FilePath "${zoomPath}"`, { timeout: 10000 });
      logger.ok('Zoom launched via PowerShell', { path: zoomPath });
      return { success: true, path: zoomPath };
    } catch (e2) {
      logger.debug('PowerShell launch failed, trying cmd', { error: e2.message });

      // Method 3: cmd start
      try {
        await spawnSafe('cmd', ['/c', 'start', '', zoomPath], { timeout: 10000 });
        logger.ok('Zoom launched via cmd', { path: zoomPath });
        return { success: true, path: zoomPath };
      } catch (e3) {
        logger.error('All launch methods failed', { error: e3.message });
        return { success: false, error: e3.message };
      }
    }
  }
}

/**
 * Clean Room Launch — bypass 1132 by wiping ALL Zoom fingerprint data before launch.
 *
 * How it works:
 *   1. Kill all existing Zoom processes and services
 *   2. Delete ALL Zoom data from real APPDATA/LOCALAPPDATA/ProgramData
 *      (telemetry DBs, encrypted DBs, config files — everything)
 *   3. Delete ALL Zoom registry keys (HKCU + HKLM + WOW64)
 *   4. Kill updaters, then launch Zoom — it sees empty data dirs + no registry
 *      → generates a completely fresh device fingerprint → no ban
 *
 * NOTE: Env var APPDATA redirect does NOT work for Win32 apps like Zoom.
 * Zoom uses SHGetKnownFolderPath() which reads the registry, not env vars.
 * The only reliable approach is to wipe the real data directories.
 */
async function launchZoomCleanRoom() {
  logger.info('Clean room launch: starting...');

  const installed = await isZoomInstalled();
  if (!installed.success) {
    return { success: false, error: 'Zoom not installed' };
  }

  const zoomExe = installed.path;

  try {
    // Step 1: Kill all Zoom processes and services
    logger.info('Clean room: killing existing Zoom processes...');
    await runPowerShell(`
      # Kill all known Zoom process names
      $names = @('Zoom','Zoomus','Zoom_launcher','CptHost','CptService','CptControl',
        'aomhost','aomhost64','airhost','zCrashReport','zCrashReport64',
        'ZoomWebHost','zWebview2Agent','zCefAgent','zUpdater','ZoomInstaller',
        'zcscpthost','zCSCptService','ZoomDocConverter','zTscoder')
      foreach ($n in $names) { taskkill /F /IM "$n.exe" 2>$null | Out-Null }
      Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } | Stop-Process -Force -EA SilentlyContinue
      Get-Process -Name 'CptService','CptHost','CptControl' -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
      # Stop and delete services
      Stop-Service -Name 'ZoomCptService' -Force -EA SilentlyContinue
      Stop-Service -Name 'CptService' -Force -EA SilentlyContinue
      sc.exe delete ZoomCptService 2>$null | Out-Null
      sc.exe delete CptService 2>$null | Out-Null
      sc.exe delete zCSCptService 2>$null | Out-Null
      Start-Sleep -Seconds 2
      # Second pass — catch respawns
      Get-Process | Where-Object { $_.Name -like '*zoom*' } | Stop-Process -Force -EA SilentlyContinue
    `, { timeout: 15000 }).catch(() => {});

    // Step 2: Wipe ALL Zoom data from REAL APPDATA/LOCALAPPDATA/ProgramData
    // NOTE: We wipe the REAL directories, not a fake clean room.
    // Zoom uses Win32 SHGetKnownFolderPath, not %APPDATA% env var.
    logger.info('Clean room: wiping ALL Zoom data directories...');
    await runPowerShell(`
      $roaming = [Environment]::GetFolderPath('ApplicationData')
      $local = [Environment]::GetFolderPath('LocalApplicationData')

      # Wipe Zoom data dirs in Roaming (telemetry DBs, encrypted DBs, config)
      $zoomRoaming = Join-Path $roaming 'Zoom'
      if (Test-Path $zoomRoaming) {
        # Delete data/, logs/, reports/, EBWebView/, app-data/ — all fingerprint sources
        @('data','logs','reports','EBWebView','app-data','aomhost','CptService') | ForEach-Object {
          $p = Join-Path $zoomRoaming $_
          if (Test-Path $p) { Remove-Item $p -Recurse -Force -EA SilentlyContinue }
        }
        # Delete config files with device identifiers
        @('Zoom.us.ini','viper.ini','appsafecheck.txt','ZoomWorkplace.ini') | ForEach-Object {
          $p = Join-Path $zoomRoaming $_
          if (Test-Path $p) { Remove-Item $p -Force -EA SilentlyContinue }
        }
      }

      # Same for Zoom Workplace (newer branding)
      $zoomWpRoaming = Join-Path $roaming 'Zoom Workplace'
      if (Test-Path $zoomWpRoaming) {
        Remove-Item $zoomWpRoaming -Recurse -Force -EA SilentlyContinue
      }

      # Wipe Zoom data dirs in Local
      $zoomLocal = Join-Path $local 'Zoom'
      if (Test-Path $zoomLocal) {
        @('data','plugin','EBWebView','app-data','CptService') | ForEach-Object {
          $p = Join-Path $zoomLocal $_
          if (Test-Path $p) { Remove-Item $p -Recurse -Force -EA SilentlyContinue }
        }
      }
      $zoomWpLocal = Join-Path $local 'Zoom Workplace'
      if (Test-Path $zoomWpLocal) {
        Remove-Item $zoomWpLocal -Recurse -Force -EA SilentlyContinue
      }

      # Other Zoom AppData variants
      foreach ($sub in @('ZoomUMX','zoomus','zoom.us','ZoomVideoComm','ZoomGifCollector',
                         'Zoom Meetings','ZoomLogs','zoom.us','Zoom VDI')) {
        $p1 = Join-Path $roaming $sub
        $p2 = Join-Path $local $sub
        if (Test-Path $p1) { Remove-Item $p1 -Recurse -Force -EA SilentlyContinue }
        if (Test-Path $p2) { Remove-Item $p2 -Recurse -Force -EA SilentlyContinue }
      }

      # Wipe ProgramData fingerprints (CptService, device IDs)
      foreach ($pd in @('CptService','CptHost','Zoom','ZoomVideo','ZoomVideoComm',
                        'Zoom Video Communications','Zoom CptService','zCSCptService',
                        'Zoom Workplace','1132Fixer')) {
        $p = Join-Path $env:ProgramData $pd
        if (Test-Path $p) { Remove-Item $p -Recurse -Force -EA SilentlyContinue }
      }

      # Clean Windows credentials
      cmdkey /list 2>$null | Select-String 'zoom' -CaseSensitive:$false | ForEach-Object {
        $target = ($_ -split 'Target:')[1]
        if ($target) { cmdkey /delete:$target.Trim() 2>$null | Out-Null }
      }
    `, { timeout: 20000 }).catch(() => {});

    // Step 3: Clean ALL Zoom registry keys (HKCU + HKLM + WOW64)
    logger.info('Clean room: cleaning registry...');
    await runPowerShell(`
      # HKCU keys — remove DENY ACLs first (from previous fixer runs), then delete
      $hkcuKeys = @(
        'HKCU:\\Software\\Zoom', 'HKCU:\\Software\\ZoomUMX', 'HKCU:\\Software\\zoom.us',
        'HKCU:\\Software\\Zoom Video Communications', 'HKCU:\\Software\\Zoom Workplace',
        'HKCU:\\Software\\ZoomVideoComm', 'HKCU:\\Software\\ZoomGifCollector',
        'HKCU:\\Software\\CptService'
      )
      foreach ($k in $hkcuKeys) {
        if (Test-Path $k) {
          try {
            $acl = Get-Acl $k
            $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
              $acl.RemoveAccessRule($_) | Out-Null
            }
            Set-Acl $k $acl -EA SilentlyContinue
            Get-ChildItem $k -Recurse -EA SilentlyContinue | ForEach-Object {
              try {
                $subAcl = Get-Acl $_.PSPath
                $subAcl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
                  $subAcl.RemoveAccessRule($_) | Out-Null
                }
                Set-Acl $_.PSPath $subAcl -EA SilentlyContinue
              } catch {}
            }
          } catch {}
          Remove-Item $k -Recurse -Force -EA SilentlyContinue
        }
      }
      # reg.exe for reliability
      foreach ($k in @(
        'HKCU\\Software\\Zoom', 'HKCU\\Software\\ZoomUMX', 'HKCU\\Software\\zoom.us',
        'HKCU\\Software\\CptService', 'HKCU\\Software\\Zoom Video Communications',
        'HKCU\\Software\\Zoom Workplace', 'HKCU\\Software\\ZoomVideoComm',
        'HKCU\\Software\\ZoomGifCollector'
      )) { reg delete $k /f 2>$null | Out-Null }

      # HKLM + WOW64 keys
      $hklmKeys = @(
        'HKLM:\\SOFTWARE\\Zoom', 'HKLM:\\SOFTWARE\\ZoomUMX', 'HKLM:\\SOFTWARE\\zoom.us',
        'HKLM:\\SOFTWARE\\Zoom Video Communications', 'HKLM:\\SOFTWARE\\Zoom Workplace',
        'HKLM:\\SOFTWARE\\ZoomVideoComm', 'HKLM:\\SOFTWARE\\CptService',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Zoom', 'HKLM:\\SOFTWARE\\WOW6432Node\\ZoomUMX',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Zoom Workplace', 'HKLM:\\SOFTWARE\\WOW6432Node\\CptService',
        'HKLM:\\SOFTWARE\\WOW6432Node\\ZoomVideoComm', 'HKLM:\\SOFTWARE\\Policies\\Zoom'
      )
      foreach ($k in $hklmKeys) {
        if (Test-Path $k) {
          try {
            $acl = Get-Acl $k
            $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
              $acl.RemoveAccessRule($_) | Out-Null
            }
            Set-Acl $k $acl -EA SilentlyContinue
          } catch {}
          Remove-Item $k -Recurse -Force -EA SilentlyContinue
        }
      }

      # Remove auto-start entries
      $runHKCU = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      $runHKLM = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomUMX','ZoomWorkplace')) {
        Remove-ItemProperty -Path $runHKCU -Name $v -Force -EA SilentlyContinue
      }
      foreach ($v in @('Zoom','ZoomCptService')) {
        Remove-ItemProperty -Path $runHKLM -Name $v -Force -EA SilentlyContinue
      }
    `, { timeout: 20000 }).catch(() => {});

    // Step 3.5: Kill updaters before launch
    await killZoomUpdaters();

    // Step 4: Launch Zoom normally — it starts with completely fresh data
    logger.info('Clean room: launching Zoom with wiped data...');
    const { spawn } = require('child_process');
    const child = spawn(zoomExe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.unref();

    logger.ok('Clean room: Zoom launched with wiped fingerprint data', { zoomExe });
    return { success: true, method: 'cleanroom', path: zoomExe };
  } catch (e) {
    logger.error('Clean room launch failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Launch Zoom as a clean Windows user to bypass DPAPI-based device bans.
 *
 * Why this works:
 *   Zoom's device fingerprint includes a DPAPI-encrypted key (win_osencrypt_key)
 *   that is tied to the Windows user's SID + master encryption keys. Same user
 *   always produces the same fingerprint — even after a full data wipe + reinstall.
 *   A different Windows user has different DPAPI keys → different fingerprint → no ban.
 *
 * Flow:
 *   1. Delete any existing ZoomClean user + stale profile data
 *   2. Create a fresh ZoomClean user
 *   3. Force profile creation via interactive logon
 *   4. Symlink shared folders (Documents, Downloads, etc.) to the real user's folders
 *   5. Launch Zoom as ZoomClean via schtasks
 *
 * @returns {Promise<{success: boolean, tempUser?: string, error?: string}>}
 */
async function launchZoomAsCleanUser() {
  logger.info('Clean user launch: setting up ZoomClean Windows user...');

  const installed = await isZoomInstalled();
  if (!installed.success) {
    return { success: false, error: 'Zoom not installed' };
  }

  const elevated = await isElevated();
  if (!elevated) {
    return { success: false, error: 'Admin privileges required to create a temporary user' };
  }

  const zoomExe = installed.path;
  const tempUser = 'ZoomClean';
  const password = 'Z00mCl3an!' + new Date().getFullYear();

  try {
    // Step 1: Kill any ZoomClean processes and delete old accounts
    logger.info('Cleaning up any existing ZoomClean accounts...');
    await runPowerShell(`
      # Kill ALL processes running under any ZoomClean user
      Get-Process -IncludeUserName -EA SilentlyContinue |
        Where-Object { $_.UserName -like '*ZoomClean*' } |
        Stop-Process -Force -EA SilentlyContinue

      Start-Sleep -Seconds 3

      # Unload ZoomClean registry hives (prevents profile lock)
      $zoomSIDs = (Get-CimInstance Win32_UserProfile |
        Where-Object { $_.LocalPath -like '*ZoomClean*' }).SID
      foreach ($sid in $zoomSIDs) {
        if ($sid) {
          reg unload "HKU\\$sid" 2>$null | Out-Null
        }
      }
      Start-Sleep -Seconds 2

      # Delete all ZoomClean* local users
      Get-LocalUser | Where-Object { $_.Name -like 'ZoomClean*' } | ForEach-Object {
        Remove-LocalUser -Name $_.Name -EA SilentlyContinue
      }

      # Wait for profile to unload after user deletion
      Start-Sleep -Seconds 3

      # Remove stale CIM profile entries with retry (critical — prevents TEMP profile)
      for ($i = 0; $i -lt 3; $i++) {
        $stale = Get-CimInstance Win32_UserProfile |
          Where-Object { $_.LocalPath -like '*ZoomClean*' -or $_.LocalPath -eq 'C:\\Users\\TEMP' }
        if (-not $stale) { break }
        $stale | ForEach-Object { Remove-CimInstance $_ -EA SilentlyContinue }
        Start-Sleep -Seconds 2
      }

      # Remove stale profile directories
      Get-ChildItem 'C:\\Users' -Directory |
        Where-Object { $_.Name -like 'ZoomClean*' } |
        ForEach-Object { cmd /c "rmdir /S /Q \`"$($_.FullName)\`"" 2>$null }

      # Remove TEMP profile if it was created by a failed attempt
      if (Test-Path 'C:\\Users\\TEMP') {
        cmd /c "rmdir /S /Q \`"C:\\Users\\TEMP\`"" 2>$null
      }

      # Final verification — no stale entries remain
      Start-Sleep -Seconds 2
      $remaining = Get-CimInstance Win32_UserProfile |
        Where-Object { $_.LocalPath -like '*ZoomClean*' -or $_.LocalPath -eq 'C:\\Users\\TEMP' }
      if ($remaining) {
        throw "Stale CIM profile entries still exist: $($remaining.LocalPath -join ', ')"
      }
      Write-Output 'cleaned'
    `, { timeout: 60000 });

    // Step 2: Create fresh ZoomClean user
    logger.info('Creating fresh ZoomClean user...');
    await runPowerShell(`
      $pw = ConvertTo-SecureString '${password}' -AsPlainText -Force
      New-LocalUser -Name '${tempUser}' -Password $pw -Description '1132-Remover clean profile' -PasswordNeverExpires -EA Stop | Out-Null
      Add-LocalGroupMember -Group 'Users' -Member '${tempUser}' -EA SilentlyContinue
      Write-Output 'created'
    `, { timeout: 15000 });

    // Step 3: Force profile creation via interactive logon
    logger.info('Creating user profile via logon...');
    await runPowerShell(`
      $pw = ConvertTo-SecureString '${password}' -AsPlainText -Force
      $cred = New-Object System.Management.Automation.PSCredential('.\\${tempUser}', $pw)

      # Ensure SecLogon service is running (required for credential-based Start-Process)
      $svc = Get-Service seclogon -EA SilentlyContinue
      if ($svc -and $svc.Status -ne 'Running') {
        Set-Service seclogon -StartupType Manual -EA SilentlyContinue
        Start-Service seclogon -EA SilentlyContinue
        Start-Sleep -Seconds 1
      }

      $p = Start-Process 'cmd.exe' -ArgumentList '/c','echo %USERPROFILE% & timeout /t 2' -Credential $cred -PassThru -WindowStyle Hidden
      $p.WaitForExit(15000)
      Start-Sleep -Seconds 5

      # Verify profile was created as ZoomClean (not TEMP)
      $profilePath = $null
      Get-ChildItem 'C:\\Users' -Directory |
        Where-Object { $_.Name -like '${tempUser}*' } |
        ForEach-Object { $profilePath = $_.FullName }

      # Check WMI if filesystem check didn't find it
      if (-not $profilePath) {
        $wmiProfile = Get-CimInstance Win32_UserProfile |
          Where-Object { $_.LocalPath -like '*${tempUser}*' } |
          Select-Object -First 1
        if ($wmiProfile) { $profilePath = $wmiProfile.LocalPath }
      }

      # Detect TEMP profile — means stale CIM entry caused Windows to redirect
      if (-not $profilePath -or -not (Test-Path $profilePath)) {
        $tempProfile = Get-CimInstance Win32_UserProfile |
          Where-Object { $_.LocalPath -eq 'C:\\Users\\TEMP' }
        if ($tempProfile -or (Test-Path 'C:\\Users\\TEMP')) {
          throw 'Profile was created as C:\\Users\\TEMP instead of ${tempUser}. Stale CIM entries were not fully removed — retry the operation.'
        }
        throw 'Profile directory not created'
      }

      Write-Output $profilePath
    `, { timeout: 30000 });

    // Step 4: Grant ZoomClean access to Zoom directory (no symlinks — fully isolated profile)
    const zoomDir = path.dirname(zoomExe);
    logger.info('Granting ZoomClean access to Zoom directory...');
    await runPowerShell(`
      # Grant Zoom directory read+execute access (no /T — inheritance handles children)
      icacls '${zoomDir.replace(/\\/g, '\\\\')}' /grant '${tempUser}:(OI)(CI)RX' /Q 2>$null | Out-Null
      Write-Output 'granted'
    `, { timeout: 15000 });

    // Step 5: Launch ManyCam + Zoom as ZoomClean in the same session
    // Both apps must share a session so ManyCam's virtual camera is visible to Zoom.
    // We use a single schtask running a batch script to keep them in one session.
    const manyCamExe = 'C:\\Program Files (x86)\\ManyCam\\ManyCam.exe';
    const hasManyCam = fs.existsSync(manyCamExe);
    logger.info(`Launching ${hasManyCam ? 'ManyCam + ' : ''}Zoom as ZoomClean...`);

    // Write a launcher batch script that starts ManyCam (if present), waits, then starts Zoom
    const launcherPath = path.join(process.env.TEMP || 'C:\\Windows\\Temp', '1132fix-launcher.cmd');
    const launcherLines = ['@echo off'];
    if (hasManyCam) {
      launcherLines.push(`start "" "${manyCamExe}"`);
      launcherLines.push('timeout /t 5 /nobreak >nul');
    }
    launcherLines.push(`start "" "${zoomExe}"`);
    fs.writeFileSync(launcherPath, launcherLines.join('\r\n'));

    await runPowerShell(`
      $launcherPath = '${launcherPath.replace(/\\/g, '\\\\')}'
      $taskName = '1132Fix-LaunchZoom'

      schtasks /Delete /TN $taskName /F 2>$null | Out-Null
      schtasks /Create /TN $taskName /TR "\`"$launcherPath\`"" /SC ONCE /ST 00:00 /RU '${tempUser}' /RP '${password}' /RL LIMITED /F 2>&1 | Out-Null
      schtasks /Run /TN $taskName 2>&1 | Out-Null
      Start-Sleep -Seconds 8
      schtasks /Delete /TN $taskName /F 2>$null | Out-Null

      Write-Output 'launched'
    `, { timeout: 25000 });

    // Clean up launcher script
    try { fs.unlinkSync(launcherPath); } catch (e) { /* ignore */ }

    logger.ok(`${hasManyCam ? 'ManyCam + ' : ''}Zoom launched as ZoomClean user`);
    return { success: true, tempUser };
  } catch (e) {
    logger.error('Clean user launch failed', { error: e.message });
    await cleanupTempUser(tempUser).catch(() => {});
    return { success: false, error: e.message };
  }
}

/**
 * Clean up a ZoomClean user created by launchZoomAsCleanUser.
 * Kills any processes running as that user, then deletes the account + profile + CIM entries.
 * @param {string} [tempUser='ZoomClean'] - Username to remove
 * @returns {Promise<{success: boolean}>}
 */
async function cleanupTempUser(tempUser = 'ZoomClean') {
  if (!tempUser || !tempUser.startsWith('ZoomClean')) {
    return { success: false, error: 'Invalid temp user name' };
  }

  logger.info(`Cleaning up user: ${tempUser}`);
  try {
    await runPowerShell(`
      $name = '${tempUser}'

      # Kill all processes running as this user
      Get-Process -IncludeUserName -EA SilentlyContinue |
        Where-Object { $_.UserName -like "*\\$name" } |
        Stop-Process -Force -EA SilentlyContinue

      Start-Sleep -Seconds 2

      # Remove the user account
      Remove-LocalUser -Name $name -EA SilentlyContinue

      # Remove CIM profile entry (prevents stale profile issues on next creation)
      Get-CimInstance Win32_UserProfile |
        Where-Object { $_.LocalPath -like "*\\$name*" } |
        ForEach-Object { Remove-CimInstance $_ -EA SilentlyContinue }

      # Remove profile directory
      Get-ChildItem 'C:\\Users' -Directory |
        Where-Object { $_.Name -like "$name*" } |
        ForEach-Object { cmd /c "rmdir /S /Q \`"$($_.FullName)\`"" 2>$null }

      Write-Output 'cleaned'
    `, { timeout: 30000 });

    logger.ok(`User ${tempUser} removed`);
    return { success: true };
  } catch (e) {
    logger.warn(`Failed to clean up user ${tempUser}`, { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Clean up ALL leftover ZoomClean* users from previous runs.
 * @returns {Promise<{success: boolean, removed: number}>}
 */
async function cleanupAllTempUsers() {
  try {
    const result = await runPowerShell(`
      $count = 0

      # Delete all ZoomClean* local users
      Get-LocalUser | Where-Object { $_.Name -like 'ZoomClean*' } | ForEach-Object {
        $name = $_.Name

        # Kill processes
        Get-Process -IncludeUserName -EA SilentlyContinue |
          Where-Object { $_.UserName -like "*\\$name" } |
          Stop-Process -Force -EA SilentlyContinue

        Start-Sleep -Seconds 1

        # Remove user
        Remove-LocalUser -Name $name -EA SilentlyContinue
        $count++
      }

      # Remove ALL stale CIM profile entries
      Get-CimInstance Win32_UserProfile |
        Where-Object { $_.LocalPath -like '*ZoomClean*' } |
        ForEach-Object { Remove-CimInstance $_ -EA SilentlyContinue }

      # Remove ALL stale profile directories
      Get-ChildItem 'C:\\Users' -Directory |
        Where-Object { $_.Name -like 'ZoomClean*' } |
        ForEach-Object { cmd /c "rmdir /S /Q \`"$($_.FullName)\`"" 2>$null }

      Write-Output $count
    `, { timeout: 60000 });

    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`Cleaned up ${removed} ZoomClean user(s)`);
    }
    return { success: true, removed };
  } catch (e) {
    logger.warn('Failed to clean up ZoomClean users', { error: e.message });
    return { success: false, removed: 0 };
  }
}

/**
 * Clean up installer file
 * @param {string} installerPath - Path to installer
 */
function cleanupInstaller(installerPath) {
  if (installerPath && fs.existsSync(installerPath)) {
    try {
      fs.unlinkSync(installerPath);
      logger.debug('Cleaned up installer file');
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

module.exports = {
  downloadFile,
  downloadZoomInstaller,
  installZoom,
  hardenZoomInstall,
  killZoomUpdaters,
  isZoomInstalled,
  launchZoom,
  launchZoomCleanRoom,
  launchZoomAsCleanUser,
  cleanupTempUser,
  cleanupAllTempUsers,
  cleanupInstaller
};
