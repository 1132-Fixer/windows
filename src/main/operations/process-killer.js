/**
 * CleanState Sentinel - Process Killer
 * Kills all Zoom-related processes with verification
 */

const { spawnSafe, runPowerShell, isProcessRunning } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_PROCESSES } = require('../../shared/constants');
const { stopZoomServices } = require('./services');

/**
 * Kill a single process using taskkill (fast)
 * @param {string} processName - Process name (without .exe)
 * @returns {Promise<{name: string, killed: boolean, method: string|null}>}
 */
async function killProcess(processName) {
  // Quick check if running
  const running = await isProcessRunning(processName);
  if (!running) {
    return { name: processName, killed: true, method: 'not_running', wasRunning: false };
  }

  // Use taskkill /F - fast and effective
  try {
    await spawnSafe('taskkill', ['/F', '/IM', `${processName}.exe`], { timeout: 5000 });

    // Quick verify
    if (!(await isProcessRunning(processName))) {
      return { name: processName, killed: true, method: 'taskkill', wasRunning: true };
    }
  } catch (e) {
    // Continue
  }

  // Try tree kill
  try {
    await spawnSafe('taskkill', ['/F', '/T', '/IM', `${processName}.exe`], { timeout: 5000 });
    if (!(await isProcessRunning(processName))) {
      return { name: processName, killed: true, method: 'taskkill_tree', wasRunning: true };
    }
  } catch (e) {
    // Continue
  }

  // Last resort: PowerShell
  try {
    await runPowerShell(
      `Stop-Process -Name "${processName}" -Force -ErrorAction SilentlyContinue`,
      { timeout: 5000 }
    );
    if (!(await isProcessRunning(processName))) {
      return { name: processName, killed: true, method: 'powershell', wasRunning: true };
    }
  } catch (e) {
    // Continue
  }

  logger.warn(`Could not kill: ${processName}`);
  return { name: processName, killed: false, method: null, wasRunning: true };
}

/**
 * Kill all Zoom processes
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, results: Array, killed: number, failed: number}>}
 */
async function killAllZoomProcesses(onProgress = null) {
  logger.section('Killing Zoom Processes');

  // CRITICAL: Stop Windows services FIRST
  if (onProgress) {
    onProgress({ step: 'kill', current: 0, total: 1, message: 'Stopping Zoom services...' });
  }

  const serviceResult = await stopZoomServices();

  // Short wait for service processes to exit
  await new Promise(r => setTimeout(r, 1000));

  // Find any running Zoom processes
  const runningProcesses = await findZoomProcesses();
  const allProcesses = [...new Set([...ZOOM_PROCESSES, ...runningProcesses])];

  const results = [];
  let killed = 0;
  let failed = 0;

  // Kill processes in batches for speed
  const batchSize = 10;
  for (let i = 0; i < allProcesses.length; i += batchSize) {
    const batch = allProcesses.slice(i, i + batchSize);

    if (onProgress) {
      onProgress({
        step: 'kill',
        current: Math.min(i + batchSize, allProcesses.length),
        total: allProcesses.length,
        message: `Stopping processes (${Math.min(i + batchSize, allProcesses.length)}/${allProcesses.length})...`
      });
    }

    // Process batch in parallel
    const batchResults = await Promise.all(batch.map(proc => killProcess(proc)));

    for (const result of batchResults) {
      results.push(result);
      if (result.killed && result.wasRunning) killed++;
      else if (!result.killed) failed++;
    }
  }

  // Final sweep with wildcards
  logger.info('Running final wildcard sweep...');
  try {
    await spawnSafe('taskkill', ['/F', '/IM', 'Zoom*.exe'], { timeout: 5000 }).catch(() => {});
    await spawnSafe('taskkill', ['/F', '/IM', '*Cpt*.exe'], { timeout: 5000 }).catch(() => {});
  } catch (e) {
    // Ignore
  }

  // Verify
  const remaining = await findZoomProcesses();
  if (remaining.length > 0) {
    logger.warn(`Still running after cleanup: ${remaining.join(', ')}`);
    failed += remaining.length;
  }

  const success = failed === 0;
  logger.logStep('Kill Zoom Processes', success, { killed, failed, remaining: remaining.length });

  return { success, results, killed, failed, remaining };
}

/**
 * Find all currently running Zoom-related processes
 * @returns {Promise<string[]>} Array of process names
 */
async function findZoomProcesses() {
  try {
    // Use tasklist for speed
    const result = await spawnSafe('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000 });
    const output = result.stdout || '';

    const zoomProcesses = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const match = line.match(/"([^"]+\.exe)"/i);
      if (match) {
        const procName = match[1].toLowerCase();
        if (procName.includes('zoom') || procName.includes('cpt') || procName.includes('zcs')) {
          const baseName = procName.replace('.exe', '');
          if (!zoomProcesses.includes(baseName)) {
            zoomProcesses.push(baseName);
          }
        }
      }
    }

    return zoomProcesses;
  } catch (e) {
    logger.debug('Error finding Zoom processes', { error: e.message });
    return [];
  }
}

/**
 * Check if any Zoom processes are running
 * @returns {Promise<boolean>}
 */
async function isZoomRunning() {
  const procs = await findZoomProcesses();
  return procs.length > 0;
}

/**
 * Wait for Zoom processes to exit (with timeout)
 * @param {number} timeoutMs - Maximum wait time
 * @returns {Promise<boolean>} True if all processes exited
 */
async function waitForZoomExit(timeoutMs = 10000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (!(await isZoomRunning())) {
      return true;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return false;
}

module.exports = {
  stopZoomServices,
  killProcess,
  killAllZoomProcesses,
  findZoomProcesses,
  isZoomRunning,
  waitForZoomExit
};
