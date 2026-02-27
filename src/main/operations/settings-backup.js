/**
 * Zoom Settings Backup & Restore
 * Saves Zoom's encrypted settings databases before purge,
 * restores them after reinstall to preserve user preferences.
 *
 * Settings are stored in encrypted SQLite databases (DPAPI).
 * Since the Windows user profile survives the purge, the
 * encryption keys remain valid and restored DBs are readable.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const APPDATA = process.env.APPDATA;
const LOCALAPPDATA = process.env.LOCALAPPDATA;

// Where Zoom stores its data
const ZOOM_DATA_DIR = path.join(APPDATA, 'Zoom', 'data');

// Where we save the backup
const BACKUP_DIR = path.join(LOCALAPPDATA, '1132-Remover', 'zoom-settings');

// Files that contain SETTINGS (safe to restore)
const SETTINGS_FILES = [
  'Zoom.us.ini',              // Theme, language, Outlook sync
  'zoomus.zmdb.kvs.enc.db',   // Key-value settings store (most settings)
  'zoommeeting.enc.db'         // Meeting-specific settings
];

// Files that contain FINGERPRINTS (never restore)
// telemetrydata.db, process_monitoring.db, local_dns_cache.db,
// zoomus.enc.db (main DB with identity), 3dCustomAvatar.enc.db

/**
 * Save Zoom settings files before purge
 * @returns {{success: boolean, files: string[], backupDir: string}}
 */
function saveZoomSettings() {
  logger.info('Saving Zoom settings backup...');

  const saved = [];

  // Check if Zoom data directory exists
  if (!fs.existsSync(ZOOM_DATA_DIR)) {
    logger.debug('No Zoom data directory found, skipping settings backup');
    return { success: true, files: [], backupDir: BACKUP_DIR, skipped: true };
  }

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  for (const filename of SETTINGS_FILES) {
    const src = path.join(ZOOM_DATA_DIR, filename);
    const dest = path.join(BACKUP_DIR, filename);

    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
        saved.push(filename);
        logger.debug(`Backed up: ${filename}`);
      } catch (e) {
        logger.debug(`Failed to backup ${filename}: ${e.message}`);
      }
    }
  }

  if (saved.length > 0) {
    logger.ok(`Zoom settings backed up: ${saved.length} files`, { dir: BACKUP_DIR });
  } else {
    logger.debug('No settings files found to backup');
  }

  return { success: true, files: saved, backupDir: BACKUP_DIR };
}

/**
 * Restore Zoom settings files after reinstall
 * Call AFTER Zoom is installed but BEFORE launching Zoom
 * @returns {{success: boolean, files: string[]}}
 */
function restoreZoomSettings() {
  logger.info('Restoring Zoom settings from backup...');

  const restored = [];

  // Check if backup exists
  if (!fs.existsSync(BACKUP_DIR)) {
    logger.debug('No settings backup found, skipping restore');
    return { success: true, files: [], skipped: true };
  }

  // Ensure Zoom data directory exists (installer should have created it)
  if (!fs.existsSync(ZOOM_DATA_DIR)) {
    fs.mkdirSync(ZOOM_DATA_DIR, { recursive: true });
  }

  for (const filename of SETTINGS_FILES) {
    const src = path.join(BACKUP_DIR, filename);
    const dest = path.join(ZOOM_DATA_DIR, filename);

    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, dest);
        restored.push(filename);
        logger.debug(`Restored: ${filename}`);
      } catch (e) {
        logger.debug(`Failed to restore ${filename}: ${e.message}`);
      }
    }
  }

  if (restored.length > 0) {
    logger.ok(`Zoom settings restored: ${restored.length} files`);
  } else {
    logger.debug('No backup files found to restore');
  }

  return { success: true, files: restored };
}

/**
 * Check if a settings backup exists
 * @returns {boolean}
 */
function hasBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return false;
  return SETTINGS_FILES.some(f => fs.existsSync(path.join(BACKUP_DIR, f)));
}

/**
 * Delete the settings backup (cleanup)
 */
function clearBackup() {
  if (fs.existsSync(BACKUP_DIR)) {
    for (const filename of SETTINGS_FILES) {
      const fp = path.join(BACKUP_DIR, filename);
      if (fs.existsSync(fp)) {
        try { fs.unlinkSync(fp); } catch (e) { /* ignore */ }
      }
    }
    logger.debug('Settings backup cleared');
  }
}

module.exports = {
  saveZoomSettings,
  restoreZoomSettings,
  hasBackup,
  clearBackup,
  BACKUP_DIR
};
