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
        const methodName = result.method === 'sandboxie' ? 'Sandboxie-Plus'
          : result.method === 'vm' ? 'VirtualBox VM'
          : 'Windows Sandbox';
        addLog('ok', `Zoom launched in ${methodName}.`);
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
      const methodName = result.method === 'sandboxie' ? 'Sandboxie-Plus'
        : result.method === 'vm' ? 'VirtualBox VM'
        : 'Windows Sandbox';
      addLog('ok', `Zoom launched in ${methodName}. Fingerprints isolated.`);
    } else {
      addLog('err', 'Sandbox failed: ' + (result?.error || 'Unknown'));
      await window.electronAPI?.showError('No sandbox method available.\n\n' + (result?.error || 'Use VM Setup for best results.'));
    }
  });

  // VM Setup flow
  $('btnVMSetup')?.addEventListener('click', handleVMSetup);

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
          const methodName = sbResult.method === 'sandboxie' ? 'Sandboxie-Plus'
            : sbResult.method === 'vm' ? 'VirtualBox VM'
            : 'Windows Sandbox';
          addLog('ok', `Zoom launched in ${methodName}.`);
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

// ==========================================
// VM SETUP FLOW
// ==========================================

async function handleVMSetup() {
  addLog('info', 'Checking VM status...');

  const status = await window.electronAPI?.getVMStatus();
  if (!status) {
    addLog('err', 'Failed to get VM status');
    return;
  }

  // VM already exists and ready
  if (status.vmExists) {
    if (status.vmState === 'running') {
      addLog('ok', 'Zoom VM is already running.');
      return;
    }
    const launch = await window.electronAPI?.showConfirm(
      'Zoom VM already exists.\n\nLaunch it now?'
    );
    if (launch) {
      addLog('info', 'Starting Zoom VM...');
      const result = await window.electronAPI?.launchZoomVM();
      if (result?.success) {
        addLog('ok', 'Zoom VM started. Use Zoom inside the VM window.');
      } else {
        addLog('err', 'VM launch failed: ' + (result?.error || 'Unknown'));
      }
    }
    return;
  }

  // Need to set up VM — check VirtualBox first
  if (!status.vboxInstalled) {
    const installVBox = await window.electronAPI?.showConfirm(
      'VirtualBox is not installed.\n\n' +
      'VirtualBox creates a virtual PC with completely different hardware IDs — ' +
      'the only reliable way to bypass hardware-level 1132 bans on Windows Home.\n\n' +
      'Download and install VirtualBox (~100 MB)?'
    );
    if (!installVBox) {
      addLog('info', 'VM setup cancelled.');
      return;
    }
    addLog('info', 'Downloading & installing VirtualBox...');
    const installResult = await window.electronAPI?.installVBox();
    if (!installResult?.success) {
      addLog('err', 'VirtualBox install failed: ' + (installResult?.error || 'Unknown'));
      await window.electronAPI?.showError('VirtualBox installation failed.\n\n' + (installResult?.error || ''));
      return;
    }
    addLog('ok', 'VirtualBox installed (v' + (installResult.version || '?') + ')');
  }

  // Need a Windows ISO
  let isoPath = null;

  if (status.isos && status.isos.length > 0) {
    // Found ISOs automatically
    const useFound = await window.electronAPI?.showConfirm(
      'Found Windows ISO:\n' + status.isos[0] + '\n\nUse this ISO to create the Zoom VM?'
    );
    if (useFound) {
      isoPath = status.isos[0];
    }
  }

  if (!isoPath) {
    // Ask user to pick ISO
    addLog('info', 'Select a Windows 10/11 ISO file...');
    const isoResult = await window.electronAPI?.selectISO();
    if (!isoResult?.selected) {
      addLog('info', 'No ISO selected. VM setup cancelled.');
      await window.electronAPI?.showError(
        'A Windows 10 or 11 ISO is needed to create the VM.\n\n' +
        'Download one from microsoft.com/software-download/windows11'
      );
      return;
    }
    isoPath = isoResult.path;
  }

  // Create VM
  addLog('info', 'Creating Zoom VM with spoofed hardware...');
  addLog('info', 'ISO: ' + isoPath);

  const setupResult = await window.electronAPI?.setupZoomVM(isoPath);
  if (setupResult?.success) {
    addLog('ok', 'Zoom VM created and started!');
    addLog('ok', setupResult.message || 'Windows is installing automatically (~15 min).');
    await window.electronAPI?.showSuccess(
      'Zoom VM Created!\n\n' +
      'Windows is installing automatically inside the VM.\n' +
      'This takes about 15 minutes.\n\n' +
      'Once Windows is ready, install Zoom inside the VM and use it for meetings.\n' +
      'The VM has completely different hardware IDs — 1132 ban will not apply.'
    );
  } else {
    addLog('err', 'VM setup failed: ' + (setupResult?.error || 'Unknown'));
    await window.electronAPI?.showError('VM setup failed:\n\n' + (setupResult?.error || 'Unknown error'));
  }
}
