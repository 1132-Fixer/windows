// Helper-profile safety (TEMP fallback guard, reconciled from closed
// unmerged PR #40 onto current main). Pure, require()-able helpers shared
// by main.js and tools/profile-safety-smoke.js — main.js cannot be imported
// under plain node (Electron requires).
//
// Canonical 1132 contract:
//   1. Helper account is `user1`.
//   2. Real Windows profile is C:\Users\user1 — never a TEMP fallback.
//   3. Historical Zoom exe is C:\Program Files\Zoom\bin\Zoom.exe.
//   4. Launch env USERPROFILE/APPDATA/LOCALAPPDATA must sit under user1.
//   5. A TEMP/suffixed landing is NEVER a silent success.
//   6. Unknown / unavailable is NEVER success.
// Destructive TEMP cleanup is out of scope: never delete C:\Users\TEMP*,
// C:\Users\user1, ProfileList keys, or the helper account by path/name
// guessing. Inventory + classify only; FIX NOW uses the existing rebuild.

const path = require('path');
const zoomDetect = require('./zoom-detect');

const FIX_USER = 'user1';
const CANONICAL_PROFILE = `C:\\Users\\${FIX_USER}`;
const HISTORICAL_ZOOM_EXE = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
const HISTORICAL_ZOOM_DIR = 'C:\\Program Files\\Zoom\\bin';
const ZOOM_X86_EXE = 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe';

// Current desktop shortcut (operator naming ruling 2026-08-23): the name
// says exactly what the shortcut does — launch Zoom as User1. Previous
// names ("Open Zoom with 1132 Helper.lnk", "Launch Zoom as user1.lnk")
// are legacy and cleaned up after a successful create.
const PRIMARY_SHORTCUT_FILENAME = 'Zoom — User1.lnk';
const PRIMARY_SHORTCUT_ICON = '1132-helper-shortcut.ico';
const PRIMARY_SHORTCUT_ICON_INDEX = 0;
const PRIMARY_SHORTCUT_DESCRIPTION =
  'Starts Zoom using the dedicated helper account created by 1132 Fixer.';
const USER1_DESKTOP_SETTINGS_SHORTCUT = 'Apply Zoom Settings.lnk';

const PROFILE_KIND = {
  canonical: 'canonical',
  temp: 'temp',
  suffixed: 'suffixed',
  missing: 'missing',
  unknown: 'unknown'
};

function _normPath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\//g, '\\').replace(/\\+$/, '');
}

function canonicalProfilePath(username) {
  const u = typeof username === 'string' && username ? username : FIX_USER;
  return `C:\\Users\\${u}`;
}

// TEMP profiles minted by the User Profile Service (Event 1511/1515) look
// like C:\Users\TEMP, C:\Users\TEMP.<machine>, C:\Users\TEMP.<machine>.NNN.
// A suffix of ".tmp" on an otherwise real name is also a TEMP fallback.
function isTempProfilePath(p) {
  const n = _normPath(p);
  if (!n) return false;
  const m = /^[A-Za-z]:\\Users\\([^\\]+)(?:\\|$)/i.exec(n);
  if (!m) return false;
  const leaf = m[1];
  return /^TEMP(?:[._].*)?$/i.test(leaf);
}

function isCanonicalProfilePath(p, username) {
  const expected = canonicalProfilePath(username);
  const n = _normPath(p);
  return !!n && n.toLowerCase() === expected.toLowerCase();
}

function isSuffixedProfilePath(p, username) {
  const u = typeof username === 'string' && username ? username : FIX_USER;
  const n = _normPath(p);
  if (!n) return false;
  const m = /^[A-Za-z]:\\Users\\([^\\]+)(?:\\|$)/i.exec(n);
  if (!m) return false;
  const leaf = m[1];
  if (isTempProfilePath(n)) return false;
  // user1.MACHINE / user1.MACHINE.000 — Windows collision suffix.
  return new RegExp('^' + u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.', 'i').test(leaf);
}

function classifyProfilePath(p, username, source) {
  const u = typeof username === 'string' && username ? username : FIX_USER;
  if (p == null || p === '') {
    return {
      kind: PROFILE_KIND.missing,
      path: p == null ? null : '',
      source: source || 'not_found',
      reason: 'No profile path was resolved.'
    };
  }
  if (typeof p !== 'string') {
    return {
      kind: PROFILE_KIND.unknown,
      path: null,
      source: source || 'invalid',
      reason: 'Profile path is not a string — unavailable is not success.'
    };
  }
  const n = _normPath(p);
  if (isTempProfilePath(n)) {
    return {
      kind: PROFILE_KIND.temp,
      path: n,
      source: source || 'temp',
      reason: `Windows fell back to a TEMP profile at '${n}'.`
    };
  }
  if (isSuffixedProfilePath(n, u) || source === 'folder-suffixed') {
    return {
      kind: PROFILE_KIND.suffixed,
      path: n,
      source: source || 'folder-suffixed',
      reason: `Windows created a suffixed profile at '${n}' instead of '${canonicalProfilePath(u)}'.`
    };
  }
  if (isCanonicalProfilePath(n, u)) {
    return {
      kind: PROFILE_KIND.canonical,
      path: n,
      source: source || 'canonical',
      reason: `Profile is the real ${canonicalProfilePath(u)}.`
    };
  }
  return {
    kind: PROFILE_KIND.unknown,
    path: n,
    source: source || 'unknown',
    reason: `Profile path '${n}' is not the canonical ${canonicalProfilePath(u)}.`
  };
}

function buildLaunchedEnv(profilePath) {
  const n = _normPath(profilePath);
  if (!n) {
    return { USERPROFILE: null, APPDATA: null, LOCALAPPDATA: null };
  }
  return {
    USERPROFILE: n,
    APPDATA: path.win32.join(n, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.win32.join(n, 'AppData', 'Local')
  };
}

function envUnderUser(env, username) {
  const u = typeof username === 'string' && username ? username : FIX_USER;
  const expected = canonicalProfilePath(u);
  if (!env || !env.USERPROFILE) return false;
  const up = _normPath(env.USERPROFILE);
  if (!isCanonicalProfilePath(up, u)) return false;
  const roaming = path.win32.join(expected, 'AppData', 'Roaming').toLowerCase();
  const local = path.win32.join(expected, 'AppData', 'Local').toLowerCase();
  return _normPath(env.APPDATA).toLowerCase() === roaming &&
         _normPath(env.LOCALAPPDATA).toLowerCase() === local;
}

// Decision for the STEP-6 launch guard. TEMP / suffixed / missing / unknown
// all set silentSuccessForbidden so computeRunVerdict cannot go green.
function evaluateLaunchProfile({ profilePath, source, username } = {}) {
  const u = username || FIX_USER;
  const classified = classifyProfilePath(profilePath, u, source);
  const env = buildLaunchedEnv(classified.path);
  const expected = canonicalProfilePath(u);
  if (classified.kind === PROFILE_KIND.canonical && envUnderUser(env, u)) {
    return {
      ok: true,
      kind: classified.kind,
      env,
      code: null,
      message: `Verified: profile is the real ${expected} (source: ${classified.source}).`,
      silentSuccessForbidden: false
    };
  }
  const code = classified.kind === PROFILE_KIND.temp
    ? 'temp_profile_fallback'
    : classified.kind === PROFILE_KIND.suffixed
      ? 'suffixed_profile'
      : classified.kind === PROFILE_KIND.missing
        ? 'profile_not_materialized'
        : 'temp_or_suffixed_profile';
  const message = classified.kind === PROFILE_KIND.missing
    ? `user1 profile did not appear. Expected '${expected}'.`
    : `Zoom resolved to '${classified.path || '(none)'}' (source: ${classified.source}) instead of '${expected}'. Windows fell back to a TEMP/suffixed profile, so the 1132 device identity may not be clean. Reboot and re-run the fix so the User Profile Service drops stale hive handles before the next launch.`;
  return {
    ok: false,
    kind: classified.kind,
    env,
    code,
    message,
    silentSuccessForbidden: true
  };
}

// PowerShell single-quoted string: the only escape is doubling apostrophes.
function psSingleQuote(value) {
  return "'" + String(value == null ? '' : value).replace(/'/g, "''") + "'";
}

// Windows CreateProcess argv quoting (CommandLineToArgvW rules): wrap in
// double quotes and double-escape backslashes that precede a quote.
function winArgvQuote(value) {
  const s = String(value == null ? '' : value);
  if (s.length === 0) return '""';
  if (!/[\s"]/.test(s)) return s;
  let out = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') {
      slashes += 1;
      continue;
    }
    if (ch === '"') {
      out += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    if (slashes) {
      out += '\\'.repeat(slashes);
      slashes = 0;
    }
    out += ch;
  }
  if (slashes) out += '\\'.repeat(slashes * 2);
  return out + '"';
}

function redactSecrets(text, secrets) {
  let out = String(text == null ? '' : text);
  const list = Array.isArray(secrets) ? secrets.filter(s => typeof s === 'string' && s.length > 0) : [];
  for (const secret of list) {
    if (!secret) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

function argvContainsSecret(argv, secrets) {
  const args = Array.isArray(argv) ? argv.map(a => String(a)) : [];
  const list = Array.isArray(secrets) ? secrets.filter(s => typeof s === 'string' && s.length > 0) : [];
  for (const a of args) {
    for (const s of list) {
      if (a === s || a.includes(s)) return true;
    }
  }
  return false;
}

// Account-create body for a tmp PowerShell file (same residual as Zoom
// launch: secret lives in the unlinked tmp script, never on CreateProcess
// argv / Win32_Process CommandLine). net.exe /y answers the ">14 char"
// DOS-compat prompt.
function accountCreateScript(username, password) {
  const u = psSingleQuote(username);
  const p = psSingleQuote(password);
  return [
    `$u = ${u}`,
    `$p = ${p}`,
    `$out = & net.exe user $u $p /add /y 2>&1`,
    `Write-Host (($out | Out-String).Trim())`,
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
    `Write-Host 'ACCOUNT_CREATE=OK'`
  ].join('\r\n');
}

// Spawn argv for that create script: powershell -File <tmp>. The password
// must never appear here.
function accountCreateArgv(scriptPath) {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath
  ];
}

const DEFAULT_ZOOM_CANDIDATES = [
  { path: HISTORICAL_ZOOM_EXE, source: 'default-x64' },
  { path: ZOOM_X86_EXE, source: 'default-x86' }
];

// Pure Zoom-exe discovery against a mock exists() — historical default
// first, then x86, then extras. Unsafe paths are skipped, not accepted.
function discoverZoomExe(existsFn, extraCandidates) {
  const exists = typeof existsFn === 'function' ? existsFn : () => false;
  const extras = Array.isArray(extraCandidates) ? extraCandidates : [];
  const list = DEFAULT_ZOOM_CANDIDATES.concat(extras);
  for (const c of list) {
    const p = c && c.path;
    if (!p || !zoomDetect.isSafeZoomPath(p)) continue;
    if (!exists(p)) continue;
    return {
      path: p,
      dir: path.win32.dirname(p),
      source: c.source || 'extra'
    };
  }
  return { path: null, dir: null, source: null };
}

function shortcutSpec() {
  return {
    filename: PRIMARY_SHORTCUT_FILENAME,
    launchesAs: FIX_USER,
    iconResource: PRIMARY_SHORTCUT_ICON,
    iconIndex: PRIMARY_SHORTCUT_ICON_INDEX,
    description: PRIMARY_SHORTCUT_DESCRIPTION,
    user1DesktopSettings: USER1_DESKTOP_SETTINGS_SHORTCUT
  };
}

// Privilege / availability: unknown is never success.
function classifyPrivilegeState({ elevated, probeFailed, available } = {}) {
  if (probeFailed === true || available === false) {
    return {
      ok: false,
      status: 'unknown',
      code: 'privilege_unknown',
      message: 'Administrator status could not be verified. Unavailable is not success — re-launch 1132 Fixer as Administrator and re-check.'
    };
  }
  if (elevated === true) {
    return {
      ok: true,
      status: 'elevated',
      code: null,
      message: 'Running elevated.'
    };
  }
  if (elevated === false) {
    return {
      ok: false,
      status: 'not_elevated',
      code: 'not_elevated',
      message: 'Not running as Administrator. Close the app, right-click its icon and choose "Run as administrator", then try again.'
    };
  }
  return {
    ok: false,
    status: 'unknown',
    code: 'privilege_unknown',
    message: 'Administrator status was not reported. Unavailable is not success.'
  };
}

// Read-only inventory → checklist card. Never recommends deleting TEMP*
// by name. FIX NOW rebuilds via the existing account/profile flow.
function classifyHelperProfileCard(input) {
  const d = input && typeof input === 'object' ? input : {};
  const label = 'Helper profile';
  if (d.probeFailed) {
    return {
      status: 'warning',
      label,
      kind: PROFILE_KIND.unknown,
      message: 'Helper profile inventory unavailable — could not read ProfileList / ownership. Unavailable is not a clean profile. FIX NOW can still run; the checklist re-scans when you come back to this window.'
    };
  }
  const classified = classifyProfilePath(
    d.profileImagePath || (d.folderExists ? d.folderPath : ''),
    d.username || FIX_USER,
    d.source
  );
  const ownerBit = d.owner ? ` Owner: ${d.owner}.` : '';
  const bakBit = d.profileListBak
    ? ' ProfileList also has a .bak SID key (Event 1515).'
    : '';

  if (classified.kind === PROFILE_KIND.temp) {
    return {
      status: 'repairable',
      label,
      kind: classified.kind,
      message: `TEMP profile detected at '${classified.path}'. FIX NOW rebuilds the real ${canonicalProfilePath(d.username)} — 1132 Fixer will not delete TEMP folders by name guessing.${ownerBit}${bakBit}`
    };
  }
  if (classified.kind === PROFILE_KIND.suffixed) {
    return {
      status: 'repairable',
      label,
      kind: classified.kind,
      message: `Suffixed profile at '${classified.path}' instead of ${canonicalProfilePath(d.username)}. FIX NOW rebuilds the real profile.${ownerBit}${bakBit}`
    };
  }
  if (classified.kind === PROFILE_KIND.canonical) {
    const nt = d.ntuserPresent === false
      ? ' Folder exists but NTUSER.DAT is not readable yet.'
      : '';
    return {
      status: nt ? 'warning' : 'ready',
      label,
      kind: classified.kind,
      message: `Real profile at ${classified.path}.${ownerBit}${bakBit}${nt}`
    };
  }
  if (!d.accountExists && !d.folderExists && !d.profileImagePath) {
    return {
      status: 'ready',
      label,
      kind: PROFILE_KIND.missing,
      message: `No ${FIX_USER} profile yet — FIX NOW creates the real ${canonicalProfilePath(d.username)}.`
    };
  }
  if (d.folderExists && !d.accountExists) {
    return {
      status: 'warning',
      label,
      kind: classified.kind,
      message: `Stale folder at ${d.folderPath || canonicalProfilePath(d.username)} with no account.${ownerBit} FIX NOW will clean it through the normal rebuild, not by path guessing.`
    };
  }
  return {
    status: 'warning',
    label,
    kind: classified.kind,
    message: `${classified.reason}${ownerBit}${bakBit} Unavailable/unrecognized is not a clean profile.`
  };
}

function parseProfileListEntries(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    const m = /^(S-1-5-\S+)\t(.*)$/.exec(t);
    if (!m) continue;
    const sid = m[1];
    const imagePath = m[2];
    const bak = /\.bak$/i.test(sid);
    const kind = classifyProfilePath(imagePath).kind;
    out.push({ sid, imagePath, bak, kind });
  }
  return out;
}

module.exports = {
  FIX_USER,
  CANONICAL_PROFILE,
  HISTORICAL_ZOOM_EXE,
  HISTORICAL_ZOOM_DIR,
  ZOOM_X86_EXE,
  PRIMARY_SHORTCUT_FILENAME,
  PRIMARY_SHORTCUT_ICON,
  PRIMARY_SHORTCUT_ICON_INDEX,
  PRIMARY_SHORTCUT_DESCRIPTION,
  USER1_DESKTOP_SETTINGS_SHORTCUT,
  PROFILE_KIND,
  DEFAULT_ZOOM_CANDIDATES,
  canonicalProfilePath,
  isTempProfilePath,
  isCanonicalProfilePath,
  isSuffixedProfilePath,
  classifyProfilePath,
  buildLaunchedEnv,
  envUnderUser,
  evaluateLaunchProfile,
  psSingleQuote,
  winArgvQuote,
  redactSecrets,
  argvContainsSecret,
  accountCreateScript,
  accountCreateArgv,
  discoverZoomExe,
  shortcutSpec,
  classifyPrivilegeState,
  classifyHelperProfileCard,
  parseProfileListEntries
};
