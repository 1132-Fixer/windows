/**
 * 1132 Remover - Registry Cleanup
 * Deletes all Zoom registry entries with verification
 */

const { spawnSafe, runPowerShell, registryKeyExists, deleteRegistryKey, deleteRegistryValue } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { REGISTRY_KEYS, REGISTRY_CLEANUP_PATHS, REGISTRY_RUN_VALUES } = require('../../shared/constants');

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
    ...REGISTRY_KEYS.WOW64,
    ...(REGISTRY_KEYS.HKCR || [])
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

  // Deep cleanup: UserAssist (execution history)
  await cleanUserAssist();

  // Deep cleanup: BAM/DAM (Background/Desktop Activity Moderator)
  await cleanActivityModerator();

  // Deep cleanup: Shell history (recent docs, file dialogs)
  await cleanShellHistory();

  // Deep cleanup: Feature usage tracking
  await cleanFeatureUsage();

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
 * Clean UserAssist entries containing Zoom
 * UserAssist tracks program execution with ROT13 encoded paths
 */
async function cleanUserAssist() {
  logger.info('Cleaning UserAssist (execution history)...');

  try {
    const script = `
      $guids = @(
        '{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}',
        '{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}'
      )
      $removed = 0
      foreach ($guid in $guids) {
        $path = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\$guid\\Count"
        if (Test-Path $path) {
          $props = Get-ItemProperty $path -ErrorAction SilentlyContinue
          foreach ($prop in $props.PSObject.Properties) {
            # ROT13 decode and check for zoom
            $name = $prop.Name
            $decoded = -join ($name.ToCharArray() | ForEach-Object {
              $c = $_
              if ($c -match '[a-zA-Z]') {
                $base = if ($c -cmatch '[A-Z]') { [int][char]'A' } else { [int][char]'a' }
                [char](($([int][char]$c - $base + 13) % 26) + $base)
              } else { $c }
            })
            if ($decoded -like '*zoom*' -or $decoded -like '*cpt*' -or $decoded -like '*zcs*') {
              Remove-ItemProperty -Path $path -Name $name -ErrorAction SilentlyContinue
              $removed++
            }
          }
        }
      }
      Write-Output $removed
    `;

    const result = await runPowerShell(script, { timeout: 30000 });
    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`UserAssist cleaned: ${removed} entries removed`);
    }
  } catch (e) {
    logger.debug('UserAssist cleanup skipped', { error: e.message });
  }
}

/**
 * Clean BAM/DAM (Background/Desktop Activity Moderator)
 * These track every EXE that was launched
 */
async function cleanActivityModerator() {
  logger.info('Cleaning BAM/DAM activity tracking...');

  try {
    const script = `
      $removed = 0
      $services = @('bam', 'dam')
      foreach ($svc in $services) {
        $basePath = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$svc\\State\\UserSettings"
        if (Test-Path $basePath) {
          Get-ChildItem $basePath -ErrorAction SilentlyContinue | ForEach-Object {
            $userPath = $_.PSPath
            $props = Get-ItemProperty $userPath -ErrorAction SilentlyContinue
            foreach ($prop in $props.PSObject.Properties) {
              if ($prop.Name -like '*zoom*' -or $prop.Name -like '*cpt*' -or $prop.Name -like '*zcs*') {
                Remove-ItemProperty -Path $userPath -Name $prop.Name -ErrorAction SilentlyContinue
                $removed++
              }
            }
          }
        }
      }
      Write-Output $removed
    `;

    const result = await runPowerShell(script, { timeout: 30000 });
    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`BAM/DAM cleaned: ${removed} entries removed`);
    }
  } catch (e) {
    logger.debug('BAM/DAM cleanup skipped', { error: e.message });
  }
}

/**
 * Clean Shell history (RecentDocs, OpenSaveMRU, TypedPaths)
 */
async function cleanShellHistory() {
  logger.info('Cleaning Shell history...');

  try {
    const script = `
      $removed = 0

      # Clean RecentDocs
      $recentPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RecentDocs'
      if (Test-Path $recentPath) {
        Get-ChildItem $recentPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          foreach ($prop in $props.PSObject.Properties) {
            $val = [System.Text.Encoding]::Unicode.GetString($prop.Value) 2>$null
            if ($val -like '*zoom*') {
              Remove-ItemProperty -Path $_.PSPath -Name $prop.Name -ErrorAction SilentlyContinue
              $removed++
            }
          }
        }
      }

      # Clean ComDlg32 (file dialog history)
      $comdlgPaths = @(
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\OpenSavePidlMRU',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\LastVisitedPidlMRU',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\ComDlg32\\LastVisitedPidlMRULegacy'
      )
      foreach ($dlgPath in $comdlgPaths) {
        if (Test-Path $dlgPath) {
          Get-ChildItem $dlgPath -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            foreach ($prop in $props.PSObject.Properties) {
              if ($prop.Name -notlike 'PS*' -and $prop.Name -ne 'MRUListEx') {
                $val = [System.Text.Encoding]::Unicode.GetString($prop.Value) 2>$null
                if ($val -like '*zoom*') {
                  Remove-ItemProperty -Path $_.PSPath -Name $prop.Name -ErrorAction SilentlyContinue
                  $removed++
                }
              }
            }
          }
        }
      }

      # Clean TypedPaths (Explorer address bar history)
      $typedPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths'
      if (Test-Path $typedPath) {
        $props = Get-ItemProperty $typedPath -ErrorAction SilentlyContinue
        foreach ($prop in $props.PSObject.Properties) {
          if ($prop.Value -like '*zoom*') {
            Remove-ItemProperty -Path $typedPath -Name $prop.Name -ErrorAction SilentlyContinue
            $removed++
          }
        }
      }

      Write-Output $removed
    `;

    const result = await runPowerShell(script, { timeout: 45000 });
    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`Shell history cleaned: ${removed} entries removed`);
    }
  } catch (e) {
    logger.debug('Shell history cleanup skipped', { error: e.message });
  }
}

/**
 * Clean FeatureUsage tracking
 */
async function cleanFeatureUsage() {
  logger.info('Cleaning Feature usage tracking...');

  try {
    const script = `
      $removed = 0
      $featurePath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FeatureUsage'
      if (Test-Path $featurePath) {
        Get-ChildItem $featurePath -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          foreach ($prop in $props.PSObject.Properties) {
            if ($prop.Name -like '*zoom*' -or $prop.Name -like '*cpt*') {
              Remove-ItemProperty -Path $_.PSPath -Name $prop.Name -ErrorAction SilentlyContinue
              $removed++
            }
          }
        }
      }
      Write-Output $removed
    `;

    const result = await runPowerShell(script, { timeout: 15000 });
    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`FeatureUsage cleaned: ${removed} entries removed`);
    }
  } catch (e) {
    logger.debug('FeatureUsage cleanup skipped', { error: e.message });
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
  cleanUserAssist,
  cleanActivityModerator,
  cleanShellHistory,
  cleanFeatureUsage,
  verifyRegistryClean,
  escalatedRegistryCleanup
};
