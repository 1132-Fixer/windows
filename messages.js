// User-facing message catalog — the single source for error and status copy
// shown by the renderer. Loaded as a plain browser script before renderer.js
// (contextIsolation keeps require() out of the renderer) and require()-able
// from Node for tests, same pattern the Chrome extension uses for popup.js
// helpers.
//
// Copy rules (support standard): say what happened, whether it is safe,
// what the app does next, what the user can do, and keep the internal code
// visible so support can identify the incident. Never show a bare code,
// enum, 'unknown', or raw exception text as the whole message.

const FRIENDLY_ERRORS = {
  not_elevated:             'Process is not running as Administrator. Re-launch the app elevated (right-click → Run as administrator).',
  running_as_target:        'You are currently signed in as user1. Sign in as a different administrator and try again.',
  preflight_failed:         'Environment check found one or more blockers. Look at the highlighted lines above — each one tells you what to fix before retrying.',
  missing_tool:             'A required Windows tool is missing from PATH (powershell/taskkill/robocopy/icacls/takeown/net/reg). See preflight output above.',
  create_user_failed:       'Could not create the user1 account. Make sure the app is running as Administrator and that password policy allows the password.',
  delete_user_failed:       'Could not delete the existing user1 account. Make sure the app is running as Administrator.',
  delete_profile_failed:    'The user1 profile folder could not be removed — a file handle is still open. Reboot once and run the fix again.',
  delete_profile_timeout:   'Deleting the old user1 profile folder timed out — a program is still holding it open (Zoom, antivirus, or the search indexer are the usual suspects). Reboot once, then run the fix again.',
  zoom_not_found:           'Zoom Workplace was not found at C:\\Program Files\\Zoom\\bin\\Zoom.exe. Install the machine-wide Zoom Workplace MSI (not the per-user installer), then try again.',
  launch_failed:            'Zoom could not be launched as user1. Common causes: Secondary Logon service disabled, password policy mismatch, or user1 lacks permission to start C:\\Program Files\\Zoom\\bin\\Zoom.exe. Re-run as Administrator or check the log above for the exact PowerShell exception.',
  seclogon_disabled:        'The Secondary Logon service is disabled. It is required to launch processes under another local account. Run this from an admin shell and retry:  sc.exe config seclogon start= demand  &  sc.exe start seclogon',
  profile_not_materialized: 'The user1 profile did not appear in time. The account was created and Zoom was launched, but the per-user profile setup was skipped.',
  tool_probe_failed:        'The PowerShell tool probe failed. PowerShell itself may be missing or restricted by AppLocker/policy. The fix cannot continue.'
};

function friendlyError(code) {
  if (FRIENDLY_ERRORS[code]) return FRIENDLY_ERRORS[code];
  if (code) {
    return `Something went wrong and the fix could not finish (code: ${code}). ` +
      'It is safe to run the fix again. If it keeps failing, send us the code with Feedback & Report.';
  }
  return 'Something went wrong and the fix could not finish. ' +
    'It is safe to run the fix again. If it keeps failing, tell us what happened with Feedback & Report.';
}

// The fix flow threw before returning a result (IPC or renderer helper).
// The fix is idempotent by design — re-running is always safe.
function unexpectedFixFailure(err) {
  const detail = err && err.message ? String(err.message) : '';
  return 'The fix stopped before it could finish. It is safe to run the fix again.' +
    (detail ? ` If this keeps happening, send us this detail with Feedback & Report: ${detail}` : '');
}

// Environment scan failed outright (the IPC threw) — shown as the single
// checklist row. Most common real cause: the app is not elevated.
function scanFailureMessage(err) {
  const detail = err && err.message ? String(err.message) : '';
  return 'The environment check could not finish. Close 1132 Fixer and start it again as Administrator ' +
    '(right-click → Run as administrator).' +
    (detail ? ` Detail for support: ${detail}` : '');
}

// Shortcut creation failed. result.error carries raw PowerShell stderr or an
// exit code — useful to support, useless alone.
function shortcutFailureMessage(rawError) {
  const detail = rawError ? String(rawError) : '';
  return 'Could not create the shortcut. Nothing else was changed — you can try again with the ' +
    '"Create Zoom Helper Shortcut" button.' +
    (detail ? ` Detail for support: ${detail}` : '');
}

// Fix-receipt describers. Known states map to plain explanations; an
// unrecognized state is reported honestly, with the raw value kept visible
// for support instead of a bare enum or 'unknown'.
const HKU_STATES = {
  'session':   { txt: 'Active user1 session — consent written live',                                icon: 'info' },
  'temp-load': { txt: 'NTUSER.DAT loaded to write consent, then unloaded cleanly',                  icon: 'info' },
  'skipped':   { txt: 'Per-user write skipped — only HKLM floor applied (firstrun retries)',        icon: 'warn' }
};

const FRAME_SERVER_STATES = {
  'ok':                     { txt: 'Running normally',                                              icon: 'ok'   },
  'restored-from-disabled': { txt: 'Was Disabled — restored to Manual',                             icon: 'ok'   },
  'disabled-unfixable':     { txt: 'Disabled and could not be re-enabled — cameras will not work',  icon: 'fail' },
  'missing':                { txt: 'Service not present — cameras may not enumerate',               icon: 'fail' }
};

function describeUnrecognized(value, whatBroken) {
  if (!value) {
    return { txt: `Not recorded for this run. If ${whatBroken} is not working, run the fix again and send a support report.`, icon: 'info' };
  }
  return { txt: `Unrecognized state ("${value}") — this version does not know it. If ${whatBroken} is not working, send a support report and include this line.`, icon: 'warn' };
}

function describeHku(value) {
  return HKU_STATES[value] || describeUnrecognized(value, 'camera consent');
}

function describeFrameServer(value) {
  return FRAME_SERVER_STATES[value] || describeUnrecognized(value, 'the camera');
}

function receiptStatusFor(status) {
  switch (status) {
    case 'OK':
      return { text: 'GRANTED', status: 'ok' };
    case 'POLICY-BLOCKED':
      return { text: 'BLOCKED BY WINDOWS POLICY — your IT admin / device management blocks access. 1132 Fixer cannot override this.', status: 'fail' };
    case 'UNVERIFIED':
      return { text: 'UNVERIFIED — registry write did not confirm. Open Settings > Privacy & security under user1 and toggle on manually.', status: 'warn' };
    default: {
      const d = describeUnrecognized(status, 'camera or microphone');
      return { text: d.txt, status: d.icon === 'warn' ? 'warn' : 'info' };
    }
  }
}

// Feedback submit fallbacks (renderer side; main.js maps HTTP statuses).
const FEEDBACK_FALLBACK = 'Could not send right now. Check your internet connection and try again in a minute.';
const FEEDBACK_NETWORK  = 'Network error — the message was not sent. Check your internet connection and try again.';

// Support-report modal failure.
function reportBuildFailure(err) {
  const detail = err && err.message ? String(err.message) : (err ? String(err) : '');
  return 'Could not build the report. Close this window and try again. If it keeps failing, ' +
    'describe the problem with Feedback & Report instead.' +
    (detail ? ` Detail for support: ${detail}` : '');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FRIENDLY_ERRORS, friendlyError, unexpectedFixFailure, scanFailureMessage,
    shortcutFailureMessage, HKU_STATES, FRAME_SERVER_STATES, describeHku,
    describeFrameServer, receiptStatusFor, describeUnrecognized,
    FEEDBACK_FALLBACK, FEEDBACK_NETWORK, reportBuildFailure
  };
}
