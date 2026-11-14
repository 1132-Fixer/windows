// ============================================================
// details-view.js — the plain-English model behind "View details".
//
// The environment scan reports one card per check (main.js), written for
// support staff: service names, registry hives, account names, commands.
// The Details screen is for the person sitting at the PC, so every check
// is translated here into a label, a one-line description and a short
// explanation per state. Nothing on that screen renders a raw card
// message, a registry path, an account name or a command.
//
// Pure and DOM-free (same pattern as ui-state.js) so tools/
// details-view-smoke.js can assert the translations and the
// no-technical-text rule in Node.
//
// Status vocabulary on the Details screen is exactly four words:
//   Checking · Ready · Needs attention · Unable to verify
// mapped from the six internal card states. 'repairable' (the app can fix
// it) is "Needs attention" with the explanation that Fix now handles it;
// it never reads as Ready. 'warning' and 'unknown' (a probe could not run
// or returned an unexpected value) read as "Unable to verify" — not a
// pass, not a failure.
// ============================================================

const DETAILS_STATUS = Object.freeze({
  pending:    { word: 'Checking',         tone: 'checking' },
  ready:      { word: 'Ready',            tone: 'ready' },
  repairable: { word: 'Needs attention',  tone: 'attention' },
  blocked:    { word: 'Needs attention',  tone: 'attention' },
  warning:    { word: 'Unable to verify', tone: 'unverified' },
  unknown:    { word: 'Unable to verify', tone: 'unverified' }
});

function detailsStatusFor(status) {
  return DETAILS_STATUS[status] || DETAILS_STATUS.unknown;
}

// Category headings as they appear on the Details screen. Keys are the
// CHECK_ORDER group names from messages.js, so the two cannot drift.
const DETAILS_CATEGORY_LABELS = Object.freeze({
  'App':              'App',
  'Zoom':             'Zoom',
  'Helper account':   'Helper account',
  'Privacy policies': 'Privacy policies',
  'Camera service':   'Camera service'
});

// Per-check translation. `explain` is the one sentence shown when a check
// is not Ready. Wording rule: say what is wrong and what happens next;
// name a Windows feature only with a plain description beside it; never
// a command, path, account name or policy key.
const DETAILS_CHECKS = Object.freeze({
  admin: {
    label: 'Administrator access',
    description: '1132 Fixer needs to run as an administrator.',
    explain: {
      blocked: 'Not running as an administrator. Close the app, then right-click it and choose Run as administrator.',
      warning: 'Could not confirm administrator access.',
      unknown: 'Could not confirm administrator access.'
    }
  },
  zoom: {
    label: 'Zoom installation',
    description: 'Zoom must be installed for everyone on this PC.',
    explain: {
      blocked: 'Zoom is not installed for everyone on this PC. Install it, then check again.',
      warning: 'Could not confirm the Zoom installation.',
      unknown: 'Could not confirm the Zoom installation.'
    }
  },
  helperUser: {
    label: 'Helper account',
    description: 'A separate Windows account used only to start Zoom.',
    explain: {
      repairable: 'Needs a reset. Fix now takes care of this.',
      warning: 'Could not fully check the helper account. The fix can still run.',
      unknown: 'Could not fully check the helper account. The fix can still run.'
    }
  },
  helperProfile: {
    label: 'Helper profile',
    description: 'The settings folder for the helper account.',
    explain: {
      repairable: 'Needs to be rebuilt. Fix now takes care of this.',
      warning: 'Could not fully check the helper profile. The fix can still run.',
      unknown: 'Could not fully check the helper profile. The fix can still run.'
    }
  },
  seclogon: {
    label: 'Windows sign-in service',
    description: 'A Windows service (Secondary Logon) that opens Zoom in the helper account.',
    explain: {
      blocked: 'This Windows service is turned off, so Zoom cannot open in the helper account. Turn it on, or ask whoever manages this PC.',
      warning: 'Could not confirm this Windows service is running. Zoom may not open after the fix.',
      unknown: 'Could not confirm this Windows service is running.'
    }
  },
  camPolicy: {
    label: 'Camera permission',
    description: 'Windows lets apps use the camera.',
    explain: {
      blocked: 'A Windows policy blocks camera access. If this PC is managed by an organization, ask them to allow it.',
      warning: 'Could not read the camera permission setting.',
      unknown: 'Could not read the camera permission setting.'
    }
  },
  micPolicy: {
    label: 'Microphone permission',
    description: 'Windows lets apps use the microphone.',
    explain: {
      blocked: 'A Windows policy blocks microphone access. If this PC is managed by an organization, ask them to allow it.',
      warning: 'Could not read the microphone permission setting.',
      unknown: 'Could not read the microphone permission setting.'
    }
  },
  hku: {
    label: 'Windows profile settings',
    description: 'Where camera and microphone permissions are saved for the helper account.',
    explain: {
      warning: 'Could not read the profile settings. The fix can still run.',
      unknown: 'Could not read the profile settings. The fix can still run.'
    }
  },
  frameServer: {
    label: 'Camera service',
    description: 'The Windows service that makes cameras available to apps.',
    explain: {
      repairable: 'Turned off. Fix now turns it on.',
      warning: 'Could not confirm the camera service. Cameras may not work in Zoom.',
      unknown: 'Could not confirm the camera service.'
    }
  }
});

// Fallbacks by state for a check without a specific sentence.
const DETAILS_EXPLAIN_DEFAULT = Object.freeze({
  pending:    'Checking…',
  ready:      '',
  repairable: 'Fix now takes care of this.',
  blocked:    'Needs attention before the fix can run.',
  warning:    'Could not be verified. The fix can still run.',
  unknown:    'Could not be verified.'
});

function normalizeStatus(status) {
  return Object.prototype.hasOwnProperty.call(DETAILS_STATUS, status) ? status : 'unknown';
}

function checkView(key, fallbackLabel, status) {
  const s = normalizeStatus(status);
  const spec = DETAILS_CHECKS[key] || { label: fallbackLabel || key, description: '', explain: {} };
  const st = detailsStatusFor(s);
  const explain = (spec.explain && spec.explain[s]) || DETAILS_EXPLAIN_DEFAULT[s] || '';
  return {
    key,
    label: spec.label,
    description: spec.description,
    status: s,
    word: st.word,
    tone: st.tone,
    explain
  };
}

// Worst-of ranking for a category. Same discipline as ui-state.js: a
// category is only as good as its worst check.
const TONE_RANK = ['attention', 'unverified', 'checking', 'ready'];
function worstTone(tones) {
  for (const t of TONE_RANK) if (tones.indexOf(t) !== -1) return t;
  return 'unverified';
}

function plural(n, one, many) {
  return n === 1 ? one : many;
}

function categorySummary(cat) {
  const total = cat.checks.length;
  const ready = cat.checks.filter((c) => c.tone === 'ready').length;
  const attention = cat.checks.filter((c) => c.tone === 'attention').length;
  const unverified = cat.checks.filter((c) => c.tone === 'unverified').length;
  const checking = cat.checks.filter((c) => c.tone === 'checking').length;
  if (checking) return 'Checking…';
  if (attention) return `${attention} ${plural(attention, 'item needs', 'items need')} attention`;
  if (unverified) return `${unverified} ${plural(unverified, 'check', 'checks')} could not be verified`;
  return `${ready} of ${total} ${plural(total, 'check', 'checks')} passed`;
}

// statusByKey : { [checkKey]: internal status } — what the scan rendered.
// order       : CHECK_ORDER from messages.js ([{ key, label, group }]).
// Returns the full Details model: categories in scan order, each with its
// translated checks, counts, tone and one summary line; plus an overall
// headline and count line for the summary strip.
function buildDetailsModel(statusByKey, order) {
  const by = statusByKey && typeof statusByKey === 'object' ? statusByKey : {};
  const list = Array.isArray(order) ? order : [];
  const categories = [];
  for (const c of list) {
    let cat = categories.find((x) => x.group === c.group);
    if (!cat) {
      cat = { group: c.group, id: c.group.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label: DETAILS_CATEGORY_LABELS[c.group] || c.group, checks: [] };
      categories.push(cat);
    }
    // A key the scan never reported is unknown — never silently Ready.
    const status = Object.prototype.hasOwnProperty.call(by, c.key) ? by[c.key] : 'unknown';
    cat.checks.push(checkView(c.key, c.label, status));
  }
  for (const cat of categories) {
    cat.tone = worstTone(cat.checks.map((x) => x.tone));
    cat.word = cat.tone === 'ready' ? 'Ready' : cat.tone === 'checking' ? 'Checking' : cat.tone === 'attention' ? 'Needs attention' : 'Unable to verify';
    cat.passed = cat.checks.filter((x) => x.tone === 'ready').length;
    cat.total = cat.checks.length;
    cat.summary = categorySummary(cat);
  }
  const all = categories.reduce((acc, cat) => acc.concat(cat.checks), []);
  const total = all.length;
  const passed = all.filter((x) => x.tone === 'ready').length;
  const attention = all.filter((x) => x.tone === 'attention').length;
  const unverified = all.filter((x) => x.tone === 'unverified').length;
  const checking = all.filter((x) => x.tone === 'checking').length;
  let headline;
  let tone;
  if (total === 0) { headline = 'Nothing has been checked yet.'; tone = 'unverified'; }
  else if (checking) { headline = 'Still checking this PC.'; tone = 'checking'; }
  else if (attention) { headline = `${attention} ${plural(attention, 'item needs', 'items need')} attention.`; tone = 'attention'; }
  else if (unverified) { headline = `${unverified} ${plural(unverified, 'check', 'checks')} could not be verified.`; tone = 'unverified'; }
  else { headline = 'Everything this fix needs is ready.'; tone = 'ready'; }
  const counts = total === 0 ? '' : `${passed} of ${total} ${plural(total, 'check', 'checks')} passed`;
  return { categories, overall: { total, passed, attention, unverified, checking, headline, counts, tone } };
}

// ------------------------------------------------------------
// Repair results (after Fix now has run). The receipt from main.js
// carries four verified items; these are their plain labels and the
// status words in the same four-word vocabulary. Values are taken from
// messages.js (receiptStatusFor / describeHku / describeFrameServer) by
// the renderer and passed in already worded for people.
// ------------------------------------------------------------
const RECEIPT_TONE = Object.freeze({
  ok:   { word: 'Ready',            tone: 'ready' },
  warn: { word: 'Unable to verify', tone: 'unverified' },
  fail: { word: 'Needs attention',  tone: 'attention' },
  info: { word: 'Unable to verify', tone: 'unverified' }
});

const RECEIPT_LABELS = Object.freeze({
  camera:      'Camera permission',
  microphone:  'Microphone permission',
  hku:         'Windows profile settings',
  frameServer: 'Camera service'
});

function receiptItemView(key, status, text) {
  const st = RECEIPT_TONE[status] || RECEIPT_TONE.info;
  return { key, label: RECEIPT_LABELS[key] || key, status, word: st.word, tone: st.tone, explain: st.tone === 'ready' ? '' : String(text || '') };
}

// Extra repair-result rows. Read identifiers and outcomes only: labels,
// details, messages and nested payloads can contain private diagnostic data.
// This model never copies those fields or turns an unknown result into Ready.
const REPAIR_ATTENTION_LIMITS = Object.freeze({ entriesPerSource: 64, items: 12 });
const REPAIR_ATTENTION_COPY = Object.freeze({
  sessions: {
    label: 'Helper programs and sign-in',
    explain: 'Could not confirm that helper programs and sign-in sessions closed safely. Send a support report before another reset.'
  },
  accountPermissions: {
    label: 'Helper account permissions',
    explain: 'Could not confirm that the helper account has only the access it needs. Send a support report.'
  },
  cleanup: {
    label: 'Old helper settings',
    explain: 'Could not fully confirm that old helper settings were removed. Send a support report before another reset.'
  },
  profileRefresh: {
    label: 'Windows profile refresh',
    explain: 'Windows could not confirm the profile refresh. Save your work, restart Windows, then check again.'
  },
  account: {
    label: 'New helper account',
    explain: 'A fresh helper account could not be confirmed. Send a support report before treating the repair as complete.'
  },
  zoomLaunch: {
    label: 'Zoom launch',
    explain: 'The Zoom launch or restart reported a problem. Check Zoom, or send a support report.'
  },
  profileSetup: {
    label: 'Helper profile setup',
    explain: 'A fresh helper profile could not be confirmed. Send a support report before another reset.'
  },
  preferences: {
    label: 'Zoom preferences',
    explain: 'Some Zoom preferences could not be confirmed. Check the settings in Zoom.'
  },
  permissions: {
    label: 'Camera and microphone setup',
    explain: 'A camera or microphone setup step reported a problem. Check Windows privacy settings if Zoom cannot use them.'
  },
  camera: {
    label: 'Camera permission',
    explain: 'Windows reported a policy blocking camera access. Ask whoever manages this PC to check it.'
  },
  microphone: {
    label: 'Microphone permission',
    explain: 'Windows reported a policy blocking microphone access. Ask whoever manages this PC to check it.'
  },
  profilePermissions: {
    label: 'Helper permission settings',
    explain: 'A helper permission setup step reported a problem. Send a support report if Zoom cannot use the camera or microphone.'
  },
  cameraService: {
    label: 'Camera service',
    explain: 'Windows reported that the camera service was unavailable. Check camera access in Zoom, or ask whoever manages this PC for help.'
  },
  shortcut: {
    label: 'Zoom shortcut',
    explain: 'The desktop shortcut could not be prepared safely. Send a support report for help starting Zoom.'
  },
  verification: {
    label: 'Repair verification',
    explain: 'Some repair results were missing or could not be confirmed. Send a support report before treating the repair as complete.'
  },
  other: {
    label: 'Other repair results',
    explain: 'An additional repair result needs review. Send a support report for help.'
  },
  additional: {
    label: 'More repair results',
    explain: 'More repair results need review. Send a support report for the full result.'
  }
});
const REPAIR_ATTENTION_STEPS = Object.freeze({
  'close-sessions': 'sessions',
  'remove-admin-rights': 'accountPermissions',
  'data-clear': 'cleanup',
  'profsvc-flush': 'profileRefresh',
  'create-account': 'account',
  'launch-zoom': 'zoomLaunch',
  'relaunch': 'zoomLaunch',
  'profile-setup': 'profileSetup',
  'zoom-config': 'preferences',
  'consent': 'permissions'
});
const REPAIR_ATTENTION_WARNINGS = Object.freeze({
  logoff_partial: 'sessions',
  profsvc_flush_failed: 'profileRefresh',
  temp_or_suffixed_profile: 'profileSetup',
  firstrun_missing: 'profileSetup',
  firstrun_deploy_failed: 'profileSetup',
  shortcut_failed: 'shortcut',
  dpapi_seal_failed: 'shortcut',
  stale_credential_cleanup_failed: 'shortcut',
  gpo_deny_camera: 'camera',
  gpo_deny_microphone: 'microphone',
  consent_script_missing: 'permissions',
  consent_script_error: 'permissions',
  consent_exit_nonzero: 'permissions',
  consent_hklm_write_fail: 'permissions',
  camera_consent_unverified: 'permissions',
  mic_consent_unverified: 'permissions',
  consent_hku_load_failed: 'profilePermissions',
  consent_hku_unload_failed: 'profilePermissions',
  consent_hku_not_loaded: 'profilePermissions',
  consent_hku_write_fail: 'profilePermissions',
  frameserver_disabled: 'cameraService',
  frameserver_missing: 'cameraService',
  sid_unresolved: 'profileSetup',
  ini_seed_failed: 'preferences',
  ini_write_failed: 'preferences',
  pref_copy_failed: 'preferences',
  zoom_close_residual: 'preferences',
  relaunch_failed: 'zoomLaunch',
  verify_probe_failed: 'verification'
});
const REPAIR_ATTENTION_FAILED_WARNINGS = new Set([
  'profsvc_flush_failed', 'temp_or_suffixed_profile', 'shortcut_failed',
  'dpapi_seal_failed', 'stale_credential_cleanup_failed', 'gpo_deny_camera',
  'gpo_deny_microphone', 'consent_hku_unload_failed', 'frameserver_disabled',
  'frameserver_missing', 'relaunch_failed'
]);

function repairAttentionOwnValue(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value : undefined;
  } catch (_) { return undefined; }
}

// Returns { items, tone, word, summary, truncated }. `items` use the existing
// receipt-row shape and can be appended to the four receiptItemView rows.
// An empty model means no extra attention was reported, not verified success.
function buildRepairAttentionModel(steps, warnings, verdictAttention) {
  const items = new Map();
  let truncated = false;
  let overflowFailed = false;
  const add = (group, status) => {
    if (items.has(group)) {
      if (status === 'fail') items.get(group).status = 'fail';
      return;
    }
    if (items.size >= REPAIR_ATTENTION_LIMITS.items) {
      truncated = true;
      overflowFailed = overflowFailed || status === 'fail';
      return;
    }
    items.set(group, { group, status });
  };
  const knownGroup = (catalog, value) => typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(catalog, value) ? catalog[value] : null;
  const visit = (entry, source) => {
    let record = false;
    try { record = entry !== null && typeof entry === 'object' && !Array.isArray(entry); }
    catch (_) { /* A revoked proxy is missing evidence. */ }
    if (!record) { add('verification', 'warn'); return; }
    if (source === 'warnings') {
      const code = repairAttentionOwnValue(entry, 'code');
      const group = knownGroup(REPAIR_ATTENTION_WARNINGS, code);
      add(group || 'other', group && REPAIR_ATTENTION_FAILED_WARNINGS.has(code) ? 'fail' : 'warn');
      return;
    }
    const outcome = repairAttentionOwnValue(entry, 'outcome');
    if (source === 'steps' && outcome === 'ok') return;
    if (outcome !== 'warn' && outcome !== 'fail') { add('verification', 'warn'); return; }
    const id = repairAttentionOwnValue(entry, 'id');
    const group = knownGroup(REPAIR_ATTENTION_STEPS, id);
    const evidence = typeof id === 'string' && id.length <= 64 && /^step-evidence(?:-[1-9][0-9]*)?$/.test(id);
    add(group || (evidence ? 'verification' : 'other'), outcome);
  };
  const read = (list, source) => {
    if (list === undefined) return;
    let array = false;
    try { array = Array.isArray(list); } catch (_) { /* Missing evidence. */ }
    if (!array) { add('verification', 'warn'); return; }
    const length = repairAttentionOwnValue(list, 'length');
    if (!Number.isSafeInteger(length) || length < 0) { add('verification', 'warn'); return; }
    if (length > REPAIR_ATTENTION_LIMITS.entriesPerSource) truncated = true;
    for (let index = 0; index < Math.min(length, REPAIR_ATTENTION_LIMITS.entriesPerSource); index++) {
      visit(repairAttentionOwnValue(list, String(index)), source);
    }
  };
  read(steps, 'steps');
  read(warnings, 'warnings');
  read(verdictAttention, 'attention');
  let rows = Array.from(items.values());
  if (truncated) {
    const omitted = rows.slice(REPAIR_ATTENTION_LIMITS.items - 1);
    overflowFailed = overflowFailed || omitted.some(row => row.status === 'fail');
    rows = rows.slice(0, REPAIR_ATTENTION_LIMITS.items - 1);
    rows.push({ group: 'additional', status: overflowFailed ? 'fail' : 'warn' });
  }
  rows = rows.map(({ group, status }) => ({
    key: `repair-${group}`,
    label: REPAIR_ATTENTION_COPY[group].label,
    status,
    word: RECEIPT_TONE[status].word,
    tone: RECEIPT_TONE[status].tone,
    explain: REPAIR_ATTENTION_COPY[group].explain
  }));
  const tone = rows.length ? worstTone(rows.map(row => row.tone)) : null;
  return {
    items: rows,
    tone,
    word: tone === 'attention' ? 'Needs attention' : tone === 'unverified' ? 'Unable to verify' : null,
    summary: tone === 'attention' ? 'Repair results need attention.'
      : tone === 'unverified' ? 'Some repair results could not be verified.' : '',
    truncated
  };
}

// Words and patterns that must never reach the Details surface. Checked
// by tools/details-view-smoke.js against every string this module can
// emit, and available to the renderer as a last-line guard.
const TECHNICAL_TEXT = Object.freeze([
  /HKLM|HKCU|HKU\b|NTUSER|ProfileList|\bSID\b/i,
  /\breg\.exe|\bsc\.exe|Start-Process|Get-ItemProperty|msiexec|powershell/i,
  /\buser1\b|FIX_USER|helperProfileDir/i,
  /[A-Z]:\\|\\\\/,
  /LetAppsAccess|Force ?(Allow|Deny)/i,
  /\bat line:\d+/i
]);

function isPlainEnglish(text) {
  const s = String(text == null ? '' : text);
  return !TECHNICAL_TEXT.some((re) => re.test(s));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DETAILS_STATUS,
    DETAILS_CATEGORY_LABELS,
    DETAILS_CHECKS,
    DETAILS_EXPLAIN_DEFAULT,
    RECEIPT_LABELS,
    RECEIPT_TONE,
    TECHNICAL_TEXT,
    detailsStatusFor,
    checkView,
    buildDetailsModel,
    receiptItemView,
    REPAIR_ATTENTION_LIMITS,
    buildRepairAttentionModel,
    isPlainEnglish
  };
}
