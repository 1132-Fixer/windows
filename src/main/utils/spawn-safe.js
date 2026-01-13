/**
 * 1132 Remover - Safe Process Spawning
 * Wrapper around child_process.spawn with timeout and error handling
 */

const { spawn } = require('child_process');

/**
 * Spawn a process with timeout and proper error handling
 * @param {string} command - The command to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Options
 * @param {number} options.timeout - Timeout in ms (default: 30000)
 * @param {boolean} options.windowsHide - Hide window (default: true)
 * @param {boolean} options.shell - Use shell (default: false)
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
function spawnSafe(command, args = [], options = {}) {
  const timeout = options.timeout || 30000;
  const windowsHide = options.windowsHide !== false;
  const shell = options.shell || false;

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const proc = spawn(command, args, {
      windowsHide,
      shell,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeout);

    // Capture stdout
    if (proc.stdout) {
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
    }

    // Capture stderr
    if (proc.stderr) {
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    }

    // Process completed
    proc.on('close', (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`Timeout after ${timeout}ms: ${command} ${args.join(' ')}`));
        return;
      }

      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        success: code === 0
      });
    });

    // Process error (e.g., command not found)
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ${command}: ${err.message}`));
    });
  });
}

/**
 * Run a PowerShell command with timeout
 * @param {string} script - PowerShell script to run
 * @param {Object} options - Options
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function runPowerShell(script, options = {}) {
  const timeout = options.timeout || 60000;

  // Escape the script for command line
  const escapedScript = script.replace(/"/g, '\\"');

  return spawnSafe('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    escapedScript
  ], {
    timeout,
    windowsHide: true
  });
}

/**
 * Run a command and return true if exit code is 0
 * @param {string} command - Command to run
 * @param {string[]} args - Arguments
 * @param {Object} options - Options
 * @returns {Promise<boolean>}
 */
async function runCommand(command, args = [], options = {}) {
  try {
    const result = await spawnSafe(command, args, options);
    return result.exitCode === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Check if a process is running
 * @param {string} processName - Process name (without .exe)
 * @returns {Promise<boolean>}
 */
async function isProcessRunning(processName) {
  try {
    const result = await runPowerShell(
      `Get-Process -Name "${processName}" -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`
    );
    const count = parseInt(result.stdout, 10);
    return !isNaN(count) && count > 0;
  } catch (e) {
    return false;
  }
}

/**
 * Check if a registry key exists
 * @param {string} keyPath - Registry key path (e.g., "HKCU\\Software\\Zoom")
 * @returns {Promise<boolean>}
 */
async function registryKeyExists(keyPath) {
  try {
    const result = await spawnSafe('reg', ['query', keyPath], { timeout: 5000 });
    return result.exitCode === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Delete a registry key
 * @param {string} keyPath - Registry key path
 * @returns {Promise<{success: boolean, existed: boolean}>}
 */
async function deleteRegistryKey(keyPath) {
  const existed = await registryKeyExists(keyPath);

  if (!existed) {
    return { success: true, existed: false };
  }

  try {
    const result = await spawnSafe('reg', ['delete', keyPath, '/f'], { timeout: 10000 });
    const stillExists = await registryKeyExists(keyPath);

    return {
      success: !stillExists,
      existed: true,
      deleted: !stillExists
    };
  } catch (e) {
    return { success: false, existed: true, error: e.message };
  }
}

/**
 * Delete a registry value
 * @param {string} keyPath - Registry key path
 * @param {string} valueName - Value name to delete
 * @returns {Promise<{success: boolean}>}
 */
async function deleteRegistryValue(keyPath, valueName) {
  try {
    const result = await spawnSafe('reg', ['delete', keyPath, '/v', valueName, '/f'], { timeout: 5000 });
    return { success: result.exitCode === 0 };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = {
  spawnSafe,
  runPowerShell,
  runCommand,
  isProcessRunning,
  registryKeyExists,
  deleteRegistryKey,
  deleteRegistryValue
};
