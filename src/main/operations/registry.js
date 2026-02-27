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
    ...(REGISTRY_KEYS.HKCR || []),
    ...(REGISTRY_KEYS.TRACING || []),
    ...(REGISTRY_KEYS.INSTALLER || []),
    ...(REGISTRY_KEYS.SHELL_EXT || [])
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

  // Batched deep cleanup - HKCU operations (single PowerShell invocation)
  await cleanRegistryBatchHKCU();

  // Batched deep cleanup - HKLM operations (single PowerShell invocation)
  await cleanRegistryBatchHKLM();

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
 * Batched HKCU registry cleanup (single PowerShell invocation)
 * Combines: MUI Cache, AppCompat, UserAssist, Shell History, FeatureUsage
 * Saves ~2500ms of PowerShell cold-start overhead vs 5 separate invocations
 */
async function cleanRegistryBatchHKCU() {
  logger.info('Running batched HKCU registry cleanup...');

  try {
    const script = `
      $totalRemoved = 0

      # --- MUI Cache ---
      $muiPath = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'
      if (Test-Path $muiPath) {
        $props = Get-ItemProperty $muiPath -ErrorAction SilentlyContinue
        $toRemove = $props.PSObject.Properties | Where-Object { $_.Name -like '*zoom*' }
        foreach ($prop in $toRemove) {
          Remove-ItemProperty -Path $muiPath -Name $prop.Name -ErrorAction SilentlyContinue
          $totalRemoved++
        }
      }

      # --- AppCompat Flags ---
      $compatPath = 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
      if (Test-Path $compatPath) {
        $props = Get-ItemProperty $compatPath -ErrorAction SilentlyContinue
        $toRemove = $props.PSObject.Properties | Where-Object { $_.Name -like '*zoom*' }
        foreach ($prop in $toRemove) {
          Remove-ItemProperty -Path $compatPath -Name $prop.Name -ErrorAction SilentlyContinue
          $totalRemoved++
        }
      }

      # --- UserAssist (ROT13 encoded execution history) ---
      $guids = @(
        '{CEBFF5CD-ACE2-4F4F-9178-9926F41749EA}',
        '{F4E57C4B-2036-45F0-A9AB-443BCFE33D9F}'
      )
      foreach ($guid in $guids) {
        $uaPath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\$guid\\Count"
        if (Test-Path $uaPath) {
          $props = Get-ItemProperty $uaPath -ErrorAction SilentlyContinue
          foreach ($prop in $props.PSObject.Properties) {
            $name = $prop.Name
            $decoded = -join ($name.ToCharArray() | ForEach-Object {
              $c = $_
              if ($c -match '[a-zA-Z]') {
                $base = if ($c -cmatch '[A-Z]') { [int][char]'A' } else { [int][char]'a' }
                [char](($([int][char]$c - $base + 13) % 26) + $base)
              } else { $c }
            })
            if ($decoded -like '*zoom*' -or $decoded -like '*cpt*' -or $decoded -like '*zcs*') {
              Remove-ItemProperty -Path $uaPath -Name $name -ErrorAction SilentlyContinue
              $totalRemoved++
            }
          }
        }
      }

      # --- Shell History (RecentDocs, ComDlg32, TypedPaths) ---
      $recentPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\RecentDocs'
      if (Test-Path $recentPath) {
        Get-ChildItem $recentPath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          foreach ($prop in $props.PSObject.Properties) {
            $val = [System.Text.Encoding]::Unicode.GetString($prop.Value) 2>$null
            if ($val -like '*zoom*') {
              Remove-ItemProperty -Path $_.PSPath -Name $prop.Name -ErrorAction SilentlyContinue
              $totalRemoved++
            }
          }
        }
      }

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
                  $totalRemoved++
                }
              }
            }
          }
        }
      }

      $typedPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\TypedPaths'
      if (Test-Path $typedPath) {
        $props = Get-ItemProperty $typedPath -ErrorAction SilentlyContinue
        foreach ($prop in $props.PSObject.Properties) {
          if ($prop.Value -like '*zoom*') {
            Remove-ItemProperty -Path $typedPath -Name $prop.Name -ErrorAction SilentlyContinue
            $totalRemoved++
          }
        }
      }

      # --- FeatureUsage ---
      $featurePath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FeatureUsage'
      if (Test-Path $featurePath) {
        Get-ChildItem $featurePath -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          foreach ($prop in $props.PSObject.Properties) {
            if ($prop.Name -like '*zoom*' -or $prop.Name -like '*cpt*') {
              Remove-ItemProperty -Path $_.PSPath -Name $prop.Name -ErrorAction SilentlyContinue
              $totalRemoved++
            }
          }
        }
      }

      Write-Output $totalRemoved
    `;

    const result = await runPowerShell(script, { timeout: 60000 });
    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`HKCU batch cleanup: ${removed} entries removed`);
    }
  } catch (e) {
    logger.debug('HKCU batch cleanup skipped', { error: e.message });
  }
}

/**
 * Batched HKLM registry cleanup (single PowerShell invocation)
 * Combines: BAM/DAM, COM/CLSID/TypeLib, Installer registry, Firewall registry
 * Saves ~2000ms of PowerShell cold-start overhead vs 4 separate invocations
 */
async function cleanRegistryBatchHKLM() {
  logger.info('Running batched HKLM registry cleanup...');

  try {
    const script = `
      $totalRemoved = 0

      # --- BAM/DAM (Background/Desktop Activity Moderator) ---
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
                $totalRemoved++
              }
            }
          }
        }
      }

      # --- Uninstall entries (targeted, fast) ---
      $uninstallPaths = @(
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      )
      foreach ($uPath in $uninstallPaths) {
        if (Test-Path $uPath) {
          Get-ChildItem $uPath -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($props.DisplayName -like '*Zoom*' -or $props.Publisher -like '*Zoom Video*') {
              Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
              $totalRemoved++
            }
          }
        }
      }

      # --- Firewall registry entries ---
      $fwPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\SharedAccess\\Parameters\\FirewallPolicy\\FirewallRules'
      if (Test-Path $fwPath) {
        $props = Get-ItemProperty $fwPath -ErrorAction SilentlyContinue
        foreach ($prop in $props.PSObject.Properties) {
          if ($prop.Value -like '*zoom*' -or $prop.Value -like '*Zoom*' -or $prop.Value -like '*CptService*') {
            Remove-ItemProperty -Path $fwPath -Name $prop.Name -ErrorAction SilentlyContinue
            $totalRemoved++
          }
        }
      }

      Write-Output $totalRemoved
    `;

    const result = await runPowerShell(script, { timeout: 30000 });
    const removed = parseInt(result.stdout, 10) || 0;
    if (removed > 0) {
      logger.ok(`HKLM batch cleanup: ${removed} entries removed`);
    }
  } catch (e) {
    logger.debug('HKLM batch cleanup skipped', { error: e.message });
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
  cleanRegistryBatchHKCU,
  cleanRegistryBatchHKLM,
  verifyRegistryClean,
  escalatedRegistryCleanup
};
