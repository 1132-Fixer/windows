/**
 * 1132 Remover - Self-Test Mode
 * Dry run that checks what would be cleaned without making changes
 */

const fs = require('fs');
const logger = require('../utils/logger');
const { registryKeyExists } = require('../utils/spawn-safe');
const {
  ZOOM_DATA_PATHS,
  REGISTRY_KEYS,
  FINGERPRINT_LOCATIONS,
  ZOOM_SERVICES,
  ZOOM_EXECUTABLE_PATHS
} = require('../../shared/constants');

/**
 * Check if Zoom is installed
 * @returns {Promise<{installed: boolean, path?: string}>}
 */
async function checkZoomInstalled() {
  for (const p of ZOOM_EXECUTABLE_PATHS) {
    if (fs.existsSync(p)) {
      return { installed: true, path: p };
    }
  }
  return { installed: false };
}

/**
 * Count existing registry keys
 * @returns {Promise<{count: number, keys: string[]}>}
 */
async function checkRegistryKeys() {
  const foundKeys = [];

  // Check all registry key categories
  const allKeys = [
    ...REGISTRY_KEYS.HKCU,
    ...REGISTRY_KEYS.HKLM,
    ...REGISTRY_KEYS.WOW64,
    ...REGISTRY_KEYS.HKCR
  ];

  for (const key of allKeys) {
    if (await registryKeyExists(key)) {
      foundKeys.push(key);
    }
  }

  return { count: foundKeys.length, keys: foundKeys };
}

/**
 * Count existing data folders
 * @returns {{count: number, folders: string[]}}
 */
function checkDataFolders() {
  const foundFolders = [];

  for (const p of ZOOM_DATA_PATHS) {
    if (fs.existsSync(p)) {
      foundFolders.push(p);
    }
  }

  return { count: foundFolders.length, folders: foundFolders };
}

/**
 * Count existing fingerprint files
 * @returns {{count: number, files: string[]}}
 */
function checkFingerprintFiles() {
  const foundFiles = [];

  // Check telemetry databases
  for (const p of FINGERPRINT_LOCATIONS.telemetryDatabases) {
    if (fs.existsSync(p)) {
      foundFiles.push(p);
    }
  }

  // Check CptService folders
  for (const p of FINGERPRINT_LOCATIONS.cptServiceFolders) {
    if (fs.existsSync(p)) {
      foundFiles.push(p);
    }
  }

  return { count: foundFiles.length, files: foundFiles };
}

/**
 * Check for running Zoom services
 * @returns {Promise<{count: number, services: string[]}>}
 */
async function checkServices() {
  const { runPowerShell } = require('../utils/spawn-safe');
  const runningServices = [];

  for (const svc of ZOOM_SERVICES) {
    try {
      const result = await runPowerShell(
        `Get-Service -Name "${svc}" -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | Measure-Object | Select-Object -ExpandProperty Count`,
        { timeout: 5000, rejectOnError: false }
      );
      const count = parseInt(result.stdout, 10);
      if (!isNaN(count) && count > 0) {
        runningServices.push(svc);
      }
    } catch (e) {
      // Service doesn't exist, that's fine
    }
  }

  return { count: runningServices.length, services: runningServices };
}

/**
 * Run complete self-test
 * @returns {Promise<Object>} Self-test results
 */
async function runSelfTest() {
  logger.section('SELF-TEST - Checking System State');

  // Check Zoom installation
  logger.info('Checking Zoom installation...');
  const zoomCheck = await checkZoomInstalled();
  logger.info('Zoom installed:', zoomCheck);

  // Check registry
  logger.info('Checking registry keys...');
  const registryCheck = await checkRegistryKeys();
  logger.info(`Found ${registryCheck.count} registry keys`);
  if (registryCheck.count > 0) {
    logger.debug('Registry keys found:', { keys: registryCheck.keys.slice(0, 10) });
  }

  // Check data folders
  logger.info('Checking data folders...');
  const folderCheck = checkDataFolders();
  logger.info(`Found ${folderCheck.count} data folders`);
  if (folderCheck.count > 0) {
    logger.debug('Folders found:', { folders: folderCheck.folders.slice(0, 10) });
  }

  // Check fingerprint files
  logger.info('Checking fingerprint files...');
  const fingerprintCheck = checkFingerprintFiles();
  logger.info(`Found ${fingerprintCheck.count} fingerprint files`);
  if (fingerprintCheck.count > 0) {
    logger.debug('Fingerprint files found:', { files: fingerprintCheck.files });
  }

  // Check services
  logger.info('Checking Zoom services...');
  const serviceCheck = await checkServices();
  logger.info(`Found ${serviceCheck.count} running services`);
  if (serviceCheck.count > 0) {
    logger.debug('Running services:', { services: serviceCheck.services });
  }

  // Determine if cleanup is needed
  const needsCleanup = registryCheck.count > 0 ||
                       folderCheck.count > 0 ||
                       fingerprintCheck.count > 0 ||
                       serviceCheck.count > 0;

  const results = {
    timestamp: new Date().toISOString(),
    zoomInstalled: zoomCheck.installed,
    zoomPath: zoomCheck.path || null,
    registryCount: registryCheck.count,
    registryKeys: registryCheck.keys,
    folderCount: folderCheck.count,
    folders: folderCheck.folders,
    fingerprintCount: fingerprintCheck.count,
    fingerprintFiles: fingerprintCheck.files,
    serviceCount: serviceCheck.count,
    services: serviceCheck.services,
    needsCleanup,
    allPassed: true // Self-test always passes, it's just a check
  };

  logger.section('SELF-TEST COMPLETE');
  logger.info('Results:', {
    zoomInstalled: results.zoomInstalled,
    registryCount: results.registryCount,
    folderCount: results.folderCount,
    fingerprintCount: results.fingerprintCount,
    serviceCount: results.serviceCount,
    needsCleanup: results.needsCleanup
  });

  if (needsCleanup) {
    logger.info('Recommendation: Run full reset to clean detected items');
  } else {
    logger.ok('System is clean - no Zoom artifacts detected');
  }

  return results;
}

module.exports = {
  runSelfTest,
  checkZoomInstalled,
  checkRegistryKeys,
  checkDataFolders,
  checkFingerprintFiles,
  checkServices
};
