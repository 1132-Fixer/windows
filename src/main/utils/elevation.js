/**
 * CleanState Sentinel - Elevation Helper
 *
 * Handles requesting elevation for privileged operations.
 * The app runs as normal user by default and requests elevation
 * only when needed, with explicit user consent.
 *
 * SECURITY MODEL:
 * - App starts as non-elevated
 * - Elevation is requested only for specific operations
 * - User must explicitly consent via UAC prompt
 * - Elevated operations run for shortest possible duration
 */

const { spawn } = require('child_process');
const path = require('path');
const { dialog } = require('electron');

/**
 * Check if the current process is running elevated
 * @returns {Promise<boolean>}
 */
async function isElevated() {
  return new Promise((resolve) => {
    const proc = spawn('net', ['session'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Operations that require elevation
 */
const PRIVILEGED_OPERATIONS = {
  STOP_SERVICE: 'stop_service',
  DELETE_SERVICE: 'delete_service',
  MODIFY_HKLM_REGISTRY: 'modify_hklm_registry',
  DELETE_PROTECTED_FILE: 'delete_protected_file',
  CREATE_SCHEDULED_TASK: 'create_scheduled_task',
  DELETE_SCHEDULED_TASK: 'delete_scheduled_task',
  CLEAR_PREFETCH: 'clear_prefetch',
  MODIFY_SYSTEM_DATABASE: 'modify_system_database',
};

/**
 * Human-readable descriptions for privileged operations
 */
const OPERATION_DESCRIPTIONS = {
  [PRIVILEGED_OPERATIONS.STOP_SERVICE]: 'Stop system services',
  [PRIVILEGED_OPERATIONS.DELETE_SERVICE]: 'Remove system services',
  [PRIVILEGED_OPERATIONS.MODIFY_HKLM_REGISTRY]: 'Modify system registry keys',
  [PRIVILEGED_OPERATIONS.DELETE_PROTECTED_FILE]: 'Delete protected system files',
  [PRIVILEGED_OPERATIONS.CREATE_SCHEDULED_TASK]: 'Create scheduled tasks',
  [PRIVILEGED_OPERATIONS.DELETE_SCHEDULED_TASK]: 'Remove scheduled tasks',
  [PRIVILEGED_OPERATIONS.CLEAR_PREFETCH]: 'Clear Windows prefetch data',
  [PRIVILEGED_OPERATIONS.MODIFY_SYSTEM_DATABASE]: 'Modify system databases',
};

/**
 * Check if an operation requires elevation
 * @param {string} operation - Operation type from PRIVILEGED_OPERATIONS
 * @returns {boolean}
 */
function requiresElevation(operation) {
  return Object.values(PRIVILEGED_OPERATIONS).includes(operation);
}

/**
 * Request user consent for elevation
 * @param {string[]} operations - List of operations that need elevation
 * @param {BrowserWindow} parentWindow - Parent window for dialog
 * @returns {Promise<boolean>} - True if user consented
 */
async function requestElevationConsent(operations, parentWindow = null) {
  const operationList = operations
    .map((op) => OPERATION_DESCRIPTIONS[op] || op)
    .join('\n• ');

  const message = `The following operations require administrator privileges:\n\n• ${operationList}\n\nWindows will prompt you for permission. Continue?`;

  const result = await dialog.showMessageBox(parentWindow, {
    type: 'warning',
    title: 'Administrator Privileges Required',
    message: 'Elevation Required',
    detail: message,
    buttons: ['Continue', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  return result.response === 0;
}

/**
 * Run a command with elevation via PowerShell's Start-Process -Verb RunAs
 * This triggers UAC and runs the command elevated
 *
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {Object} options - Options
 * @param {boolean} options.waitForExit - Wait for the elevated process to complete
 * @param {number} options.timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, exitCode: number, error?: string}>}
 */
async function runElevated(command, args = [], options = {}) {
  const { waitForExit = true, timeout = 60000 } = options;

  // Build the command string
  const escapedArgs = args.map((arg) => {
    // Escape single quotes for PowerShell
    return `'${arg.replace(/'/g, "''")}'`;
  }).join(',');

  const psCommand = `
    $process = Start-Process -FilePath '${command}' -ArgumentList ${escapedArgs || "''"} -Verb RunAs -PassThru ${waitForExit ? '-Wait' : ''}
    if ($process) { exit $process.ExitCode } else { exit 1 }
  `.trim();

  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', psCommand,
    ], {
      windowsHide: true,
      shell: false,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve({
        success: false,
        exitCode: -1,
        error: 'Operation timed out',
      });
    }, timeout);

    proc.on('close', (code) => {
      if (!timedOut) {
        clearTimeout(timer);
        resolve({
          success: code === 0,
          exitCode: code || 0,
        });
      }
    });

    proc.on('error', (err) => {
      if (!timedOut) {
        clearTimeout(timer);
        resolve({
          success: false,
          exitCode: -1,
          error: err.message,
        });
      }
    });
  });
}

/**
 * Run a batch of commands elevated (single UAC prompt)
 * Creates a temporary script and runs it elevated
 *
 * @param {Array<{command: string, args: string[]}>} commands - Commands to run
 * @param {Object} options - Options
 * @returns {Promise<{success: boolean, results: Array<{command: string, success: boolean}>}>}
 */
async function runElevatedBatch(commands, options = {}) {
  const fs = require('fs').promises;
  const os = require('os');
  const crypto = require('crypto');

  // Create a temporary batch script
  const scriptId = crypto.randomBytes(8).toString('hex');
  const scriptPath = path.join(os.tmpdir(), `cleanstate_elevated_${scriptId}.bat`);

  try {
    // Build batch script content
    const scriptLines = [
      '@echo off',
      'setlocal EnableDelayedExpansion',
      '',
    ];

    commands.forEach(({ command, args }, index) => {
      const fullCommand = args.length > 0
        ? `"${command}" ${args.map((a) => `"${a}"`).join(' ')}`
        : `"${command}"`;
      scriptLines.push(`REM Command ${index + 1}`);
      scriptLines.push(fullCommand);
      scriptLines.push('');
    });

    scriptLines.push('endlocal');

    await fs.writeFile(scriptPath, scriptLines.join('\r\n'), 'utf-8');

    // Run the script elevated
    const result = await runElevated('cmd.exe', ['/c', scriptPath], options);

    return {
      success: result.success,
      results: commands.map((cmd) => ({
        command: cmd.command,
        success: result.success, // Batch is all-or-nothing
      })),
    };
  } finally {
    // Clean up the temporary script
    try {
      await fs.unlink(scriptPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Execute a privileged operation with consent flow
 *
 * @param {string} operation - Operation type from PRIVILEGED_OPERATIONS
 * @param {Function} executor - Async function that performs the operation
 * @param {BrowserWindow} parentWindow - Parent window for dialogs
 * @returns {Promise<{success: boolean, elevated: boolean, result?: any, error?: string}>}
 */
async function executePrivileged(operation, executor, parentWindow = null) {
  // Check if already elevated
  const elevated = await isElevated();

  if (elevated) {
    // Already elevated, just run
    try {
      const result = await executor();
      return { success: true, elevated: true, result };
    } catch (error) {
      return {
        success: false,
        elevated: true,
        error: error.message || 'Operation failed',
      };
    }
  }

  // Not elevated - request consent
  const consented = await requestElevationConsent([operation], parentWindow);

  if (!consented) {
    return {
      success: false,
      elevated: false,
      error: 'User declined elevation',
    };
  }

  // Try to run elevated
  try {
    const result = await executor();
    return { success: true, elevated: false, result };
  } catch (error) {
    return {
      success: false,
      elevated: false,
      error: error.message || 'Operation failed',
    };
  }
}

module.exports = {
  isElevated,
  requiresElevation,
  requestElevationConsent,
  runElevated,
  runElevatedBatch,
  executePrivileged,
  PRIVILEGED_OPERATIONS,
  OPERATION_DESCRIPTIONS,
};
