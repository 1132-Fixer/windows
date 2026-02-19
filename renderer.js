/**
 * 1132 Remover - Renderer
 */

const $ = id => document.getElementById(id);

// State
let isRunning = false;
let options = { uninstall: true, reinstall: true, launch: false };

// Elements
const statusDot = $('statusDot');
const statusText = $('statusText');
const btnReset = $('btnReset');
const progressSection = $('progressSection');
const progressFill = $('progressFill');
const progressLabel = $('progressLabel');
const progressPercent = $('progressPercent');
const logContent = $('logContent');
const normalView = $('normalView');
const completeView = $('completeView');
const completeMsg = $('completeMsg');
const adminStatus = $('adminStatus');

// Initialize
document.addEventListener('DOMContentLoaded', init);

function init() {
  // Setup checkboxes
  document.querySelectorAll('.option-checkbox').forEach(cb => {
    cb.addEventListener('click', (e) => {
      e.preventDefault();
      if (isRunning) return;
      cb.classList.toggle('checked');
      options[cb.dataset.option] = cb.classList.contains('checked');
    });
  });

  // Main button
  btnReset.addEventListener('click', handleReset);

  // Log actions
  $('btnCopyLog')?.addEventListener('click', copyLog);
  $('btnClearLog')?.addEventListener('click', clearLog);
  $('btnOpenLogs')?.addEventListener('click', () => window.electronAPI?.openLogFolder());

  // Complete view buttons
  $('btnLaunchZoom')?.addEventListener('click', async () => {
    await window.electronAPI?.launchZoom();
  });

  $('btnStartOver')?.addEventListener('click', () => {
    completeView.classList.remove('active');
    normalView.style.display = '';
    clearLog();
    addLog('info', 'Ready for another reset.');
    setStatus('Ready');
  });

  // Progress updates from main process
  window.electronAPI?.onProgress?.(data => {
    if (data.percent !== undefined) {
      progressFill.style.width = data.percent + '%';
      progressPercent.textContent = data.percent + '%';
    }
    if (data.step) {
      progressLabel.textContent = data.step;
      addLog('info', data.step);
    }
  });

  // Log updates from main process
  window.electronAPI?.onLog?.(data => {
    const type = data.level === 'error' ? 'err' : data.level === 'ok' ? 'ok' : 'info';
    addLog(type, data.message);
  });

  // Check admin status
  adminStatus.textContent = 'Administrator';

  addLog('info', 'System ready.');
}

async function handleReset() {
  if (isRunning) return;

  // Confirm
  const confirmed = await window.electronAPI?.showConfirm(
    'This will completely reset Zoom and remove device fingerprints.\n\n' +
    (options.uninstall ? '• Uninstall Zoom\n' : '') +
    '• Delete all Zoom data & registry entries\n' +
    '• Wipe device fingerprints\n' +
    (options.reinstall ? '• Download and reinstall Zoom\n' : '') +
    '\nContinue?'
  );

  if (!confirmed) {
    addLog('info', 'Cancelled by user.');
    return;
  }

  // Start
  isRunning = true;
  setStatus('Running...', true);
  btnReset.disabled = true;
  progressSection.classList.add('active');
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  clearLog();
  addLog('info', 'Starting Zoom reset...');

  try {
    const result = await window.electronAPI.fullReset(options);

    if (result.success) {
      setStatus('Complete');
      addLog('ok', 'Reset completed successfully!');

      // Show complete view
      normalView.style.display = 'none';
      completeView.classList.add('active');
      completeMsg.textContent = options.reinstall
        ? 'Zoom has been reset and reinstalled successfully.'
        : 'Zoom has been completely removed from this device.';

      // Auto-launch if selected
      if (options.launch && options.reinstall) {
        addLog('info', 'Launching Zoom...');
        await window.electronAPI.launchZoom();
      }
    } else {
      setStatus('Failed');
      addLog('err', 'Reset failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    setStatus('Error');
    addLog('err', 'Error: ' + err.message);
  }

  isRunning = false;
  btnReset.disabled = false;
  progressSection.classList.remove('active');
}

function setStatus(text, running = false) {
  statusText.textContent = text;
  statusDot.classList.toggle('running', running);
}

function clearLog() {
  logContent.innerHTML = '';
}

function addLog(type, msg) {
  // Remove empty state
  const empty = logContent.querySelector('.log-empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = new Date().toLocaleTimeString('en-US', { hour12: false });

  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${type}">${escapeHtml(msg)}</span>`;

  logContent.appendChild(entry);
  logContent.scrollTop = logContent.scrollHeight;
}

function copyLog() {
  const entries = logContent.querySelectorAll('.log-entry');
  const lines = [];

  entries.forEach(entry => {
    const time = entry.querySelector('.log-time')?.textContent || '';
    const msg = entry.querySelector('.log-msg')?.textContent || '';
    lines.push(`${time} ${msg}`);
  });

  const text = lines.join('\n');

  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      addLog('ok', 'Log copied to clipboard');
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    addLog('ok', 'Log copied to clipboard');
  } catch (e) {
    addLog('err', 'Failed to copy log');
  }
  document.body.removeChild(textarea);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
