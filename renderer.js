/**
 * 1132 Fixer - Renderer
 */

const $ = id => document.getElementById(id);

let isRunning = false;
const options = { uninstall: true, reinstall: true, launch: false };

// Ring circumference for progress (2πr = 2π×90 ≈ 565)
const RING_CIRC = 565;

async function init() {
  // Version
  try {
    const v = await window.electronAPI.getVersion();
    $('appVersion').textContent = 'v' + v;
    if ($('versionLabel')) $('versionLabel').textContent = 'v' + v;
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
    try {
      await window.electronAPI.launchZoom();
    } catch (_) {}
    $('btnLaunch').textContent = 'Launch Zoom';
  });

  // Start Over
  $('btnReset').addEventListener('click', resetUI);

  // Feedback modal
  let feedbackType = 'Bug Report';
  $('btnFeedback').addEventListener('click', () => {
    $('feedbackModal').classList.add('show');
    $('feedbackText').value = '';
    $('feedbackStatus').textContent = '';
    $('feedbackSubmit').disabled = false;
  });
  $('feedbackCancel').addEventListener('click', () => {
    $('feedbackModal').classList.remove('show');
  });
  // Type selector bubbles
  document.querySelectorAll('#feedbackType button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#feedbackType button').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      feedbackType = btn.dataset.type;
    });
  });
  // Submit feedback
  $('feedbackSubmit').addEventListener('click', async () => {
    const text = $('feedbackText').value.trim();
    if (!text) { $('feedbackStatus').textContent = 'Please enter a description'; return; }
    $('feedbackSubmit').disabled = true;
    $('feedbackStatus').textContent = 'Submitting...';
    $('feedbackStatus').className = 'modal-status';
    try {
      const result = await window.electronAPI.submitFeedback(feedbackType, text);
      if (result.success) {
        $('feedbackStatus').textContent = 'Submitted! Thank you.';
        $('feedbackStatus').classList.add('success');
        setTimeout(() => $('feedbackModal').classList.remove('show'), 1500);
      } else {
        $('feedbackStatus').textContent = result.error || 'Failed to submit';
        $('feedbackStatus').classList.add('error');
        $('feedbackSubmit').disabled = false;
      }
    } catch (err) {
      $('feedbackStatus').textContent = 'Error: ' + err.message;
      $('feedbackStatus').classList.add('error');
      $('feedbackSubmit').disabled = false;
    }
  });

  // Auto-update listener
  window.electronAPI.onUpdateStatus((data) => {
    const banner = $('updateBanner');
    if (!data) return;
    if (data.status === 'available') {
      banner.textContent = `Update v${data.version} downloading...`;
      banner.classList.add('show', 'downloading');
    } else if (data.status === 'downloading') {
      banner.textContent = `Downloading update... ${data.percent}%`;
    } else if (data.status === 'ready') {
      banner.textContent = `Update v${data.version} ready — click to restart`;
      banner.classList.remove('downloading');
      banner.classList.add('show');
      banner.onclick = () => window.electronAPI.installUpdate();
    }
  });

  // Progress listener
  window.electronAPI.onProgress((data) => {
    if (!data) return;
    const pct = data.percent || 0;

    // Update ring
    const offset = RING_CIRC - (RING_CIRC * pct / 100);
    $('ringFill').style.strokeDashoffset = offset;
    $('btnPct').textContent = Math.round(pct) + '%';

    // Update bar
    $('progressFill').style.width = pct + '%';

    // Update status text
    if (data.step) {
      $('statusText').textContent = data.step;
    }
  });
}

async function handleFix() {
  if (isRunning) return;

  // Confirm
  const confirmed = await window.electronAPI.showConfirmDialog(
    'This will reset all Zoom data and device fingerprints to fix Error 1132.\n\nContinue?'
  );
  if (!confirmed) return;

  // Enter running state
  isRunning = true;
  const btn = $('btnFix');
  btn.classList.add('running');
  btn.disabled = true;
  $('progressRing').classList.add('active');
  $('progressBar').classList.add('active');
  $('statusText').textContent = 'Starting...';
  $('statusText').classList.add('active');
  $('postActions').classList.remove('show');

  // Disable toggles
  document.querySelectorAll('.toggle').forEach(t => t.classList.add('disabled'));

  try {
    const result = await window.electronAPI.fullReset(options);

    if (result && result.success) {
      // Done state
      btn.classList.remove('running');
      btn.classList.add('done');
      $('progressRing').classList.add('done');
      $('ringFill').style.strokeDashoffset = 0;
      $('statusText').textContent = options.reinstall ? 'Zoom reinstalled — launch via button below' : 'All Zoom traces removed';
      $('statusText').classList.remove('active');
      $('statusText').classList.add('done');
      $('progressBar').classList.remove('active');
      $('postActions').classList.add('show');

      // Auto-launch if option set
      if (options.launch && options.reinstall) {
        try { await window.electronAPI.launchZoom(); } catch (_) {}
      }
    } else {
      // Failed
      $('statusText').textContent = 'Fix failed — ' + (result?.error || 'unknown error');
      $('statusText').classList.remove('active');
      btn.classList.remove('running');
      btn.disabled = false;
      $('progressRing').classList.remove('active');
      $('progressBar').classList.remove('active');
      isRunning = false;
      document.querySelectorAll('.toggle').forEach(t => t.classList.remove('disabled'));
    }
  } catch (err) {
    $('statusText').textContent = 'Error: ' + err.message;
    $('statusText').classList.remove('active');
    btn.classList.remove('running');
    btn.disabled = false;
    $('progressRing').classList.remove('active');
    $('progressBar').classList.remove('active');
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
  $('ringFill').style.strokeDashoffset = RING_CIRC;
  $('progressRing').classList.remove('active', 'done');
  $('progressBar').classList.remove('active');
  $('progressFill').style.width = '0%';
  $('statusText').textContent = 'Ready';
  $('statusText').classList.remove('active', 'done');
  $('postActions').classList.remove('show');
  document.querySelectorAll('.toggle').forEach(t => t.classList.remove('disabled'));
}

document.addEventListener('DOMContentLoaded', init);
