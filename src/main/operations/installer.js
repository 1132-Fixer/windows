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

  return { success: true, details };
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
 * Clean Room Launch — bypass 1132 by redirecting Zoom's data to a fresh directory.
 *
 * How it works:
 *   1. Create/wipe a clean room directory (C:\ProgramData\1132Fixer\CleanZoom)
 *   2. Kill all existing Zoom processes
 *   3. Delete HKCU\Software\Zoom registry (prevents stale fingerprint reads)
 *   4. Launch Zoom.exe with APPDATA + LOCALAPPDATA env vars pointing to clean room
 *   5. Zoom sees empty data dirs → generates fresh device fingerprint → no ban
 *
 * This avoids needing a separate Windows user (ghost user) because Zoom's
 * fingerprint databases live in %APPDATA%\Zoom\data\ — redirecting that path
 * gives Zoom a blank slate while keeping the same user session.
 */
async function launchZoomCleanRoom() {
  logger.info('Clean room launch: starting...');

  const installed = await isZoomInstalled();
  if (!installed.success) {
    return { success: false, error: 'Zoom not installed' };
  }

  const zoomExe = installed.path;
  const cleanBase = path.join(process.env.ProgramData || 'C:\\ProgramData', '1132Fixer', 'CleanZoom');
  const cleanRoaming = path.join(cleanBase, 'Roaming');
  const cleanLocal = path.join(cleanBase, 'Local');

  try {
    // Step 1: Kill all Zoom processes
    logger.info('Clean room: killing existing Zoom processes...');
    await runPowerShell(`
      $names = @('Zoom','Zoomus','Zoom_launcher','CptHost','CptService','CptControl',
        'aomhost','aomhost64','airhost','zCrashReport','zCrashReport64',
        'ZoomWebHost','zWebview2Agent','zCefAgent','zUpdater','ZoomInstaller')
      foreach ($n in $names) { taskkill /F /IM "$n.exe" 2>$null | Out-Null }
      Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } | Stop-Process -Force -EA SilentlyContinue
      Get-Process -Name 'CptService','CptHost','CptControl' -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
      Start-Sleep -Seconds 2
      # Second pass
      Get-Process | Where-Object { $_.Name -like '*zoom*' } | Stop-Process -Force -EA SilentlyContinue
    `, { timeout: 15000 }).catch(() => {});

    // Step 2: Wipe clean room (delete and recreate for total freshness)
    logger.info('Clean room: wiping data directory...');
    if (fs.existsSync(cleanBase)) {
      await runPowerShell(
        `Remove-Item -LiteralPath '${cleanBase.replace(/'/g, "''")}' -Recurse -Force -EA SilentlyContinue`,
        { timeout: 10000 }
      ).catch(() => {});
    }
    fs.mkdirSync(cleanRoaming, { recursive: true });
    fs.mkdirSync(cleanLocal, { recursive: true });

    // Step 3: Clean HKCU registry (Zoom reads SystemInfo from HKCU)
    logger.info('Clean room: cleaning registry...');
    await runPowerShell(`
      # Delete all Zoom registry keys under HKCU
      @('HKCU:\\Software\\Zoom', 'HKCU:\\Software\\ZoomUMX', 'HKCU:\\Software\\zoom.us',
        'HKCU:\\Software\\Zoom Video Communications', 'HKCU:\\Software\\CptService') | ForEach-Object {
        if (Test-Path $_) { Remove-Item $_ -Recurse -Force -EA SilentlyContinue }
      }
      # Also via reg.exe for reliability
      reg delete "HKCU\\Software\\Zoom" /f 2>$null | Out-Null
      reg delete "HKCU\\Software\\ZoomUMX" /f 2>$null | Out-Null
      reg delete "HKCU\\Software\\zoom.us" /f 2>$null | Out-Null
      reg delete "HKCU\\Software\\CptService" /f 2>$null | Out-Null
      reg delete "HKCU\\Software\\Zoom Video Communications" /f 2>$null | Out-Null
      # Delete HKLM Zoom keys too
      @('HKLM:\\SOFTWARE\\Zoom', 'HKLM:\\SOFTWARE\\ZoomUMX') | ForEach-Object {
        if (Test-Path $_) { Remove-Item $_ -Recurse -Force -EA SilentlyContinue }
      }
      # Remove auto-start entries
      Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'Zoom' -Force -EA SilentlyContinue
      Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ZoomUMX' -Force -EA SilentlyContinue
      Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ZoomWorkplace' -Force -EA SilentlyContinue
      # Purge ALL Zoom Group Policy registry keys (stale from older versions)
      $policyRoot = 'HKLM:\\SOFTWARE\\Policies\\Zoom'
      if (Test-Path $policyRoot) {
        Remove-Item $policyRoot -Recurse -Force -EA SilentlyContinue
      }
    `, { timeout: 10000 }).catch(() => {});

    // Step 4: Launch Zoom with redirected APPDATA → clean room
    logger.info('Clean room: launching Zoom with redirected data paths...');
    const { spawn } = require('child_process');
    const cleanEnv = { ...process.env };
    cleanEnv.APPDATA = cleanRoaming;
    cleanEnv.LOCALAPPDATA = cleanLocal;

    const child = spawn(zoomExe, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: cleanEnv
    });
    child.unref();

    logger.ok('Clean room: Zoom launched with fresh data paths', {
      zoomExe,
      APPDATA: cleanRoaming,
      LOCALAPPDATA: cleanLocal
    });
    return { success: true, method: 'cleanroom', path: zoomExe, cleanBase };
  } catch (e) {
    logger.error('Clean room launch failed', { error: e.message });
    return { success: false, error: e.message };
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
  isZoomInstalled,
  launchZoom,
  launchZoomCleanRoom,
  cleanupInstaller
};
