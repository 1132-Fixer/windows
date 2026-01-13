/**
 * 1132 Remover - Device Fingerprint Wipe
 * CRITICAL: This module removes the device identifiers that cause Error 1132
 *
 * Zoom tracks devices using:
 * 1. CptService folders (device ID in ProgramData)
 * 2. Telemetry databases (tracking data)
 * 3. Registry service entries (service identifiers)
 * 4. Windows credentials (cached tokens)
 * 5. Prefetch files (execution history)
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe, runPowerShell, deleteRegistryKey } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { FINGERPRINT_LOCATIONS, ZOOM_CREDENTIALS } = require('../../shared/constants');

/**
 * Delete telemetry databases
 * These contain device-specific tracking data
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function wipeTelemetryDatabases() {
  logger.info('Wiping telemetry databases...');

  let deleted = 0;

  for (const dbPath of FINGERPRINT_LOCATIONS.telemetryDatabases) {
    if (fs.existsSync(dbPath)) {
      try {
        // Try to unlock the file first
        await runPowerShell(`
          $path = "${dbPath.replace(/\\/g, '\\\\')}"
          $handle = [System.IO.File]::Open($path, 'Open', 'ReadWrite', 'None')
          $handle.Close()
        `, { timeout: 5000 }).catch(() => {});

        fs.unlinkSync(dbPath);
        deleted++;
        logger.ok(`Deleted telemetry DB: ${dbPath}`);
      } catch (e) {
        // Try force delete
        try {
          await runPowerShell(`Remove-Item -LiteralPath "${dbPath}" -Force`, { timeout: 5000 });
          deleted++;
          logger.ok(`Force deleted telemetry DB: ${dbPath}`);
        } catch (e2) {
          logger.warn(`Could not delete: ${dbPath}`, { error: e2.message });
        }
      }
    }
  }

  return { success: true, deleted };
}

/**
 * Wipe CptService folders
 * These contain the Screen Sharing Service device identifiers
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function wipeCptServiceData() {
  logger.info('Wiping CptService device identifiers...');

  let deleted = 0;

  for (const folder of FINGERPRINT_LOCATIONS.cptServiceFolders) {
    if (fs.existsSync(folder)) {
      try {
        // Take ownership and remove
        await runPowerShell(`
          takeown /F "${folder}" /R /A /D Y 2>&1 | Out-Null
          icacls "${folder}" /grant Administrators:F /T /Q 2>&1 | Out-Null
        `, { timeout: 15000 }).catch(() => {});

        fs.rmSync(folder, { recursive: true, force: true });
        deleted++;
        logger.ok(`Deleted CptService folder: ${folder}`);
      } catch (e) {
        // Try PowerShell force delete
        try {
          await runPowerShell(
            `Remove-Item -LiteralPath "${folder}" -Recurse -Force -ErrorAction SilentlyContinue`,
            { timeout: 15000 }
          );

          if (!fs.existsSync(folder)) {
            deleted++;
            logger.ok(`Force deleted: ${folder}`);
          }
        } catch (e2) {
          logger.warn(`Could not delete: ${folder}`, { error: e2.message });
        }
      }
    }
  }

  return { success: true, deleted };
}

/**
 * Wipe registry fingerprints
 * Service registry entries contain device identifiers
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function wipeRegistryFingerprints() {
  logger.info('Wiping registry fingerprints...');

  let deleted = 0;

  for (const keyPath of FINGERPRINT_LOCATIONS.registryFingerprints) {
    const result = await deleteRegistryKey(keyPath);
    if (result.existed && result.success) {
      deleted++;
      logger.ok(`Deleted registry fingerprint: ${keyPath}`);
    }
  }

  return { success: true, deleted };
}

/**
 * Remove Windows credentials
 * Cached Zoom credentials may contain identifying info
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function removeWindowsCredentials() {
  logger.info('Removing Windows credentials...');

  let deleted = 0;

  for (const target of ZOOM_CREDENTIALS) {
    try {
      const result = await spawnSafe('cmdkey', ['/delete:' + target], { timeout: 5000 });
      // cmdkey returns 0 even if credential didn't exist
      deleted++;
      logger.debug(`Attempted credential removal: ${target}`);
    } catch (e) {
      // Ignore errors
    }
  }

  // Also clear any generic zoom credentials
  try {
    await runPowerShell(`
      cmdkey /list | Select-String 'zoom' | ForEach-Object {
        $target = ($_ -split ':')[1].Trim()
        cmdkey /delete:$target 2>&1 | Out-Null
      }
    `, { timeout: 10000 });
  } catch (e) {
    // Ignore
  }

  return { success: true, deleted };
}

/**
 * Clear prefetch files
 * Windows tracks program execution in prefetch
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function clearPrefetchFiles() {
  logger.info('Clearing prefetch files...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*.pf' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        $count++
      }
      Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*CPT*.pf' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        $count++
      }
      Write-Output $count
    `, { timeout: 15000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Cleared ${deleted} prefetch files`);
    }
  } catch (e) {
    logger.debug('Prefetch cleanup failed (may require higher privileges)', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Flush DNS cache
 * May contain cached Zoom domain lookups
 * @returns {Promise<{success: boolean}>}
 */
async function flushDnsCache() {
  logger.info('Flushing DNS cache...');

  try {
    await spawnSafe('ipconfig', ['/flushdns'], { timeout: 10000 });
    logger.ok('DNS cache flushed');
    return { success: true };
  } catch (e) {
    logger.warn('DNS flush failed', { error: e.message });
    return { success: false };
  }
}

/**
 * Remove firewall rules for Zoom
 * These can reveal previous Zoom installation
 * @returns {Promise<{success: boolean, removed: number}>}
 */
async function removeFirewallRules() {
  logger.info('Removing Zoom firewall rules...');

  try {
    const result = await runPowerShell(`
      $rules = Get-NetFirewallRule | Where-Object { $_.DisplayName -like '*Zoom*' }
      $count = $rules.Count
      $rules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      Write-Output $count
    `, { timeout: 30000 });

    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`Removed ${removed} firewall rules`);
    }

    return { success: true, removed };
  } catch (e) {
    logger.debug('Firewall cleanup skipped', { error: e.message });
    return { success: false, removed: 0 };
  }
}

/**
 * Complete device fingerprint wipe
 * This is the CRITICAL function for 1132 bypass
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, steps: Object}>}
 */
async function wipeDeviceFingerprint(onProgress = null) {
  logger.section('Wiping Device Fingerprint');
  logger.warn('This removes all device identifiers used by Zoom');

  const steps = {
    telemetry: null,
    cptService: null,
    registry: null,
    credentials: null,
    prefetch: null,
    dns: null,
    firewall: null
  };

  const stepList = [
    { id: 'telemetry', name: 'Telemetry Databases', fn: wipeTelemetryDatabases },
    { id: 'cptService', name: 'CptService Identifiers', fn: wipeCptServiceData },
    { id: 'registry', name: 'Registry Fingerprints', fn: wipeRegistryFingerprints },
    { id: 'credentials', name: 'Windows Credentials', fn: removeWindowsCredentials },
    { id: 'prefetch', name: 'Prefetch Files', fn: clearPrefetchFiles },
    { id: 'dns', name: 'DNS Cache', fn: flushDnsCache },
    { id: 'firewall', name: 'Firewall Rules', fn: removeFirewallRules }
  ];

  for (let i = 0; i < stepList.length; i++) {
    const step = stepList[i];

    if (onProgress) {
      onProgress({
        step: 'fingerprint',
        current: i + 1,
        total: stepList.length,
        message: `Wiping: ${step.name}...`
      });
    }

    steps[step.id] = await step.fn();
  }

  // Verify critical items are gone
  const verification = await verifyFingerprintWipe();

  const success = verification.clean;
  logger.logStep('Device Fingerprint Wipe', success, {
    ...steps,
    verification
  });

  return {
    success,
    steps,
    verification
  };
}

/**
 * Verify the fingerprint wipe was successful
 * @returns {Promise<{clean: boolean, remaining: string[]}>}
 */
async function verifyFingerprintWipe() {
  const remaining = [];

  // Check telemetry DBs
  for (const db of FINGERPRINT_LOCATIONS.telemetryDatabases) {
    if (fs.existsSync(db)) {
      remaining.push(`Telemetry: ${db}`);
    }
  }

  // Check CptService folders
  for (const folder of FINGERPRINT_LOCATIONS.cptServiceFolders) {
    if (fs.existsSync(folder)) {
      remaining.push(`CptService: ${folder}`);
    }
  }

  return {
    clean: remaining.length === 0,
    remaining
  };
}

module.exports = {
  wipeTelemetryDatabases,
  wipeCptServiceData,
  wipeRegistryFingerprints,
  removeWindowsCredentials,
  clearPrefetchFiles,
  flushDnsCache,
  removeFirewallRules,
  wipeDeviceFingerprint,
  verifyFingerprintWipe
};
