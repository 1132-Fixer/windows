'use strict';

/**
 * Compact presentation shell for 1132 Fixer.
 *
 * This module deliberately does not own repair/preflight state. The
 * renderer remains the source of truth and continues to drive the same DOM
 * nodes and IPC calls. The shell:
 *
 *   - derives the compact state (checking → ready/blocked → fixing/
 *     cancelling → success/error/notice/cancelled) from what the renderer
 *     painted and publishes it on <body data-compact-state>;
 *   - applies the per-state copy for the consumer flow;
 *   - owns the two controls the renderer's outcome table does not know:
 *     cooperative Cancel fix and the exit confirmation while a fix runs;
 *   - applies the screen action gate (screen-actions.js) after every
 *     renderer change, so a control from another screen is never visible.
 *
 * The header, footer and action area are static markup in index.html; the
 * shell moves no nodes and hides nothing with CSS that the gate should
 * own. Details is a renderer-owned view (renderer.js openDetails) and only
 * reports itself here through <body data-view="details">.
 */

const COMPACT_CSS = String.raw`
/* ================================================================
   1132 Fixer compact shell — state-specific presentation only.
   Every colour is a :root token from index.html; no hex here.
   ================================================================ */

/* CHECKING: title, one line, spinner. The grouped check rows stay in the
   DOM for assistive technology (the pane is a status region) but the
   consumer view is the sentence plus spinner. */
body.compact-shell-enabled #wizChecking .wiz-checks { display: none; }
.compact-check-sub {
  margin: var(--s-2) 0 0;
  color: var(--muted);
  font-size: 14px;
  line-height: 20px;
  text-align: center;
}
.compact-spinner {
  width: 28px;
  height: 28px;
  margin-top: var(--s-6);
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: compact-spin 900ms linear infinite;
}
@keyframes compact-spin { to { transform: rotate(360deg); } }

/* READY: no glyph above the title; the copy carries the state. */
body[data-compact-state="ready"] #wizResultGlyph,
body[data-compact-state="ready"] #zoomRecovery,
body[data-compact-state="ready"] #fixDisabledNote { display: none; }

/* FIXING: the renderer's five-stage tracker IS the progress display; it
   is driven by the real orchestrator. One detail line and a "Step n of 5"
   progressbar sit under it. */
body.compact-shell-enabled #wizFixing > .wiz-step-line { display: none; }
body.compact-shell-enabled #wizFixing .stage-tracker {
  width: min(360px, 100%);
  margin: var(--s-4) auto 0;
  text-align: left;
}
.compact-fix-detail {
  margin-top: var(--s-3);
  min-height: 20px;
  color: var(--muted);
  font-size: 14px;
  line-height: 20px;
}
.compact-step-line {
  margin-top: var(--s-2);
  color: var(--muted);
  font-size: 13px;
  line-height: 18px;
  font-weight: 600;
}

/* SUCCESS / notices keep the renderer glyph, tightened. */
body[data-compact-state="success"] #wizNoticeGlyph,
body[data-compact-state="notice"] #wizNoticeGlyph,
body[data-compact-state="error"] #wizNoticeGlyph,
body[data-compact-state="cancelled"] #wizNoticeGlyph,
body[data-compact-state="blocked"] #wizResultGlyph { margin-bottom: var(--s-3); }
body[data-compact-state="success"] #wizNoticeGlyph { color: var(--success); }

/* BLOCKED: the Zoom recovery card is the one genuinely long surface; it
   scrolls inside the pane rather than growing the window. */
body[data-compact-state="blocked"] .zoom-recovery {
  max-height: 260px;
  overflow-y: auto;
  margin-top: var(--s-4);
}
body[data-compact-state="cancelling"] #cancelFixBtn { opacity: 0.72; }

/* Exit while a fix is running is an explicit choice, never an implicit abort. */
.compact-exit-overlay {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: grid;
  place-items: center;
  padding: var(--s-6);
  background: rgba(15, 23, 36, 0.72);
  -webkit-app-region: no-drag;
}
.compact-exit-overlay[hidden] { display: none; }
.compact-exit-dialog {
  width: min(390px, 100%);
  padding: var(--s-6);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--panel);
  box-shadow: var(--shadow-lg);
  text-align: left;
}
.compact-exit-dialog h2 { margin: 0; font-size: 18px; line-height: 24px; font-weight: 700; }
.compact-exit-dialog p { margin: var(--s-2) 0 var(--s-5); color: var(--muted); font-size: 13px; line-height: 18px; }
.compact-exit-dialog-actions { display: flex; justify-content: flex-end; gap: var(--s-2); }
.compact-exit-dialog button {
  min-height: 40px;
  padding: 0 var(--s-4);
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.compact-exit-dialog button:hover { background: var(--panel-2); }
.compact-exit-dialog button:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.compact-exit-dialog .compact-exit-confirm { background: var(--danger); border-color: var(--danger); color: #fff; }

@media (prefers-reduced-motion: reduce) {
  .compact-spinner { animation: none; border-top-color: var(--border-strong); }
}
`;

// Five real orchestrator stages, one row each in #stageTracker. The step
// number is the row's position; nothing here is a percentage.
const FIX_STAGE_VIEW = Object.freeze({
  prep:    { step: 1, detail: 'Getting things ready…' },
  verify:  { step: 2, detail: 'Setting up the fresh Zoom environment…' },
  consent: { step: 3, detail: 'Applying camera and microphone settings…' },
  launch:  { step: 4, detail: 'Starting Zoom…' },
  receipt: { step: 5, detail: 'Checking that Zoom is ready…' }
});
const FIX_STAGE_COUNT = 5;

function compactStageView(stage) {
  return FIX_STAGE_VIEW[stage] || FIX_STAGE_VIEW.prep;
}

function installCompactShell({ requestCancel, requestQuit, gate } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const applyGate = typeof gate === 'function'
    ? gate
    : (typeof applyScreenControls === 'function' ? applyScreenControls : () => []);

  const start = () => {
    try { console.log('[compact-shell] start readyState=' + document.readyState); } catch (_) {}
    const wizard = document.getElementById('wizardCard');
    const appMark = document.querySelector('.app-mark');
    const exitBtn = document.getElementById('btnExit');
    const statusBadge = document.getElementById('statusBadge');
    const fixBtn = document.getElementById('fixBtn');
    const launchBtn = document.getElementById('launchBtn');
    const shortcutBtn = document.getElementById('shortcutBtn');
    const shortcutOpt = document.getElementById('shortcutOpt');
    const rescanBtn = document.getElementById('rescanBtn');
    const detailsBtn = document.getElementById('detailsBtn');
    const supportBtn = document.getElementById('supportBtn');
    const cancelBtn = document.getElementById('cancelFixBtn');
    const doneBtn = document.getElementById('doneBtn');
    const actionArea = document.querySelector('.action-area');

    if (!wizard || !appMark || !exitBtn || !statusBadge || !fixBtn || !launchBtn ||
        !detailsBtn || !actionArea || !cancelBtn || !doneBtn) {
      console.warn('[compact-shell] missing required nodes', {
        wizard: !!wizard, appMark: !!appMark, exitBtn: !!exitBtn, statusBadge: !!statusBadge,
        fixBtn: !!fixBtn, launchBtn: !!launchBtn, detailsBtn: !!detailsBtn,
        actionArea: !!actionArea, cancelBtn: !!cancelBtn, doneBtn: !!doneBtn
      });
      document.body.classList.add('compact-shell-enabled');
      return;
    }

    document.body.classList.add('compact-shell-enabled');
    appMark.src = 'assets/brand/app-mark.png';
    appMark.alt = '1132 Fixer';

    const style = document.createElement('style');
    style.id = 'compactShellStyles';
    style.textContent = COMPACT_CSS;
    document.head.appendChild(style);

    // Checking copy + spinner.
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

    // Fixing progress: "Step n of 5" is the accessible progress value
    // (role=progressbar, integer steps, announced politely as the
    // orchestrator advances). The visible rows live in #stageTracker.
    const fixing = document.getElementById('wizFixing');
    const fixingTitle = fixing && fixing.querySelector('.wiz-title');
    const fixDetail = document.createElement('p');
    fixDetail.className = 'compact-fix-detail';
    const stepLine = document.createElement('p');
    stepLine.className = 'compact-step-line';
    stepLine.setAttribute('role', 'progressbar');
    stepLine.setAttribute('aria-valuemin', '1');
    stepLine.setAttribute('aria-valuemax', String(FIX_STAGE_COUNT));
    stepLine.setAttribute('aria-live', 'polite');
    if (fixing) {
      fixing.appendChild(fixDetail);
      fixing.appendChild(stepLine);
    }

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
    let cancelRequested = false;
    let exitAfterCancel = false;
    let quitAfterCancelScheduled = false;

    function resetCancelButton() {
      cancelRequested = false;
      cancelBtn.disabled = false;
      cancelBtn.textContent = 'Cancel fix';
    }

    // Cancel is cooperative: preload routes the request through the
    // fix-cancellation broker and the repair stops only at a known-safe
    // workflow boundary.
    async function askForCancellation({ exitWhenDone = false } = {}) {
      if (cancelRequested) return;
      cancelRequested = true;
      exitAfterCancel = exitAfterCancel || exitWhenDone;
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
      scheduleSync();
      if (typeof requestCancel !== 'function') {
        resetCancelButton();
        scheduleSync();
        return;
      }
      try {
        const result = await requestCancel();
        if (!result || result.cancelRequested !== true) {
          resetCancelButton();
          scheduleSync();
        }
      } catch (_) {
        resetCancelButton();
        scheduleSync();
      }
    }

    cancelBtn.addEventListener('click', () => askForCancellation());
    doneBtn.addEventListener('click', () => { if (typeof requestQuit === 'function') requestQuit(); });
    exitBtn.addEventListener('click', () => {
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
      exitBtn.focus();
    });
    exitConfirmBtn.addEventListener('click', () => {
      exitOverlay.hidden = true;
      askForCancellation({ exitWhenDone: true });
    });
    exitOverlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        exitOverlay.hidden = true;
        exitBtn.focus();
      }
    });

    function activePane() {
      for (const [name, el] of Object.entries(panes)) {
        if (el && el.classList.contains('active')) return name;
      }
      return 'checking';
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
      stepLine.textContent = `Step ${view.step} of ${FIX_STAGE_COUNT}`;
      stepLine.setAttribute('aria-valuenow', String(view.step));
      stepLine.setAttribute('aria-valuetext', `Step ${view.step} of ${FIX_STAGE_COUNT}: ${view.detail}`);
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

    function deriveState() {
      const pane = activePane();
      const tone = sourceTone();
      const fixVisible = !fixBtn.hidden;
      const elevateVisible = !!document.getElementById('elevateBtn') && !document.getElementById('elevateBtn').hidden;
      const recoveryVisible = !!zoomRecovery && !zoomRecovery.hidden;
      // A result is "ready" only when the renderer exposed a valid fix path.
      // A blocked result stays blocked; the shell never manufactures
      // permission to run a repair.
      const resultCanProceed = pane === 'result' && !elevateVisible && !recoveryVisible && fixVisible;
      const fixOutcome = document.documentElement.dataset.fixOutcome || '';
      const success = pane === 'notice' && tone === 'done';
      const error = pane === 'notice' && tone === 'error';
      if (fixOutcome === 'cancelled') return 'cancelled';
      if (pane === 'fixing' && cancelRequested) return 'cancelling';
      if (pane === 'result') return resultCanProceed ? 'ready' : 'blocked';
      if (pane === 'notice') return error ? 'error' : (success ? 'success' : 'notice');
      return pane;
    }

    function sync() {
      const state = deriveState();
      document.body.dataset.compactState = state;
      const view = document.body.dataset.view || '';

      if (checkingTitle) checkingTitle.textContent = 'Checking…';
      if (fixingTitle) fixingTitle.textContent = 'Fixing Zoom';

      // Shell-owned controls: Cancel only while work runs, Done only on a
      // completed repair. Everything else is the renderer's outcome table.
      setElementHidden(cancelBtn, !(state === 'fixing' || state === 'cancelling'));
      setElementHidden(doneBtn, state !== 'success');

      if (state === 'ready') {
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
      } else if (state === 'fixing' || state === 'cancelling') {
        if (state === 'cancelling') {
          if (fixingTitle) fixingTitle.textContent = 'Cancelling…';
          fixDetail.textContent = 'Finishing the current step safely…';
          cancelBtn.disabled = true;
          cancelBtn.textContent = 'Cancelling…';
        } else {
          cancelBtn.disabled = false;
          cancelBtn.textContent = 'Cancel fix';
          updateFixingProgress();
        }
        // Keep the single details disclosure available during work.
        setElementHidden(detailsBtn, false);
      } else if (state === 'cancelled') {
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
        resetCancelButton();
        if (exitAfterCancel && !quitAfterCancelScheduled && typeof requestQuit === 'function') {
          quitAfterCancelScheduled = true;
          window.setTimeout(() => requestQuit(), 0);
        }
      } else if (state === 'success') {
        if (noticeTitle) noticeTitle.textContent = "You're all set";
        if (noticeSub) {
          noticeSub.textContent = document.documentElement.dataset.fixOutcome === 'cancel-too-late'
            ? 'Zoom is ready to use. The fix finished before it could be cancelled.'
            : 'Zoom is ready to use.';
          noticeSub.hidden = false;
        }
        resetCancelButton();
        setElementHidden(launchBtn, false);
        launchBtn.textContent = 'Open Zoom';
        setElementHidden(rescanBtn, true);
        setElementHidden(detailsBtn, false);
        setElementHidden(supportBtn, true);
      }
      // blocked / error / notice keep the renderer's copy and actions.

      // The gate: whatever the renderer or this shell painted, only the
      // controls this screen allows stay visible.
      applyGate(state, document, view);
    }

    const observer = new MutationObserver(scheduleSync);
    observer.observe(wizard, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-state', 'data-tone'] });
    observer.observe(actionArea, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled'] });
    observer.observe(statusBadge, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'data-tone'] });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-fix-outcome'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-view'] });

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

// Two hosts:
//  - Node (tests): export the API.
//  - The renderer page: index.html loads this file as a classic script
//    before renderer.js, so it installs itself here. It must NOT be
//    required from preload.js — a sandboxed preload can only require the
//    Electron shim modules, and `require('./src/preload/compact-shell')`
//    threw "module not found", which aborted the whole preload and left the
//    page without window.electronAPI (the packaged 6.2.0–6.3.1 startup
//    failure, caught by tools/packaged-acceptance.js).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    installCompactShell,
    compactStageView
  };
} else if (typeof window !== 'undefined') {
  const api = () => window.electronAPI;
  installCompactShell({
    requestCancel: () => (api() && api().quitApp ? api().quitApp() : Promise.resolve(null)),
    requestQuit: () => (api() && api().quitApp ? api().quitApp() : Promise.resolve(null))
  });
}
