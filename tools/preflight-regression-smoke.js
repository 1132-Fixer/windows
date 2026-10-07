'use strict';

// Exercise the production preflight and its real repair entry guard. The
// PowerShell transport is mocked: these tests never modify Windows accounts,
// profiles, services, files or registry values, and run on every CI host.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const windowsTools = require('../src/main/windows-tools');
const messages = require('../messages');
const runVerdict = require('../run-verdict');

function functionSource(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `production function ${name} exists`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `production function ${name} closes`);
  return source.slice(start, end + 2);
}

function templateConstant(name) {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `production template ${name} exists`);
  const expressionStart = start + marker.length;
  const contentStart = source.indexOf(String.fromCharCode(96), expressionStart);
  assert.notEqual(contentStart, -1, `production template ${name} starts`);
  const end = source.indexOf(String.fromCharCode(96) + ';', contentStart + 1);
  assert.notEqual(end, -1, `production template ${name} closes`);
  return vm.runInNewContext(source.slice(expressionStart, end + 1));
}

function toolList(name) {
  const declaration = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`).exec(source);
  assert.ok(declaration, `production ${name} list exists`);
  return Array.from(vm.runInNewContext(declaration[1]));
}

const required = toolList('REQUIRED_TOOLS');
const optional = toolList('OPTIONAL_TOOLS');
const allTools = [...required, ...optional];
const preflightSource = functionSource('preflightCheck');
const fixSource = functionSource('runFixFlow');
const profileSelectorSource = functionSource('selectSidBoundProfileEntries');
const exactSidDeleteScriptSource = functionSource('exactSidLocalUserDeleteScript');
const exactSidDeleteReceiptSource = functionSource('exactSidLocalUserDeleteProved');
const exactSidDisableScriptSource = functionSource('exactSidLocalUserDisableScript');
const exactSidDisableReceiptSource = functionSource('exactSidLocalUserDisableProved');
const exactSidFinalDrainSource = functionSource('exactSidFinalDrainScript');
const profileIdentityHelper = templateConstant('PS_PROFILE_PATH_IDENTITY_HELPER');
const profileRecoveryHelper = templateConstant('PS_PROFILE_RECOVERY_HELPER');
const profileInventoryGuard = templateConstant('PS_PROFILE_INVENTORY_GUARD');
const removeProfileHelper = templateConstant('PS_REMOVE_PROFILE_HELPER');
const exactSidDisableHelper = templateConstant('PS_EXACT_SID_LOCAL_USER_DISABLE_HELPER');
const exactSidProcessStopHelper = templateConstant('PS_EXACT_SID_PROCESS_STOP_HELPER');

function inventory(overrides = {}) {
  return {
    ...Object.fromEntries(allTools.map(tool => [tool, true])),
    seclogon_status: 'Running',
    seclogon_starttype: 'Manual',
    ...overrides
  };
}

function probe(payload, overrides = {}) {
  return {
    code: 0,
    stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
    stderr: '',
    timedOut: false,
    ...overrides
  };
}

function harness(initialProbe, healProbe, overrides = {}) {
  const calls = [];
  const destructive = [];
  const logs = [];
  const context = {
    REQUIRED_TOOLS: required,
    OPTIONAL_TOOLS: optional,
    windowsTools,
    messages,
    runPSCapture: async script => {
      calls.push(script);
      if (calls.length === 1) return initialProbe;
      assert.ok(healProbe, 'no unexpected additional PowerShell probe');
      return healProbe;
    },
    isElevatedSync: async () => true,
    os: { userInfo: () => ({ username: 'Owner' }) },
    FIX_USER: 'user1',
    getFirstRunScriptPath: () => 'C:\\App\\zoom-firstrun-setup.ps1',
    fs: { existsSync: () => true },
    resolveZoomInstall: async () => ({ path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe' }),
    zoomInstall: null,
    zoomDetect: { zoomStatusMessage: () => 'Zoom is installed.' },
    profileSafety: { redactSecrets: line => line },
    runProcess: async (...args) => {
      destructive.push(args);
      throw new Error('Destructive repair crossed a failed preflight guard');
    },
    ...overrides
  };
  vm.createContext(context);
  vm.runInContext(`${preflightSource}\n${fixSource}`, context, { filename: 'main.js:preflight-regression' });
  return {
    context,
    calls,
    destructive,
    logs,
    preflight: () => context.preflightCheck(),
    repair: () => context.runFixFlow({ sender: { send: (_channel, data) => logs.push(data) } })
  };
}

const OLD_SID = 'S-1-5-21-100-200-300-1001';
const NEW_SID = 'S-1-5-21-100-200-300-1002';
const RACE_SID = 'S-1-5-21-100-200-300-1003';
const PROFILE_PATH = 'C:\\Users\\user1';
const PROFILE_IDENTITY = '0000000000000001:00112233445566778899AABBCCDDEEFF';

function repairHarness(options = {}) {
  const state = {
    accountSid: OLD_SID,
    profileFolderPresent: true,
    profileKeyPresent: true,
    cleanupAttempts: 0,
    disableAttempts: 0,
    finalDrainAttempts: 0,
    deleteAttempts: 0,
    createAttempts: 0,
    resolveCalls: 0,
    identityReads: 0,
    cleanupScript: '',
    order: [],
    accountEnabled: true
  };
  const logs = [];
  const cleanupResults = Array.from(options.cleanupResults || [probe('')]);
  const flushResult = options.flushResult || probe('PROFSVC_REFRESH=OK');
  const profileEntry = () => ({
    keyName: OLD_SID,
    profileImagePath: options.profilePathState === 'blank' || options.profilePathState === 'missing' ? '' : PROFILE_PATH,
    profileImagePathPresent: options.profilePathState !== 'missing',
    hasNtUserDat: options.profilePathState === 'blank' || options.profilePathState === 'missing'
      ? false : state.profileFolderPresent,
    readable: true,
    pathExists: options.profilePathState === 'blank' || options.profilePathState === 'missing'
      ? false : state.profileFolderPresent,
    isReparsePoint: false,
    resolvedPath: options.profilePathState === 'blank' || options.profilePathState === 'missing' ? '' : PROFILE_PATH,
    stableIdentity: options.profilePathState === 'blank' || options.profilePathState === 'missing'
      ? '' : (state.profileFolderPresent ? PROFILE_IDENTITY : '')
  });
  const context = {
    REQUIRED_TOOLS: required,
    OPTIONAL_TOOLS: optional,
    FIX_USER: 'user1',
    PS_PROFILE_PATH_IDENTITY_HELPER: profileIdentityHelper,
    PS_PROFILE_RECOVERY_HELPER: profileRecoveryHelper,
    PS_PROFILE_INVENTORY_GUARD: profileInventoryGuard,
    PS_REMOVE_PROFILE_HELPER: removeProfileHelper,
    PS_EXACT_SID_LOCAL_USER_DISABLE_HELPER: exactSidDisableHelper,
    PS_EXACT_SID_PROCESS_STOP_HELPER: exactSidProcessStopHelper,
    deletionOutcome: runVerdict.deletionOutcome,
    profsvcRefreshResult: runVerdict.profsvcRefreshResult,
    computeRunVerdict: runVerdict.computeRunVerdict,
    isElevatedSync: async () => true,
    preflightCheck: async () => ({
      ok: true,
      blockers: [],
      warnings: [],
      info: {
        tools: Object.fromEntries(allTools.map(tool => [tool, true])),
        zoomPath: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe',
        firstRunScript: 'C:\\App\\zoom-firstrun-setup.ps1',
        interactiveUser: 'Owner',
        seclogon: { status: 'Running', startType: 'Manual' }
      }
    }),
    fs: {
      existsSync: () => true,
      rmSync: () => {}
    },
    path,
    profileSafety: {
      redactSecrets: line => line,
      accountCreateScript: () => 'FIXTURE_CREATE_ACCOUNT'
    },
    helperCred: { generateHelperPassword: () => 'FixturePassword-12345' },
    CRED_BLOB_PATH: () => 'C:\\ProgramData\\1132 Fixer\\helper.bin',
    LAUNCHER_SCRIPT_PATH: () => 'C:\\ProgramData\\1132 Fixer\\launch.ps1',
    zoomInstall: { path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe', dir: 'C:\\Program Files\\Zoom\\bin' },
    resolveZoomInstall: async () => ({ path: 'C:\\Program Files\\Zoom\\bin\\Zoom.exe', dir: 'C:\\Program Files\\Zoom\\bin' }),
    zoomDetect: { zoomStatusMessage: () => 'Zoom is installed.' },
    userExists: async () => !!state.accountSid,
    resolveSID: async (_username, staleSid = '') => {
      state.resolveCalls++;
      if (options.sidRace && state.resolveCalls === 1) return RACE_SID;
      if (!state.accountSid) return '';
      if (staleSid && state.accountSid.toLowerCase() === String(staleSid).toLowerCase()) return '';
      return state.accountSid;
    },
    readLocalAccountIdentity: async () => {
      state.identityReads++;
      if (options.sidRace && state.identityReads === 2) state.accountSid = RACE_SID;
      if ((options.initialIdentityUnverified && state.identityReads === 1) ||
          (options.deleteReadbackUnverified && state.identityReads > 2)) {
        return { verified: false, exists: false, sid: '' };
      }
      return { verified: true, exists: !!state.accountSid, sid: state.accountSid || '' };
    },
    verifyAdminMembership: async () => ({ verified: true, inGroup: false, sid: state.accountSid }),
    runPSCapture: async script => {
      if (script.includes('FIXER_HELPER_INITIAL_DRAIN_V1=')) {
        return probe('FIXER_HELPER_INITIAL_DRAIN_V1=CLEAR');
      }
      if (script.includes('FIXER_HELPER_FINAL_DRAIN_V1=')) {
        state.finalDrainAttempts++;
        state.order.push('final-drain');
        return options.finalDrainResult || probe('FIXER_HELPER_FINAL_DRAIN_V1=CLEAR');
      }
      if (script.includes("marker = 'FIXER_PROFILELIST_V1'")) {
        return probe({
          marker: 'FIXER_PROFILELIST_V1',
          sid: OLD_SID,
          entries: state.profileKeyPresent ? [profileEntry()] : []
        });
      }
      if (script.includes("Name='Zoom.exe'")) return probe('NO');
      throw new Error('unexpected PowerShell capture in repair harness');
    },
    runPSScript: async script => {
      if (script.includes('FIXER_LOCAL_USER_DISABLE_V1')) {
        state.disableAttempts++;
        state.order.push('disable');
        if (options.disableFails) {
          return probe(JSON.stringify({
            marker: 'FIXER_LOCAL_USER_DISABLE_V1', pre: 'unknown', disable: 'not-run',
            expectedSidPost: 'unknown', namePost: 'unknown'
          }), { code: 1 });
        }
        state.accountEnabled = false;
        return probe(JSON.stringify({
          marker: 'FIXER_LOCAL_USER_DISABLE_V1', pre: 'exact', disable: 'success',
          expectedSidPost: 'disabled', namePost: 'expected'
        }));
      }
      if (script.includes('Assert-FixerProfileInventory')) {
        state.cleanupScript = script;
        state.cleanupAttempts++;
        const result = cleanupResults.shift();
        assert.ok(result, 'cleanup response exists');
        if (!result.timedOut && result.code === 0) {
          state.profileFolderPresent = false;
          state.profileKeyPresent = false;
          state.order.push('cleanup');
        } else if (options.partialCleanupFailure && state.cleanupAttempts === 1) {
          state.profileFolderPresent = false;
        }
        return result;
      }
      if (script.includes('PROFSVC_REFRESH=')) return flushResult;
      if (script.includes('FIXER_LOCAL_USER_DELETE_V1')) {
        state.deleteAttempts++;
        state.order.push('delete');
        assert.equal(state.profileFolderPresent, false, 'profile-folder cleanup finishes before account deletion');
        assert.equal(state.profileKeyPresent, false, 'ProfileList cleanup finishes before account deletion');
        assert.equal(state.accountSid, OLD_SID, 'only the validated old SID reaches deletion');
        if (options.deleteReplacementSid) {
          state.accountSid = options.deleteReplacementSid;
          return probe(JSON.stringify({
            marker: 'FIXER_LOCAL_USER_DELETE_V1', pre: 'exact', deletion: 'failed',
            expectedSidPost: 'absent', namePost: 'replacement'
          }), { code: 1 });
        }
        state.accountSid = '';
        return probe(JSON.stringify({
          marker: 'FIXER_LOCAL_USER_DELETE_V1', pre: 'exact', deletion: 'success',
          expectedSidPost: 'absent', namePost: 'absent'
        }));
      }
      if (script === 'FIXTURE_CREATE_ACCOUNT') {
        state.createAttempts++;
        state.order.push('create');
        assert.equal(state.profileFolderPresent, false, 'account creation cannot overlap a stranded old folder');
        assert.equal(state.profileKeyPresent, false, 'account creation cannot overlap a stranded old ProfileList key');
        assert.equal(state.accountSid, '', 'old local account is absent before recreation');
        if (options.createSucceeds) {
          state.accountSid = NEW_SID;
          return probe('');
        }
        return probe('', { code: 1 });
      }
      throw new Error('unexpected PowerShell mutation in repair harness');
    },
    runProcess: async () => { throw new Error('name-based account deletion must not run'); },
    runPSScriptLaunchCapture: async () => ({ code: 1, stdout: '', timedOut: false }),
    formatLaunchDiagnostics: () => [],
    console
  };
  vm.createContext(context);
  vm.runInContext(
    profileSelectorSource + '\n' + exactSidDeleteScriptSource + '\n' + exactSidDeleteReceiptSource + '\n' +
      exactSidDisableScriptSource + '\n' + exactSidDisableReceiptSource + '\n' +
      exactSidFinalDrainSource + '\n' + fixSource +
      '\nthis.selectSidBoundProfileEntries = selectSidBoundProfileEntries; this.runFixFlow = runFixFlow;',
    context,
    { filename: 'main.js:repair-regression' }
  );
  return {
    state,
    logs,
    repair: () => context.runFixFlow({ sender: { send: (_channel, data) => logs.push(data) } })
  };
}

let checks = 0;
function check(condition, name) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok  ${name}`);
}

async function invalidProbe(name, response, expectedCode) {
  const pre = await harness(response).preflight();
  check(!pre.ok, `${name}: preflight blocks`);
  check(pre.blockers.length === 1 && pre.blockers[0].code === expectedCode,
    `${name}: one accurate probe blocker`);
  check(!pre.blockers.some(blocker => blocker.code === 'missing_tool'),
    `${name}: no invented missing Windows tools`);
  check(allTools.every(tool => pre.info.tools[tool] === null),
    `${name}: tool presence stays unverified`);

  const run = harness(response);
  const result = await run.repair();
  check(result.success === false && result.error === 'preflight_failed',
    `${name}: actual repair stops at preflight`);
  check(run.destructive.length === 0, `${name}: no destructive child process starts`);
  check(!run.logs.some(entry => /^\[1\/8\]/.test(entry.line)),
    `${name}: account/profile repair stage never starts`);
}

async function main() {
  console.log('preflight-regression-smoke: actual production preflight transport failures');
  await invalidProbe('empty stdout', probe(''), 'tool_probe_failed');
  await invalidProbe('empty object', probe({}), 'tool_probe_failed');
  await invalidProbe('malformed JSON', probe('blocked PowerShell output'), 'tool_probe_failed');
  await invalidProbe('nonzero with complete JSON', probe(inventory(), { code: 1 }), 'tool_probe_failed');
  await invalidProbe('timeout with complete JSON', probe(inventory(), { timedOut: true }), 'tool_probe_timeout');
  await invalidProbe('timeout with empty stdout', probe('', { code: -1, timedOut: true }), 'tool_probe_timeout');
  await invalidProbe('launch error with empty stdout', probe('', { code: -1, stderr: 'spawn powershell.exe ENOENT' }), 'tool_probe_failed');
  const partial = inventory();
  delete partial[required[0]];
  await invalidProbe('incomplete tool inventory', probe(partial), 'tool_probe_failed');
  await invalidProbe('wrong boolean type', probe(inventory({ [required[0]]: 'true' })), 'tool_probe_failed');
  await invalidProbe('array payload', probe([]), 'tool_probe_failed');
  const noService = inventory();
  delete noService.seclogon_status;
  await invalidProbe('missing service inventory', probe(noService), 'tool_probe_failed');
  await invalidProbe('wrong service type', probe(inventory({ seclogon_starttype: true })), 'tool_probe_failed');

  console.log('preflight-regression-smoke: verified presence, absence and optional tools');
  {
    const run = harness(probe(inventory()));
    const pre = await run.preflight();
    check(pre.ok && pre.blockers.length === 0, 'complete healthy inventory permits repair');
    check(allTools.every(tool => pre.info.tools[tool] === true), 'healthy tool inventory preserved');
    check(run.calls.length === 1, 'running service needs no start attempt');
    check(run.calls[0].includes('Resolve-FixerTool') && run.calls[0].includes('Test-Path'),
      'actual inventory resolves Windows executables and checks files');
    check(!run.calls[0].includes('Get-Command'), 'tool presence does not depend on inherited PATH');
  }
  {
    const missingTools = required.slice(0, 2);
    const pre = await harness(probe(inventory(Object.fromEntries(missingTools.map(tool => [tool, false]))))).preflight();
    check(!pre.ok && pre.blockers.length === 1 && pre.blockers[0].code === 'missing_tool',
      'verified absent required tools share one blocker');
    assert.deepEqual(Array.from(pre.blockers[0].tools), missingTools);
    check(missingTools.every(tool => pre.info.tools[tool] === false), 'verified absent tools stay false');
    check(required.slice(2).every(tool => pre.info.tools[tool] === true), 'other tools stay verified present');
  }
  {
    const pre = await harness(probe(inventory(Object.fromEntries(optional.map(tool => [tool, false]))))).preflight();
    check(pre.ok, 'absent optional Windows tools do not block repair');
    check(optional.every(tool => pre.info.tools[tool] === false), 'optional absence remains accurate');
  }

  console.log('preflight-regression-smoke: Secondary Logon remains a hard repair gate');
  {
    const pre = await harness(probe(inventory({ seclogon_status: 'MISSING', seclogon_starttype: 'MISSING' }))).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_missing'), 'missing Secondary Logon blocks repair');
  }
  {
    const pre = await harness(probe(inventory({ seclogon_status: 'Stopped', seclogon_starttype: 'Disabled' }))).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_disabled'), 'disabled Secondary Logon blocks repair');
  }
  {
    const pre = await harness(probe(inventory({ seclogon_status: 'Paused', seclogon_starttype: 'Boot' }))).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_not_running'),
      'service that is not running and cannot be started stays blocked');
  }
  {
    const run = harness(probe(inventory({ seclogon_status: 'Stopped' })), probe('SECLOGON_HEAL=RUNNING'));
    const pre = await run.preflight();
    check(pre.ok && pre.info.seclogon.status === 'Running' && pre.info.seclogon.selfHeal === 'started',
      'verified successful service start permits repair');
    check(run.calls.length === 2, 'stopped service gets one bounded start attempt');
  }
  for (const [name, response] of [
    ['service start fails', probe('SECLOGON_HEAL=FAILED=Stopped', { code: 1 })],
    ['nonzero service start with success text', probe('SECLOGON_HEAL=RUNNING', { code: 1 })],
    ['timed out service start with success text', probe('SECLOGON_HEAL=RUNNING', { timedOut: true })]
  ]) {
    const pre = await harness(probe(inventory({ seclogon_status: 'Stopped' })), response).preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'seclogon_start_failed'), `${name}: repair stays blocked`);
    check(pre.info.seclogon.status !== 'Running', `${name}: no false running service state`);
  }

  console.log('preflight-regression-smoke: existing elevation and helper-account safeguards');
  {
    const run = harness(probe(inventory()), undefined, { isElevatedSync: async () => false });
    const pre = await run.preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'not_elevated'),
      'healthy tools never bypass the administrator guard');
  }
  {
    const run = harness(probe(inventory()), undefined, { os: { userInfo: () => ({ username: 'USER1' }) } });
    const pre = await run.preflight();
    check(!pre.ok && pre.blockers.some(blocker => blocker.code === 'running_as_target'),
      'healthy tools never allow rebuilding the signed-in helper account');
    const repair = harness(probe(inventory()), undefined, { os: { userInfo: () => ({ username: 'USER1' }) } });
    const result = await repair.repair();
    check(!result.success && result.error === 'preflight_failed' && repair.destructive.length === 0,
      'actual repair preserves the signed-in helper account');
  }

  console.log('preflight-regression-smoke: SID-bound cleanup remains retryable');
  {
    const unknown = repairHarness({ initialIdentityUnverified: true });
    const result = await unknown.repair();
    check(result.success === false && result.error === 'helper_sid_unresolved' &&
      unknown.state.disableAttempts === 0 && unknown.state.finalDrainAttempts === 0 &&
      unknown.state.cleanupAttempts === 0 && unknown.state.deleteAttempts === 0 &&
      unknown.state.createAttempts === 0,
    'an uncertain initial local-account inventory blocks every cleanup and recreation mutation');
  }
  for (const profilePathState of ['blank', 'missing']) {
    const malformed = repairHarness({ profilePathState });
    const result = await malformed.repair();
    check(result.success === false && result.error === 'profile_cleanup_identity_unresolved' &&
      malformed.state.cleanupAttempts === 0 && malformed.state.deleteAttempts === 0 &&
      malformed.state.disableAttempts === 0 && malformed.state.finalDrainAttempts === 0 &&
      malformed.state.createAttempts === 0 && malformed.state.accountSid === OLD_SID &&
      malformed.state.profileKeyPresent,
    `an exact-SID key with a ${profilePathState} ProfileImagePath causes zero mutation`);
  }
  {
    const blocked = repairHarness({ disableFails: true });
    const result = await blocked.repair();
    check(result.success === false && result.error === 'helper_disable_unproved' &&
      blocked.state.disableAttempts === 1 && blocked.state.finalDrainAttempts === 0 &&
      blocked.state.cleanupAttempts === 0 && blocked.state.deleteAttempts === 0 &&
      blocked.state.createAttempts === 0,
    'an unproved exact-SID disable starts no final drain or destructive cleanup');
  }
  for (const [name, finalDrainResult] of [
    ['unknown', probe('FIXER_HELPER_FINAL_DRAIN_V1=UNKNOWN', { code: 1 })],
    ['timeout', probe('FIXER_HELPER_FINAL_DRAIN_V1=CLEAR', { timedOut: true })]
  ]) {
    const blocked = repairHarness({ finalDrainResult });
    const result = await blocked.repair();
    check(result.success === false && result.error === 'helper_final_drain_unproved' &&
      blocked.state.disableAttempts === 1 && blocked.state.finalDrainAttempts === 1 &&
      blocked.state.cleanupAttempts === 0 && blocked.state.deleteAttempts === 0 &&
      blocked.state.createAttempts === 0,
    `a final exact-SID drain ${name} result starts no profile cleanup`);
  }
  {
    const retry = repairHarness({
      cleanupResults: [probe('', { code: 1 }), probe('')],
      partialCleanupFailure: true,
      createSucceeds: true
    });
    const first = await retry.repair();
    check(first.success === false && first.error === 'delete_profile_failed',
      'first cleanup failure returns a controlled result');
    check(retry.state.accountSid === OLD_SID && !retry.state.accountEnabled &&
      !retry.state.profileFolderPresent &&
      retry.state.profileKeyPresent &&
      retry.state.deleteAttempts === 0 && retry.state.createAttempts === 0,
    'first partial cleanup failure retains the old account and SID key after folder removal');

    const second = await retry.repair();
    check(second.success === false && second.error === 'launch_failed',
      'second run safely passes cleanup, account replacement, and reaches launch verification');
    check(retry.state.accountSid === NEW_SID && !retry.state.profileFolderPresent &&
      !retry.state.profileKeyPresent &&
      retry.state.cleanupAttempts === 2 && retry.state.deleteAttempts === 1 &&
      retry.state.disableAttempts === 2 && retry.state.finalDrainAttempts === 2 &&
      retry.state.createAttempts === 1 &&
      retry.state.order.join('>') === 'disable>final-drain>disable>final-drain>cleanup>delete>create' &&
      retry.state.cleanupScript.includes(".TrimEnd('" + String.fromCharCode(92) + "')"),
    'retry orders cleanup before delete before one fresh-SID creation');
  }
  {
    const raced = repairHarness({ cleanupResults: [probe('')], sidRace: true });
    const result = await raced.repair();
    check(result.success === false && result.error === 'helper_identity_changed_before_delete' &&
      raced.state.deleteAttempts === 0 && raced.state.createAttempts === 0,
    'a changed local SID blocks name-based deletion and recreation');
  }
  {
    const reappeared = repairHarness({ cleanupResults: [probe('')], deleteReplacementSid: RACE_SID });
    const result = await reappeared.repair();
    check(result.success === false && result.error === 'delete_user_failed' &&
      reappeared.state.deleteAttempts === 1 && reappeared.state.createAttempts === 0 &&
      reappeared.state.accountSid === RACE_SID,
    'an exact-SID delete race preserves a same-name replacement and blocks recreation');
  }
  {
    const uncertain = repairHarness({ cleanupResults: [probe('')], deleteReadbackUnverified: true });
    const result = await uncertain.repair();
    check(result.success === false && result.error === 'delete_user_unproved' &&
      uncertain.state.deleteAttempts === 1 && uncertain.state.createAttempts === 0,
    'an uncertain post-delete identity readback blocks account recreation');
  }
  check(exactSidDeleteScriptSource.includes('& $removeLocalUser -SID $expectedSid') &&
    exactSidDeleteScriptSource.includes('Import-Module -Name $trustedManifest -Force -PassThru') &&
    !exactSidDeleteScriptSource.includes('Remove-LocalUser -Name') &&
    !fixSource.includes("runProcess('net.exe', ['user', FIX_USER, '/delete']"),
  'account deletion is exact-SID only and has no name-based fallback');

  console.log('preflight-regression-smoke: ProfSvc failures stay controlled');
  for (const [name, flushResult, detail] of [
    ['timeout', probe('PROFSVC_REFRESH=OK', { timedOut: true }), 'timed out after 60 seconds'],
    ['nonzero', probe('PROFSVC_REFRESH=OK', { code: 7 }), 'exit 7'],
    ['missing OK', probe('HKLM flushed.'), 'did not confirm success']
  ]) {
    const run = repairHarness({ cleanupResults: [probe('')], flushResult });
    const result = await run.repair();
    const profsvc = Array.from(result.steps || []).find(step => step.id === 'profsvc-flush');
    check(result.success === false && result.error === 'create_user_failed' &&
      profsvc && profsvc.outcome === 'fail' && profsvc.detail.includes(detail) &&
      !(result.warnings || []).some(warning => warning.code === 'profsvc_flush_failed'),
    'ProfSvc ' + name + ' returns a controlled prior-account failure without ReferenceError');
  }
  console.log(`preflight-regression-smoke: all ${checks} checks passed`);
}

main().catch(error => {
  console.error(`preflight-regression-smoke: ${error.stack || error}`);
  process.exitCode = 1;
});
