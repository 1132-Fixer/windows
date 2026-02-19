/**
 * Zoom Preference Snapshots
 * Capture and compare config states for diff-based verification
 */

const fs = require('fs');
const path = require('path');
const { readZoomConf, diffConfigs, getDiffSummary } = require('./conf-utils');

const LOCALAPPDATA = process.env.LOCALAPPDATA;
const SNAPSHOT_DIR = path.join(LOCALAPPDATA, '1132-Remover', 'zoom-pref-snapshots');
const DIFF_DIR = path.join(LOCALAPPDATA, '1132-Remover', 'zoom-pref-diffs');

/**
 * Ensure snapshot directories exist
 */
function ensureDirs() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
  if (!fs.existsSync(DIFF_DIR)) {
    fs.mkdirSync(DIFF_DIR, { recursive: true });
  }
}

/**
 * Take a snapshot of current zoomus.conf
 * @param {string} label - Snapshot label (e.g., 'pre-write', 'post-write', 'post-launch')
 * @returns {{success: boolean, snapshot?: Object, path?: string}}
 */
function takeSnapshot(label) {
  ensureDirs();

  const conf = readZoomConf();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${timestamp}_${label}.json`;
  const filepath = path.join(SNAPSHOT_DIR, filename);

  const snapshot = {
    label,
    timestamp: new Date().toISOString(),
    conf: conf || {},
    keyCount: conf ? Object.keys(conf).length : 0
  };

  fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2));

  return {
    success: true,
    snapshot,
    path: filepath
  };
}

/**
 * Load a snapshot by label (most recent matching)
 * @param {string} label - Snapshot label to find
 * @returns {Object|null}
 */
function loadSnapshot(label) {
  ensureDirs();

  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.json') && f.includes(`_${label}.json`))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const filepath = path.join(SNAPSHOT_DIR, files[0]);
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

/**
 * Compare two snapshots
 * @param {Object} s1 - First snapshot (before)
 * @param {Object} s2 - Second snapshot (after)
 * @returns {Object} Diff result
 */
function compareSnapshots(s1, s2) {
  const diff = diffConfigs(s1?.conf || {}, s2?.conf || {});
  const summary = getDiffSummary(diff);

  return {
    before: s1?.label || 'unknown',
    after: s2?.label || 'unknown',
    beforeTimestamp: s1?.timestamp,
    afterTimestamp: s2?.timestamp,
    diff,
    summary
  };
}

/**
 * Save a diff result for a specific Zoom build
 * @param {string} build - Zoom build version string
 * @param {Object} diffResult - Diff result from compareSnapshots
 * @returns {string} Path to saved diff
 */
function saveDiff(build, diffResult) {
  ensureDirs();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeBuild = (build || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '_');
  const filename = `${safeBuild}_${timestamp}.json`;
  const filepath = path.join(DIFF_DIR, filename);

  const record = {
    build,
    timestamp: new Date().toISOString(),
    ...diffResult
  };

  fs.writeFileSync(filepath, JSON.stringify(record, null, 2));

  return filepath;
}

/**
 * Get all saved diffs for a build
 * @param {string} build - Zoom build version (or null for all)
 * @returns {Object[]}
 */
function getDiffsForBuild(build) {
  ensureDirs();

  const files = fs.readdirSync(DIFF_DIR)
    .filter(f => f.endsWith('.json'))
    .filter(f => !build || f.startsWith(build.replace(/[^a-zA-Z0-9.-]/g, '_')))
    .sort()
    .reverse();

  return files.map(f => {
    const filepath = path.join(DIFF_DIR, f);
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  });
}

/**
 * Get the most recent diff
 * @returns {Object|null}
 */
function getLatestDiff() {
  ensureDirs();

  const files = fs.readdirSync(DIFF_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  const filepath = path.join(DIFF_DIR, files[0]);
  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

/**
 * Wait for zoomus.conf to settle (stop changing)
 * @param {string} confPath - Path to zoomus.conf
 * @param {number} settleMs - Time with no changes to consider stable (default 4000ms)
 * @param {number} timeoutMs - Max wait time (default 60000ms)
 * @returns {Promise<boolean>} True if settled, false if timeout
 */
async function waitForFileSettle(confPath, settleMs = 4000, timeoutMs = 60000) {
  const start = Date.now();
  let lastMtime = 0;
  let lastChange = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const st = fs.statSync(confPath);
      const m = st.mtimeMs;

      if (m !== lastMtime) {
        lastMtime = m;
        lastChange = Date.now();
      } else if (Date.now() - lastChange > settleMs) {
        return true; // Stable
      }
    } catch (e) {
      // File might not exist yet, keep waiting
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return false; // Timeout
}

/**
 * Clean old snapshots (keep last N)
 * @param {number} keep - Number of snapshots to keep per label
 */
function cleanOldSnapshots(keep = 10) {
  ensureDirs();

  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  // Group by label
  const byLabel = {};
  for (const f of files) {
    const match = f.match(/_([^_]+)\.json$/);
    if (match) {
      const label = match[1];
      if (!byLabel[label]) byLabel[label] = [];
      byLabel[label].push(f);
    }
  }

  // Keep only last N per label
  for (const [label, labelFiles] of Object.entries(byLabel)) {
    const toDelete = labelFiles.slice(keep);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
    }
  }
}

module.exports = {
  SNAPSHOT_DIR,
  DIFF_DIR,
  takeSnapshot,
  loadSnapshot,
  compareSnapshots,
  saveDiff,
  getDiffsForBuild,
  getLatestDiff,
  waitForFileSettle,
  cleanOldSnapshots
};
