'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { OPERATOR_IDENTITY_PROBE, validateOperatorIdentity, checkOperatorIdentity } =
  require('../src/main/operator-identity');

let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }
const sid = 'S-1-5-21-100-200-300-1001';
const otherSid = 'S-1-5-21-100-200-300-1002';
const aadSid = 'S-1-12-1-100-200-300-400';
const receipt = (session = 1, token = sid, user = token) =>
  `FIXER_OPERATOR_IDENTITY_V1|${session}|${token}|${user}`;
const capture = stdout => ({ code: 0, timedOut: false, stdout, stderr: '' });

let completed = false;
const deadline = setTimeout(() => { console.error('operator-identity-smoke: timed out'); process.exit(1); }, 30000);
deadline.unref();
process.once('beforeExit', () => {
  if (!completed) { console.error('operator-identity-smoke: incomplete'); process.exitCode = 1; }
});

(async () => {
  for (const user of [sid, aadSid]) {
    for (const suffix of ['', '\n', '\r\n']) {
      const result = validateOperatorIdentity(capture(receipt(2, user) + suffix), { helperSid: otherSid });
      check(result.ok && result.sessionId === 2 && result.tokenSid === user && result.sessionUserSid === user,
        'the exact same local/domain or Azure AD token and session identity is accepted');
    }
  }
  check(validateOperatorIdentity(capture(receipt(1, sid, otherSid))).code === 'operator_identity_mismatch',
    'a different administrator token in the operator session blocks');
  for (const [token, user] of [[sid, sid], [sid, otherSid], [otherSid, sid]]) {
    check(validateOperatorIdentity(capture(receipt(1, token, user)), { helperSid: sid }).code === 'operator_is_helper',
      'the helper SID may be neither the current token nor the signed-in session user');
  }
  for (const stdout of [null, undefined, {}, 1, '', receipt(0), receipt(-1), receipt('01'),
    receipt(2147483648), receipt('1.0'), receipt('1e0'), receipt(1) + '\n\n', receipt(1) + '\r',
    ' ' + receipt(1), receipt(1) + ' ', receipt(1) + '\nUNVERIFIED', receipt(1) + '\n' + receipt(1),
    'FIXER_OPERATOR_IDENTITY_V1=UNVERIFIED', 'x'.repeat(513)]) {
    check(validateOperatorIdentity(capture(stdout)).code === 'operator_identity_unverified',
      'missing, ambiguous, noncanonical or noninteractive-session receipts block');
  }
  for (const invalidSid of ['S-1-5-18', 'S-1-5-19', 'S-1-5-20', 'S-1-5-80-1-2-3-4-5',
    'S-1-5-21-01-200-300-1001', 'S-1-5-21-4294967296-200-300-1001',
    'S-1-12-1-100-200-300-4294967296', sid + '\n', sid + "';exit 0;#", 'user1']) {
    check(!validateOperatorIdentity(capture(receipt(1, invalidSid))).ok,
      'system, service, malformed and out-of-range SIDs block');
  }
  const healthy = capture(receipt());
  for (const value of [null, undefined, {}, { ...healthy, code: '0' }, { ...healthy, code: 1 },
    { ...healthy, timedOut: true }, { ...healthy, timedOut: undefined },
    { ...healthy, stderr: 'private native error' }, { ...healthy, stderr: undefined }]) {
    check(!validateOperatorIdentity(value).ok, 'only an exact successful quiet capture can authorize work');
  }
  let calls = 0;
  const runCapture = async (script, options) => {
    calls++;
    check(script === OPERATOR_IDENTITY_PROBE, 'the adapter runs the exact read-only production probe');
    check(options.timeoutMs === 20000, 'identity lookup has a finite native deadline');
    return healthy;
  };
  check((await checkOperatorIdentity(runCapture, { helperSid: otherSid })).ok && calls === 1,
    'one successful exact probe permits continuation');
  for (const options of [null, [], 'text', { helperSid: null }, { helperSid: 'user1' }, { helperSid: sid + '\n' }]) {
    check(!(await checkOperatorIdentity(runCapture, options)).ok && calls === 1,
      'invalid helper identity/options never reach the native adapter');
  }
  check(!(await checkOperatorIdentity(null)).ok, 'an unavailable adapter blocks');
  const failed = await checkOperatorIdentity(async () => { throw new Error('PRIVATE_ACCOUNT_NAME'); });
  check(JSON.stringify(failed) === '{"ok":false,"code":"operator_identity_unverified"}',
    'native exceptions produce only a fixed diagnostic without private names or raw errors');
  check(OPERATOR_IDENTITY_PROBE.includes('process.SessionId') &&
    OPERATOR_IDENTITY_PROBE.includes('Query(IntPtr.Zero, session, infoClass') &&
    OPERATOR_IDENTITY_PROBE.includes('ReadField(session, 5)') &&
    OPERATOR_IDENTITY_PROBE.includes('ReadField(session, 7)'),
  'both WTS fields come from the calling process session on the local server');
  check(OPERATOR_IDENTITY_PROBE.includes('if (session <= 0)') &&
    OPERATOR_IDENTITY_PROBE.includes('new NTAccount(domain, user)') &&
    OPERATOR_IDENTITY_PROBE.includes('.Translate(typeof(SecurityIdentifier))'),
  'session zero and unqualified/unresolved user identities cannot pass');
  check(OPERATOR_IDENTITY_PROBE.includes('finally {\n            if (buffer != IntPtr.Zero) WTSFreeMemory(buffer);') &&
    OPERATOR_IDENTITY_PROBE.includes('using (Process process') &&
    OPERATOR_IDENTITY_PROBE.includes('using (WindowsIdentity token') &&
    OPERATOR_IDENTITY_PROBE.includes('DefaultDllImportSearchPaths(DllImportSearchPath.System32)'),
  'native buffers and identity/process handles are disposed and native DLL lookup stays in System32');
  check(!/\b(?:WTSGetActiveConsoleSessionId|WTSQueryUserToken|Stop-Service|Start-Service|Stop-Process|Set-Item|Remove-Item|New-LocalUser|Set-Acl)\b/.test(OPERATOR_IDENTITY_PROBE),
    'the proof does not use console-only identity, acquire another token, or mutate the machine');

  if (process.platform === 'win32') {
    const { NATIVE_PS_STDIN_ARGS, nativePowerShell7, prepareNativeScript } = require('./native-powershell');
    const definition = /Add-Type -TypeDefinition @'\r?\n([\s\S]+?)\r?\n'@ -ErrorAction Stop/.exec(OPERATOR_IDENTITY_PROBE);
    check(Boolean(definition), 'the exact native definition is available for a separate compile check');
    const compile = spawnSync(nativePowerShell7(), NATIVE_PS_STDIN_ARGS, {
      input: prepareNativeScript("$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n" + definition[1] +
        "\n'@ -ErrorAction Stop\nWrite-Output 'FIXER_OPERATOR_NATIVE_COMPILED'"),
      encoding: 'utf8', windowsHide: true, timeout: 20000
    });
    check(!compile.error && compile.status === 0 &&
      String(compile.stdout).trim() === 'FIXER_OPERATOR_NATIVE_COMPILED' && !String(compile.stderr).trim(),
    'the actual read-only Windows native binding compiles under PowerShell 7');
    const native = spawnSync(nativePowerShell7(), NATIVE_PS_STDIN_ARGS, {
      input: prepareNativeScript(OPERATOR_IDENTITY_PROBE), encoding: 'utf8', windowsHide: true, timeout: 20000
    });
    check(!native.error && !native.signal, 'the real read-only identity probe exits within its bound');
    const result = validateOperatorIdentity({
      code: native.status, timedOut: false, stdout: String(native.stdout), stderr: String(native.stderr)
    });
    check(result.ok || (native.status === 1 && String(native.stdout).trim() === 'FIXER_OPERATOR_IDENTITY_V1=UNVERIFIED' &&
      !String(native.stderr).trim()) || result.code === 'operator_identity_mismatch',
    'the current Windows session returns exact identity proof or an explicit fail-closed result');
    console.log(`operator-identity-smoke: native current-session outcome=${result.ok ? 'verified' : result.code}`);
  } else {
    console.log('operator-identity-smoke: native identity probe not-run (non-Windows host)');
  }
  console.log(`operator-identity-smoke: ${checks} checks passed`);
  completed = true;
})().catch(() => {
  completed = true;
  console.error(`operator-identity-smoke: failed after ${checks} checks`);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
