/**
 * Zoom Config File Utilities
 * Parse, render, and diff zoomus.conf files
 */

const fs = require('fs');
const path = require('path');

const APPDATA = process.env.APPDATA;
const ZOOM_CONF_PATH = path.join(APPDATA, 'Zoom', 'data', 'zoomus.conf');

/**
 * Parse zoomus.conf content into object
 * @param {string} text - Config file content
 * @returns {Object} Parsed key-value pairs
 */
function parseZoomConf(text) {
  const out = {};

  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();

    // Skip empty lines and comments
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;

    const i = t.indexOf('=');
    if (i === -1) continue;

    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim();
    out[k] = v;
  }

  return out;
}

/**
 * Render config object to zoomus.conf format
 * Deterministic ordering for stable diffs
 * @param {Object} confObj - Config key-value pairs
 * @returns {string} Config file content
 */
function renderZoomConf(confObj) {
  const keys = Object.keys(confObj).sort((a, b) => a.localeCompare(b));
  return keys.map(k => `${k}=${confObj[k]}`).join('\r\n') + '\r\n';
}

/**
 * Read current zoomus.conf
 * @returns {Object|null} Parsed config or null if not found
 */
function readZoomConf() {
  if (!fs.existsSync(ZOOM_CONF_PATH)) {
    return null;
  }

  try {
    const content = fs.readFileSync(ZOOM_CONF_PATH, 'utf-8');
    return parseZoomConf(content);
  } catch (e) {
    return null;
  }
}

/**
 * Write zoomus.conf
 * @param {Object} confObj - Config to write
 * @returns {{success: boolean, path: string}}
 */
function writeZoomConf(confObj) {
  const dir = path.dirname(ZOOM_CONF_PATH);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const content = renderZoomConf(confObj);

  // Write with no BOM, ASCII-compatible
  fs.writeFileSync(ZOOM_CONF_PATH, content, { encoding: 'utf-8' });

  return { success: true, path: ZOOM_CONF_PATH };
}

/**
 * Compute diff between two config objects
 * @param {Object} before - Previous config state
 * @param {Object} after - Current config state
 * @returns {{added: Object, removed: Object, modified: Object}}
 */
function diffConfigs(before, after) {
  const changes = {
    added: {},
    removed: {},
    modified: {}
  };

  const allKeys = new Set([
    ...Object.keys(before || {}),
    ...Object.keys(after || {})
  ]);

  for (const k of allKeys) {
    const inBefore = before && k in before;
    const inAfter = after && k in after;

    if (!inBefore && inAfter) {
      changes.added[k] = after[k];
    } else if (inBefore && !inAfter) {
      changes.removed[k] = before[k];
    } else if (inBefore && inAfter && before[k] !== after[k]) {
      changes.modified[k] = { from: before[k], to: after[k] };
    }
  }

  return changes;
}

/**
 * Check if diff has any changes
 * @param {Object} diff - Diff object from diffConfigs
 * @returns {boolean}
 */
function hasChanges(diff) {
  return (
    Object.keys(diff.added).length > 0 ||
    Object.keys(diff.removed).length > 0 ||
    Object.keys(diff.modified).length > 0
  );
}

/**
 * Get summary of diff
 * @param {Object} diff - Diff object
 * @returns {{added: number, removed: number, modified: number, total: number}}
 */
function getDiffSummary(diff) {
  const added = Object.keys(diff.added).length;
  const removed = Object.keys(diff.removed).length;
  const modified = Object.keys(diff.modified).length;

  return {
    added,
    removed,
    modified,
    total: added + removed + modified
  };
}

/**
 * Get the zoomus.conf path
 * @returns {string}
 */
function getZoomConfPath() {
  return ZOOM_CONF_PATH;
}

module.exports = {
  ZOOM_CONF_PATH,
  parseZoomConf,
  renderZoomConf,
  readZoomConf,
  writeZoomConf,
  diffConfigs,
  hasChanges,
  getDiffSummary,
  getZoomConfPath
};
