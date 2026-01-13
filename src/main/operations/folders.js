/**
 * 1132 Remover - Folder Cleanup
 * Deletes all Zoom data folders with verification
 */

const fs = require('fs');
const path = require('path');
const { runPowerShell } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_DATA_PATHS } = require('../../shared/constants');

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

      // Calculate size
      try {
        const size = await getFolderSize(p);
        totalSize += size;
      } catch (e) {
        // Ignore size errors
      }
    }
  }

  logger.debug(`Checked ${checked} predefined paths, found ${found}`);

  // Also scan all user profiles (including current user)
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
      // Skip system folders only (scan ALL real user profiles including current)
      if (['Public', 'Default', 'Default User', 'All Users'].includes(user)) continue;

      const userPath = path.join(usersDir, user);

      // Check if it's a directory
      try {
        if (!fs.statSync(userPath).isDirectory()) continue;
      } catch (e) {
        continue;
      }

      // Check for Zoom folders in this user's profile
      const zoomFolders = [
        path.join(userPath, 'AppData', 'Roaming', 'Zoom'),
        path.join(userPath, 'AppData', 'Roaming', 'zoomus'),
        path.join(userPath, 'AppData', 'Local', 'Zoom'),
        path.join(userPath, 'AppData', 'Local', 'Programs', 'Zoom'),
        path.join(userPath, 'Documents', 'Zoom')
      ];

      for (const folder of zoomFolders) {
        if (fs.existsSync(folder)) {
          paths.push(folder);
          try {
            totalSize += await getFolderSize(folder);
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
 * Get folder size recursively
 * @param {string} folderPath - Folder path
 * @returns {Promise<number>} Size in bytes
 */
async function getFolderSize(folderPath) {
  try {
    const result = await runPowerShell(
      `(Get-ChildItem "${folderPath}" -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum`,
      { timeout: 30000 }
    );
    return parseInt(result.stdout, 10) || 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Delete a folder with retry logic
 * @param {string} folderPath - Folder to delete
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function deleteFolder(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return { success: true, existed: false };
  }

  // Method 1: Node.js rmSync
  try {
    fs.rmSync(folderPath, { recursive: true, force: true, maxRetries: 3 });
    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'rmSync' };
    }
  } catch (e) {
    logger.debug(`rmSync failed for ${folderPath}: ${e.message}`);
  }

  // Method 2: PowerShell Remove-Item
  try {
    await runPowerShell(
      `Remove-Item -LiteralPath "${folderPath}" -Recurse -Force -ErrorAction Stop`,
      { timeout: 30000 }
    );
    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'powershell' };
    }
  } catch (e) {
    logger.debug(`PowerShell remove failed for ${folderPath}: ${e.message}`);
  }

  // Method 3: Take ownership and retry
  try {
    await runPowerShell(`
      takeown /F "${folderPath}" /R /A /D Y 2>&1 | Out-Null
      icacls "${folderPath}" /grant Administrators:F /T /Q 2>&1 | Out-Null
      Remove-Item -LiteralPath "${folderPath}" -Recurse -Force -ErrorAction Stop
    `, { timeout: 60000 });

    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'takeown' };
    }
  } catch (e) {
    logger.debug(`Takeown method failed for ${folderPath}: ${e.message}`);
  }

  // Method 4: CMD rd (sometimes works when others fail)
  try {
    await runPowerShell(
      `cmd /c rd /s /q "${folderPath}"`,
      { timeout: 30000 }
    );
    if (!fs.existsSync(folderPath)) {
      return { success: true, method: 'rd' };
    }
  } catch (e) {
    // Continue
  }

  return {
    success: false,
    error: 'All deletion methods failed'
  };
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
      logger.ok(`Deleted: ${folderPath}`);
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
  logger.logStep('Delete Zoom Folders', success, { deleted, failed });

  return {
    success,
    deleted,
    failed,
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

/**
 * Format bytes to human readable string
 * @param {number} bytes - Bytes
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
  scanZoomFolders,
  scanAllUserProfiles,
  getFolderSize,
  deleteFolder,
  deleteAllZoomFolders,
  verifyFoldersDeleted,
  formatBytes
};
