// Smoke test for profile-safety.js — TEMP fallback guard reconciled from
// closed unmerged PR #40 onto current main. Imports the REAL module
// main.js ships with. Pure logic only (no Electron, no live ProfileList
// mutation, no folder deletes).
//
// Contract under test:
//  - TEMP fallback detected
//  - real profile path classification
//  - no silent TEMP launch
//  - command quoting
//  - env construction
//  - Zoom exe discovery (mock paths)
//  - shortcut name/icon
//  - privilege/error handling (unknown ≠ success)
//  - credential not in logs/argv (presence assertions, never print secrets)

const ps = require('../profile-safety.js');
const hc = require('../helper-credential.js');
const rv = require('../run-verdict.js');
const zd = require('../zoom-detect.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('profile-safety-smoke: TEMP fallback detected');
{
  check(ps.isTempProfilePath('C:\\Users\\TEMP'), 'bare TEMP folder is TEMP');
  check(ps.isTempProfilePath('C:\\Users\\TEMP.DESKTOP-ABC'), 'TEMP.MACHINE is TEMP');
  check(ps.isTempProfilePath('C:\\Users\\TEMP.DESKTOP-ABC.000'), 'TEMP.MACHINE.NNN is TEMP');
  check(ps.isTempProfilePath('C:\\Users\\TEMP\\AppData\\Roaming'), 'path under TEMP is TEMP');
  check(ps.isTempProfilePath('c:\\users\\temp.foo'), 'TEMP match is case-insensitive');
  check(!ps.isTempProfilePath('C:\\Users\\user1'), 'canonical user1 is not TEMP');
  check(!ps.isTempProfilePath('C:\\Users\\user1.DESKTOP'), 'suffixed user1 is not TEMP');
  check(!ps.isTempProfilePath('C:\\Users\\TemporaryUser'), 'TemporaryUser is not TEMP');
  check(!ps.isTempProfilePath(''), 'empty is not TEMP');
  check(!ps.isTempProfilePath(null), 'null is not TEMP');
  const t = ps.classifyProfilePath('C:\\Users\\TEMP.PC.003', 'user1');
  check(t.kind === ps.PROFILE_KIND.temp, 'classify TEMP.PC.003 -> temp');
}

console.log('profile-safety-smoke: real profile path classification');
{
  const c = ps.classifyProfilePath('C:\\Users\\user1', 'user1', 'registry');
  check(c.kind === ps.PROFILE_KIND.canonical, 'C:\\Users\\user1 is canonical');
  check(ps.isCanonicalProfilePath('C:\\Users\\user1\\', 'user1'), 'trailing slash still canonical');
  check(ps.isCanonicalProfilePath('c:\\users\\USER1', 'user1'), 'canonical is case-insensitive');
  const s = ps.classifyProfilePath('C:\\Users\\user1.DESKTOP-1', 'user1', 'folder-suffixed');
  check(s.kind === ps.PROFILE_KIND.suffixed, 'user1.MACHINE is suffixed');
  check(ps.isSuffixedProfilePath('C:\\Users\\user1.PC', 'user1'), 'suffixed helper');
  const m = ps.classifyProfilePath(null, 'user1');
  check(m.kind === ps.PROFILE_KIND.missing, 'null path is missing');
  const u = ps.classifyProfilePath('C:\\Users\\Other', 'user1');
  check(u.kind === ps.PROFILE_KIND.unknown, 'unrelated Users folder is unknown');
  check(ps.classifyProfilePath(42).kind === ps.PROFILE_KIND.unknown, 'non-string is unknown');
}

console.log('profile-safety-smoke: no silent TEMP launch');
{
  const expected = 'C:\\Users\\user1';
  const tempEval = ps.evaluateLaunchProfile({
    profilePath: 'C:\\Users\\TEMP.BOX.002',
    source: 'registry',
    username: 'user1'
  });
  check(tempEval.ok === false, 'TEMP launch is not ok');
  check(tempEval.silentSuccessForbidden === true, 'TEMP launch forbids silent success');
  check(tempEval.code === 'temp_profile_fallback', 'TEMP code is temp_profile_fallback');
  check(tempEval.message.includes(expected), 'TEMP message names the canonical path');
  check(tempEval.message.includes('TEMP.BOX.002'), 'TEMP message names the resolved path');

  const sufEval = ps.evaluateLaunchProfile({
    profilePath: 'C:\\Users\\user1.MACHINE',
    source: 'folder-suffixed'
  });
  check(sufEval.ok === false && sufEval.silentSuccessForbidden, 'suffixed launch forbids silent success');
  check(sufEval.code === 'suffixed_profile', 'suffixed code is suffixed_profile');

  const miss = ps.evaluateLaunchProfile({ profilePath: null, source: 'not_found' });
  check(miss.ok === false && miss.silentSuccessForbidden, 'missing profile forbids silent success');

  const good = ps.evaluateLaunchProfile({
    profilePath: 'C:\\Users\\user1',
    source: 'registry'
  });
  check(good.ok === true && good.silentSuccessForbidden === false, 'canonical launch is ok');
  check(good.kind === ps.PROFILE_KIND.canonical, 'canonical kind');

  // Fail-loud: a TEMP step must produce NEEDS ATTENTION, never a green run.
  const verdict = rv.computeRunVerdict(
    [{ id: 'profile-setup', label: 'Set up the user1 profile', outcome: 'fail', detail: tempEval.message }],
    [{ code: tempEval.code, message: tempEval.message }],
    []
  );
  check(verdict.partial === true && verdict.header === rv.VERDICT_HEADERS.attention,
    'TEMP fallback step -> FIX COMPLETE — NEEDS ATTENTION (not silent green)');
  check(verdict.success === true, 'partial still ran to the end');
}

console.log('profile-safety-smoke: command quoting');
{
  check(ps.psSingleQuote("user1") === "'user1'", 'psSingleQuote plain');
  check(ps.psSingleQuote("o'brien") === "'o''brien'", 'psSingleQuote doubles apostrophes');
  check(ps.psSingleQuote(null) === "''", 'psSingleQuote null -> empty quotes');
  check(ps.winArgvQuote('Zoom.exe') === 'Zoom.exe', 'winArgvQuote leaves simple tokens');
  check(ps.winArgvQuote('C:\\Program Files\\Zoom\\bin\\Zoom.exe') ===
    '"C:\\Program Files\\Zoom\\bin\\Zoom.exe"', 'winArgvQuote wraps spaces');
  check(ps.winArgvQuote('say "hi"') === '"say \\"hi\\""', 'winArgvQuote escapes embedded quotes');
  check(ps.winArgvQuote('') === '""', 'winArgvQuote empty -> empty quotes');
  const create = ps.accountCreateScript('user1', 'Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!');
  check(create.includes("/add /y"), 'account create keeps net.exe /add /y');
  check(create.includes("net.exe user"), 'account create calls net.exe user');
  const argv = ps.accountCreateArgv('C:\\tmp\\fixer-create.ps1');
  check(argv[0] === 'powershell.exe' && argv.includes('-File'), 'create spawn is powershell -File');
  check(!argv.includes('Aa1!Aa1!Aa1!Aa1!Aa1!Aa1!'), 'create argv has no password token');
}

console.log('profile-safety-smoke: env construction');
{
  const env = ps.buildLaunchedEnv('C:\\Users\\user1');
  check(env.USERPROFILE === 'C:\\Users\\user1', 'USERPROFILE is the profile root');
  check(env.APPDATA === 'C:\\Users\\user1\\AppData\\Roaming', 'APPDATA under user1');
  check(env.LOCALAPPDATA === 'C:\\Users\\user1\\AppData\\Local', 'LOCALAPPDATA under user1');
  check(ps.envUnderUser(env, 'user1'), 'canonical env sits under user1');
  const tempEnv = ps.buildLaunchedEnv('C:\\Users\\TEMP.PC');
  check(tempEnv.USERPROFILE === 'C:\\Users\\TEMP.PC', 'TEMP env USERPROFILE follows the landing');
  check(!ps.envUnderUser(tempEnv, 'user1'), 'TEMP env is NOT under canonical user1');
  const empty = ps.buildLaunchedEnv(null);
  check(empty.USERPROFILE === null && empty.APPDATA === null, 'missing path -> null env');
}

console.log('profile-safety-smoke: Zoom exe discovery (mock paths)');
{
  const historical = ps.HISTORICAL_ZOOM_EXE;
  check(historical === 'C:\\Program Files\\Zoom\\bin\\Zoom.exe', 'historical default is Program Files Zoom.exe');
  const hit = ps.discoverZoomExe(p => p === historical);
  check(hit.path === historical && hit.source === 'default-x64', 'mock: historical path wins');
  check(hit.dir === ps.HISTORICAL_ZOOM_DIR, 'mock: dir is the bin folder');

  const x86 = ps.discoverZoomExe(p => p === ps.ZOOM_X86_EXE);
  check(x86.path === ps.ZOOM_X86_EXE && x86.source === 'default-x86', 'mock: x86 used when historical absent');

  const none = ps.discoverZoomExe(() => false);
  check(none.path === null && none.source === null, 'mock: nothing exists -> not found (not success)');

  const custom = 'D:\\Apps\\Zoom\\bin\\Zoom.exe';
  const extra = ps.discoverZoomExe(p => p === custom, [{ path: custom, source: 'registry' }]);
  check(extra.path === custom && extra.source === 'registry', 'mock: extra candidate after defaults');

  const unsafe = "C:\\o'brien\\Zoom\\bin\\Zoom.exe";
  check(!zd.isSafeZoomPath(unsafe), 'unsafe apostrophe path rejected by zoom-detect');
  const skipped = ps.discoverZoomExe(() => true, [{ path: unsafe, source: 'evil' }]);
  check(skipped.path === historical, 'unsafe extra is skipped; historical still preferred when existsFn is true');

  const onlyUnsafe = ps.discoverZoomExe(p => p === unsafe, [{ path: unsafe, source: 'evil' }]);
  check(onlyUnsafe.path === null, 'unsafe-only discovery is not a hit');
}

console.log('profile-safety-smoke: shortcut name/icon');
{
  const spec = ps.shortcutSpec();
  check(spec.filename === 'Zoom — User1.lnk', 'primary shortcut name says exactly what it launches');
  check(spec.launchesAs === 'user1', 'shortcut launches Zoom as user1');
  check(spec.iconResource === '1132-helper-shortcut.ico', 'canonical 1132 helper icon resource');
  check(spec.iconIndex === 0, 'icon index is 0');
  check(/helper account/i.test(spec.description), 'description names the helper account');
  check(spec.user1DesktopSettings === 'Apply Zoom Settings.lnk', 'user1-desktop settings shortcut name');
  check(ps.PRIMARY_SHORTCUT_FILENAME === spec.filename, 'exported filename matches spec');
}

console.log('profile-safety-smoke: privilege/error handling');
{
  const el = ps.classifyPrivilegeState({ elevated: true });
  check(el.ok === true && el.status === 'elevated', 'elevated is ok');
  const ne = ps.classifyPrivilegeState({ elevated: false });
  check(ne.ok === false && ne.code === 'not_elevated', 'not elevated is a named failure');
  const unk = ps.classifyPrivilegeState({});
  check(unk.ok === false && unk.status === 'unknown', 'missing elevation is unknown, not success');
  const fail = ps.classifyPrivilegeState({ probeFailed: true, elevated: true });
  check(fail.ok === false && fail.status === 'unknown', 'failed probe overrides a claimed elevation');
  check(/not success/i.test(fail.message), 'unknown privilege copy says unavailable is not success');
}

console.log('profile-safety-smoke: helper-profile inventory card');
{
  const ready = ps.classifyHelperProfileCard({
    accountExists: true,
    folderExists: true,
    folderPath: 'C:\\Users\\user1',
    profileImagePath: 'C:\\Users\\user1',
    owner: 'DESKTOP\\user1',
    ntuserPresent: true
  });
  check(ready.status === 'ready' && ready.kind === 'canonical', 'canonical inventory is ready');
  check(ready.message.includes('C:\\Users\\user1'), 'ready card names the real path');
  check(ready.message.includes('DESKTOP\\user1'), 'ready card names ownership');

  const temp = ps.classifyHelperProfileCard({
    accountExists: true,
    profileImagePath: 'C:\\Users\\TEMP.PC.001',
    profileListBak: true,
    owner: 'NT AUTHORITY\\SYSTEM'
  });
  check(temp.status === 'repairable' && temp.kind === 'temp', 'TEMP inventory is repairable, not ready');
  check(/will not delete TEMP folders by name guessing/i.test(temp.message),
    'TEMP card refuses name-guessing deletes');
  check(/\.bak/i.test(temp.message), 'TEMP card mentions ProfileList .bak');

  const unavailable = ps.classifyHelperProfileCard({ probeFailed: true });
  check(unavailable.status === 'warning' && unavailable.kind === 'unknown',
    'failed inventory is warning, not ready/success');
  check(/not a clean profile/i.test(unavailable.message), 'unavailable copy refuses success');

  const entries = ps.parseProfileListEntries([
    'S-1-5-21-1-2-3-1001\tC:\\Users\\user1',
    'S-1-5-21-1-2-3-1001.bak\tC:\\Users\\TEMP.PC',
    'garbage'
  ].join('\n'));
  check(entries.length === 2, 'ProfileList parser keeps two SID rows');
  check(entries[0].kind === 'canonical' && entries[1].kind === 'temp' && entries[1].bak,
    'ProfileList parser classifies canonical vs TEMP.bak');
}

console.log('profile-safety-smoke: credential not in logs/argv');
{
  const pw = hc.generateHelperPassword();
  check(hc.isSafeHelperPassword(pw), 'fixture password is a real helper password');
  check(!/user1/.test(pw) || pw !== 'user1', 'fixture is not the legacy static password');

  const argv = ps.accountCreateArgv('C:\\tmp\\create.ps1');
  check(!ps.argvContainsSecret(argv, [pw]), 'create argv does not contain the password');
  check(!ps.argvContainsSecret(['powershell.exe', '-File', 'C:\\tmp\\x.ps1'], [pw]),
    'generic -File argv does not contain the password');
  check(ps.argvContainsSecret(['net.exe', 'user', 'user1', pw, '/add'], [pw]),
    'presence helper flags a net.exe argv that DID leak the password');

  const leaked = `net user user1 ${pw} /add`;
  const redacted = ps.redactSecrets(leaked, [pw]);
  check(!redacted.includes(pw), 'redactSecrets strips the password from a log line');
  check(redacted.includes('[redacted]'), 'redactSecrets replaces with [redacted]');
  check(ps.redactSecrets('no secrets here', [pw]) === 'no secrets here', 'redactSecrets is a no-op without a match');

  const script = ps.accountCreateScript('user1', pw);
  check(script.includes(pw), 'tmp script body holds the password (accepted residual)');
  const spawnLine = argv.join(' ');
  check(!spawnLine.includes(pw), 'joined create argv string has no password');
  // Never print the fixture password itself.
  check(!process.argv.join(' ').includes(pw), 'this smoke argv does not contain the fixture password');
}

if (failures) {
  console.error(`profile-safety-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('profile-safety-smoke: all checks passed');
