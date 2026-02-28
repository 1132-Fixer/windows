/**
 * Zoom Settings Backup/Restore
 *
 * Minimal stub — Group Policy template enforcement has been removed.
 * The purge/reinstall flow no longer writes any Zoom registry policies.
 * Zoom will use its own defaults after a fresh install.
 */

const logger = require('../utils/logger');

/**
 * Restore is now a no-op — no policies to write.
 */
async function restoreZoomSettings() {
  logger.debug('Settings restore: no policies to apply (GP template removed)');
  return { success: true, policiesSet: 0, iniWritten: 0 };
}

/**
 * Save is a no-op — nothing to back up.
 */
function saveZoomSettings() {
  logger.debug('Settings save: no-op');
  return { success: true, method: 'none' };
}

function hasBackup() {
  return false;
}

function clearBackup() {
  // No-op
}

module.exports = {
  saveZoomSettings,
  restoreZoomSettings,
  hasBackup,
  clearBackup
};
