/**
 * 1132 Fixer - Database Purge Operation
 * Nukes the ENTIRE Zoom\data directory (databases, WebviewCache, viper.ini, configs).
 * Zoom stores device fingerprint data across multiple file types in this directory,
 * not just .db files. A complete wipe forces Zoom to generate a fresh device identity.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('../utils/logger');

const APPDATA = process.env.APPDATA;
const LOCALAPPDATA = process.env.LOCALAPPDATA;

// Directories to nuke entirely
const ZOOM_DATA_DIRS = [
  path.join(APPDATA, 'Zoom', 'data'),
  path.join(LOCALAPPDATA, 'Zoom', 'data'),
  path.join(APPDATA, 'Zoom Workplace', 'data'),
  path.join(LOCALAPPDATA, 'Zoom Workplace', 'data'),
];

// Additional per-user files outside \data that contain fingerprints
const ZOOM_ROOT_FILES = [
  'appsafecheck.txt',
];

/**
 * Count files recursively in a directory
 */
function countFiles(dirPath) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        count += countFiles(full);
      } else {
        count++;
      }
    }
  } catch (_) {}
  return count;
}

/**
 * Get total size of a directory
 */
function dirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += dirSize(full);
      } else {
        try { size += fs.statSync(full).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return size;
}

/**
 * Scan all Zoom data directories (read-only preview)
 * @returns {{files: Array, totalSize: number, dirs: Array<string>}}
 */
function scanAllDatabases() {
  const allFiles = [];
  const scannedDirs = [];

  for (const dir of ZOOM_DATA_DIRS) {
    if (fs.existsSync(dir)) {
      scannedDirs.push(dir);
      // List top-level items for display
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          try {
            if (entry.isDirectory()) {
              const fileCount = countFiles(fullPath);
              const size = dirSize(fullPath);
              allFiles.push({ path: fullPath, name: `${entry.name}/ (${fileCount} files)`, size });
            } else {
              const stat = fs.statSync(fullPath);
              allFiles.push({ path: fullPath, name: entry.name, size: stat.size });
            }
          } catch (_) {
            allFiles.push({ path: fullPath, name: entry.name, size: 0 });
          }
        }
      } catch (_) {}
    }
  }

  const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
  return { files: allFiles, totalSize, dirs: scannedDirs };
}

/**
 * Nuke entire Zoom data directories + root fingerprint files
 * @param {Function} [onProgress] - Progress callback
 * @returns {Promise<{success: boolean, deleted: number, failed: number, files: Array, totalSize: number}>}
 */
async function purgeAllDatabases(onProgress) {
  logger.section('DATABASE PURGE (FULL DATA WIPE)');

  if (onProgress) onProgress({ message: 'Scanning Zoom data directories...', current: 0, total: 1 });

  const scan = scanAllDatabases();

  for (const dir of scan.dirs) {
    logger.info(`Scanning → ${dir}`);
  }

  logger.info(`Found ${scan.files.length} items (${formatBytes(scan.totalSize)})`);

  if (scan.files.length === 0) {
    logger.ok('No Zoom data found — already clean');
    return { success: true, deleted: 0, failed: 0, files: [], totalSize: 0 };
  }

  for (const f of scan.files) {
    logger.info(`  ${f.name} (${formatBytes(f.size)})`);
  }

  // Kill Zoom processes first to release file locks
  if (onProgress) onProgress({ message: 'Killing Zoom processes...', current: 0, total: scan.dirs.length });
  try {
    execSync('taskkill /F /IM Zoom.exe /T 2>nul & taskkill /F /IM CptService.exe /T 2>nul & taskkill /F /IM CptHost.exe /T 2>nul & taskkill /F /IM ZoomWebHost.exe /T 2>nul & taskkill /F /IM Zoom_launcher.exe /T 2>nul', { stdio: 'ignore', timeout: 10000 });
  } catch (_) {}
  // Brief pause for process cleanup
  await new Promise(r => setTimeout(r, 500));

  // Nuke each data directory entirely
  let deleted = 0;
  let failed = 0;
  const results = [];

  for (let i = 0; i < ZOOM_DATA_DIRS.length; i++) {
    const dir = ZOOM_DATA_DIRS[i];
    if (!fs.existsSync(dir)) continue;

    if (onProgress) {
      onProgress({ message: `Wiping ${dir}...`, current: i + 1, total: ZOOM_DATA_DIRS.length });
    }

    const fileCount = countFiles(dir);

    try {
      fs.rmSync(dir, { recursive: true, force: true });
      deleted += fileCount;
      results.push({ name: dir, size: 0, deleted: true });
      logger.ok(`Nuked: ${dir} (${fileCount} files)`);
    } catch (_) {
      // Fallback: cmd rd for locked files
      try {
        execSync(`rd /s /q "${dir}"`, { stdio: 'ignore', timeout: 15000 });
        deleted += fileCount;
        results.push({ name: dir, size: 0, deleted: true });
        logger.ok(`Nuked (rd): ${dir}`);
      } catch (_2) {
        failed++;
        results.push({ name: dir, size: 0, deleted: false, error: 'locked' });
        logger.warn(`Failed to nuke: ${dir}`);
      }
    }
  }

  // Also delete root-level fingerprint files
  for (const zoomBase of ['Zoom', 'Zoom Workplace']) {
    for (const rootFile of ZOOM_ROOT_FILES) {
      for (const base of [APPDATA, LOCALAPPDATA]) {
        const fp = path.join(base, zoomBase, rootFile);
        try {
          if (fs.existsSync(fp)) {
            fs.unlinkSync(fp);
            deleted++;
            logger.ok(`Deleted: ${fp}`);
          }
        } catch (_) {}
      }
    }
  }

  // Clear DENY ACLs and delete all Zoom registry keys
  // Previous fixer runs set DENY ACLs which block Zoom from creating fresh identity
  if (onProgress) onProgress({ message: 'Clearing Zoom registry...', current: 0, total: 1 });
  try {
    const regKeys = [
      'HKCU\\Software\\Zoom',
      'HKCU\\Software\\ZoomUMX',
      'HKCU\\Software\\zoom.us',
      'HKCU\\Software\\Zoom Video Communications',
      'HKCU\\Software\\Zoom Workplace',
      'HKCU\\Software\\ZoomVideoComm',
      'HKCU\\Software\\CptService',
      'HKCU\\Software\\ZoomGifCollector',
    ];
    const psScript = regKeys.map(k => {
      const psPath = k.replace('HKCU\\', 'HKCU:\\');
      return `
        if (Test-Path '${psPath}') {
          try {
            $acl = Get-Acl '${psPath}'
            $acl.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
            Set-Acl '${psPath}' $acl -EA SilentlyContinue
          } catch {}
          Remove-Item '${psPath}' -Recurse -Force -EA SilentlyContinue
        }
        reg delete '${k}' /f 2>$null | Out-Null`;
    }).join('\n');
    execSync(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`, { stdio: 'ignore', timeout: 15000 });
    logger.ok('Cleared Zoom registry keys and DENY ACLs');
    deleted++;
  } catch (e) {
    logger.warn('Registry cleanup partial', { error: e.message });
  }

  // Stop and delete CptService
  try {
    execSync('sc stop ZoomCptService 2>nul & sc stop CptService 2>nul & sc delete ZoomCptService 2>nul & sc delete CptService 2>nul', { stdio: 'ignore', timeout: 10000 });
    logger.ok('Stopped/deleted CptService');
  } catch (_) {}

  logger.section('PURGE COMPLETE');
  logger.info(`Deleted: ${deleted} files, Failed: ${failed} directories`);

  return {
    success: failed === 0,
    deleted,
    failed,
    files: results,
    totalSize: scan.totalSize
  };
}

/**
 * Verify that all data directories have been purged
 * @returns {{clean: boolean, remaining: number}}
 */
function verifyPurge() {
  let remaining = 0;
  for (const dir of ZOOM_DATA_DIRS) {
    if (fs.existsSync(dir)) {
      remaining += countFiles(dir);
    }
  }
  return { clean: remaining === 0, remaining };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0.00 MB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

module.exports = {
  scanAllDatabases,
  purgeAllDatabases,
  verifyPurge,
  ZOOM_DATA_DIRS
};
