'use strict';

/**
 * Compact four-state presentation shell for 1132 Fixer.
 *
 * This module deliberately does not own repair/preflight state. The existing
 * renderer remains the source of truth and continues to drive the same DOM
 * nodes and IPC calls. We only reshape those nodes into the compact consumer
 * flow requested for the Windows app:
 *
 *   Checking -> Ready -> Fixing/Cancelling -> Complete
 *
 * Diagnostics, recovery guidance, feedback, updater notices, and error paths
 * remain available; they are simply subordinate to the main flow.
 */

const COMPACT_CSS = String.raw`
/* ================================================================
   1132 Fixer compact shell
   Presentation-only override. Existing renderer IDs remain canonical.
   ================================================================ */
:root {
  --compact-bg: #0f1724;
  --compact-surface: #172235;
  --compact-border: #2b3d57;
  --compact-text: #f5f7fb;
  --compact-muted: #a8b5c7;
  --compact-dim: #7f8da1;
  --compact-accent: #337fdb;
  --compact-accent-hover: #3b8ae8;
  --compact-success: #2bc66d;
  --compact-warning: #f3b84a;
  --compact-danger: #f05d67;
}

html, body {
  width: 100%;
  height: 100%;
  background: var(--compact-bg) !important;
}

body.compact-shell-enabled {
  min-width: 0;
  min-height: 0;
  color: var(--compact-text);
  overflow: hidden;
}

/* Retire the dashboard-like chrome. The compact top row is the stable
   outer shell: window-centered product mark, status, and Exit. */
body.compact-shell-enabled > .titlebar,
body.compact-shell-enabled > .header,
body.compact-shell-enabled > .footer {
  display: none !important;
}

.compact-topbar {
  height: 64px;
  flex: 0 0 64px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 24px;
  border-bottom: 1px solid transparent;
  -webkit-app-region: drag;
  position: relative;
  z-index: 20;
}

.compact-topbar[hidden] { display: none !important; }

/* Canonical product mark: assets/brand/app-mark.png. Centered on the
   full window width so status/Exit never shift it. Same size and
   coordinates in every wizard state. */
.compact-topbar .app-mark {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 44px;
  height: 44px;
  object-fit: contain;
  pointer-events: none;
  display: block;
}

.compact-status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 650;
  color: var(--compact-muted);
  letter-spacing: 0.01em;
}

.compact-status-icon {
  width: 16px;
  text-align: center;
  color: var(--compact-muted);
  font-size: 13px;
  line-height: 16px;
}

body[data-compact-state="ready"] .compact-status-icon { color: var(--compact-success); }
body[data-compact-state="fixing"] .compact-status-icon,
body[data-compact-state="cancelling"] .compact-status-icon { color: var(--compact-accent); }
body[data-compact-state="blocked"] .compact-status-icon,
body[data-compact-state="notice"] .compact-status-icon { color: var(--compact-warning); }
body[data-compact-state="error"] .compact-status-icon { color: var(--compact-danger); }
body[data-compact-state="cancelled"] .compact-status-icon { color: var(--compact-muted); }

.compact-topbar .compact-exit {
  width: auto !important;
  height: 36px !important;
  min-width: 48px;
  padding: 0 8px !important;
  border: 0 !important;
  border-radius: 8px !important;
  background: transparent !important;
  color: var(--compact-muted) !important;
  font: inherit;
  font-size: 12px !important;
  font-weight: 600 !important;
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.compact-topbar .compact-exit:hover {
  background: rgba(168,181,199,0.08) !important;
  color: var(--compact-text) !important;
}

/* Keep update information functional without letting it become a second
   dashboard. It only appears when the updater explicitly makes it visible. */
body.compact-shell-enabled > .update-banner {
  position: absolute;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  width: min(560px, calc(100% - 48px));
  margin: 0 !important;
  padding: 10px 12px !important;
  border-radius: 10px !important;
  z-index: 100;
  box-shadow: 0 12px 28px rgba(0,0,0,0.2);
}

body.compact-shell-enabled > .main {
  flex: 1 1 auto;
  min-height: 0;
  width: 100%;
  padding: 0 24px 18px !important;
  gap: 0 !important;
  overflow: hidden !important;
  display: flex !important;
  justify-content: center;
}

body[data-compact-state="checking"] > .main,
body[data-compact-state="success"] > .main {
  padding-top: 20px !important;
}

body.compact-shell-enabled .workspace {
  width: min(560px, 100%);
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0 !important;
  overflow: hidden;
}

body.compact-shell-enabled .wizard {
  flex: 0 0 auto !important;
  width: 100% !important;
  max-width: 520px;
  min-height: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
}

body.compact-shell-enabled .wiz-pane {
  width: 100%;
  min-height: 0 !important;
  padding: 0 !important;
  align-items: center !important;
  justify-content: flex-start !important;
  text-align: center !important;
}

body.compact-shell-enabled .wiz-title {
  margin: 0;
  color: var(--compact-text);
  font-size: 24px !important;
  line-height: 31px !important;
  font-weight: 650 !important;
  letter-spacing: -0.015em;
}

body.compact-shell-enabled .wiz-sub {
  margin-top: 12px !important;
  max-width: 410px;
  color: var(--compact-muted) !important;
  font-size: 14px !important;
  line-height: 21px !important;
  white-space: pre-line;
}

/* CHECKING ------------------------------------------------------- */
body.compact-shell-enabled #wizChecking .wiz-checks,
body.compact-shell-enabled #wizChecking .wiz-hint {
  display: none !important;
}

.compact-check-sub {
  margin: 12px 0 0;
  color: var(--compact-muted);
  font-size: 14px;
  line-height: 21px;
  text-align: center;
}

.compact-spinner {
  width: 28px;
  height: 28px;
  margin-top: 30px;
  border: 2px solid rgba(168,181,199,0.28);
  border-top-color: var(--compact-accent);
  border-radius: 50%;
  animation: compact-spin 900ms linear infinite;
}
@keyframes compact-spin { to { transform: rotate(360deg); } }

/* RESULT / READY ------------------------------------------------- */
body[data-compact-state="ready"] #wizResultGlyph {
  display: none !important;
}
body[data-compact-state="ready"] #zoomRecovery,
body[data-compact-state="ready"] #fixDisabledNote {
  display: none !important;
}

/* The option reads as a quiet one-line choice instead of a settings card. */
body[data-compact-state="ready"] #shortcutOpt {
  margin-top: 2px;
  padding: 0 !important;
  min-height: 32px;
  align-items: center;
  gap: 8px !important;
  color: var(--compact-muted);
}
body[data-compact-state="ready"] #shortcutOpt input {
  width: 14px !important;
  height: 14px !important;
  margin: 0 !important;
}
body[data-compact-state="ready"] #shortcutOpt .shortcut-opt-title {
  font-size: 13px !important;
  line-height: 18px !important;
  font-weight: 550 !important;
  color: var(--compact-muted) !important;
}
body[data-compact-state="ready"] #shortcutOpt .shortcut-opt-sub {
  display: none !important;
}

/* FIXING --------------------------------------------------------- */
body.compact-shell-enabled #wizFixing .stage-tracker,
body.compact-shell-enabled #wizFixing > .wiz-step-line,
body.compact-shell-enabled #wizFixing > .wiz-hint {
  display: none !important;
}

.compact-fix-detail {
  margin-top: 12px;
  min-height: 21px;
  color: var(--compact-muted);
  font-size: 14px;
  line-height: 21px;
}
.compact-step-line {
  margin-top: 16px;
  color: var(--compact-muted);
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
}
.compact-progress {
  width: min(380px, 86%);
  height: 5px;
  margin-top: 14px;
  overflow: hidden;
  border-radius: 999px;
  background: rgba(168,181,199,0.18);
}
.compact-progress-fill {
  width: 25%;
  height: 100%;
  border-radius: inherit;
  background: var(--compact-accent);
  transition: width 220ms ease-out;
}

/* SUCCESS -------------------------------------------------------- */
body[data-compact-state="success"] #wizNoticeGlyph {
  display: block !important;
  width: auto !important;
  height: auto !important;
  margin: 0 0 18px !important;
  color: var(--compact-success) !important;
}
body[data-compact-state="success"] #wizNoticeGlyph svg {
  width: 34px !important;
  height: 34px !important;
}

/* ACTIONS -------------------------------------------------------- */
body.compact-shell-enabled .action-area {
  flex: 0 0 auto !important;
  width: 100% !important;
  max-width: 520px;
  margin: 26px 0 0 !important;
  padding: 0 !important;
  gap: 10px !important;
}

body.compact-shell-enabled .action-area .button-container {
  width: 100%;
}

body.compact-shell-enabled .action-area .btn,
body.compact-shell-enabled .action-area .btn-primary {
  width: min(300px, 100%) !important;
  flex: 0 1 300px !important;
  min-height: 46px !important;
  padding: 11px 18px !important;
  border-radius: 10px !important;
  border: 1px solid var(--compact-border) !important;
  background: var(--compact-surface) !important;
  color: var(--compact-text) !important;
  font-size: 14px !important;
  line-height: 20px !important;
  font-weight: 650 !important;
  box-shadow: none !important;
  transform: none !important;
}
body.compact-shell-enabled .action-area .btn-primary,
body.compact-shell-enabled #fixBtn:not(.btn-quiet),
body.compact-shell-enabled #launchBtn {
  background: var(--compact-accent) !important;
  border-color: var(--compact-accent) !important;
  color: #fff !important;
}
body.compact-shell-enabled .action-area .btn-primary:hover:not(:disabled),
body.compact-shell-enabled #fixBtn:not(.btn-quiet):hover:not(:disabled),
body.compact-shell-enabled #launchBtn:hover:not(:disabled) {
  background: var(--compact-accent-hover) !important;
  border-color: var(--compact-accent-hover) !important;
}

body.compact-shell-enabled .secondary-row {
  margin-top: 0 !important;
  gap: 18px !important;
}
body.compact-shell-enabled .btn-quiet,
.compact-text-action {
  min-height: 34px !important;
  padding: 5px 8px !important;
  border: 0 !important;
  border-radius: 8px !important;
  background: transparent !important;
  color: var(--compact-muted) !important;
  font: inherit;
  font-size: 13px !important;
  line-height: 18px !important;
  font-weight: 600 !important;
  cursor: pointer;
}
body.compact-shell-enabled .btn-quiet:hover:not(:disabled),
.compact-text-action:hover:not(:disabled) {
  background: rgba(168,181,199,0.07) !important;
  color: var(--compact-text) !important;
}

.compact-run-actions {
  width: 100%;
  max-width: 520px;
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: 26px;
}
body[data-compact-state="checking"] .compact-run-actions { display: none; }
.compact-run-actions .compact-cancel {
  min-width: 180px;
  min-height: 44px;
  padding: 10px 18px;
  border-radius: 10px;
  border: 1px solid var(--compact-border);
  background: var(--compact-surface);
  color: var(--compact-text);
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.compact-run-actions .compact-cancel:hover { background: #1d2a3f; }
body[data-compact-state="ready"] .compact-cancel,
body[data-compact-state="ready"] .compact-done,
body[data-compact-state="blocked"] .compact-cancel,
body[data-compact-state="blocked"] .compact-done,
body[data-compact-state="notice"] .compact-cancel,
body[data-compact-state="notice"] .compact-done,
body[data-compact-state="error"] .compact-cancel,
body[data-compact-state="error"] .compact-done,
body[data-compact-state="cancelled"] .compact-cancel,
body[data-compact-state="cancelled"] .compact-done,
body[data-compact-state="success"] .compact-cancel { display: none; }
body[data-compact-state="fixing"] .compact-done,
body[data-compact-state="cancelling"] .compact-done { display: none; }
body[data-compact-state="cancelling"] .compact-cancel {
  opacity: 0.72;
  cursor: default;
}
.compact-run-actions .compact-done {
  min-height: 34px;
}

/* Details open as a dialog so they cannot grow the wizard or add nested
   page scroll. The landing page stays a single no-scroll column. */
body.compact-shell-enabled .adv-region {
  flex: 0 0 auto !important;
  width: 100% !important;
  max-width: 520px;
  margin: 0 !important;
  gap: 0 !important;
  overflow: visible;
  min-height: 0;
}
body.compact-shell-enabled .adv-region .log-actions { margin: 0 !important; }
body.compact-shell-enabled .adv-panel.hidden { display: none !important; }
body.compact-shell-enabled .adv-panel:not(.hidden) {
  position: fixed !important;
  inset: 64px 24px 72px !important;
  z-index: 80;
  max-height: none !important;
  width: auto !important;
  padding: 16px !important;
  overflow-y: auto !important;
  border: 1px solid var(--compact-border);
  border-radius: 14px;
  background: var(--compact-surface);
  box-shadow: 0 18px 52px rgba(0,0,0,0.32);
}
body.compact-shell-enabled .wiz-pane.active {
  max-height: none !important;
  overflow: hidden !important;
}
body.compact-shell-enabled .workspace {
  padding-bottom: 0 !important;
  justify-content: center;
}
.compact-status:empty,
.compact-status:has(.compact-status-text:empty) { display: none; }

/* The compact shell owns the visible View details control location. */
body[data-compact-state="fixing"] .action-area,
body[data-compact-state="cancelling"] .action-area,
body[data-compact-state="success"] .action-area,
body[data-compact-state="cancelled"] .action-area {
  margin-top: 24px !important;
}

/* Footer appears only on the ready/result screen. */
.compact-footer {
  flex: 0 0 48px;
  width: min(560px, 100%);
  min-height: 48px;
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 2px;
  color: var(--compact-dim);
  font-size: 12px;
}
.compact-footer[hidden] { display: none !important; }
.compact-footer-meta {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  gap: 4px;
}
.compact-footer .badge,
.compact-footer button {
  min-height: 32px !important;
  padding: 5px 8px !important;
  border: 0 !important;
  border-radius: 8px !important;
  background: transparent !important;
  color: var(--compact-dim) !important;
  font: inherit;
  font-size: 12px !important;
  line-height: 16px !important;
  font-weight: 600 !important;
  cursor: pointer;
}
.compact-footer #appVersion {
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 5px 0 !important;
  color: var(--compact-dim) !important;
  background: transparent !important;
  border: 0 !important;
}
.compact-footer button:hover { color: var(--compact-text) !important; background: rgba(168,181,199,0.07) !important; }

/* Hide dashboard-oriented extras from the primary flow. Explore stays a
   quiet footer text control so the product directory remains reachable
   without competing with Fix now. */
body.compact-shell-enabled #adminBadge {
  display: none !important;
}
body.compact-shell-enabled #projectDisclosure {
  display: flex !important;
  align-items: center;
  gap: 6px;
  margin: 0;
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: var(--compact-dim);
  font-size: 11px;
  line-height: 14px;
  font-weight: 500;
  pointer-events: none;
}
body.compact-shell-enabled #projectDisclosure span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
body.compact-shell-enabled #projectDisclosure .os-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 14px;
}

/* Blocked/recovery and error states remain truthful rather than being forced
   into the happy-path mockup. Tighten them to the same centered shell. */
body[data-compact-state="blocked"] #wizResultGlyph,
body[data-compact-state="notice"] #wizNoticeGlyph,
body[data-compact-state="error"] #wizNoticeGlyph {
  margin-bottom: 14px !important;
}
body[data-compact-state="blocked"] .zoom-recovery {
  max-height: 260px;
  overflow-y: auto;
  margin-top: 18px !important;
}



/* Exit while a fix is running is an explicit choice, never an implicit abort. */
.compact-exit-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(7, 12, 21, 0.72);
  backdrop-filter: blur(4px);
  -webkit-app-region: no-drag;
}
.compact-exit-overlay[hidden] { display: none !important; }
.compact-exit-dialog {
  width: min(390px, 100%);
  padding: 24px;
  border: 1px solid var(--compact-border);
  border-radius: 14px;
  background: var(--compact-surface);
  box-shadow: 0 18px 52px rgba(0,0,0,0.32);
  text-align: left;
}
.compact-exit-dialog h2 {
  margin: 0;
  font-size: 18px;
  line-height: 24px;
  font-weight: 650;
}
.compact-exit-dialog p {
  margin: 8px 0 20px;
  color: var(--compact-muted);
  font-size: 13px;
  line-height: 19px;
}
.compact-exit-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.compact-exit-dialog button {
  min-height: 40px;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--compact-border);
  background: transparent;
  color: var(--compact-text);
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
}
.compact-exit-dialog .compact-exit-confirm {
  background: var(--compact-danger);
  border-color: var(--compact-danger);
  color: #fff;
}

@media (max-width: 720px), (max-height: 650px) {
  .compact-topbar { height: 64px; flex-basis: 64px; padding: 0 18px; }
  .compact-topbar .app-mark { width: 44px; height: 44px; }
  body.compact-shell-enabled > .main { padding-left: 18px !important; padding-right: 18px !important; }
  body.compact-shell-enabled .wiz-title { font-size: 22px !important; line-height: 28px !important; }
  body.compact-shell-enabled .action-area, .compact-run-actions { margin-top: 20px !important; }
  .compact-footer { min-height: 42px; flex-basis: 42px; }
  body.compact-shell-enabled .adv-panel { max-height: 150px !important; }
}

@media (prefers-reduced-motion: reduce) {
  .compact-spinner { animation: none; border-top-color: rgba(168,181,199,0.28); }
  .compact-progress-fill { transition: none; }
}
`;

const FIX_STAGE_VIEW = Object.freeze({
  prep:    { step: 1, detail: 'Getting things ready…' },
  verify:  { step: 2, detail: 'Setting up a fresh Zoom profile…' },
  consent: { step: 3, detail: 'Applying camera and microphone settings…' },
  launch:  { step: 4, detail: 'Starting Zoom…' },
  receipt: { step: 4, detail: 'Checking that Zoom is ready…' }
});

function compactStageView(stage) {
  return FIX_STAGE_VIEW[stage] || FIX_STAGE_VIEW.prep;
}

function installCompactShell({ requestCancel, requestQuit } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const start = () => {
    const wizard = document.getElementById('wizardCard');
    const workspace = document.querySelector('.workspace');
    const appMark = document.querySelector('.app-mark');
    const originalExitBtn = document.getElementById('btnExit');
    const statusBadge = document.getElementById('statusBadge');
    const fixBtn = document.getElementById('fixBtn');
    const launchBtn = document.getElementById('launchBtn');
    const shortcutBtn = document.getElementById('shortcutBtn');
    const shortcutOpt = document.getElementById('shortcutOpt');
    const shortcutOptTitle = shortcutOpt && shortcutOpt.querySelector('.shortcut-opt-title');
    const rescanBtn = document.getElementById('rescanBtn');
    const detailsBtn = document.getElementById('detailsBtn');
    const supportBtn = document.getElementById('supportBtn');
    const actionArea = document.querySelector('.action-area');
    const advRegion = document.querySelector('.adv-region');
    const appVersion = document.getElementById('appVersion');
    const feedbackBtn = document.getElementById('btnSupport');

    // Fail open to the existing UI if the page structure ever changes.
    if (!wizard || !workspace || !appMark || !originalExitBtn || !statusBadge ||
        !fixBtn || !launchBtn || !detailsBtn || !actionArea || !advRegion) return;

    document.body.classList.add('compact-shell-enabled');
    detailsBtn.textContent = 'View details';
    if (shortcutOptTitle) shortcutOptTitle.textContent = 'Create desktop shortcut';

    const style = document.createElement('style');
    style.id = 'compactShellStyles';
    style.textContent = COMPACT_CSS;
    document.head.appendChild(style);

    // Stable header: window-centered canonical gear, status + Exit on the right.
    const topbar = document.createElement('div');
    topbar.className = 'compact-topbar';
    topbar.setAttribute('aria-label', '1132 Fixer');
    const compactStatus = document.createElement('div');
    compactStatus.className = 'compact-status';
    compactStatus.setAttribute('role', 'status');
    compactStatus.setAttribute('aria-live', 'polite');
    compactStatus.innerHTML = '<span class="compact-status-icon" aria-hidden="true"></span><span class="compact-status-text"></span>';
    topbar.appendChild(compactStatus);
    appMark.src = 'assets/brand/app-mark.png';
    appMark.alt = '1132 Fixer';
    appMark.width = 44;
    appMark.height = 44;
    topbar.appendChild(appMark);
    const compactExitBtn = document.createElement('button');
    compactExitBtn.type = 'button';
    compactExitBtn.className = 'compact-exit';
    compactExitBtn.textContent = 'Exit';
    compactExitBtn.setAttribute('aria-label', 'Exit 1132 Fixer');
    topbar.appendChild(compactExitBtn);
    document.body.insertBefore(topbar, document.querySelector('.update-banner') || document.body.firstChild);

    // Checking copy + spinner. Existing grouped checks still populate in the
    // hidden diagnostics source and are available from View details later.
    const checking = document.getElementById('wizChecking');
    const checkingTitle = checking && checking.querySelector('.wiz-title');
    const checkingSub = document.createElement('p');
    checkingSub.className = 'compact-check-sub';
    checkingSub.textContent = 'Making sure everything is ready.';
    const spinner = document.createElement('div');
    spinner.className = 'compact-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    if (checking) {
      checking.appendChild(checkingSub);
      checking.appendChild(spinner);
    }

    // Four-step progress presentation. The existing 5-stage rail remains the
    // source of truth; receipt is folded into step 4 for the consumer view.
    const fixing = document.getElementById('wizFixing');
    const fixingTitle = fixing && fixing.querySelector('.wiz-title');
    const fixDetail = document.createElement('p');
    fixDetail.className = 'compact-fix-detail';
    const stepLine = document.createElement('p');
    stepLine.className = 'compact-step-line';
    const progress = document.createElement('div');
    progress.className = 'compact-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '1');
    progress.setAttribute('aria-valuemax', '4');
    const progressFill = document.createElement('div');
    progressFill.className = 'compact-progress-fill';
    progress.appendChild(progressFill);
    if (fixing) {
      fixing.appendChild(fixDetail);
      fixing.appendChild(stepLine);
      fixing.appendChild(progress);
    }

    // Running/success actions that are intentionally not part of the old
    // setActions() state table. Cancel is cooperative: preload routes the
    // request through the fix-cancellation broker and the repair stops only
    // at a known-safe workflow boundary. Done is a normal application exit.
    const runActions = document.createElement('div');
    runActions.className = 'compact-run-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'compact-cancel';
    cancelBtn.textContent = 'Cancel fix';
    cancelBtn.title = 'Stop after the current safe step.';
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'compact-text-action compact-done';
    doneBtn.textContent = 'Done';
    runActions.append(cancelBtn, doneBtn, detailsBtn);
    // Put the primary action area before the quiet state actions/details so
    // the visual order is Fix/Open -> Done/Cancel -> View details.
    workspace.insertBefore(actionArea, advRegion);
    workspace.insertBefore(runActions, advRegion);

    const exitOverlay = document.createElement('div');
    exitOverlay.className = 'compact-exit-overlay';
    exitOverlay.hidden = true;
    exitOverlay.setAttribute('role', 'dialog');
    exitOverlay.setAttribute('aria-modal', 'true');
    exitOverlay.setAttribute('aria-labelledby', 'compactExitTitle');
    exitOverlay.innerHTML = `
      <div class="compact-exit-dialog">
        <h2 id="compactExitTitle">A fix is running</h2>
        <p>1132 Fixer can stop safely after the current step finishes.</p>
        <div class="compact-exit-dialog-actions">
          <button type="button" class="compact-exit-keep">Keep running</button>
          <button type="button" class="compact-exit-confirm">Cancel fix and exit</button>
        </div>
      </div>`;
    document.body.appendChild(exitOverlay);
    const exitKeepBtn = exitOverlay.querySelector('.compact-exit-keep');
    const exitConfirmBtn = exitOverlay.querySelector('.compact-exit-confirm');

    // Minimal footer: independence disclosure, Explore, Support, Feedback,
    // About. The app version node is moved, not copied.
    const compactFooter = document.createElement('div');
    compactFooter.className = 'compact-footer';
    if (appVersion) compactFooter.appendChild(appVersion);
    const projectDisclosure = document.getElementById('projectDisclosure');
    if (projectDisclosure) compactFooter.appendChild(projectDisclosure);
    const footerMeta = document.createElement('div');
    footerMeta.className = 'compact-footer-meta';
    const exploreBtn = document.getElementById('btnExplore');
    if (exploreBtn) {
      exploreBtn.classList.remove('badge', 'site-badge');
      exploreBtn.classList.add('compact-footer-explore');
      footerMeta.appendChild(exploreBtn);
    }
    const footerSupport = document.createElement('button');
    footerSupport.type = 'button';
    footerSupport.className = 'compact-footer-support';
    footerSupport.textContent = 'Support';
    footerSupport.addEventListener('click', () => {
      if (supportBtn) supportBtn.click();
    });
    footerMeta.appendChild(footerSupport);
    if (feedbackBtn) {
      feedbackBtn.textContent = 'Feedback';
      footerMeta.appendChild(feedbackBtn);
    }
    const aboutBtn = document.createElement('button');
    aboutBtn.type = 'button';
    aboutBtn.className = 'compact-footer-about';
    aboutBtn.textContent = 'About';
    aboutBtn.setAttribute('aria-label', 'About 1132 Fixer');
    aboutBtn.addEventListener('click', () => {
      const about = document.getElementById('aboutOverlay');
      if (about) {
        about.hidden = false;
        const close = document.getElementById('aboutClose');
        if (close) close.focus();
      }
    });
    footerMeta.appendChild(aboutBtn);
    compactFooter.appendChild(footerMeta);
    workspace.appendChild(compactFooter);

    const panes = {
      checking: document.getElementById('wizChecking'),
      result: document.getElementById('wizResult'),
      fixing: document.getElementById('wizFixing'),
      notice: document.getElementById('wizNotice')
    };
    const resultTitle = document.getElementById('wizResultTitle');
    const resultSub = document.getElementById('wizResultSub');
    const noticeTitle = document.getElementById('wizNoticeTitle');
    const noticeSub = document.getElementById('wizNoticeSub');
    const zoomRecovery = document.getElementById('zoomRecovery');
    const secondaryRow = document.querySelector('.secondary-row');
    let cancelRequested = false;
    let exitAfterCancel = false;
    let quitAfterCancelScheduled = false;

    async function askForCancellation({ exitWhenDone = false } = {}) {
      if (cancelRequested) return;
      cancelRequested = true;
      exitAfterCancel = exitAfterCancel || exitWhenDone;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      scheduleSync();
      if (typeof requestCancel !== 'function') {
        cancelRequested = false;
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel fix';
        scheduleSync();
        return;
      }
      try {
        const result = await requestCancel();
        if (!result || result.cancelRequested !== true) {
          cancelRequested = false;
          cancelBtn.disabled = false;
          cancelBtn.textContent = 'Cancel fix';
          scheduleSync();
        }
      } catch (_) {
        cancelRequested = false;
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel fix';
        scheduleSync();
      }
    }

    cancelBtn.addEventListener('click', () => askForCancellation());
    doneBtn.addEventListener('click', () => { if (typeof requestQuit === 'function') requestQuit(); });
    compactExitBtn.addEventListener('click', () => {
      const state = document.body.dataset.compactState || '';
      if (state === 'fixing' || state === 'cancelling') {
        exitOverlay.hidden = false;
        exitKeepBtn.focus();
        return;
      }
      if (typeof requestQuit === 'function') requestQuit();
    });
    exitKeepBtn.addEventListener('click', () => {
      exitOverlay.hidden = true;
      compactExitBtn.focus();
    });
    exitConfirmBtn.addEventListener('click', () => {
      exitOverlay.hidden = true;
      askForCancellation({ exitWhenDone: true });
    });
    exitOverlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        exitOverlay.hidden = true;
        compactExitBtn.focus();
      }
    });

    function activePane() {
      for (const [name, el] of Object.entries(panes)) {
        if (el && el.classList.contains('active')) return name;
      }
      return 'checking';
    }

    function setCompactStatus(icon, text) {
      const iconEl = compactStatus.querySelector('.compact-status-icon');
      const textEl = compactStatus.querySelector('.compact-status-text');
      if (iconEl.textContent !== icon) iconEl.textContent = icon;
      if (textEl.textContent !== text) textEl.textContent = text;
    }

    function setElementHidden(el, hidden) {
      if (el && el.hidden !== hidden) el.hidden = hidden;
    }

    function sourceTone() {
      return statusBadge.getAttribute('data-tone') || '';
    }

    function updateFixingProgress() {
      const tracker = document.getElementById('stageTracker');
      let stage = 'prep';
      if (tracker) {
        const active = tracker.querySelector('.stage-pill[data-state="active"]');
        if (active) stage = active.getAttribute('data-stage') || stage;
        else {
          // A completed receipt can briefly exist before the notice pane swaps.
          const receipt = tracker.querySelector('.stage-pill[data-stage="receipt"]');
          if (receipt && ['done', 'warn', 'fail'].includes(receipt.getAttribute('data-state'))) stage = 'receipt';
        }
      }
      const view = compactStageView(stage);
      fixDetail.textContent = view.detail;
      stepLine.textContent = `Step ${view.step} of 4`;
      progressFill.style.width = `${view.step * 25}%`;
      progress.setAttribute('aria-valuenow', String(view.step));
      progress.setAttribute('aria-valuetext', `Step ${view.step} of 4: ${view.detail}`);
    }

    let syncing = false;
    let scheduled = false;
    function scheduleSync() {
      if (syncing || scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        syncing = true;
        try { sync(); } finally { syncing = false; }
      });
    }

    function sync() {
      const pane = activePane();
      const tone = sourceTone();
      const fixVisible = !fixBtn.hidden;
      const launchVisible = !launchBtn.hidden;
      const elevateVisible = !!document.getElementById('elevateBtn') && !document.getElementById('elevateBtn').hidden;
      const recoveryVisible = !!zoomRecovery && !zoomRecovery.hidden;

      // A result is "ready" only when the canonical renderer exposed a valid
      // fix/launch path. A blocked result stays blocked; we never manufacture
      // permission to run a repair.
      const resultCanProceed = pane === 'result' && !elevateVisible && !recoveryVisible && fixVisible;
      const fixOutcome = document.documentElement.dataset.fixOutcome || '';
      const success = pane === 'notice' && tone === 'done';
      const error = pane === 'notice' && tone === 'error';

      let state = pane;
      if (fixOutcome === 'cancelled') state = 'cancelled';
      else if (pane === 'fixing' && cancelRequested) state = 'cancelling';
      else if (pane === 'result') state = resultCanProceed ? 'ready' : 'blocked';
      else if (pane === 'notice') state = error ? 'error' : (success ? 'success' : 'notice');
      document.body.dataset.compactState = state;

      if (checkingTitle) checkingTitle.textContent = 'Checking…';
      if (fixingTitle) fixingTitle.textContent = 'Fixing Zoom';

      // Default visibility before per-state overrides. The product mark
      // stays in the stable header in every state.
      topbar.hidden = false;
      appMark.hidden = false;
      compactFooter.hidden = false;

      if (state === 'checking') {
        setCompactStatus('', '');
        return;
      }

      if (state === 'ready') {
        setCompactStatus('', '');
        if (resultTitle) resultTitle.textContent = 'Ready to fix Zoom';
        if (resultSub) {
          resultSub.textContent = 'Start Zoom with a fresh setup.\nYour personal files won’t be changed.';
          resultSub.hidden = false;
        }

        setElementHidden(fixBtn, false);
        if (fixBtn.textContent !== 'Starting after check…') fixBtn.textContent = 'Fix now';
        setElementHidden(launchBtn, true);
        setElementHidden(shortcutBtn, true);
        setElementHidden(shortcutOpt, false);
        setElementHidden(rescanBtn, true);
        setElementHidden(detailsBtn, false);
        return;
      }

      if (state === 'fixing' || state === 'cancelling') {
        if (state === 'cancelling') {
          setCompactStatus('●', 'Cancelling');
          if (fixingTitle) fixingTitle.textContent = 'Cancelling…';
          fixDetail.textContent = 'Finishing the current step safely…';
          cancelBtn.disabled = true;
          cancelBtn.textContent = 'Cancelling…';
        } else {
          setCompactStatus('●', 'Fixing');
          if (fixingTitle) fixingTitle.textContent = 'Fixing Zoom';
          cancelBtn.disabled = false;
          cancelBtn.textContent = 'Cancel fix';
          updateFixingProgress();
        }
        // Keep the single diagnostics escape hatch available during work.
        setElementHidden(detailsBtn, false);
        return;
      }

      if (state === 'cancelled') {
        setCompactStatus('○', 'Cancelled');
        if (noticeTitle) noticeTitle.textContent = 'Fix cancelled';
        if (noticeSub) {
          noticeSub.textContent = 'Nothing else will be changed.';
          noticeSub.hidden = false;
        }
        setElementHidden(launchBtn, true);
        setElementHidden(shortcutBtn, true);
        setElementHidden(rescanBtn, true);
        setElementHidden(detailsBtn, false);
        setElementHidden(supportBtn, true);
        if (!fixBtn.hidden) fixBtn.textContent = 'Try again';
        cancelRequested = false;
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel fix';
        if (exitAfterCancel && !quitAfterCancelScheduled && typeof requestQuit === 'function') {
          quitAfterCancelScheduled = true;
          window.setTimeout(() => requestQuit(), 0);
        }
        return;
      }

      if (state === 'success') {
        setCompactStatus('', '');
        if (noticeTitle) noticeTitle.textContent = "You're all set";
        if (noticeSub) {
          noticeSub.textContent = document.documentElement.dataset.fixOutcome === 'cancel-too-late'
            ? 'Zoom is ready to use. The fix finished before it could be cancelled.'
            : 'Zoom is ready to use.';
          noticeSub.hidden = false;
        }
        cancelRequested = false;
        cancelBtn.disabled = false;
        cancelBtn.textContent = 'Cancel fix';
        setElementHidden(launchBtn, false);
        launchBtn.textContent = 'Open Zoom';
        setElementHidden(shortcutBtn, true);
        setElementHidden(rescanBtn, true);
        setElementHidden(detailsBtn, false);
        setElementHidden(supportBtn, true);
        return;
      }

      // Blocked, warning, and failure states retain their canonical copy and
      // actions; only the surrounding chrome is simplified.
      if (state === 'error') setCompactStatus('!', 'Needs attention');
      else if (state === 'blocked') setCompactStatus('!', 'Action needed');
      else setCompactStatus('!', 'Needs attention');
    }

    const observer = new MutationObserver(scheduleSync);
    observer.observe(wizard, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-state', 'data-tone'] });
    observer.observe(actionArea, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled'] });
    observer.observe(statusBadge, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-tone'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fix-outcome'] });

    // Renderer initialization runs in its own DOMContentLoaded listener after
    // this preload listener. Reconcile once more on the next task after it has
    // selected its initial state and populated real version/elevation data.
    sync();
    window.setTimeout(scheduleSync, 0);
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

module.exports = {
  installCompactShell,
  compactStageView
};
