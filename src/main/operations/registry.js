/**
 * 1132 Remover - Registry Cleanup
 * Deletes all Zoom registry entries with verification
 */

const { spawnSafe, runPowerShell, registryKeyExists, deleteRegistryKey, deleteRegistryValue } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { REGISTRY_KEYS, REGISTRY_RUN_VALUES } = require('../../shared/constants');

/**
 * Delete all Zoom registry keys with verification
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, deleted: number, failed: number, results: Array}>}
 */
async function cleanRegistry(onProgress = null) {
  logger.section('Cleaning Registry');

  const results = [];
  let deleted = 0;
  let failed = 0;
  let notFound = 0;

  // Combine all registry keys
  const allKeys = [
    ...REGISTRY_KEYS.HKCU,
    ...REGISTRY_KEYS.HKLM,
    ...REGISTRY_KEYS.WOW64
  ];

  const total = allKeys.length + REGISTRY_RUN_VALUES.length;
  let current = 0;

  // Delete registry keys
  for (const keyPath of allKeys) {
    current++;

    if (onProgress) {
      onProgress({
        step: 'registry',
        current,
        total,
        message: `Deleting: ${keyPath.split('\\').pop()}...`
      });
    }

    const result = await deleteRegistryKey(keyPath);

    if (result.existed) {
      if (result.success) {
        deleted++;
        logger.ok(`Deleted registry key: ${keyPath}`);
      } else {
        failed++;
        logger.error(`Failed to delete: ${keyPath}`, { error: result.error });
      }
    } else {
      notFound++;
      logger.debug(`Key not found: ${keyPath}`);
    }

    results.push({
      key: keyPath,
      existed: result.existed,
      deleted: result.success && result.existed,
      error: result.error
    });
  }

  // Delete Run values
  for (const runEntry of REGISTRY_RUN_VALUES) {
    current++;

    if (onProgress) {
      onProgress({
        step: 'registry',
        current,
        total,
        message: `Removing autorun: ${runEntry.value}...`
      });
    }

    const result = await deleteRegistryValue(runEntry.key, runEntry.value);

    if (result.success) {
      logger.ok(`Deleted Run value: ${runEntry.value}`);
    }

    results.push({
      key: `${runEntry.key}\\${runEntry.value}`,
      type: 'value',
      deleted: result.success
    });
  }

  // Additional cleanup: MUI Cache entries
  await cleanMuiCache();

  // Additional cleanup: App Compatibility entries
  await cleanAppCompatFlags();

  const success = failed === 0;
  logger.logStep('Registry Cleanup', success, { deleted, failed, notFound });

  return {
    success,
    deleted,
    failed,
    notFound,
    results
  };
}

/**
 * Clean MUI Cache entries containing "zoom"
 * These can contain traces of Zoom being run
 */
async function cleanMuiCache() {
  logger.info('Cleaning MUI Cache...');

  try {
    const script = `
      $muiPath = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
      if (Test-Path $muiPath) {
        $props = Get-ItemProperty $muiPath -ErrorAction SilentlyContinue
        $toRemove = $props.PSObject.Properties | Where-Object { $_.Name -like '*zoom*' }
        foreach ($prop in $toRemove) {
          Remove-ItemProperty -Path $muiPath -Name $prop.Name -ErrorAction SilentlyContinue
          Write-Output "Removed: $($prop.Name)"
        }
      }
    `;

    const result = await runPowerShell(script, { timeout: 15000 });
    if (result.stdout) {
      logger.ok('MUI Cache cleaned', { removed: result.stdout.split('\n').filter(s => s.includes('Removed')).length });
    }
  } catch (e) {
    logger.debug('MUI Cache cleanup skipped', { error: e.message });
  }
}

/**
 * Clean App Compatibility flags for Zoom
 * These track Zoom execution history
 */
async function cleanAppCompatFlags() {
  logger.info('Cleaning App Compatibility flags...');

  try {
    const script = `
      $compatPath = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
      if (Test-Path $compatPath) {
        $props = Get-ItemProperty $compatPath -ErrorAction SilentlyContinue
        $toRemove = $props.PSObject.Properties | Where-Object { $_.Name -like '*zoom*' }
        foreach ($prop in $toRemove) {
          Remove-ItemProperty -Path $compatPath -Name $prop.Name -ErrorAction SilentlyContinue
          Write-Output "Removed: $($prop.Name)"
        }
      }
    `;

    const result = await runPowerShell(script, { timeout: 15000 });
    if (result.stdout) {
      logger.ok('AppCompat flags cleaned');
    }
  } catch (e) {
    logger.debug('AppCompat cleanup skipped', { error: e.message });
  }
}

/**
 * Verify registry is clean
 * @returns {Promise<{clean: boolean, remaining: string[]}>}
 */
async function verifyRegistryClean() {
  const remaining = [];

  // Check critical keys
  const criticalKeys = [
    'HKCU\\Software\\Zoom',
    'HKLM\\Software\\Zoom',
    'HKCU\\Software\\CptService',
    'HKLM\\SYSTEM\\CurrentControlSet\\Services\\CptService'
  ];

  for (const key of criticalKeys) {
    if (await registryKeyExists(key)) {
      remaining.push(key);
    }
  }

  return {
    clean: remaining.length === 0,
    remaining
  };
}

/**
 * Escalated registry cleanup (requires TrustedInstaller for some keys)
 * Use this if normal cleanup fails
 * @returns {Promise<{success: boolean}>}
 */
async function escalatedRegistryCleanup() {
  logger.warn('Attempting escalated registry cleanup...');

  try {
    const script = `
      # Take ownership and delete stubborn keys
      $stubbornKeys = @(
        'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\CptService',
        'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\ZoomCptService'
      )

      foreach ($keyPath in $stubbornKeys) {
        if (Test-Path $keyPath) {
          try {
            # Take ownership
            $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey(
              $keyPath.Replace('HKLM:\\', ''),
              [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
              [System.Security.AccessControl.RegistryRights]::TakeOwnership
            )

            $acl = $key.GetAccessControl()
            $owner = [System.Security.Principal.NTAccount]'Administrators'
            $acl.SetOwner($owner)
            $key.SetAccessControl($acl)
            $key.Close()

            # Delete the key
            Remove-Item -Path $keyPath -Recurse -Force -ErrorAction Stop
            Write-Output "Deleted: $keyPath"
          }
          catch {
            Write-Output "Failed: $keyPath - $($_.Exception.Message)"
          }
        }
      }
    `;

    await runPowerShell(script, { timeout: 30000 });
    return { success: true };
  } catch (e) {
    logger.error('Escalated cleanup failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

module.exports = {
  cleanRegistry,
  cleanMuiCache,
  cleanAppCompatFlags,
  verifyRegistryClean,
  escalatedRegistryCleanup
};
