'use strict';

// Exercise the actual packaged driver's gate with controlled runtime facts.
// The Windows acceptance run separately proves these facts in real Electron.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const windowsTools = require('../src/main/windows-tools');
const source = fs.readFileSync(path.join(__dirname, 'packaged-acceptance.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function productionFunction(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const fnStart = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(fnStart, -1, `production function ${name} exists`);
  const fnEnd = source.indexOf('\n}\n', fnStart);
  assert.notEqual(fnEnd, -1, `production function ${name} closes`);
  return source.slice(fnStart, fnEnd + 2);
}
const start = source.indexOf('async function runtimeAuthority(');
const end = source.indexOf('\nasync function launch(', start);
assert.ok(start >= 0 && end > start, 'the production packaged runtime gate is present');
const root = 'C:\\Windows';
const archive = 'D:\\build\\resources\\app.asar';
const objects = ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `${root}\\System32\\${name}`);
const originalEnvironment = {
  SystemRoot: root,
  WINDIR: root,
  PATH: `${root}\\System32`,
  PROCESSOR_ARCHITEW6432: 'AMD64',
  ComSpec: `${root}\\System32\\cmd.exe`,
  FIXER_UNRELATED: 'preserve-me'
};
let checks = 0;

async function run(options = {}) {
  const records = [];
  const runtimeEnvironment = { ...originalEnvironment };
  const expectedForgedEnvironment = options.fakeRoot ? {
    SystemRoot: options.fakeRoot,
    WINDIR: options.fakeRoot,
    PATH: '',
    PROCESSOR_ARCHITEW6432: 'FORGED',
    ComSpec: path.win32.join(options.fakeRoot, 'System32', 'cmd.exe')
  } : null;
  let reports = 0;
  const report = { excludeEnv: false, excludeNetwork: false, getReport() {
    reports++;
    assert.equal(this.excludeEnv, true);
    assert.equal(this.excludeNetwork, true);
    if (expectedForgedEnvironment) {
      assert.deepEqual(runtimeEnvironment, { ...originalEnvironment, ...expectedForgedEnvironment });
    }
    if (options.reportThrows) throw new Error('PRIVATE_REPORT_ERROR');
    return { sharedObjects: options.objects || objects, environmentVariables: { PRIVATE: 'PRIVATE_REPORT_CONTENT' } };
  } };
  const tools = {
    ...windowsTools,
    resolveSystemRoot: () => options.cachedRoot || root,
    resolveTool: name => windowsTools.resolveTool(name, { getReport: () => ({ sharedObjects: objects }), arch: 'x64' })
  };
  let commands = 0;
  const runtime = {
    versions: { electron: options.electron || '44.2.0', node: '22.0.0' }, arch: 'x64',
    env: runtimeEnvironment,
    report: options.noReport ? undefined : report,
    getBuiltinModule: options.noBuiltin ? undefined : name => {
      if (name === 'path') return path.win32;
      if (name === 'module') return { createRequire: file => {
        assert.equal(file, path.win32.join(options.archive || archive, 'package.json'));
        return name => { assert.equal(name, './src/main/windows-tools.js'); return tools; };
      } };
      if (name === 'child_process') return { spawnSync: (exe, args, spawnOptions) => {
        commands++;
        assert.equal(exe, `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
        assert.deepEqual(args, windowsTools.PS_STDIN_ARGS);
        assert.equal(spawnOptions.timeout, 15000);
        assert.ok(spawnOptions.input.toString().includes("$fixerTestCmd = Resolve-FixerTool 'cmd.exe'"));
        assert.ok(spawnOptions.input.toString().includes('& $fixerTestCmd'));
        assert.ok(spawnOptions.input.toString().endsWith('$r | ConvertTo-Json -Compress'));
        if (options.fakeRoot) {
          assert.deepEqual(runtime.env, { ...originalEnvironment, ...expectedForgedEnvironment });
          assert.deepEqual(JSON.parse(spawnOptions.env.FIXER_TEST_FORGED_ENV), expectedForgedEnvironment);
          for (const [key, value] of Object.entries(originalEnvironment)) assert.equal(spawnOptions.env[key], value);
          assert.ok(spawnOptions.input.toString().includes('$env:ComSpec = [string]$fixerTestEnvironment.ComSpec'));
          assert.ok(spawnOptions.input.toString().includes('$env:ComSpec -eq [string]$fixerTestEnvironment.ComSpec'));
        }
        const reply = { systemDir: `${root}\\System32`, marker: 'FIXER_TRUSTED_RUNTIME',
          ...(options.fakeRoot ? { forgedEnvironment: true, nativePathTrusted: true } : {}) };
        return { status: options.exitCode ?? 0, stdout: options.stdout || JSON.stringify(reply),
          ...(options.spawnError ? { error: new Error('PRIVATE_PROCESS_ERROR') } : {}) };
      } };
      throw new Error('unexpected builtin');
    }
  };
  const context = {
    process: runtime, Buffer, path: path.win32, EXE: 'D:\\build\\1132 Fixer.exe',
    require: name => { assert.equal(name, 'electron/package.json'); return { version: '44.2.0' }; },
    passed: (id, detail, extra) => records.push({ id, status: 'passed', detail, ...extra }),
    failed: (id, detail, extra) => records.push({ id, status: 'failed', detail, ...extra })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\nthis.gate = runtimeAuthority;', context);
  const app = {
    evaluate: callback => callback({ app: { isPackaged: options.packaged !== false, getAppPath: () => options.archive || archive } }, options.fakeRoot || null)
  };
  const ok = await context.gate(app, 'fixture', options.fakeRoot);
  assert.equal(records.length, 1, 'each gate produces one authoritative result');
  assert.equal(report.excludeEnv, false);
  assert.equal(report.excludeNetwork, false);
  assert.deepEqual(runtime.env, originalEnvironment, 'the packaged main environment is restored exactly');
  assert.ok(!JSON.stringify(records).includes('PRIVATE_'), 'report and process errors cannot reach runtime evidence');
  return { ok, records, commands, reports };
}

(async () => {
  const acceptanceContract = {};
  vm.createContext(acceptanceContract);
  vm.runInContext([
    productionFunction('fixJourneySucceeded'),
    productionFunction('acceptanceExitCode'),
    productionFunction('selectFixLaunchTrace'),
    'this.fixJourneySucceeded = fixJourneySucceeded;',
    'this.acceptanceExitCode = acceptanceExitCode;',
    'this.selectFixLaunchTrace = selectFixLaunchTrace;'
  ].join('\n'), acceptanceContract);
  assert.equal(acceptanceContract.fixJourneySucceeded('success'), true);
  for (const state of ['error', 'notice', 'cancelled']) {
    assert.equal(acceptanceContract.fixJourneySucceeded(state), false, `${state} cannot satisfy the Fix now success assertion`);
  }
  checks++;
  assert.equal(acceptanceContract.acceptanceExitCode([{ status: 'not-run', mandatory: true }]), 1,
    'a mandatory not-run case makes packaged acceptance nonzero');
  assert.equal(acceptanceContract.acceptanceExitCode([{ status: 'not-run' }]), 0,
    'an explicitly optional not-run case stays report-only');
  assert.equal(acceptanceContract.acceptanceExitCode([{ status: 'failed' }]), 1,
    'a failed case makes packaged acceptance nonzero');
  assert.equal(acceptanceContract.acceptanceExitCode([], false), 1,
    'diagnostic mode is never eligible for a green release gate');
  checks++;
  assert.ok(source.includes("'fix.completes-successfully'") && source.includes('fixJourneySucceeded(done.state)'),
    'the terminal Fix now result uses the strict success predicate');
  assert.ok(/notRun\('fix\.journey',[\s\S]*?mandatory:\s*true/.test(source),
    'an unavailable mandatory Fix now journey is blocking');
  checks++;

  const detailsRecords = [];
  const detailsContext = {
    notRun: (id, detail, extra) => detailsRecords.push({ id, status: 'not-run', detail, ...(extra || {}) })
  };
  vm.createContext(detailsContext);
  vm.runInContext([
    productionFunction('runDetailsRoundTrip'),
    'this.runDetailsRoundTrip = runDetailsRoundTrip;'
  ].join('\n'), detailsContext);
  await detailsContext.runDetailsRoundTrip({ evaluate: async () => false }, 'required-ready', 'ready');
  assert.deepEqual(detailsRecords, [{
    id: 'required-ready.details-round-trip',
    status: 'not-run',
    detail: 'View details is not offered on "ready"',
    mandatory: true
  }], 'the real missing View details branch records a mandatory not-run');
  assert.equal(acceptanceContract.acceptanceExitCode(detailsRecords, true), 1,
    'the real missing View details branch makes acceptance nonzero');
  checks++;

  const skipRecords = [];
  const skipEvaluations = [
    undefined,
    { role: 'dialog', labelledBy: 'fixConfirmTitle', body: 'personal files will not be changed', inside: true, focused: 'fixConfirmContinue' },
    { hidden: true, focused: 'fixBtn' }
  ];
  const skipPage = {
    clicks: [],
    evaluate: async () => skipEvaluations.shift(),
    keyboard: { press: async () => {} },
    waitForSelector: async () => ({}),
    click: async selector => { skipPage.clicks.push(selector); }
  };
  const skipContext = {
    SKIP_FIX: true,
    stateOf: async () => 'ready',
    sleep: async () => {},
    shot: async () => 'diagnostic.png',
    passed: (id, detail, extra) => skipRecords.push({ id, status: 'passed', detail, ...(extra || {}) }),
    failed: (id, detail, extra) => skipRecords.push({ id, status: 'failed', detail, ...(extra || {}) }),
    notRun: (id, detail, extra) => skipRecords.push({ id, status: 'not-run', detail, ...(extra || {}) })
  };
  vm.createContext(skipContext);
  vm.runInContext([
    productionFunction('runFixJourney'),
    'this.runFixJourney = runFixJourney;'
  ].join('\n'), skipContext);
  await skipContext.runFixJourney(skipPage);
  const skippedFix = skipRecords.find(row => row.id === 'fix.run');
  assert.equal(skippedFix.status, 'not-run');
  assert.equal(skippedFix.mandatory, true);
  assert.equal(skippedFix.acceptanceResult, 'non-acceptance');
  assert.equal(skipPage.clicks.length, 0, 'diagnostic mode never enters the destructive continuation branch');
  assert.equal(acceptanceContract.acceptanceExitCode(skipRecords, false), 1,
    'the real --skip-fix branch cannot be consumed as green acceptance');
  checks++;

  const secretMarker = 'DO-NOT-RECORD-SECRET-1132';
  const launchTrace = acceptanceContract.selectFixLaunchTrace([
    { line: "[5/8] Launching Zoom as 'user1'...", kind: 'header' },
    { line: `net user user1 ${secretMarker} /add`, kind: 'out' },
    { line: '  Dispatching Zoom launch (detached) ...', kind: 'out' },
    { line: '  Launch result: code=0 timedOut=false error=none successMarker=true failureMarker=false', kind: 'out' },
    { line: '  Launch script exited with code 1; verifying via Win32_Process...', kind: 'err' },
    { line: "ERROR: Zoom.exe is not running as 'user1' after launch.", kind: 'err' },
    { line: '  PowerShell launcher reported: Launch failed: Access is denied.', kind: 'err' },
    { line: `unrelated ${secretMarker}`, kind: 'err' }
  ]);
  assert.deepEqual(Array.from(launchTrace), [
    "[5/8] Launching Zoom as 'user1'...",
    'Dispatching Zoom launch (detached) ...',
    'Launch result: code=0 timedOut=false error=none successMarker=true failureMarker=false',
    'Launch script exited with code 1; verifying via Win32_Process...',
    "ERROR: Zoom.exe is not running as 'user1' after launch.",
    'PowerShell launcher reported: Launch failed: Access is denied.'
  ], 'diagnostic receipt keeps only the allowlisted launch boundary and exact exception');
  assert.ok(!JSON.stringify(launchTrace).includes(secretMarker), 'unrelated secret-bearing output is excluded');
  assert.equal(acceptanceContract.acceptanceExitCode([{ status: 'failed', launchTrace }], true), 1,
    'capturing the launcher exception never turns an error into success');
  checks++;
  assert.ok(mainSource.includes('Launch result: code=${launchCode} timedOut=${launch.timedOut === true}') &&
    mainSource.includes('successMarker=${launchSuccessMarker} failureMarker=${!!launchFailLine}'),
  'main emits a structured launch outcome even when PowerShell has no exception line');
  assert.ok(source.includes("line.startsWith('Launch result: ')") &&
    source.includes('window.__fixerAcceptanceFixLog.length < 32'),
  'receipt capture keeps only a bounded set of launch evidence lines');
  checks++;
  assert.ok(source.includes("mode: ACCEPTANCE_MODE") && source.includes("acceptanceResult = report.releaseGateEligible"),
    'report declares full-acceptance versus diagnostic non-acceptance');
  checks++;

  const good = await run();
  assert.equal(good.ok, true);
  assert.equal(good.commands, 1);
  checks++;
  const forged = await run({ fakeRoot: 'E:\\Fake Windows' });
  assert.equal(forged.ok, true);
  assert.equal(forged.commands, 1);
  assert.equal(forged.reports, 1);
  assert.equal(forged.records[0].runtime.forgedEnvironmentApplied, true);
  assert.equal(forged.records[0].runtime.nativeEnvironmentApplied, true);
  assert.equal(forged.records[0].runtime.nativePathTrusted, true);
  assert.equal(forged.records[0].runtime.environmentRestored, true);
  checks++;
  for (const [name, options] of [
    ['report API unavailable', { noReport: true }],
    ['report collection throws', { reportThrows: true }],
    ['builtin API unavailable', { noBuiltin: true }],
    ['missing core DLL', { objects: objects.slice(0, 2) }],
    ['conflicting DLL root', { objects: [objects[0], objects[1], 'E:\\Fake\\System32\\kernelbase.dll'] }],
    ['cache differs from OS report', { cachedRoot: 'E:\\Fake' }],
    ['wrong packaged archive', { archive: 'E:\\other\\app.asar' }],
    ['unpackaged application', { packaged: false }],
    ['different Electron runtime', { electron: '43.0.0' }],
    ['nonzero trusted command', { exitCode: 7 }],
    ['spawn error despite successful status', { spawnError: true }],
    ['malformed command response', { stdout: 'not JSON' }],
    ['command reports different system directory', { stdout: JSON.stringify({ systemDir: 'E:\\Fake\\System32', marker: 'FIXER_TRUSTED_RUNTIME' }) }],
    ['embedded native command has no marker', { stdout: JSON.stringify({ systemDir: `${root}\\System32` }) }],
    ['tool resolves inside forged root', { fakeRoot: root }]
  ]) {
    const result = await run(options);
    assert.equal(result.ok, false, name);
    assert.equal(result.records[0].status, 'failed', name);
    if (name === 'tool resolves inside forged root') assert.equal(result.commands, 0, 'fake PowerShell is never executed');
    checks++;
  }
  console.log(`packaged-runtime-smoke: ${checks} authoritative runtime gate checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
