// ============================================================
// ui-state.js — honest state mapping for every user-visible status
// surface. Pure and DOM-free: it maps a main-process state onto the
// *view* (icon key, badge word, tone, copy) and nothing else, so the
// mapping is testable in Node by tools/ui-state-smoke.js.
//
// Loaded as a plain browser script before renderer.js and require()-able
// from tools/ — the same pattern as messages.js and run-verdict.js.
//
// GOVERNING RULE: unknown !== success.
//
// Every function here is written so that a state this version does not
// recognise, a check that could not run, or a payload that never arrived
// resolves to an *unknown* rendering — never to a green check, never to
// silence. A rendering that could not be justified by real data is a
// wrong-data-state defect, not a cosmetic one: it tells the user their
// machine is fixed when nobody looked.
//
// Corollary for the TEMP/suffixed helper-profile contract (#160): a
// 'repairable' card — which is what a detected TEMP profile produces —
// must never roll up into a green summary. The rules below make the
// summary strictly no-greener than its worst rendered row.
// ============================================================

// ------------------------------------------------------------
// Checklist rows
// ------------------------------------------------------------

// The complete set of row states this version can render. 'unknown' is a
// first-class state, not a fallback that borrows another state's look.
const CHECK_STATUS_BADGE = {
  ready:      'Ready',
  repairable: 'Repairable',
  warning:    'Warning',
  blocked:    'Blocked',
  pending:    'Checking',
  unknown:    'Unknown'
};

// Icon KEY, not the SVG — the SVG strings stay renderer-side so this
// module holds no markup and can be required from Node.
const CHECK_STATUS_ICON = {
  ready:      'check',
  repairable: 'wrench',
  warning:    'warn',
  blocked:    'block',
  pending:    'dot',
  // An unrecognised status is a warning, never a check. This is the line
  // that used to read `default: svgCheck(...)`.
  unknown:    'warn'
};

// Anything not in the table is 'unknown'. A missing/blank/misspelled
// status from main must not inherit the success rendering.
function normalizeCheckStatus(status) {
  return Object.prototype.hasOwnProperty.call(CHECK_STATUS_BADGE, status)
    ? status
    : 'unknown';
}

function badgeForCheckStatus(status) {
  return CHECK_STATUS_BADGE[normalizeCheckStatus(status)];
}

function iconKeyForCheckStatus(status) {
  return CHECK_STATUS_ICON[normalizeCheckStatus(status)];
}

// A row the scan never reported. Dropping it silently would shorten the
// checklist and let an all-green list stand in for a check that never
// ran — the "fake zero" shape of this defect class.
const MISSING_CARD_MESSAGE =
  'This check was not reported by the environment scan, so its result is unknown — ' +
  'it is not a pass. Select "Check again". If it stays unknown, send a support report.';

// A row that could not run because the app is not elevated. Named
// separately so the copy can say what is missing AND what it costs.
const NOT_ELEVATED_CARD_MESSAGE =
  'Could not run — this check needs Administrator rights. Its result is unknown, not a pass.';

// ------------------------------------------------------------
// Summary badge
// ------------------------------------------------------------

// The summary is derived from the statuses ACTUALLY RENDERED, not from
// the roll-up label alone. Two reasons:
//
//  1. main.js ranks 'repairable' above 'warning', so a scan carrying both
//     reports overall='repairable'. The renderer previously had no
//     'repairable' branch and fell through to the green "Ready" badge —
//     which is exactly what a detected TEMP helper profile produced.
//  2. A roll-up value a future/older main emits that this version does
//     not know must not resolve to green either.
//
// Tones map 1:1 onto the existing .status-badge CSS classes.
const SUMMARY_TONE_ICON = {
  done:     '✓', // check
  warn:     '!',
  error:    '⨯', // cross
  scanning: '↻', // refresh
  action:   '●', // fix available — app-repairable, not a user warning
  unknown:  '?'
};

function summaryIcon(tone) {
  return Object.prototype.hasOwnProperty.call(SUMMARY_TONE_ICON, tone)
    ? SUMMARY_TONE_ICON[tone]
    : SUMMARY_TONE_ICON.unknown;
}

// statuses  : the row statuses the renderer just put on screen
// overall   : main's roll-up label ('ready'|'repairable'|'warning'|'blocked')
// canRunFix : main's own gate on the Fix button
//
// Returns { tone, text }. tone is a .status-badge CSS class.
function summarizeChecks(statuses, overall, canRunFix) {
  const list = (Array.isArray(statuses) ? statuses : []).map(normalizeCheckStatus);

  // No rows at all is not "nothing wrong" — it is "nothing was checked".
  if (list.length === 0) {
    return { tone: 'error', text: 'No checks ran' };
  }
  // A blocked row is a genuine external/manual blocker — amber "Action
  // required". Red stays reserved for actual failures (scan threw, fix
  // failed), which the runtime paths set directly.
  if (list.indexOf('blocked') !== -1 || overall === 'blocked' || canRunFix === false) {
    return { tone: 'warn', text: 'Action required' };
  }
  // Unknown outranks every non-blocking state: we do not know, so we do
  // not claim.
  if (list.indexOf('unknown') !== -1) {
    return { tone: 'warn', text: 'Unknown' };
  }
  // Repairable means the APP can fix it with one click — that is an offer,
  // not a warning, so it gets the accent "Fix available" badge, never the
  // generic amber "Action needed" it used to show.
  if (list.indexOf('repairable') !== -1) {
    return { tone: 'action', text: 'Fix available' };
  }
  if (list.indexOf('warning') !== -1) {
    return { tone: 'warn', text: 'Ready (warnings)' };
  }
  if (list.indexOf('pending') !== -1) {
    return { tone: 'scanning', text: 'Checking…' };
  }
  // Every row is 'ready'. Only a roll-up that agrees earns the green
  // badge; an unrecognised roll-up is reported as unknown.
  if (overall && overall !== 'ready') {
    return { tone: 'warn', text: 'Unknown' };
  }
  return { tone: 'done', text: 'Ready' };
}

// The disabled Fix button must always be able to say why. An empty
// reason list with the button disabled is a silent no-op.
const FIX_DISABLED_FALLBACK =
  'Fix now is disabled: the environment check did not clear, but this version could not name ' +
  'the blocking item. Select "Check again", then send a support report if it stays disabled.';

function fixDisabledNoteText(labels, canRunFix) {
  const list = (Array.isArray(labels) ? labels : []).filter(Boolean);
  if (canRunFix) return '';
  if (list.length === 0) return FIX_DISABLED_FALLBACK;
  return 'Fix now is disabled by: ' + list.join(', ');
}

// ------------------------------------------------------------
// Update banner
// ------------------------------------------------------------

// Every 'update-status' payload main can send, plus the two shapes it
// must never render as silence: a state this version does not know, and
// a payload that arrived malformed.
//
// The previous mapping hid the banner on both, which reads as "you are up
// to date" — an unknown update state presented as a settled result. It
// also auto-hid the 'error' banner after 6s, so a failed update check
// erased itself and left the app looking current.
// Copy lives in messages.js (UPDATE). The view returns which controls the
// banner shows: restartBtn / laterBtn (ready), retryBtn / continueBtn /
// diagBtn (failed, recovery), downloadBtn (portable notice, or the manual
// fallback once automatic retries are exhausted), okBtn (updated), and
// `overlay` names the blocking notice shown while the app is closing for
// the installer ('installing' | 'restarting').
function updateCopy() {
  if (typeof UPDATE !== 'undefined') return UPDATE;
  try { return require('./messages').UPDATE; } catch (_) { return null; }
}

function updateReasonText(stage, reason) {
  const U = updateCopy();
  const table = (U && U.REASONS) || {};
  // A library error is described by the stage it interrupted; every other
  // reason has its own sentence.
  if (reason === 'library-error' || reason === 'check-rejected' || !reason) {
    if (stage === 'check') return (U && U.FAILED_CHECK) || 'Could not check for updates.';
    if (stage === 'download') return (U && U.FAILED_DOWNLOAD) || 'The update download did not finish.';
  }
  if (reason && table[reason]) return table[reason];
  return table['library-error'] || 'Something interrupted the update.';
}

// The banner view for every 'update-status' payload: a title, one short
// message, a tone (info | warning | success | quiet), an icon name, an
// optional progress value or countdown, and which compact actions exist.
// Actions are booleans so the renderer only shows what the state allows:
//   downloadBtn  — only a positively verified newer version ("Download update")
//   notNowBtn    — dismisses that offer for now
//   restartBtn / laterBtn — a verified, downloaded update
//   retryBtn / dismissBtn — a failed check or download (never "Download update")
//   continueBtn / diagBtn — a failed or unverified install (recovery)
//   pageLink     — "Check the download page" text link (failed check, manual)
//   okBtn        — the post-update confirmation
// `overlay` names the blocking notice while the app is closing.
function updateBannerView(data) {
  const d = data && typeof data === 'object' ? data : {};
  const state = typeof d.state === 'string' ? d.state : '';
  const U = updateCopy() || {};
  const v = d.version ? String(d.version) : '';
  const c = d.current ? String(d.current) : '';
  const pct = Math.max(0, Math.min(100, Number(d.percent) || 0));
  const fill = (s) => String(s || '').replace('{v}', v || 'the new version').replace('{c}', c || 'the current version').replace('{p}', String(pct));
  const t = (key, dflt) => fill(U[key] || dflt);

  switch (state) {
    case 'checking':
      return { show: true, tone: 'quiet', icon: 'sync', title: t('CHECKING', 'Checking for updates'), msg: t('CHECKING_MSG', 'This only takes a moment.') };
    case 'available':
      if (d.quiet) return { show: false };
      return { show: true, tone: 'info', icon: 'download', title: t('AVAILABLE', 'Update available'), msg: t('AVAILABLE_MSG', 'Version {v} is ready to download.'), downloadBtn: true, notNowBtn: true };
    case 'downloading':
      return { show: true, tone: 'info', icon: 'download', title: t('DOWNLOADING', 'Downloading update'), msg: t('DOWNLOADING_MSG', 'Version {v} — {p}%.'), progress: pct };
    case 'verifying':
      return { show: true, tone: 'info', icon: 'shield', title: t('VERIFYING', 'Verifying update'), msg: t('VERIFYING_MSG', 'Checking that version {v} downloaded correctly.'), progress: 100 };
    case 'ready':
      if (d.deferred) {
        return { show: true, tone: 'info', icon: 'restart', title: t('READY', 'Ready to restart'), msg: t('READY_DEFERRED_MSG', 'Version {v} installs when you exit, or restart now.'), restartBtn: true };
      }
      return {
        show: true, tone: 'info', icon: 'restart',
        title: t('READY', 'Ready to restart'),
        msg: t('READY_MSG', '1132 Fixer restarts in {s} seconds to install version {v}.'),
        countdown: true,
        seconds: Number(d.seconds) > 0 ? Number(d.seconds) : 10,
        restartBtn: true,
        laterBtn: true
      };
    case 'installing':
      return { show: true, tone: 'info', icon: 'restart', title: t('INSTALLING', 'Installing update'), msg: t('INSTALLING_MSG', 'Version {v} is being installed. 1132 Fixer will reopen automatically.'), overlay: 'installing' };
    case 'restarting':
      return { show: true, tone: 'info', icon: 'restart', title: t('RESTARTING', 'Restarting 1132 Fixer'), msg: t('RESTARTING_MSG', 'The installer is finishing. 1132 Fixer reopens by itself.'), overlay: 'restarting' };
    case 'updated':
      return { show: true, tone: 'success', icon: 'check', title: t('UPDATED', '1132 Fixer was updated'), msg: t('UPDATED_MSG', 'You are now on version {v}.'), okBtn: true };
    case 'failed':
    case 'error': {
      if (d.quiet) return { show: false };
      const stage = d.stage || 'check';
      if (stage === 'check' || stage === 'metadata') {
        // The check did not produce a result. Nothing is known about a newer
        // version, so no download is offered — only a retry, a dismissal and
        // the official download page.
        return { show: true, tone: 'warning', icon: 'offline', title: t('CHECK_FAILED', 'Couldn’t check for updates'), msg: t('CHECK_FAILED_MSG', 'You can continue using 1132 Fixer. We’ll try again the next time the app starts.'), retryBtn: true, dismissBtn: true, pageLink: true };
      }
      if (stage === 'download' || stage === 'verify') {
        return { show: true, tone: 'warning', icon: 'offline', title: t('DOWNLOAD_FAILED', 'The update didn’t finish downloading'), msg: t('DOWNLOAD_FAILED_MSG', 'You can continue using 1132 Fixer and try the download again.'), retryBtn: true, dismissBtn: true, diagBtn: true };
      }
      const canRetry = d.canRetry !== false;
      return { show: true, tone: 'warning', icon: 'warning', title: t('INSTALL_FAILED', 'The update could not be installed'), msg: t('INSTALL_FAILED_MSG', '1132 Fixer is still on version {c} and works normally.'), retryBtn: canRetry, pageLink: !canRetry, continueBtn: true, diagBtn: true };
    }
    case 'recovery': {
      const canRetry = d.canRetry !== false;
      return { show: true, tone: 'warning', icon: 'warning', title: t('RECOVERY', 'The update could not be completed'), msg: t('RECOVERY_MSG', '1132 Fixer is still on version {c} and works normally.'), retryBtn: canRetry, pageLink: !canRetry, continueBtn: true, diagBtn: true };
    }
    case 'manual':
      return { show: true, tone: 'info', icon: 'download', title: t('MANUAL', 'Update available'), msg: t('MANUAL_MSG', "Version {v} is available. This portable version can't update itself — download the new one."), pageLink: true, dismissBtn: true };
    case 'idle':
      return { show: false };
    default:
      return {
        show: true, tone: 'warning', icon: 'warning',
        title: t('UNKNOWN', 'Update status unknown'),
        msg: t('UNKNOWN_MSG', '1132 Fixer could not tell whether a newer version exists. You can continue using it.') + (state ? ' (It reported "' + state + '", which this version does not recognise.)' : ''),
        retryBtn: true, dismissBtn: true, pageLink: true
      };
  }
}

// ------------------------------------------------------------
// Zoom installer launch
// ------------------------------------------------------------

// zoom-run-installer resolves { started: false } with NO message when the
// approved descriptor was already consumed or the spawn itself threw. The
// renderer used to change nothing in that case, leaving the pre-launch
// UAC notice on screen — copy that promises Windows will prompt and that
// the app will re-check when the installer finishes. Neither happened.
const INSTALLER_NOT_STARTED =
  'The installer did not start, so nothing was installed and nothing on this computer changed. ' +
  'Select "Choose installer…" again, or install Zoom Workplace yourself and then select "Check again".';

// The user declined the Windows administrator prompt, or the installer
// was cancelled. A decline is not a success and must not read as one.
const INSTALLER_DECLINED =
  'The installer closed without completing — Windows reported that it was cancelled or not approved. ' +
  'Zoom Workplace was not installed. Re-checking now.';

function installerExitNote(code) {
  const n = Number(code);
  if (n === 0) return '';
  // 1602 = user cancelled, 1223 = elevation prompt declined, -1 = spawn failed.
  return INSTALLER_DECLINED;
}

// ------------------------------------------------------------
// Fix receipt
// ------------------------------------------------------------

// A run that reports success but carries no receipt has not proven the
// four things the receipt exists to prove. Hiding the panel made that
// absence invisible under a "FIX COMPLETE" headline.
const RECEIPT_MISSING_MESSAGE =
  'The fix finished but did not return a receipt, so the camera, microphone, registry-hive and ' +
  'Frame Server results for this run are unknown — they are not confirmed. Run the fix again, ' +
  'and send a support report if the receipt stays missing.';

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CHECK_STATUS_BADGE,
    CHECK_STATUS_ICON,
    normalizeCheckStatus,
    badgeForCheckStatus,
    iconKeyForCheckStatus,
    MISSING_CARD_MESSAGE,
    NOT_ELEVATED_CARD_MESSAGE,
    SUMMARY_TONE_ICON,
    summaryIcon,
    summarizeChecks,
    FIX_DISABLED_FALLBACK,
    fixDisabledNoteText,
    updateBannerView,
    updateReasonText,
    INSTALLER_NOT_STARTED,
    INSTALLER_DECLINED,
    installerExitNote,
    RECEIPT_MISSING_MESSAGE
  };
}
