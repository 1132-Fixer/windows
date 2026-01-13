/**
 * Zoom Preference Manager
 * High-level operations for preference application and verification
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const zoomPrefs = require('../../shared/zoom-prefs');

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const CONFIG_PATH = path.join(LOCALAPPDATA, '1132-Remover', 'config.json');

/**
 * Load user preferences from config file
 * @returns {Object} User preferences or defaults
 */
function loadUserPrefs() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return zoomPrefs.getDefaultPreferences();
  }

  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return config.zoomPrefs || zoomPrefs.getDefaultPreferences();
  } catch (e) {
    logger.warn('Failed to load user prefs, using defaults', { error: e.message });
    return zoomPrefs.getDefaultPreferences();
  }
}

/**
 * Save user preferences to config file
 * @param {Object} prefs - User preferences
 * @returns {{success: boolean}}
 */
function saveUserPrefs(prefs) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let config = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
      // Start fresh
    }
  }

  config.zoomPrefs = prefs;
  config.lastUpdated = new Date().toISOString();

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  logger.ok('User preferences saved', { path: CONFIG_PATH });

  return { success: true };
}

/**
 * Apply preferences to Zoom (write zoomus.conf)
 * @param {Object} options - Options
 * @param {Object} options.userPrefs - User preferences (or load from config)
 * @param {boolean} options.snapshot - Take snapshot before/after (default true)
 * @returns {Promise<{success: boolean, keysApplied: number, build?: string}>}
 */
async function applyPreferences(options = {}) {
  logger.section('Applying Zoom Preferences');

  try {
    // Detect Zoom version
    const versionInfo = await zoomPrefs.detectZoomVersion();
    const build = versionInfo.version?.raw || 'unknown';
    logger.info('Detected Zoom version', versionInfo);

    // Select template for this version
    const template = zoomPrefs.selectTemplate(versionInfo.version);
    logger.info('Selected template', { id: template.id });

    // Load user preferences
    const userPrefs = options.userPrefs || loadUserPrefs();

    // Take pre-write snapshot
    if (options.snapshot !== false) {
      const s0 = zoomPrefs.takeSnapshot('pre-write');
      logger.debug('Pre-write snapshot', { keyCount: s0.snapshot?.keyCount });
    }

    // Map UI prefs to conf keys
    const confObj = zoomPrefs.uiToConf(userPrefs, template);
    const keyCount = Object.keys(confObj).length;

    // Write config
    const writeResult = zoomPrefs.writeZoomConf(confObj);
    logger.ok('Zoom preferences written', {
      path: writeResult.path,
      keysApplied: keyCount,
      build
    });

    // Take post-write snapshot
    if (options.snapshot !== false) {
      const s1 = zoomPrefs.takeSnapshot('post-write');
      logger.debug('Post-write snapshot', { keyCount: s1.snapshot?.keyCount });
    }

    return {
      success: true,
      keysApplied: keyCount,
      build,
      templateId: template.id,
      path: writeResult.path
    };
  } catch (e) {
    logger.error('Failed to apply preferences', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Verify preferences after Zoom launch
 * Compares post-write snapshot with current state
 * @param {Object} options - Options
 * @param {number} options.settleMs - Time to wait for config to settle
 * @param {number} options.timeoutMs - Max wait time
 * @returns {Promise<{success: boolean, diff: Object, summary: Object}>}
 */
async function verifyPreferences(options = {}) {
  logger.section('Verifying Zoom Preferences');

  try {
    const confPath = zoomPrefs.getZoomConfPath();

    // Wait for config to settle
    logger.info('Waiting for zoomus.conf to settle...');
    const settled = await zoomPrefs.waitForFileSettle(
      confPath,
      options.settleMs || 4000,
      options.timeoutMs || 60000
    );

    if (!settled) {
      logger.warn('Config file did not settle within timeout');
    }

    // Take post-launch snapshot
    const s2 = zoomPrefs.takeSnapshot('post-launch');
    logger.debug('Post-launch snapshot', { keyCount: s2.snapshot?.keyCount });

    // Load post-write snapshot for comparison
    const s1 = zoomPrefs.loadSnapshot('post-write');
    if (!s1) {
      logger.warn('No post-write snapshot found for comparison');
      return {
        success: true,
        diff: null,
        summary: null,
        warning: 'No baseline snapshot for comparison'
      };
    }

    // Compare snapshots
    const comparison = zoomPrefs.compareSnapshots(s1, s2);
    const { diff, summary } = comparison;

    // Log what Zoom changed
    if (summary.total > 0) {
      logger.info('Zoom modified preferences after launch', {
        added: summary.added,
        removed: summary.removed,
        modified: summary.modified
      });

      // Log specific changes
      if (summary.modified > 0) {
        for (const [key, change] of Object.entries(diff.modified)) {
          logger.debug(`  ${key}: "${change.from}" → "${change.to}"`);
        }
      }
    } else {
      logger.ok('All preferences preserved - no changes by Zoom');
    }

    // Save diff for this build
    const versionInfo = await zoomPrefs.detectZoomVersion();
    const build = versionInfo.version?.raw || 'unknown';
    const diffPath = zoomPrefs.saveDiff(build, comparison);
    logger.info('Diff saved', { path: diffPath, build });

    return {
      success: true,
      diff,
      summary,
      build,
      diffPath
    };
  } catch (e) {
    logger.error('Failed to verify preferences', { error: e.message });
    return { success: false, error: e.message };
  }
}

/**
 * Full apply + verify cycle with optional Zoom launch
 * @param {Object} options - Options
 * @param {boolean} options.launchZoom - Launch Zoom for verification
 * @param {Function} options.launchFn - Custom launch function
 * @returns {Promise<Object>}
 */
async function applyAndVerify(options = {}) {
  logger.section('Apply and Verify Preferences');

  // Apply preferences
  const applyResult = await applyPreferences({ snapshot: true });
  if (!applyResult.success) {
    return applyResult;
  }

  // Optionally launch Zoom and verify
  if (options.launchZoom) {
    logger.info('Launching Zoom for verification...');

    if (options.launchFn) {
      await options.launchFn();
    } else {
      // Use installer module's launch function
      const installer = require('./installer');
      await installer.launchZoom();
    }

    // Small delay before verification
    await new Promise(r => setTimeout(r, 1000));

    const verifyResult = await verifyPreferences();

    return {
      success: true,
      applied: applyResult,
      verified: verifyResult
    };
  }

  return {
    success: true,
    applied: applyResult,
    verified: null,
    note: 'Verification skipped (launchZoom=false)'
  };
}

/**
 * Get current Zoom preferences from zoomus.conf
 * @returns {Object} Current preferences in UI format
 */
function getCurrentPrefs() {
  const conf = zoomPrefs.readZoomConf();
  if (!conf) {
    return null;
  }
  return zoomPrefs.confToUi(conf);
}

/**
 * Get the last diff result
 * @returns {Object|null}
 */
function getLastDiff() {
  return zoomPrefs.getLatestDiff();
}

/**
 * Get preference options schema for UI
 * @returns {Object}
 */
function getPrefOptions() {
  return zoomPrefs.ZOOM_PREF_OPTIONS;
}

module.exports = {
  loadUserPrefs,
  saveUserPrefs,
  applyPreferences,
  verifyPreferences,
  applyAndVerify,
  getCurrentPrefs,
  getLastDiff,
  getPrefOptions,
  CONFIG_PATH
};
