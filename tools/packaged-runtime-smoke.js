'use strict';

// Exercise the actual packaged driver's gate with controlled runtime facts.
// The Windows acceptance run separately proves these facts in real Electron.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
function mainProductionFunction(name) {
  const asyncStart = mainSource.indexOf(`async function ${name}(`);
  const fnStart = asyncStart >= 0 ? asyncStart : mainSource.indexOf(`function ${name}(`);
  assert.notEqual(fnStart, -1, `production main function ${name} exists`);
  const fnEnd = mainSource.indexOf('\n}\n', fnStart);
  assert.notEqual(fnEnd, -1, `production main function ${name} closes`);
  return mainSource.slice(fnStart, fnEnd + 2);
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

  const resolveSidSource = mainProductionFunction('resolveSID');
  async function resolveSid(payload, staleSid = '') {
    const context = {
      runPSCapture: async script => {
        context.script = script;
        return { code: 0, timedOut: false, stdout: JSON.stringify(payload) };
      }
    };
    vm.createContext(context);
    vm.runInContext(resolveSidSource + '\nthis.resolveSID = resolveSID;', context);
    return { sid: await context.resolveSID('user1', staleSid), script: context.script };
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
  assert.ok(exact.script.includes('Get-CimInstance Win32_UserAccount') &&
    exact.script.includes('[System.Environment]::MachineName'),
  'SID receipt comes from the local account inventory and machine identity');
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
  const profileEntry = (keyName, profileImagePath = '', hasNtUserDat = true, readable = true,
    pathExists = profileImagePath !== '', isReparsePoint = false) =>
    ({ keyName, profileImagePath, hasNtUserDat, readable, pathExists, isReparsePoint });
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
    const context = { path: path.win32, capturedScript: '', runPSCapture: async script => {
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
  const accountDeleteIndex = mainSource.indexOf("runProcess('net.exe', ['user', FIX_USER, '/delete']");
  const folderDeleteIndex = mainSource.indexOf('Remove-ProfileFolder -Path $profilePath -Sid $expectedSid');
  const residueProofIndex = mainSource.indexOf("throw 'profile folder remains after cleanup'", folderDeleteIndex);
  const keyDeleteIndex = mainSource.indexOf('Remove-Item -LiteralPath $key.PSPath', residueProofIndex);
  assert.ok(!mainSource.includes('const sourceProfile = `C:\\\\Users\\\\${FIX_USER}`') &&
    !mainSource.includes('$matchByPath') &&
    !mainSource.includes("Get-ChildItem 'C:\\\\Users' -Directory") &&
    mainSource.includes("selectSidBoundProfileEntries(entries, preDeleteSid, 'cleanup')") &&
    cleanupPlanIndex >= 0 && cleanupPlanIndex < accountDeleteIndex &&
    folderDeleteIndex >= 0 && folderDeleteIndex < residueProofIndex && residueProofIndex < keyDeleteIndex &&
    mainSource.includes("(($profileDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)") &&
    mainSource.includes('$plannedPaths = @($plan | Where-Object { [bool]$_.pathExists }') &&
    mainSource.includes("throw 'previously absent profile folder appeared after validation'") &&
    mainSource.includes("if ($expected.Count -ne 1 -or [string]$expected[0].profileImagePath -ine $profilePath)") &&
    !mainSource.includes('if (profileCleanupPlan.entries.length > 0)'),
  'cleanup revalidates even an empty plan and never deletes a folder that appeared after the protected snapshot');
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

  const pwshCandidates = process.platform === 'win32'
    ? ['pwsh.exe', 'pwsh']
    : ['pwsh', '/mnt/c/Program Files/PowerShell/7/pwsh.exe'];
  let pwsh = '';
  for (const candidate of pwshCandidates) {
    if (candidate.startsWith('/') && !fs.existsSync(candidate)) continue;
    const version = spawnSync(candidate,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!version.error && version.status === 0 && Number(String(version.stdout || '').trim()) >= 7) {
      pwsh = candidate;
      break;
    }
  }
  if (pwsh) {
    const executeOwnerFixture = setup => {
      const child = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        input: `${setup}\n${yesProbe.probeScript}`,
        encoding: 'utf8', windowsHide: true, timeout: 15000
      });
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
  } else {
    console.log('packaged-runtime-smoke: skip PowerShell 7 owner-probe fixtures (pwsh unavailable)');
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
