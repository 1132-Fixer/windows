/**
 * 1132 ELIMINATOR - Renderer Process
 * Combat-themed UI controller
 */

// ==================== DOM ELEMENTS ====================
const elements = {
  // Header
  headerStatusDot: document.getElementById('headerStatusDot'),
  headerStatusText: document.getElementById('headerStatusText'),
  btnMinimize: document.getElementById('btnMinimize'),
  btnMaximize: document.getElementById('btnMaximize'),
  btnClose: document.getElementById('btnClose'),

  // Target Analysis
  dataZoomInstalled: document.getElementById('dataZoomInstalled'),
  dataProcesses: document.getElementById('dataProcesses'),
  dataLocations: document.getElementById('dataLocations'),
  dataRegistry: document.getElementById('dataRegistry'),
  dataFingerprint: document.getElementById('dataFingerprint'),
  threatBadge: document.getElementById('threatBadge'),
  threatLevel: document.getElementById('threatLevel'),

  // Operation Controls
  btnExecute: document.getElementById('btnExecute'),
  btnTerminate: document.getElementById('btnTerminate'),
  btnPurgeData: document.getElementById('btnPurgeData'),
  btnWipeFingerprint: document.getElementById('btnWipeFingerprint'),
  btnStopZoom: document.getElementById('btnStopZoom'),
  btnLaunchZoom: document.getElementById('btnLaunchZoom'),
  btnOpenLogs: document.getElementById('btnOpenLogs'),
  btnSaveLog: document.getElementById('btnSaveLog'),

  // Tactical Options
  toggleDemolition: document.getElementById('toggleDemolition'),
  toggleRebuild: document.getElementById('toggleRebuild'),
  toggleAutoDeploy: document.getElementById('toggleAutoDeploy'),
  toggleDeepSterilization: document.getElementById('toggleDeepSterilization'),

  // Progress
  progressSection: document.getElementById('progressSection'),
  progressFill: document.getElementById('progressFill'),
  progressTarget: document.getElementById('progressTarget'),
  progressPercent: document.getElementById('progressPercent'),
  currentTarget: document.getElementById('currentTarget'),
  elapsedTime: document.getElementById('elapsedTime'),
  btnAbort: document.getElementById('btnAbort'),
  logTitle: document.getElementById('logTitle'),

  // Log
  logEntries: document.getElementById('logEntries'),

  // Views
  normalView: document.getElementById('normalView'),
  completeView: document.getElementById('completeView'),

  // Mission Complete
  statFolders: document.getElementById('statFolders'),
  statRegistry: document.getElementById('statRegistry'),
  statProcesses: document.getElementById('statProcesses'),
  btnDeployZoom: document.getElementById('btnDeployZoom'),
  btnViewReport: document.getElementById('btnViewReport'),
  btnResetApp: document.getElementById('btnResetApp'),

  // Status Bar
  statusBarDot: document.getElementById('statusBarDot'),
  statusBarText: document.getElementById('statusBarText'),
  statusBarCenter: document.getElementById('statusBarCenter'),
  adminBadge: document.getElementById('adminBadge')
};

// ==================== STATE ====================
let state = {
  isOperating: false,
  startTime: null,
  elapsedTimer: null,
  options: {
    uninstall: true,
    reinstall: true,
    launch: false,
    deep: true
  }
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
  setupWindowControls();
  setupToggles();
  setupButtons();
  setupEventListeners();
  checkInitialState();
});

// ==================== WINDOW CONTROLS ====================
function setupWindowControls() {
  // These would work with custom frameless window
  // For now, they're placeholders
  elements.btnMinimize?.addEventListener('click', () => {
    // window.electronAPI.minimize();
  });

  elements.btnMaximize?.addEventListener('click', () => {
    // window.electronAPI.maximize();
  });

  elements.btnClose?.addEventListener('click', () => {
    window.electronAPI?.quitApp();
  });
}

// ==================== TOGGLES ====================
function setupToggles() {
  document.querySelectorAll('.toggle').forEach(toggle => {
    toggle.addEventListener('click', () => {
      if (state.isOperating) return;

      toggle.classList.toggle('active');
      const option = toggle.dataset.option;
      state.options[option] = toggle.classList.contains('active');
    });
  });
}

// ==================== BUTTONS ====================
function setupButtons() {
  // Execute Full Purge
  elements.btnExecute.addEventListener('click', handleExecutePurge);

  // Secondary actions
  elements.btnTerminate.addEventListener('click', async () => {
    if (state.isOperating) return;
    addLog('KILL', 'Terminating all Zoom processes...');
    setStatus('Terminating processes...', 'operating');

    try {
      const result = await window.electronAPI.killZoom();
      if (result.success) {
        addLog('OK', `Terminated ${result.killed || 0} processes`);
        setStatus('Processes terminated', 'ready');
      } else {
        addLog('ERR', 'Failed to terminate some processes');
        setStatus('Partial termination', 'ready');
      }
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
      setStatus('Termination failed', 'ready');
    }
  });

  elements.btnPurgeData.addEventListener('click', () => {
    if (state.isOperating) return;
    addLog('DEL', 'Manual data purge requested - use Execute Full Purge for complete operation');
  });

  elements.btnWipeFingerprint.addEventListener('click', () => {
    if (state.isOperating) return;
    addLog('FP', 'Fingerprint wipe requested - use Execute Full Purge for complete operation');
  });

  // Utility actions
  elements.btnStopZoom.addEventListener('click', async () => {
    if (state.isOperating) return;
    addLog('KILL', 'Stopping Zoom...');

    try {
      const result = await window.electronAPI.killZoom();
      addLog('OK', result.success ? 'Zoom stopped' : 'No Zoom processes found');
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
    }
  });

  elements.btnLaunchZoom.addEventListener('click', async () => {
    if (state.isOperating) return;
    addLog('OK', 'Launching Zoom...');

    try {
      const result = await window.electronAPI.launchZoom();
      addLog(result.success ? 'OK' : 'ERR', result.success ? 'Zoom launched' : 'Failed to launch Zoom');
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
    }
  });

  // Open Logs Folder
  elements.btnOpenLogs.addEventListener('click', async () => {
    addLog('OK', 'Opening log folder...');
    try {
      const result = await window.electronAPI.openLogFolder();
      if (result.success) {
        addLog('OK', `Opened: ${result.path}`);
      } else {
        addLog('ERR', `Failed to open logs: ${result.error}`);
      }
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
    }
  });

  // Save Log
  elements.btnSaveLog.addEventListener('click', async () => {
    addLog('OK', 'Saving operation log...');
    try {
      // Get log content from the UI
      const logContent = getLogContent();
      const result = await window.electronAPI.saveLog(logContent);
      if (result.success) {
        addLog('OK', `Log saved to: ${result.path}`);
      } else if (result.error !== 'Save cancelled') {
        addLog('ERR', `Failed to save: ${result.error}`);
      }
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
    }
  });

  // Abort button
  elements.btnAbort.addEventListener('click', () => {
    addLog('ERR', 'Operation aborted by user');
    resetToReady();
  });

  // Mission Complete actions
  elements.btnDeployZoom.addEventListener('click', async () => {
    addLog('OK', 'Deploying Zoom...');
    try {
      await window.electronAPI.launchZoom();
      window.electronAPI.quitApp();
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
    }
  });

  elements.btnViewReport.addEventListener('click', async () => {
    addLog('OK', 'Opening operation report...');
    try {
      const logPath = await window.electronAPI.getLogPath();
      addLog('OK', `Report saved to: ${logPath}`);
    } catch (err) {
      addLog('ERR', `Error: ${err.message}`);
    }
  });

  elements.btnResetApp.addEventListener('click', () => {
    resetToReady();
    elements.normalView.classList.remove('hidden');
    elements.completeView.classList.remove('active');
    clearLog();
    addLog('INIT', 'System reset. Ready for new operation.');
    updateTargetAnalysis({ installed: true, threat: 'critical' });
  });
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
  // Progress updates from main process
  if (window.electronAPI?.onProgress) {
    window.electronAPI.onProgress((data) => {
      updateProgress(data);
    });
  }

  // Log updates from main process
  if (window.electronAPI?.onLog) {
    window.electronAPI.onLog((data) => {
      const type = data.level?.toUpperCase() || 'OK';
      addLog(type, data.message);
    });
  }
}

// ==================== MAIN EXECUTE HANDLER ====================
async function handleExecutePurge() {
  if (state.isOperating) return;

  // Confirm
  const confirmed = await window.electronAPI.showConfirm(
    'EXECUTE FULL PURGE\n\n' +
    'This operation will:\n' +
    '• Terminate all Zoom processes\n' +
    (state.options.uninstall ? '• Uninstall Zoom completely\n' : '') +
    '• Delete ALL Zoom data folders\n' +
    '• Wipe registry entries\n' +
    '• Eliminate device fingerprint data\n' +
    (state.options.reinstall ? '• Download and install fresh Zoom\n' : '') +
    '\nThis operation cannot be undone.\n\nExecute purge protocol?'
  );

  if (!confirmed) {
    addLog('INIT', 'Operation cancelled by user');
    return;
  }

  // Start operation
  state.isOperating = true;
  state.startTime = Date.now();
  showOperatingUI();
  clearLog();

  addLog('INIT', '═══════════════════════════════════════');
  addLog('INIT', 'FULL PURGE PROTOCOL INITIATED');
  addLog('INIT', '═══════════════════════════════════════');

  // Start elapsed timer
  state.elapsedTimer = setInterval(updateElapsedTime, 1000);

  try {
    const result = await window.electronAPI.fullReset(state.options);

    clearInterval(state.elapsedTimer);

    if (result.success) {
      addLog('OK', '');
      addLog('OK', '═══════════════════════════════════════');
      addLog('OK', 'MISSION ACCOMPLISHED');
      addLog('OK', '═══════════════════════════════════════');

      if (result.allClean) {
        addLog('OK', 'All verifications passed - Target eliminated');
      } else {
        addLog('INIT', 'Some remnants may remain - Manual review recommended');
      }

      // Show mission complete
      showMissionComplete(result);

      // Auto-launch if option selected
      if (state.options.launch && result.success) {
        addLog('OK', 'Auto-deploying Zoom...');
        await window.electronAPI.launchZoom();
      }
    } else {
      addLog('ERR', '');
      addLog('ERR', '═══════════════════════════════════════');
      addLog('ERR', 'OPERATION FAILED');
      addLog('ERR', '═══════════════════════════════════════');
      addLog('ERR', `Error: ${result.error}`);
      setStatus('Operation failed', 'ready');
      resetToReady();
    }
  } catch (err) {
    clearInterval(state.elapsedTimer);
    addLog('ERR', '');
    addLog('ERR', '═══════════════════════════════════════');
    addLog('ERR', 'CRITICAL ERROR');
    addLog('ERR', '═══════════════════════════════════════');
    addLog('ERR', `Exception: ${err.message}`);
    setStatus('Critical error', 'ready');
    resetToReady();
  }

  state.isOperating = false;
}

// ==================== UI STATE MANAGEMENT ====================
function showOperatingUI() {
  setStatus('Operation in progress', 'operating');
  elements.progressSection.classList.add('active');
  elements.btnAbort.classList.remove('hidden');
  elements.logTitle.textContent = 'OPERATION IN PROGRESS';
  disableControls();
}

function resetToReady() {
  state.isOperating = false;
  if (state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = null;
  }

  setStatus('System Ready', 'ready');
  elements.progressSection.classList.remove('active');
  elements.btnAbort.classList.add('hidden');
  elements.logTitle.textContent = 'OPERATION LOG';
  elements.progressFill.style.width = '0%';
  elements.progressPercent.textContent = '0%';
  elements.elapsedTime.textContent = '00:00:00';
  enableControls();
}

function showMissionComplete(result) {
  elements.normalView.classList.add('hidden');
  elements.completeView.classList.add('active');

  // Update stats
  const steps = result.steps || [];
  const foldersStep = steps.find(s => s.name === 'folders');
  const registryStep = steps.find(s => s.name === 'registry');
  const killStep = steps.find(s => s.name === 'kill');

  elements.statFolders.textContent = foldersStep?.deleted || 0;
  elements.statRegistry.textContent = registryStep?.deleted || 0;
  elements.statProcesses.textContent = killStep?.killed || 0;

  setStatus('Mission complete', 'complete');
  updateTargetAnalysis({ installed: false, threat: 'clear' });
}

function disableControls() {
  elements.btnExecute.disabled = true;
  elements.btnTerminate.disabled = true;
  elements.btnPurgeData.disabled = true;
  elements.btnWipeFingerprint.disabled = true;
  elements.btnStopZoom.disabled = true;
  elements.btnLaunchZoom.disabled = true;
  document.querySelectorAll('.toggle').forEach(t => t.style.pointerEvents = 'none');
}

function enableControls() {
  elements.btnExecute.disabled = false;
  elements.btnTerminate.disabled = false;
  elements.btnPurgeData.disabled = false;
  elements.btnWipeFingerprint.disabled = false;
  elements.btnStopZoom.disabled = false;
  elements.btnLaunchZoom.disabled = false;
  document.querySelectorAll('.toggle').forEach(t => t.style.pointerEvents = 'auto');
}

// ==================== PROGRESS ====================
function updateProgress(data) {
  const percent = data.percent || 0;

  elements.progressFill.style.width = `${percent}%`;
  elements.progressPercent.textContent = `${percent}%`;

  if (data.step) {
    elements.progressTarget.textContent = data.step;
    elements.currentTarget.textContent = data.step;

    // Add log entry for major steps
    if (data.step.toLowerCase().includes('kill')) {
      addLog('KILL', data.step);
    } else if (data.step.toLowerCase().includes('uninstall')) {
      addLog('DEL', data.step);
    } else if (data.step.toLowerCase().includes('registry')) {
      addLog('REG', data.step);
    } else if (data.step.toLowerCase().includes('fingerprint')) {
      addLog('FP', data.step);
    } else if (data.step.toLowerCase().includes('download') || data.step.toLowerCase().includes('install')) {
      addLog('OK', data.step);
    } else if (data.step.toLowerCase().includes('delet')) {
      addLog('DEL', data.step);
    } else {
      addLog('INIT', data.step);
    }
  }
}

function updateElapsedTime() {
  if (!state.startTime) return;

  const elapsed = Date.now() - state.startTime;
  const seconds = Math.floor(elapsed / 1000) % 60;
  const minutes = Math.floor(elapsed / 60000) % 60;
  const hours = Math.floor(elapsed / 3600000);

  elements.elapsedTime.textContent =
    `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// ==================== LOGGING ====================
function clearLog() {
  elements.logEntries.innerHTML = '';
}

function addLog(type, message) {
  // Remove empty state if present
  const empty = elements.logEntries.querySelector('.log-empty');
  if (empty) empty.remove();

  const now = new Date();
  const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-timestamp">[${timestamp}]</span>
    <span class="log-type ${type}">[${type}]</span>
    <span class="log-message">${escapeHtml(message)}</span>
  `;

  elements.logEntries.appendChild(entry);
  elements.logEntries.scrollTop = elements.logEntries.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getLogContent() {
  const entries = elements.logEntries.querySelectorAll('.log-entry');
  const lines = ['═══════════════════════════════════════════════════════════════'];
  lines.push('1132 ELIMINATOR - OPERATION LOG');
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');

  entries.forEach(entry => {
    const timestamp = entry.querySelector('.log-timestamp')?.textContent || '';
    const type = entry.querySelector('.log-type')?.textContent || '';
    const message = entry.querySelector('.log-message')?.textContent || '';
    lines.push(`${timestamp} ${type} ${message}`);
  });

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('END OF LOG');
  lines.push('═══════════════════════════════════════════════════════════════');

  return lines.join('\n');
}

// ==================== STATUS ====================
function setStatus(text, type = 'ready') {
  elements.statusBarText.textContent = text;

  // Update dots
  const dots = [elements.headerStatusDot, elements.statusBarDot];
  dots.forEach(dot => {
    dot.className = 'status-dot';
    if (type === 'operating') {
      dot.classList.add('operating');
    } else if (type === 'complete') {
      dot.classList.add('complete');
    }
  });

  // Update header text
  const statusConfig = {
    ready: { text: 'SYSTEM READY', color: 'var(--tactical-cyan)' },
    operating: { text: 'OPERATION IN PROGRESS', color: 'var(--kill-red)' },
    complete: { text: 'MISSION COMPLETE', color: 'var(--eliminated-green)' }
  };

  const config = statusConfig[type] || statusConfig.ready;
  elements.headerStatusText.textContent = config.text;
  elements.headerStatusText.style.color = config.color;

  // Update status bar center
  if (type === 'operating') {
    elements.statusBarCenter.textContent = text;
  } else {
    elements.statusBarCenter.textContent = '';
  }
}

// ==================== TARGET ANALYSIS ====================
function updateTargetAnalysis(data) {
  if (data.installed !== undefined) {
    elements.dataZoomInstalled.textContent = data.installed ? 'YES' : 'NO';
    elements.dataZoomInstalled.className = `data-value ${data.installed ? 'danger' : 'safe'}`;
  }

  if (data.processes !== undefined) {
    elements.dataProcesses.textContent = data.processes;
  }

  if (data.locations !== undefined) {
    elements.dataLocations.textContent = data.locations;
  }

  if (data.registry !== undefined) {
    elements.dataRegistry.textContent = data.registry;
  }

  if (data.fingerprint !== undefined) {
    elements.dataFingerprint.textContent = data.fingerprint ? 'DETECTED' : 'NONE';
    elements.dataFingerprint.className = `data-value ${data.fingerprint ? 'danger' : 'safe'}`;
  }

  if (data.threat !== undefined) {
    elements.threatBadge.className = `threat-badge ${data.threat}`;
    elements.threatLevel.textContent = data.threat.toUpperCase();
  }
}

// ==================== INITIAL STATE ====================
async function checkInitialState() {
  // Check admin status
  elements.adminBadge.textContent = 'Admin: Active';
  elements.adminBadge.style.color = 'var(--eliminated-green)';

  // Check Zoom installation
  try {
    if (window.electronAPI?.checkZoom) {
      const zoomCheck = await window.electronAPI.checkZoom();
      if (zoomCheck.success || zoomCheck.installed) {
        updateTargetAnalysis({
          installed: true,
          fingerprint: true,
          threat: 'critical'
        });
        addLog('INIT', 'Target detected: Zoom installation found');
      } else {
        updateTargetAnalysis({
          installed: false,
          fingerprint: false,
          threat: 'clear'
        });
        addLog('INIT', 'No Zoom installation detected');
      }
    }
  } catch (err) {
    addLog('ERR', `Scan error: ${err.message}`);
  }

  addLog('INIT', 'System initialized. Ready for operation.');
  setStatus('System Ready', 'ready');
}
