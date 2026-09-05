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

// Environment checklist structure — row keys, fallback labels, display
// order, and the §9 Doctor group headers. Lives here (not renderer.js) so
// tools/messages-smoke.js can test the shipped mapping; renderer.js reads
// it as a global, the same way it reads the rest of this catalog.
const CHECK_ORDER = [
  { key: 'admin',       label: 'Administrator',       group: 'App' },
  { key: 'zoom',        label: 'Zoom Workplace',      group: 'Zoom' },
  { key: 'helperUser',    label: 'Helper account',      group: 'Helper account' },
  { key: 'helperProfile', label: 'Helper profile',      group: 'Helper account' },
  { key: 'seclogon',      label: 'Secondary Logon',     group: 'Helper account' },
  { key: 'camPolicy',   label: 'Camera policy',       group: 'Privacy policies' },
  { key: 'micPolicy',   label: 'Microphone policy',   group: 'Privacy policies' },
  { key: 'hku',         label: 'User registry hive',  group: 'Privacy policies' },
  { key: 'frameServer', label: 'Camera Frame Server', group: 'Camera service' }
];

const FRIENDLY_ERRORS = {
  not_elevated:             'Process is not running as Administrator. Re-launch the app elevated (right-click → Run as administrator).',
  running_as_target:        'You are currently signed in as user1. Sign in as a different administrator and try again.',
  preflight_failed:         'Environment check found one or more blockers. Look at the highlighted lines above — each one tells you what to fix before retrying.',
  missing_tool:             'A required Windows tool is missing from PATH (powershell/taskkill/robocopy/icacls/takeown/net/reg). See preflight output above.',
  create_user_failed:       'Could not create the user1 account. Make sure the app is running as Administrator and that password policy allows the password.',
  delete_user_failed:       'Could not delete the existing user1 account. Make sure the app is running as Administrator.',
  delete_profile_failed:    'The user1 profile folder could not be removed — a file handle is still open. Reboot once and run the fix again.',
  delete_profile_timeout:   'Deleting the old user1 profile folder timed out — a program is still holding it open (Zoom, antivirus, or the search indexer are the usual suspects). Reboot once, then run the fix again.',
  zoom_not_found:           'No machine-wide Zoom Workplace install was found on this PC. Install the machine-wide Zoom Workplace MSI (not the per-user installer) — download it from zoom.us/download under "Zoom Workplace for IT admins" — then try again.',
  launch_failed:            'Zoom could not be started in the fresh setup. Nothing else was changed. Press Try again. If it happens again, restart Windows, run Fix now once more, and use Support Report if it still fails. The exact reason is under View details.',
  seclogon_disabled:        'The Secondary Logon service is disabled. It is required to launch processes under another local account. Run this from an admin shell and retry:  sc.exe config seclogon start= demand  &  sc.exe start seclogon',
  profile_not_materialized: 'The user1 profile did not appear in time. The account was created and Zoom was launched, but the per-user profile setup was skipped.',
  temp_or_suffixed_profile: 'Windows did not land Zoom in the real C:\\Users\\user1 profile — it fell back to a TEMP or suffixed profile. The 1132 identity may not be clean. Reboot once, then run the fix again. 1132 Fixer does not delete TEMP folders by name guessing.',
  temp_profile_fallback:    'Windows gave user1 a temporary profile instead of C:\\Users\\user1. The 1132 identity may not be clean. Reboot once, then run the fix again.',
  suffixed_profile:         'Windows created a suffixed profile (user1.MACHINE) instead of C:\\Users\\user1. Reboot once, then run the fix again.',
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
    '"Create desktop shortcut" button.' +
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

// ============================================================
// Zoom Workplace guided recovery card.
// Copy below is approved copy, pinned byte-exact by
// tools/messages-smoke.js: title, primary description, both helper texts,
// the seven state strings, the official admin download URL, and the two
// accepted publisher names. Never reword them here.
//
// Truthfulness rule: the card never claims
// automatic or background repair that has no mechanism. Detection is
// read-only; nothing on the computer changes unless the user launches an
// installer they chose and approved; the ONE automatic behavior described
// (re-check when the installer finishes) is implemented exactly as written
// (installer process exit -> read-only environment re-scan).
// ============================================================
const ZOOM_RECOVERY = {
  TITLE: 'Zoom Workplace needs to be installed',
  DESCRIPTION: '1132 Fixer uses the computer-wide version of Zoom Workplace. We could not find that version on this PC.',
  HELPER_LABEL: 'What does this mean?',
  HELPER_TEXT: 'Zoom may be missing, or you may have a personal version installed only for your Windows account. Install the 64-bit MSI version so Zoom works for every user on this computer.',
  WHY_LABEL: 'Why is the MSI version required?',
  WHY_TEXT: 'The MSI package installs Zoom in the standard Windows program folder. This lets 1132 Fixer reliably find, check, and repair Zoom for every Windows user on this computer.',
  TECH_LABEL: 'Technical details',
  FLAG_LABEL: 'Action required',
  DOWNLOAD_URL: 'https://zoom.us/download/admin',
  PUBLISHERS: ['Zoom Communications, Inc.', 'Zoom Video Communications, Inc.'],
  ACTIONS: {
    download: 'Download Zoom MSI',
    recheck: 'I installed it — Check again',
    choose: 'Choose installer file',
    cancel: 'Cancel setup',
    // Replaces the "Cancel setup" label once msiexec is running: at that point
    // closing the app no longer cancels anything, so the label must not imply
    // it does.
    close_installing: 'Close 1132 Fixer'
  },
  // Accessible name for the download button — the external-link icon is
  // decorative (aria-hidden), so the name itself says a browser opens and
  // where it goes. Nothing essential lives in a tooltip.
  DOWNLOAD_ARIA: "Download Zoom MSI — opens Zoom's official download page (zoom.us/download/admin) in your browser",
  STATES: {
    downloading: "Opening Zoom's official download page…",
    waiting: 'Install Zoom Workplace, then return here and select Check again.',
    checking: 'Checking for Zoom Workplace…',
    success: 'Zoom Workplace is installed and ready.',
    still_not_found: 'We still cannot find the computer-wide Zoom installation. Make sure you installed the MSI version, then check again.',
    wrong_version: 'We found Zoom, but it is installed only for one Windows user. Install the computer-wide MSI version to continue.',
    offline: "We could not open Zoom's download page. Check your internet connection, or choose an MSI installer already saved on this computer."
  },
  // Cancel row copy — truthfulness: states exactly what has and has not
  // been changed. Checking is read-only; nothing installs without the user.
  CANCEL_NOTE: 'Cancelling makes no changes: checking for Zoom is read-only, and 1132 Fixer installs nothing unless you choose an installer and approve it. Closing the app now leaves this computer exactly as it is.',
  // Replaces CANCEL_NOTE once msiexec is running. The "leaves this computer
  // exactly as it is" promise is no longer true — Windows is mid-install and
  // closing 1132 Fixer does not stop it — so the copy must say so.
  CANCEL_NOTE_INSTALLING: 'The installer is running now. Closing 1132 Fixer will not stop it — Windows finishes the installation on its own. When it finishes, 1132 Fixer checks for Zoom again automatically.',
  // Shown AFTER a chosen installer passes every validation check and BEFORE
  // msiexec starts — explains the Windows admin-approval prompt first, and
  // describes the one real automatic behavior (installer-exit re-check).
  UAC_NOTE: 'The file passed all checks. Windows may now ask you to approve the installation — approval happens in the Windows prompt, and 1132 Fixer never asks for or stores your password. When the installer finishes, 1132 Fixer checks for Zoom again automatically.'
};

// "Technical details" disclosure body — the raw paths, demoted out of the
// main explanation per the directive. Mirrors what resolveZoomInstall()
// actually probes: both default machine-wide dirs plus any custom install
// dir a Zoom MSI registered in the Windows installer registry.
function zoomRecoveryTechDetails(install) {
  const { perUserPath } = install || {};
  const lines = [
    'Machine-wide locations checked: C:\\Program Files\\Zoom\\bin\\Zoom.exe, ' +
    'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe, plus any custom install directory ' +
    'registered by a Zoom MSI in the Windows installer registry (HKLM uninstall keys). ' +
    'This check is read-only — nothing on this computer was changed.'
  ];
  if (perUserPath) {
    lines.push(`Per-user Zoom found at: ${perUserPath} — installed only for your Windows account, so the fix's helper account cannot use it.`);
  }
  return lines.join('\n');
}

// Installer-validation refusal copy — names the EXACT failed check and states
// that nothing was executed (truthfulness rule). `detail` carries the raw
// status / signer / architecture facts so support can identify the incident.
function zoomInstallerRefusal(code, detail) {
  const d = detail ? String(detail) : '';
  const source = `Download the installer again from ${ZOOM_RECOVERY.DOWNLOAD_URL} and retry.`;
  switch (code) {
    case 'not_msi_ext':
      return `Failed check: file type. The selected file is not a .msi installer package — nothing was run. Choose the MSI file downloaded from ${ZOOM_RECOVERY.DOWNLOAD_URL}.`;
    case 'not_msi_magic':
      return `Failed check: file format. The selected file has a .msi name but its contents are not a real Windows Installer package — nothing was run. ${source}`;
    case 'changed':
      return `Failed check: file integrity. The chosen installer changed on disk after it passed its checks — nothing was run. ${source}`;
    case 'unreadable':
      return `Failed check: file access. The selected file could not be read${d ? ` (${d})` : ''} — nothing was run. ${source}`;
    case 'signature':
      return `Failed check: digital signature. The selected file's signature is not valid (Windows reports: ${d || 'no signature'}) — nothing was run. ${source}`;
    case 'publisher':
      return `Failed check: publisher. The selected file is signed by "${d || 'an unknown publisher'}", not by Zoom — nothing was run. ${source}`;
    case 'architecture':
      // detail is the full archCompare explanation — never a silent mismatch.
      return `Failed check: processor architecture. ${d} Nothing was run. ${source}`;
    default:
      return `The selected installer could not be validated${d ? ` (${d})` : ''} — nothing was run. It is safe to try again. ${source}`;
  }
}

// ============================================================
// Wizard copy — the state-driven center card (UX simplification,
// operator directive 2026-08-23). Titles/subtitles for each wizard
// state live here so tools/messages-smoke.js can pin them and the
// renderer stays presentation-only. Technical diagnostics stay in
// Advanced details; nothing here repeats a raw code or log line.
// ============================================================

// Grouped summary rows for the CHECKING pane — derived from CHECK_ORDER so
// the wizard can never drift from the real checklist. Each group's status
// is the WORST of its rows (the same unknown!==success discipline).
const WIZARD_GROUP_LABELS = {
  'App':             'Administrator',
  'Zoom':            'Zoom Workplace',
  'Helper account':  'Helper account',
  'Privacy policies':'Privacy policies',
  'Camera service':  'Camera service'
};
const WIZARD_GROUPS = CHECK_ORDER.reduce((groups, c) => {
  const last = groups[groups.length - 1];
  if (last && last.group === c.group) { last.keys.push(c.key); return groups; }
  groups.push({ group: c.group, label: WIZARD_GROUP_LABELS[c.group] || c.group, keys: [c.key] });
  return groups;
}, []);

const WIZARD = {
  // Ready means the tool can run the repair. It is NOT a claim that Zoom
  // error 1132 is absent, that the helper account works, or that Zoom is healthy.
  READY_TITLE:    'Ready to fix Zoom',
  READY_SUB:      'Start Zoom with a fresh setup.\nYour personal files won’t be changed.',
  CHECKING_TITLE: 'Checking…',
  CHECKING_SUB:   'Making sure everything is ready.',
  READY_WARN_TITLE: 'Ready, with warnings',
  READY_WARN_SUB: 'The fix can run, but some checks reported warnings — open View details to see them.',
  UNKNOWN_TITLE:  "Couldn't verify everything",
  UNKNOWN_SUB:    'Some checks did not report a result, so their state is unknown — not a pass. ' +
                  'The fix can still run. Open View details for the per-check detail.',
  BLOCKED_TITLE:  'Action required',
  ADMIN_TITLE:    'Administrator access required',
  // Shown when the automatic elevation attempt did not go through (declined
  // Windows prompt, or the probe could not confirm rights). The button is
  // the retry; the manual right-click path stays as the fallback of record.
  ADMIN_SUB:      '1132 Fixer needs administrator access to create the fresh Windows setup used for Zoom.',
  ADMIN_PRIMARY:  'Restart as administrator',
  ADMIN_CLOSE:    'Close',
  ADMIN_DECLINED_SUB: 'Windows approval was declined or did not complete, so 1132 Fixer is still not ' +
                  'running as Administrator. Nothing has been changed. Select "Restart as administrator" ' +
                  'to try again.',
  ADMIN_RESTARTING: 'Restarting with administrator access…',
  UNABLE_TITLE:   'Unable to complete',
  UNABLE_SUB:     'The startup check did not finish in time. Nothing has been changed on this computer.',
  TRY_AGAIN:      'Try again',
  FIXING_TITLE:   'Fixing Zoom',
  FIXING_START:   'Getting things ready…',
  SUCCESS_TITLE:  'Complete',
  SUCCESS_SUB:    'Zoom has been fixed and is ready to use.',
  PARTIAL_TITLE:  'Finished — some items need attention',
  PARTIAL_SUB:    'The fix ran, but some steps could not be completed. Open View details to see exactly what needs attention.',
  WARNINGS_SUB:   'The fix finished with warnings. Open View details to read them.',
  FAIL_TITLE:     "Couldn't complete the fix",
  CONFIRM_TITLE:  'Before we start',
  CONFIRM_BODY:   '1132 Fixer will replace its helper account and helper profile. Your signed-in Windows account and personal files will not be changed. Zoom will open in the fresh helper environment. You can cancel only at safe checkpoints.',
  CONFIRM_CONTINUE: 'Continue',
  CONFIRM_CANCEL: 'Go back',
  SHORTCUT_NOT_READY_TITLE: "Shortcut isn't ready yet",
  SHORTCUT_NOT_READY_SUB:   'Run the repair once before creating the Zoom Helper shortcut — it stores the sign-in the shortcut needs.',
  SHORTCUT_FAILED_TITLE:    "The shortcut couldn't be created",
  SHORTCUT_FAILED_SUB:      'Nothing else was changed — you can try again. The technical detail is under Advanced details.',
  SHORTCUT_DONE_TITLE:      'Shortcut created',
  SHORTCUT_DONE_SUB:        "It's on your desktop — double-click it to start Zoom as the helper."
};

// "One fix found" / "3 fixes found" — count comes from the repairable rows
// actually rendered, so the headline can never promise more than the scan
// reported.
function wizardFixFoundTitle(count) {
  return count === 1 ? 'One fix found' : `${count} fixes found`;
}
// Safety is stated ONCE, here (design review P0-4) — no second
// explanatory line elsewhere on the screen.
function wizardFixFoundSub(labels) {
  const list = (Array.isArray(labels) ? labels : []).filter(Boolean);
  if (list.length === 1) {
    const label = list[0].charAt(0).toLowerCase() + list[0].slice(1);
    return `The ${label} needs repair. Your Zoom files and data won't be changed.`;
  }
  const what = list.length ? list.join(', ') : 'Repairable items';
  return `${what} need repair. Your Zoom files and data won't be changed.`;
}
// Manual blockers — name them, plainly, without the raw diagnostics.
function wizardBlockedSub(labels) {
  const list = (Array.isArray(labels) ? labels : []).filter(Boolean);
  if (!list.length) {
    return 'Something on this PC blocks the fix, but this version could not name it. ' +
      'Select Check again; if it stays blocked, send a support report.';
  }
  return `${list.join(', ')} ${list.length > 1 ? 'need' : 'needs'} your attention before the fix can run.`;
}

// ============================================================
// Explore launcher catalog (directive 2026-08-23). Pure destination
// VIEW data — display name, subtitle, logo asset, grouping — keyed by the
// same fixed keys the security layer owns (electron-security.js
// EXPLORE_DESTINATIONS). The renderer builds the modal from this list, so
// destinations are never hand-duplicated across markup, and the smoke can
// assert the view and the security map never drift.
// logo:null = no supplied brand asset -> the renderer shows the generic
// 40×40 fallback glyph (never a broken image, never invented artwork).
// ============================================================
const EXPLORE_COPY = {
  TITLE: 'Explore',
  SUB: 'Explore apps, bots, and tools. Links open in your browser.',
  // The secondary directory heading. Deliberately quieter than the hero:
  // 1132 Fixer is the subject of this panel, and everything below it is
  // the network around it.
  NETWORK_TITLE: 'Explore the network',
  NETWORK_SUB: 'Organizations, bots, and creative tools',
  VISIT: 'Visit project',
  OPENED: 'Opened in your browser.',
  FAILED: 'Could not open the website — try again.'
};

// Category order IS render order IS focus order. One list, so the three
// can never drift apart - the ordering tests assert against this.
const EXPLORE_CATEGORIES = [
  { id: 'featured',       label: 'FEATURED' },
  { id: 'organizations',  label: 'ORGANIZATIONS & SERVICES' },
  { id: 'bots',           label: 'BOTS' },
  { id: 'creative-tools', label: 'CREATIVE TOOLS' }
];
const EXPLORE_VIEW = [
  // id           name                 description                     category         icon                                  accent      featured
  { id: 'fixer',          name: '1132 Fixer',      description: 'Project website',            category: 'featured',       icon: 'assets/logo-transparent.png'   ,     accent: 'blue',   featured: true  },
  { id: 'botify',         name: 'Botify Network',  description: 'Network home',               category: 'organizations',  icon: 'assets/explore/botify.png',         accent: 'blue',   featured: false },
  { id: 'primeHosting',   name: 'Prime Hosting',   description: 'Hosting and developer services', category: 'organizations', icon: 'assets/explore/prime-hosting.png', accent: 'violet', featured: false },
  { id: 'gifDirectory',   name: 'GIF Directory',   description: 'Organize and discover GIFs', category: 'organizations',  icon: 'assets/explore/gif-directory.png',  accent: 'purple', featured: false },
  { id: 'kickbot',        name: 'BotifyKickBot',   description: 'Moderation bot',             category: 'bots',           icon: 'assets/explore/kickbot.png',        accent: null,     featured: false },
  { id: 'modbot',         name: 'BotifyModBot',    description: 'Community management bot',   category: 'bots',           icon: 'assets/explore/modbot.png',         accent: null,     featured: false },
  { id: 'emojiGenerator', name: 'Emoji Generator', description: 'Create custom emoji',        category: 'creative-tools', icon: 'assets/explore/emojiGenerator.png', accent: null,     featured: false },
  { id: 'makeItGif',      name: 'Make It GIF',     description: 'Create and convert GIFs',    category: 'creative-tools', icon: 'assets/explore/make-it-gif.png',    accent: null,     featured: false }
];
// Waiting Room Attendant: a brand asset is staged at
// assets/explore/waiting-room-attendant.png, but the app has NO canonical
// WRA destination URL, so it is deliberately NOT in this list (never guess
// URLs). Add a row + an EXPLORE_DESTINATIONS entry when the canonical URL
// is ruled.

// ============================================================
// Project disclosure (addendum 2026-08-23) — persistent trust line.
// INDEPENDENCE is the exact approved wording; never reworded. Rendered
// into the shell (above the footer) and, subdued, at the bottom of the
// Explore panel — from this single source.
// ============================================================
const DISCLOSURE = {
  OS_LABEL: 'Open Source',
  INDEPENDENCE: 'Independent project. Not affiliated with Zoom.',
  LEGAL: 'Independent project. Not affiliated with, sponsored by, or endorsed by Zoom Communications, Inc.',
  DESCRIPTION: '1132 Fixer is an independent open-source Windows profile-isolation utility that recreates a local helper account and starts an existing Zoom Workplace installation using that separate Windows profile.',
  ZOOM_OBTAIN: 'Zoom Workplace must be installed separately. Obtain it from Zoom’s official Download Center. 1132 Fixer does not download, bundle, modify, or redistribute Zoom Workplace.',
  ARIA: 'Open Source. Independent project. Not affiliated with Zoom.'
};

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

// ------------------------------------------------------------
// Update lifecycle copy. One line per state, plain English, no library
// error text. The {v} and {s} placeholders are the target version and the
// countdown seconds. REASONS explains a failed stage in one sentence; the
// technical detail stays in the updater log and the diagnostics dialog.
// ------------------------------------------------------------
const UPDATE = {
  // Banner title / message per state ({v} target version, {c} current
  // version, {p} percent, {s} countdown seconds).
  CHECKING:    'Checking for updates',
  CHECKING_MSG: 'This only takes a moment.',
  CURRENT:     '1132 Fixer is up to date',
  AVAILABLE:   'Update available',
  AVAILABLE_MSG: 'Version {v} is ready to download.',
  DOWNLOADING: 'Downloading update',
  DOWNLOADING_MSG: 'Version {v} — {p}%. You can keep using 1132 Fixer.',
  VERIFYING:   'Verifying update',
  VERIFYING_MSG: 'Checking that version {v} downloaded correctly.',
  READY:       'Ready to restart',
  READY_MSG:   '1132 Fixer restarts in {s} seconds to install version {v}.',
  READY_DEFERRED_MSG: 'Version {v} installs when you exit, or restart now.',
  INSTALLING:  'Installing update',
  INSTALLING_MSG: 'Version {v} is being installed. 1132 Fixer will reopen automatically.',
  RESTARTING:  'Restarting 1132 Fixer',
  RESTARTING_MSG: 'The installer is finishing. 1132 Fixer reopens by itself.',
  UPDATED:     '1132 Fixer was updated',
  UPDATED_MSG: 'You are now on version {v}.',
  CHECK_FAILED: 'Couldn’t check for updates',
  CHECK_FAILED_MSG: 'You can continue using 1132 Fixer. We’ll try again the next time the app starts.',
  DOWNLOAD_FAILED: 'The update didn’t finish downloading',
  DOWNLOAD_FAILED_MSG: 'You can continue using 1132 Fixer and try the download again.',
  INSTALL_FAILED: 'The update could not be installed',
  INSTALL_FAILED_MSG: '1132 Fixer is still on version {c} and works normally.',
  RECOVERY:    'The update could not be completed',
  RECOVERY_MSG: '1132 Fixer is still on version {c} and works normally.',
  MANUAL:      'Update available',
  MANUAL_MSG:  "Version {v} is available. This portable version can't update itself — download the new one.",
  UNKNOWN:     'Update status unknown',
  UNKNOWN_MSG: '1132 Fixer could not tell whether a newer version exists. You can continue using it.',
  RESTART_NOW: 'Restart now',
  LATER:       'Later',
  NOT_NOW:     'Not now',
  RETRY:       'Retry',
  RETRY_UPDATE: 'Retry update',
  DISMISS:     'Dismiss',
  CONTINUE:    'Continue with current version',
  DIAGNOSTICS: 'View diagnostic details',
  DOWNLOAD:    'Download update',
  DOWNLOAD_PAGE: 'Check the download page',
  OK:          'OK',
  INSTALL_OVERLAY_TITLE: 'Installing update',
  INSTALL_OVERLAY_BODY:  'The verified update {v} is being installed. 1132 Fixer will close and reopen automatically — this takes about a minute.',
  RESTART_OVERLAY_TITLE: 'Restarting 1132 Fixer',
  RESTART_OVERLAY_BODY:  '1132 Fixer is closing so the installer can finish. It reopens by itself when the update is in place.',
  DIAG_TITLE: 'Update diagnostic details',
  DIAG_NOTE:  'Paths and names are redacted. The full log is in the updater log file listed below.',
  DIAG_COPY:  'Copy details',
  DIAG_COPIED: 'Copied',
  DIAG_CLOSE: 'Close',
  REASONS: {
    'offline':                     'No internet connection was available.',
    'timeout':                     'The update service did not answer in time.',
    'service-unavailable':         'The update service could not be reached.',
    'invalid-response':            'The update service sent a response 1132 Fixer could not read.',
    'no-compatible-asset':         'The release has no installer for this Windows.',
    'integrity-failed':            'The downloaded file did not pass its integrity check.',
    'download-failed':             'The download was interrupted.',
    'library-error':               'Something interrupted the update.',
    'check-rejected':              'The update check did not finish. Check your internet connection.',
    'metadata-missing':            'The release information was empty.',
    'metadata-version-invalid':    'The release information had an invalid version.',
    'metadata-version-current':    'The release offered is the version already installed.',
    'metadata-version-older':      'The release offered is older than the installed version.',
    'metadata-prerelease-on-stable': 'A pre-release build was offered to the stable channel and was refused.',
    'metadata-no-installer':       'The release information named no installer.',
    'metadata-artifact-name':      'The installer name in the release information was not recognised.',
    'metadata-artifact-version-mismatch': 'The installer name did not match the release version.',
    'metadata-arch-mismatch':      'The release is built for a different processor type than this Windows.',
    'metadata-sha512-missing':     'The release information carried no checksum.',
    'downloaded-version-mismatch': 'The downloaded release did not match the one that was announced.',
    'downloaded-file-missing':     'The downloaded file could not be found.',
    'downloaded-file-name':        'The downloaded file had an unexpected name.',
    'size-mismatch':               'The downloaded file was the wrong size.',
    'sha512-mismatch':             'The downloaded file did not match the published checksum.',
    'hash-failed':                 'The downloaded file could not be read for verification.',
    'verify-threw':                'Verification stopped unexpectedly.',
    'no-verified-file':            'No verified update file was available.',
    'not-installed-build':         'This copy of 1132 Fixer was not installed with the installer, so it cannot update itself.',
    'unexpected-executable':       '1132 Fixer is running from an unexpected file.',
    'elevation-required':          '1132 Fixer needs administrator access to install the update.',
    'file-changed-after-verify':   'The downloaded file changed after it was verified.',
    'install-location-mismatch':   '1132 Fixer is running from a different folder than the one Windows has registered.',
    'handoff-write-failed':        'The update record could not be saved.',
    'installer-missing':           'The installer file was missing when it was time to run it.',
    'installer-elevation-refused': 'Windows did not allow the installer to start.',
    'installer-launch-failed':     'The installer did not start.',
    'installer-not-started':       'The installer did not start last time.',
    'previous-version-running':    'The previous version opened instead of the new one.',
    'version-mismatch':            'A different version opened than the one that was installed.',
    'unexpected-executable-path':  '1132 Fixer opened from a different location than the one that was updated.',
    'retry-limit-reached':         'Automatic retries have stopped. Download the update to install it by hand.',
    'install-threw':               'The install step stopped unexpectedly.'
  }
};

// ------------------------------------------------------------
// Inactivity warning. Shown after 30 s without use; the app closes 30 s
// later unless the user does something. {s} is the live seconds value.
// ------------------------------------------------------------
const INACTIVITY = {
  TITLE: 'Closing soon',
  BODY: '1132 Fixer will close in 30 seconds because it hasn’t been used.',
  COUNTDOWN: '{s} seconds',
  COUNTDOWN_ONE: '1 second',
  ANNOUNCE: 'Closing in {s} seconds',
  KEEP_OPEN: 'Keep open',
  CLOSE_NOW: 'Close now',
  ARIA_DIALOG: 'Closing soon. 1132 Fixer will close because it hasn’t been used.',
  ARIA_HOURGLASS: 'Hourglass showing the time left'
};

// ------------------------------------------------------------
// Product discovery on the completed-repair screen (operator request
// 2026-09-05). Secondary to the repair result; opens the official product
// directory in the default browser. No URL is ever shown to the user.
// ------------------------------------------------------------
const DISCOVERY = {
  TITLE: 'Explore more tools',
  BODY: 'Discover other products and tools designed to make your experience easier.',
  BUTTON: 'Explore Our Products',
  ARIA: 'Explore Our Products — opens our product directory in your browser',
  FAILED: 'We couldn’t open that page. Please try again.'
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UPDATE,
    INACTIVITY,
    DISCOVERY,
    CHECK_ORDER,
    FRIENDLY_ERRORS, friendlyError, unexpectedFixFailure, scanFailureMessage,
    shortcutFailureMessage, HKU_STATES, FRAME_SERVER_STATES, describeHku,
    describeFrameServer, receiptStatusFor, describeUnrecognized,
    ZOOM_RECOVERY, zoomRecoveryTechDetails, zoomInstallerRefusal,
    WIZARD_GROUPS, WIZARD, wizardFixFoundTitle, wizardFixFoundSub, wizardBlockedSub,
    EXPLORE_COPY, EXPLORE_CATEGORIES, EXPLORE_VIEW, DISCLOSURE,
    FEEDBACK_FALLBACK, FEEDBACK_NETWORK, reportBuildFailure
  };
}
