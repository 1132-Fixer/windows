/**
 * 1132 Remover - Process Killer
 * Kills all Zoom-related processes with verification
 */

const { spawnSafe, runPowerShell, isProcessRunning } = require('../utils/spawn-safe');
const logger = require('../utils/logger');
const { ZOOM_PROCESSES } = require('../../shared/constants');

/**
 * Kill a single process using multiple methods
 * @param {string} processName - Process name (without .exe)
 * @returns {Promise<{name: string, killed: boolean, method: string|null}>}
 */
async function killProcess(processName) {
  // First check if it's even running
  const isRunning = await isProcessRunning(processName);
  if (!isRunning) {
    return { name: processName, killed: true, method: 'not_running', wasRunning: false };
  }

  logger.debug(`Killing process: ${processName}`);

  // Method 1: taskkill /F
  try {
    await spawnSafe('taskkill', ['/F', '/IM', `${processName}.exe`], { timeout: 10000 });
    if (!(await isProcessRunning(processName))) {
      logger.ok(`Killed ${processName} with taskkill /F`);
      return { name: processName, killed: true, method: 'taskkill', wasRunning: true };
    }
  } catch (e) {
    // Continue to next method
  }

  // Method 2: taskkill /F /T (tree kill)
  try {
    await spawnSafe('taskkill', ['/F', '/T', '/IM', `${processName}.exe`], { timeout: 10000 });
    if (!(await isProcessRunning(processName))) {
      logger.ok(`Killed ${processName} with taskkill /T`);
      return { name: processName, killed: true, method: 'taskkill_tree', wasRunning: true };
    }
  } catch (e) {
    // Continue to next method
  }

  // Method 3: PowerShell Stop-Process
  try {
    await runPowerShell(
      `Get-Process -Name "${processName}" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`
    );
    if (!(await isProcessRunning(processName))) {
      logger.ok(`Killed ${processName} with PowerShell`);
      return { name: processName, killed: true, method: 'powershell', wasRunning: true };
    }
  } catch (e) {
    // Continue to next method
  }

  // Method 4: WMIC
  try {
    await spawnSafe('wmic', ['process', 'where', `name='${processName}.exe'`, 'delete'], {
      timeout: 15000,
      shell: true
    });
    if (!(await isProcessRunning(processName))) {
      logger.ok(`Killed ${processName} with WMIC`);
      return { name: processName, killed: true, method: 'wmic', wasRunning: true };
    }
  } catch (e) {
    // Continue
  }

  // Method 5: PowerShell with Get-CimInstance (modern WMIC replacement)
  try {
    await runPowerShell(
      `Get-CimInstance Win32_Process -Filter "Name='${processName}.exe'" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    );
    if (!(await isProcessRunning(processName))) {
      logger.ok(`Killed ${processName} with CimInstance`);
      return { name: processName, killed: true, method: 'cim', wasRunning: true };
    }
  } catch (e) {
    // All methods failed
  }

  logger.error(`Failed to kill ${processName} after all methods`);
  return { name: processName, killed: false, method: null, wasRunning: true };
}

/**
 * Kill all Zoom processes
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<{success: boolean, results: Array, killed: number, failed: number}>}
 */
async function killAllZoomProcesses(onProgress = null) {
  logger.section('Killing Zoom Processes');

  const results = [];
  let killed = 0;
  let failed = 0;

  // Also catch any processes with "zoom" in the name that we might have missed
  const additionalProcesses = await findZoomProcesses();
  const allProcesses = [...new Set([...ZOOM_PROCESSES, ...additionalProcesses])];

  const total = allProcesses.length;

  for (let i = 0; i < allProcesses.length; i++) {
    const proc = allProcesses[i];

    if (onProgress) {
      onProgress({
        step: 'kill',
        current: i + 1,
        total,
        message: `Stopping ${proc}...`
      });
    }

    const result = await killProcess(proc);
    results.push(result);

    if (result.killed) {
      if (result.wasRunning) killed++;
    } else {
      failed++;
    }
  }

  // Run a final sweep with wildcard matching
  logger.info('Running final wildcard sweep...');
  await runPowerShell(
    `Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' } | Stop-Process -Force -ErrorAction SilentlyContinue`
  );

  // Verify nothing is left running
  const remaining = await findZoomProcesses();
  if (remaining.length > 0) {
    logger.warn(`Still running after cleanup: ${remaining.join(', ')}`);
    failed += remaining.length;
  }

  const success = failed === 0;
  logger.logStep('Kill Zoom Processes', success, { killed, failed, remaining: remaining.length });

  return {
    success,
    results,
    killed,
    failed,
    remaining
  };
}

/**
 * Find all currently running Zoom-related processes
 * @returns {Promise<string[]>} Array of process names
 */
async function findZoomProcesses() {
  try {
    const result = await runPowerShell(
      `Get-Process | Where-Object { $_.Name -like '*zoom*' -or $_.Name -like '*cpt*' -or $_.Name -like '*zcs*' } | Select-Object -ExpandProperty Name`
    );

    if (result.stdout) {
      return result.stdout.split('\n').map(s => s.trim()).filter(s => s);
    }
  } catch (e) {
    logger.debug('Error finding Zoom processes', { error: e.message });
  }

  return [];
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
  killProcess,
  killAllZoomProcesses,
  findZoomProcesses,
  isZoomRunning,
  waitForZoomExit
};
