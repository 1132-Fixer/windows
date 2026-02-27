/**
 * 1132 Remover - Zoom Uninstaller
 * Multiple uninstall methods with verification
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_UNINSTALLER_PATHS } = require('../../shared/constants');

/**
 * Check if Zoom is installed
 * @returns {Promise<{installed: boolean, paths: string[]}>}
 */
async function isZoomInstalled() {
  const existingPaths = [];

  // Check for installer executables
  for (const p of ZOOM_UNINSTALLER_PATHS) {
    if (fs.existsSync(p)) {
      existingPaths.push(p);
    }
  }

  // Check for Zoom.exe
  const zoomExePaths = [
    'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
    'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe',
    path.join(process.env.LOCALAPPDATA, 'Programs', 'Zoom', 'Zoom.exe'),
    path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe')
  ];

  for (const p of zoomExePaths) {
    if (fs.existsSync(p)) {
      existingPaths.push(p);
    }
  }

  // Check registry for installed products (fast, no WMI)
  try {
    const result = await runPowerShell(`
      @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') |
        ForEach-Object { Get-ItemProperty $_ -ErrorAction SilentlyContinue } |
        Where-Object { $_.DisplayName -like '*Zoom*' } |
        Select-Object -ExpandProperty DisplayName
    `, { timeout: 10000 });
    if (result.stdout && result.stdout.trim()) {
      for (const name of result.stdout.trim().split('\n')) {
        existingPaths.push(`Registry: ${name.trim()}`);
      }
    }
  } catch (e) {
    // Registry check failed
  }

  return {
    installed: existingPaths.length > 0,
    paths: existingPaths
  };
}

/**
 * Uninstall Zoom using its own installer
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function uninstallWithOwnInstaller() {
  logger.info('Trying Zoom built-in uninstaller...');

  for (const installerPath of ZOOM_UNINSTALLER_PATHS) {
    if (!fs.existsSync(installerPath)) continue;

    try {
      logger.debug(`Running: ${installerPath} /uninstall`);
      const result = await spawnSafe(installerPath, ['/uninstall'], {
        timeout: 120000,
        shell: true
      });

      // Give it time to complete
      await new Promise(r => setTimeout(r, 3000));

      // Check if Zoom is still installed
      const check = await isZoomInstalled();
      if (!check.installed) {
        logger.ok('Zoom uninstalled with built-in uninstaller');
        return { success: true, method: 'builtin' };
      }
    } catch (e) {
      logger.debug(`Built-in uninstaller failed: ${e.message}`);
    }
  }

  return { success: false, method: 'builtin' };
}

/**
 * Find Zoom MSI product GUIDs from registry uninstall keys
 * Faster and more reliable than WMI Win32_Product enumeration
 * @returns {Promise<Array<{displayName: string, version: string, guid: string, uninstallString: string}>>}
 */
async function findZoomMsiGuids() {
  try {
    const result = await runPowerShell(`
      $roots = @(
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
      )
      foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
          $p = Get-ItemProperty $_.PsPath -ErrorAction SilentlyContinue
          if (-not $p -or -not $p.DisplayName -or $p.DisplayName -notmatch 'Zoom') { return }
          $u = $p.UninstallString
          if (-not $u) { return }
          $m = [regex]::Match($u, '\\{[0-9A-Fa-f\\-]{36}\\}')
          if ($m.Success) {
            Write-Output "$($p.DisplayName)|$($p.DisplayVersion)|$($m.Value)|$u"
          }
        }
      }
    `, { timeout: 30000 });

    if (!result.stdout || !result.stdout.trim()) return [];

    const items = [];
    const seen = new Set();
    for (const line of result.stdout.trim().split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length >= 3 && !seen.has(parts[2])) {
        seen.add(parts[2]);
        items.push({
          displayName: parts[0],
          version: parts[1] || '',
          guid: parts[2],
          uninstallString: parts[3] || ''
        });
      }
    }
    return items;
  } catch (e) {
    logger.debug('MSI GUID enumeration failed', { error: e.message });
    return [];
  }
}

/**
 * Uninstall Zoom using MSI product GUIDs from registry
 * Much faster than WMI Win32_Product (which triggers a full MSI reconfiguration scan)
 * @returns {Promise<{success: boolean, method: string, products: number}>}
 */
async function uninstallWithMsiGuids() {
  logger.info('Trying MSI GUID-based uninstall...');

  const items = await findZoomMsiGuids();
  if (items.length === 0) {
    logger.debug('No Zoom MSI products found in registry');
    return { success: false, method: 'msi_guid', products: 0 };
  }

  logger.info(`Found ${items.length} Zoom MSI product(s)`, { items });

  for (const item of items) {
    try {
      logger.debug(`Uninstalling MSI: ${item.displayName} (${item.guid})`);
      await spawnSafe('msiexec', ['/x', item.guid, '/qn', '/norestart'], {
        timeout: 120000,
        shell: true
      });
    } catch (e) {
      logger.debug(`MSI uninstall failed for ${item.guid}: ${e.message}`);
    }
  }

  // Wait for uninstall to complete
  await new Promise(r => setTimeout(r, 3000));

  const check = await isZoomInstalled();
  if (!check.installed) {
    logger.ok(`Zoom uninstalled via MSI GUID (${items.length} product(s))`);
    return { success: true, method: 'msi_guid', products: items.length };
  }

  return { success: false, method: 'msi_guid', products: items.length };
}

/**
 * Uninstall Zoom using WMI (Windows Management Instrumentation)
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function uninstallWithWMI() {
  logger.info('Trying WMI uninstall...');

  try {
    // Use msiexec directly with GUIDs from registry (avoid slow Win32_Product)
    const guids = await findZoomMsiGuids();
    if (guids.length === 0) {
      logger.debug('No Zoom products found for WMI uninstall');
      return { success: false, method: 'wmi' };
    }

    for (const item of guids) {
      try {
        await spawnSafe('msiexec', ['/x', item.guid, '/qn', '/norestart', 'REBOOT=ReallySuppress'], {
          timeout: 60000,
          shell: true
        });
      } catch (e) {
        logger.debug(`WMI-style uninstall failed for ${item.guid}: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 3000));

    const check = await isZoomInstalled();
    if (!check.installed) {
      logger.ok('Zoom uninstalled with WMI-style msiexec');
      return { success: true, method: 'wmi' };
    }
  } catch (e) {
    logger.debug(`WMI uninstall failed: ${e.message}`);
  }

  return { success: false, method: 'wmi' };
}

/**
 * Uninstall Zoom using PowerShell Get-Package
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function uninstallWithPowerShell() {
  logger.info('Trying PowerShell package uninstall...');

  try {
    const script = `
      $ErrorActionPreference = 'SilentlyContinue'

      # Try Get-Package (modern method, fast)
      $packages = Get-Package -Name '*Zoom*' -ProviderName Programs, msi -ErrorAction SilentlyContinue
      foreach ($pkg in $packages) {
        Write-Host "Uninstalling: $($pkg.Name)"
        Uninstall-Package $pkg -Force -ErrorAction SilentlyContinue
      }

      # Try registry uninstall strings (fast, no WMI)
      $uninstallPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )

      foreach ($regPath in $uninstallPaths) {
        Get-ItemProperty $regPath -ErrorAction SilentlyContinue |
          Where-Object { $_.DisplayName -like '*Zoom*' } |
          ForEach-Object {
            if ($_.UninstallString) {
              Write-Host "Running uninstall: $($_.UninstallString)"
              $cmd = $_.UninstallString -replace '/I', '/X'
              if ($cmd -notlike '*msiexec*') {
                Start-Process cmd -ArgumentList "/c $cmd /S" -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
              } else {
                $args = ($cmd -replace 'msiexec(.exe)?\\s*', '') + ' /qn /norestart'
                Start-Process msiexec -ArgumentList $args -Wait -WindowStyle Hidden -ErrorAction SilentlyContinue
              }
            }
          }
      }
    `;

    await runPowerShell(script, { timeout: 60000 });

    // Wait for uninstall
    await new Promise(r => setTimeout(r, 5000));

    const check = await isZoomInstalled();
    if (!check.installed) {
      logger.ok('Zoom uninstalled with PowerShell');
      return { success: true, method: 'powershell' };
    }
  } catch (e) {
    logger.debug(`PowerShell uninstall failed: ${e.message}`);
  }

  return { success: false, method: 'powershell' };
}

/**
 * Force remove Zoom files (last resort)
 * @returns {Promise<{success: boolean, method: string}>}
 */
async function forceRemoveFiles() {
  logger.info('Force removing Zoom files...');

  const zoomDirs = [
    'C:\\Program Files\\Zoom',
    'C:\\Program Files (x86)\\Zoom',
    path.join(process.env.LOCALAPPDATA, 'Programs', 'Zoom')
  ];

  let removed = 0;

  for (const dir of zoomDirs) {
    if (fs.existsSync(dir)) {
      try {
        // First try to take ownership
        await runPowerShell(
          `takeown /F "${dir}" /R /A /D Y; icacls "${dir}" /grant Administrators:F /T /Q`,
          { timeout: 30000 }
        );

        // Then remove
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
        logger.ok(`Removed: ${dir}`);
      } catch (e) {
        logger.warn(`Failed to remove ${dir}: ${e.message}`);
      }
    }
  }

  return { success: removed > 0, method: 'force_remove', removed };
}

/**
 * Uninstall Zoom using all available methods
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, method: string, details: Object}>}
 */
async function uninstallZoom(onProgress = null) {
  logger.section('Uninstalling Zoom');

  // First check if Zoom is even installed
  const installCheck = await isZoomInstalled();
  if (!installCheck.installed) {
    logger.info('Zoom is not installed, skipping uninstall');
    return { success: true, method: 'not_installed', alreadyUninstalled: true };
  }

  logger.info('Zoom found at:', { paths: installCheck.paths });

  const methods = [
    { name: 'Built-in Uninstaller', fn: uninstallWithOwnInstaller },
    { name: 'MSI GUID Uninstall', fn: uninstallWithMsiGuids },
    { name: 'WMI Uninstall', fn: uninstallWithWMI },
    { name: 'PowerShell Uninstall', fn: uninstallWithPowerShell },
    { name: 'Force Remove Files', fn: forceRemoveFiles }
  ];

  for (let i = 0; i < methods.length; i++) {
    const method = methods[i];

    if (onProgress) {
      onProgress({
        step: 'uninstall',
        current: i + 1,
        total: methods.length,
        message: `Trying: ${method.name}...`
      });
    }

    const result = await method.fn();

    if (result.success) {
      logger.logStep('Uninstall Zoom', true, { method: result.method });
      return {
        success: true,
        method: result.method,
        details: result
      };
    }
  }

  // Final check
  const finalCheck = await isZoomInstalled();
  if (!finalCheck.installed) {
    logger.ok('Zoom uninstalled (verification passed)');
    return { success: true, method: 'verified', details: {} };
  }

  logger.error('Failed to uninstall Zoom after all methods', { remaining: finalCheck.paths });
  return {
    success: false,
    method: null,
    remaining: finalCheck.paths
  };
}

module.exports = {
  isZoomInstalled,
  uninstallZoom,
  uninstallWithOwnInstaller,
  findZoomMsiGuids,
  uninstallWithMsiGuids,
  uninstallWithWMI,
  uninstallWithPowerShell,
  forceRemoveFiles
};
