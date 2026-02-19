/**
 * 1132 Remover - Folder Cleanup
 * Deletes all Zoom data folders with verification
 *
 * OPTIMIZED: Better handling of locked files
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe, runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_DATA_PATHS, ZOOM_PER_USER_FOLDER_NAMES, formatBytes } = require('../../shared/constants');

/**
 * Get all Zoom data paths that exist on this system
 * @returns {Promise<{paths: string[], totalSize: number}>}
 */
async function scanZoomFolders() {
  const existingPaths = [];
  let totalSize = 0;
  let checked = 0;
  let found = 0;

  // Check all predefined paths
  for (const p of ZOOM_DATA_PATHS) {
    checked++;
    if (fs.existsSync(p)) {
      found++;
      existingPaths.push(p);
      logger.debug(`Found: ${p}`);

      // Calculate size (quick estimate)
      try {
        const size = await getFolderSizeQuick(p);
        totalSize += size;
      } catch (e) {
        // Ignore size errors
      }
    }
  }

  logger.debug(`Checked ${checked} predefined paths, found ${found}`);

  // Also scan all user profiles
  const userProfiles = await scanAllUserProfiles();
  existingPaths.push(...userProfiles.paths);
  totalSize += userProfiles.totalSize;

  // Deduplicate paths
  const uniquePaths = [...new Set(existingPaths)];

  return { paths: uniquePaths, totalSize };
}

/**
 * Scan all user profiles for Zoom data
 * @returns {Promise<{paths: string[], totalSize: number}>}
 */
async function scanAllUserProfiles() {
  const paths = [];
  let totalSize = 0;

  const usersDir = 'C:\\Users';

  try {
    const users = fs.readdirSync(usersDir);

    for (const user of users) {
      // Skip system folders
      if (['Public', 'Default', 'Default User', 'All Users'].includes(user)) continue;

      const userPath = path.join(usersDir, user);

      // Check if it's a directory
      try {
        if (!fs.statSync(userPath).isDirectory()) continue;
      } catch (e) {
        continue;
      }

      // Build full paths from shared per-user folder names
      const zoomFolders = ZOOM_PER_USER_FOLDER_NAMES.map(
        relPath => path.join(userPath, relPath)
      );

      for (const folder of zoomFolders) {
        if (fs.existsSync(folder)) {
          paths.push(folder);
          try {
            totalSize += await getFolderSizeQuick(folder);
          } catch (e) {
            // Ignore
          }
        }
      }
    }
  } catch (e) {
    logger.debug('Error scanning user profiles', { error: e.message });
  }

  return { paths, totalSize };
}

/**
 * Get folder size quickly (estimates based on file count)
 * @param {string} folderPath - Folder path
 * @returns {Promise<number>} Size in bytes (estimate)
 */
async function getFolderSizeQuick(folderPath) {
  try {
    let size = 0;
    const items = fs.readdirSync(folderPath, { withFileTypes: true });

    for (const item of items) {
      const fullPath = path.join(folderPath, item.name);
      try {
        if (item.isDirectory()) {
          size += await getFolderSizeQuick(fullPath);
        } else {
          size += fs.statSync(fullPath).size;
        }
      } catch (e) {
        // Ignore inaccessible files
      }
    }

    return size;
  } catch (e) {
    return 0;
  }
}

/**
 * Try to close any handles on a file/folder using PowerShell
 * @param {string} targetPath - Path to unlock
 */
async function tryUnlockPath(targetPath) {
  try {
    // Kill any explorer.exe handles (common issue)
    await runPowerShell(
      `Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() }`,
      { timeout: 3000 }
    ).catch(() => {});

    // Try to release file handles via .NET
    await runPowerShell(`
      [System.GC]::Collect()
      [System.GC]::WaitForPendingFinalizers()
    `, { timeout: 3000 }).catch(() => {});

    // Small delay
    await new Promise(r => setTimeout(r, 500));
  } catch (e) {
    // Ignore
  }
}

/**
 * Delete a single file with retries
 * @param {string} filePath - File to delete
 * @returns {Promise<boolean>}
 */
async function deleteFile(filePath) {
  for (let i = 0; i < 3; i++) {
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      if (i < 2) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // Try with PowerShell
  try {
    await runPowerShell(
      `Remove-Item -LiteralPath "${filePath}" -Force -ErrorAction Stop`,
      { timeout: 5000 }
    );
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Delete a folder with multiple retry strategies
 * @param {string} folderPath - Folder to delete
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return { success: true, existed: false };
  }

  // Try to unlock first
  await tryUnlockPath(folderPath);

  // Method 1: Node.js rmSync with retries
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(folderPath, { recursive: true, force: true, maxRetries: 3 });
      if (!fs.existsSync(folderPath)) {
        return { success: true, method: 'rmSync' };
      }
    } catch (e) {
      logger.debug(`rmSync attempt ${i + 1} failed for ${folderPath}: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Method 2: Delete files individually first
  try {
    await deleteContentsRecursive(folderPath);
    fs.rmdirSync(folderPath);
    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'recursive' };
    }
  } catch (e) {
    logger.debug(`Recursive delete failed for ${folderPath}: ${e.message}`);
  }

  // Method 3: PowerShell with GC
  try {
    await runPowerShell(`
      [System.GC]::Collect()
      [System.GC]::WaitForPendingFinalizers()
      Start-Sleep -Milliseconds 500
      Remove-Item -LiteralPath "${folderPath}" -Recurse -Force -ErrorAction Stop
    `, { timeout: 30000 });

    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'powershell_gc' };
    }
  } catch (e) {
    logger.debug(`PowerShell GC method failed for ${folderPath}: ${e.message}`);
  }

  // Method 4: Take ownership and retry
  try {
    await runPowerShell(`
      takeown /F "${folderPath}" /R /A /D Y 2>&1 | Out-Null
      icacls "${folderPath}" /grant Administrators:F /T /Q 2>&1 | Out-Null
      Start-Sleep -Milliseconds 500
      Remove-Item -LiteralPath "${folderPath}" -Recurse -Force -ErrorAction Stop
    `, { timeout: 60000 });

    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'takeown' };
    }
  } catch (e) {
    logger.debug(`Takeown method failed for ${folderPath}: ${e.message}`);
  }

  // Method 5: Rename first then delete (sometimes helps)
  try {
    const tempName = folderPath + '_del_' + Date.now();
    fs.renameSync(folderPath, tempName);
    fs.rmSync(tempName, { recursive: true, force: true });
    if (!fs.existsSync(folderPath) && !fs.existsSync(tempName)) {
      return { success: true, method: 'rename' };
    }
  } catch (e) {
    logger.debug(`Rename method failed for ${folderPath}: ${e.message}`);
  }

  // Method 6: CMD rd (sometimes works when others fail)
  try {
    await spawnSafe('cmd', ['/c', 'rd', '/s', '/q', folderPath], { timeout: 30000 });
    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'rd' };
    }
  } catch (e) {
    // Continue
  }

  // Method 7: Schedule for delete on reboot (last resort)
  try {
    await runPowerShell(`
      $signature = @'
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool MoveFileEx(string lpExistingFileName, string lpNewFileName, int dwFlags);
'@
      $type = Add-Type -MemberDefinition $signature -Name 'MoveFileEx' -Namespace 'Win32' -PassThru
      $MOVEFILE_DELAY_UNTIL_REBOOT = 0x00000004
      $type::MoveFileEx("${folderPath}", $null, $MOVEFILE_DELAY_UNTIL_REBOOT)
    `, { timeout: 10000 });

    logger.warn(`Scheduled for deletion on reboot: ${folderPath}`);
    return { success: true, method: 'reboot_scheduled', needsReboot: true };
  } catch (e) {
    // Continue
  }

  return {
    success: false,
    error: 'All deletion methods failed'
  };
}

/**
 * Delete folder contents recursively (handles locked files better)
 * @param {string} folderPath - Folder path
 */
async function deleteContentsRecursive(folderPath) {
  const items = fs.readdirSync(folderPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(folderPath, item.name);

    try {
      if (item.isDirectory()) {
        await deleteContentsRecursive(fullPath);
        fs.rmdirSync(fullPath);
      } else {
        // Try multiple times for files
        await deleteFile(fullPath);
      }
    } catch (e) {
      // Log but continue - we'll try the folder delete anyway
      logger.debug(`Could not delete ${fullPath}: ${e.message}`);
    }
  }
}

/**
 * Delete all Zoom folders
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, deleted: number, failed: number, results: Array}>}
 */
async function deleteAllZoomFolders(onProgress = null) {
  logger.section('Deleting Zoom Data Folders');

  // First scan for all folders
  const scan = await scanZoomFolders();
  logger.info(`Found ${scan.paths.length} Zoom folders (${formatBytes(scan.totalSize)})`);

  const results = [];
  let deleted = 0;
  let failed = 0;
  let needsReboot = false;

  for (let i = 0; i < scan.paths.length; i++) {
    const folderPath = scan.paths[i];

    if (onProgress) {
      onProgress({
        step: 'folders',
        current: i + 1,
        total: scan.paths.length,
        message: `Deleting: ${path.basename(folderPath)}...`
      });
    }

    const result = await deleteFolder(folderPath);

    if (result.success) {
      deleted++;
      if (result.needsReboot) {
        needsReboot = true;
        logger.warn(`Scheduled for reboot: ${folderPath}`);
      } else {
        logger.ok(`Deleted: ${folderPath}`);
      }
    } else {
      failed++;
      logger.error(`Failed to delete: ${folderPath}`, { error: result.error });
    }

    results.push({
      path: folderPath,
      ...result
    });
  }

  const success = failed === 0;
  logger.logStep('Delete Zoom Folders', success, { deleted, failed, needsReboot });

  return {
    success,
    deleted,
    failed,
    needsReboot,
    results
  };
}

/**
 * Verify all Zoom folders are deleted
 * @returns {Promise<{clean: boolean, remaining: string[]}>}
 */
async function verifyFoldersDeleted() {
  const scan = await scanZoomFolders();
  return {
    clean: scan.paths.length === 0,
    remaining: scan.paths
  };
}

module.exports = {
  scanZoomFolders,
  scanAllUserProfiles,
  getFolderSizeQuick,
  deleteFolder,
  deleteAllZoomFolders,
  verifyFoldersDeleted
};
