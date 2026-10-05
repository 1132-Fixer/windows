'use strict';

// Trusted Windows executables, secret-safe stdin transport and fail-closed
// inventory contracts. No repair, account, registry or service changes occur.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const windowsTools = require('../src/main/windows-tools');

let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}
function existsIn(...values) {
  const known = new Set(values.map(value => path.win32.normalize(value).toLowerCase()));
  return value => known.has(path.win32.normalize(value).toLowerCase());
}
const ROOT = 'D:\\Windows';
const SYSTEM32 = path.win32.join(ROOT, 'System32');
const installed = existsIn(ROOT, SYSTEM32);
const fallback = existsIn('C:\\Windows', 'C:\\Windows\\System32');
const options = { env: { SystemRoot: ROOT, PATH: '' }, arch: 'x64', existsSync: installed };

console.log('windows-tools-smoke: system executable resolution');
for (const name of windowsTools.WINDOWS_TOOLS) {
  const expected = name === 'powershell.exe'
    ? path.win32.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', name)
    : path.win32.join(SYSTEM32, name);
  check(windowsTools.resolveTool(name, options) === expected,
    `${name} resolves without PATH and without requiring executable existence`);
}
{
  const fake = { ...options, env: { SystemRoot: ROOT, PATH: 'C:\\Fake tools', CWD: 'C:\\Fake tools' } };
  check(windowsTools.resolveTool('net.exe', fake) === `${SYSTEM32}\\net.exe`,
    'fake CWD and PATH executables cannot replace a Windows tool');
  check(windowsTools.resolveTool('reg.exe', { ...options, env: { systemroot: ROOT } }) === `${SYSTEM32}\\reg.exe`,
    'SystemRoot keys are case insensitive');
  check(windowsTools.resolveTool('reg.exe', { ...options, env: { windir: ROOT } }) === `${SYSTEM32}\\reg.exe`,
    'WINDIR supports a stripped SystemRoot environment');
  check(windowsTools.resolveTool('cmd.exe', { ...options, env: { SystemRoot: ROOT, processor_architew6432: 'AMD64' }, arch: 'ia32' }) === `${ROOT}\\Sysnative\\cmd.exe`,
    'WOW64 ia32 process resolves Sysnative regardless of environment-key case');
  check(windowsTools.resolveTool('cmd.exe', { ...options, env: { SystemRoot: ROOT, PROCESSOR_ARCHITEW6432: 'AMD64' } }) === `${SYSTEM32}\\cmd.exe`,
    'shipped x64 process never uses Sysnative');
  check(windowsTools.resolveTool('cmd.exe', { ...options, arch: 'ia32' }) === `${SYSTEM32}\\cmd.exe`,
    '32-bit Windows uses System32');
  const unicodeRoot = 'E:\\Windows installations\\Fenêtres 日本語';
  const unicode = { env: { SystemRoot: unicodeRoot }, arch: 'x64',
    existsSync: existsIn(unicodeRoot, `${unicodeRoot}\\System32`) };
  check(windowsTools.resolveTool('powershell.exe', unicode) === `${unicodeRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    'spaces and Unicode Windows roots remain one executable path');
}
for (const root of ['Windows', '\\Windows', '/Windows', 'C:Windows', 'C:\\Temp\\..\\Windows', '\\\\server\\Windows', '\\\\?\\C:\\Windows', 'C:\\Windows\u0000']) {
  check(windowsTools.resolveSystemRoot({ SystemRoot: root }, fallback) === 'C:\\Windows',
    `unsafe Windows root ${JSON.stringify(root)} is ignored`);
}
check(windowsTools.resolveSystemRoot({ SystemRoot: 'D:\\Fake' }, existsIn('D:\\Fake')) === null,
  'an arbitrary existing folder without System32 is rejected');
check(windowsTools.resolveSystemRoot({}, fallback) === 'C:\\Windows',
  'known Windows installation is used for missing root metadata');
check(windowsTools.resolveSystemRoot({}, () => { throw new Error('filesystem unavailable'); }) === null,
  'filesystem failure has no PATH fallback');
for (const name of ['net', 'NET.EXE', 'calc.exe', '..\\net.exe', 'C:\\Fake\\net.exe']) {
  assert.throws(() => windowsTools.resolveTool(name, options), { code: 'WINDOWS_TOOL_NOT_ALLOWED' });
  checks++;
}
assert.throws(() => windowsTools.resolveTool('net.exe', { env: {}, existsSync: () => false }),
  { code: 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE' });
checks++;

console.log('windows-tools-smoke: secret-safe transport');
const SECRET = 'smoke-password-\u65e5\u672c\u8a9e-quote\'-$`-!';
const secretScript = `$pw = '${SECRET.replace(/'/g, "''")}'; Write-Output 'done'`;
check(!JSON.stringify(windowsTools.PS_STDIN_ARGS).includes(SECRET), 'credentials never appear in process arguments');
check(!windowsTools.PS_STDIN_ARGS.includes('-File') && !windowsTools.PS_STDIN_ARGS.includes('-EncodedCommand'),
  'transport has no script-file or encoded-script argument');
check(windowsTools.PS_STDIN_ARGS.at(-1).includes('[Console]::In.ReadToEnd()'),
  'fixed command reads the entire script before parsing compound blocks');
check(windowsTools.prepareScript(secretScript).endsWith(secretScript),
  'caller content stays intact in stdin, including its final line');
check(windowsTools.prepareScript('Write-Output 1').startsWith(windowsTools.PS_UTF8_OUTPUT_PREAMBLE),
  'captured output uses UTF-8 before caller code runs');
check(windowsTools.prepareScript('').includes('[Environment]::SystemDirectory') &&
  !windowsTools.prepareScript('').includes('$env:SystemRoot'),
  'embedded native tools use the Windows API system directory');
assert.throws(() => windowsTools.prepareScript(undefined), TypeError);
checks++;

console.log('windows-tools-smoke: inventory validation');
const toolNames = ['powershell.exe', 'net.exe', 'reg.exe', 'quser.exe'];
const valid = Object.fromEntries(toolNames.map(name => [name, true]));
Object.assign(valid, { seclogon_status: 'Running', seclogon_starttype: 'Manual' });
const reply = (inventory = valid, extra = {}) => ({ code: 0, stdout: JSON.stringify(inventory), ...extra });
{
  const parsed = windowsTools.parseProbe(reply(), toolNames);
  check(parsed.ok && parsed.diagnostic === null && parsed.tools['net.exe'] === true && parsed.seclogon.status === 'Running',
    'complete boolean inventory and service data are accepted');
  const parsedMissing = windowsTools.parseProbe(reply({ ...valid, 'net.exe': false, 'quser.exe': false }), toolNames);
  check(parsedMissing.ok && parsedMissing.tools['net.exe'] === false && parsedMissing.tools['quser.exe'] === false,
    'confirmed missing tools stay false rather than unknown');
  const missingService = windowsTools.parseProbe(reply({ ...valid, seclogon_status: 'MISSING', seclogon_starttype: 'MISSING' }), toolNames);
  check(missingService.ok && missingService.seclogon.status === 'MISSING',
    'confirmed absent service stays distinct from an unreadable service');
  const tool_paths = Object.fromEntries(toolNames.map(name => [name, windowsTools.resolveTool(name, options)]));
  const parsedPaths = windowsTools.parseProbe(reply({ ...valid, tool_paths, ignored: SECRET }), toolNames);
  check(parsedPaths.ok && parsedPaths.tool_paths['net.exe'] === `${SYSTEM32}\\net.exe` && !JSON.stringify(parsedPaths).includes(SECRET),
    'valid resolved-path metadata is preserved without unrelated probe data');
}
const partial = { ...valid };
delete partial['reg.exe'];
const badProbes = [
  ['empty stdout', { code: 0, stdout: '' }],
  ['whitespace stdout', { code: 0, stdout: ' \r\n' }],
  ['empty JSON object', reply({})],
  ['JSON null', reply(null)],
  ['JSON array', reply([valid])],
  ['malformed JSON', { code: 0, stdout: '{"net.exe":true' }],
  ['extra output after JSON', { code: 0, stdout: JSON.stringify(valid) + '\nerror' }],
  ['partial inventory', reply(partial)],
  ['nonboolean inventory', reply({ ...valid, 'net.exe': 'true' })],
  ['null inventory status', reply({ ...valid, 'net.exe': null })],
  ['missing service status', reply({ ...valid, seclogon_status: undefined })],
  ['unknown service status', reply({ ...valid, seclogon_status: 'not checked' })],
  ['missing service start type', reply({ ...valid, seclogon_starttype: undefined })],
  ['mixed missing service fields', reply({ ...valid, seclogon_status: 'MISSING' })],
  ['nonzero exit with valid stdout', reply(valid, { code: 1 })],
  ['no exit status with valid stdout', reply(valid, { code: null })],
  ['spawn failure with valid stdout', reply(valid, { error: new Error(SECRET), errorCode: 'ENOENT' })],
  ['failed outcome with valid stdout', reply(valid, { outcome: 'launch-error' })],
  ['timeout with valid stdout', reply(valid, { timedOut: true, code: -1 })],
  ['timeout outcome with valid stdout', reply(valid, { outcome: 'timeout' })],
  ['unsafe tool paths', reply({ ...valid, tool_paths: Object.fromEntries(toolNames.map(name => [name, `C:\\Fake\\${name}`])) })],
  ['partial tool paths', reply({ ...valid, tool_paths: {} })],
  ['no result', null]
];
for (const [name, result] of badProbes) {
  const parsed = windowsTools.parseProbe(result, toolNames);
  check(!parsed.ok && Object.values(parsed.tools).every(value => value === null) &&
    parsed.seclogon.status === 'not checked' && parsed.diagnostic &&
    !JSON.stringify(parsed).includes(SECRET), `${name}: one diagnostic, unknown tools, no synthetic missing data`);
  check(parsed.diagnostic.code === (result && (result.timedOut || result.outcome === 'timeout')
    ? 'tool_probe_timeout' : 'tool_probe_failed'), `${name}: failure class remains accurate`);
}
const failedCode = windowsTools.parseProbe(reply(valid, { code: -1, errorCode: 'ENOENT' }), toolNames).diagnostic;
check(failedCode.exitCode === -1 && failedCode.errorCode === 'ENOENT' && failedCode.timedOut === false,
  'failure diagnostics retain exit/error codes without exposing process output');
const untrustedCode = windowsTools.parseProbe(reply(valid, { code: 1, errorCode: SECRET }), toolNames).diagnostic;
check(untrustedCode.errorCode === null, 'untrusted error text is not copied into structured diagnostics');
assert.throws(() => windowsTools.parseProbe(reply(), ['net.exe', 'net.exe']), TypeError);
checks++;

if (process.platform === 'win32') {
  console.log('windows-tools-smoke: real Windows transport (read-only)');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-tools-'));
  try {
    for (const name of ['powershell.exe', 'cmd.exe', 'net.exe']) {
      fs.writeFileSync(path.join(temp, name), 'fake executable: must never be launched');
    }
    const exe = windowsTools.resolveTool('powershell.exe');
    const run = (script) => spawnSync(exe, windowsTools.PS_STDIN_ARGS, {
      input: Buffer.from(windowsTools.prepareScript(script), 'utf8'),
      cwd: temp, env: { ...process.env, PATH: '' }, windowsHide: true, timeout: 30000
    });
    const sample = "C:\\Users\\José\\Área de Trabalho — Рабочий стол — デスクトップ';$`";
    const unicode = run(`Write-Output '${sample.replace(/'/g, "''")}'`);
    check(unicode.status === 0 && unicode.stdout.toString('utf8').trim() === sample,
      'UTF-8 and punctuation round-trip with PATH empty and fake CWD tools');
    const blocks = run("$items = @(); foreach ($i in @(1, 2, 3)) {\n  if ($i -gt 1) { $items += $i }\n}; Write-Output ($items -join '|')");
    check(blocks.status === 0 && blocks.stdout.toString('utf8').trim() === '2|3',
      'compound blocks execute with no final newline');
    const native = run("& (Resolve-FixerTool 'cmd.exe') /d /c 'echo TRUSTED_CMD'");
    check(native.status === 0 && native.stdout.toString('utf8').trim() === 'TRUSTED_CMD',
      'embedded native command resolves independently of PATH and fake CWD');
    const paths = run("$r = @{}; foreach ($name in @('powershell.exe','cmd.exe')) { $r[$name] = Resolve-FixerTool $name }; $r | ConvertTo-Json -Compress");
    let realPaths = null;
    try { realPaths = JSON.parse(paths.stdout.toString('utf8').trim()); } catch (_) {}
    check(paths.status === 0 && realPaths && realPaths['powershell.exe'].toLowerCase() === exe.toLowerCase() &&
      !Object.values(realPaths).some(value => value.includes(temp)),
      'PowerShell and Node select the same system tools');
    const finalLine = run("Write-Output 'FINAL_LINE'");
    check(finalLine.status === 0 && finalLine.stdout.toString('utf8').trim() === 'FINAL_LINE',
      'last command runs without a trailing newline');
    const malformed = run(`$pw = '${SECRET.replace(/'/g, "''")}'; if (`);
    check(malformed.status === 1 && !malformed.stderr.toString('utf8').includes(SECRET) &&
      malformed.stderr.toString('utf8').includes('PowerShell script failed.'),
      'parser failures never echo credential-bearing script source');
    const explicitFailure = run('exit 7');
    check(explicitFailure.status === 7, 'explicit script failure keeps its nonzero exit code');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.log('  not-run real Windows transport: Windows PowerShell requires Windows');
}

console.log(`windows-tools-smoke: ${checks} checks passed`);
