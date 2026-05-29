// ============================================================
// 1132 Fixer renderer — Slice C premium UX
//
// View model:
//   preflight  -> shows preflight card grid + FIX NOW gate
//   running    -> shows 5-stage tracker; raw log collapses to Advanced Details
//   done       -> shows receipt; raw log re-expands by default
// ============================================================

const fileList    = document.getElementById('fileList');
const fixBtn      = document.getElementById('fixBtn');
const shortcutBtn = document.getElementById('shortcutBtn');
const checkEnvBtn = document.getElementById('checkEnvBtn');
const preflightView = document.getElementById('preflightView');
const runningView   = document.getElementById('runningView');
const preflightGrid = document.getElementById('preflightGrid');
const stageTracker  = document.getElementById('stageTracker');
const receiptPanel  = document.getElementById('receiptPanel');
const logToggle     = document.getElementById('logToggle');
const logToggleLabel= document.getElementById('logToggleLabel');

let isRunning = false;
let lastReceipt = null;
let lastStageLabel = '';
const logBuffer = [];
const LOG_BUFFER_MAX = 400;

// ============================================================
// View / stage helpers
// ============================================================
function showView(name) {
  preflightView.classList.toggle('active', name === 'preflight');
  runningView.classList.toggle('active', name === 'running' || name === 'done');
}

function setStatus(className, text) {
  const badge = document.getElementById('statusBadge');
  badge.className = 'status-badge' + (className ? ' ' + className : '');
  document.getElementById('statusBadgeText').textContent = text;
}

const STAGE_ORDER = ['prep', 'verify', 'consent', 'launch', 'receipt'];
const STAGE_LABEL = {
  prep: 'Preparing', verify: 'Verifying', consent: 'Consent', launch: 'Launch', receipt: 'Verify'
};

// Map a fix-log [N/8] step number onto our 5-stage UI.
function stageForStep(n) {
  if (n <= 1) return 'prep';
  if (n <= 4) return 'verify';
  if (n <= 7) return 'consent';
  if (n === 8) return 'launch';
  return null;
}

function setStageTracker(active) {
  stageTracker.classList.toggle('active', active);
}

function setStageState(stage, state) {
  const el = stageTracker.querySelector(`.stage-pill[data-stage="${stage}"]`);
  if (el) el.setAttribute('data-state', state);
}

function resetStages() {
  STAGE_ORDER.forEach(s => setStageState(s, 'pending'));
  lastStageLabel = '';
}

function advanceStageTo(stage) {
  if (!stage) return;
  let reached = false;
  for (const s of STAGE_ORDER) {
    if (s === stage) {
      setStageState(s, 'active');
      reached = true;
      lastStageLabel = STAGE_LABEL[s];
    } else if (!reached) {
      setStageState(s, 'done');
    }
  }
}

function finalizeStages(outcome) {
  // outcome: 'ok' | 'warn' | 'fail'
  const stateForLeading = outcome === 'fail' ? 'fail' : (outcome === 'warn' ? 'warn' : 'done');
  for (const s of STAGE_ORDER) {
    const cur = stageTracker.querySelector(`.stage-pill[data-stage="${s}"]`)?.getAttribute('data-state');
    if (cur === 'active' || cur === 'pending') {
      if (s === 'receipt') setStageState(s, outcome === 'fail' ? 'fail' : (outcome === 'warn' ? 'warn' : 'done'));
      else setStageState(s, cur === 'active' ? stateForLeading : 'pending');
    }
  }
  // Mark receipt stage explicitly to outcome.
  setStageState('receipt', outcome === 'fail' ? 'fail' : (outcome === 'warn' ? 'warn' : 'done'));
  lastStageLabel = STAGE_LABEL.receipt;
}

// ============================================================
// Log region — backed by a ring buffer for the Support Report.
// ============================================================
function clearFileList() {
  fileList.innerHTML = '';
  logBuffer.length = 0;
}

function addFileItem(text, className = '') {
  const div = document.createElement('div');
  div.className = `file-item ${className}`;
  div.textContent = text;
  fileList.appendChild(div);
  fileList.scrollTop = fileList.scrollHeight;
  logBuffer.push(text);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();

  // Stage advancement — parse "[N/8] ..." header lines.
  const m = /^\[(\d)\/8\]/.exec(text);
  if (m) {
    const stage = stageForStep(parseInt(m[1], 10));
    if (stage) advanceStageTo(stage);
  }
}

function addEmptyLine() {
  const div = document.createElement('div');
  div.className = 'file-item empty-line';
  div.innerHTML = '&nbsp;';
  fileList.appendChild(div);
}

function setLogExpanded(expanded) {
  logToggle.classList.toggle('expanded', expanded);
  logToggle.setAttribute('aria-expanded', String(expanded));
  fileList.classList.toggle('hidden', !expanded);
  logToggleLabel.textContent = expanded ? 'Hide Advanced Details' : 'Show Advanced Details';
}

logToggle.addEventListener('click', () => {
  const expanded = logToggle.classList.contains('expanded');
  setLogExpanded(!expanded);
});

// ============================================================
// Preflight Scan
// ============================================================
const PF_BADGE = {
  ready:      'READY',
  repairable: 'REPAIRABLE',
  warning:    'WARNING',
  blocked:    'BLOCKED'
};

const PF_ICONS = {
  ready:      svgCheck(),
  repairable: svgWrench(),
  warning:    svgWarn(),
  blocked:    svgBlock()
};

// Inline SVG so we don't ship extra files. data: URIs allowed by CSP.
function svgCheck()  { return `<svg class="pf-card-icon" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`; }
function svgWrench() { return `<svg class="pf-card-icon" viewBox="0 0 24 24" fill="none" stroke="#f5a623" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-7-7 8-8 .7 1.3z"/><line x1="9" y1="15" x2="4.5" y2="19.5"/></svg>`; }
function svgWarn()   { return `<svg class="pf-card-icon" viewBox="0 0 24 24" fill="none" stroke="#f5c518" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`; }
function svgBlock()  { return `<svg class="pf-card-icon" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`; }

function renderPreflightCard(card) {
  const wrap = document.createElement('div');
  wrap.className = 'pf-card';
  wrap.setAttribute('data-status', card.status);
  wrap.setAttribute('role', 'listitem');
  const head = document.createElement('div');
  head.className = 'pf-card-head';
  head.innerHTML = `${PF_ICONS[card.status] || svgCheck()}
    <span class="pf-card-label">${escapeHtml(card.label)}</span>
    <span class="pf-card-badge">${PF_BADGE[card.status] || ''}</span>`;
  const msg = document.createElement('div');
  msg.className = 'pf-card-msg';
  msg.textContent = card.message;
  wrap.appendChild(head);
  wrap.appendChild(msg);
  return wrap;
}

const PREFLIGHT_ORDER = ['admin', 'zoom', 'helperUser', 'camPolicy', 'micPolicy', 'hku', 'frameServer', 'version'];

async function runPreflightScan() {
  setStatus('scanning', 'Scanning');
  preflightGrid.setAttribute('aria-busy', 'true');
  preflightGrid.innerHTML = '<div class="pf-empty">Scanning environment…</div>';
  fixBtn.disabled = true;
  shortcutBtn.disabled = true;
  try {
    const result = await window.electronAPI.preflightScan();
    preflightGrid.innerHTML = '';
    for (const key of PREFLIGHT_ORDER) {
      const card = result.cards[key];
      if (!card) continue;
      preflightGrid.appendChild(renderPreflightCard(card));
    }
    preflightGrid.setAttribute('aria-busy', 'false');

    const elevated = result.cards.admin && result.cards.admin.status === 'ready';
    fixBtn.disabled = !result.canRunFix;
    shortcutBtn.disabled = !elevated;

    if (result.overall === 'blocked') {
      setStatus('error', 'Blocked');
    } else if (result.overall === 'repairable' || result.overall === 'warning') {
      setStatus('warn', 'Action needed');
    } else {
      setStatus('done', 'Ready');
    }
  } catch (err) {
    preflightGrid.innerHTML = `<div class="pf-empty">Preflight failed: ${escapeHtml(err.message || String(err))}</div>`;
    preflightGrid.setAttribute('aria-busy', 'false');
    setStatus('error', 'Error');
  }
}

// ============================================================
// Fix Receipt — styled cards
// ============================================================
function renderFixReceipt(receipt, warnings) {
  if (!receipt) {
    receiptPanel.classList.remove('visible');
    return;
  }
  lastReceipt = receipt;
  const cam = receiptStatusFor(receipt.camera);
  const mic = receiptStatusFor(receipt.microphone);

  const hkuMap = {
    'session':   { txt: 'Active user1 session — consent written live',                    icon: 'info' },
    'temp-load': { txt: 'NTUSER.DAT loaded to write consent, then unloaded cleanly',      icon: 'info' },
    'skipped':   { txt: 'Per-user write skipped — only HKLM floor applied (firstrun retries)', icon: 'warn' }
  };
  const hku = hkuMap[receipt.hkuPath] || { txt: receipt.hkuPath || 'unknown', icon: 'info' };

  const fsMap = {
    'ok':                     { txt: 'Running normally',                                  icon: 'ok'   },
    'restored-from-disabled': { txt: 'Was Disabled — restored to Manual',                 icon: 'ok'   },
    'disabled-unfixable':     { txt: 'Disabled and could not be re-enabled — cameras will not work', icon: 'fail' },
    'missing':                { txt: 'Service not present — cameras may not enumerate',   icon: 'fail' }
  };
  const fs = fsMap[receipt.frameServer] || { txt: receipt.frameServer || 'unknown', icon: 'info' };

  const items = [
    receiptCardHtml('Camera (desktop apps)',     cam.text, cam.status, cam.iconSvg),
    receiptCardHtml('Microphone (desktop apps)', mic.text, mic.status, mic.iconSvg),
    receiptCardHtml('User registry hive',        hku.txt,  hku.icon,   iconForReceipt(hku.icon)),
    receiptCardHtml('Camera Frame Server',       fs.txt,   fs.icon,    iconForReceipt(fs.icon)),
  ];

  const warnCount = Array.isArray(warnings) ? warnings.length : 0;
  const titleSuffix = warnCount ? ` <span style="color: var(--warning); font-weight: 700;">(${warnCount} warning${warnCount > 1 ? 's' : ''})</span>` : '';

  receiptPanel.innerHTML = `
    <div class="receipt-title">FIX RECEIPT${titleSuffix}</div>
    <div class="receipt-grid">${items.join('')}</div>
    <div class="receipt-foot">
      Hardware privacy shutters, function-key camera disables, camera-driver failures, and third-party antivirus
      webcam shields operate below the OS layer and are not controlled by this fix.
    </div>`;
  receiptPanel.classList.add('visible');
}

function receiptCardHtml(label, value, status, iconSvg) {
  return `<div class="receipt-item" data-status="${status}">
    ${iconSvg}
    <div>
      <span class="receipt-label">${escapeHtml(label)}</span>
      <span class="receipt-value">${escapeHtml(value)}</span>
    </div>
  </div>`;
}

function iconForReceipt(s) {
  switch (s) {
    case 'ok':   return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    case 'warn': return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="#f5c518" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`;
    case 'fail': return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    default:     return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="#7dd3fc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16"/></svg>`;
  }
}

function receiptStatusFor(status) {
  switch (status) {
    case 'OK':
      return { text: 'GRANTED', status: 'ok',   iconSvg: iconForReceipt('ok') };
    case 'POLICY-BLOCKED':
      return { text: 'BLOCKED BY WINDOWS POLICY — your IT admin / device management blocks access. 1132 Fixer cannot override this.', status: 'fail', iconSvg: iconForReceipt('fail') };
    case 'UNVERIFIED':
      return { text: 'UNVERIFIED — registry write did not confirm. Open Settings > Privacy & security under user1 and toggle on manually.', status: 'warn', iconSvg: iconForReceipt('warn') };
    default:
      return { text: status || 'unknown', status: 'info', iconSvg: iconForReceipt('info') };
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// Focus trap — modals.
// Cycles Tab / Shift+Tab inside the overlay, restores focus to the
// element that opened the modal on close. Handles 0 / 1 focusable
// element without throwing (Tab becomes a no-op rather than an error).
// ============================================================
const FOCUSABLE_SEL =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SEL)).filter(el => {
    // Skip elements that aren't actually rendered (display:none ancestors).
    return el.offsetParent !== null || el === document.activeElement;
  });
}

function installFocusTrap(overlay) {
  if (!overlay) return () => {};
  const opener = (document.activeElement instanceof HTMLElement) ? document.activeElement : null;

  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const items = getFocusable(overlay);
    if (items.length === 0) { e.preventDefault(); return; }
    if (items.length === 1) { e.preventDefault(); items[0].focus(); return; }
    const first = items[0];
    const last  = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !overlay.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !overlay.contains(active)) { e.preventDefault(); first.focus(); }
    }
  };
  overlay.addEventListener('keydown', handler);

  // Focus the first focusable on open, deferred so layout settles.
  setTimeout(() => {
    const items = getFocusable(overlay);
    if (items.length) items[0].focus();
  }, 0);

  return function release() {
    overlay.removeEventListener('keydown', handler);
    // Restore focus to the opener so keyboard users land back where they
    // were. Guard against the opener having been removed from the DOM.
    if (opener && document.contains(opener) && typeof opener.focus === 'function') {
      try { opener.focus(); } catch (_) { /* opener no longer focusable */ }
    }
  };
}

// ============================================================
// Run Fix flow
// ============================================================
async function runFix() {
  if (isRunning) return;

  const confirmed = await window.electronAPI.showFixConfirm();
  if (!confirmed) return;

  isRunning = true;
  fixBtn.disabled = true;
  shortcutBtn.disabled = true;
  checkEnvBtn.disabled = true;
  setStatus('scanning', 'Running');

  // Switch to running view.
  showView('running');
  resetStages();
  setStageTracker(true);
  advanceStageTo('prep');
  receiptPanel.classList.remove('visible');
  clearFileList();
  setLogExpanded(false);
  logToggle.classList.add('visible');
  addFileItem('STARTING FIX...', 'header');
  addEmptyLine();

  const result = await window.electronAPI.runFix();

  isRunning = false;
  fixBtn.disabled = false;
  shortcutBtn.disabled = false;
  checkEnvBtn.disabled = false;

  addEmptyLine();
  if (result.success) {
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    if (warnings.length) {
      addFileItem(`FIX COMPLETE (with ${warnings.length} warning(s))`, 'header');
      finalizeStages('warn');
      setStatus('warn', 'Done (warnings)');
    } else {
      addFileItem('FIX COMPLETE', 'header');
      finalizeStages('ok');
      setStatus('done', 'Done');
    }
    renderFixReceipt(result.receipt, warnings);

    if (warnings.length) {
      addEmptyLine();
      addFileItem('WARNINGS', 'header');
      warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
    }
    // Re-expand log on completion so users can scroll back.
    setLogExpanded(true);

    const status = await window.electronAPI.shortcutExists();
    if (status && status.exists && status.valid) {
      addEmptyLine();
      addFileItem(`Desktop shortcut already present: ${status.path}`, 'success');
    } else {
      const wantShortcut = await window.electronAPI.showShortcutPrompt();
      if (wantShortcut) await createShortcut(false);
    }
  } else {
    addFileItem(`FIX FAILED: ${friendlyError(result.error)}`, 'failed');
    if (Array.isArray(result.blockers) && result.blockers.length) {
      result.blockers.forEach(b => addFileItem(`  • [${b.code}] ${b.message}`, 'failed'));
    }
    if (Array.isArray(result.warnings) && result.warnings.length) {
      result.warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
    }
    finalizeStages('fail');
    setStatus('error', 'Failed');
    setLogExpanded(true);
  }
}

function friendlyError(code) {
  switch (code) {
    case 'not_elevated':            return 'Process is not running as Administrator. Re-launch the app elevated (right-click → Run as administrator).';
    case 'running_as_target':       return 'You are currently signed in as user1. Sign in as a different administrator and try again.';
    case 'preflight_failed':        return 'Environment check found one or more blockers. Look at the highlighted lines above — each one tells you what to fix before retrying.';
    case 'missing_tool':            return 'A required Windows tool is missing from PATH (powershell/taskkill/robocopy/icacls/takeown/net/reg). See preflight output above.';
    case 'create_user_failed':      return 'Could not create the user1 account. Make sure the app is running as Administrator and that password policy allows the password.';
    case 'delete_user_failed':      return 'Could not delete the existing user1 account. Make sure the app is running as Administrator.';
    case 'delete_profile_failed':   return 'The user1 profile folder could not be removed — a file handle is still open. Reboot once and run the fix again.';
    case 'zoom_not_found':          return 'Zoom Workplace was not found at C:\\Program Files\\Zoom\\bin\\Zoom.exe. Install the machine-wide Zoom Workplace MSI (not the per-user installer), then try again.';
    case 'launch_failed':           return 'Zoom could not be launched as user1. Common causes: Secondary Logon service disabled, password policy mismatch, or user1 lacks permission to start C:\\Program Files\\Zoom\\bin\\Zoom.exe. Re-run as Administrator or check the log above for the exact PowerShell exception.';
    case 'seclogon_disabled':       return 'The Secondary Logon service is disabled. It is required to launch processes under another local account. Run this from an admin shell and retry:  sc.exe config seclogon start= demand  &  sc.exe start seclogon';
    case 'profile_not_materialized':return 'The user1 profile did not appear in time. The account was created and Zoom was launched, but the per-user profile setup was skipped.';
    case 'tool_probe_failed':       return 'The PowerShell tool probe failed. PowerShell itself may be missing or restricted by AppLocker/policy. The fix cannot continue.';
    default:                        return code || 'Unknown error.';
  }
}

// ============================================================
// Re-scan / shortcut helpers
// ============================================================
async function checkEnvironment() {
  if (isRunning) return;
  showView('preflight');
  setStageTracker(false);
  await runPreflightScan();
}

async function createShortcut(showHeader) {
  if (showHeader) {
    addEmptyLine();
    addFileItem('CREATING DESKTOP SHORTCUT...', 'header');
  }
  const result = await window.electronAPI.createShortcut();
  if (result.success) addFileItem(`Shortcut created: ${result.path}`, 'success');
  else                addFileItem(`Shortcut failed: ${result.error}`, 'failed');
}

// ============================================================
// Bootstrap
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btnExit').addEventListener('click', () => window.electronAPI.quitApp());
  fixBtn.addEventListener('click', runFix);
  shortcutBtn.addEventListener('click', async () => {
    const proceed = await window.electronAPI.showShortcutPrompt();
    if (proceed) await createShortcut(true);
  });
  checkEnvBtn.addEventListener('click', checkEnvironment);

  window.electronAPI.onFixLog(({ line, kind }) => {
    const cls = kind === 'err' ? 'failed'
      : kind === 'header'  ? 'header'
      : kind === 'success' ? 'success'
      : '';
    addFileItem(line, cls);
  });

  // Initial state: preflight view.
  showView('preflight');
  setStageTracker(false);
  await runPreflightScan();
});

// ============================================================
// Footer: app version + admin badge + buttons
// ============================================================
(async () => {
  try {
    const v = await window.electronAPI.getVersion();
    document.getElementById('appVersion').textContent = 'v' + v;
  } catch (_) {}
  try {
    const elevated = await window.electronAPI.isElevated();
    const ab = document.getElementById('adminBadge');
    if (!elevated) {
      ab.textContent = 'Not Admin';
      ab.classList.remove('admin-badge');
      ab.style.color = 'var(--danger)';
      ab.style.borderColor = 'var(--danger-bd)';
      ab.style.background  = 'var(--danger-bg)';
    }
  } catch (_) {}
})();

// ============================================================
// Feedback modal (unchanged behavior)
// ============================================================
const ratings = { ease: 0, resolved: 0, recommend: 0, overall: 0 };
let feedbackMode = '';
let releaseFeedbackTrap = null;

function showSection(id) {
  document.querySelectorAll('.fb-section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function openFeedback() {
  const overlay = document.getElementById('fbOverlay');
  overlay.classList.add('show');
  showSection('fbChoose');
  feedbackMode = '';
  document.querySelectorAll('.fb-textarea').forEach(t => { t.value = ''; });
  document.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
  document.querySelectorAll('.fb-status').forEach(s => { s.textContent = ''; s.className = 'fb-status'; });
  Object.keys(ratings).forEach(k => { ratings[k] = 0; });
  loadSysInfo();
  releaseFeedbackTrap = installFocusTrap(overlay);
}
function closeFeedback() {
  document.getElementById('fbOverlay').classList.remove('show');
  if (releaseFeedbackTrap) { releaseFeedbackTrap(); releaseFeedbackTrap = null; }
}

async function loadSysInfo() {
  try {
    const info = await window.electronAPI.getSystemInfo();
    const el = document.getElementById('fbSysInfo');
    el.textContent = `Version: ${info.version}\nOS: ${info.os}\nAdmin: ${info.admin ? 'Yes' : 'No'}`;
  } catch (_) {
    document.getElementById('fbSysInfo').textContent = 'Could not load system info';
  }
}

document.getElementById('btnFeedback').addEventListener('click', openFeedback);
['fbClose', 'fbBugCancel', 'fbRatingCancel', 'fbContactCancel'].forEach(id => {
  document.getElementById(id).addEventListener('click', closeFeedback);
});
['fbBugBack', 'fbRatingBack', 'fbContactBack'].forEach(id => {
  document.getElementById(id).addEventListener('click', () => showSection('fbChoose'));
});
document.querySelectorAll('.fb-choice').forEach(el => {
  const activate = () => {
    feedbackMode = el.dataset.mode;
    if      (feedbackMode === 'bug')     showSection('fbBug');
    else if (feedbackMode === 'rating')  showSection('fbRating');
    else if (feedbackMode === 'contact') showSection('fbContact');
  };
  el.addEventListener('click', activate);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
  });
});
document.querySelectorAll('.fb-rating-btns').forEach(group => {
  const cat = group.dataset.cat;
  group.querySelectorAll('.fb-rating-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ratings[cat] = parseInt(btn.dataset.val);
      group.querySelectorAll('.fb-rating-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      const filled = Object.values(ratings).filter(v => v > 0).length;
      document.getElementById('fbRatingSubmit').disabled = filled === 0;
    });
  });
});
['fbBugText', 'fbContactText'].forEach(id => {
  const submitId = id === 'fbBugText' ? 'fbBugSubmit' : 'fbContactSubmit';
  document.getElementById(id).addEventListener('input', (e) => {
    document.getElementById(submitId).disabled = e.target.value.trim().length < 50;
  });
});

document.getElementById('fbBugSubmit').addEventListener('click', async () => {
  const text = document.getElementById('fbBugText').value.trim();
  const sysInfo = document.getElementById('fbSysInfo').textContent;
  const body = `${text}\n\n---\n**System Info**\n${sysInfo.split('\n').map(l => '- ' + l).join('\n')}`;
  await submitFeedback('Bug Report', body, 'fbBugStatus');
});
document.getElementById('fbRatingSubmit').addEventListener('click', async () => {
  const filled = Object.entries(ratings).filter(([,v]) => v > 0);
  const avg = (filled.reduce((s,[,v]) => s + v, 0) / filled.length).toFixed(1);
  const comments = document.getElementById('fbRatingText').value.trim();
  let body = `## User Rating Survey\n\n| Category | Score |\n|----------|-------|\n`;
  body += `| Ease of Use | ${ratings.ease}/5 |\n`;
  body += `| Issue Resolved | ${ratings.resolved}/5 |\n`;
  body += `| Recommend | ${ratings.recommend}/5 |\n`;
  body += `| Overall | ${ratings.overall}/5 |\n`;
  body += `| **Average** | **${avg}/5** |\n`;
  if (comments) body += `\n### Comments\n${comments}\n`;
  body += `\n---\n_Submitted via 1132 Fixer app_\n\n<!-- RATING_DATA:${JSON.stringify({...ratings, avg: parseFloat(avg)})} -->`;
  await submitFeedback('User Rating', body, 'fbRatingStatus');
});
document.getElementById('fbContactSubmit').addEventListener('click', async () => {
  const text = document.getElementById('fbContactText').value.trim();
  await submitFeedback('Contact', text, 'fbContactStatus');
});

async function submitFeedback(type, text, statusId) {
  const statusEl = document.getElementById(statusId);
  statusEl.textContent = 'Submitting...';
  statusEl.className = 'fb-status';
  try {
    const result = await window.electronAPI.submitFeedback(type, text);
    if (result.success) {
      statusEl.textContent = 'Submitted successfully!';
      statusEl.className = 'fb-status ok';
      setTimeout(closeFeedback, 1500);
    } else {
      statusEl.textContent = result.error || 'Submission failed';
      statusEl.className = 'fb-status err';
    }
  } catch (err) {
    statusEl.textContent = 'Network error';
    statusEl.className = 'fb-status err';
  }
}

// ============================================================
// Support Report modal
// ============================================================
const supportOverlay   = document.getElementById('supportOverlay');
const supportTextArea  = document.getElementById('supportText');
const supportCopyBtn   = document.getElementById('supportCopy');
const supportCloseBtn  = document.getElementById('supportClose');
const supportCopyStat  = document.getElementById('supportCopyStatus');
const btnSupportReport = document.getElementById('btnSupportReport');

let releaseSupportTrap = null;

async function openSupportReport() {
  supportOverlay.classList.add('show');
  supportTextArea.value = 'Generating sanitized report…';
  supportCopyStat.textContent = '';
  releaseSupportTrap = installFocusTrap(supportOverlay);
  try {
    const result = await window.electronAPI.supportReport({
      receipt: lastReceipt,
      logTail: logBuffer.join('\n'),
      stage:   lastStageLabel
    });
    supportTextArea.value = (result && result.markdown) ? result.markdown : 'Failed to build report.';
  } catch (err) {
    supportTextArea.value = `Failed to build report: ${err.message || err}`;
  }
}

function closeSupportReport() {
  supportOverlay.classList.remove('show');
  if (releaseSupportTrap) { releaseSupportTrap(); releaseSupportTrap = null; }
}

btnSupportReport.addEventListener('click', openSupportReport);
supportCloseBtn.addEventListener('click', closeSupportReport);
supportCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(supportTextArea.value);
    supportCopyStat.textContent = 'Copied — paste into your support thread.';
    supportCopyStat.style.color = 'var(--success)';
  } catch (err) {
    // Fallback: select all so user can manually copy.
    supportTextArea.focus();
    supportTextArea.select();
    supportCopyStat.textContent = 'Auto-copy blocked — text is selected, press Ctrl+C.';
    supportCopyStat.style.color = 'var(--warning)';
  }
});

// Esc closes either modal.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (supportOverlay.classList.contains('show')) closeSupportReport();
    if (document.getElementById('fbOverlay').classList.contains('show')) closeFeedback();
  }
});
