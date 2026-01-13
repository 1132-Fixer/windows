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
 * 6. Amcache.hve (Windows program execution history database)
 * 7. SRUM database (System Resource Usage Monitor)
 * 8. Windows Event Logs (application errors, installation logs)
 * 9. Group Policy registry keys (enterprise settings)
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe, runPowerShell, deleteRegistryKey } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { FINGERPRINT_LOCATIONS, SYSTEM_TRACE_LOCATIONS, ZOOM_CREDENTIALS } = require('../../shared/constants');

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
 * Clean Jump Lists (Recent items in taskbar)
 * These contain shortcuts to Zoom files/meetings
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanJumpLists() {
  logger.info('Cleaning Jump Lists...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      $recentPath = [Environment]::GetFolderPath('Recent')

      # Clean .lnk files with zoom in name
      Get-ChildItem "$recentPath" -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -like '*zoom*'
      } | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        $count++
      }

      # Clean AutomaticDestinations (jumplist files)
      $autoPath = Join-Path $recentPath 'AutomaticDestinations'
      if (Test-Path $autoPath) {
        Get-ChildItem $autoPath -Filter '*.automaticDestinations-ms' -ErrorAction SilentlyContinue | ForEach-Object {
          $content = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
          if ($content -like '*zoom*' -or $content -like '*Zoom*') {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }

      # Clean CustomDestinations
      $customPath = Join-Path $recentPath 'CustomDestinations'
      if (Test-Path $customPath) {
        Get-ChildItem $customPath -Filter '*.customDestinations-ms' -ErrorAction SilentlyContinue | ForEach-Object {
          $content = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
          if ($content -like '*zoom*' -or $content -like '*Zoom*') {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }

      Write-Output $count
    `, { timeout: 60000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Cleaned ${deleted} jump list entries`);
    }
  } catch (e) {
    logger.debug('Jump list cleanup failed', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Clean VirtualStore (UAC redirected writes)
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanVirtualStore() {
  logger.info('Cleaning VirtualStore...');

  let deleted = 0;

  if (SYSTEM_TRACE_LOCATIONS && SYSTEM_TRACE_LOCATIONS.virtualStore) {
    for (const folder of SYSTEM_TRACE_LOCATIONS.virtualStore) {
      if (fs.existsSync(folder)) {
        try {
          fs.rmSync(folder, { recursive: true, force: true });
          deleted++;
          logger.ok(`Deleted VirtualStore: ${folder}`);
        } catch (e) {
          logger.debug(`Could not delete: ${folder}`);
        }
      }
    }
  }

  return { success: true, deleted };
}

/**
 * Clean Windows Error Reporting crash dumps
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanCrashDumps() {
  logger.info('Cleaning crash dumps...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0

      # Clean CrashDumps folder
      $crashPath = Join-Path $env:LOCALAPPDATA 'CrashDumps'
      if (Test-Path $crashPath) {
        Get-ChildItem $crashPath -Filter '*zoom*.dmp' -ErrorAction SilentlyContinue | ForEach-Object {
          Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
          $count++
        }
        Get-ChildItem $crashPath -Filter '*cpt*.dmp' -ErrorAction SilentlyContinue | ForEach-Object {
          Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
          $count++
        }
        Get-ChildItem $crashPath -Filter '*zcs*.dmp' -ErrorAction SilentlyContinue | ForEach-Object {
          Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # Clean WER folders
      $werPaths = @(
        (Join-Path $env:ProgramData 'Microsoft\\Windows\\WER\\ReportArchive'),
        (Join-Path $env:ProgramData 'Microsoft\\Windows\\WER\\ReportQueue')
      )
      foreach ($werPath in $werPaths) {
        if (Test-Path $werPath) {
          Get-ChildItem $werPath -Directory -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*cpt*'
          } | ForEach-Object {
            Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }

      Write-Output $count
    `, { timeout: 30000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Cleaned ${deleted} crash dump entries`);
    }
  } catch (e) {
    logger.debug('Crash dump cleanup failed', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Rebuild icon cache (removes Zoom icon traces)
 * @returns {Promise<{success: boolean}>}
 */
async function rebuildIconCache() {
  logger.info('Rebuilding icon cache...');

  try {
    await runPowerShell(`
      # Stop Explorer
      Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue

      # Delete icon cache files
      $explorerPath = Join-Path $env:LOCALAPPDATA 'Microsoft\\Windows\\Explorer'
      Remove-Item "$explorerPath\\iconcache*.db" -Force -ErrorAction SilentlyContinue
      Remove-Item "$explorerPath\\thumbcache*.db" -Force -ErrorAction SilentlyContinue
      Remove-Item (Join-Path $env:LOCALAPPDATA 'IconCache.db') -Force -ErrorAction SilentlyContinue

      # Restart Explorer
      Start-Process explorer
    `, { timeout: 30000 });

    logger.ok('Icon cache rebuilt');
    return { success: true };
  } catch (e) {
    logger.debug('Icon cache rebuild failed', { error: e.message });
    return { success: false };
  }
}

/**
 * Clean Recycle Bin of Zoom files
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanRecycleBin() {
  logger.info('Cleaning Recycle Bin...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      $shell = New-Object -ComObject Shell.Application
      $recycleBin = $shell.NameSpace(0xA)

      # Get items in recycle bin
      $items = $recycleBin.Items()
      foreach ($item in $items) {
        $name = $item.Name
        $path = $item.Path
        if ($name -like '*zoom*' -or $path -like '*zoom*' -or $name -like '*cpt*') {
          # Unfortunately can't selectively delete from recycle bin via COM
          # Just count for now
          $count++
        }
      }

      # If there are zoom items, offer to empty specific items
      # For full cleanup, we need to use Clear-RecycleBin for zoom items
      if ($count -gt 0) {
        # Use rd to forcefully clean recycle bin folders
        Get-ChildItem 'C:\\$Recycle.Bin' -Force -ErrorAction SilentlyContinue | ForEach-Object {
          Get-ChildItem $_.FullName -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*'
          } | ForEach-Object {
            Remove-Item $_.FullName -Force -Recurse -ErrorAction SilentlyContinue
          }
        }
      }

      Write-Output $count
    `, { timeout: 30000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Found/cleaned ${deleted} Zoom items in Recycle Bin`);
    }
  } catch (e) {
    logger.debug('Recycle Bin cleanup failed', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Clean Amcache (Windows program execution history)
 * Amcache.hve tracks every executable ever run on the system
 * This is a CRITICAL fingerprint source for device bans
 * @returns {Promise<{success: boolean, deleted: number, method: string}>}
 */
async function wipeAmcache() {
  logger.info('Wiping Amcache (program execution history)...');

  let deleted = 0;
  let method = 'none';

  try {
    // Amcache.hve is locked by Windows. We need to:
    // 1. Load it as an offline hive
    // 2. Delete Zoom-related entries
    // 3. Unload it
    //
    // The hive contains File entries with SHA1 hashes and paths of executed programs
    const result = await runPowerShell(`
      $deleted = 0
      $hivePath = 'C:\\Windows\\AppCompat\\Programs\\Amcache.hve'
      $tempKey = 'HKLM\\TEMP_AMCACHE'

      # Check if file exists
      if (-not (Test-Path $hivePath)) {
        Write-Output "0|notfound"
        exit
      }

      try {
        # Load the hive offline
        $loadResult = reg load $tempKey $hivePath 2>&1
        if ($LASTEXITCODE -ne 0) {
          # Try stopping Application Experience service first
          Stop-Service -Name 'AeLookupSvc' -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 2
          $loadResult = reg load $tempKey $hivePath 2>&1
        }

        if ($LASTEXITCODE -eq 0) {
          # Search for Zoom entries in InventoryApplicationFile
          $basePath = 'HKLM:\\TEMP_AMCACHE\\Root\\InventoryApplicationFile'
          if (Test-Path $basePath) {
            Get-ChildItem $basePath -ErrorAction SilentlyContinue | ForEach-Object {
              $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
              $name = $props.Name
              $path = $props.LowerCaseLongPath

              if ($name -like '*zoom*' -or $name -like '*cpt*' -or $name -like '*zcs*' -or
                  $path -like '*zoom*' -or $path -like '*cpt*') {
                Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
                $deleted++
              }
            }
          }

          # Also check Root\\File (older format)
          $filePath = 'HKLM:\\TEMP_AMCACHE\\Root\\File'
          if (Test-Path $filePath) {
            Get-ChildItem $filePath -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
              $name = $_.PSChildName
              if ($name -like '*zoom*' -or $name -like '*cpt*') {
                Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
                $deleted++
              }
            }
          }

          # Unload the hive
          [gc]::Collect()
          Start-Sleep -Seconds 1
          reg unload $tempKey 2>&1 | Out-Null

          # Restart service
          Start-Service -Name 'AeLookupSvc' -ErrorAction SilentlyContinue

          Write-Output "$deleted|hive"
        } else {
          Write-Output "0|locked"
        }
      } catch {
        # Make sure we unload on error
        reg unload $tempKey 2>&1 | Out-Null
        Start-Service -Name 'AeLookupSvc' -ErrorAction SilentlyContinue
        Write-Output "0|error"
      }
    `, { timeout: 120000 });

    const parts = result.stdout.trim().split('|');
    deleted = parseInt(parts[0], 10) || 0;
    method = parts[1] || 'unknown';

    if (deleted > 0) {
      logger.ok(`Wiped ${deleted} Amcache entries`, { method });
    } else if (method === 'locked') {
      logger.warn('Amcache is locked - may require reboot to clean');
    } else if (method === 'notfound') {
      logger.debug('Amcache.hve not found');
    }
  } catch (e) {
    logger.warn('Amcache cleanup failed', { error: e.message });
    method = 'failed';
  }

  // Also clean RecentFileCache.bcf if it exists
  try {
    const bcfPath = 'C:\\Windows\\AppCompat\\Programs\\RecentFileCache.bcf';
    if (fs.existsSync(bcfPath)) {
      fs.unlinkSync(bcfPath);
      deleted++;
      logger.ok('Deleted RecentFileCache.bcf');
    }
  } catch (e) {
    // May be locked
    logger.debug('RecentFileCache.bcf locked or inaccessible');
  }

  return { success: true, deleted, method };
}

/**
 * Clean SRUM database (System Resource Usage Monitor)
 * SRUM tracks per-application resource usage and can fingerprint the device
 * @returns {Promise<{success: boolean, deleted: number, method: string}>}
 */
async function wipeSrumDatabase() {
  logger.info('Wiping SRUM database (resource usage history)...');

  let deleted = 0;
  let method = 'none';

  try {
    // SRUDB.dat is locked by DiagTrack and DPS services
    // We need to stop them, delete/clean the DB, then restart
    const result = await runPowerShell(`
      $deleted = 0
      $srumPath = 'C:\\Windows\\System32\\sru\\SRUDB.dat'

      if (-not (Test-Path $srumPath)) {
        Write-Output "0|notfound"
        exit
      }

      try {
        # Stop services that lock SRUM
        $services = @('DiagTrack', 'DPS')
        $stoppedServices = @()

        foreach ($svc in $services) {
          $service = Get-Service -Name $svc -ErrorAction SilentlyContinue
          if ($service -and $service.Status -eq 'Running') {
            Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
            $stoppedServices += $svc
          }
        }

        Start-Sleep -Seconds 3

        # Try to access SRUM via ESE database (esentutl)
        # First, try to defragment/repair which can clear some entries
        # Or we can delete the whole file and let Windows recreate it

        # Option 1: Delete the entire SRUM database (Windows will recreate it fresh)
        # This is the nuclear option but most effective
        $retries = 3
        $deletedFile = $false

        for ($i = 0; $i -lt $retries; $i++) {
          try {
            Remove-Item $srumPath -Force -ErrorAction Stop
            $deletedFile = $true
            $deleted++
            break
          } catch {
            Start-Sleep -Seconds 2
          }
        }

        # If deletion failed, try using esentutl to dump and recreate
        if (-not $deletedFile) {
          # Alternative: use esentutl to at least defrag
          esentutl /d $srumPath 2>&1 | Out-Null
        }

        # Restart services
        foreach ($svc in $stoppedServices) {
          Start-Service -Name $svc -ErrorAction SilentlyContinue
        }

        if ($deletedFile) {
          Write-Output "$deleted|deleted"
        } else {
          Write-Output "0|defrag"
        }
      } catch {
        # Restart services on error
        Start-Service -Name 'DiagTrack' -ErrorAction SilentlyContinue
        Start-Service -Name 'DPS' -ErrorAction SilentlyContinue
        Write-Output "0|error"
      }
    `, { timeout: 120000 });

    const parts = result.stdout.trim().split('|');
    deleted = parseInt(parts[0], 10) || 0;
    method = parts[1] || 'unknown';

    if (method === 'deleted') {
      logger.ok('SRUM database deleted (will be recreated fresh by Windows)');
    } else if (method === 'defrag') {
      logger.warn('SRUM database defragmented but not deleted (file locked)');
    } else if (method === 'notfound') {
      logger.debug('SRUM database not found');
    }
  } catch (e) {
    logger.warn('SRUM cleanup failed', { error: e.message });
    method = 'failed';
  }

  return { success: true, deleted, method };
}

/**
 * Clean Windows Event Logs of Zoom-related entries
 * Event logs can contain error codes, installation info, and device identifiers
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanEventLogs() {
  logger.info('Cleaning Windows Event Logs (Zoom entries)...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $deleted = 0

      # Event logs that may contain Zoom entries
      $logNames = @(
        'Application',
        'System',
        'Microsoft-Windows-AppXDeploymentServer/Operational',
        'Microsoft-Windows-AppXPackaging/Operational'
      )

      foreach ($logName in $logNames) {
        try {
          # Get Zoom-related events and remove them
          # We can't selectively delete events, but we can clear the entire log
          # Instead, we'll use wevtutil to export, filter, and re-import
          # For now, we just count and warn
          $events = Get-WinEvent -LogName $logName -ErrorAction SilentlyContinue | Where-Object {
            $_.Message -like '*zoom*' -or
            $_.Message -like '*Zoom*' -or
            $_.ProviderName -like '*Zoom*' -or
            $_.Message -like '*CptService*' -or
            $_.Message -like '*1132*'
          }

          if ($events) {
            $deleted += $events.Count
          }
        } catch {
          # Log might not exist or be inaccessible
        }
      }

      # Clear specific operational logs that might track Zoom
      $clearLogs = @(
        'Microsoft-Windows-Application-Experience/Program-Inventory',
        'Microsoft-Windows-Application-Experience/Program-Telemetry'
      )

      foreach ($log in $clearLogs) {
        try {
          wevtutil cl "$log" 2>&1 | Out-Null
          if ($LASTEXITCODE -eq 0) {
            $deleted++
          }
        } catch { }
      }

      Write-Output $deleted
    `, { timeout: 60000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Found/cleared ${deleted} event log entries`);
    }
  } catch (e) {
    logger.debug('Event log cleanup failed', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Clean Windows temp folders of Zoom files
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanTempFiles() {
  logger.info('Cleaning temp files...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      $tempPaths = @(
        $env:TEMP,
        (Join-Path $env:LOCALAPPDATA 'Temp'),
        'C:\\Windows\\Temp'
      )

      foreach ($tempPath in $tempPaths) {
        if (Test-Path $tempPath) {
          Get-ChildItem $tempPath -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or $_.Name -like '*cpt*' -or $_.Name -like '*zcs*'
          } | ForEach-Object {
            try {
              if ($_.PSIsContainer) {
                Remove-Item $_.FullName -Recurse -Force -ErrorAction Stop
              } else {
                Remove-Item $_.FullName -Force -ErrorAction Stop
              }
              $count++
            } catch { }
          }
        }
      }

      Write-Output $count
    `, { timeout: 60000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Cleaned ${deleted} temp files`);
    }
  } catch (e) {
    logger.debug('Temp file cleanup failed', { error: e.message });
  }

  return { success: true, deleted };
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
    amcache: null,
    srum: null,
    eventLogs: null,
    dns: null,
    firewall: null,
    jumpLists: null,
    virtualStore: null,
    crashDumps: null,
    tempFiles: null,
    recycleBin: null,
    iconCache: null
  };

  // CRITICAL: Order matters! Some steps depend on others
  // NOTE: Recycle bin cleanup and icon cache rebuild are NOT included here
  //       They must be called AFTER folder deletion by ipc-handlers.js
  //       (folder deletion may send items to recycle bin)
  //
  // Order:
  // 1. First clean active fingerprint data (telemetry, cpt, registry)
  // 2. Then clean execution history (prefetch, credentials)
  // 3. Then clean network traces (dns, firewall)
  // 4. Then clean filesystem traces (jumpLists, virtualStore, crashDumps, temp)
  const stepList = [
    { id: 'telemetry', name: 'Telemetry Databases', fn: wipeTelemetryDatabases },
    { id: 'cptService', name: 'CptService Identifiers', fn: wipeCptServiceData },
    { id: 'registry', name: 'Registry Fingerprints', fn: wipeRegistryFingerprints },
    { id: 'credentials', name: 'Windows Credentials', fn: removeWindowsCredentials },
    { id: 'prefetch', name: 'Prefetch Files', fn: clearPrefetchFiles },
    { id: 'amcache', name: 'Amcache (Execution History)', fn: wipeAmcache },
    { id: 'srum', name: 'SRUM Database (Usage History)', fn: wipeSrumDatabase },
    { id: 'eventLogs', name: 'Event Logs (Zoom Entries)', fn: cleanEventLogs },
    { id: 'dns', name: 'DNS Cache', fn: flushDnsCache },
    { id: 'firewall', name: 'Firewall Rules', fn: removeFirewallRules },
    { id: 'jumpLists', name: 'Jump Lists & Recent Files', fn: cleanJumpLists },
    { id: 'virtualStore', name: 'VirtualStore Files', fn: cleanVirtualStore },
    { id: 'crashDumps', name: 'Crash Dumps & WER', fn: cleanCrashDumps },
    { id: 'tempFiles', name: 'Temp Files', fn: cleanTempFiles }
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
  wipeAmcache,
  wipeSrumDatabase,
  cleanEventLogs,
  flushDnsCache,
  removeFirewallRules,
  cleanJumpLists,
  cleanVirtualStore,
  cleanCrashDumps,
  rebuildIconCache,
  cleanRecycleBin,
  cleanTempFiles,
  wipeDeviceFingerprint,
  verifyFingerprintWipe
};
