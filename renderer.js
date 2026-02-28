/**
 * 1132 Eliminator - Renderer
 */

const $ = id => document.getElementById(id);

// State
let isRunning = false;
let options = { uninstall: true, reinstall: true, launch: false, sandbox: false };

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
    // If sandbox mode was used, launch through sandbox instead of bare
    if (options.sandbox) {
      addLog('info', 'Launching Zoom in sandbox...');
      const result = await window.electronAPI?.launchSandbox();
      if (result?.success) {
        const method = result.method === 'sandboxie' ? 'Sandboxie-Plus' : 'Windows Sandbox';
        addLog('ok', `Zoom launched in ${method}.`);
      } else {
        addLog('err', 'Sandbox failed: ' + (result?.error || 'Unknown'));
      }
    } else {
      await window.electronAPI?.launchZoom();
    }
  });

  $('btnStartOver')?.addEventListener('click', () => {
    completeView.classList.remove('active');
    normalView.style.display = '';
    clearLog();
    addLog('info', 'System reset. Awaiting new target.');
    setStatus('Standing By');
  });

  $('btnLaunchSandbox')?.addEventListener('click', async () => {
    addLog('info', 'Checking sandbox availability...');
    const result = await window.electronAPI?.launchSandbox();
    if (result?.success) {
      const method = result.method === 'sandboxie' ? 'Sandboxie-Plus' : 'Windows Sandbox';
      addLog('ok', `Zoom launched in ${method}. Fingerprints isolated.`);
    } else {
      addLog('err', 'Sandbox failed: ' + (result?.error || 'Unknown'));
      await window.electronAPI?.showError('No sandbox method available.\n\n' + (result?.error || 'Install Sandboxie-Plus (free) from sandboxie-plus.com.'));
    }
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

  addLog('info', 'System armed. Awaiting target.');

  // Wire up alert bar
  window._alertBar = document.getElementById('alertBar');
}

async function handleReset() {
  if (isRunning) return;

  // Confirm
  const confirmed = await window.electronAPI?.showConfirm(
    'ELIMINATION PROTOCOL\n\nThis will purge all Zoom traces from this device:\n\n' +
    (options.uninstall ? '• Uninstall Zoom\n' : '') +
    '• Eliminate all registry entries & data\n' +
    '• Purge device fingerprints\n' +
    (options.reinstall ? '• Download clean Zoom install\n' : '') +
    '\nInitiate purge?'
  );

  if (!confirmed) {
    addLog('info', 'Operation aborted.');
    return;
  }

  // Start
  isRunning = true;
  setStatus('Purging...', true);
  btnReset.disabled = true;
  progressSection.classList.add('active');
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  if (window._alertBar) window._alertBar.classList.add('active');
  clearLog();
  addLog('info', 'Elimination protocol initiated...');

  try {
    const result = await window.electronAPI.fullReset(options);

    if (result.success) {
      setStatus('Eliminated');
      addLog('ok', 'Target eliminated. All traces purged.');

      // Show complete view
      normalView.style.display = 'none';
      completeView.classList.add('active');
      completeMsg.textContent = options.reinstall
        ? 'All Zoom artifacts purged. Clean install complete.'
        : 'All Zoom traces have been eliminated from this device.';

      // Auto-launch if selected
      if (options.sandbox) {
        addLog('info', 'Launching Zoom in sandbox...');
        const sbResult = await window.electronAPI.launchSandbox();
        if (sbResult?.success) {
          const method = sbResult.method === 'sandboxie' ? 'Sandboxie-Plus' : 'Windows Sandbox';
          addLog('ok', `Zoom launched in ${method}.`);
        } else {
          addLog('err', 'Sandbox unavailable: ' + (sbResult?.error || 'Unknown'));
        }
      } else if (options.launch && options.reinstall) {
        addLog('info', 'Launching Zoom...');
        await window.electronAPI.launchZoom();
      }
    } else {
      setStatus('Failed');
      addLog('err', 'Purge failed: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    setStatus('Error');
    addLog('err', 'Error: ' + err.message);
  }

  isRunning = false;
  btnReset.disabled = false;
  progressSection.classList.remove('active');
  if (window._alertBar) window._alertBar.classList.remove('active');
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
