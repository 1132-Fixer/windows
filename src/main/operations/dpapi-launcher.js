/**
 * DPAPI Hook Launcher for 1132 Fixer
 *
 * Generates a random session key, then launches Zoom with the DPAPI hook
 * DLL injected. The hook intercepts CryptProtectData/CryptUnprotectData
 * to inject per-session entropy, making Zoom generate a unique device
 * fingerprint without needing a separate Windows user.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSafe } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const installer = require('./installer');

const SESSION_KEY_LEN = 32;

/**
 * Get path to session key file
 */
function getKeyPath() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
  return path.join(localAppData, '1132-Remover', 'dpapi-session.key');
}

/**
 * Generate a new random session key and write to disk
 */
function generateSessionKey() {
  const keyPath = getKeyPath();
  const keyDir = path.dirname(keyPath);

  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true });
  }

  const key = crypto.randomBytes(SESSION_KEY_LEN);
  fs.writeFileSync(keyPath, key);
  logger.ok(`Generated new DPAPI session key at ${keyPath}`);
  return keyPath;
}

/**
 * Delete the session key file
 */
function cleanupSessionKey() {
  const keyPath = getKeyPath();
  try {
    if (fs.existsSync(keyPath)) {
      fs.unlinkSync(keyPath);
      logger.info('Cleaned up session key');
    }
  } catch (_) {}
}

/**
 * Find the dpapi_hook.dll and zoom-launcher.exe paths
 * Checks: assets/ (dev), extraResources (packaged)
 */
function findBinaries() {
  const candidates = [
    // Packaged: extraResources (check FIRST — assets/ inside asar can't be executed)
    process.resourcesPath || '',
    // Development: assets/ directory
    path.join(__dirname, '..', '..', '..', 'assets'),
    // Native build directory
    path.join(__dirname, '..', '..', '..', 'native', 'dpapi_hook'),
  ];

  let dllPath = null;
  let launcherPath = null;

  for (const dir of candidates) {
    if (!dir || !fs.existsSync(dir)) continue;
    // Skip paths inside .asar archives — files exist virtually but can't be spawned
    if (dir.includes('.asar')) continue;

    const dll = path.join(dir, 'dpapi_hook.dll');
    const launcher = path.join(dir, 'zoom-launcher.exe');

    if (!dllPath && fs.existsSync(dll)) dllPath = dll;
    if (!launcherPath && fs.existsSync(launcher)) launcherPath = launcher;
  }

  return { dllPath, launcherPath };
}

/**
 * Launch Zoom with DPAPI hook injected
 * @returns {Promise<{success: boolean, method: string, error?: string}>}
 */
async function launchZoomWithDpapiHook() {
  logger.section('DPAPI HOOK LAUNCH');

  // Find Zoom
  const installed = await installer.isZoomInstalled();
  if (!installed.success) {
    return { success: false, error: 'Zoom not installed' };
  }

  const zoomExe = installed.path;
  logger.info(`Zoom path: ${zoomExe}`);

  // Find our binaries
  const { dllPath, launcherPath } = findBinaries();

  if (!dllPath) {
    logger.warn('dpapi_hook.dll not found, falling back to clean user launch');
    return installer.launchZoomAsCleanUser();
  }

  if (!launcherPath) {
    logger.warn('zoom-launcher.exe not found, falling back to clean user launch');
    return installer.launchZoomAsCleanUser();
  }

  logger.info(`DLL: ${dllPath}`);
  logger.info(`Launcher: ${launcherPath}`);

  // Generate fresh session key
  const keyPath = generateSessionKey();
  logger.info(`Session key: ${keyPath}`);

  try {
    // Launch Zoom with DLL injection
    const result = await spawnSafe(launcherPath, [zoomExe, dllPath], {
      timeout: 15000,
    });

    const output = (result.stdout || '').trim();
    logger.info(`Launcher output: ${output}`);

    if (output.startsWith('OK:')) {
      logger.ok('Zoom launched with DPAPI hook');
      return { success: true, method: 'dpapi-hook' };
    } else {
      logger.warn(`Launcher returned: ${output}`);
      // Fall back to clean user
      logger.info('Falling back to clean user launch...');
      return installer.launchZoomAsCleanUser();
    }
  } catch (e) {
    logger.error('DPAPI hook launch failed', { error: e.message });
    // Fall back to clean user
    logger.info('Falling back to clean user launch...');
    return installer.launchZoomAsCleanUser();
  }
}

module.exports = {
  launchZoomWithDpapiHook,
  generateSessionKey,
  cleanupSessionKey,
  findBinaries,
};
