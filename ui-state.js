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
  if (list.indexOf('blocked') !== -1 || overall === 'blocked' || canRunFix === false) {
    return { tone: 'error', text: 'Blocked' };
  }
  // Unknown outranks every non-blocking state: we do not know, so we do
  // not claim.
  if (list.indexOf('unknown') !== -1) {
    return { tone: 'warn', text: 'Unknown' };
  }
  if (list.indexOf('repairable') !== -1) {
    return { tone: 'warn', text: 'Action needed' };
  }
  if (list.indexOf('warning') !== -1) {
    return { tone: 'warn', text: 'Ready (warnings)' };
  }
  if (list.indexOf('pending') !== -1) {
    return { tone: 'scanning', text: 'Checking' };
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
function updateBannerView(data) {
  const d = data && typeof data === 'object' ? data : {};
  const state = typeof d.state === 'string' ? d.state : '';
  const v = d.version ? 'v' + d.version : 'update';

  switch (state) {
    case 'downloading': {
      const pct = Math.max(0, Math.min(100, Number(d.percent) || 0));
      return { show: true, msg: 'Downloading ' + v + ' in the background… ' + pct + '%', progress: pct };
    }
    case 'restarting':
      return {
        show: true,
        msg: 'Update ' + v + ' is ready — restarting in {s}s to install.',
        countdown: true,
        seconds: Number(d.seconds) > 0 ? Number(d.seconds) : 10,
        restartBtn: true,
        laterBtn: true
      };
    case 'deferred':
      return {
        show: true,
        msg: 'Update ' + v + ' is ready — it installs automatically when you exit the app.',
        restartBtn: true
      };
    case 'manual':
      return {
        show: true,
        msg: 'Update ' + v + " is available. This portable version can't update itself — download the new one.",
        downloadBtn: true,
        laterBtn: true
      };
    case 'error':
      // Stays until dismissed. "Retries next launch" is true but does not
      // change the fact that RIGHT NOW the update state is unknown.
      return {
        show: true,
        msg: 'Update check failed — 1132 Fixer could not confirm whether a newer version exists. ' +
             'It retries on the next launch; you can also open the download page and check by hand.',
        downloadBtn: true,
        laterBtn: true
      };
    case 'idle':
      return { show: false };
    default:
      return {
        show: true,
        msg: 'Update status is unknown — 1132 Fixer could not tell whether a newer version exists' +
             (state ? ' (it reported "' + state + '", which this version does not recognise)' : '') +
             '. Open the download page to check by hand, or restart the app to try again.',
        downloadBtn: true,
        laterBtn: true
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
    INSTALLER_NOT_STARTED,
    INSTALLER_DECLINED,
    installerExitNote,
    RECEIPT_MISSING_MESSAGE
  };
}
