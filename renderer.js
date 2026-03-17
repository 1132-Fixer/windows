/**
 * 1132 Fixer - Renderer (Streamlined)
 */

const $ = id => document.getElementById(id);

let isRunning = false;
const options = { launch: true };

// Ring circumference for progress (2*pi*90 ~ 565)
const RING_CIRC = 565;

async function init() {
  // Version
  try {
    const v = await window.electronAPI.getVersion();
    $('appVersion').textContent = 'v' + v;
  } catch (_) {}

  // Toggle switches
  document.querySelectorAll('.toggle').forEach(t => {
    t.addEventListener('click', () => {
      if (isRunning) return;
      const key = t.dataset.key;
      t.classList.toggle('on');
      options[key] = t.classList.contains('on');
    });
  });

  // FIX button
  $('btnFix').addEventListener('click', handleFix);

  // Launch Zoom
  $('btnLaunch').addEventListener('click', async () => {
    $('btnLaunch').textContent = 'Launching...';
    try { await window.electronAPI.launchZoom(); } catch (_) {}
    $('btnLaunch').textContent = 'Launch Zoom';
  });

  // Start Over
  $('btnReset').addEventListener('click', resetUI);

  // Exit
  $('btnExit').addEventListener('click', () => window.electronAPI.quitApp());

  // Auto-update listener
  window.electronAPI.onUpdateStatus((data) => {
    if (!data) return;
    const overlay = $('updateOverlay');
    const icon = $('updateIcon');
    const title = $('updateTitle');
    const msg = $('updateMsg');
    const pct = $('updatePct');
    const fill = $('updateFill');
    const card = $('updateCard');

    if (data.status === 'available' || data.status === 'downloading') {
      overlay.classList.add('show');
      icon.textContent = '\u231B';
      title.textContent = 'Downloading Update';
      msg.textContent = data.version ? `Version ${data.version} is being downloaded...` : 'Downloading...';
      pct.textContent = (data.percent || 0) + '%';
      fill.style.width = (data.percent || 0) + '%';
    } else if (data.status === 'ready') {
      card.className = 'update-card ready';
      icon.textContent = '\u2705';
      title.textContent = 'Update Ready';
      msg.textContent = 'Restarting now...';
      pct.textContent = '100%';
      fill.style.width = '100%';
    }
  });

  // Progress listener
  window.electronAPI.onProgress((data) => {
    if (!data) return;
    const pct = data.percent || 0;

    $('progressFill').style.width = pct + '%';
    $('btnPct').textContent = Math.round(pct) + '%';

    if (data.step) {
      $('statusText').textContent = data.step;
    }
  });
}

async function handleFix() {
  if (isRunning) return;

  const confirmed = await window.electronAPI.showConfirmDialog(
    'This will:\n\n' +
    '1. Kill all Zoom processes\n' +
    '2. Change MachineGuid and volume serial\n' +
    '3. Relaunch Zoom\n\n' +
    'Zoom will restart with a new device identity.\n\nContinue?'
  );
  if (!confirmed) return;

  isRunning = true;
  const btn = $('btnFix');
  btn.classList.add('running');
  btn.disabled = true;
  $('progressBar').classList.add('active');
  $('statusText').textContent = 'Starting...';
  $('statusText').classList.add('active');
  $('statusBadge').className = 'status-badge running';
  $('statusBadgeText').textContent = 'Fixing...';
  $('postActions').classList.remove('show');

  document.querySelectorAll('.toggle').forEach(t => t.classList.add('disabled'));

  try {
    const result = await window.electronAPI.fullReset(options);

    if (result && result.success) {
      btn.classList.remove('running');
      btn.classList.add('done');
      $('statusText').textContent = 'Device identity reset — Zoom relaunched';
      $('statusText').classList.remove('active');
      $('statusText').classList.add('done');
      $('statusBadge').className = 'status-badge done';
      $('statusBadgeText').textContent = 'Fixed';
      $('progressBar').classList.remove('active');
      $('postActions').classList.add('show');
    } else {
      $('statusText').textContent = 'Fix failed — ' + (result?.error || 'unknown error');
      $('statusText').classList.remove('active');
      btn.classList.remove('running');
      btn.disabled = false;
      $('progressBar').classList.remove('active');
      $('statusBadge').className = 'status-badge error';
      $('statusBadgeText').textContent = 'Failed';
      isRunning = false;
      document.querySelectorAll('.toggle').forEach(t => t.classList.remove('disabled'));
    }
  } catch (err) {
    $('statusText').textContent = 'Error: ' + err.message;
    $('statusText').classList.remove('active');
    btn.classList.remove('running');
    btn.disabled = false;
    $('progressBar').classList.remove('active');
    $('statusBadge').className = 'status-badge error';
    $('statusBadgeText').textContent = 'Error';
    isRunning = false;
    document.querySelectorAll('.toggle').forEach(t => t.classList.remove('disabled'));
  }
}

function resetUI() {
  isRunning = false;
  const btn = $('btnFix');
  btn.classList.remove('running', 'done');
  btn.disabled = false;
  $('btnPct').textContent = '0%';
  $('progressBar').classList.remove('active');
  $('progressFill').style.width = '0%';
  $('statusText').textContent = '';
  $('statusText').classList.remove('active', 'done');
  $('statusBadge').className = 'status-badge';
  $('statusBadgeText').textContent = 'Ready';
  $('postActions').classList.remove('show');
  document.querySelectorAll('.toggle').forEach(t => t.classList.remove('disabled'));
}

document.addEventListener('DOMContentLoaded', init);
