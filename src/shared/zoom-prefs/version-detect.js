/**
 * Zoom Version Detection
 * Detect installed Zoom version for version-aware config templates
 */

const fs = require('fs');
const path = require('path');
const { spawnSafe } = require('../../main/utils/spawn-safe');

/**
 * Possible Zoom executable paths
 */
const ZOOM_EXE_PATHS = [
  'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
  'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe',
  path.join(process.env.LOCALAPPDATA, 'Programs', 'Zoom', 'Zoom.exe'),
  path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe')
];

/**
 * Find the Zoom executable path
 * @returns {string|null} Path to Zoom.exe or null
 */
function findZoomExe() {
  for (const p of ZOOM_EXE_PATHS) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Get Zoom version from executable file properties
 * @param {string} zoomExePath - Path to Zoom.exe
 * @returns {Promise<string|null>} Version string or null
 */
async function getZoomExeVersion(zoomExePath) {
  if (!zoomExePath || !fs.existsSync(zoomExePath)) {
    return null;
  }

  const escapedPath = zoomExePath.replace(/\\/g, '\\\\');
  const ps = `
    $p = "${escapedPath}"
    if (!(Test-Path $p)) { exit 2 }
    (Get-Item $p).VersionInfo.FileVersion
  `;

  try {
    const result = await spawnSafe('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', ps
    ], { timeout: 10000 });

    if (result.exitCode !== 0) return null;
    return result.stdout.trim() || null;
  } catch (e) {
    return null;
  }
}

/**
 * Parse version string into components
 * @param {string} versionStr - Version like "6.6.11.23272"
 * @returns {{major: number, minor: number, patch: number, build: number, raw: string}|null}
 */
function parseVersion(versionStr) {
  if (!versionStr) return null;

  // Handle various formats: "6.6.11.23272", "6.6.11", "6.6"
  const parts = versionStr.split('.').map(p => parseInt(p, 10));

  if (parts.length < 2 || parts.some(isNaN)) {
    return null;
  }

  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    build: parts[3] || 0,
    raw: versionStr
  };
}

/**
 * Detect installed Zoom version
 * @returns {Promise<{installed: boolean, path?: string, version?: Object}>}
 */
async function detectZoomVersion() {
  const exePath = findZoomExe();

  if (!exePath) {
    return { installed: false };
  }

  const versionStr = await getZoomExeVersion(exePath);
  const version = parseVersion(versionStr);

  return {
    installed: true,
    path: exePath,
    version: version || { raw: versionStr || 'unknown' }
  };
}

/**
 * Check if version matches a pattern
 * @param {Object} version - Parsed version object
 * @param {{major?: number, minor?: number}} pattern - Match pattern
 * @returns {boolean}
 */
function versionMatches(version, pattern) {
  if (!version) return false;

  if (pattern.major !== undefined && version.major !== pattern.major) {
    return false;
  }

  if (pattern.minor !== undefined && version.minor !== pattern.minor) {
    return false;
  }

  return true;
}

/**
 * Compare two versions
 * @param {Object} a - First version
 * @param {Object} b - Second version
 * @returns {number} -1 if a < b, 0 if equal, 1 if a > b
 */
function compareVersions(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.build !== b.build) return a.build - b.build;

  return 0;
}

module.exports = {
  ZOOM_EXE_PATHS,
  findZoomExe,
  getZoomExeVersion,
  parseVersion,
  detectZoomVersion,
  versionMatches,
  compareVersions
};
