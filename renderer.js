// ============================================================
// 1132 Fixer renderer
//
// View model:
//   home     -> one-line pitch + live environment checklist.
//               The checklist runs AUTOMATICALLY on launch (and on
//               window focus). FIX NOW is a single click: brief
//               cancelable countdown on the button itself, then the
//               whole flow runs end to end — no wizard, no dialogs.
//   running  -> 5-stage tracker; raw log collapses to Advanced Details
//   done     -> receipt; desktop shortcut auto-created; log re-expands
// ============================================================

const fileList        = document.getElementById('fileList');
const fixBtn          = document.getElementById('fixBtn');
const shortcutBtn     = document.getElementById('shortcutBtn');
const homeView        = document.getElementById('homeView');
const runningView     = document.getElementById('runningView');
const checkList       = document.getElementById('checkList');
const stageTracker    = document.getElementById('stageTracker');
const receiptPanel    = document.getElementById('receiptPanel');
const logToggle       = document.getElementById('logToggle');
const logToggleLabel  = document.getElementById('logToggleLabel');

let isRunning = false;
let lastReceipt = null;
let lastStageLabel = '';
const logBuffer = [];
const LOG_BUFFER_MAX = 400;
// Hard cap on log DOM nodes. Long robocopy/PowerShell output used to grow
// the DOM without bound — thousands of nodes plus a forced reflow per line
// was a real source of the "app freezes" reports.
const LOG_DOM_MAX = 400;

// ============================================================
// View / stage helpers
// ============================================================
function showView(name) {
  homeView.classList.toggle('active', name === 'home');
  runningView.classList.toggle('active', name === 'running' || name === 'done');
}

function setStatus(className, text) {
  const badge = document.getElementById('statusBadge');
  badge.className = 'status-badge' + (className ? ' ' + className : '');
  document.getElementById('statusBadgeIcon').textContent =
    className === 'error' ? '⨯' :
    className === 'warn' ? '!' :
    className === 'scanning' ? '↻' : '✓';
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
// Log region — ring buffer for the Support Report + rAF-batched DOM
// writes. Lines arrive from main in bursts (robocopy, icacls, PS);
// appending + scrolling per line forced a reflow each time. Batching
// into one frame keeps the renderer responsive during the fix.
// ============================================================
const pendingLogItems = [];
let logFlushScheduled = false;

function clearFileList() {
  pendingLogItems.length = 0;
  fileList.innerHTML = '';
  logBuffer.length = 0;
}

function flushLogItems() {
  logFlushScheduled = false;
  if (!pendingLogItems.length) return;
  const frag = document.createDocumentFragment();
  for (const item of pendingLogItems.splice(0)) {
    const div = document.createElement('div');
    div.className = `file-item ${item.className}`;
    div.textContent = item.text;
    frag.appendChild(div);
  }
  fileList.appendChild(frag);
  while (fileList.children.length > LOG_DOM_MAX) {
    fileList.removeChild(fileList.firstChild);
  }
  fileList.scrollTop = fileList.scrollHeight;
}

function queueLogItem(text, className) {
  pendingLogItems.push({ text, className });
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(flushLogItems);
  }
}

function addFileItem(text, className = '') {
  queueLogItem(text, className);
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
  queueLogItem(' ', 'empty-line');
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
// Status icon SVGs — shared between checklist + receipt.
// Inline strings so the renderer ships nothing extra.
// ============================================================
const STATUS_BADGE = {
  ready:      'Ready',
  repairable: 'Repairable',
  warning:    'Warning',
  blocked:    'Blocked',
  pending:    'Checking'
};

function svgCheck(klass)  { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`; }
function svgWrench(klass) { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-7-7 8-8 .7 1.3z"/><line x1="9" y1="15" x2="4.5" y2="19.5"/></svg>`; }
function svgWarn(klass)   { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`; }
function svgBlock(klass)  { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>`; }
function svgDot(klass)    { return `<svg class="${klass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/></svg>`; }

function iconForStatus(status, klass) {
  switch (status) {
    case 'ready':      return svgCheck(klass);
    case 'repairable': return svgWrench(klass);
    case 'warning':    return svgWarn(klass);
    case 'blocked':    return svgBlock(klass);
    case 'pending':    return svgDot(klass);
    default:           return svgCheck(klass);
  }
}

// ============================================================
// Environment checklist — runs automatically, no clicks required.
// ============================================================
const CHECK_ORDER = [
  { key: 'admin',       label: 'Administrator' },
  { key: 'zoom',        label: 'Zoom Workplace' },
  { key: 'helperUser',  label: 'Helper account' },
  { key: 'camPolicy',   label: 'Camera policy' },
  { key: 'micPolicy',   label: 'Microphone policy' },
  { key: 'hku',         label: 'User registry hive' },
  { key: 'frameServer', label: 'Camera Frame Server' }
];

let scanInProgress = false;
let lastScanAt = 0;
let canRunFix = false;

function renderCheckRow(key, label, status, message) {
  const row = document.createElement('div');
  row.className = 'chk-row';
  row.setAttribute('data-status', status);
  row.setAttribute('data-key', key);
  row.setAttribute('role', 'listitem');
  row.innerHTML = `${iconForStatus(status, 'chk-icon')}
    <span class="chk-label">${escapeHtml(label)}</span>
    <span class="chk-msg">${escapeHtml(message)}</span>
    <span class="chk-badge">${STATUS_BADGE[status] || ''}</span>`;
  return row;
}

async function runEnvironmentScan() {
  if (scanInProgress || isRunning) return;
  scanInProgress = true;
  lastScanAt = Date.now();
  setStatus('scanning', 'Checking');
  fixBtn.disabled = true;

  // Show all rows immediately as pending so the screen never sits empty.
  checkList.innerHTML = '';
  for (const c of CHECK_ORDER) {
    checkList.appendChild(renderCheckRow(c.key, c.label, 'pending', 'Checking…'));
  }

  try {
    const result = await window.electronAPI.preflightScan();
    checkList.innerHTML = '';
    for (const c of CHECK_ORDER) {
      const card = result.cards[c.key];
      if (!card) continue;
      checkList.appendChild(renderCheckRow(c.key, card.label || c.label, card.status, card.message || ''));
    }
    canRunFix = !!result.canRunFix;
    if (result.overall === 'blocked') {
      setStatus('error', 'Blocked');
    } else if (result.overall === 'warning') {
      setStatus('warn', 'Ready');
    } else {
      setStatus('done', 'Ready');
    }
    fixBtn.disabled = !canRunFix;
  } catch (err) {
    checkList.innerHTML = '';
    checkList.appendChild(renderCheckRow('scan', 'Environment scan', 'blocked', scanFailureMessage(err)));
    canRunFix = false;
    setStatus('error', 'Error');
    fixBtn.disabled = true;
  } finally {
    scanInProgress = false;
  }
}

// Re-scan when the user comes back to the window (e.g. after installing
// Zoom or fixing a blocker) — throttled, home view only.
window.addEventListener('focus', () => {
  if (isRunning || scanInProgress) return;
  if (!homeView.classList.contains('active')) return;
  if (Date.now() - lastScanAt < 10000) return;
  runEnvironmentScan();
});

// ============================================================
// Fix Receipt — styled cards
// ============================================================
function renderFixReceipt(receipt, warnings) {
  if (!receipt) {
    receiptPanel.classList.remove('visible');
    return;
  }
  lastReceipt = receipt;
  const cam = receiptStatusView(receipt.camera);
  const mic = receiptStatusView(receipt.microphone);
  const hku = describeHku(receipt.hkuPath);
  const fs  = describeFrameServer(receipt.frameServer);

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
    case 'ok':   return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    case 'warn': return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12" y2="17"/></svg>`;
    case 'fail': return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;
    default:     return `<svg class="receipt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16" x2="12" y2="16"/></svg>`;
  }
}

// Thin view adapter over the messages.js catalog: adds the icon SVG, which
// stays renderer-side so the catalog remains DOM-free and testable in Node.
function receiptStatusView(status) {
  const m = receiptStatusFor(status);
  return { text: m.text, status: m.status, iconSvg: iconForReceipt(m.status) };
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
// FIX NOW — one click. A short countdown runs ON the button itself
// (click again to cancel) as the only guard before the destructive
// flow. No wizard, no native confirm, no shortcut prompt.
// ============================================================
const FIX_COUNTDOWN_SECONDS = 3;
let fixCountdownTimer = null;

function cancelFixCountdown() {
  if (fixCountdownTimer) {
    clearInterval(fixCountdownTimer);
    fixCountdownTimer = null;
    fixBtn.textContent = 'Fix now';
    fixBtn.classList.remove('counting');
  }
}

function startFixCountdown() {
  let remaining = FIX_COUNTDOWN_SECONDS;
  fixBtn.classList.add('counting');
  fixBtn.textContent = `Starting in ${remaining}… Click to cancel`;
  fixCountdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      cancelFixCountdown();
      runFix();
    } else {
      fixBtn.textContent = `Starting in ${remaining}… Click to cancel`;
    }
  }, 1000);
}

function onFixButtonClick() {
  if (isRunning) return;
  if (fixCountdownTimer) {
    cancelFixCountdown();
    return;
  }
  if (!canRunFix) return;
  startFixCountdown();
}

// ============================================================
// Run Fix flow
// ============================================================
async function runFix() {
  if (isRunning) return;

  isRunning = true;
  fixBtn.disabled = true;
  fixBtn.textContent = 'Fixing…';
  shortcutBtn.disabled = true;
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

  try {
    const result = await window.electronAPI.runFix();

    addEmptyLine();
    if (result && result.success) {
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

      // Desktop shortcut: created automatically when missing or stale —
      // part of "one click does everything", no prompt.
      const status = await window.electronAPI.shortcutExists();
      if (status && status.exists && status.valid) {
        addEmptyLine();
        addFileItem(`Desktop shortcut already present: ${status.path}`, 'success');
      } else {
        addEmptyLine();
        await createShortcut(true);
      }
    } else {
      const res = result || {};
      addFileItem(`FIX FAILED: ${friendlyError(res.error)}`, 'failed');
      if (Array.isArray(res.blockers) && res.blockers.length) {
        res.blockers.forEach(b => addFileItem(`  • [${b.code}] ${b.message}`, 'failed'));
      }
      if (Array.isArray(res.warnings) && res.warnings.length) {
        res.warnings.forEach(w => addFileItem(`  • [${w.code}] ${w.message}`, 'failed'));
      }
      finalizeStages('fail');
      setStatus('error', 'Failed');
      setLogExpanded(true);
    }
  } catch (err) {
    // The fix IPC (or a renderer helper it calls) threw. Surface it instead
    // of dying as a silent unhandled rejection.
    addEmptyLine();
    addFileItem(`FIX FAILED: ${unexpectedFixFailure(err)}`, 'failed');
    finalizeStages('fail');
    setStatus('error', 'Failed');
    setLogExpanded(true);
  } finally {
    // Always release the run lock and re-enable controls — even on a throw.
    isRunning = false;
    fixBtn.disabled = false;
    fixBtn.textContent = 'Run again';
    shortcutBtn.disabled = false;
  }
}

// friendlyError() and the rest of the user-facing copy live in messages.js
// (loaded before this script; require()-able by tools/messages-smoke.js).

// ============================================================
// Shortcut helper — direct create, no prompt.
// ============================================================
async function createShortcut(showHeader) {
  if (showHeader) {
    addFileItem('CREATING ZOOM HELPER SHORTCUT...', 'header');
  }
  const result = await window.electronAPI.createShortcut();
  if (!result.success) {
    addFileItem(shortcutFailureMessage(result.error), 'failed');
    return;
  }
  addFileItem(`Shortcut created: ${result.path}`, 'success');

  // An old shortcut we could not delete is the exact problem the rename
  // cleanup exists to prevent, so it is never swallowed by the success line:
  // the user is told which file to remove, in plain words.
  const failed = result.legacyRemovalFailed || [];
  if (failed.length) {
    addFileItem(
      `Could not remove ${failed.length === 1 ? 'the older shortcut' : `${failed.length} older shortcuts`} — delete ${failed.length === 1 ? 'it' : 'them'} by hand so you do not have two:`,
      'failed'
    );
    for (const f of failed) addFileItem(`    ${f.path}`, 'failed');
  } else if ((result.legacyRemoved || []).length) {
    addFileItem(`Older shortcut removed: ${result.legacyRemoved.join(', ')}`, 'success');
  }
}

// ============================================================
// Update banner — mirrors main-process 'update-status' events.
// Main owns the real timers; this is display + two buttons.
// ============================================================
const updateBanner  = document.getElementById('updateBanner');
const ubMsg         = document.getElementById('ubMsg');
const ubRestart     = document.getElementById('ubRestart');
const ubDownload    = document.getElementById('ubDownload');
const ubLater       = document.getElementById('ubLater');
const ubProgress    = document.getElementById('ubProgress');
const ubProgressFill= document.getElementById('ubProgressFill');

let ubTickTimer = null;
let ubHideTimer = null;

function ubClearTimers() {
  if (ubTickTimer) { clearInterval(ubTickTimer); ubTickTimer = null; }
  if (ubHideTimer) { clearTimeout(ubHideTimer); ubHideTimer = null; }
}

function ubShow({ msg, restartBtn = false, downloadBtn = false, laterBtn = false, progress = null }) {
  updateBanner.classList.add('visible');
  ubMsg.textContent = msg;
  ubRestart.style.display = restartBtn ? '' : 'none';
  ubDownload.style.display = downloadBtn ? '' : 'none';
  ubLater.style.display = laterBtn ? '' : 'none';
  if (progress === null) {
    ubProgress.style.display = 'none';
  } else {
    ubProgress.style.display = '';
    ubProgressFill.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  }
}

function ubHide() {
  updateBanner.classList.remove('visible');
}

function handleUpdateStatus(data) {
  if (!data || !data.state) return;
  ubClearTimers();
  const v = data.version ? `v${data.version}` : 'update';
  switch (data.state) {
    case 'downloading':
      ubShow({ msg: `Downloading ${v} in the background… ${data.percent || 0}%`, progress: data.percent || 0 });
      break;
    case 'restarting': {
      let remaining = data.seconds || 10;
      const render = () => ubShow({
        msg: `Update ${v} is ready — restarting in ${remaining}s to install.`,
        restartBtn: true,
        laterBtn: true
      });
      render();
      ubTickTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { ubClearTimers(); return; }
        render();
      }, 1000);
      break;
    }
    case 'deferred':
      ubShow({
        msg: `Update ${v} is ready — it installs automatically when you exit the app.`,
        restartBtn: true
      });
      break;
    case 'manual':
      // Portable build: cannot self-update; offer the download page.
      ubShow({
        msg: `Update ${v} is available. This portable version can't update itself — download the new one.`,
        downloadBtn: true,
        laterBtn: true
      });
      break;
    case 'error':
      ubShow({ msg: 'Update check failed — will retry on next launch.' });
      ubHideTimer = setTimeout(ubHide, 6000);
      break;
    case 'idle':
    default:
      ubHide();
      break;
  }
}

ubRestart.addEventListener('click', () => {
  ubClearTimers();
  ubShow({ msg: 'Installing update — the app will restart itself…' });
  window.electronAPI.installUpdateNow();
});
ubDownload.addEventListener('click', () => {
  window.electronAPI.openDownloadPage();
  ubShow({ msg: 'Download page opened in your browser — grab the newest version there.' });
  ubHideTimer = setTimeout(ubHide, 8000);
});
ubLater.addEventListener('click', () => {
  ubClearTimers();
  // Hide immediately; a downloaded NSIS update re-shows itself as 'deferred'
  // via the main process, and the portable notice returns on the next 4h check.
  ubHide();
  window.electronAPI.deferUpdate();
});

// ============================================================
// Bootstrap
// ============================================================
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('btnExit').addEventListener('click', () => window.electronAPI.quitApp());
  document.getElementById('btnMinimize').addEventListener('click', () => window.electronAPI.minimizeWindow());
  document.getElementById('btnMaximize').addEventListener('click', () => window.electronAPI.maximizeWindow());
  fixBtn.addEventListener('click', onFixButtonClick);
  shortcutBtn.addEventListener('click', async () => {
    // Direct create — no confirmation round-trip. Logs land in the running
    // view's log region; flip to it so the result is visible.
    if (isRunning) return;
    showView('running');
    logToggle.classList.add('visible');
    setLogExpanded(true);
    await createShortcut(true);
  });

  window.electronAPI.onFixLog(({ line, kind }) => {
    const cls = kind === 'err' ? 'failed'
      : kind === 'header'  ? 'header'
      : kind === 'success' ? 'success'
      : '';
    addFileItem(line, cls);
  });

  window.electronAPI.onUpdateStatus(handleUpdateStatus);

  // Initial state: home view + auto-run the environment checklist.
  showView('home');
  setStageTracker(false);
  const elevated = await window.electronAPI.isElevated();
  if (!elevated) {
    checkList.innerHTML = '';
    checkList.appendChild(renderCheckRow('admin', 'Administrator', 'blocked',
      'Not running as Administrator. Close this app, right-click it → Run as administrator.'));
    fixBtn.disabled = true;
    shortcutBtn.disabled = true;
    setStatus('error', 'Not Admin');
    return;
  }
  shortcutBtn.disabled = false;
  runEnvironmentScan();
});

// ============================================================
// Footer: app version + admin badge
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
// Feedback modal — single Submit Feedback / Report entry: chooser (bug /
// rating / message+support-request), attach-report flow, report preview link
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
  attachGen++;
  const attachBtn = document.getElementById('fbAttachReport');
  attachBtn.disabled = false;
  attachBtn.textContent = 'Attach Support Report';
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

document.getElementById('btnSupport').addEventListener('click', openFeedback);
document.getElementById('btnVisitSite').addEventListener('click', () => window.electronAPI.openWebsite());
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

document.getElementById('fbViewReport').addEventListener('click', openSupportReport);

// Bug-report attach flow: pull the sanitized report into the bug description
// so one submission carries both. attachGen invalidates an in-flight build
// when the modal is closed/reopened (openFeedback bumps it), so a stale IPC
// completion can't write into a fresh form. Budget leaves headroom under the
// proxy's 4,000-char MAX_TEXT_CHARS for the auto-appended system-info block.
const MAX_ATTACH_CHARS = 3700;
let attachGen = 0;
document.getElementById('fbAttachReport').addEventListener('click', async () => {
  const btn = document.getElementById('fbAttachReport');
  const status = document.getElementById('fbBugStatus');
  status.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Attaching…';
  const gen = attachGen;
  try {
    const result = await window.electronAPI.supportReport({
      receipt: lastReceipt,
      logTail: logBuffer.join('\n'),
      stage:   lastStageLabel
    });
    if (gen !== attachGen) return;
    const md = result && result.markdown;
    if (!md) throw new Error('report unavailable');
    const ta = document.getElementById('fbBugText');
    const userText = ta.value.trim();
    let combined = userText ? userText + '\n\n---\n' + md : md;
    if (combined.length > MAX_ATTACH_CHARS) {
      const marker = '\n…[report trimmed to fit the 4,000-character limit]';
      combined = combined.slice(0, MAX_ATTACH_CHARS - marker.length) + marker;
      status.textContent = 'The report was trimmed to fit the 4,000-character limit.';
    }
    ta.value = combined;
    ta.dispatchEvent(new Event('input'));
    btn.textContent = 'Report attached'; // stays disabled: one attach per open
  } catch (err) {
    if (gen !== attachGen) return;
    btn.disabled = false;
    btn.textContent = 'Attach Support Report';
    status.textContent = 'Could not build the report — try again.';
  }
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
      statusEl.textContent = result.error || FEEDBACK_FALLBACK;
      statusEl.className = 'fb-status err';
    }
  } catch (err) {
    statusEl.textContent = FEEDBACK_NETWORK;
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
    supportTextArea.value = (result && result.markdown) ? result.markdown : reportBuildFailure(null);
  } catch (err) {
    supportTextArea.value = reportBuildFailure(err);
  }
}

function closeSupportReport() {
  supportOverlay.classList.remove('show');
  if (releaseSupportTrap) { releaseSupportTrap(); releaseSupportTrap = null; }
}

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

// Esc closes any open modal; also cancels a pending FIX countdown.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    cancelFixCountdown();
    // Close only the topmost overlay — the report preview can now sit on top
    // of the feedback modal, and closing both would wipe the user's draft.
    if      (supportOverlay.classList.contains('show'))                    closeSupportReport();
    else if (document.getElementById('fbOverlay').classList.contains('show')) closeFeedback();
  }
});
