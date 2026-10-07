'use strict';

// Exercise the actual packaged driver's gate with controlled runtime facts.
// The Windows acceptance run separately proves these facts in real Electron.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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
function mainProductionFunction(name) {
  const asyncStart = mainSource.indexOf(`async function ${name}(`);
  const fnStart = asyncStart >= 0 ? asyncStart : mainSource.indexOf(`function ${name}(`);
  assert.notEqual(fnStart, -1, `production main function ${name} exists`);
  const fnEnd = mainSource.indexOf('\n}\n', fnStart);
  assert.notEqual(fnEnd, -1, `production main function ${name} closes`);
  return mainSource.slice(fnStart, fnEnd + 2);
}
function mainTemplateConstant(name) {
  const marker = `const ${name} = `;
  const start = mainSource.indexOf(marker);
  assert.notEqual(start, -1, `production main template ${name} exists`);
  const expressionStart = start + marker.length;
  const contentStart = mainSource.indexOf(String.fromCharCode(96), expressionStart);
  assert.notEqual(contentStart, -1, `production main template ${name} starts`);
  const end = mainSource.indexOf(String.fromCharCode(96) + ';', contentStart + 1);
  assert.notEqual(end, -1, `production main template ${name} closes`);
  return vm.runInNewContext(mainSource.slice(expressionStart, end + 1));
}
const profileIdentityHelper = mainTemplateConstant('PS_PROFILE_PATH_IDENTITY_HELPER');
const profileRecoveryHelper = mainTemplateConstant('PS_PROFILE_RECOVERY_HELPER');
const profileInventoryGuard = mainTemplateConstant('PS_PROFILE_INVENTORY_GUARD');
const removeProfileHelper = mainTemplateConstant('PS_REMOVE_PROFILE_HELPER');
const exactSidDisableHelper = mainTemplateConstant('PS_EXACT_SID_LOCAL_USER_DISABLE_HELPER');
const exactSidProcessStopHelper = mainTemplateConstant('PS_EXACT_SID_PROCESS_STOP_HELPER');
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
  const launchDiagnosticContract = {};
  vm.createContext(launchDiagnosticContract);
  vm.runInContext([
    mainProductionFunction('normalizeLaunchExceptionClass'),
    mainProductionFunction('normalizeLaunchInteger'),
    mainProductionFunction('parseLaunchPhaseMarkers'),
    mainProductionFunction('formatLaunchDiagnostics'),
    'this.formatLaunchDiagnostics = formatLaunchDiagnostics;'
  ].join('\n'), launchDiagnosticContract);
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
  const credentialRaw = 'FIXER_LAUNCH_PHASE_V1 phase=credential outcome=failure ' +
    'exceptionClass=System.Management.Automation.MethodInvocationException hresult=-2146233087 nativeCode=1326';
  const credentialDiagnostics = Array.from(launchDiagnosticContract.formatLaunchDiagnostics({
    code: 1, stdout: credentialRaw + '\n', timedOut: false
  }));
  assert.deepEqual(credentialDiagnostics, [
    'Launch diagnostic: phase=credential outcome=failure exceptionClass=System.Management.Automation.MethodInvocationException ' +
      'hresult=-2146233087 nativeCode=1326 exitCode=1 timeout=false markerPresent=true'
  ], 'forced credential-construction failure preserves only its allowlisted class and numeric codes');
  const preLaunchDiagnostics = Array.from(launchDiagnosticContract.formatLaunchDiagnostics({
    code: -1, stdout: '', timedOut: false,
    exceptionClass: 'System.ComponentModel.Win32Exception', nativeCode: 5
  }));
  assert.deepEqual(preLaunchDiagnostics, [
    'Launch diagnostic: phase=pre_launch outcome=failure exceptionClass=System.ComponentModel.Win32Exception ' +
      'hresult=none nativeCode=5 exitCode=-1 timeout=false markerPresent=false'
  ], 'forced pre-launch failure is explicit even when PowerShell emitted no marker');
  const malformedDiagnostics = Array.from(launchDiagnosticContract.formatLaunchDiagnostics({
    code: 1, timedOut: false,
    stdout: credentialRaw + ` exceptionMessage=${secretMarker}\n`
  }));
  assert.ok(!JSON.stringify(malformedDiagnostics).includes(secretMarker) &&
    malformedDiagnostics[0].includes('phase=pre_launch') && malformedDiagnostics[0].includes('markerPresent=false'),
  'a marker with any extra field is rejected without copying the field value');
  checks++;

  const launchTrace = acceptanceContract.selectFixLaunchTrace([
    { line: credentialDiagnostics[0], kind: 'err' },
    { line: preLaunchDiagnostics[0], kind: 'err' },
    { line: `Launch diagnostic: phase=credential outcome=failure exceptionClass=Error hresult=none nativeCode=none exitCode=1 timeout=false markerPresent=true message=${secretMarker}`, kind: 'err' },
    { line: `PowerShell launcher reported: Launch failed: ${secretMarker}`, kind: 'err' },
    { line: `raw stdout ${secretMarker}`, kind: 'out' },
    { line: "[5/8] Launching Zoom as 'user1'...", kind: 'header' }
  ]);
  assert.deepEqual(Array.from(launchTrace), [credentialDiagnostics[0], preLaunchDiagnostics[0]],
    'diagnostic receipt keeps only exact allowlisted launch markers');
  const allowedFields = ['phase', 'outcome', 'exceptionClass', 'hresult', 'nativeCode', 'exitCode', 'timeout', 'markerPresent'];
  for (const line of launchTrace) {
    const keys = line.slice('Launch diagnostic: '.length).split(' ').map(field => field.split('=')[0]);
    assert.deepEqual(Array.from(keys), allowedFields, 'receipt marker has exactly the approved fields');
  }
  assert.ok(!JSON.stringify(launchTrace).includes(secretMarker) &&
    !JSON.stringify(launchTrace).includes('username') && !JSON.stringify(launchTrace).includes('stdout'),
  'secret, account and raw-stream fields are excluded');
  assert.equal(acceptanceContract.acceptanceExitCode([{ status: 'failed', launchTrace }], true), 1,
    'capturing safe diagnostics never turns an error into success');
  checks++;

  const launchScriptStart = mainSource.indexOf('const launchPs = `');
  const launchScriptEnd = mainSource.indexOf('\n  `;', launchScriptStart);
  const launchScript = mainSource.slice(launchScriptStart, launchScriptEnd);
  const secureStringCtor = launchScript.indexOf('$pw = [System.Security.SecureString]::new()');
  const appendCharacter = launchScript.indexOf('$pw.AppendChar($fixerPasswordChar)');
  const clearCharacters = launchScript.indexOf('[Array]::Clear($fixerPasswordChars, 0, $fixerPasswordChars.Length)');
  const makeReadOnly = launchScript.indexOf('$pw.MakeReadOnly()');
  const localUser = launchScript.indexOf("$fixerLocalUser = [System.Environment]::MachineName + '\\\\${FIX_USER}'");
  const credentialCtor = launchScript.indexOf('$cred = [System.Management.Automation.PSCredential]::new($fixerLocalUser, $pw)');
  const credentialSuccess = launchScript.indexOf('phase=credential outcome=success');
  const startProcessPhase = launchScript.indexOf("$fixerLaunchPhase = 'start_process'");
  const startProcess = launchScript.indexOf('Start-Process -FilePath');
  assert.ok(launchScriptStart >= 0 && launchScriptEnd > launchScriptStart &&
    launchScript.indexOf('try {') < secureStringCtor &&
    secureStringCtor < appendCharacter && appendCharacter < clearCharacters &&
    clearCharacters < makeReadOnly && makeReadOnly < localUser && localUser < credentialCtor &&
    credentialCtor < credentialSuccess && credentialSuccess < startProcessPhase &&
    startProcessPhase < startProcess && launchScript.includes('-Credential $cred -EA Stop') &&
    !launchScript.includes('ConvertTo-SecureString') && !launchScript.includes('New-Object') &&
    launchScript.includes("$ErrorActionPreference = 'Stop'") &&
    launchScript.includes("$fixerFailurePhase = 'pre_launch'") &&
    launchScript.includes("$fixerFailurePhase = [string]$fixerLaunchPhase") &&
    !launchScript.includes('Exception.Message') && !launchScript.includes('StackTrace'),
  'typed read-only credential construction reaches Start-Process and failures stay in the closed phase marker');
  assert.ok(mainSource.includes('const launchDiagnostics = formatLaunchDiagnostics(launch);') &&
    source.includes("const launchLine = /^Launch diagnostic: phase=") &&
    source.includes('window.__fixerAcceptanceFixLog.length < 32'),
  'main and the bounded receipt capture use the closed launch-diagnostic path');
  checks++;

  const accountIdentitySource = mainProductionFunction('readLocalAccountIdentity');
  const resolveSidSource = mainProductionFunction('resolveSID');
  async function resolveSid(payload, staleSid = '') {
    const context = {
      runPSCapture: async script => {
        context.script = script;
        return { code: 0, timedOut: false, stdout: JSON.stringify(payload) };
      }
    };
    vm.createContext(context);
    vm.runInContext(accountIdentitySource + '\n' + resolveSidSource +
      '\nthis.resolveSID = resolveSID;', context);
    return { sid: await context.resolveSID('user1', staleSid), script: context.script };
  }
  async function readAccountIdentity(payload, overrides = {}) {
    const context = {
      runPSCapture: async () => ({
        code: 0,
        timedOut: false,
        stdout: JSON.stringify(payload),
        ...overrides
      })
    };
    vm.createContext(context);
    vm.runInContext(accountIdentitySource +
      '\nthis.readLocalAccountIdentity = readLocalAccountIdentity;', context);
    return context.readLocalAccountIdentity('user1');
  }
  const oldSid = 'S-1-5-21-100-200-300-1000';
  const newSid = 'S-1-5-21-100-200-300-1001';
  const exactAccount = { name: 'user1', domain: 'LOCALPC', localAccount: true, sid: newSid };
  const domainAccount = { name: 'user1', domain: 'CONTOSO', localAccount: false, sid: 'S-1-5-21-9-8-7-1001' };
  const exact = await resolveSid({ machine: 'LOCALPC', accounts: [domainAccount, exactAccount] });
  assert.equal(exact.sid, newSid, 'exact local-machine SID wins over a domain account with the same name');
  assert.equal((await resolveSid({ machine: 'LOCALPC', accounts: [domainAccount] })).sid, '',
    'domain same-name account is never accepted as the local helper');
  assert.equal((await resolveSid({ machine: 'LOCALPC', accounts: [] })).sid, '',
    'missing local helper SID fails closed');
  assert.equal((await resolveSid({ machine: 'LOCALPC', accounts: [exactAccount, { ...exactAccount }] })).sid, '',
    'ambiguous local helper SID fails closed');
  assert.equal((await resolveSid({ machine: 'LOCALPC', accounts: [{ ...exactAccount, sid: oldSid }] }, oldSid)).sid, '',
    'stale SID from the deleted account generation fails closed');
  const absentIdentity = await readAccountIdentity({ machine: 'LOCALPC', accounts: [domainAccount] });
  const invalidIdentity = await readAccountIdentity({
    machine: 'LOCALPC', accounts: [{ ...exactAccount, sid: 'malformed' }]
  });
  const uncertainIdentity = await readAccountIdentity({ machine: 'LOCALPC', accounts: [] }, { code: 1 });
  assert.ok(absentIdentity.verified && !absentIdentity.exists && !absentIdentity.sid &&
    !invalidIdentity.verified && !invalidIdentity.exists &&
    !uncertainIdentity.verified && !uncertainIdentity.exists,
  'post-delete identity distinguishes proved absence from malformed or failed inventory');
  assert.ok(exact.script.includes('Get-CimInstance Win32_UserAccount') &&
    exact.script.includes('[System.Environment]::MachineName'),
  'SID receipt comes from the local account inventory and machine identity');
  const exactDeleteContext = {};
  vm.createContext(exactDeleteContext);
  vm.runInContext([
    mainProductionFunction('exactSidLocalUserDeleteScript'),
    mainProductionFunction('exactSidLocalUserDeleteProved'),
    mainProductionFunction('exactSidLocalUserDisableScript'),
    mainProductionFunction('exactSidLocalUserDisableProved'),
    mainProductionFunction('exactSidFinalDrainScript'),
    'this.exactSidLocalUserDeleteScript = exactSidLocalUserDeleteScript;',
    'this.exactSidLocalUserDeleteProved = exactSidLocalUserDeleteProved;',
    'this.exactSidLocalUserDisableScript = exactSidLocalUserDisableScript;',
    'this.exactSidLocalUserDisableProved = exactSidLocalUserDisableProved;',
    'this.exactSidFinalDrainScript = exactSidFinalDrainScript;'
  ].join('\n'), Object.assign(exactDeleteContext, {
    PS_EXACT_SID_LOCAL_USER_DISABLE_HELPER: exactSidDisableHelper
  }));
  const exactDeleteScript = exactDeleteContext.exactSidLocalUserDeleteScript(oldSid, 'user1');
  const exactDeleteReceipt = JSON.stringify({
    marker: 'FIXER_LOCAL_USER_DELETE_V1', pre: 'exact', deletion: 'success',
    expectedSidPost: 'absent', namePost: 'absent'
  });
  assert.ok(exactDeleteScript.includes("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.LocalAccounts'") &&
    exactDeleteScript.includes('Import-Module -Name $trustedManifest -Force -PassThru') &&
    exactDeleteScript.includes("$removeLocalUser = $exactModules[0].ExportedCommands['Remove-LocalUser']") &&
    exactDeleteScript.includes('& $removeLocalUser -SID $expectedSid') &&
    !exactDeleteScript.includes('Remove-LocalUser -Name') &&
    !exactDeleteScript.includes('net user') &&
    exactDeleteContext.exactSidLocalUserDeleteProved({ code: 0, timedOut: false, stdout: exactDeleteReceipt }) &&
    !exactDeleteContext.exactSidLocalUserDeleteProved({ code: 0, timedOut: false, stdout: exactDeleteReceipt + '\nnoise' }) &&
    !exactDeleteContext.exactSidLocalUserDeleteProved({ code: 1, timedOut: false, stdout: exactDeleteReceipt }),
  'local-account deletion requires one strict exact-SID success receipt and has no name mutation fallback');
  const exactDisableScript = exactDeleteContext.exactSidLocalUserDisableScript(oldSid, 'user1');
  const exactDisableReceipt = JSON.stringify({
    marker: 'FIXER_LOCAL_USER_DISABLE_V1', pre: 'exact', disable: 'success',
    expectedSidPost: 'disabled', namePost: 'expected'
  });
  assert.ok(exactDisableScript.includes("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.LocalAccounts'") &&
    exactDisableScript.includes("$disableLocalUser = $exactModules[0].ExportedCommands['Disable-LocalUser']") &&
    exactDisableScript.includes('& $disableLocalUser -SID $expectedSidObject') &&
    !exactDisableScript.includes('Disable-LocalUser -Name') &&
    exactDeleteContext.exactSidLocalUserDisableProved({ code: 0, timedOut: false, stdout: exactDisableReceipt }) &&
    !exactDeleteContext.exactSidLocalUserDisableProved({ code: 0, timedOut: false, stdout: exactDisableReceipt + '\nnoise' }) &&
    !exactDeleteContext.exactSidLocalUserDisableProved({ code: 1, timedOut: false, stdout: exactDisableReceipt }),
  'local-account disable requires one strict exact-SID receipt and has no name mutation fallback');
  const verifyAdminSource = mainProductionFunction('verifyAdminMembership');
  async function verifyAdmin(stdout, code = 0, timedOut = false) {
    const context = { runPSCapture: async () => ({ stdout, code, timedOut }) };
    vm.createContext(context);
    vm.runInContext(verifyAdminSource + '\nthis.verifyAdminMembership = verifyAdminMembership;', context);
    return context.verifyAdminMembership(newSid);
  }
  const exactAdmin = await verifyAdmin(`METHOD=Get-LocalGroupMember\nRESULT=YES\nSID=${newSid}`);
  const exactStandard = await verifyAdmin(`METHOD=Get-LocalGroupMember\nRESULT=NO\nSID=${newSid}`);
  const unknownAdmin = await verifyAdmin(`METHOD=failed\nRESULT=UNKNOWN\nSID=${newSid}`, 1);
  assert.ok(exactAdmin.verified && exactAdmin.inGroup &&
    exactStandard.verified && !exactStandard.inGroup &&
    !unknownAdmin.verified && !unknownAdmin.inGroup &&
    !verifyAdminSource.includes('NTAccount') && !verifyAdminSource.includes('$m.Name') &&
    !verifyAdminSource.includes('net localgroup'),
  'administrator membership accepts only an exact SID result and fails closed on unknown identity');
  checks++;

  const profilePolicyContext = { path: path.win32 };
  vm.createContext(profilePolicyContext);
  vm.runInContext(
    mainProductionFunction('selectSidBoundProfileEntries') +
      '\nthis.selectSidBoundProfileEntries = selectSidBoundProfileEntries;',
    profilePolicyContext
  );
  const profileIdentity = value => {
    let hash = 0;
    for (const char of String(value).toLowerCase()) hash = ((hash * 33) + char.charCodeAt(0)) >>> 0;
    return '0000000000000001:' + hash.toString(16).toUpperCase().padStart(32, '0');
  };
  const profileEntry = (keyName, profileImagePath = '', hasNtUserDat = true, readable = true,
    pathExists = profileImagePath !== '', isReparsePoint = false,
    resolvedPath = profileImagePath,
    stableIdentity = pathExists ? profileIdentity(resolvedPath) : '',
    profileImagePathPresent = true) =>
    ({ keyName, profileImagePath, profileImagePathPresent, hasNtUserDat, readable, pathExists, isReparsePoint,
      resolvedPath, stableIdentity });
  const domainSid = 'S-1-5-21-900-800-700-1001';
  const staleSid = 'S-1-5-21-400-500-600-1001';
  const canonicalProfile = 'C:\\Users\\user1';
  const backupProfile = 'C:\\Users\\user1.OLDPC';
  const domainProfile = 'C:\\Users\\user1.CONTOSO';
  const selectProfiles = (entries, sid, purpose) =>
    profilePolicyContext.selectSidBoundProfileEntries(entries, sid, purpose);

  const noPriorSid = selectProfiles([
    profileEntry(domainSid, canonicalProfile),
    profileEntry(staleSid, backupProfile)
  ], '', 'cleanup');
  assert.ok(noPriorSid.ok && noPriorSid.keys.length === 0 && noPriorSid.paths.length === 0,
    'without a trusted prior SID, name-only canonical and suffixed folders are never cleanup targets');
  const noMatchingKey = selectProfiles([], oldSid, 'cleanup');
  assert.ok(noMatchingKey.ok && noMatchingKey.keys.length === 0,
    'a name-only folder without an exact SID key is never deleted');
  for (const [name, entries] of [
    ['blank live target', [profileEntry(oldSid, '')]],
    ['missing live target property', [profileEntry(oldSid, '', true, true, false, false, '', '', false)]],
    ['valid live plus blank backup', [profileEntry(oldSid, canonicalProfile), profileEntry(`${oldSid}.bak`, '')]],
    ['blank live plus valid backup', [profileEntry(oldSid, ''), profileEntry(`${oldSid}.bak`, backupProfile)]]
  ]) {
    assert.equal(selectProfiles(entries, oldSid, 'cleanup').ok, false,
      `${name} ProfileImagePath fails closed`);
  }
  const missingPresenceMetadata = profileEntry(oldSid, canonicalProfile);
  delete missingPresenceMetadata.profileImagePathPresent;
  assert.equal(selectProfiles([missingPresenceMetadata], oldSid, 'cleanup').reason, 'invalid_inventory_shape',
    'missing ProfileImagePath presence metadata fails closed');
  assert.equal(selectProfiles([
    profileEntry(oldSid, canonicalProfile),
    profileEntry(domainSid, '', false, true, false, false, '', '', false)
  ], oldSid, 'cleanup').ok, true,
  'a blank unrelated record is preserved while a valid exact-SID target remains selectable');
  const exactCleanup = selectProfiles([
    profileEntry(oldSid, canonicalProfile),
    profileEntry(`${oldSid}.bak`, backupProfile),
    profileEntry(domainSid, domainProfile),
    profileEntry(staleSid, 'C:\\Users\\stale-helper')
  ], oldSid, 'cleanup');
  assert.ok(exactCleanup.ok);
  assert.deepEqual(Array.from(exactCleanup.keys).sort(), [oldSid, `${oldSid}.bak`].sort(),
    'cleanup selects only the exact old SID and its .bak key');
  assert.deepEqual(Array.from(exactCleanup.paths).sort(), [canonicalProfile, backupProfile].sort(),
    'cleanup selects only folders resolved from those exact SID keys');
  assert.ok(!Array.from(exactCleanup.keys).includes(domainSid) && !Array.from(exactCleanup.keys).includes(staleSid),
    'same-name domain and stale unrelated SID entries remain preserved');
  const sharedDomainPath = selectProfiles([
    profileEntry(oldSid, canonicalProfile),
    profileEntry(domainSid, canonicalProfile)
  ], oldSid, 'cleanup');
  assert.equal(sharedDomainPath.ok, false,
    'a path also referenced by a same-name domain SID blocks cleanup instead of deleting either profile');
  assert.equal(selectProfiles([
    profileEntry(oldSid, canonicalProfile),
    profileEntry(domainSid, domainProfile, true, true, true, false,
      domainProfile, profileIdentity(canonicalProfile))
  ], oldSid, 'cleanup').ok, false,
  'a different same-name domain path with the target file identity blocks cleanup');
  assert.equal(selectProfiles([
    profileEntry(oldSid, canonicalProfile),
    profileEntry(domainSid, domainProfile, true, true, true, true,
      canonicalProfile, profileIdentity(canonicalProfile))
  ], oldSid, 'cleanup').ok, false,
  'a same-name domain junction is unsafe even when its final target is known');
  assert.equal(selectProfiles([
    profileEntry(oldSid, canonicalProfile),
    profileEntry(domainSid, '\\\\?\\C:\\Users\\user1', true, true, true, false,
      canonicalProfile, profileIdentity(canonicalProfile))
  ], oldSid, 'cleanup').ok, false,
  'a device-namespace alias cannot enter the ProfileList inventory');
  for (const [field, value] of [
    ['keyName', 42],
    ['profileImagePath', 42],
    ['resolvedPath', 42],
    ['stableIdentity', 42],
    ['pathExists', 'false'],
    ['isReparsePoint', 'false'],
    ['hasNtUserDat', 'false'],
    ['readable', 'true'],
    ['profileImagePathPresent', 'true']
  ]) {
    const malformed = profileEntry(oldSid, canonicalProfile);
    malformed[field] = value;
    assert.equal(selectProfiles([malformed], oldSid, 'cleanup').ok, false,
      `non-typed ${field} inventory metadata fails closed`);
  }
  assert.equal(selectProfiles([
    profileEntry(oldSid, canonicalProfile, true, true, true, true)
  ], oldSid, 'cleanup').ok, false, 'a top-level profile junction blocks cleanup');
  assert.equal(selectProfiles([
    profileEntry(oldSid, 'C:\\Users\\Public')
  ], oldSid, 'cleanup').ok, false, 'a protected shared profile root blocks cleanup');
  const absentFolderPlan = selectProfiles([
    profileEntry(oldSid, 'C:\\Users\\user1.DOMAIN', false, true, false, false)
  ], oldSid, 'cleanup');
  assert.ok(absentFolderPlan.ok && absentFolderPlan.entries.length === 1 &&
    absentFolderPlan.entries[0].pathExists === false,
  'cleanup preserves the observed missing-folder state instead of treating a later name match as owned');
  checks++;

  const exactResolved = selectProfiles([profileEntry(newSid, canonicalProfile)], newSid, 'resolve');
  assert.ok(exactResolved.ok && exactResolved.entry.profileImagePath === canonicalProfile,
    'the exact live helper SID with its local profile and hive resolves');
  for (const [name, entries] of [
    ['unrelated stale SID only', [profileEntry(staleSid, canonicalProfile)]],
    ['bak only', [profileEntry(`${newSid}.bak`, canonicalProfile)]],
    ['live plus bak', [profileEntry(newSid, canonicalProfile), profileEntry(`${newSid}.bak`, backupProfile)]],
    ['duplicate live key', [profileEntry(newSid, canonicalProfile), profileEntry(newSid, canonicalProfile)]],
    ['missing path', [profileEntry(newSid, '')]],
    ['missing NTUSER.DAT', [profileEntry(newSid, canonicalProfile, false)]],
    ['unreadable inventory', [profileEntry(newSid, canonicalProfile, true, false)]],
    ['profile root junction', [profileEntry(newSid, canonicalProfile, true, true, true, true)]],
    ['path shared by unrelated SID', [profileEntry(newSid, canonicalProfile), profileEntry(domainSid, canonicalProfile)]]
  ]) {
    assert.equal(selectProfiles(entries, newSid, 'resolve').ok, false, name);
  }
  for (const unsafePath of [
    'D:\\Users\\user1',
    'C:\\Users\\user1\\nested',
    'C:\\Users\\other\\..\\user1',
    '\\\\server\\profiles\\user1',
    '\\\\?\\C:\\Users\\user1',
    'C:/Users/user1',
    'C:\\Users\\user1.',
    ' C:\\Users\\user1',
    'C:\\Users\\Public',
    'C:\\Users\\Default',
    'C:\\Users\\Default User',
    'C:\\Users\\CON',
    'C:\\Users\\LPT1.data'
  ]) {
    assert.equal(selectProfiles([profileEntry(newSid, unsafePath)], newSid, 'resolve').ok, false,
      `unsafe profile path is rejected: ${unsafePath}`);
  }
  checks++;

  const resolveProfileSource = mainProductionFunction('resolveUserProfilePath');
  async function resolveProfile(payload, { code = 0, timedOut = false, stdout } = {}) {
    const context = { path: path.win32, PS_PROFILE_PATH_IDENTITY_HELPER: profileIdentityHelper,
      PS_PROFILE_RECOVERY_HELPER: profileRecoveryHelper,
      capturedScript: '', runPSCapture: async script => {
      context.capturedScript = script;
      return {
        code,
        timedOut,
        stdout: stdout === undefined ? JSON.stringify(payload) : stdout
      };
    } };
    vm.createContext(context);
    vm.runInContext([
      mainProductionFunction('selectSidBoundProfileEntries'),
      resolveProfileSource,
      'this.resolveUserProfilePath = resolveUserProfilePath;'
    ].join('\n'), context);
    const result = await context.resolveUserProfilePath('user1', 1, () => {}, newSid);
    return { result, script: context.capturedScript };
  }
  const exactProfileReceipt = {
    marker: 'FIXER_PROFILELIST_V1', sid: newSid,
    entries: [profileEntry(newSid, canonicalProfile)]
  };
  const resolvedProfile = await resolveProfile(exactProfileReceipt);
  assert.equal(resolvedProfile.result.path, canonicalProfile);
  assert.equal(resolvedProfile.result.source, 'registry');
  assert.equal(resolvedProfile.result.sid, newSid);
  assert.ok(resolvedProfile.script.includes('$liveKey = Join-Path $base $sid') &&
    resolvedProfile.script.includes("$bakKey = $liveKey + '.bak'") &&
    resolvedProfile.script.includes('Get-ChildItem -LiteralPath $base -EA Stop') &&
    resolvedProfile.script.includes('Get-FixerProfilePathIdentity -Path $candidate') &&
    resolvedProfile.script.includes("Join-Path $candidateIdentity.resolvedPath 'NTUSER.DAT'") &&
    !resolvedProfile.script.includes("Join-Path $candidate 'NTUSER.DAT'") &&
    !resolveProfileSource.includes('NTAccount') &&
    !resolveProfileSource.includes('folder-suffixed') &&
    !resolveProfileSource.includes("Get-ChildItem 'C:\\\\Users'"),
  'profile resolution inventories only ProfileList and has no account-name or folder fallback');
  assert.equal((await resolveProfile({ ...exactProfileReceipt, entries: [] })).result.path, null,
    'a name-only folder cannot replace the exact helper SID key');
  assert.equal((await resolveProfile(exactProfileReceipt, { code: 1 })).result.path, null,
    'a nonzero ProfileList inventory fails closed');
  assert.equal((await resolveProfile(exactProfileReceipt, { timedOut: true })).result.path, null,
    'a timed-out ProfileList inventory fails closed');
  assert.equal((await resolveProfile(exactProfileReceipt, { stdout: '{bad-json' })).result.path, null,
    'a malformed ProfileList receipt fails closed');
  assert.equal((await resolveProfile(exactProfileReceipt, {
    stdout: `${JSON.stringify(exactProfileReceipt)}\n${JSON.stringify(exactProfileReceipt)}`
  })).result.path, null, 'multiple ProfileList receipts fail closed');
  const cleanupPlanIndex = mainSource.indexOf("profileCleanupPlan = selectSidBoundProfileEntries(entries, preDeleteSid, 'cleanup')");
  const accountDeleteIndex = mainSource.indexOf('exactSidLocalUserDeleteScript(preDeleteSid, FIX_USER)');
  const folderDeleteIndex = mainSource.indexOf('Remove-ProfileFolder -Path $quarantinePath -Sid $expectedSid');
  const recoveryReceiptIndex = mainSource.indexOf("New-ItemProperty -LiteralPath $folderKey.PSPath -Name 'FixerProfileQuarantineV1'");
  const disableExactSidIndex = mainSource.indexOf('exactSidLocalUserDisableScript(preDeleteSid, FIX_USER)');
  const finalDrainIndex = mainSource.indexOf('exactSidFinalDrainScript(preDeleteSid)', disableExactSidIndex);
  const quarantineRenameIndex = mainSource.indexOf('$actualQuarantinePath = $lease.Quarantine()');
  const deletingReceiptIndex = mainSource.indexOf("phase = 'deleting'", quarantineRenameIndex);
  const recoveryReceiptRemovalIndex = mainSource.indexOf("Remove-ItemProperty -LiteralPath $folderKey.PSPath -Name 'FixerProfileQuarantineV1'");
  const residueProofIndex = mainSource.indexOf("throw 'profile folder remains after cleanup'", folderDeleteIndex);
  const keyDeleteIndex = mainSource.indexOf('Remove-Item -LiteralPath $key.PSPath', residueProofIndex);
  assert.ok(!mainSource.includes('const sourceProfile = `C:\\\\Users\\\\${FIX_USER}`') &&
    !mainSource.includes('$matchByPath') &&
    !mainSource.includes("Get-ChildItem 'C:\\\\Users' -Directory") &&
    mainSource.includes("selectSidBoundProfileEntries(entries, preDeleteSid, 'cleanup')") &&
    cleanupPlanIndex >= 0 && cleanupPlanIndex < accountDeleteIndex &&
    folderDeleteIndex >= 0 && folderDeleteIndex < residueProofIndex &&
    recoveryReceiptIndex >= 0 && recoveryReceiptIndex < quarantineRenameIndex &&
    disableExactSidIndex >= 0 && disableExactSidIndex < finalDrainIndex &&
    finalDrainIndex < quarantineRenameIndex &&
    quarantineRenameIndex < folderDeleteIndex && folderDeleteIndex < recoveryReceiptRemovalIndex &&
    quarantineRenameIndex < deletingReceiptIndex && deletingReceiptIndex < folderDeleteIndex &&
    residueProofIndex < keyDeleteIndex && keyDeleteIndex < accountDeleteIndex &&
    mainSource.includes('GetFileInformationByHandleEx') &&
    mainSource.includes('AcquireQuarantineLease') &&
    mainSource.includes('SetFileInformationByHandle') &&
    mainSource.includes('$actualQuarantinePath = $lease.Quarantine()') &&
    mainSource.includes('$Lease.DeleteEmpty()') &&
    mainSource.includes("$disableLocalUser = $exactModules[0].ExportedCommands['Disable-LocalUser']") &&
    mainSource.includes('& $disableLocalUser -SID $expectedSidObject') &&
    exactSidProcessStopHelper.includes('$heldProcess.SafeHandle') &&
    exactSidProcessStopHelper.includes('$refreshed[0].CreationDate') &&
    exactSidProcessStopHelper.includes('$heldProcess.Kill()') &&
    !exactSidProcessStopHelper.includes('Stop-Process -Id') &&
    !mainProductionFunction('exactSidFinalDrainScript').includes('Stop-Process') &&
    !mainSource.includes('Stop-Process -Id') &&
    mainSource.includes('[System.Security.AccessControl.AccessControlSections]::Owner') &&
    mainSource.includes("$owner.Value -cne 'S-1-5-32-544'") &&
    mainSource.includes('FILE_FLAG_OPEN_REPARSE_POINT') &&
    mainSource.includes('profile identity is shared by an unrelated SID') &&
    mainSource.includes('Assert-FixerProfilePathIdentity -Path $profilePath') &&
    mainSource.includes('$plannedPaths = @($Plan | Where-Object { [bool]$_.pathExists }') &&
    mainSource.includes("throw 'previously absent profile folder appeared after validation'") &&
    mainSource.includes("throw 'previously present profile folder disappeared after validation'") &&
    mainSource.includes('if ($expected.Count -ne 1 -or -not [bool]$expected[0].profileImagePathPresent -or') &&
    mainSource.indexOf("throw 'exact-SID ProfileImagePath is missing or blank'") <
      mainSource.indexOf('$targets.Add($key)') &&
    !mainSource.includes("runProcess('net.exe', ['user', FIX_USER, '/delete']") &&
    !mainSource.includes('if (profileCleanupPlan.entries.length > 0)'),
  'cleanup keeps the account/SID until stable-identity folder and ProfileList absence are proved');
  checks++;

  const launchZoomHelperSource = mainProductionFunction('launchZoomHelper');
  async function launchZoomProbe(probeResult) {
    let spawns = 0;
    let probeScript = '';
    const context = {
      fs: { existsSync: () => true },
      FIX_USER: 'user1',
      LAUNCHER_SCRIPT_PATH: () => 'C:\\ProgramData\\1132 Fixer\\launch.ps1',
      CRED_BLOB_PATH: () => 'C:\\ProgramData\\1132 Fixer\\helper.bin',
      resolveSID: async () => newSid,
      runPSCapture: async script => { probeScript = script; return probeResult; },
      spawnWindowsTool: () => { spawns++; return { unref() {} }; }
    };
    vm.createContext(context);
    vm.runInContext(launchZoomHelperSource + '\nthis.launchZoomHelper = launchZoomHelper;', context);
    return { result: await context.launchZoomHelper(), spawns, probeScript };
  }
  const yesProbe = await launchZoomProbe({ code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=YES\n' });
  assert.ok(yesProbe.result.success && yesProbe.result.alreadyRunning && yesProbe.spawns === 0,
    'the exact helper SID YES receipt suppresses a duplicate launcher');
  const noProbe = await launchZoomProbe({ code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=NO\n' });
  assert.ok(noProbe.result.success && noProbe.spawns === 1,
    'one exact successful NO receipt starts one launcher');
  const domainOnlyProbe = await launchZoomProbe({ code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=NO' });
  assert.equal(domainOnlyProbe.spawns, 1,
    'a successful scan containing only a different domain SID does not impersonate the helper SID');
  for (const [name, probeResult] of [
    ['owner lookup failure', { code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=UNKNOWN' }],
    ['enumeration failure', { code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=UNKNOWN\n' }],
    ['timeout', { code: 0, timedOut: true, stdout: 'FIXER_ZOOM_DEDUP_V1=NO' }],
    ['nonzero exit', { code: 1, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=NO' }],
    ['missing marker', { code: 0, timedOut: false, stdout: '' }],
    ['malformed marker', { code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=MAYBE' }],
    ['multiple markers', { code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=YES\nFIXER_ZOOM_DEDUP_V1=NO' }],
    ['duplicate markers', { code: 0, timedOut: false, stdout: 'FIXER_ZOOM_DEDUP_V1=NO\nFIXER_ZOOM_DEDUP_V1=NO' }],
    ['extra output', { code: 0, timedOut: false, stdout: 'noise\nFIXER_ZOOM_DEDUP_V1=NO' }]
  ]) {
    const blocked = await launchZoomProbe(probeResult);
    assert.equal(blocked.result.success, false, name);
    assert.equal(blocked.spawns, 0, `${name} cannot start the launcher`);
  }
  assert.ok(yesProbe.probeScript.includes("Get-CimInstance Win32_Process -Filter \"Name='Zoom.exe'\" -EA Stop") &&
    yesProbe.probeScript.includes('Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -EA Stop') &&
    (yesProbe.probeScript.match(/catch \{ \$unknown = \$true \}/g) || []).length === 2 &&
    yesProbe.probeScript.includes('if (-not $o -or $o.ReturnValue -ne 0 -or -not $o.Sid) { $unknown = $true; continue }') &&
    yesProbe.probeScript.includes('if ([string]$o.Sid -ieq $sid) { $hit = $true }') &&
    !/MethodName GetOwner(?!Sid)/.test(yesProbe.probeScript) &&
    !/\.User\b|\.Domain\b|user1/i.test(yesProbe.probeScript),
  'the real probe maps both enumeration and owner uncertainty to UNKNOWN and uses no same-name owner fallback');

  if (process.platform === 'win32') {
    const productPowerShell = process.platform === 'win32'
      ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : '';
    assert.ok(productPowerShell && fs.existsSync(productPowerShell),
      'the native fixtures use the same trusted Windows PowerShell transport as production');
    const executeProductPowerShell = (script, options = {}) => spawnSync(
      productPowerShell,
      windowsTools.PS_STDIN_ARGS,
      {
        input: windowsTools.prepareScript(script),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15000,
        ...options
      });
    const executeOwnerFixture = setup => {
      const child = executeProductPowerShell(`${setup}\n${yesProbe.probeScript}`);
      assert.equal(child.status, 0, String(child.stderr || 'PowerShell fixture failed'));
      return String(child.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    };
    const enumerationFailure = executeOwnerFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName,[string]$Filter) throw 'fixture enumeration failure' }
      function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName) throw 'must not run' }
    `);
    const ownerFailure = executeOwnerFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName,[string]$Filter) [pscustomobject]@{ ProcessId = 10 } }
      function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName) throw 'fixture owner failure' }
    `);
    const domainOwner = executeOwnerFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName,[string]$Filter) [pscustomobject]@{ ProcessId = 11 } }
      function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName) [pscustomobject]@{ ReturnValue = 0; Sid = '${domainSid}' } }
    `);
    const exactOwner = executeOwnerFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName,[string]$Filter) [pscustomobject]@{ ProcessId = 12 } }
      function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName) [pscustomobject]@{ ReturnValue = 0; Sid = '${newSid}' } }
    `);
    assert.deepEqual(enumerationFailure, ['FIXER_ZOOM_DEDUP_V1=UNKNOWN'],
      'a real PowerShell enumeration failure emits one UNKNOWN marker');
    assert.deepEqual(ownerFailure, ['FIXER_ZOOM_DEDUP_V1=UNKNOWN'],
      'a real PowerShell owner lookup failure emits one UNKNOWN marker');
    assert.deepEqual(domainOwner, ['FIXER_ZOOM_DEDUP_V1=NO'],
      'a real PowerShell different/domain SID emits one NO marker');
    assert.deepEqual(exactOwner, ['FIXER_ZOOM_DEDUP_V1=YES'],
      'a real PowerShell exact helper SID emits one YES marker');

    const executeFinalDrainFixture = setup => executeProductPowerShell(
      `${setup}\n${exactDeleteContext.exactSidFinalDrainScript(oldSid)}`);
    const finalDrainClear = executeFinalDrainFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName) return @() }
      function Invoke-CimMethod { throw 'must not run' }
    `);
    assert.equal(finalDrainClear.status, 0, String(finalDrainClear.stderr || 'final-drain clear fixture failed'));
    assert.deepEqual(String(finalDrainClear.stdout || '').trim().split(/\r?\n/),
      ['FIXER_HELPER_FINAL_DRAIN_V1=CLEAR'],
      'the evaluated production final drain emits one exact CLEAR marker');
    const finalDrainUnknown = executeFinalDrainFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName) throw 'fixture inventory failure' }
      function Invoke-CimMethod { throw 'must not run' }
    `);
    assert.equal(finalDrainUnknown.status, 1, 'an uncertain final owner inventory fails closed');
    assert.deepEqual(String(finalDrainUnknown.stdout || '').trim().split(/\r?\n/),
      ['FIXER_HELPER_FINAL_DRAIN_V1=UNKNOWN'],
      'the evaluated production final drain emits one exact UNKNOWN marker');
    const finalDrainDomain = executeFinalDrainFixture(`
      function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)][string]$ClassName) [pscustomobject]@{ ProcessId = 41 } }
      function Invoke-CimMethod { [CmdletBinding()] param([object]$InputObject,[string]$MethodName) [pscustomobject]@{ ReturnValue = 0; Sid = '${domainSid}' } }
    `);
    assert.equal(finalDrainDomain.status, 0, 'a same-name domain SID is not the disabled local helper');
    assert.deepEqual(String(finalDrainDomain.stdout || '').trim().split(/\r?\n/),
      ['FIXER_HELPER_FINAL_DRAIN_V1=CLEAR'],
      'the evaluated production final drain compares only the exact helper SID');

    const processCustodyFixture = executeProductPowerShell(`
      ${exactSidProcessStopHelper}
      $trustedPowerShell = Resolve-FixerTool 'powershell.exe'
      $currentSid = [string][System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $exactChild = $null
      $wrongOwnerChild = $null
      try {
        $exactChild = Start-Process -FilePath $trustedPowerShell -ArgumentList @(
          '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
        $exactCandidate = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $exactChild.Id) -EA Stop)
        if ($exactCandidate.Count -ne 1) { throw 'exact fixture process inventory failed' }
        $exactOutcome = Stop-FixerOwnedProcessBySid -Candidate $exactCandidate[0] -ExpectedSid $currentSid

        $wrongOwnerChild = Start-Process -FilePath $trustedPowerShell -ArgumentList @(
          '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60') -PassThru -WindowStyle Hidden
        $wrongCandidate = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $wrongOwnerChild.Id) -EA Stop)
        if ($wrongCandidate.Count -ne 1) { throw 'wrong-owner fixture process inventory failed' }
        $wrongOwnerBlocked = $false
        try {
          $null = Stop-FixerOwnedProcessBySid -Candidate $wrongCandidate[0] -ExpectedSid '${domainSid}'
        } catch { $wrongOwnerBlocked = $true }
        $wrongOwnerChild.Refresh()
        [pscustomobject]@{
          exactOutcome = $exactOutcome
          exactExited = [bool]$exactChild.HasExited
          wrongOwnerBlocked = $wrongOwnerBlocked
          wrongOwnerSurvived = -not [bool]$wrongOwnerChild.HasExited
        } | ConvertTo-Json -Compress
      } finally {
        foreach ($fixtureChild in @($exactChild,$wrongOwnerChild)) {
          if ($null -ne $fixtureChild) {
            try { $fixtureChild.Refresh(); if (-not $fixtureChild.HasExited) { $fixtureChild.Kill(); $null = $fixtureChild.WaitForExit(2000) } } catch {}
            $fixtureChild.Dispose()
          }
        }
      }
    `, { timeout: 30000 });
    assert.equal(processCustodyFixture.status, 0,
      String(processCustodyFixture.stderr || 'retained-process-handle fixture failed'));
    assert.deepEqual(JSON.parse(String(processCustodyFixture.stdout || '').trim()), {
      exactOutcome: 'TERMINATED', exactExited: true,
      wrongOwnerBlocked: true, wrongOwnerSurvived: true
    }, 'retained Process custody kills only the refreshed exact SID and preserves a different-SID process');

    const trustedModuleProbe = executeProductPowerShell(
      exactDeleteContext.exactSidLocalUserDeleteScript(oldSid, '__fixer_fixture_absent__'));
    const trustedModuleReceipt = JSON.parse(String(trustedModuleProbe.stdout || '').trim());
    assert.equal(trustedModuleReceipt.pre, 'mismatch',
      'the production transport loads the LocalAccounts commands from the trusted OS module tree');

    const fakeLocalAccountsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fixer-localaccounts-'));
    try {
      const fakeLocalAccountsVersion = path.join(fakeLocalAccountsRoot, '1.0.0.0');
      fs.mkdirSync(fakeLocalAccountsVersion);
      fs.writeFileSync(path.join(fakeLocalAccountsVersion, 'Microsoft.PowerShell.LocalAccounts.psm1'), `
        $script:oldSidText = '${oldSid}'
        $script:newSidText = '${newSid}'
        $script:users = @([pscustomobject]@{
          Name = 'user1'
          SID = [System.Security.Principal.SecurityIdentifier]::new($script:oldSidText)
          Enabled = [bool]($env:FIXER_TEST_ACCOUNT_DISABLED -ne '1')
        })
        function Get-LocalUser {
          [CmdletBinding()]
          param()
          return @($script:users)
        }
        function Remove-LocalUser {
          [CmdletBinding(SupportsShouldProcess=$true)]
          param([Parameter(Mandatory=$true)][System.Security.Principal.SecurityIdentifier[]]$SID)
          $requested = [string]$SID[0].Value
          if ($requested -ine $script:oldSidText) { throw 'fixture received a non-target SID' }
          $script:users = @([pscustomobject]@{
            Name = 'user1'
            SID = [System.Security.Principal.SecurityIdentifier]::new($script:newSidText)
          })
          throw 'fixture old SID no longer exists'
        }
        function Disable-LocalUser {
          [CmdletBinding(SupportsShouldProcess=$true)]
          param([Parameter(Mandatory=$true)][System.Security.Principal.SecurityIdentifier[]]$SID)
          if ($SID.Count -ne 1 -or [string]$SID[0].Value -ine $script:oldSidText) {
            throw 'fixture received a non-target account'
          }
          $script:users[0].Enabled = $false
        }
        Export-ModuleMember -Function Get-LocalUser,Remove-LocalUser,Disable-LocalUser
      `, 'utf8');
      fs.writeFileSync(path.join(fakeLocalAccountsVersion, 'Microsoft.PowerShell.LocalAccounts.psd1'), `@{
        RootModule = 'Microsoft.PowerShell.LocalAccounts.psm1'
        ModuleVersion = '1.0.0'
        GUID = '8aa1a81d-fd55-4ed2-934c-179b9a42c09d'
        FunctionsToExport = @('Get-LocalUser','Remove-LocalUser','Disable-LocalUser')
        CmdletsToExport = @()
        VariablesToExport = @()
        AliasesToExport = @()
      }`, 'utf8');
      const raceDeleteScript = exactDeleteContext.exactSidLocalUserDeleteScript(
        oldSid, 'user1', fakeLocalAccountsRoot);
      const sidDisableScript = exactDeleteContext.exactSidLocalUserDisableScript(
        oldSid, 'user1', fakeLocalAccountsRoot);
      const sidDisable = executeProductPowerShell(sidDisableScript);
      assert.equal(sidDisable.status, 0, String(sidDisable.stderr || 'exact-SID disable fixture failed'));
      assert.equal(exactDeleteContext.exactSidLocalUserDisableProved({
        code: sidDisable.status,
        timedOut: false,
        stdout: String(sidDisable.stdout || '')
      }), true, 'the production helper disables and reads back only the exact local SID through trusted commands');
      const sidDisableRetry = executeProductPowerShell(sidDisableScript, {
        env: { ...process.env, FIXER_TEST_ACCOUNT_DISABLED: '1' }
      });
      assert.equal(exactDeleteContext.exactSidLocalUserDisableProved({
        code: sidDisableRetry.status,
        timedOut: false,
        stdout: String(sidDisableRetry.stdout || '')
      }), true, 'an already-disabled exact SID is a proved idempotent retry');
      const sidDeleteRace = executeProductPowerShell(raceDeleteScript);
      assert.equal(sidDeleteRace.status, 1, 'a same-name replacement makes exact-SID deletion fail closed');
      assert.deepEqual(JSON.parse(String(sidDeleteRace.stdout || '').trim()), {
        marker: 'FIXER_LOCAL_USER_DELETE_V1',
        pre: 'exact',
        deletion: 'failed',
        expectedSidPost: 'absent',
        namePost: 'replacement'
      }, 'the production deletion script preserves and reports the replacement SID without selecting it by name');
    } finally {
      fs.rmSync(fakeLocalAccountsRoot, { recursive: true, force: true });
    }

    const executeMalformedProfileTarget = (profileState, receiptState = 'absent') => {
      const itemExpression = profileState === 'missing'
        ? '[pscustomobject]@{}'
        : `[pscustomobject]@{ ProfileImagePath = '${profileState === 'safe' ? 'C:\\Users\\user1' : ''}' }`;
      const receiptSetup = receiptState === 'valid'
        ? `$fixtureReceipt = [ordered]@{
            marker = 'FIXER_PROFILE_QUARANTINE_V1'
            phase = 'moving'
            originalPath = 'C:\\Users\\user1'
            quarantinePath = 'C:\\Users\\.1132-fixer-quarantine-00112233445566778899aabbccddeeff'
            stableIdentity = '0000000000000001:00112233445566778899AABBCCDDEEFF'
          } | ConvertTo-Json -Compress`
        : (receiptState === 'blank' ? "$fixtureReceipt = '   '" : '');
      const receiptAdd = receiptState === 'absent'
        ? ''
        : '$item | Add-Member -NotePropertyName FixerProfileQuarantineV1 -NotePropertyValue $fixtureReceipt';
      const child = executeProductPowerShell(`
          $ErrorActionPreference = 'Stop'
          ${profileRecoveryHelper}
          ${profileInventoryGuard}
          ${receiptSetup}
          $script:identityCalls = 0
          function Get-ChildItem {
            [CmdletBinding()] param([string]$LiteralPath)
            [pscustomobject]@{ PSChildName = '${oldSid}'; PSPath = 'fixture-key' }
          }
          function Get-ItemProperty {
            [CmdletBinding()] param([string]$LiteralPath)
            $item = ${itemExpression}
            ${receiptAdd}
            $item
          }
          function Get-FixerProfilePathIdentity { param([string]$Path) $script:identityCalls++; throw 'must not inspect malformed target' }
          function Assert-FixerProfilePathIdentity { param() throw 'must not inspect malformed target' }
          $plan = @([pscustomobject]@{
            keyName = '${oldSid}'
            profileImagePath = 'C:\\Users\\user1'
            profileImagePathPresent = $true
            pathExists = $true
            stableIdentity = '0000000000000001:00112233445566778899AABBCCDDEEFF'
            resolvedPath = 'C:\\Users\\user1'
          })
          $blocked = $false
          $reason = ''
          try { $null = Assert-FixerProfileInventory -Plan $plan -ExpectedSid '${oldSid}' -Base 'fixture-base' }
          catch { $blocked = $true; $reason = [string]$_.Exception.Message }
          [pscustomobject]@{ blocked = $blocked; identityCalls = $script:identityCalls; reason = $reason } | ConvertTo-Json -Compress
        `);
      assert.equal(child.status, 0, String(child.stderr || 'PowerShell malformed-profile fixture failed'));
      return JSON.parse(String(child.stdout || '').trim());
    };
    assert.deepEqual(executeMalformedProfileTarget('blank'), {
      blocked: true, identityCalls: 0, reason: 'exact-SID ProfileImagePath is missing or blank'
    },
      'the production mutation guard rejects a blank exact-SID ProfileImagePath before any identity or mutation call');
    assert.deepEqual(executeMalformedProfileTarget('missing'), {
      blocked: true, identityCalls: 0, reason: 'exact-SID ProfileImagePath is missing or blank'
    },
      'the production mutation guard rejects a missing exact-SID ProfileImagePath before any identity or mutation call');
    for (const profileState of ['blank', 'missing']) {
      assert.deepEqual(executeMalformedProfileTarget(profileState, 'valid'), {
        blocked: true, identityCalls: 0, reason: 'profile quarantine receipt has no exact-SID path authority'
      }, `a recovery receipt cannot authorize a ${profileState} exact-SID ProfileImagePath`);
    }
    assert.deepEqual(executeMalformedProfileTarget('safe', 'blank'), {
      blocked: true, identityCalls: 0, reason: 'profile quarantine receipt is malformed'
    }, 'a present blank quarantine receipt fails closed before identity or mutation');

    const identityFixture = executeProductPowerShell(`
        $ErrorActionPreference = 'Stop'
        ${profileIdentityHelper}
        ${profileRecoveryHelper}
        $root = Join-Path ([IO.Path]::GetTempPath()) ('fixer-profile-identity-' + [Guid]::NewGuid().ToString('N'))
        $target = Join-Path $root 'user1'
        $moved = Join-Path $root 'user1-original'
        $junction = Join-Path $root 'user1.CONTOSO'
        $vanishing = Join-Path $root 'vanishing-profile'
        $vanished = Join-Path $root 'vanished-profile'
        $bound = Join-Path $root 'bound-profile'
        $unrelated = Join-Path $root 'unrelated'
        try {
          $null = New-Item -ItemType Directory -Path $target -Force
          [IO.File]::WriteAllText((Join-Path $target 'old-sentinel.txt'), 'old')
          $first = Get-FixerProfilePathIdentity -Path $target

          $null = New-Item -ItemType Junction -Path $junction -Target $target
          $junctionRejected = $false
          try { $null = Get-FixerProfilePathIdentity -Path $junction } catch { $junctionRejected = $true }
          [IO.Directory]::Delete($junction, $false)

          $device = [string]([char]92) + [char]92 + '?' + [char]92 + $target
          $deviceRejected = $false
          try { $null = Get-FixerProfilePathIdentity -Path $device } catch { $deviceRejected = $true }

          Move-Item -LiteralPath $target -Destination $moved -EA Stop
          $null = New-Item -ItemType Directory -Path $target -Force
          [IO.File]::WriteAllText((Join-Path $target 'new-sentinel.txt'), 'new')
          $replacement = Get-FixerProfilePathIdentity -Path $target
          $driftBlocked = $false
          try {
            $null = Assert-FixerProfilePathIdentity -Path $target -ExpectedExists $true -ExpectedIdentity $first.stableIdentity -ExpectedResolvedPath $first.resolvedPath
          } catch { $driftBlocked = $true }

          $null = New-Item -ItemType Directory -Path $vanishing -Force
          $vanishingIdentity = Get-FixerProfilePathIdentity -Path $vanishing
          Move-Item -LiteralPath $vanishing -Destination $vanished -EA Stop
          $missingIdentityBlocked = $false
          try {
            $null = Assert-FixerProfilePathIdentity -Path $vanishing -ExpectedExists $true -ExpectedIdentity $vanishingIdentity.stableIdentity -ExpectedResolvedPath $vanishingIdentity.resolvedPath
          } catch { $missingIdentityBlocked = $true }

          $null = New-Item -ItemType Directory -Path $bound -Force
          $null = New-Item -ItemType Directory -Path $unrelated -Force
          [IO.File]::WriteAllText((Join-Path $bound 'verified-sentinel.txt'), 'verified')
          [IO.File]::WriteAllText((Join-Path $unrelated 'unrelated-sentinel.txt'), 'unrelated')
          $boundIdentity = Get-FixerProfilePathIdentity -Path $bound
          $wrongIdentityBlocked = $false
          try {
            $badLease = [FixerProfileIdentityV1]::AcquireQuarantineLease($bound, $first.stableIdentity, $boundIdentity.resolvedPath)
            $badLease.Dispose()
          } catch { $wrongIdentityBlocked = $true }
          $lease = [FixerProfileIdentityV1]::AcquireQuarantineLease(
            $bound, $boundIdentity.stableIdentity, $boundIdentity.resolvedPath)
          $quarantinePath = ''
          try {
            $plannedQuarantinePath = [string]$lease.PlannedQuarantinePath
            $recoveryJson = [ordered]@{
              marker = 'FIXER_PROFILE_QUARANTINE_V1'
              phase = 'moving'
              originalPath = $bound
              quarantinePath = $plannedQuarantinePath
              stableIdentity = $boundIdentity.stableIdentity
            } | ConvertTo-Json -Compress
            $recoveryItem = [pscustomobject]@{
              ProfileImagePath = $bound
              FixerProfileQuarantineV1 = $recoveryJson
            }
            $preRenameRecovered = Resolve-FixerProfileInventoryPath -Item $recoveryItem -KeyName '${oldSid}' -ExpectedSid '${oldSid}'
            $quarantinePath = $lease.Quarantine()
            $null = New-Item -ItemType Directory -Path $bound -Force
            [IO.File]::WriteAllText((Join-Path $bound 'replacement-sentinel.txt'), 'replacement')
            $movedSentinelPresent = [IO.File]::Exists((Join-Path $quarantinePath 'verified-sentinel.txt'))
            $recoveredPath = Resolve-FixerProfileInventoryPath -Item $recoveryItem -KeyName '${oldSid}' -ExpectedSid '${oldSid}'
            $deletingJson = [ordered]@{
              marker = 'FIXER_PROFILE_QUARANTINE_V1'
              phase = 'deleting'
              originalPath = $bound
              quarantinePath = $plannedQuarantinePath
              stableIdentity = $boundIdentity.stableIdentity
            } | ConvertTo-Json -Compress
            $deletingItem = [pscustomobject]@{
              ProfileImagePath = $quarantinePath
              FixerProfileQuarantineV1 = $deletingJson
            }
            $deleteReadyRecovered = Resolve-FixerProfileInventoryPath -Item $deletingItem -KeyName '${oldSid}' -ExpectedSid '${oldSid}'
            Remove-Item -LiteralPath (Join-Path $quarantinePath 'verified-sentinel.txt') -Force -EA Stop
            $lease.DeleteEmpty()
            $deleteProved = [bool]$lease.DeleteProved
            $deleteCompleteRecovered = Resolve-FixerProfileInventoryPath -Item $deletingItem -KeyName '${oldSid}' -ExpectedSid '${oldSid}'

            $missingOriginal = Join-Path $root 'missing-original'
            $missingQuarantine = Join-Path $root '.1132-fixer-quarantine-ffeeddccbbaa99887766554433221100'
            $movingMissingJson = [ordered]@{
              marker = 'FIXER_PROFILE_QUARANTINE_V1'
              phase = 'moving'
              originalPath = $missingOriginal
              quarantinePath = $missingQuarantine
              stableIdentity = $boundIdentity.stableIdentity
            } | ConvertTo-Json -Compress
            $movingMissingBlocked = $false
            try {
              $null = Resolve-FixerProfileInventoryPath -Item ([pscustomobject]@{
                ProfileImagePath = $missingOriginal
                FixerProfileQuarantineV1 = $movingMissingJson
              }) -KeyName '${oldSid}' -ExpectedSid '${oldSid}'
            } catch { $movingMissingBlocked = $true }
            $null = New-Item -ItemType Directory -Path $quarantinePath -Force
            $wrongQuarantineBlocked = $false
            try {
              $null = Resolve-FixerProfileInventoryPath -Item $deletingItem -KeyName '${oldSid}' -ExpectedSid '${oldSid}'
            } catch { $wrongQuarantineBlocked = $true }
            [IO.Directory]::Delete($quarantinePath, $false)
          } finally {
            $lease.Dispose()
          }
          $boundReplacement = Get-FixerProfilePathIdentity -Path $bound

          [pscustomobject]@{
            exactPresent = [bool]$first.pathExists
            exactIdentity = [bool]($first.stableIdentity -match '^[0-9A-F]{16}:[0-9A-F]{32}$')
            junctionRejected = $junctionRejected
            deviceRejected = $deviceRejected
            driftBlocked = $driftBlocked
            missingIdentityBlocked = $missingIdentityBlocked
            identityChanged = [bool]($first.stableIdentity -cne $replacement.stableIdentity)
            oldSentinelPresent = [IO.File]::Exists((Join-Path $moved 'old-sentinel.txt'))
            newSentinelPresent = [IO.File]::Exists((Join-Path $target 'new-sentinel.txt'))
            wrongIdentityBlocked = $wrongIdentityBlocked
            handleDeleteProved = $deleteProved
            nonEmptyObjectMoved = $movedSentinelPresent
            plannedPathUsed = [bool]($plannedQuarantinePath -ieq $quarantinePath)
            receiptAuthenticatedBeforeRename = [bool]([string]$preRenameRecovered.profileImagePath -ieq $bound)
            receiptRecoveredMovedIdentity = [bool]([string]$recoveredPath.profileImagePath -ieq $quarantinePath)
            deleteReceiptRecoveredIdentity = [bool]([string]$deleteReadyRecovered.profileImagePath -ieq $quarantinePath -and
              -not [bool]$deleteReadyRecovered.recoveryCompleted)
            deleteReceiptRecoveredAbsence = [bool]([string]$deleteCompleteRecovered.profileImagePath -ieq $quarantinePath -and
              [bool]$deleteCompleteRecovered.recoveryCompleted)
            movingMissingBlocked = $movingMissingBlocked
            wrongQuarantineBlocked = $wrongQuarantineBlocked
            quarantineAbsent = -not [IO.Directory]::Exists($quarantinePath)
            replacementSurvived = [IO.File]::Exists((Join-Path $bound 'replacement-sentinel.txt'))
            replacementIdentityChanged = [bool]($boundReplacement.stableIdentity -cne $boundIdentity.stableIdentity)
            unrelatedSurvived = [IO.File]::Exists((Join-Path $unrelated 'unrelated-sentinel.txt'))
          } | ConvertTo-Json -Compress
        } finally {
          if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force -EA SilentlyContinue }
        }
      `, { timeout: 30000 });
    assert.equal(identityFixture.status, 0, String(identityFixture.stderr || 'PowerShell identity fixture failed'));
    const identityEvidence = JSON.parse(String(identityFixture.stdout || '').trim());
    assert.deepEqual(identityEvidence, {
      exactPresent: true,
      exactIdentity: true,
      junctionRejected: true,
      deviceRejected: true,
      driftBlocked: true,
      missingIdentityBlocked: true,
      identityChanged: true,
      oldSentinelPresent: true,
      newSentinelPresent: true,
      wrongIdentityBlocked: true,
      handleDeleteProved: true,
      nonEmptyObjectMoved: true,
      plannedPathUsed: true,
      receiptAuthenticatedBeforeRename: true,
      receiptRecoveredMovedIdentity: true,
      deleteReceiptRecoveredIdentity: true,
      deleteReceiptRecoveredAbsence: true,
      movingMissingBlocked: true,
      wrongQuarantineBlocked: true,
      quarantineAbsent: true,
      replacementSurvived: true,
      replacementIdentityChanged: true,
      unrelatedSurvived: true
    }, 'native handle custody quarantines and deletes only the verified object while replacement and unrelated trees survive');

    const cleanupFixture = executeProductPowerShell(`
        $ErrorActionPreference = 'Stop'
        ${profileIdentityHelper}
        ${removeProfileHelper}
        function Resolve-FixerTool {
          param([string]$Name)
          $candidate = Join-Path (Join-Path $env:SystemRoot 'System32') $Name
          if (-not [IO.File]::Exists($candidate)) { throw 'fixture tool missing' }
          return $candidate
        }
        $root = Join-Path ([IO.Path]::GetTempPath()) ('fixer-profile-cleanup-' + [Guid]::NewGuid().ToString('N'))
        $profile = Join-Path $root 'profile'
        $unrelated = Join-Path $root 'unrelated'
        try {
          $null = New-Item -ItemType Directory -Path $profile -Force
          $null = New-Item -ItemType Directory -Path $unrelated -Force
          $null = New-Item -ItemType Directory -Path (Join-Path $profile 'nested') -Force
          [IO.File]::WriteAllText((Join-Path $profile 'nested\\owned.txt'), 'owned')
          [IO.File]::WriteAllText((Join-Path $unrelated 'unrelated-sentinel.txt'), 'unrelated')
          $null = New-Item -ItemType Junction -Path (Join-Path $profile 'outside-link') -Target $unrelated
          $identity = Get-FixerProfilePathIdentity -Path $profile
          $lease = [FixerProfileIdentityV1]::AcquireQuarantineLease(
            $profile, $identity.stableIdentity, $identity.resolvedPath)
          try {
            Protect-FixerProfileQuarantineRoot -Path $profile
            $privatePath = $lease.Quarantine()
            $null = New-Item -ItemType Directory -Path $profile -Force
            [IO.File]::WriteAllText((Join-Path $profile 'replacement-sentinel.txt'), 'replacement')
            Remove-ProfileFolder -Path $privatePath -Sid '' -ExpectedIdentity $identity.stableIdentity -ExpectedResolvedPath $privatePath -Lease $lease
            $proved = [bool]$lease.DeleteProved
          } finally {
            $lease.Dispose()
          }
          [pscustomobject]@{
            proved = $proved
            quarantineAbsent = -not [IO.Directory]::Exists($privatePath)
            replacementSurvived = [IO.File]::Exists((Join-Path $profile 'replacement-sentinel.txt'))
            unrelatedSurvived = [IO.File]::Exists((Join-Path $unrelated 'unrelated-sentinel.txt'))
          } | ConvertTo-Json -Compress
        } finally {
          if ([IO.Directory]::Exists($root)) {
            try { [IO.Directory]::Delete($root, $true) } catch {
              $cleanupArgs = '/c rd /s /q "' + $root + '"'
              Start-Process -FilePath (Join-Path (Join-Path $env:SystemRoot 'System32') 'cmd.exe') -ArgumentList $cleanupArgs -Wait -WindowStyle Hidden | Out-Null
            }
          }
        }
      `, { timeout: 60000 });
    assert.equal(cleanupFixture.status, 0, String(cleanupFixture.stderr || 'PowerShell cleanup fixture failed'));
    const cleanupLines = String(cleanupFixture.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert.deepEqual(JSON.parse(cleanupLines[cleanupLines.length - 1]), {
      proved: true,
      quarantineAbsent: true,
      replacementSurvived: true,
      unrelatedSurvived: true
    }, 'the evaluated production cleanup deletes only the quarantined tree and preserves replacement and junction targets');
  } else {
    console.log('packaged-runtime-smoke: skip native Windows PowerShell fixtures (non-Windows host)');
  }
  checks++;

  const ownerSidCalls = (mainSource.match(/MethodName GetOwnerSid/g) || []).length;
  const sidAclGrants = (mainSource.match(/`\*\$\{helperSID\}:/g) || []).length;
  const preflightScanSource = mainSource.slice(mainSource.indexOf("ipcMain.handle('preflight-scan'"));
  assert.ok(ownerSidCalls >= 5 && !/MethodName GetOwner(?!Sid)/.test(mainSource) &&
    mainSource.includes("const helperSID = await resolveSID(FIX_USER, preDeleteSid)") &&
    mainSource.includes("$sid = '${helperSID}'") &&
    mainSource.includes('$liveKey = Join-Path $base $sid') &&
    mainSource.includes("if (-not $o -or $o.ReturnValue -ne 0 -or -not $o.Sid) { $unknown = $true; continue }") &&
    mainSource.includes("error: 'zoom_process_custody_unresolved'") &&
    mainSource.includes("verifyAdminMembership(preDeleteSid)") &&
    mainSource.includes("Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $matches[0]") &&
    !mainSource.includes("Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member '${FIX_USER}'") &&
    sidAclGrants === 3 &&
    preflightScanSource.includes("$out['user1_identity_verified']") &&
    preflightScanSource.includes("$out['user1_admin_verified']") &&
    !preflightScanSource.includes("NTAccount('${FIX_USER}')") &&
    !preflightScanSource.includes("$m.Name -ieq '${FIX_USER}'"),
  'helper drain, Zoom liveness, close, verification and helper launch use exact SID ownership');
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
