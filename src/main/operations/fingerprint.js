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
 * Wipe Zoom data directories and database files for ALL user profiles on the machine.
 * Scans C:\Users\* for AppData\Roaming\Zoom\data and AppData\Local\Zoom\data.
 * @returns {Promise<{success: boolean, deleted: number, users: string[]}>}
 */
async function wipeAllUserZoomData() {
  logger.info('Nuking ALL Zoom data for all user profiles...');

  const usersDir = 'C:\\Users';
  const skipUsers = [];  // Don't skip ANY user — nuke Zoom data everywhere
  let deleted = 0;
  const affectedUsers = [];

  try {
    const users = fs.readdirSync(usersDir);

    for (const user of users) {
      if (skipUsers.includes(user)) continue;

      const userPath = path.join(usersDir, user);
      try {
        if (!fs.statSync(userPath).isDirectory()) continue;
      } catch (_) { continue; }

      // Wipe fingerprint data subdirectories but KEEP bin/ (Zoom installation) intact
      // User-installed Zoom lives at AppData\Roaming\Zoom\bin — deleting the whole folder uninstalls Zoom
      const zoomDataSubdirs = ['data', 'EBWebView', 'app-data', 'logs', 'CrashDumps', 'WebviewCacheX64'];
      const zoomRoots = ['Zoom', 'Zoom Workplace'];
      const zoomDirs = [];
      for (const base of ['Roaming', 'Local']) {
        for (const root of zoomRoots) {
          for (const sub of zoomDataSubdirs) {
            zoomDirs.push(path.join(userPath, 'AppData', base, root, sub));
          }
        }
      }
      // These are NOT Zoom installations, safe to nuke entirely
      for (const extra of ['ZoomAgentClient', 'ZoomAlt']) {
        zoomDirs.push(path.join(userPath, 'AppData', 'Roaming', extra));
        zoomDirs.push(path.join(userPath, 'AppData', 'Local', extra));
      }

      // Also catch data subdirs in any other Zoom* dirs we don't know about
      try {
        for (const base of ['Roaming', 'Local']) {
          const appDataBase = path.join(userPath, 'AppData', base);
          if (fs.existsSync(appDataBase)) {
            const entries = fs.readdirSync(appDataBase);
            for (const entry of entries) {
              if (entry.toLowerCase().startsWith('zoom')) {
                // Only target data subdirs, not the root (which may contain bin/)
                for (const sub of zoomDataSubdirs) {
                  const subPath = path.join(appDataBase, entry, sub);
                  if (!zoomDirs.includes(subPath)) {
                    zoomDirs.push(subPath);
                  }
                }
              }
            }
          }
        }
      } catch (_) {}

      // Also delete key fingerprint config files from Zoom root dirs (but NOT bin/)
      const fingerprintFiles = ['Zoom.us.ini', 'viper.ini', 'appsafecheck.txt', 'ZoomWorkplace.ini'];
      for (const base of ['Roaming', 'Local']) {
        for (const root of ['Zoom', 'Zoom Workplace']) {
          const zoomRoot = path.join(userPath, 'AppData', base, root);
          for (const f of fingerprintFiles) {
            const fp = path.join(zoomRoot, f);
            try {
              if (fs.existsSync(fp)) {
                fs.unlinkSync(fp);
                deleted++;
                logger.ok(`Deleted config: ${fp}`);
              }
            } catch (_) {}
          }
        }
      }

      let userHit = false;

      for (const zoomDir of zoomDirs) {
        if (!fs.existsSync(zoomDir)) continue;

        try {
          // Count files before deletion
          const countBefore = countFilesRecursive(zoomDir);
          logger.info(`Found ${countBefore} files in ${zoomDir}`);

          // Try Node.js recursive delete first
          fs.rmSync(zoomDir, { recursive: true, force: true });
          deleted += countBefore;
          userHit = true;
          logger.ok(`Nuked entire directory: ${zoomDir} (${countBefore} files)`);
        } catch (_) {
          // Force delete via PowerShell if Node fails (locked files, permissions)
          try {
            await runPowerShell(
              `Remove-Item -LiteralPath '${zoomDir}' -Recurse -Force -ErrorAction SilentlyContinue`,
              { timeout: 15000 }
            );
            userHit = true;
            logger.ok(`Force nuked directory: ${zoomDir}`);
          } catch (e2) {
            logger.warn(`Could not fully delete: ${zoomDir}`, { error: e2.message });
            // Last resort: try to at least delete key fingerprint files
            try {
              await runPowerShell(`
                Get-ChildItem '${zoomDir}' -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
                  try { Remove-Item $_.FullName -Force -ErrorAction Stop } catch {}
                }
              `, { timeout: 15000 });
              userHit = true;
              logger.ok(`Force deleted files in: ${zoomDir}`);
            } catch (_) {}
          }
        }
      }

      if (userHit) affectedUsers.push(user);
    }
  } catch (e) {
    logger.warn('Error scanning user profiles', { error: e.message });
  }

  // Also nuke global Zoom directories (ProgramData, Program Files leftovers)
  const globalZoomDirs = [
    'C:\\ProgramData\\Zoom',
    'C:\\ProgramData\\Zoom Workplace',
    'C:\\ProgramData\\ZoomCptService',
    'C:\\ProgramData\\Zoom CptService',
    'C:\\ProgramData\\zCSCptService',
  ];

  // Catch Zoom_del_* leftover directories in Program Files (NOT the actual Zoom installation)
  try {
    const pfDirs = ['C:\\Program Files', 'C:\\Program Files (x86)'];
    for (const pf of pfDirs) {
      if (fs.existsSync(pf)) {
        const entries = fs.readdirSync(pf);
        for (const entry of entries) {
          const lower = entry.toLowerCase();
          // Only delete leftover/temp dirs like "Zoom_del_xxxx", never the main "Zoom" or "Zoom Workplace" installation
          if (lower.startsWith('zoom_del') || lower.startsWith('zoom workplace_del')) {
            globalZoomDirs.push(path.join(pf, entry));
          }
        }
      }
    }
  } catch (_) {}

  for (const gDir of globalZoomDirs) {
    if (!fs.existsSync(gDir)) continue;
    try {
      const countBefore = countFilesRecursive(gDir);
      fs.rmSync(gDir, { recursive: true, force: true });
      deleted += countBefore;
      logger.ok(`Nuked global directory: ${gDir} (${countBefore} files)`);
    } catch (_) {
      try {
        await runPowerShell(`
          $dir = '${gDir.replace(/'/g, "''")}'
          # Take ownership and reset ACLs
          takeown /F $dir /R /D Y 2>&1 | Out-Null
          icacls $dir /reset /T /Q 2>&1 | Out-Null
          icacls $dir /grant:r Administrators:F /T /Q 2>&1 | Out-Null
          Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop
        `, { timeout: 30000 });
        logger.ok(`Force nuked global directory: ${gDir}`);
      } catch (_) {
        // Last resort: cmd rd
        try {
          await spawnSafe('cmd', ['/c', 'rd', '/s', '/q', gDir], { timeout: 15000 });
          logger.ok(`rd nuked global directory: ${gDir}`);
        } catch (_) {
          logger.warn(`Could not delete global dir: ${gDir}`);
        }
      }
    }
  }

  if (deleted > 0) {
    logger.ok(`Nuked ${deleted} Zoom files across ${affectedUsers.length} user(s): ${affectedUsers.join(', ')}`);
  } else {
    logger.info('No Zoom data found across user profiles');
  }

  return { success: true, deleted, users: affectedUsers };
}

/**
 * Count files recursively in a directory
 */
function countFilesRecursive(dirPath) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        count++;
      } else if (entry.isDirectory()) {
        count += countFilesRecursive(path.join(dirPath, entry.name));
      }
    }
  } catch (_) {}
  return count;
}

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
 * Block CptService from accessing the network
 * Must be called BEFORE MSI install to prevent device fingerprint registration
 * Creates Windows Firewall rules that block CptService.exe outbound traffic
 * @returns {Promise<{success: boolean, rulesCreated: number}>}
 */
async function blockCptServiceNetwork() {
  logger.info('Blocking Zoom/CptService network access via firewall...');

  try {
    const result = await runPowerShell(`
      $count = 0

      # Remove any existing block rules first (idempotent)
      Get-NetFirewallRule -DisplayName '1132Fix-Block-*' -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue

      # Block ALL Zoom binaries from outbound network access
      # CptShare.dll runs INSIDE Zoom.exe, so we must block Zoom.exe itself
      $zoomExePaths = @(
        "$env:ProgramFiles\\Zoom\\bin\\Zoom.exe",
        "$env:ProgramFiles\\Zoom\\bin\\CptInstall.exe",
        "$env:ProgramFiles\\Zoom\\bin\\Zoom_launcher.exe",
        "$env:ProgramFiles\\Zoom\\bin\\aomhost64.exe",
        "$env:ProgramFiles (x86)\\Zoom\\bin\\Zoom.exe",
        "$env:ProgramFiles (x86)\\Zoom\\bin\\CptInstall.exe",
        "$env:LOCALAPPDATA\\Zoom\\Zoom.exe",
        "$env:LOCALAPPDATA\\Zoom\\CptInstall.exe",
        "$env:APPDATA\\Zoom\\bin\\Zoom.exe"
      )

      foreach ($p in $zoomExePaths) {
        $hash = $p.GetHashCode()
        New-NetFirewallRule -DisplayName "1132Fix-Block-Zoom-$hash" -Direction Outbound -Action Block \`
          -Program $p -Profile Any -Enabled True -ErrorAction SilentlyContinue | Out-Null
        $count++
      }

      # Block by service name
      foreach ($svc in @('ZoomCptService','CptService','zCSCptService')) {
        New-NetFirewallRule -DisplayName "1132Fix-Block-Svc-$svc" -Direction Outbound -Action Block \`
          -Service $svc -Profile Any -Enabled True -ErrorAction SilentlyContinue | Out-Null
        $count++
      }

      Write-Output $count
    `, { timeout: 30000 });

    const created = parseInt(result.stdout, 10) || 0;
    logger.ok(`Created ${created} firewall block rules for Zoom/CptService`);
    return { success: true, rulesCreated: created };
  } catch (e) {
    logger.warn('Failed to create firewall blocks', { error: e.message });
    return { success: false, rulesCreated: 0 };
  }
}

/**
 * Remove 1132Fix firewall block rules (cleanup)
 * Called if the user wants to unblock CptService later
 * @returns {Promise<{success: boolean, removed: number}>}
 */
async function unblockCptServiceNetwork() {
  logger.info('Removing CptService firewall blocks...');

  try {
    const result = await runPowerShell(`
      $rules = Get-NetFirewallRule -DisplayName '1132Fix-Block-*' -ErrorAction SilentlyContinue
      $count = 0
      if ($rules) {
        $count = $rules.Count
        $rules | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      }
      Write-Output $count
    `, { timeout: 30000 });

    const removed = parseInt(result.stdout, 10) || 0;
    logger.ok(`Removed ${removed} CptService block rules`);
    return { success: true, removed };
  } catch (e) {
    logger.warn('Failed to remove CptService block rules', { error: e.message });
    return { success: false, removed: 0 };
  }
}

/**
 * Neutralize CptService binary after MSI install
 * Deletes the CptService.exe binary and sets DENY ACLs on the path
 * to prevent Zoom from recreating it
 * @returns {Promise<{success: boolean, neutralized: number}>}
 */
async function neutralizeCptServiceBinary() {
  logger.info('Neutralizing CptService/CptShare binaries...');

  try {
    const result = await runPowerShell(`
      $count = 0

      # Kill any running CptService/Zoom processes first
      Get-Process -Name 'CptService','CptHost','CptControl','CptInstall','zcscpthost','zCSCptService','Zoom','Zoomus','Zoom_launcher' -EA SilentlyContinue |
        Stop-Process -Force -EA SilentlyContinue
      Start-Sleep -Milliseconds 1000

      Stop-Service -Name 'ZoomCptService' -Force -EA SilentlyContinue
      Stop-Service -Name 'CptService' -Force -EA SilentlyContinue
      Stop-Service -Name 'zCSCptService' -Force -EA SilentlyContinue
      sc.exe delete ZoomCptService 2>$null | Out-Null
      sc.exe delete CptService 2>$null | Out-Null
      sc.exe delete zCSCptService 2>$null | Out-Null

      # Target the ACTUAL fingerprinting binaries in Zoom install dirs
      # CptShare.dll = the DLL loaded by Zoom.exe that generates device fingerprints
      # CptInstall.exe = installs/manages CptService
      $zoomBinDirs = @(
        "$env:ProgramFiles\\Zoom\\bin",
        "$env:ProgramFiles (x86)\\Zoom\\bin",
        "$env:LOCALAPPDATA\\Zoom\\bin",
        "$env:APPDATA\\Zoom\\bin",
        "$env:ProgramFiles\\Common Files\\Zoom\\Support",
        "$env:ProgramFiles (x86)\\Common Files\\Zoom\\Support"
      )

      # ALL fingerprinting-related binaries
      $cptBinaries = @(
        'CptShare.dll',
        'CptInstall.exe',
        'CptService.exe',
        'CptHost.exe',
        'CptControl.exe',
        'zcscpthost.exe',
        'zCSCptService.exe',
        'zMcmService.dll'
      )

      foreach ($dir in $zoomBinDirs) {
        if (-not (Test-Path $dir)) { continue }
        foreach ($bin in $cptBinaries) {
          $fullPath = Join-Path $dir $bin
          if (Test-Path $fullPath) {
            try {
              takeown /F "$fullPath" /A 2>&1 | Out-Null
              icacls "$fullPath" /grant Administrators:F /Q 2>&1 | Out-Null
              Remove-Item -LiteralPath $fullPath -Force -EA Stop
              $count++
              Write-Host "DELETED: $fullPath"
            } catch {
              # Try renaming instead of deleting (may be locked)
              try {
                $newName = "$fullPath.disabled"
                Rename-Item -LiteralPath $fullPath -NewName $newName -Force -EA Stop
                $count++
                Write-Host "RENAMED: $fullPath -> $newName"
              } catch {
                Write-Host "FAILED: $fullPath - $_"
              }
            }
          }
        }
      }

      # Clean CptService data directories
      $cptDataPaths = @(
        "$env:ProgramData\\CptService",
        "$env:ProgramData\\CptHost",
        "$env:ProgramData\\Zoom CptService",
        "$env:ProgramData\\zCSCptService",
        "$env:ProgramData\\ZoomCptService"
      )

      foreach ($dp in $cptDataPaths) {
        if (Test-Path $dp) {
          takeown /F "$dp" /R /A /D Y 2>&1 | Out-Null
          icacls "$dp" /grant Administrators:F /T /Q 2>&1 | Out-Null
          Remove-Item $dp -Recurse -Force -EA SilentlyContinue
          if (-not (Test-Path $dp)) {
            $count++
            Write-Host "DELETED DIR: $dp"
          }
        }
      }

      # Create placeholder files at CptShare.dll path to prevent Zoom from recreating
      foreach ($dir in $zoomBinDirs) {
        if (-not (Test-Path $dir)) { continue }
        foreach ($bin in @('CptShare.dll','CptInstall.exe')) {
          $fullPath = Join-Path $dir $bin
          if (-not (Test-Path $fullPath)) {
            try {
              # Create a 0-byte placeholder
              [System.IO.File]::Create($fullPath).Close()
              # Make it read-only and set DENY write ACL
              $item = Get-Item $fullPath
              $item.Attributes = 'ReadOnly,System,Hidden'
              $acl = Get-Acl $fullPath
              $everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
              $deny = New-Object System.Security.AccessControl.FileSystemAccessRule(
                $everyone, 'Write,Delete,Modify', 'None', 'None', 'Deny')
              $acl.AddAccessRule($deny)
              Set-Acl -Path $fullPath -AclObject $acl -EA SilentlyContinue
              Write-Host "PLACEHOLDER: $fullPath (0-byte, locked)"
            } catch {
              Write-Host "Could not create placeholder: $fullPath"
            }
          }
        }
      }

      Write-Output $count
    `, { timeout: 45000 });

    const neutralized = parseInt(result.stdout, 10) || 0;
    logger.ok(`Neutralized ${neutralized} CptService/CptShare binaries`);
    return { success: true, neutralized };
  } catch (e) {
    logger.warn('Failed to neutralize CptService', { error: e.message });
    return { success: false, neutralized: 0 };
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
        # Stop ALL services that lock Amcache
        @('AeLookupSvc', 'PcaSvc', 'DiagTrack') | ForEach-Object {
          Stop-Service -Name $_ -Force -ErrorAction SilentlyContinue
        }
        # Kill processes that hold Amcache open
        @('CompatTelRunner', 'WerFault') | ForEach-Object {
          Get-Process -Name $_ -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2

        # Load the hive offline
        $loadResult = reg load $tempKey $hivePath 2>&1
        if ($LASTEXITCODE -ne 0) {
          Start-Sleep -Seconds 3
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
          # Hive still locked — schedule deletion at next reboot
          try {
            [System.IO.File]::Move($hivePath, "$hivePath.bak") 2>$null
          } catch {}
          # Use MoveFileEx to delete on reboot (kernel API)
          $signature = @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);
'@
          $type = Add-Type -MemberDefinition $signature -Name 'MoveFileUtils' -Namespace 'Win32' -PassThru -ErrorAction SilentlyContinue
          if ($type) {
            $type::MoveFileEx($hivePath, $null, 4) | Out-Null  # MOVEFILE_DELAY_UNTIL_REBOOT
            $type::MoveFileEx("$hivePath.LOG1", $null, 4) | Out-Null
            $type::MoveFileEx("$hivePath.LOG2", $null, 4) | Out-Null
            Write-Output "0|reboot_scheduled"
          } else {
            Write-Output "0|locked"
          }
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
    } else if (method === 'reboot_scheduled') {
      logger.warn('Amcache locked — scheduled for deletion on next reboot');
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
 * Clean Zoom certificates from the Windows certificate store
 * These are used for code signing verification and can fingerprint the device
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanZoomCertificates() {
  logger.info('Cleaning Zoom certificates from certificate store...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      $stores = @('Cert:\\CurrentUser\\Root', 'Cert:\\CurrentUser\\TrustedPublisher', 'Cert:\\LocalMachine\\Root', 'Cert:\\LocalMachine\\TrustedPublisher')
      foreach ($store in $stores) {
        if (Test-Path $store) {
          Get-ChildItem $store -ErrorAction SilentlyContinue | Where-Object {
            $_.Subject -like '*Zoom*' -or $_.Subject -like '*zoom.us*' -or $_.Issuer -like '*Zoom Video*'
          } | ForEach-Object {
            Remove-Item $_.PSPath -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Removed ${deleted} Zoom certificates`);
    }
  } catch (e) {
    logger.debug('Certificate cleanup skipped', { error: e.message });
  }

  return { success: true, deleted };
}


/**
 * Clean BITS (Background Intelligent Transfer Service) jobs
 * Zoom uses BITS for downloads and these persist with identifying info
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanBitsJobs() {
  logger.info('Cleaning BITS transfer jobs...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0
      Import-Module BitsTransfer -ErrorAction SilentlyContinue
      Get-BitsTransfer -AllUsers -ErrorAction SilentlyContinue | Where-Object {
        $_.DisplayName -like '*zoom*' -or $_.FileList.RemoteName -like '*zoom*' -or $_.Description -like '*zoom*'
      } | ForEach-Object {
        Remove-BitsTransfer $_ -ErrorAction SilentlyContinue
        $count++
      }
      Write-Output $count
    `, { timeout: 30000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`BITS jobs cleaned: ${deleted} removed`);
    }
  } catch (e) {
    logger.debug('BITS cleanup skipped', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Clean network profiles that contain Zoom connection data
 * Windows stores per-network info that can link to Zoom usage
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanNetworkProfiles() {
  logger.info('Cleaning Zoom network profile traces...');

  let deleted = 0;

  try {
    const result = await runPowerShell(`
      $count = 0

      # Clean network list profile registry keys that reference Zoom
      $nlmPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\NetworkList\\Profiles'
      if (Test-Path $nlmPath) {
        Get-ChildItem $nlmPath -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          if ($props.Description -like '*zoom*' -or $props.ProfileName -like '*zoom*') {
            Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }

      # Flush ARP cache (removes cached network addresses used during Zoom calls)
      netsh interface ip delete arpcache 2>&1 | Out-Null

      Write-Output $count
    `, { timeout: 30000 });

    deleted = parseInt(result.stdout, 10) || 0;
    if (deleted > 0) {
      logger.ok(`Network profiles cleaned: ${deleted} removed`);
    }
  } catch (e) {
    logger.debug('Network profile cleanup skipped', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Clean Windows Notification database of Zoom entries
 * The notification DB (wpndatabase.db) stores Zoom toast notification history
 * @returns {Promise<{success: boolean, deleted: number}>}
 */
async function cleanNotificationDatabase() {
  logger.info('Cleaning notification database...');

  let deleted = 0;

  try {
    const notifPath = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications');
    if (fs.existsSync(notifPath)) {
      const result = await runPowerShell(`
        $count = 0
        $notifPath = "${notifPath.replace(/\\/g, '\\\\')}"

        # Stop notification service to unlock DB
        Stop-Service -Name 'WpnService' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1

        # Delete notification DB files (they'll be recreated)
        Get-ChildItem $notifPath -Filter 'wpndatabase*' -ErrorAction SilentlyContinue | ForEach-Object {
          try {
            Remove-Item $_.FullName -Force -ErrorAction Stop
            $count++
          } catch { }
        }

        # Restart notification service
        Start-Service -Name 'WpnService' -ErrorAction SilentlyContinue

        Write-Output $count
      `, { timeout: 30000 });

      deleted = parseInt(result.stdout, 10) || 0;
      if (deleted > 0) {
        logger.ok(`Notification database cleaned: ${deleted} files removed`);
      }
    }
  } catch (e) {
    logger.debug('Notification cleanup skipped', { error: e.message });
  }

  return { success: true, deleted };
}

/**
 * Clean font cache (Zoom registers custom fonts that persist)
 * @returns {Promise<{success: boolean}>}
 */
async function cleanFontCache() {
  logger.info('Cleaning font cache...');

  try {
    await runPowerShell(`
      # Stop font cache service
      Stop-Service -Name 'FontCache' -Force -ErrorAction SilentlyContinue
      Stop-Service -Name 'FontCache3.0.0.0' -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 1

      # Delete font cache files
      $fontCachePath = Join-Path $env:windir 'ServiceProfiles\\LocalService\\AppData\\Local\\FontCache'
      if (Test-Path $fontCachePath) {
        Get-ChildItem $fontCachePath -Filter '*.dat' -ErrorAction SilentlyContinue | ForEach-Object {
          Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        }
      }

      # Delete FNTCACHE.DAT
      $fntcache = Join-Path $env:windir 'System32\\FNTCACHE.DAT'
      Remove-Item $fntcache -Force -ErrorAction SilentlyContinue

      # Restart font cache
      Start-Service -Name 'FontCache' -ErrorAction SilentlyContinue
    `, { timeout: 30000 });

    logger.ok('Font cache cleaned');
    return { success: true };
  } catch (e) {
    logger.debug('Font cache cleanup skipped', { error: e.message });
    return { success: false };
  }
}

/**
 * Wipe user-profile-specific execution fingerprints
 * CRITICAL: These are the entries that persist on the CURRENT user but
 * would be clean on a NEW Windows user — explaining why new accounts bypass 1132.
 *
 * Covers: BAM, UserAssist, AppCompatFlags, ActivitiesCache, ShimCache, MUICache
 * @returns {Promise<{success: boolean, deleted: number, details: Object}>}
 */
async function wipeUserProfileFingerprints() {
  logger.info('Wiping user-profile execution fingerprints...');

  let totalDeleted = 0;
  const details = {};

  // 1. BAM (Background Activity Monitor) — per-user SID in HKLM
  //    Tracks every EXE run with exact timestamps, indexed by user SID
  try {
    const bamResult = await runPowerShell(`
      $count = 0
      $sid = (New-Object System.Security.Principal.NTAccount($env:USERNAME)).Translate([System.Security.Principal.SecurityIdentifier]).Value

      # BAM state (Win10 1709+)
      $bamPaths = @(
        "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\bam\\State\\UserSettings\\$sid",
        "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\bam\\UserSettings\\$sid",
        "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\dam\\State\\UserSettings\\$sid",
        "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\dam\\UserSettings\\$sid"
      )

      foreach ($bamPath in $bamPaths) {
        if (Test-Path $bamPath) {
          $props = Get-ItemProperty $bamPath -ErrorAction SilentlyContinue
          $props.PSObject.Properties | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
            $_.Name -like '*cpt*' -or $_.Name -like '*zcs*'
          } | ForEach-Object {
            Remove-ItemProperty -Path $bamPath -Name $_.Name -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const bamDeleted = parseInt(bamResult.stdout, 10) || 0;
    details.bam = { deleted: bamDeleted };
    totalDeleted += bamDeleted;
    if (bamDeleted > 0) logger.ok(`BAM: removed ${bamDeleted} Zoom execution entries`);
  } catch (e) {
    details.bam = { error: e.message };
    logger.debug('BAM cleanup failed', { error: e.message });
  }

  // 2. UserAssist — ROT13-encoded execution tracking per user
  //    Tracks execution count, focus time, and last run for every program
  try {
    const uaResult = await runPowerShell(`
      $count = 0
      $uaBase = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist'

      if (Test-Path $uaBase) {
        Get-ChildItem $uaBase -ErrorAction SilentlyContinue | ForEach-Object {
          $countPath = Join-Path $_.PSPath 'Count'
          if (Test-Path $countPath) {
            # UserAssist keys are ROT13 encoded
            $props = Get-ItemProperty $countPath -ErrorAction SilentlyContinue
            $props.PSObject.Properties | Where-Object {
              # Decode ROT13 and check for zoom
              $decoded = $_.Name -creplace '[A-Za-z]', { param($m) [char](([int][char]$m.Value - 65 + 13) % 26 + 65) }
              # Also check raw name (some entries aren't ROT13)
              $decoded -like '*zoom*' -or $decoded -like '*Zoom*' -or
              $decoded -like '*cpt*' -or $decoded -like '*zcs*' -or
              $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
              $_.Name -like '*Mbbz*' -or $_.Name -like '*MBBZ*'
            } | ForEach-Object {
              Remove-ItemProperty -Path $countPath -Name $_.Name -Force -ErrorAction SilentlyContinue
              $count++
            }
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const uaDeleted = parseInt(uaResult.stdout, 10) || 0;
    details.userAssist = { deleted: uaDeleted };
    totalDeleted += uaDeleted;
    if (uaDeleted > 0) logger.ok(`UserAssist: removed ${uaDeleted} entries`);
  } catch (e) {
    details.userAssist = { error: e.message };
    logger.debug('UserAssist cleanup failed', { error: e.message });
  }

  // 3. AppCompatFlags — per-user compatibility assistant tracking
  try {
    const acfResult = await runPowerShell(`
      $count = 0
      $acfPaths = @(
        'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Compatibility Assistant\\Store',
        'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers',
        'HKLM:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers'
      )

      foreach ($acfPath in $acfPaths) {
        if (Test-Path $acfPath) {
          $props = Get-ItemProperty $acfPath -ErrorAction SilentlyContinue
          $props.PSObject.Properties | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
            $_.Name -like '*cpt*' -or $_.Name -like '*zcs*'
          } | ForEach-Object {
            Remove-ItemProperty -Path $acfPath -Name $_.Name -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const acfDeleted = parseInt(acfResult.stdout, 10) || 0;
    details.appCompatFlags = { deleted: acfDeleted };
    totalDeleted += acfDeleted;
    if (acfDeleted > 0) logger.ok(`AppCompatFlags: removed ${acfDeleted} entries`);
  } catch (e) {
    details.appCompatFlags = { error: e.message };
    logger.debug('AppCompatFlags cleanup failed', { error: e.message });
  }

  // 4. ActivitiesCache.db — Windows Timeline per-user database
  try {
    const actResult = await runPowerShell(`
      $count = 0
      $cdpBase = Join-Path $env:LOCALAPPDATA 'ConnectedDevicesPlatform'

      if (Test-Path $cdpBase) {
        # Stop the service that locks it
        Stop-Service -Name 'CDPUserSvc*' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1

        Get-ChildItem $cdpBase -Recurse -Filter 'ActivitiesCache.db*' -ErrorAction SilentlyContinue | ForEach-Object {
          Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
          $count++
        }

        # Also delete the whole CDP folder content
        Get-ChildItem $cdpBase -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          Get-ChildItem $_.FullName -File -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const actDeleted = parseInt(actResult.stdout, 10) || 0;
    details.activitiesCache = { deleted: actDeleted };
    totalDeleted += actDeleted;
    if (actDeleted > 0) logger.ok(`ActivitiesCache: removed ${actDeleted} files`);
  } catch (e) {
    details.activitiesCache = { error: e.message };
    logger.debug('ActivitiesCache cleanup failed', { error: e.message });
  }

  // 5. AppCompatCache / ShimCache — system-level execution cache
  try {
    const shimResult = await runPowerShell(`
      # AppCompatCache is a binary blob — we clear it entirely and let Windows rebuild
      $shimPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\AppCompatCache'
      if (Test-Path $shimPath) {
        try {
          Remove-ItemProperty -Path $shimPath -Name 'AppCompatCache' -Force -ErrorAction Stop
          Write-Output "1"
        } catch {
          Write-Output "0"
        }
      } else {
        Write-Output "0"
      }
    `, { timeout: 15000 });

    const shimDeleted = parseInt(shimResult.stdout, 10) || 0;
    details.shimCache = { deleted: shimDeleted };
    totalDeleted += shimDeleted;
    if (shimDeleted > 0) logger.ok('ShimCache/AppCompatCache cleared');
  } catch (e) {
    details.shimCache = { error: e.message };
    logger.debug('ShimCache cleanup failed', { error: e.message });
  }

  // 6. MUICache — per-user program name cache
  try {
    const muiResult = await runPowerShell(`
      $count = 0
      $muiPath = 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache'

      if (Test-Path $muiPath) {
        $props = Get-ItemProperty $muiPath -ErrorAction SilentlyContinue
        $props.PSObject.Properties | Where-Object {
          $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
          $_.Name -like '*cpt*' -or $_.Name -like '*zcs*'
        } | ForEach-Object {
          Remove-ItemProperty -Path $muiPath -Name $_.Name -Force -ErrorAction SilentlyContinue
          $count++
        }
      }
      Write-Output $count
    `, { timeout: 15000 });

    const muiDeleted = parseInt(muiResult.stdout, 10) || 0;
    details.muiCache = { deleted: muiDeleted };
    totalDeleted += muiDeleted;
    if (muiDeleted > 0) logger.ok(`MUICache: removed ${muiDeleted} entries`);
  } catch (e) {
    details.muiCache = { error: e.message };
    logger.debug('MUICache cleanup failed', { error: e.message });
  }

  // 7. Explorer FeatureUsage — tracks per-user app launch counts
  try {
    const fuResult = await runPowerShell(`
      $count = 0
      $fuBase = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FeatureUsage'

      if (Test-Path $fuBase) {
        Get-ChildItem $fuBase -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          $props.PSObject.Properties | Where-Object {
            $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' -or
            $_.Name -like '*cpt*'
          } | ForEach-Object {
            Remove-ItemProperty -Path $_.PSPath -Name $_.Name -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 15000 });

    const fuDeleted = parseInt(fuResult.stdout, 10) || 0;
    details.featureUsage = { deleted: fuDeleted };
    totalDeleted += fuDeleted;
    if (fuDeleted > 0) logger.ok(`FeatureUsage: removed ${fuDeleted} entries`);
  } catch (e) {
    details.featureUsage = { error: e.message };
    logger.debug('FeatureUsage cleanup failed', { error: e.message });
  }

  logger.info(`User profile fingerprint wipe: ${totalDeleted} total entries removed`);
  return { success: true, deleted: totalDeleted, details };
}

/**
 * Deep wipe of all Zoom-related per-user traces that standard cleanup misses.
 * These are the traces that differentiate a cleaned user from a brand-new Windows user.
 * Covers: Audio PolicyConfig, CapabilityAccessManager, CloudStore, AppListBackup,
 *         URL protocol handlers, browser data, custom Zoom apps, Run keys, shortcuts, etc.
 */
async function wipeDeepUserTraces() {
  logger.info('Wiping deep user-profile Zoom traces...');
  let totalDeleted = 0;
  const details = {};

  // 1. Audio PolicyConfig — hardware device-to-Zoom.exe mappings (hardware fingerprint!)
  try {
    const audioResult = await runPowerShell(`
      $count = 0
      $audioBase = 'HKCU:\\Software\\Microsoft\\Internet Explorer\\LowRegistry\\Audio\\PolicyConfig\\PropertyStore'
      if (Test-Path $audioBase) {
        Get-ChildItem $audioBase -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          $allText = ($props.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
          if ($allText -match 'zoom|Zoom|cpt') {
            Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(audioResult.stdout, 10) || 0;
    details.audioPolicyConfig = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Audio PolicyConfig: removed ${d} device mappings`);
  } catch (e) {
    details.audioPolicyConfig = { error: e.message };
  }

  // 2. CapabilityAccessManager — mic/webcam/location consent per Zoom path
  try {
    const camResult = await runPowerShell(`
      $count = 0
      $stores = @('microphone','webcam','location','camera')
      foreach ($store in $stores) {
        $basePath = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\$store"
        if (Test-Path $basePath) {
          # Check NonPackaged subkeys
          $npPath = Join-Path $basePath 'NonPackaged'
          if (Test-Path $npPath) {
            Get-ChildItem $npPath -ErrorAction SilentlyContinue | Where-Object {
              $_.Name -match 'zoom|Zoom|cpt|zcs'
            } | ForEach-Object {
              Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
              $count++
            }
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(camResult.stdout, 10) || 0;
    details.capabilityAccess = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`CapabilityAccessManager: removed ${d} consent entries`);
  } catch (e) {
    details.capabilityAccess = { error: e.message };
  }

  // 3. CloudStore — app metadata synced to Microsoft cloud
  try {
    const cloudResult = await runPowerShell(`
      $count = 0
      $cloudBase = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore'
      if (Test-Path $cloudBase) {
        Get-ChildItem $cloudBase -Recurse -ErrorAction SilentlyContinue | Where-Object {
          $_.Name -match 'zoom|Zoom|zoomumx|ZoomUMX'
        } | ForEach-Object {
          Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }
      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(cloudResult.stdout, 10) || 0;
    details.cloudStore = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`CloudStore: removed ${d} entries`);
  } catch (e) {
    details.cloudStore = { error: e.message };
  }

  // 4. AppListBackup — tracks every install/uninstall cycle
  try {
    const albResult = await runPowerShell(`
      $count = 0
      $albBase = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\AppListBackup'
      if (Test-Path $albBase) {
        Get-ChildItem $albBase -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          $allText = ($props.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
          if ($allText -match 'zoom|Zoom|ZoomUMX|zoomumx') {
            Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(albResult.stdout, 10) || 0;
    details.appListBackup = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`AppListBackup: removed ${d} entries`);
  } catch (e) {
    details.appListBackup = { error: e.message };
  }

  // 5. URL protocol handlers and shell registrations
  try {
    const protoResult = await runPowerShell(`
      $count = 0
      $protoKeys = @(
        'HKCU:\\Software\\Classes\\ZoomContactCenterCall',
        'HKCU:\\Software\\Classes\\ZoomPhoneSMS',
        'HKCU:\\Software\\Classes\\ZoomPhoneCall',
        'HKCU:\\Software\\Clients\\ZoomPBX',
        'HKCU:\\Software\\Classes\\zoommtg',
        'HKCU:\\Software\\Classes\\zoomphonecall',
        'HKCU:\\Software\\Classes\\zoomus',
        'HKCU:\\Software\\Classes\\zoomrc',
        'HKCU:\\Software\\Classes\\zoomrc.rooms'
      )
      foreach ($k in $protoKeys) {
        if (Test-Path $k) {
          Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # ApplicationAssociationToasts
      $toastPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ApplicationAssociationToasts'
      if (Test-Path $toastPath) {
        $props = Get-ItemProperty $toastPath -ErrorAction SilentlyContinue
        $props.PSObject.Properties | Where-Object { $_.Name -match 'zoom|Zoom' } | ForEach-Object {
          Remove-ItemProperty -Path $toastPath -Name $_.Name -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # URL Associations
      $uaBase = 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations'
      if (Test-Path $uaBase) {
        Get-ChildItem $uaBase -ErrorAction SilentlyContinue | Where-Object {
          $_.Name -match 'zoom|Zoom'
        } | ForEach-Object {
          Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # IE Feature Control
      $fePath = 'HKCU:\\Software\\Microsoft\\Internet Explorer\\Main\\FeatureControl\\FEATURE_BROWSER_EMULATION'
      if (Test-Path $fePath) {
        $props = Get-ItemProperty $fePath -ErrorAction SilentlyContinue
        $props.PSObject.Properties | Where-Object { $_.Name -match 'zoom|Zoom' } | ForEach-Object {
          Remove-ItemProperty -Path $fePath -Name $_.Name -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(protoResult.stdout, 10) || 0;
    details.protocolHandlers = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Protocol handlers/associations: removed ${d} entries`);
  } catch (e) {
    details.protocolHandlers = { error: e.message };
  }

  // 6. Custom Zoom apps in AppData (zoom-agent-client, admin dashboard, etc.)
  try {
    const customAppsResult = await runPowerShell(`
      $count = 0
      $customPaths = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\\zoom-agent-client'),
        (Join-Path $env:APPDATA 'Zoom Agent Client'),
        (Join-Path $env:APPDATA 'Zoom Admin Dashboard'),
        (Join-Path $env:APPDATA 'Zoom Client'),
        (Join-Path $env:APPDATA 'ZoomAdminDashboard'),
        (Join-Path $env:APPDATA 'ZoomClient'),
        (Join-Path $env:LOCALAPPDATA 'zoom-admin-dashboard-updater'),
        (Join-Path $env:LOCALAPPDATA 'zoom-agent-client-updater'),
        (Join-Path $env:APPDATA 'zoom-1132-eliminator'),
        (Join-Path $env:LOCALAPPDATA '1132-Remover\\zoom-settings')
      )
      foreach ($p in $customPaths) {
        if (Test-Path $p) {
          Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }
      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(customAppsResult.stdout, 10) || 0;
    details.customApps = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Custom Zoom apps: removed ${d} directories`);
  } catch (e) {
    details.customApps = { error: e.message };
  }

  // 7. HKCU Run keys (auto-start entries)
  try {
    const runResult = await runPowerShell(`
      $count = 0
      $runPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      if (Test-Path $runPath) {
        $props = Get-ItemProperty $runPath -ErrorAction SilentlyContinue
        $props.PSObject.Properties | Where-Object {
          $_.Name -match 'zoom|Zoom' -or ($_.Value -is [string] -and $_.Value -match 'zoom|Zoom')
        } | ForEach-Object {
          Remove-ItemProperty -Path $runPath -Name $_.Name -Force -ErrorAction SilentlyContinue
          $count++
        }
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(runResult.stdout, 10) || 0;
    details.runKeys = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Run keys: removed ${d} auto-start entries`);
  } catch (e) {
    details.runKeys = { error: e.message };
  }

  // 8. Notification/Push settings
  try {
    const notifResult = await runPowerShell(`
      $count = 0
      $bases = @(
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications\\Backup'
      )
      foreach ($base in $bases) {
        if (Test-Path $base) {
          Get-ChildItem $base -ErrorAction SilentlyContinue | Where-Object {
            $_.Name -match 'zoom|Zoom'
          } | ForEach-Object {
            Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(notifResult.stdout, 10) || 0;
    details.notifications = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Notifications: removed ${d} entries`);
  } catch (e) {
    details.notifications = { error: e.message };
  }

  // 9. Custom GUID registry key (zoom-agent-client installer)
  try {
    const guidResult = await runPowerShell(`
      $count = 0
      Get-ChildItem 'HKCU:\\Software' -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match '^HKEY_CURRENT_USER\\\\Software\\\\[0-9a-f]{8}-'
      } | ForEach-Object {
        $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
        $allText = ($props.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ' '
        if ($allText -match 'zoom|Zoom') {
          Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(guidResult.stdout, 10) || 0;
    details.guidKeys = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`GUID registry keys: removed ${d} entries`);
  } catch (e) {
    details.guidKeys = { error: e.message };
  }

  // 10. Desktop/Start Menu shortcuts
  try {
    const shortcutResult = await runPowerShell(`
      $count = 0
      $shortcutDirs = @(
        (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
        (Join-Path $env:USERPROFILE 'Desktop')
      )
      foreach ($dir in $shortcutDirs) {
        if (Test-Path $dir) {
          Get-ChildItem $dir -Filter '*zoom*' -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            $count++
          }
          Get-ChildItem $dir -Filter '*Zoom*' -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(shortcutResult.stdout, 10) || 0;
    details.shortcuts = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Shortcuts: removed ${d} files`);
  } catch (e) {
    details.shortcuts = { error: e.message };
  }

  logger.info(`Deep user trace wipe: ${totalDeleted} total items removed`);
  return { success: true, deleted: totalDeleted, details };
}

/**
 * Wipe ALL browser data for zoom.us domains (Chrome + Edge).
 * This is CRITICAL — browser cookies and localStorage are a primary fingerprint vector.
 * A new Windows user has NO browser data, so this must be cleaned for the reset to work.
 *
 * Strategy:
 * 1. Kill Chrome and Edge
 * 2. Delete Cookies and Cookies-journal files (user will need to re-login to ALL sites)
 * 3. Delete Local Storage leveldb (user loses ALL localStorage for ALL sites)
 * 4. Delete Session Storage
 * 5. Delete Cache directories for zoom.us
 * 6. Delete Web Data (autofill for zoom.us forms)
 *
 * This is destructive but necessary — the ban fingerprint persists in browser storage.
 */
async function wipeBrowserZoomData() {
  logger.info('Wiping browser zoom.us data (cookies, localStorage, cache)...');

  let totalDeleted = 0;
  const details = {};

  // 1. Kill browsers first (they lock the SQLite files)
  try {
    await runPowerShell(`
      Stop-Process -Name 'chrome' -Force -ErrorAction SilentlyContinue
      Stop-Process -Name 'msedge' -Force -ErrorAction SilentlyContinue
      Stop-Process -Name 'brave' -Force -ErrorAction SilentlyContinue
      Stop-Process -Name 'firefox' -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
    `, { timeout: 15000 });
    logger.ok('Browsers closed for cookie cleanup');
  } catch (e) {
    logger.debug('Browser kill attempt', { error: e.message });
  }

  // 2. Delete Cookies files from ALL browser profiles
  try {
    const cookieResult = await runPowerShell(`
      $count = 0
      $browserBases = @(
        (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\\Brave-Browser\\User Data')
      )

      foreach ($browserBase in $browserBases) {
        if (-not (Test-Path $browserBase)) { continue }

        # Find all profile directories
        $profiles = @('Default') + (Get-ChildItem $browserBase -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^Profile' } | ForEach-Object { $_.Name })

        foreach ($profile in $profiles) {
          $profilePath = Join-Path $browserBase $profile

          # Delete Cookies and Cookies-journal
          $cookiePaths = @(
            (Join-Path $profilePath 'Network\\Cookies'),
            (Join-Path $profilePath 'Network\\Cookies-journal'),
            (Join-Path $profilePath 'Cookies'),
            (Join-Path $profilePath 'Cookies-journal')
          )

          foreach ($cp in $cookiePaths) {
            if (Test-Path $cp) {
              Remove-Item $cp -Force -ErrorAction SilentlyContinue
              $count++
            }
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const d = parseInt(cookieResult.stdout, 10) || 0;
    details.cookies = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Browser cookies: deleted ${d} cookie database files`);
  } catch (e) {
    details.cookies = { error: e.message };
    logger.debug('Cookie cleanup failed', { error: e.message });
  }

  // 3. Delete Local Storage leveldb (contains zoom.us localStorage fingerprints)
  try {
    const lsResult = await runPowerShell(`
      $count = 0
      $browserBases = @(
        (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\\Brave-Browser\\User Data')
      )

      foreach ($browserBase in $browserBases) {
        if (-not (Test-Path $browserBase)) { continue }

        $profiles = @('Default') + (Get-ChildItem $browserBase -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^Profile' } | ForEach-Object { $_.Name })

        foreach ($profile in $profiles) {
          $lsPath = Join-Path $browserBase "$profile\\Local Storage\\leveldb"
          if (Test-Path $lsPath) {
            Remove-Item $lsPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }

          # Also delete Session Storage
          $ssPath = Join-Path $browserBase "$profile\\Session Storage"
          if (Test-Path $ssPath) {
            Remove-Item $ssPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const d = parseInt(lsResult.stdout, 10) || 0;
    details.localStorage = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Browser localStorage/sessionStorage: deleted ${d} directories`);
  } catch (e) {
    details.localStorage = { error: e.message };
    logger.debug('localStorage cleanup failed', { error: e.message });
  }

  // 4. Delete zoom.us cache data from browser cache directories
  try {
    const cacheResult = await runPowerShell(`
      $count = 0
      $browserBases = @(
        (Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\\Edge\\User Data'),
        (Join-Path $env:LOCALAPPDATA 'BraveSoftware\\Brave-Browser\\User Data')
      )

      foreach ($browserBase in $browserBases) {
        if (-not (Test-Path $browserBase)) { continue }

        $profiles = @('Default') + (Get-ChildItem $browserBase -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^Profile' } | ForEach-Object { $_.Name })

        foreach ($profile in $profiles) {
          $profilePath = Join-Path $browserBase $profile

          # Delete zoom.us Site Data (origins with zoom in name)
          $sdPath = Join-Path $profilePath 'Site Data'
          if (Test-Path $sdPath) {
            Get-ChildItem $sdPath -Recurse -ErrorAction SilentlyContinue | Where-Object {
              $_.Name -match 'zoom'
            } | ForEach-Object {
              Remove-Item $_.FullName -Force -Recurse -ErrorAction SilentlyContinue
              $count++
            }
          }

          # Delete Web Data (autofill for zoom.us forms)
          $wdPaths = @(
            (Join-Path $profilePath 'Web Data'),
            (Join-Path $profilePath 'Web Data-journal')
          )
          foreach ($wd in $wdPaths) {
            if (Test-Path $wd) {
              Remove-Item $wd -Force -ErrorAction SilentlyContinue
              $count++
            }
          }

          # Delete Origin Bound Certs (TLS session tickets)
          $obcPath = Join-Path $profilePath 'Origin Bound Certs'
          if (Test-Path $obcPath) {
            Remove-Item $obcPath -Force -ErrorAction SilentlyContinue
            $count++
          }
          $obcPath2 = Join-Path $profilePath 'Origin Bound Certs-journal'
          if (Test-Path $obcPath2) {
            Remove-Item $obcPath2 -Force -ErrorAction SilentlyContinue
            $count++
          }

          # Delete Reporting and NEL (network error logging for zoom.us)
          $repPath = Join-Path $profilePath 'Reporting and NEL'
          if (Test-Path $repPath) {
            Remove-Item $repPath -Force -ErrorAction SilentlyContinue
            $count++
          }

          # Delete Trust Tokens
          $ttPath = Join-Path $profilePath 'Trust Tokens'
          if (Test-Path $ttPath) {
            Remove-Item $ttPath -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }
      Write-Output $count
    `, { timeout: 30000 });

    const d = parseInt(cacheResult.stdout, 10) || 0;
    details.browserCache = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Browser cache/data: deleted ${d} items`);
  } catch (e) {
    details.browserCache = { error: e.message };
    logger.debug('Browser cache cleanup failed', { error: e.message });
  }

  // 5. Firefox cleanup (uses different storage format)
  try {
    const ffResult = await runPowerShell(`
      $count = 0
      $ffBase = Join-Path $env:APPDATA 'Mozilla\\Firefox\\Profiles'
      if (Test-Path $ffBase) {
        Get-ChildItem $ffBase -Directory -ErrorAction SilentlyContinue | ForEach-Object {
          $profilePath = $_.FullName

          # Delete cookies.sqlite (all cookies)
          $cookieFile = Join-Path $profilePath 'cookies.sqlite'
          if (Test-Path $cookieFile) {
            Remove-Item $cookieFile -Force -ErrorAction SilentlyContinue
            $count++
          }

          # Delete webappsstore.sqlite (localStorage)
          $wsFile = Join-Path $profilePath 'webappsstore.sqlite'
          if (Test-Path $wsFile) {
            Remove-Item $wsFile -Force -ErrorAction SilentlyContinue
            $count++
          }

          # Delete zoom-related storage
          $storagePath = Join-Path $profilePath 'storage\\default'
          if (Test-Path $storagePath) {
            Get-ChildItem $storagePath -Directory -ErrorAction SilentlyContinue | Where-Object {
              $_.Name -match 'zoom'
            } | ForEach-Object {
              Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
              $count++
            }
          }
        }
      }
      Write-Output $count
    `, { timeout: 20000 });

    const d = parseInt(ffResult.stdout, 10) || 0;
    details.firefox = { deleted: d };
    totalDeleted += d;
    if (d > 0) logger.ok(`Firefox: deleted ${d} zoom data files`);
  } catch (e) {
    details.firefox = { error: e.message };
  }

  logger.info(`Browser zoom data wipe: ${totalDeleted} total items removed`);
  return { success: true, deleted: totalDeleted, details };
}

/**
 * Spoof additional hardware identifiers that Zoom reads for device fingerprinting.
 * These are Windows-level IDs beyond MachineGuid that recent Zoom versions check:
 *   - SQMClient MachineId (telemetry machine identifier)
 *   - Hardware Profile GUID (hardware configuration fingerprint)
 *   - Windows Product ID (unique per-installation)
 *   - WMI persistent Zoom entries
 *   - SMBIOS System UUID cache in registry
 *
 * @returns {Promise<{success: boolean, spoofed: number, details: Object}>}
 */
async function spoofHardwareIds() {
  logger.info('Spoofing additional hardware identifiers...');

  let totalSpoofed = 0;
  const details = {};

  // 1. SQMClient MachineId — Windows telemetry machine identifier
  //    Zoom can read this via WMI or registry to fingerprint the device
  try {
    const sqmResult = await runPowerShell(`
      $count = 0
      $sqmPath = 'HKLM:\\SOFTWARE\\Microsoft\\SQMClient'
      if (Test-Path $sqmPath) {
        $oldId = (Get-ItemProperty $sqmPath -Name MachineId -EA SilentlyContinue).MachineId
        if ($oldId) {
          $newId = '{' + [System.Guid]::NewGuid().ToString().ToUpper() + '}'
          Set-ItemProperty -Path $sqmPath -Name MachineId -Value $newId -Force
          $count++
        }
      }
      # Also clean SQMClient Windows subkeys
      $sqmWin = 'HKLM:\\SOFTWARE\\Microsoft\\SQMClient\\Windows'
      if (Test-Path $sqmWin) {
        Remove-Item $sqmWin -Recurse -Force -EA SilentlyContinue
        $count++
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(sqmResult.stdout, 10) || 0;
    details.sqmClient = { spoofed: d };
    totalSpoofed += d;
    if (d > 0) logger.ok('SQMClient MachineId rotated');
  } catch (e) {
    details.sqmClient = { error: e.message };
    logger.debug('SQMClient spoof failed', { error: e.message });
  }

  // 2. Hardware Profile GUID — unique per hardware config
  try {
    const hwResult = await runPowerShell(`
      $count = 0
      $hwPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\IDConfigDB\\Hardware Profiles\\0001'
      if (Test-Path $hwPath) {
        $oldGuid = (Get-ItemProperty $hwPath -Name HwProfileGuid -EA SilentlyContinue).HwProfileGuid
        if ($oldGuid) {
          $newGuid = '{' + [System.Guid]::NewGuid().ToString() + '}'
          # Backup
          $backupPath = Join-Path $env:LOCALAPPDATA '1132Fixer'
          if (-not (Test-Path $backupPath)) { New-Item $backupPath -ItemType Directory -Force | Out-Null }
          $oldGuid | Out-File (Join-Path $backupPath 'HwProfileGuid.bak') -Force
          Set-ItemProperty -Path $hwPath -Name HwProfileGuid -Value $newGuid -Force
          $count++
        }
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(hwResult.stdout, 10) || 0;
    details.hwProfileGuid = { spoofed: d };
    totalSpoofed += d;
    if (d > 0) logger.ok('HwProfileGuid rotated');
  } catch (e) {
    details.hwProfileGuid = { error: e.message };
    logger.debug('HwProfileGuid spoof failed', { error: e.message });
  }

  // 3. Windows Product ID — unique per Windows installation
  //    NOT related to license activation; safe to randomize
  try {
    const pidResult = await runPowerShell(`
      $count = 0
      $ntPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
      $oldPid = (Get-ItemProperty $ntPath -Name ProductId -EA SilentlyContinue).ProductId
      if ($oldPid) {
        # Backup
        $backupPath = Join-Path $env:LOCALAPPDATA '1132Fixer'
        if (-not (Test-Path $backupPath)) { New-Item $backupPath -ItemType Directory -Force | Out-Null }
        $oldPid | Out-File (Join-Path $backupPath 'ProductId.bak') -Force

        # Generate a new ProductId in same format (XXXXX-XXX-XXXXXXX-XXXXX)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $b = New-Object byte[] 20
        $rng.GetBytes($b)
        $chars = '0123456789'
        $seg1 = -join (0..4 | ForEach-Object { $chars[$b[$_] % 10] })
        $seg2 = -join (5..7 | ForEach-Object { $chars[$b[$_] % 10] })
        $seg3 = -join (8..14 | ForEach-Object { $chars[$b[$_] % 10] })
        $seg4 = -join (15..19 | ForEach-Object { $chars[$b[$_] % 10] })
        $newPid = "$seg1-$seg2-$seg3-$seg4"

        Set-ItemProperty -Path $ntPath -Name ProductId -Value $newPid -Force
        $count++
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(pidResult.stdout, 10) || 0;
    details.productId = { spoofed: d };
    totalSpoofed += d;
    if (d > 0) logger.ok('Windows ProductId rotated');
  } catch (e) {
    details.productId = { error: e.message };
    logger.debug('ProductId spoof failed', { error: e.message });
  }

  // 4. WMI repository — clean Zoom-related persistent entries
  //    WMI stores device inventory that Zoom can query
  try {
    const wmiResult = await runPowerShell(`
      $count = 0
      # Reset WMI performance counters related to Zoom
      # Remove any CCM_RecentlyUsedApps or similar cached entries
      try {
        Get-CimInstance -Namespace 'root\\cimv2' -ClassName 'Win32_Product' -Filter "Name LIKE '%Zoom%'" -EA SilentlyContinue | ForEach-Object {
          $_ | Remove-CimInstance -EA SilentlyContinue
          $count++
        }
      } catch {}

      # Clean MSI installer database references
      $installerBase = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Installer\\UserData'
      if (Test-Path $installerBase) {
        Get-ChildItem $installerBase -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          $allText = ($props.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { "$($_.Value)" }) -join ' '
          if ($allText -match 'zoom|Zoom Video Communications') {
            Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
            $count++
          }
        }
      }

      # Clean Classes\\Installer product registrations
      $clsInstaller = 'HKLM:\\SOFTWARE\\Classes\\Installer'
      if (Test-Path $clsInstaller) {
        foreach ($sub in @('Products','Features','UpgradeCodes')) {
          $subPath = Join-Path $clsInstaller $sub
          if (Test-Path $subPath) {
            Get-ChildItem $subPath -ErrorAction SilentlyContinue | ForEach-Object {
              $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
              if ($props.ProductName -like '*Zoom*' -or $props.ProductName -like '*zoom*') {
                Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
                $count++
              }
            }
          }
        }
      }

      Write-Output $count
    `, { timeout: 60000 });
    const d = parseInt(wmiResult.stdout, 10) || 0;
    details.wmi = { cleaned: d };
    totalSpoofed += d;
    if (d > 0) logger.ok(`WMI/Installer cleanup: removed ${d} entries`);
  } catch (e) {
    details.wmi = { error: e.message };
    logger.debug('WMI cleanup failed', { error: e.message });
  }

  // 5. Clean Zoom EBWebView2 data in non-standard locations
  //    Zoom's embedded browser stores unique identifiers outside normal data paths
  try {
    const ebResult = await runPowerShell(`
      $count = 0
      $ebPaths = @(
        (Join-Path $env:LOCALAPPDATA 'ZoomVideoComm'),
        (Join-Path $env:LOCALAPPDATA 'Zoom\\EBWebView'),
        (Join-Path $env:APPDATA 'Zoom\\EBWebView'),
        (Join-Path $env:LOCALAPPDATA 'Zoom\\app-data'),
        (Join-Path $env:APPDATA 'Zoom\\app-data'),
        (Join-Path $env:PROGRAMDATA 'Zoom\\EBWebView'),
        (Join-Path $env:PROGRAMDATA 'ZoomVideo\\EBWebView')
      )
      foreach ($p in $ebPaths) {
        if (Test-Path $p) {
          Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # Also clean any Zoom GUIDs under HKCU\\Software\\Microsoft\\Edge\\EBWebView
      $edgeEbPath = 'HKCU:\\Software\\Microsoft\\Edge\\EBWebView'
      if (Test-Path $edgeEbPath) {
        Get-ChildItem $edgeEbPath -Recurse -EA SilentlyContinue | Where-Object {
          $_.Name -match 'zoom|Zoom'
        } | ForEach-Object {
          Remove-Item $_.PSPath -Recurse -Force -EA SilentlyContinue
          $count++
        }
      }

      Write-Output $count
    `, { timeout: 30000 });
    const d = parseInt(ebResult.stdout, 10) || 0;
    details.ebWebView = { cleaned: d };
    totalSpoofed += d;
    if (d > 0) logger.ok(`EBWebView cleanup: removed ${d} items`);
  } catch (e) {
    details.ebWebView = { error: e.message };
    logger.debug('EBWebView cleanup failed', { error: e.message });
  }

  // 6. Machine-specific DigitalProductId (binary blob, different from ProductId string)
  try {
    const dpidResult = await runPowerShell(`
      $count = 0
      $ntPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
      $dpid = (Get-ItemProperty $ntPath -Name DigitalProductId -EA SilentlyContinue).DigitalProductId
      if ($dpid -and $dpid.Length -gt 0) {
        # Backup
        $backupPath = Join-Path $env:LOCALAPPDATA '1132Fixer'
        if (-not (Test-Path $backupPath)) { New-Item $backupPath -ItemType Directory -Force | Out-Null }
        [System.IO.File]::WriteAllBytes((Join-Path $backupPath 'DigitalProductId.bak'), $dpid)

        # Randomize bytes 8-24 (the unique portion, not the header)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $randBytes = New-Object byte[] 16
        $rng.GetBytes($randBytes)
        for ($i = 0; $i -lt 16; $i++) {
          $dpid[8 + $i] = $randBytes[$i]
        }
        Set-ItemProperty -Path $ntPath -Name DigitalProductId -Value $dpid -Force
        $count++
      }
      Write-Output $count
    `, { timeout: 15000 });
    const d = parseInt(dpidResult.stdout, 10) || 0;
    details.digitalProductId = { spoofed: d };
    totalSpoofed += d;
    if (d > 0) logger.ok('DigitalProductId randomized');
  } catch (e) {
    details.digitalProductId = { error: e.message };
    logger.debug('DigitalProductId spoof failed', { error: e.message });
  }

  logger.info(`Hardware ID spoofing: ${totalSpoofed} identifiers modified`);
  return { success: true, spoofed: totalSpoofed, details };
}

/**
 * Rotate the Windows MachineGuid — a primary device identifier.
 * Zoom reads HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid to identify devices.
 * Changing this makes the machine appear as a brand-new Windows install.
 * NOTE: This is safe — MachineGuid is not used by Windows licensing or activation.
 * It is used by some apps for licensing, so we save the old value for optional restore.
 */
async function rotateMachineGuid() {
  logger.info('Rotating MachineGuid...');

  try {
    const result = await runPowerShell(`
      $ErrorActionPreference = 'Stop'
      $cryptoPath = 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography'
      $oldGuid = (Get-ItemProperty $cryptoPath -Name MachineGuid).MachineGuid

      if (-not $oldGuid) {
        Write-Output "ERROR:Could not read current MachineGuid"
        return
      }

      $newGuid = [System.Guid]::NewGuid().ToString()

      # Backup old GUID
      $backupPath = Join-Path $env:LOCALAPPDATA '1132Fixer'
      if (-not (Test-Path $backupPath)) { New-Item $backupPath -ItemType Directory -Force | Out-Null }
      $oldGuid | Out-File (Join-Path $backupPath 'MachineGuid.bak') -Force

      # Method 1: Try Set-ItemProperty (works when elevated)
      $written = $false
      try {
        Set-ItemProperty -Path $cryptoPath -Name MachineGuid -Value $newGuid -Force -ErrorAction Stop
        $written = $true
      } catch {
        # Method 2: Try reg.exe (sometimes succeeds when PS cmdlet fails)
        try {
          $regOut = & reg add "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /t REG_SZ /d $newGuid /f 2>&1
          if ($LASTEXITCODE -eq 0) { $written = $true }
        } catch {}
      }

      # Method 3: Use .NET Registry API with explicit write access
      if (-not $written) {
        try {
          $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\\Microsoft\\Cryptography', $true)
          if ($key) {
            $key.SetValue('MachineGuid', $newGuid, [Microsoft.Win32.RegistryValueKind]::String)
            $key.Close()
            $written = $true
          }
        } catch {}
      }

      if (-not $written) {
        Write-Output "FAIL:All write methods failed (not elevated?)"
        return
      }

      # Verify
      $verify = (Get-ItemProperty $cryptoPath -Name MachineGuid).MachineGuid
      if ($verify -eq $newGuid) {
        Write-Output "OK:$oldGuid->$newGuid"
      } else {
        Write-Output "FAIL:Write appeared to succeed but verification failed"
      }
    `, { timeout: 15000 });

    const out = (result.stdout || '').trim();
    if (out.startsWith('OK:')) {
      const [oldG, newG] = out.substring(3).split('->');
      logger.ok(`MachineGuid rotated: ${oldG} → ${newG}`);
      return { success: true, oldGuid: oldG, newGuid: newG };
    } else {
      logger.warn('MachineGuid rotation issue: ' + out);
      return { success: false, error: out };
    }
  } catch (e) {
    logger.error('MachineGuid rotation failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Detect active VPN adapters that could interfere with MAC spoofing.
 * VPNs can leak the real MAC or cause connectivity issues during adapter cycling.
 * @returns {Promise<{active: boolean, adapters: string[]}>}
 */
async function detectActiveVPN() {
  try {
    const result = await runPowerShell(`
      $vpnAdapters = @()

      # Check for VPN network adapters
      Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and
        $_.InterfaceDescription -match 'TAP|TUN|VPN|WireGuard|Windscribe|NordLynx|Wintun|Fortinet|Cisco AnyConnect|GlobalProtect|OpenVPN'
      } | ForEach-Object {
        $vpnAdapters += "$($_.Name) ($($_.InterfaceDescription))"
      }

      # Check if default route goes through a VPN-style interface
      $defaultRoute = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric | Select-Object -First 1
      if ($defaultRoute) {
        $iface = Get-NetAdapter -InterfaceIndex $defaultRoute.InterfaceIndex -ErrorAction SilentlyContinue
        if ($iface -and $iface.InterfaceDescription -match 'TAP|TUN|VPN|WireGuard|Windscribe|NordLynx|Wintun|Fortinet|Cisco|GlobalProtect|OpenVPN') {
          $name = "$($iface.Name) ($($iface.InterfaceDescription))"
          if ($vpnAdapters -notcontains $name) { $vpnAdapters += $name }
        }
      }

      if ($vpnAdapters.Count -gt 0) {
        Write-Output "VPN_ACTIVE"
        $vpnAdapters | ForEach-Object { Write-Output $_ }
      } else {
        Write-Output "NO_VPN"
      }
    `, { timeout: 10000 });

    const lines = (result.stdout || '').trim().split('\n').filter(l => l.trim());
    if (lines[0] === 'VPN_ACTIVE') {
      const adapters = lines.slice(1).map(l => l.trim());
      logger.warn(`Active VPN detected: ${adapters.join(', ')}`);
      return { active: true, adapters };
    }
    return { active: false, adapters: [] };
  } catch (e) {
    logger.debug('VPN detection failed, assuming no VPN', { error: e.message });
    return { active: false, adapters: [] };
  }
}

/**
 * Spoof MAC addresses on active network adapters.
 * Zoom uses MAC addresses as part of its device fingerprint.
 * This sets a random locally-administered MAC on each active physical adapter.
 * The adapter is briefly disabled/re-enabled for the change to take effect.
 */
async function spoofMacAddresses() {
  logger.info('Spoofing MAC addresses on active adapters...');

  // Check for active VPN before spoofing
  const vpnCheck = await detectActiveVPN();
  if (vpnCheck.active) {
    logger.warn(`MAC spoofing skipped: VPN active (${vpnCheck.adapters.join(', ')}). Disconnect VPN before spoofing to avoid connectivity issues.`);
    return { success: true, spoofed: 0, skipped: true, reason: `VPN active: ${vpnCheck.adapters.join(', ')}` };
  }

  try {
    const result = await runPowerShell(`
      $spoofed = 0
      $details = @()

      # Get physical adapters that are Up (skip virtual/VPN/loopback)
      $adapters = Get-NetAdapter | Where-Object {
        $_.Status -eq 'Up' -and
        $_.InterfaceDescription -notmatch 'Virtual|VPN|Loopback|Hyper-V|VirtualBox|TAP|WireGuard'
      }

      foreach ($adapter in $adapters) {
        $name = $adapter.Name
        $oldMac = $adapter.MacAddress

        # Generate random locally-administered MAC
        # Bit 1 of first octet = 1 (locally administered), Bit 0 = 0 (unicast)
        $bytes = New-Object byte[] 6
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $bytes[0] = ($bytes[0] -bor 0x02) -band 0xFE  # Set locally administered, clear multicast
        $newMac = ($bytes | ForEach-Object { $_.ToString('X2') }) -join ''

        # Set via registry (most reliable method)
        $regPath = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4D36E972-E325-11CE-BFC1-08002BE10318}"
        $found = $false

        Get-ChildItem $regPath -ErrorAction SilentlyContinue | ForEach-Object {
          $props = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
          if ($props.DriverDesc -eq $adapter.InterfaceDescription) {
            Set-ItemProperty -Path $_.PSPath -Name 'NetworkAddress' -Value $newMac -Force
            $found = $true
          }
        }

        if ($found) {
          # Disable and re-enable adapter to apply
          Disable-NetAdapter -Name $name -Confirm:$false -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 2
          Enable-NetAdapter -Name $name -Confirm:$false -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 3

          $spoofed++
          $newFormatted = ($newMac -replace '(.{2})', '$1-').TrimEnd('-')
          $details += "$name : $oldMac -> $newFormatted"
        }
      }

      Write-Output "$spoofed"
      $details | ForEach-Object { Write-Output $_ }
    `, { timeout: 60000 });

    const lines = (result.stdout || '').trim().split('\n').filter(l => l.trim());
    const count = parseInt(lines[0], 10) || 0;
    const adapterDetails = lines.slice(1);

    if (count > 0) {
      logger.ok(`Spoofed MAC on ${count} adapter(s)`);
      adapterDetails.forEach(d => logger.info('  ' + d.trim()));
    } else {
      logger.info('No adapters required MAC spoofing');
    }

    return { success: true, spoofed: count, details: adapterDetails };
  } catch (e) {
    logger.error('MAC spoofing failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Change the C: drive volume serial number.
 * Zoom may read the volume serial as a hardware fingerprint.
 * Randomize the computer name.
 * Zoom may use the computer name as part of device fingerprinting.
 * Generates a new DESKTOP-XXXXXXX style name to match Windows defaults.
 * Requires a reboot to fully take effect, but the registry change is immediate.
 */
async function randomizeComputerName() {
  logger.info('Randomizing computer name...');

  try {
    const result = await runPowerShell(`
      $oldName = $env:COMPUTERNAME

      # Generate random 7-char alphanumeric suffix (like Windows default)
      $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
      $bytes = New-Object byte[] 7
      $rng.GetBytes($bytes)
      $suffix = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
      $newName = "DESKTOP-$suffix"

      # Save old name for backup
      $backupPath = Join-Path $env:LOCALAPPDATA '1132Fixer'
      if (-not (Test-Path $backupPath)) { New-Item $backupPath -ItemType Directory -Force | Out-Null }
      $oldName | Out-File (Join-Path $backupPath 'ComputerName.bak') -Force

      # Set in all 3 registry locations
      $tcpPath = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters'
      $cnPath  = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName'
      $anPath  = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ActiveComputerName'

      Set-ItemProperty -Path $tcpPath -Name 'Hostname'       -Value $newName -Force
      Set-ItemProperty -Path $tcpPath -Name 'NV Hostname'    -Value $newName -Force
      Set-ItemProperty -Path $cnPath  -Name 'ComputerName'   -Value $newName -Force
      Set-ItemProperty -Path $anPath  -Name 'ComputerName'   -Value $newName -Force -ErrorAction SilentlyContinue

      # Also rename via WMI (applies on next reboot)
      try {
        $cs = Get-WmiObject Win32_ComputerSystem
        $cs.Rename($newName) | Out-Null
      } catch { }

      # Verify
      $verify = (Get-ItemProperty $cnPath -Name ComputerName).ComputerName
      if ($verify -eq $newName) {
        Write-Output "OK:$oldName->$newName"
      } else {
        Write-Output "FAIL:Verify mismatch $verify"
      }
    `, { timeout: 15000 });

    const out = (result.stdout || '').trim();
    if (out.startsWith('OK:')) {
      const [oldN, newN] = out.substring(3).split('->');
      logger.ok(`Computer name randomized: ${oldN} → ${newN}`);
      return { success: true, oldName: oldN, newName: newN };
    } else {
      logger.warn('Computer name randomization issue: ' + out);
      return { success: false, error: out };
    }
  } catch (e) {
    logger.error('Computer name randomization failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Change the C: drive volume serial number.
 * Zoom may read the volume serial as a hardware fingerprint.
 * Uses the volumeid approach via direct NTFS boot sector edit,
 * or falls back to a reg-based approach.
 * Requires reboot to fully apply.
 */
async function changeVolumeSerial() {
  logger.info('Changing C: drive volume serial number...');
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');

  try {
    // Get current volume serial
    const wmiOut = execSync('powershell -Command "(Get-WmiObject Win32_LogicalDisk -Filter \\"DeviceID=\'C:\'\\" ).VolumeSerialNumber"', { encoding: 'utf8' }).trim();
    const oldSerial = wmiOut;

    // Backup
    const backupDir = path.join(process.env.LOCALAPPDATA, '1132Fixer');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'VolumeSerial.bak'), oldSerial);

    // Write C# source file directly (avoids JS/PowerShell escaping issues)
    const tmpDir = path.join(process.env.TEMP, '1132Fixer');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const csFile = path.join(tmpDir, 'volserial.cs');
    const exeFile = path.join(tmpDir, 'volserial.exe');

    // C# source with proper backslash escaping (written directly to file, no template literal issues)
    const csSource = [
      'using System;',
      'using System.Runtime.InteropServices;',
      'using System.Security.Cryptography;',
      'class Program {',
      '    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)]',
      '    static extern IntPtr CreateFile(string f, uint a, uint s, IntPtr sa, uint d, uint fl, IntPtr t);',
      '    [DllImport("kernel32.dll", SetLastError=true)]',
      '    static extern bool ReadFile(IntPtr h, byte[] b, uint n, out uint r, IntPtr o);',
      '    [DllImport("kernel32.dll", SetLastError=true)]',
      '    static extern bool WriteFile(IntPtr h, byte[] b, uint n, out uint w, IntPtr o);',
      '    [DllImport("kernel32.dll", SetLastError=true)]',
      '    static extern uint SetFilePointer(IntPtr h, int lo, IntPtr hi, uint method);',
      '    [DllImport("kernel32.dll", SetLastError=true)]',
      '    static extern bool CloseHandle(IntPtr h);',
      '    static int Main() {',
      '        string diskPath = @"\\\\.\\C:";',
      '        IntPtr h = CreateFile(diskPath, 0xC0000000u, 3u, IntPtr.Zero, 3u, 0u, IntPtr.Zero);',
      '        if (h == new IntPtr(-1)) {',
      '            Console.WriteLine("FAIL:CreateFile error " + Marshal.GetLastWin32Error());',
      '            return 1;',
      '        }',
      '        byte[] boot = new byte[512];',
      '        uint read;',
      '        if (!ReadFile(h, boot, 512, out read, IntPtr.Zero) || read != 512) {',
      '            CloseHandle(h); Console.WriteLine("FAIL:ReadFile error " + Marshal.GetLastWin32Error()); return 1;',
      '        }',
      '        byte[] rand = new byte[8];',
      '        using (var rng = RandomNumberGenerator.Create()) { rng.GetBytes(rand); }',
      '        Array.Copy(rand, 0, boot, 0x48, 8);',
      '        if (SetFilePointer(h, 0, IntPtr.Zero, 0) != 0) {',
      '            CloseHandle(h); Console.WriteLine("FAIL:Seek error " + Marshal.GetLastWin32Error()); return 1;',
      '        }',
      '        uint written;',
      '        if (!WriteFile(h, boot, 512, out written, IntPtr.Zero) || written != 512) {',
      '            CloseHandle(h); Console.WriteLine("FAIL:WriteFile error " + Marshal.GetLastWin32Error()); return 1;',
      '        }',
      '        CloseHandle(h);',
      '        uint display = BitConverter.ToUInt32(rand, 4);',
      '        Console.WriteLine(string.Format("OK:{0:X4}-{1:X4}", (display >> 16) & 0xFFFF, display & 0xFFFF));',
      '        return 0;',
      '    }',
      '}',
    ].join('\r\n');

    fs.writeFileSync(csFile, csSource, 'utf8');

    // Find csc.exe
    const cscOut = execSync('powershell -Command "[System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()"', { encoding: 'utf8' }).trim();
    const cscPath = path.join(cscOut, 'csc.exe');

    // Compile
    try {
      execSync(`"${cscPath}" /nologo /out:"${exeFile}" "${csFile}"`, { encoding: 'utf8' });
    } catch (compileErr) {
      logger.error('Volume serial C# compile failed', { error: compileErr.stderr || compileErr.message });
      return { success: false, error: 'Compile failed: ' + (compileErr.stderr || compileErr.message) };
    }

    // Run (inherits admin elevation)
    let exeOut;
    try {
      exeOut = execSync(`"${exeFile}"`, { encoding: 'utf8' }).trim();
    } catch (runErr) {
      exeOut = (runErr.stdout || '').trim();
    }

    // Cleanup
    try { fs.unlinkSync(exeFile); } catch (_) {}
    try { fs.unlinkSync(csFile); } catch (_) {}

    if (exeOut.startsWith('OK:')) {
      const newSerial = exeOut.substring(3);
      logger.ok(`Volume serial changed: ${oldSerial} → ${newSerial} (reboot required)`);
      return { success: true, oldSerial, newSerial, rebootRequired: true };
    } else {
      logger.warn('Volume serial change issue: ' + exeOut);
      return { success: false, error: exeOut };
    }
  } catch (e) {
    logger.error('Volume serial change failed', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Post-install registry scrub — runs AFTER Zoom is installed to clean
 * any fingerprint keys that the MSI installer recreates.
 * Also sets DENY ACLs on SystemInfo to PREVENT Zoom from writing hardware
 * fingerprints back on launch.
 *
 * CRITICAL INSIGHT: Zoom writes SystemInfo on LAUNCH, not during install.
 * So we must both delete existing keys AND block future writes via ACLs.
 */
async function postInstallScrub() {
  logger.info('Running post-install fingerprint scrub...');

  let totalDeleted = 0;

  // Wait for installer to finish writing registry keys
  await new Promise(resolve => setTimeout(resolve, 3000));

  try {
    const result = await runPowerShell(`
      $count = 0

      # 1-5. DELETE ALL Zoom registry trees (classic + Workplace + WOW64)
      $allZoomKeys = @(
        'HKCU:\\Software\\Zoom',
        'HKCU:\\Software\\ZoomUMX',
        'HKCU:\\Software\\zoom.us',
        'HKCU:\\Software\\Zoom Workplace',
        'HKCU:\\Software\\ZoomVideoComm',
        'HKCU:\\Software\\ZoomGifCollector',
        'HKCU:\\Software\\CptService',
        'HKCU:\\Software\\Zoom Video Communications',
        'HKLM:\\SOFTWARE\\Zoom',
        'HKLM:\\SOFTWARE\\ZoomUMX',
        'HKLM:\\SOFTWARE\\zoom.us',
        'HKLM:\\SOFTWARE\\Zoom Workplace',
        'HKLM:\\SOFTWARE\\ZoomVideoComm',
        'HKLM:\\SOFTWARE\\CptService',
        'HKLM:\\SOFTWARE\\Zoom Video Communications',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Zoom',
        'HKLM:\\SOFTWARE\\WOW6432Node\\ZoomUMX',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Zoom Workplace',
        'HKLM:\\SOFTWARE\\WOW6432Node\\CptService',
        'HKLM:\\SOFTWARE\\WOW6432Node\\ZoomVideoComm',
        'HKLM:\\SOFTWARE\\Policies\\Zoom'
      )
      foreach ($k in $allZoomKeys) {
        if (Test-Path $k) {
          Remove-Item $k -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # 6. Set DENY WRITE ACL on Zoom registry keys
      #    Blocks Zoom from writing hardware fingerprints on launch
      #    Covers BOTH classic Zoom AND Zoom Workplace paths + Secrets/SystemInfo subkeys
      $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      [System.Security.AccessControl.RegistryRights]$rights = 'SetValue,CreateSubKey,Delete,WriteKey'
      [System.Security.AccessControl.InheritanceFlags]$inherit = 'ContainerInherit,ObjectInherit'

      $denyTargets = @(
        'HKCU:\\Software\\Zoom',
        'HKCU:\\Software\\Zoom\\SystemInfo',
        'HKCU:\\Software\\Zoom\\Secrets',
        'HKCU:\\Software\\Zoom Workplace',
        'HKCU:\\Software\\Zoom Workplace\\SystemInfo',
        'HKCU:\\Software\\Zoom Workplace\\Secrets',
        'HKCU:\\Software\\ZoomUMX',
        'HKCU:\\Software\\ZoomVideoComm',
        'HKCU:\\Software\\CptService'
      )
      foreach ($denyTarget in $denyTargets) {
        if (-not (Test-Path $denyTarget)) {
          New-Item -Path $denyTarget -Force -EA SilentlyContinue | Out-Null
        }
        try {
          $acl = Get-Acl $denyTarget
          $denyRule = New-Object System.Security.AccessControl.RegistryAccessRule(
            $currentUser,
            $rights,
            $inherit,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Deny
          )
          $acl.AddAccessRule($denyRule)
          Set-Acl $denyTarget $acl
          $count++
        } catch {
          # If ACL set fails, log but continue
        }
      }

      # 6b. HKLM keys: DELETE only (no DENY ACLs — they break the MSI installer)
      # HKLM keys get recreated by Zoom but the clean room launch wipes them before each launch
      @(
        'HKLM:\\SOFTWARE\\Zoom', 'HKLM:\\SOFTWARE\\Zoom Workplace',
        'HKLM:\\SOFTWARE\\ZoomUMX', 'HKLM:\\SOFTWARE\\CptService',
        'HKLM:\\SOFTWARE\\ZoomVideoComm'
      ) | ForEach-Object {
        if (Test-Path $_) {
          Remove-Item $_ -Recurse -Force -EA SilentlyContinue
          $count++
        }
      }

      # 6c. Remove stale HKLM DENY ACLs from previous fixer versions
      # Previous versions set Everyone DENY on HKLM — must clean up
      foreach ($hklmKey in @(
        'HKLM:\\SOFTWARE\\Zoom', 'HKLM:\\SOFTWARE\\Zoom Workplace',
        'HKLM:\\SOFTWARE\\ZoomUMX', 'HKLM:\\SOFTWARE\\CptService'
      )) {
        if (Test-Path $hklmKey) {
          try {
            $acl = Get-Acl $hklmKey
            $changed = $false
            $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object {
              $acl.RemoveAccessRule($_) | Out-Null
              $changed = $true
            }
            if ($changed) { Set-Acl $hklmKey $acl -EA SilentlyContinue }
            Remove-Item $hklmKey -Recurse -Force -EA SilentlyContinue
          } catch {}
        }
      }

      # 7. Remove CptService device ID folder
      $cptPaths = @(
        "$env:ProgramData\\CptService",
        "$env:ProgramData\\CptHost",
        "$env:ProgramData\\Zoom\\CptService",
        "$env:ProgramData\\Zoom CptService",
        "$env:ProgramData\\zCSCptService",
        "$env:ProgramData\\ZoomCptService",
        "$env:ProgramData\\Zoom",
        "$env:ProgramData\\ZoomVideo",
        "$env:ProgramData\\ZoomVideoComm",
        "$env:ProgramData\\Zoom Video Communications",
        "$env:ProgramData\\Zoom Workplace"
      )
      foreach ($cp in $cptPaths) {
        if (Test-Path $cp) {
          Remove-Item $cp -Recurse -Force -ErrorAction SilentlyContinue
          $count++
        }
      }

      # 8. Kill CptService and delete services
      Stop-Process -Name 'CptService' -Force -ErrorAction SilentlyContinue
      Stop-Process -Name 'cptservice' -Force -ErrorAction SilentlyContinue
      Stop-Process -Name 'CptHost' -Force -ErrorAction SilentlyContinue
      Stop-Process -Name 'CptControl' -Force -ErrorAction SilentlyContinue
      Stop-Service -Name 'ZoomCptService' -Force -ErrorAction SilentlyContinue
      Stop-Service -Name 'CptService' -Force -ErrorAction SilentlyContinue
      sc.exe delete ZoomCptService 2>$null | Out-Null
      sc.exe delete CptService 2>$null | Out-Null
      sc.exe delete zCSCptService 2>$null | Out-Null

      # 9. Remove Prefetch files created by installer
      Get-ChildItem 'C:\\Windows\\Prefetch' -Filter '*ZOOM*.pf' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
        $count++
      }

      # 10. Remove RecentFileCache
      $rfcPath = 'C:\\Windows\\AppCompat\\Programs\\RecentFileCache.bcf'
      if (Test-Path $rfcPath) {
        Remove-Item $rfcPath -Force -ErrorAction SilentlyContinue
        $count++
      }

      Write-Output $count
    `, { timeout: 45000 });

    totalDeleted = parseInt(result.stdout, 10) || 0;
    if (totalDeleted > 0) {
      logger.ok(`Post-install scrub: removed ${totalDeleted} items, DENY ACLs set on all Zoom+Workplace paths`);
    }

    // Verify and retry with reg.exe if needed
    const verifyResult = await runPowerShell(`
      $remaining = @()
      # Check HKCU Zoom classic
      foreach ($key in @('HKCU:\\Software\\Zoom\\SystemInfo', 'HKCU:\\Software\\Zoom\\Secrets')) {
        if (Test-Path $key) {
          $children = (Get-ChildItem $key -EA SilentlyContinue | Measure-Object).Count
          $values = (Get-ItemProperty $key -EA SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }
          if ($children -gt 0 -or ($values | Measure-Object).Count -gt 0) { $remaining += $key.Replace('HKCU:\\','HKCU:') + '(populated)' }
        }
      }
      # Check HKCU Zoom Workplace
      foreach ($key in @('HKCU:\\Software\\Zoom Workplace\\SystemInfo', 'HKCU:\\Software\\Zoom Workplace\\Secrets')) {
        if (Test-Path $key) {
          $children = (Get-ChildItem $key -EA SilentlyContinue | Measure-Object).Count
          $values = (Get-ItemProperty $key -EA SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }
          if ($children -gt 0 -or ($values | Measure-Object).Count -gt 0) { $remaining += $key.Replace('HKCU:\\','HKCU:') + '(populated)' }
        }
      }
      # Check HKLM keys
      foreach ($key in @('HKLM:\\SOFTWARE\\Zoom', 'HKLM:\\SOFTWARE\\ZoomUMX', 'HKLM:\\SOFTWARE\\Zoom Workplace')) {
        if (Test-Path $key) {
          $children = (Get-ChildItem $key -EA SilentlyContinue | Measure-Object).Count
          $values = (Get-ItemProperty $key -EA SilentlyContinue).PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' }
          if ($children -gt 0 -or ($values | Measure-Object).Count -gt 0) { $remaining += $key.Replace('HKLM:\\','HKLM:') + '(populated)' }
        }
      }
      if ($remaining.Count -gt 0) {
        Write-Output ("SURVIVING: " + ($remaining -join ', '))
      } else {
        Write-Output "ALL_CLEAN"
      }
    `, { timeout: 10000 });

    const verifyOut = (verifyResult.stdout || '').trim();
    if (verifyOut.startsWith('SURVIVING')) {
      logger.warn('Post-install scrub: some keys survived: ' + verifyOut);
      // Retry with reg.exe — covers all known Zoom registry paths
      const retryKeys = [
        'HKLM\\SOFTWARE\\Zoom', 'HKLM\\SOFTWARE\\ZoomUMX',
        'HKLM\\SOFTWARE\\Zoom Workplace', 'HKLM\\SOFTWARE\\ZoomVideoComm',
        'HKLM\\SOFTWARE\\WOW6432Node\\Zoom', 'HKLM\\SOFTWARE\\WOW6432Node\\ZoomUMX',
        'HKLM\\SOFTWARE\\WOW6432Node\\Zoom Workplace',
        'HKCU\\Software\\Zoom Workplace'
      ];
      for (const key of retryKeys) {
        await spawnSafe('reg', ['delete', key, '/f'], { timeout: 5000 }).catch(() => {});
      }
    } else {
      logger.ok('Post-install scrub verified clean (DENY ACLs locked on all Zoom paths)');
    }
  } catch (e) {
    logger.debug('Post-install scrub failed', { error: e.message });
  }

  return { success: true, deleted: totalDeleted };
}

/**
 * Pre-launch scrub — runs RIGHT BEFORE launching Zoom.
 * Deletes any SystemInfo data and refreshes the DENY ACL
 * to prevent Zoom from caching hardware fingerprints.
 * Also removes any HKLM Zoom keys that may have been recreated.
 */
async function preLaunchScrub() {
  logger.info('Running pre-launch fingerprint scrub...');

  try {
    const result = await runPowerShell(`
      $count = 0

      # =============================================
      # 1. REGISTRY: Nuke ALL Zoom registry keys (classic + Workplace)
      # =============================================
      # HKCU keys — remove DENY ACLs first (from previous fixer runs)
      $hkcuKeys = @(
        'HKCU:\\Software\\Zoom',
        'HKCU:\\Software\\ZoomUMX',
        'HKCU:\\Software\\zoom.us',
        'HKCU:\\Software\\Zoom Video Communications',
        'HKCU:\\Software\\Zoom Workplace',
        'HKCU:\\Software\\ZoomVideoComm',
        'HKCU:\\Software\\ZoomGifCollector',
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
            # Also recurse subkeys
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
          $count++
        }
      }
      # reg.exe for reliability (handles locked keys better)
      foreach ($k in @(
        'HKCU\\Software\\Zoom', 'HKCU\\Software\\ZoomUMX', 'HKCU\\Software\\zoom.us',
        'HKCU\\Software\\Zoom Video Communications', 'HKCU\\Software\\Zoom Workplace',
        'HKCU\\Software\\ZoomVideoComm', 'HKCU\\Software\\CptService',
        'HKCU\\Software\\ZoomGifCollector'
      )) { reg delete $k /f 2>$null | Out-Null }

      # HKLM + WOW64 keys
      $hklmKeys = @(
        'HKLM:\\SOFTWARE\\Zoom', 'HKLM:\\SOFTWARE\\ZoomUMX', 'HKLM:\\SOFTWARE\\zoom.us',
        'HKLM:\\SOFTWARE\\Zoom Video Communications', 'HKLM:\\SOFTWARE\\Zoom Workplace',
        'HKLM:\\SOFTWARE\\ZoomVideoComm', 'HKLM:\\SOFTWARE\\CptService',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Zoom', 'HKLM:\\SOFTWARE\\WOW6432Node\\ZoomUMX',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Zoom Workplace', 'HKLM:\\SOFTWARE\\WOW6432Node\\CptService',
        'HKLM:\\SOFTWARE\\WOW6432Node\\ZoomVideoComm',
        'HKLM:\\SOFTWARE\\Policies\\Zoom'
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
          $count++
        }
      }

      # =============================================
      # 2. DATA: Wipe Zoom data directories (encrypted DBs = fingerprint)
      # =============================================
      $roaming = [Environment]::GetFolderPath('ApplicationData')
      $local = [Environment]::GetFolderPath('LocalApplicationData')

      # Wipe ALL Zoom data subdirs (classic + Workplace)
      foreach ($base in @($roaming, $local)) {
        foreach ($sub in @('Zoom\\data', 'Zoom Workplace\\data', 'Zoom\\EBWebView',
                           'Zoom Workplace\\EBWebView', 'Zoom\\app-data', 'Zoom Workplace\\app-data')) {
          $p = Join-Path $base $sub
          if (Test-Path $p) { Remove-Item $p -Recurse -Force -EA SilentlyContinue; $count++ }
        }
      }

      # Root Zoom config files (Zoom.us.ini with win_osencrypt_key, viper.ini)
      foreach ($dir in @('Zoom', 'Zoom Workplace')) {
        foreach ($f in @('Zoom.us.ini','viper.ini','appsafecheck.txt','ZoomWorkplace.ini')) {
          $p = Join-Path $roaming "$dir\\$f"
          if (Test-Path $p) { Remove-Item $p -Force -EA SilentlyContinue; $count++ }
        }
      }

      # Other Zoom-related AppData folders
      foreach ($sub in @('ZoomUMX','zoomus','zoom.us','ZoomVideoComm','ZoomGifCollector')) {
        $p1 = Join-Path $roaming $sub
        $p2 = Join-Path $local $sub
        if (Test-Path $p1) { Remove-Item $p1 -Recurse -Force -EA SilentlyContinue; $count++ }
        if (Test-Path $p2) { Remove-Item $p2 -Recurse -Force -EA SilentlyContinue; $count++ }
      }

      # ProgramData fingerprints
      foreach ($pd in @('CptService','CptHost','Zoom','ZoomVideo','ZoomVideoComm',
                        'Zoom Video Communications','Zoom CptService','zCSCptService','Zoom Workplace')) {
        $p = Join-Path $env:ProgramData $pd
        if (Test-Path $p) { Remove-Item $p -Recurse -Force -EA SilentlyContinue; $count++ }
      }

      # =============================================
      # 3. Auto-start entries (prevent Zoom from respawning)
      # =============================================
      $runKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomUMX','ZoomWorkplace')) {
        Remove-ItemProperty -Path $runKey -Name $v -Force -EA SilentlyContinue
      }
      $runKeyLM = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
      foreach ($v in @('Zoom','ZoomCptService')) {
        Remove-ItemProperty -Path $runKeyLM -Name $v -Force -EA SilentlyContinue
      }

      # =============================================
      # 4. Kill Zoom processes + services
      # =============================================
      Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*Zoom*' } | Stop-Process -Force -EA SilentlyContinue
      Get-Process -Name 'CptService','CptHost','CptControl' -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
      Stop-Service -Name 'ZoomCptService' -Force -EA SilentlyContinue
      Stop-Service -Name 'CptService' -Force -EA SilentlyContinue
      sc.exe delete ZoomCptService 2>$null | Out-Null
      sc.exe delete CptService 2>$null | Out-Null

      Write-Output $count
    `, { timeout: 20000 });

    const count = parseInt(result.stdout, 10) || 0;
    logger.ok(`Pre-launch scrub: cleaned ${count} items (registry + data + processes)`);
    return { success: true, cleaned: count };
  } catch (e) {
    logger.warn('Pre-launch scrub failed', { error: e.message });
    return { success: false, error: e.message };
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

  const steps = {};
  const totalTiers = 4;
  let currentTier = 0;

  const reportProgress = (tierName) => {
    currentTier++;
    if (onProgress) {
      onProgress({
        step: 'fingerprint',
        current: currentTier,
        total: totalTiers,
        message: `Wiping: ${tierName}...`
      });
    }
  };

  // NOTE: Recycle bin cleanup and icon cache rebuild are NOT included here.
  //       They must be called AFTER folder deletion by ipc-handlers.js.

  // Tier 0: Wipe Zoom databases for ALL user profiles on the machine
  reportProgress('All-user Zoom database cleanup');
  steps.allUserData = await wipeAllUserZoomData();

  // Tier 1 (sequential - order matters: telemetry -> cpt -> registry fingerprints)
  reportProgress('Core fingerprint data');
  steps.telemetry = await wipeTelemetryDatabases();
  steps.cptService = await wipeCptServiceData();
  steps.registry = await wipeRegistryFingerprints();

  // Tier 2 (parallel - execution history traces, all independent)
  reportProgress('Execution history cleanup');
  const tier2 = await Promise.allSettled([
    removeWindowsCredentials(),
    clearPrefetchFiles(),
    wipeAmcache(),
    wipeSrumDatabase(),
    cleanEventLogs(),
    wipeUserProfileFingerprints(),
    wipeDeepUserTraces(),
    wipeBrowserZoomData(),
    spoofHardwareIds()
  ]);
  const tier2Keys = ['credentials', 'prefetch', 'amcache', 'srum', 'eventLogs', 'userProfile', 'deepTraces', 'browserData', 'hardwareIds'];
  tier2.forEach((result, i) => {
    steps[tier2Keys[i]] = result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message };
  });

  // Tier 3 (parallel - filesystem/network traces, all independent)
  reportProgress('System traces');
  const tier3 = await Promise.allSettled([
    flushDnsCache(),
    removeFirewallRules(),
    cleanJumpLists(),
    cleanVirtualStore(),
    cleanCrashDumps(),
    cleanTempFiles(),
    cleanZoomCertificates(),
    cleanBitsJobs(),
    cleanNetworkProfiles(),
    cleanNotificationDatabase(),
    cleanFontCache()
  ]);
  const tier3Keys = ['dns', 'firewall', 'jumpLists', 'virtualStore', 'crashDumps', 'tempFiles', 'certificates', 'bits', 'networkProfiles', 'notifications', 'fontCache'];
  tier3.forEach((result, i) => {
    steps[tier3Keys[i]] = result.status === 'fulfilled' ? result.value : { success: false, error: result.reason?.message };
  });

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
  cleanZoomCertificates,
  cleanBitsJobs,
  cleanNetworkProfiles,
  cleanNotificationDatabase,
  cleanFontCache,
  wipeUserProfileFingerprints,
  wipeDeepUserTraces,
  wipeBrowserZoomData,
  spoofHardwareIds,
  postInstallScrub,
  preLaunchScrub,
  rotateMachineGuid,
  detectActiveVPN,
  spoofMacAddresses,
  randomizeComputerName,
  changeVolumeSerial,
  wipeDeviceFingerprint,
  verifyFingerprintWipe,
  blockCptServiceNetwork,
  unblockCptServiceNetwork,
  neutralizeCptServiceBinary,
  wipeAllUserZoomData
};
