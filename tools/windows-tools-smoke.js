'use strict';

// Trusted Windows executables, secret-safe stdin transport and fail-closed
// inventory contracts. No repair, account, registry or service changes occur.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const windowsTools = require('../src/main/windows-tools');

let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}
function loadedReport(root, folder = 'System32') {
  return { sharedObjects: ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => path.win32.join(root, folder, name)) };
}
const ROOT = 'D:\\Windows';
const SYSTEM32 = path.win32.join(ROOT, 'System32');
const options = { getReport: () => loadedReport(ROOT), arch: 'x64' };

console.log('windows-tools-smoke: OS-loaded system executable resolution');
for (const name of windowsTools.WINDOWS_TOOLS) {
  const expected = name === 'powershell.exe'
    ? path.win32.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', name)
    : path.win32.join(SYSTEM32, name);
  check(windowsTools.resolveTool(name, options) === expected,
    `${name} resolves from loaded OS libraries without PATH or disk-shape guesses`);
}
{
  const fake = { ...options, env: { SystemRoot: 'C:\\Fake tools', WINDIR: 'C:\\Fake tools', PATH: 'C:\\Fake tools', PROCESSOR_ARCHITEW6432: 'AMD64' }, existsSync: () => true };
  check(windowsTools.resolveTool('net.exe', fake) === `${SYSTEM32}\\net.exe`,
    'forged environment and an existing fake System32 cannot replace OS-loaded authority');
  check(windowsTools.resolveTool('cmd.exe', { ...fake, arch: 'x64' }) === `${SYSTEM32}\\cmd.exe`,
    'a forged WOW64 variable cannot redirect a native process to Sysnative');
  const wow64 = { getReport: () => loadedReport(ROOT, 'SysWOW64'), arch: 'ia32' };
  check(windowsTools.resolveTool('cmd.exe', wow64) === `${ROOT}\\Sysnative\\cmd.exe`,
    'WOW64 comes from loaded SysWOW64 core libraries without environment metadata');
  check(windowsTools.resolveTool('cmd.exe', { ...options, arch: 'ia32' }) === `${SYSTEM32}\\cmd.exe`,
    'native 32-bit Windows core libraries use System32');
  const unicodeRoot = 'E:\\Windows installations\\Fenêtres 日本語';
  check(windowsTools.resolveTool('powershell.exe', { getReport: () => loadedReport(unicodeRoot), arch: 'x64' }) ===
    `${unicodeRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, 'spaces and Unicode loaded-library roots remain intact');
}
const goodObjects = loadedReport(ROOT).sharedObjects;
const badReports = [
  ['no report API', null],
  ['throwing report API', () => { throw new Error('report unavailable'); }],
  ['empty report', () => ({})],
  ['empty module list', () => ({ sharedObjects: [] })],
  ['string module list', () => ({ sharedObjects: goodObjects.join(',') })],
  ['nonstring module entry', () => ({ sharedObjects: [...goodObjects, 42] })],
  ['missing kernelbase', () => ({ sharedObjects: goodObjects.slice(0, 2) })],
  ['mismatching OS roots', () => ({ sharedObjects: [goodObjects[0], goodObjects[1], 'C:\\Fake\\System32\\kernelbase.dll'] })],
  ['mismatching system folders', () => ({ sharedObjects: [goodObjects[0], goodObjects[1], `${ROOT}\\SysWOW64\\kernelbase.dll`] })],
  ['conflicting duplicate core DLL', () => ({ sharedObjects: [...goodObjects, 'C:\\Fake\\System32\\ntdll.dll'] })],
  ['core DLL outside system folder', () => ({ sharedObjects: [goodObjects[0], goodObjects[1], `${ROOT}\\kernelbase.dll`] })]
];
for (const value of ['Windows', '\\Windows', '/Windows', 'C:Windows', 'C:\\Temp\\..\\Windows', '\\\\server\\Windows', '\\\\?\\C:\\Windows', 'C:\\Windows\u0000', 'C:\\Windows:stream']) {
  badReports.push([`malformed loaded path ${JSON.stringify(value)}`, () => ({ sharedObjects: ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `${value}\\System32\\${name}`) })]);
}
for (const [name, getReport] of badReports) {
  const resolver = windowsTools.createToolResolver({ getReport, arch: 'x64' });
  check(resolver.resolveSystemRoot() === null, `${name}: no root is fabricated`);
  assert.throws(() => resolver.resolveTool('powershell.exe'), { code: 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE' });
  checks++;
}
{
  let reads = 0;
  let report = loadedReport(ROOT);
  const resolver = windowsTools.createToolResolver({ getReport: () => { reads++; return report; }, arch: 'x64' });
  check(resolver.resolveSystemRoot() === ROOT, 'all three OS DLL identities establish one root');
  report = loadedReport('C:\\Fake');
  check(resolver.resolveTool('net.exe') === `${SYSTEM32}\\net.exe` && resolver.resolveTool('reg.exe') === `${SYSTEM32}\\reg.exe` && reads === 1,
    'only vetted root metadata is cached; subsequent reports cannot replace startup authority');
  let failedReads = 0;
  const unavailable = windowsTools.createToolResolver({ getReport: () => { failedReads++; return null; }, arch: 'x64' });
  check(unavailable.resolveSystemRoot() === null && unavailable.resolveSystemRoot() === null && failedReads === 1,
    'failed authority is cached once rather than rescanned or replaced by environment guesses');
  const duplicates = windowsTools.createToolResolver({ getReport: () => ({ sharedObjects: [...goodObjects, goodObjects[0].toUpperCase()] }), arch: 'x64' });
  check(duplicates.resolveSystemRoot()?.toLowerCase() === ROOT.toLowerCase(), 'identical case-insensitive core DLL duplicates preserve consensus');
  check(windowsTools.createToolResolver({ getReport: () => loadedReport(ROOT, 'SysWOW64'), arch: 'x64' }).resolveSystemRoot() === null,
    'native 64-bit process rejects a contradictory SysWOW64 report');
}
{
  const source = fs.readFileSync(require.resolve('../src/main/windows-tools'), 'utf8');
  const evaluate = report => {
    const module = { exports: {} };
    vm.runInNewContext(source, { require, module, process: { arch: 'x64', report } });
    return module.exports;
  };
  let reads = 0;
  const report = { excludeEnv: false, excludeNetwork: false, getReport() {
    reads++;
    assert.equal(this.excludeEnv, true);
    assert.equal(this.excludeNetwork, true);
    return { ...loadedReport(ROOT), environmentVariables: { PRIVATE: 'must-not-retain' } };
  } };
  const runtime = evaluate(report);
  check(runtime.resolveSystemRoot() === ROOT && runtime.resolveTool('net.exe') === `${SYSTEM32}\\net.exe` && reads === 1,
    'production module establishes OS authority at initialization and reads the report once');
  check(report.excludeEnv === false && report.excludeNetwork === false,
    'diagnostic report privacy flags are restored after collection');
  const throwing = { excludeEnv: false, excludeNetwork: false, getReport() { throw new Error('private diagnostic failure'); } };
  check(evaluate(throwing).resolveSystemRoot() === null && !throwing.excludeEnv && !throwing.excludeNetwork,
    'report exceptions fail closed and restore process-wide privacy flags');
  check(evaluate(undefined).resolveSystemRoot() === null,
    'a runtime without the diagnostic report API cannot fabricate OS authority');
}
for (const name of ['net', 'NET.EXE', 'calc.exe', '..\\net.exe', 'C:\\Fake\\net.exe']) {
  assert.throws(() => windowsTools.resolveTool(name, options), { code: 'WINDOWS_TOOL_NOT_ALLOWED' });
  checks++;
}

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
    const nativePs = path.win32.join(windowsTools.resolveSystemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    check(paths.status === 0 && realPaths && realPaths['powershell.exe'].toLowerCase() === nativePs.toLowerCase() &&
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

    const fakeRoot = path.join(temp, 'Fake Windows 日本語');
    const fakeSystem = path.join(fakeRoot, 'System32');
    const fakePs = path.join(fakeSystem, 'WindowsPowerShell', 'v1.0');
    fs.mkdirSync(fakePs, { recursive: true });
    for (const name of windowsTools.WINDOWS_TOOLS) fs.writeFileSync(path.join(name === 'powershell.exe' ? fakePs : fakeSystem, name), 'invalid fake executable; must never run');
    const forgedEnv = {
      ...process.env,
      FIXER_TEST_FORGED_ENV: JSON.stringify({ SystemRoot: fakeRoot, WINDIR: fakeRoot, PATH: '', PROCESSOR_ARCHITEW6432: 'FORGED' })
    };
    // Public, read-only fixture source. It is not the PowerShell transport.
    const childSource = `
      const write = value => require('fs').writeSync(1, value + '\\n');
      const phase = value => write('FIXER_PHASE:' + value);
      phase('script-start');
      const forgedFixture = process.env.FIXER_TEST_FORGED_ENV;
      let forged = null;
      if (forgedFixture !== undefined) {
        forged = JSON.parse(forgedFixture);
        const keys = ['SystemRoot', 'WINDIR', 'PATH', 'PROCESSOR_ARCHITEW6432'];
        if (!keys.every(key => typeof forged[key] === 'string')) throw new TypeError('invalid forged environment fixture');
        for (const key of Object.keys(process.env)) {
          if (/^(?:systemroot|windir|path|processor_architew6432)$/i.test(key)) delete process.env[key];
        }
        for (const key of keys) process.env[key] = forged[key];
        delete process.env.FIXER_TEST_FORGED_ENV;
      }
      const receipt = { stage: 'started', arch: process.arch, reportAvailable: typeof process.report?.getReport === 'function' };
      try {
        receipt.stage = 'load-module';
        phase(receipt.stage);
        const tools = require(process.argv[1]);
        receipt.root = tools.resolveSystemRoot();
        if (!receipt.root && receipt.reportAvailable) {
          const reportApi = process.report;
          const changed = [];
          try {
            for (const flag of ['excludeEnv', 'excludeNetwork']) {
              if (flag in reportApi) { changed.push([flag, reportApi[flag]]); reportApi[flag] = true; }
            }
            const objects = reportApi.getReport()?.sharedObjects;
            receipt.libraryListAvailable = Array.isArray(objects);
            receipt.coreLibraries = Array.isArray(objects) ? objects.filter(value => typeof value === 'string' && /^(?:ntdll|kernel32|kernelbase)\\.dll$/i.test(require('path').win32.basename(value))).slice(0, 6).map(value => ({
              name: require('path').win32.basename(value).toLowerCase(),
              folder: require('path').win32.basename(require('path').win32.dirname(value)).toLowerCase(),
              driveAbsolute: /^[A-Za-z]:[\\\\/]/.test(value)
            })) : [];
          } finally {
            for (const [flag, value] of changed.reverse()) reportApi[flag] = value;
          }
        }
        receipt.stage = 'resolve-executable';
        phase(receipt.stage);
        receipt.exe = tools.resolveTool('powershell.exe');
        receipt.stage = 'run-powershell';
        phase(receipt.stage);
        const powershellEnv = forged ? {
          ...process.env, SystemRoot: receipt.root, WINDIR: receipt.root, PATH: '',
          FIXER_TEST_FORGED_SYSTEM_ROOT: forged.SystemRoot, FIXER_TEST_FORGED_WINDIR: forged.WINDIR
        } : process.env;
        const applyForgedEnvironment = forged
          ? "$fixerTestSystemRoot = $env:FIXER_TEST_FORGED_SYSTEM_ROOT; $fixerTestWindir = $env:FIXER_TEST_FORGED_WINDIR; Remove-Item Env:FIXER_TEST_FORGED_SYSTEM_ROOT; Remove-Item Env:FIXER_TEST_FORGED_WINDIR; $env:SystemRoot = $fixerTestSystemRoot; $env:WINDIR = $fixerTestWindir; $env:PATH = ''; "
          : '';
        const result = require('child_process').spawnSync(receipt.exe, tools.PS_STDIN_ARGS, {
          input: Buffer.from(tools.prepareScript(applyForgedEnvironment + "& (Resolve-FixerTool 'cmd.exe') /d /c 'echo FIXER_TRUSTED'; [Environment]::SystemDirectory"), 'utf8'),
          env: powershellEnv, windowsHide: true, timeout: 15000, encoding: 'utf8'
        });
        const lines = (result.stdout || '').trim().split(/\\r?\\n/);
        receipt.exitCode = result.status;
        receipt.signal = result.signal;
        receipt.markerMatches = lines[0] === 'FIXER_TRUSTED';
        receipt.systemDirMatches = lines[1]?.toLowerCase() === require('path').win32.join(receipt.root, 'System32').toLowerCase();
        receipt.stderrBytes = Buffer.byteLength(result.stderr || '');
        receipt.errorCode = typeof result.error?.code === 'string' ? result.error.code : null;
        receipt.stage = 'complete';
      } catch (error) {
        receipt.errorCode = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNKNOWN';
      }
      phase(receipt.stage);
      write(JSON.stringify(receipt));
    `;
    const childProof = (env, label) => {
      const realChild = spawnSync(process.execPath, ['-e', childSource, require.resolve('../src/main/windows-tools')], {
        cwd: temp, env, windowsHide: true, timeout: 30000, encoding: 'utf8'
      });
      let proof;
      const lines = (realChild.stdout || '').trim().split(/\r?\n/);
      const phases = lines.filter(value => /^FIXER_PHASE:(?:script-start|load-module|resolve-executable|run-powershell|complete)$/.test(value)).map(value => value.slice('FIXER_PHASE:'.length));
      try { proof = JSON.parse(lines[lines.length - 1]); } catch (_) {}
      // Child errors can include source or inherited metadata. Log only
      // explicit stage/status fields, fixed markers and verified path fields.
      const stderrClass = ['SyntaxError', 'MODULE_NOT_FOUND', 'ERR_INVALID_ARG', 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE'].find(value => (realChild.stderr || '').includes(value)) || null;
      // Native assertion text is compile-time source, not a report. Keep
      // identifiers only; discard quoted literals, paths and stack output.
      const assertion = (realChild.stderr || '').split(/\r?\n/).find(value => /Assertion failed:/i.test(value));
      const assertionIdentifiers = assertion ? [...new Set(assertion.split(/,\s*file\b/i)[0].replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, '').match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || [])].slice(0, 20) : [];
      console.log(`  diagnostic ${label}: ${JSON.stringify({ status: realChild.status, signal: realChild.signal, stderrClass, phases, assertionIdentifiers,
        errorCode: realChild.error?.code || null, stdoutBytes: Buffer.byteLength(realChild.stdout || ''),
        stderrBytes: Buffer.byteLength(realChild.stderr || ''), proof: proof || null })}`);
      return { realChild, proof };
    };
    const baselineEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:path|fixer_test_forged_env)$/i.test(key)));
    baselineEnv.PATH = '';
    const baseline = childProof(baselineEnv, 'native-child-baseline');
    const { realChild, proof } = childProof(forgedEnv, 'native-child-forged-root');
    check(baseline.realChild.status === 0 && baseline.proof?.stage === 'complete' && baseline.proof.reportAvailable &&
      baseline.proof.markerMatches && baseline.proof.systemDirMatches && baseline.proof.exitCode === 0,
      'actual Windows Node child baseline executes the shared tool transport');
    check(realChild.status === 0 && proof?.stage === 'complete' && proof.reportAvailable && proof.root.toLowerCase() === windowsTools.resolveSystemRoot().toLowerCase() &&
      proof.exe.toLowerCase() === exe.toLowerCase() && !proof.exe.toLowerCase().startsWith(fakeRoot.toLowerCase()),
      'actual Windows Node child ignores forged roots and real fake executable folders');
    check(proof.exitCode === 0 && proof.markerMatches && proof.systemDirMatches,
      'real PowerShell and embedded native command run with forged roots and empty PATH');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
} else {
  console.log('  not-run real Windows transport: Windows PowerShell requires Windows');
}

console.log(`windows-tools-smoke: ${checks} checks passed`);
