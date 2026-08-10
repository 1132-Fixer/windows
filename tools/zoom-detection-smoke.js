// Smoke test for zoom-detect.js — machine-wide Zoom install detection
// (triage cluster W1-DETECT). Imports the REAL module main.js ships with,
// so the parsing/validation/copy under test is the copy in production.
//
// Contract under test:
//  - registry-probe output parses into ordered, de-duplicated candidate dirs
//    (InstallLocation as-is; DisplayIcon stripped of icon index -> directory)
//  - path safety: anything that could escape a single-quoted PowerShell
//    string, or is not an absolute local <...>Zoom.exe, is rejected
//  - message selection covers exactly three states: machine-wide found
//    (path + variant suffix), only per-user found (explains helper-account
//    limitation), nothing found (install machine-wide MSI)

const zd = require('../zoom-detect.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('zoom-detection-smoke: deriveCandidateDirs');
{
  const dirs = zd.deriveCandidateDirs('InstallLocation=C:\\Program Files\\Zoom\r\n');
  check(dirs.length === 1 && dirs[0] === 'C:\\Program Files\\Zoom', 'InstallLocation taken as-is');
}
{
  const dirs = zd.deriveCandidateDirs('InstallLocation="C:\\Apps\\Zoom\\"\n');
  check(dirs.length === 1 && dirs[0] === 'C:\\Apps\\Zoom', 'InstallLocation quotes + trailing backslash stripped');
}
{
  const dirs = zd.deriveCandidateDirs('DisplayIcon=C:\\Apps\\Zoom\\bin\\Zoom.exe,0\n');
  check(dirs.length === 1 && dirs[0] === 'C:\\Apps\\Zoom\\bin', 'DisplayIcon icon index stripped, directory taken');
}
{
  const dirs = zd.deriveCandidateDirs('DisplayIcon=C:\\Apps\\Zoom\\bin\\Zoom.exe\n');
  check(dirs.length === 1 && dirs[0] === 'C:\\Apps\\Zoom\\bin', 'DisplayIcon without index handled');
}
{
  const dirs = zd.deriveCandidateDirs('DisplayIcon="C:\\Apps\\Zoom\\bin\\Zoom.exe",-1\n');
  check(dirs.length === 1 && dirs[0] === 'C:\\Apps\\Zoom\\bin', 'DisplayIcon quoted with negative index handled');
}
{
  const out = [
    'InstallLocation=C:\\Program Files\\Zoom',
    'DisplayIcon=C:\\Program Files\\Zoom\\bin\\Zoom.exe,0',
    'InstallLocation=c:\\program files\\zoom',
    'InstallLocation=D:\\Zoom'
  ].join('\r\n');
  const dirs = zd.deriveCandidateDirs(out);
  check(dirs.length === 3, 'case-insensitive de-duplication');
  check(dirs[0] === 'C:\\Program Files\\Zoom' && dirs[2] === 'D:\\Zoom', 'order preserved (first occurrence wins)');
}
{
  check(zd.deriveCandidateDirs('').length === 0, 'empty input -> no candidates');
  check(zd.deriveCandidateDirs(null).length === 0, 'null input -> no candidates');
  check(zd.deriveCandidateDirs('random noise\nWARNING: whatever\n=orphan').length === 0, 'garbage lines ignored');
  check(zd.deriveCandidateDirs('InstallLocation=\nDisplayIcon=\n').length === 0, 'empty values ignored');
}

console.log('zoom-detection-smoke: isSafeZoomPath');
{
  check(zd.isSafeZoomPath('C:\\Program Files\\Zoom\\bin\\Zoom.exe'), 'default x64 path accepted');
  check(zd.isSafeZoomPath('C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe'), 'default x86 path accepted');
  check(zd.isSafeZoomPath('D:\\Custom Apps\\Zoom\\bin\\Zoom.exe'), 'custom drive/dir accepted');
  check(!zd.isSafeZoomPath("C:\\o'brien\\Zoom\\bin\\Zoom.exe"), 'apostrophe rejected (PS quote escape)');
  check(!zd.isSafeZoomPath('C:\\a\nb\\Zoom.exe'), 'newline rejected');
  check(!zd.isSafeZoomPath('C:\\a\rb\\Zoom.exe'), 'carriage return rejected');
  check(!zd.isSafeZoomPath('C:\\a;calc\\Zoom.exe'), 'semicolon rejected');
  check(!zd.isSafeZoomPath('C:\\a&calc\\Zoom.exe'), 'ampersand rejected');
  check(!zd.isSafeZoomPath('C:\\a|calc\\Zoom.exe'), 'pipe rejected');
  check(!zd.isSafeZoomPath('\\\\server\\share\\Zoom.exe'), 'UNC path rejected');
  check(!zd.isSafeZoomPath('Zoom.exe'), 'bare relative rejected');
  check(!zd.isSafeZoomPath('..\\Zoom.exe'), 'relative traversal rejected');
  check(!zd.isSafeZoomPath('C:\\Zoom\\bin\\Zoom.exe '), 'trailing space rejected');
  check(!zd.isSafeZoomPath('C:\\Zoom\\bin\\other.exe'), 'wrong basename rejected');
  check(!zd.isSafeZoomPath(null), 'null rejected');
  check(!zd.isSafeZoomPath(42), 'non-string rejected');
}

console.log('zoom-detection-smoke: zoomStatusMessage');
{
  const p = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
  check(zd.zoomStatusMessage({ path: p, dir: 'x', source: 'default-x64', perUserPath: null }) === p,
    'default-x64 message is the bare resolved path');
}
{
  const p = 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe';
  check(zd.zoomStatusMessage({ path: p, source: 'default-x86', perUserPath: null }) === `${p} (32-bit)`,
    'default-x86 message appends (32-bit)');
}
{
  const p = 'D:\\Apps\\Zoom\\bin\\Zoom.exe';
  check(zd.zoomStatusMessage({ path: p, source: 'registry', perUserPath: null }) === `${p} (custom location)`,
    'registry message appends (custom location)');
}
{
  const msg = zd.zoomStatusMessage({ path: null, dir: null, source: null, perUserPath: null });
  check(msg === zd.ZOOM_NOT_FOUND_MESSAGE, 'nothing found -> canonical not-found copy');
  check(/machine-wide Zoom Workplace MSI/.test(msg), 'not-found copy names the machine-wide MSI');
  check(/Check again/.test(msg), 'not-found copy tells the user the next step');
  check(/zoom\.us\/download/.test(msg), 'not-found copy says WHERE to get the MSI (W8-UX)');
}
{
  const per = 'C:\\Users\\alice\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe';
  const msg = zd.zoomStatusMessage({ path: null, dir: null, source: null, perUserPath: per });
  check(msg.includes(per), 'per-user-only copy shows the per-user path');
  check(/for your Windows user only/.test(msg), 'per-user-only copy explains the install scope');
  check(/helper account/.test(msg), 'per-user-only copy explains WHY it cannot be used');
  check(/machine-wide Zoom Workplace MSI/.test(msg), 'per-user-only copy gives the remedy');
  check(/zoom\.us\/download/.test(msg), 'per-user-only copy says WHERE to get the MSI (W8-UX)');
  check(msg !== zd.ZOOM_NOT_FOUND_MESSAGE, 'per-user-only copy differs from generic not-found');
}
{
  // A machine-wide hit must win even when a per-user install also exists.
  const p = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
  const msg = zd.zoomStatusMessage({ path: p, source: 'default-x64', perUserPath: 'C:\\Users\\a\\AppData\\Roaming\\Zoom\\bin\\Zoom.exe' });
  check(msg === p, 'machine-wide + per-user -> machine-wide path wins');
  check(zd.zoomStatusMessage(null) === zd.ZOOM_NOT_FOUND_MESSAGE, 'null install object -> not-found copy, no throw');
}

console.log('zoom-detection-smoke: MSI magic header (guided recovery card)');
{
  // Real MSIs are OLE compound files: D0 CF 11 E0 (A1 B1 1A E1).
  check(zd.hasMsiMagic(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])), 'OLE compound-file header accepted');
  check(zd.hasMsiMagic(Buffer.from([0xD0, 0xCF, 0x11, 0xE0])), 'exact 4-byte magic accepted');
  check(!zd.hasMsiMagic(Buffer.from([0x4D, 0x5A, 0x90, 0x00])), 'PE (MZ) header rejected — a renamed .exe is not an MSI');
  check(!zd.hasMsiMagic(Buffer.from([0x50, 0x4B, 0x03, 0x04])), 'ZIP header rejected');
  check(!zd.hasMsiMagic(Buffer.from('MSI text impostor')), 'plain text rejected');
  check(!zd.hasMsiMagic(Buffer.from([0xD0, 0xCF, 0x11])), 'truncated header rejected');
  check(!zd.hasMsiMagic(Buffer.alloc(0)), 'empty buffer rejected');
  check(!zd.hasMsiMagic(null), 'null rejected without throwing');
}

console.log('zoom-detection-smoke: signer CN extraction');
{
  check(zd.subjectCn('CN="Zoom Video Communications, Inc.", O=Zoom Video Communications, C=US') === 'Zoom Video Communications, Inc.', 'quoted CN with embedded comma');
  check(zd.subjectCn('CN=Zoom Communications\\, Inc., O=Zoom') === 'Zoom Communications, Inc.', 'escaped-comma CN');
  check(zd.subjectCn('CN=Simple Signer, O=X') === 'Simple Signer', 'plain CN');
  check(zd.subjectCn('O=NoCommonName, C=US') === null, 'no CN -> null (never a pass)');
  check(zd.subjectCn('') === null, 'empty -> null');
  check(zd.subjectCn(null) === null, 'null -> null, no throw');
}

console.log('zoom-detection-smoke: architecture compatibility (never silent)');
{
  const ok  = (t, a) => zd.archCompare(t, a).ok;
  const msg = (t, a) => zd.archCompare(t, a).message;
  // x64 Windows
  check(ok('x64;1033', 'AMD64'), 'x64 MSI accepted on x64 Windows');
  check(ok('Intel;1033', 'AMD64'), '32-bit MSI accepted on x64 Windows (WOW64)');
  check(!ok('Arm64;1033', 'AMD64'), 'ARM64 MSI refused on x64 Windows');
  // ARM64 Windows — the directive's headline case: never silently x64.
  check(ok('Arm64;1033', 'ARM64'), 'ARM64 MSI accepted on ARM64 Windows');
  check(!ok('x64;1033', 'ARM64'), 'x64 MSI refused on ARM64');
  check(/ARM/.test(msg('x64;1033', 'ARM64')) && /x64/.test(msg('x64;1033', 'ARM64')), 'x64-on-ARM64 refusal names both architectures');
  check(!ok('Intel;1033', 'ARM64'), '32-bit MSI refused on ARM64');
  // 32-bit Windows
  check(ok('Intel;1033', 'x86'), '32-bit MSI accepted on 32-bit Windows');
  check(!ok('x64;1033', 'x86'), 'x64 MSI refused on 32-bit Windows');
  // Never-silent rule: EVERY non-ok verdict carries a real explanation.
  const cases = [
    ['Arm64;1033', 'AMD64'], ['x64;1033', 'ARM64'], ['Intel;1033', 'ARM64'],
    ['x64;1033', 'x86'], ['Arm64;1033', 'x86'],
    ['', 'AMD64'], ['banana;1033', 'AMD64'], ['x64;1033', ''], [null, null]
  ];
  check(cases.every(([t, a]) => {
    const r = zd.archCompare(t, a);
    return r.ok || (typeof r.message === 'string' && r.message.length > 20);
  }), 'every mismatch/unknown is an explained refusal — no silent outcome');
  check(zd.archCompare('banana;1033', 'AMD64').message.includes('banana'), 'unrecognized MSI platform stays visible in the refusal');
  check(!zd.archCompare('', 'AMD64').ok, 'missing Template property -> explained refusal, never a pass');
  // Normalizers used by the matrix
  check(zd.msiPlatform('x64;1033') === 'x64' && zd.msiPlatform('Intel;1033') === 'x86' && zd.msiPlatform('Arm64;1033') === 'arm64', 'Template platform tokens normalize');
  check(zd.osArchNorm('AMD64') === 'x64' && zd.osArchNorm('ARM64') === 'arm64' && zd.osArchNorm('x86') === 'x86', 'PROCESSOR_ARCHITECTURE values normalize (incl. ARM64)');
}

console.log('zoom-detection-smoke: launcher path extraction');
{
  // Current launcher: the REAL sealed-credential content main.js ships
  // (helper-credential.js, W5 Option A) — extraction is what the shortcut
  // staleness check runs against the file on disk.
  const hc = require('../helper-credential.js');
  const script = hc.launcherScriptContent('user1',
    'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe', 'C:\\Program Files (x86)\\Zoom\\bin');
  check(zd.extractLauncherZoomPath(script) === 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe', 'extracts baked -FilePath from sealed-credential launcher');
  const bom = '\ufeff' + script;
  check(zd.extractLauncherZoomPath(bom) === 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe', 'BOM-prefixed script still parses');

  // Legacy pre-W5A plaintext launcher still on disk in the field until the
  // next fix run overwrites it — the reader must keep parsing it.
  const legacy = "$p = ConvertTo-SecureString 'user1' -AsPlainText -Force\r\n$c = New-Object System.Management.Automation.PSCredential('user1', $p)\r\nStart-Process -FilePath 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe' -WorkingDirectory 'C:\\Program Files (x86)\\Zoom\\bin' -Credential $c\r\n";
  check(zd.extractLauncherZoomPath(legacy) === 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe', 'legacy plaintext launcher still parses');

  check(zd.extractLauncherZoomPath('no launch line here') === null, 'no launch line -> null (cannot judge)');
  check(zd.extractLauncherZoomPath('') === null, 'empty -> null');
  check(zd.extractLauncherZoomPath(null) === null, 'null -> null, no throw');
}

if (failures) {
  console.error(`zoom-detection-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('zoom-detection-smoke: all checks passed');
