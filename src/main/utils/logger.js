/**
 * 1132 Remover - Persistent Logger
 * Logs all operations to file for debugging and audit trail
 */

const fs = require('fs');
const path = require('path');

// Log directory
const LOG_DIR = path.join(process.env.LOCALAPPDATA, '1132-Remover', 'logs');

// Current session log file
let currentLogFile = null;
let mainWindow = null;

// Session data for JSON export
let sessionData = {
  startTime: null,
  endTime: null,
  machine: null,
  user: null,
  steps: [],
  verification: null,
  options: null,
  success: null
};

/**
 * Initialize the logger for a new session
 * @returns {string} Path to the log file
 */
function initLogger() {
  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // Create timestamped log file
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  currentLogFile = path.join(LOG_DIR, `reset-${timestamp}.log`);

  // Initialize session data
  sessionData = {
    startTime: new Date().toISOString(),
    endTime: null,
    machine: process.env.COMPUTERNAME,
    user: process.env.USERNAME,
    steps: [],
    verification: null,
    options: null,
    success: null
  };

  // Write header
  const header = [
    '═'.repeat(60),
    '1132 REMOVER - OPERATION LOG',
    `Session started: ${new Date().toISOString()}`,
    `Machine: ${process.env.COMPUTERNAME}`,
    `User: ${process.env.USERNAME}`,
    '═'.repeat(60),
    ''
  ].join('\n');

  fs.writeFileSync(currentLogFile, header);

  return currentLogFile;
}

/**
 * Set the main window for IPC communication
 * @param {BrowserWindow} window - Electron BrowserWindow
 */
function setMainWindow(window) {
  mainWindow = window;
}

/**
 * Log levels
 */
const LEVELS = {
  INFO: 'INFO',
  OK: 'OK',
  WARN: 'WARN',
  ERROR: 'ERROR',
  DEBUG: 'DEBUG'
};

/**
 * Log a message
 * @param {string} level - Log level (INFO, OK, WARN, ERROR, DEBUG)
 * @param {string} message - Log message
 * @param {Object} data - Optional data to include
 */
function log(level, message, data = null) {
  if (!currentLogFile) {
    initLogger();
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.padEnd(5)}]`;

  // Build log line
  let logLine = `${prefix} ${message}`;
  if (data) {
    logLine += ` | ${JSON.stringify(data)}`;
  }

  // Write to file
  fs.appendFileSync(currentLogFile, logLine + '\n');

  // Send to renderer for UI display
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('log', {
        timestamp,
        level,
        message,
        data
      });
    } catch (e) {
      // Window might be closing, ignore
    }
  }

  // Also console log in development
  if (process.env.NODE_ENV === 'development') {
    const color = {
      INFO: '\x1b[36m',
      OK: '\x1b[32m',
      WARN: '\x1b[33m',
      ERROR: '\x1b[31m',
      DEBUG: '\x1b[35m'
    }[level] || '\x1b[0m';

    console.log(`${color}${prefix}\x1b[0m ${message}`);
  }
}

/**
 * Convenience methods for each log level
 */
function info(message, data) {
  log(LEVELS.INFO, message, data);
}

function ok(message, data) {
  log(LEVELS.OK, message, data);
}

function warn(message, data) {
  log(LEVELS.WARN, message, data);
}

function error(message, data) {
  log(LEVELS.ERROR, message, data);
}

function debug(message, data) {
  log(LEVELS.DEBUG, message, data);
}

/**
 * Log a step completion
 * @param {string} stepName - Name of the step
 * @param {boolean} success - Whether it succeeded
 * @param {Object} details - Additional details
 */
function logStep(stepName, success, details = {}) {
  const level = success ? LEVELS.OK : LEVELS.ERROR;
  const status = success ? 'completed' : 'FAILED';
  log(level, `${stepName}: ${status}`, details);
}

/**
 * Log a separator line
 * @param {string} title - Section title
 */
function section(title) {
  const line = '─'.repeat(50);
  log(LEVELS.INFO, line);
  log(LEVELS.INFO, `▶ ${title}`);
  log(LEVELS.INFO, line);
}

/**
 * Get the current log file path
 * @returns {string} Log file path
 */
function getLogPath() {
  return currentLogFile;
}

/**
 * Get the log directory path
 * @returns {string} Log directory path
 */
function getLogDir() {
  return LOG_DIR;
}

/**
 * Get all log files
 * @returns {string[]} Array of log file paths
 */
function getAllLogFiles() {
  if (!fs.existsSync(LOG_DIR)) {
    return [];
  }

  return fs.readdirSync(LOG_DIR)
    .filter(f => f.endsWith('.log'))
    .map(f => path.join(LOG_DIR, f))
    .sort()
    .reverse(); // Newest first
}

/**
 * Clean old log files (keep last N days)
 * @param {number} daysToKeep - Number of days to keep
 */
function cleanOldLogs(daysToKeep = 30) {
  const cutoff = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

  getAllLogFiles().forEach(logFile => {
    try {
      const stats = fs.statSync(logFile);
      if (stats.mtime.getTime() < cutoff) {
        fs.unlinkSync(logFile);
        debug(`Deleted old log: ${path.basename(logFile)}`);
      }
    } catch (e) {
      // Ignore errors
    }
  });
}

/**
 * Finalize the log session
 */
function finalize() {
  if (!currentLogFile) return;

  sessionData.endTime = new Date().toISOString();

  const footer = [
    '',
    '═'.repeat(60),
    `Session ended: ${new Date().toISOString()}`,
    '═'.repeat(60)
  ].join('\n');

  fs.appendFileSync(currentLogFile, footer);
}

/**
 * Record a step result for JSON export
 * @param {string} name - Step name
 * @param {Object} result - Step result object
 */
function recordStep(name, result) {
  sessionData.steps.push({
    name,
    timestamp: new Date().toISOString(),
    ...result
  });
}

/**
 * Set session options for JSON export
 * @param {Object} options - Session options
 */
function setSessionOptions(options) {
  sessionData.options = options;
}

/**
 * Set verification results for JSON export
 * @param {Object} verification - Verification results
 */
function setVerification(verification) {
  sessionData.verification = verification;
}

/**
 * Set session success status
 * @param {boolean} success - Whether session succeeded
 */
function setSessionSuccess(success) {
  sessionData.success = success;
}

/**
 * Get session data for JSON export
 * @returns {Object} Session data
 */
function getSessionData() {
  return {
    ...sessionData,
    durationMs: sessionData.startTime && sessionData.endTime
      ? new Date(sessionData.endTime) - new Date(sessionData.startTime)
      : null
  };
}

/**
 * Export session as JSON file
 * @returns {string} Path to JSON file
 */
function exportSessionJson() {
  if (!currentLogFile) return null;

  const jsonPath = currentLogFile.replace('.log', '.json');
  const data = getSessionData();

  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  info('Session exported to JSON', { path: jsonPath });

  return jsonPath;
}

module.exports = {
  initLogger,
  setMainWindow,
  log,
  info,
  ok,
  warn,
  error,
  debug,
  logStep,
  section,
  getLogPath,
  getLogDir,
  getAllLogFiles,
  cleanOldLogs,
  finalize,
  LEVELS,
  // JSON export
  recordStep,
  setSessionOptions,
  setVerification,
  setSessionSuccess,
  getSessionData,
  exportSessionJson
};
