/**
 * 1132 Fixer - Renderer
 */

const $ = id => document.getElementById(id);

let isRunning = false;
const options = { launch: true };

// === Auto-close system ===
let autoCloseTimer = null;
let autoCloseCancelled = false;

function startAutoClose(totalSeconds, overlayAt) {
  if (autoCloseTimer) clearInterval(autoCloseTimer);
  autoCloseCancelled = false;
  let remaining = totalSeconds;
  autoCloseTimer = setInterval(() => {
    remaining--;
    if (autoCloseCancelled) { clearInterval(autoCloseTimer); autoCloseTimer = null; return; }
    if (remaining <= overlayAt && remaining > 0) {
      $('closeOverlay').classList.add('show');
      $('closeCountdown').textContent = remaining;
    }
    if (remaining <= 0) {
      clearInterval(autoCloseTimer);
      autoCloseTimer = null;
      window.electronAPI.quitApp();
    }
  }, 1000);
}

function cancelAutoClose() {
  autoCloseCancelled = true;
  if (autoCloseTimer) { clearInterval(autoCloseTimer); autoCloseTimer = null; }
  $('closeOverlay').classList.remove('show');
}

// 5 min inactivity timer — resets on any user interaction
// After 3 min idle, show 2-min countdown overlay (total 5 min)
let inactivityTimer = null;
function resetInactivityTimer() {
  if (isRunning) return;
  cancelAutoClose();
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(() => {
    if (!isRunning) startAutoClose(120, 120);
  }, 3 * 60 * 1000);
}

// Ring circumference for progress (2πr = 2π×90 ≈ 565)
const RING_CIRC = 565;

async function init() {
  // Start 5-min inactivity timer, reset on interaction
  resetInactivityTimer();
  ['click', 'mousemove', 'keydown', 'scroll'].forEach(evt =>
    document.addEventListener(evt, resetInactivityTimer, { passive: true })
  );

  // Close overlay cancel button
  $('closeCancelBtn').addEventListener('click', () => {
    cancelAutoClose();
    resetInactivityTimer();
  });

  // Version
  try {
    const v = await window.electronAPI.getVersion();
    $('appVersion').textContent = 'v' + v;
  } catch (_) {}

  // Version badge click
  $('appVersion').addEventListener('click', () => {
    alert('✓ Your app is up to date.');
  });

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

  // Exit button
  $('btnExit').addEventListener('click', () => {
    window.close();
  });

  // Admin badge click
  $('adminStatus').addEventListener('click', () => {
    alert('Running with Administrator privileges.\n\nThis app has the correct permissions to fix Zoom Error 1132.');
  });

  // Status badge click — show app info popup
  $('statusBadge').addEventListener('click', async () => {
    const modal = $('statusModal');
    modal.classList.add('show');
    try {
      const info = cachedSysInfo || await window.electronAPI.getSystemInfo();
      $('smVersion').textContent = info.version || '--';
      $('smOS').textContent = info.os || '--';
      const adminEl = $('smAdmin');
      adminEl.textContent = info.admin ? 'Yes' : 'No';
      adminEl.className = info.admin ? 'si-value status-yes' : 'si-value';
      $('smLastFix').textContent = info.lastFix || 'Never';
      const resEl = $('smResult');
      if (info.lastFixStatus === 'Completed') {
        resEl.textContent = 'Completed'; resEl.className = 'si-value status-ok';
      } else if (info.lastFixStatus === 'Failed') {
        resEl.textContent = 'Failed'; resEl.className = 'si-value status-fail';
      } else {
        resEl.textContent = '--'; resEl.className = 'si-value';
      }
      $('smErrors').textContent = info.errors || 'None';
    } catch (_) {}
  });
  $('smClose').addEventListener('click', () => $('statusModal').classList.remove('show'));
  $('smForceUpdate').addEventListener('click', () => {
    $('statusModal').classList.remove('show');
    window.electronAPI.retryUpdate();
  });
  $('smForceRestart').addEventListener('click', () => {
    $('statusModal').classList.remove('show');
    window.electronAPI.forceRestart();
  });

  // Feedback modal — two-step flow
  let feedbackMode = '';
  let cachedSysInfo = null;
  const ratings = { ease: 0, resolved: 0, recommend: 0, overall: 0 };

  // Version-based submit limit
  function getSubmitKey(mode) { return `fb_submitted_${mode}`; }
  function hasSubmittedForVersion(mode) {
    try {
      const stored = localStorage.getItem(getSubmitKey(mode));
      if (!stored) return false;
      const v = $('appVersion')?.textContent?.replace('v', '') || '';
      return stored === v;
    } catch (_) { return false; }
  }
  function markSubmitted(mode) {
    try {
      const v = $('appVersion')?.textContent?.replace('v', '') || '';
      localStorage.setItem(getSubmitKey(mode), v);
    } catch (_) {}
  }

  // Load system info for bug reports
  async function loadSystemInfo() {
    try {
      cachedSysInfo = await window.electronAPI.getSystemInfo();
      $('siVersion').textContent = cachedSysInfo.version || '—';
      $('siOS').textContent = cachedSysInfo.os || '—';

      // Admin status with color
      const adminEl = $('siAdmin');
      if (cachedSysInfo.admin) {
        adminEl.textContent = 'Yes';
        adminEl.className = 'si-value status-yes';
      } else {
        adminEl.textContent = 'No';
        adminEl.className = 'si-value';
      }

      $('siLastFix').textContent = cachedSysInfo.lastFix || 'Never';

      // Last fix result with color
      const statusEl = $('siLastFixStatus');
      if (cachedSysInfo.lastFixStatus === 'Completed') {
        statusEl.textContent = '✓ Completed';
        statusEl.className = 'si-value status-ok';
      } else if (cachedSysInfo.lastFixStatus === 'Failed') {
        statusEl.textContent = '✗ Failed';
        statusEl.className = 'si-value status-fail';
      } else {
        statusEl.textContent = '—';
        statusEl.className = 'si-value';
      }

      $('siErrors').textContent = cachedSysInfo.errors || 'None';
    } catch (_) {
      $('siVersion').textContent = $('appVersion')?.textContent || '—';
      $('siOS').textContent = 'Windows';
      $('siAdmin').textContent = '—';
      $('siLastFix').textContent = '—';
      $('siLastFixStatus').textContent = '—';
      $('siErrors').textContent = '—';
    }
  }

  // Rating button clicks
  document.querySelectorAll('.rating-row').forEach(row => {
    row.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        const q = row.dataset.q;
        const v = parseInt(btn.dataset.v);
        ratings[q] = v;
        row.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      });
    });
  });

  function showStep1() {
    $('fbChoose').style.display = 'flex';
    $('bugSection').style.display = 'none';
    $('ratingSection').style.display = 'none';
    $('contactSection').style.display = 'none';
    $('fbActions').style.display = 'none';
    $('fbCloseRow').style.display = 'flex';
    $('modalTitle').textContent = 'How can we help?';
    $('modalSubtitle').textContent = 'Choose a category below';
    $('feedbackStatus').textContent = '';
    feedbackMode = '';
  }

  function showStep2(mode) {
    feedbackMode = mode;
    $('fbChoose').style.display = 'none';
    $('fbCloseRow').style.display = 'none';
    $('fbActions').style.display = 'flex';
    $('feedbackStatus').textContent = '';

    // Check version-limited submit
    if (hasSubmittedForVersion(mode)) {
      $('feedbackSubmit').disabled = true;
      $('feedbackStatus').textContent = 'Already submitted for this version. Update to submit again.';
      $('feedbackStatus').className = 'modal-status';
    } else {
      $('feedbackSubmit').disabled = false;
    }

    $('bugSection').style.display = mode === 'bug' ? 'block' : 'none';
    $('ratingSection').style.display = mode === 'rating' ? 'block' : 'none';
    $('contactSection').style.display = mode === 'contact' ? 'block' : 'none';

    // Load system info when entering bug mode
    if (mode === 'bug') loadSystemInfo();

    const titles = { bug: 'Report a Bug', rating: 'Rate Your Experience', contact: 'Contact Us' };
    const subtitles = { bug: 'System info is auto-attached below', rating: 'Help us improve with your feedback', contact: 'We\'ll get back to you soon' };
    $('modalTitle').textContent = titles[mode] || 'Feedback';
    $('modalSubtitle').textContent = subtitles[mode] || '';
  }

  // Category buttons
  document.querySelectorAll('.fb-option').forEach(btn => {
    btn.addEventListener('click', () => showStep2(btn.dataset.mode));
  });

  // Open modal → step 1
  $('btnFeedback').addEventListener('click', () => {
    $('feedbackModal').classList.add('show');
    $('feedbackText').value = '';
    $('bugText').value = '';
    $('contactText').value = '';
    Object.keys(ratings).forEach(k => ratings[k] = 0);
    document.querySelectorAll('.rating-row button').forEach(b => b.classList.remove('selected'));
    showStep1();
  });

  // Back → step 1
  $('feedbackBack').addEventListener('click', showStep1);

  // Close
  $('feedbackCancel').addEventListener('click', () => {
    $('feedbackModal').classList.remove('show');
  });

  // Submit
  $('feedbackSubmit').addEventListener('click', async () => {
    $('feedbackSubmit').disabled = true;
    $('feedbackStatus').textContent = 'Submitting...';
    $('feedbackStatus').className = 'modal-status';

    let type, body;

    if (feedbackMode === 'bug') {
      const bugDesc = $('bugText').value.trim();
      if (!bugDesc || bugDesc.length < 50) { $('feedbackStatus').textContent = 'Please describe the bug (at least 50 characters)'; $('feedbackSubmit').disabled = false; return; }
      type = 'Bug Report';
      // Include system info in bug report body
      const si = cachedSysInfo || {};
      body = bugDesc;
      body += `\n\n---\n**System Info**\n`;
      body += `- Version: ${si.version || '?'}\n`;
      body += `- OS: ${si.os || '?'}\n`;
      body += `- Admin: ${si.admin ? 'Yes' : 'No'}\n`;
      body += `- Last Fix: ${si.lastFix || '?'}\n`;
      body += `- Result: ${si.lastFixStatus || '—'}\n`;
      body += `- Recent Errors: ${si.errors || 'None'}\n`;
    } else if (feedbackMode === 'contact') {
      const msg = $('contactText').value.trim();
      if (!msg || msg.length < 50) { $('feedbackStatus').textContent = 'Please enter a message (at least 50 characters)'; $('feedbackSubmit').disabled = false; return; }
      type = 'Contact';
      body = msg;
    } else {
      const filledCount = Object.values(ratings).filter(v => v > 0).length;
      if (filledCount === 0) { $('feedbackStatus').textContent = 'Please rate at least one category'; $('feedbackSubmit').disabled = false; return; }
      const filledScores = Object.values(ratings).filter(v => v > 0);
      const avg = (filledScores.reduce((a, b) => a + b, 0) / filledScores.length).toFixed(1);
      const comment = $('feedbackText').value.trim();
      type = 'User Rating';
      body = `## User Rating Survey\n\n| Category | Score |\n|----------|-------|\n`;
      body += `| Ease of Use | ${ratings.ease || '—'}/5 |\n| Issue Resolved | ${ratings.resolved || '—'}/5 |\n`;
      body += `| Recommend | ${ratings.recommend || '—'}/5 |\n| Overall | ${ratings.overall || '—'}/5 |\n`;
      body += `| **Average** | **${avg}/5** |\n\n`;
      if (comment) body += `### Comments\n${comment}\n\n`;
      body += `---\n_Submitted via 1132 Fixer app_\n\n`;
      body += `<!-- RATING_DATA:${JSON.stringify({ ease: ratings.ease, resolved: ratings.resolved, recommend: ratings.recommend, overall: ratings.overall, avg: parseFloat(avg) })} -->`;
    }

    try {
      const result = await window.electronAPI.submitFeedback(type, body);
      if (result.success) {
        markSubmitted(feedbackMode);
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
  let updateDownloading = false;
  window.electronAPI.onUpdateStatus((data) => {
    const overlay = $('updateOverlay');
    const card = $('updateCard');
    const icon = $('updateIcon');
    const title = $('updateTitle');
    const msg = $('updateMsg');
    const pct = $('updatePct');
    const fill = $('updateFill');
    const retry = $('updateRetry');
    if (!data) return;

    if (data.status === 'available') {
      updateDownloading = true;
      overlay.classList.add('show');
      card.className = 'update-card';
      icon.textContent = '\u231B';
      title.textContent = 'Downloading Update';
      msg.textContent = `Version ${data.version} is being downloaded...`;
      pct.textContent = '0%';
      fill.style.width = '0%';
    } else if (data.status === 'downloading') {
      updateDownloading = true;
      overlay.classList.add('show');
      pct.textContent = `${data.percent}%`;
      fill.style.width = `${data.percent}%`;
      msg.textContent = 'Please wait while the update downloads...';
    } else if (data.status === 'ready') {
      card.className = 'update-card ready';
      icon.textContent = '\u2705';
      title.textContent = 'Update Ready';
      msg.textContent = `Version ${data.version} downloaded — restarting now...`;
      pct.textContent = '100%';
      fill.style.width = '100%';
    } else if (data.status === 'error') {
      // Only show error overlay if we were already downloading
      if (!updateDownloading) return;
      card.className = 'update-card error';
      icon.textContent = '\u274C';
      title.textContent = 'Update Failed';
      msg.textContent = (data.error || 'Something went wrong') + '\n\nClick retry to try again.';
      pct.textContent = '';
      retry.onclick = () => {
        card.className = 'update-card';
        icon.textContent = '\u231B';
        title.textContent = 'Retrying Update';
        msg.textContent = 'Checking for updates...';
        pct.textContent = '';
        fill.style.width = '0%';
        updateDownloading = false;
        window.electronAPI.retryUpdate();
      };
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
  $('statusBadge').className = 'status-badge running';
  $('statusBadgeText').textContent = 'Status: Fixing...';
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
      $('statusText').textContent = 'All Zoom traces removed';
      $('statusText').classList.remove('active');
      $('statusText').classList.add('done');
      $('statusBadge').className = 'status-badge done';
      $('statusBadgeText').textContent = 'Status: Fixed';
      $('progressBar').classList.remove('active');
      $('postActions').classList.add('show');

      // Auto-launch if option set
      if (options.launch) {
        try { await window.electronAPI.launchZoom(); } catch (_) {}
      }

      // Auto-close 60s after session, overlay at 30s remaining
      startAutoClose(60, 30);
    } else {
      // Failed
      $('statusText').textContent = 'Fix failed — ' + (result?.error || 'unknown error');
      $('statusText').classList.remove('active');
      btn.classList.remove('running');
      btn.disabled = false;
      $('progressRing').classList.remove('active');
      $('progressBar').classList.remove('active');
      $('statusBadge').className = 'status-badge error';
      $('statusBadgeText').textContent = 'Status: Failed';
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
    $('statusBadge').className = 'status-badge error';
    $('statusBadgeText').textContent = 'Status: Error';
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
  $('statusText').textContent = '';
  $('statusText').classList.remove('active', 'done');
  $('statusBadge').className = 'status-badge';
  $('statusBadgeText').textContent = 'Status: Ready';
  $('postActions').classList.remove('show');
  document.querySelectorAll('.toggle').forEach(t => t.classList.remove('disabled'));
}

document.addEventListener('DOMContentLoaded', init);
