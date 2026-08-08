// Smoke test for helper-credential.js — per-run CSPRNG helper password +
// sealed-credential desktop launcher (W5-SECURITY-DESIGN Option A, #33/#76).
// Imports the REAL module main.js ships with. Pure logic only:
//  - generated passwords meet length/class requirements and contain no
//    character that could escape a single-quoted PS string, break
//    CreateProcess argv quoting, or read as a net.exe switch
//  - the launcher content embeds NO plaintext credential, unseals via DPAPI
//    CurrentUser, keeps the Start-Process shape zoom-detect.js parses, and
//    fails friendly (FIX NOW guidance) instead of dying silently
// The DPAPI Protect/Unprotect round-trip itself is runtime behavior verified
// on Windows during a fix run; its failure path is the dpapi_seal_failed
// soft-fail warning in main.js, not a pure function — out of scope here.

const hc = require('../helper-credential.js');
const zd = require('../zoom-detect.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('helper-credential-smoke: generateHelperPassword');
{
  // Characters that must NEVER appear: apostrophe + CR/LF (end a
  // single-quoted PS string), backtick/;&| (PS metacharacters), double
  // quote + backslash + space (argv quoting), / (net.exe switch).
  const UNSAFE = /['\r\n`;&|"\\\/ ]/;
  const seen = new Set();
  let ok = { len: true, alphabet: true, classes: true, unsafe: true };
  for (let i = 0; i < 200; i++) {
    const pw = hc.generateHelperPassword();
    seen.add(pw);
    if (pw.length !== hc.PASSWORD_LENGTH) ok.len = false;
    if ([...pw].some(ch => !hc.PASSWORD_ALPHABET.includes(ch))) ok.alphabet = false;
    if (!hc.PASSWORD_CLASSES.every(cls => [...pw].some(ch => cls.includes(ch)))) ok.classes = false;
    if (UNSAFE.test(pw)) ok.unsafe = false;
    if (!hc.isSafeHelperPassword(pw)) ok.classes = false;
  }
  check(hc.PASSWORD_LENGTH === 24, 'password length is 24');
  check(ok.len, '200 generated passwords all have exact length');
  check(ok.alphabet, 'all characters drawn from the declared alphabet');
  check(ok.classes, 'every password carries all four complexity classes (validator agrees)');
  check(ok.unsafe, 'no PS-quote/argv/net.exe-hostile character ever appears');
  check(seen.size === 200, '200 generations are 200 distinct passwords');
  check(!UNSAFE.test(hc.PASSWORD_ALPHABET), 'the alphabet itself contains no unsafe character');
}

console.log('helper-credential-smoke: isSafeHelperPassword rejects bad shapes');
{
  check(!hc.isSafeHelperPassword('user1'), 'legacy static password rejected');
  check(!hc.isSafeHelperPassword(''), 'empty rejected');
  check(!hc.isSafeHelperPassword('Aa1!'), 'too short rejected');
  check(!hc.isSafeHelperPassword('a'.repeat(24)), 'single-class rejected');
  check(!hc.isSafeHelperPassword("Aa1!Aa1!Aa1!Aa1!Aa1!Aa'!"), 'apostrophe rejected');
  check(!hc.isSafeHelperPassword(null), 'null rejected');
  check(!hc.isSafeHelperPassword(42), 'non-string rejected');
}

console.log('helper-credential-smoke: launcherScriptContent');
{
  const zoomPath = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
  const zoomDir  = 'C:\\Program Files\\Zoom\\bin';
  const script = hc.launcherScriptContent('user1', zoomPath, zoomDir);

  check(!/ConvertTo-SecureString\s+'[^']/.test(script), 'no single-quoted plaintext credential literal anywhere');
  check(/ProtectedData\]::Unprotect/.test(script), 'unseals via ProtectedData::Unprotect');
  check(/DataProtectionScope\]::CurrentUser/.test(script), 'DPAPI CurrentUser scope (primary-user shortcut context)');
  check(script.includes(hc.CRED_BLOB_NAME), 'reads the co-located credential blob');
  check(/\$PSScriptRoot/.test(script), 'blob resolved relative to the script (co-located)');
  check(/PSCredential\('user1', \$p\)/.test(script), 'signs in as the helper user');
  check(zd.extractLauncherZoomPath(script) === zoomPath, 'Start-Process shape parseable by zoom-detect staleness reader');
  check(script.includes(`-WorkingDirectory '${zoomDir}'`), 'working directory baked (per-user-NSIS cwd trap)');
  check(/FIX NOW/.test(script), 'catch branch tells the user to re-run FIX NOW');
  check(/MessageBox\]::Show/.test(script), 'failure surfaces visibly (hidden-window launcher cannot print)');
  check(script.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r')), 'CRLF line endings throughout (PS 5.1 convention)');
  check(!script.includes('\ufeff'), 'no BOM inside the content (the writer prepends it exactly once)');
}

if (failures) {
  console.error(`helper-credential-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('helper-credential-smoke: all checks passed');
