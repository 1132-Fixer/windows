'use strict';

// Actual product controller + provisioned flow with synthetic native receipts.
// No worker, account, profile, child process, filesystem write or CLI is used.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const originalLoad = Module._load;
let createRepairSession;
Module._load = function guarded(request, ...args) {
  if (['fs', 'node:fs', 'child_process', 'node:child_process', 'electron', 'http', 'https',
    'node:http', 'node:https', 'net', 'node:net', 'worker_threads', 'node:worker_threads'].includes(request)
      || /helper-reset-windows|native-worker-transport/.test(request)) {
    throw new Error('Pure session import attempted an external effect: ' + request);
  }
  return originalLoad.call(this, request, ...args);
};
try { ({ createRepairSession } = require('../src/main/repair-session')); }
finally { Module._load = originalLoad; }

const MACHINE = 'machine-a';
const MACHINE_SID = 'S-1-5-21-111-222-333';
const OPERATOR_SID = MACHINE_SID + '-1002';
const OLD_SID = MACHINE_SID + '-1001';
const NEW_SID = MACHINE_SID + '-1003';
const PROFILE = 'C:\\Users\\user1';
const OPERATOR_PROFILE = 'C:\\Users\\operator';
const ZOOM = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
const EXE_HASH = 'a'.repeat(64);
const CIPHER = Buffer.from('synthetic encrypted credential').toString('base64');
const PASSWORD = 'synthetic-password-at-least-twenty-characters';
const INPUT = { zoomPath: ZOOM, authorizeExactTarget: true };
const STANDARD_ACCOUNT = Object.freeze({ usersGroupSid:'S-1-5-32-545', usersMembershipVerified:true,
  administratorsExcluded:true, groupEnumerationComplete:true, standardAccountVerified:true,
  membershipProofKind:'raw-local-sid' });
const EFFECTS = new Set(['writeJournal', 'persistBinding', 'fenceAccount', 'shutdownAccount',
  'purgeProfile', 'deleteAccount', 'createDisabledAccount', 'createProfile', 'enableAccount']);
let checks = 0;
let finished = false;
process.once('beforeExit', () => {
  if (!finished) {
    console.error('FAIL repair-session: asynchronous harness did not complete');
    process.exitCode = 1;
  }
});
class FakeTimers {
  constructor() { this.now = 1000; this.serial = 0; this.jobs = new Map(); }
  setTimeout(fn, delay) { const id = ++this.serial; this.jobs.set(id, { fn, at: this.now + delay }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  tick(delay) {
    const end = this.now + delay;
    while (true) {
      const next = [...this.jobs].sort((left, right) => left[1].at - right[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at; this.jobs.delete(next[0]); next[1].fn();
    }
    this.now = end;
  }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flushUntil(test) {
  for (let index = 0; index < 600; index++) { if (test()) return; await Promise.resolve(); }
  assert.fail('Expected synthetic checkpoint was never reached');
}
async function flush() { for (let index = 0; index < 40; index++) await Promise.resolve(); }

function fixture(settings = {}) {
  const timers = new FakeTimers();
  const calls = [];
  const passwords = [];
  const state = { held: false, closed: false, retained: false, nativeCreates: 0, passwordCreates: 0,
    inspectCalls: 0, closeCalls: 0, serial: 0, journal: { phase: 'none', unresolved: false }, credentials: null };
  const proof = (context, extra = {}, status = 'verified') => ({
    status, complete: true, operationId: context.operation.id, generation: context.operation.generation,
    machineId: context.operation.machineId, leaseNonce: context.operation.leaseNonce || 'lease-a',
    accountSid: context.operation.accountSid, capturedAtMs: timers.now, profilePath: PROFILE, ...extra
  });
  const workflowProof = (context, name, extra = {}) => proof(context, {
    verified: true, step: name, registeredSid: context.operation.accountSid, registeredPath: PROFILE,
    operatorSid: OPERATOR_SID, operatorProfilePath: OPERATOR_PROFILE, currentUserProtected: true, ...extra
  });
  function admission(context, kind) {
    const common = { kind, accountName: 'user1', isLocal: true, currentUserProtected: true,
      currentUserSid: OPERATOR_SID, currentUserProfilePath: OPERATOR_PROFILE,
      currentUserProfilePathVerified: true, profileOwnershipVerified: true,
      profileNamespaceVerified: true, profilesRootVerified: true, profilesRoot: 'C:\\Users',
      ancestorsReparseFree: true, leafReparseFree: true, accountLookupComplete: true,
      builtin: false, protected: false, special: false, enabled: true };
    return kind === 'fresh-absent'
      ? proof(context, { ...common, accountExists: false, profileExists: false, registeredProfileCount: 0, unknownProfileCount: 0 })
      : proof(context, { ...common, accountExists: true, profileExists: true, accountSid: OLD_SID,
        registeredSid: OLD_SID, registeredPath: PROFILE,
        binding: { verified: true, storageProtected: true, ownerVerified: true, accountSid: OLD_SID,
          machineId: MACHINE, machineSid: MACHINE_SID, accountName: 'user1', profilePath: PROFILE } });
  }
  function configuration(context) {
    return {
      camera: { status: 'configured', machinePolicy: 'not-denied', value: 'Allow', effectiveAccess: 'requires-app-runtime-verification' },
      microphone: { status: 'configured', machinePolicy: 'not-denied', value: 'Allow', effectiveAccess: 'requires-app-runtime-verification' },
      hive: { status: 'owned-loaded-reference', accountSid: context.operation.accountSid },
      frameServer: { status: 'running', action: 'read-only' }, optionalPreferences: { status: 'not-requested' }
    };
  }
  function processProof(context) {
    return { tokenSid: context.operation.accountSid, processId: 1234, creationFileTime: '134000000000000000',
      executablePath: ZOOM, executableSha256: EXE_HASH, liveHandleVerified: true };
  }
  function binding(context) {
    return { schemaVersion: 1, operatorSid: OPERATOR_SID, operatorProfilePath: OPERATOR_PROFILE,
      accountName: 'user1', accountSid: context.operation.accountSid, profilePath: PROFILE,
      machineId: MACHINE, machineSid: MACHINE_SID, operationId: context.operation.id,
      generation: context.operation.generation, executablePath: ZOOM, executableSha256: EXE_HASH };
  }
  function snapshot(context) {
    const common = proof(context, { schemaVersion: 1 });
    return { schemaVersion: 1, operation: { ...context.operation }, probes: {
      binding: { ...common, ownerVerified: true, storageProtected: true, machineSid: MACHINE_SID, accountName: 'user1' },
      account: { ...common, exists: true, isLocal: true, accountType: 'user', name: 'user1',
        builtin: false, protected: false, enabled: false, currentUserSid: OPERATOR_SID, currentUserProfilePath: OPERATOR_PROFILE },
      shutdown: { ...common, outcome: 'complete', timedOut: false, spawnFailed: false, terminationConfirmed: true },
      sessions: { ...common, activeCount: 0, unknownOwnerCount: 0 },
      processes: { ...common, remainingCount: 0, unknownOwnerCount: 0 },
      profile: { ...common, exists: true, loaded: false, special: false, hiveLoaded: false,
        path: PROFILE, profilesRoot: 'C:\\Users', registeredPath: PROFILE, registeredSid: OLD_SID, ownerSid: OLD_SID,
        ownershipVerified: true, profilesRootVerified: true, ancestorsReparseFree: true, leafReparseFree: true },
      logonFence: { ...common, kind: 'account-disabled', applied: true, appliedAtMs: 950 },
      lease: { ...common, scope: 'machine', held: true, exclusive: true, nonce: 'lease-a',
        unresolvedWriter: false, acquiredAtMs: 900, expiresAtMs: 100000 },
      journal: { ...common, unresolved: false, phase: 'validated', currentOperationOwned: true,
        priorUnresolved: false, storageProtected: true, durablePhase: state.journal.phase }
    } };
  }
  const adapters = {
    capabilities: { atomicIdentityExpectation: true, exclusiveProfileCreation: true, completePurgeReadback: true },
    acquireLease(context) {
      const held = { status: 'held', scope: 'machine', exclusive: true, nonce: 'lease-a', machineVerified: true,
        machineId: MACHINE, machineSid: MACHINE_SID, operationId: context.operation.id,
        generation: context.operation.generation, acquiredAtMs: 900, expiresAtMs: 100000 };
      if (settings.acquireWait) return settings.acquireWait.promise.then(() => { state.held = true; return held; });
      state.held = true; return held;
    },
    releaseLease(context) {
      if (settings.badRelease) return proof(context, { nonce: 'wrong-lease' }, 'released');
      state.held = false; return proof(context, { nonce: 'lease-a' }, 'released');
    },
    readJournal: context => proof(context, { ...state.journal, storageProtected: true }),
    inspectAdmission(context) {
      const result = admission(context, settings.kind || 'fresh-absent');
      if (settings.staleAdmission) result.capturedAtMs = 1;
      return result;
    },
    revalidateAdmission: context => admission(context, 'fresh-absent'),
    writeJournal(context) {
      state.journal = { phase: context.phase, unresolved: context.unresolved };
      return proof(context, { ...state.journal, storageProtected: true }, 'persisted');
    },
    verifyOperatorTarget(context) {
      return proof(context, { consentVerified: !settings.denyTarget, purgeAuthorized: !settings.denyTarget, consentId: context.consent.id });
    },
    revalidateEffect: context => proof(context, { effect: context.effect, expectation: context.expected.state,
      nativeIdentityVerified: true, preconditionsVerified: true, atomicExpectationVerified: true }),
    persistBinding: context => proof(context, { persisted: true, ownerVerified: true, storageProtected: true,
      atomicExpectationVerified: true, nativeIdentityVerified: true }),
    fenceAccount: context => proof(context, { disabled: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    shutdownAccount: context => proof(context, { outcome: 'complete', timedOut: false, cleanupConfirmed: true,
      terminationConfirmed: true, remainingSessions: 0, remainingProcesses: 0, unknownOwnerCount: 0,
      atomicExpectationVerified: true, nativeIdentityVerified: true }),
    captureResetSnapshot: snapshot,
    purgeProfile: context => proof(context, { purgeComplete: true, remainingOwnedPaths: 0, unknownPaths: 0,
      profileFolderAbsent: true, profileRegistrationAbsent: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    deleteAccount: context => proof(context, { accountAbsent: true, profileFolderAbsent: true,
      profileRegistrationAbsent: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    async createDisabledAccount(context) {
      return state.credentials.withPassword(context, async password => {
        passwords.push({ sid: context.operation.accountSid, password });
        return proof(context, { ...STANDARD_ACCOUNT, created: true, disabled: true, isLocal: true, accountName: 'user1',
          accountSid: NEW_SID, currentUserSid: OPERATOR_SID, currentUserProtected: true,
          atomicExpectationVerified: true, nativeIdentityVerified: true });
      });
    },
    createProfile: context => proof(context, { created: true, registeredSid: context.operation.accountSid,
      ownershipVerified: true, loaded: false, special: false, ancestorsReparseFree: true, leafReparseFree: true,
      atomicExpectationVerified: true, nativeIdentityVerified: true }),
    enableAccount: context => proof(context, { ...STANDARD_ACCOUNT, enabled: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    verifyProvisionedState: context => proof(context, { ...STANDARD_ACCOUNT, bindingVerified: true, profileVerified: true, enabled: context.expectedEnabled })
  };
  for (const [name, method] of Object.entries(adapters)) {
    if (typeof method === 'function') adapters[name] = context => {
      calls.push({ name, context });
      return method(context);
    };
  }
  const native = {
    adapters,
    inspectRepairReadiness(values) {
      calls.push({name:'inspectRepairReadiness',values});
      assert.deepEqual(values,{zoomPath:ZOOM});
      const result={status:'ready',complete:true,effectsStarted:false,machineId:MACHINE,
        operatorSid:OPERATOR_SID,operatorProfilePath:OPERATOR_PROFILE,
        currentUserProfilePathVerified:true,currentUserProtected:true,profilePath:PROFILE,
        zoomPath:ZOOM,capturedAtMs:timers.now,readinessId:'readiness-a',zoomSha256:EXE_HASH,
        zoomTrustVerified:true,zoomHandleHeld:true,credentialStoragePreconditionsVerified:true,
        credentialStorageGuardHeld:true,launchPrivilegesVerified:true,profilePrivilegesVerified:true};
      if(settings.readinessChange) settings.readinessChange(result);
      if(settings.readinessWait) return settings.readinessWait.promise;
      return result;
    },
    inspectRecovery() {
      calls.push({ name: 'inspectRecovery' });
      state.inspectCalls++;
      const prior = settings.priorUnresolved && state.inspectCalls === 1;
      const result = { status: prior ? 'blocked' : 'clear', complete: true, blocked: !!prior,
        machineId: MACHINE, storageProtected: true, leaseHeld: state.held,
        operatorSid: OPERATOR_SID, operatorProfilePath: OPERATOR_PROFILE,
        currentUserProfilePathVerified: true, currentUserProtected: true };
      if (settings.badOperator) result.operatorProfilePath = PROFILE;
      if (settings.foreignMachine) result.machineId = 'another-machine';
      if (settings.changedOperator && state.inspectCalls > 1) result.operatorSid = MACHINE_SID + '-1005';
      return result;
    },
    async runWorkflowStep(name, context, values) {
      calls.push({ name: 'workflow:' + name, context, values });
      if (name === 'launch-zoom') {
        assert.deepEqual(values, { zoomPath: ZOOM });
        return state.credentials.withPassword(context, async password => {
          passwords.push({ sid: context.operation.accountSid, password });
          return workflowProof(context, name, { ...processProof(context), launched: true, publisher: 'Zoom Communications, Inc.' });
        });
      }
      assert.deepEqual(values || {}, {});
      if (name === 'verify-profile') {
        if (settings.profileWait) await settings.profileWait.promise;
        return workflowProof(context, name, { loaded: true, special: false, ownershipVerified: true, hiveOwnedReference: true });
      }
      if (name === 'configure-helper') return workflowProof(context, name, { preferencesVerified: true, configuration: configuration(context) });
      if (name === 'seal-credential') {
        return state.credentials.withPassword(context, async password => {
          passwords.push({ sid: context.operation.accountSid, password });
          return workflowProof(context, name, { protection: 'DPAPI-CurrentUser', ciphertext: CIPHER, binding: binding(context) });
        });
      }
      if (name === 'persist-credential') {
        const result = workflowProof(context, name, { stored: true, readbackVerified: true, storageProtected: true,
          ownerVerified: true, protection: 'DPAPI-CurrentUser', formatVersion: 2,
          ciphertextSha256: crypto.createHash('sha256').update(Buffer.from(CIPHER, 'base64')).digest('hex') });
        if (settings.badStorageHash) result.ciphertextSha256 = 'b'.repeat(64);
        return result;
      }
      if (name === 'verify-zoom') return workflowProof(context, name, { ...processProof(context), ready: true, configuration: configuration(context) });
      throw new Error('Unexpected synthetic workflow step');
    },
    hasUnresolvedCustody: () => state.retained,
    retainCustody() { state.retained = true; },
    async close() {
      calls.push({ name: 'close' }); state.closeCalls++;
      assert.equal(state.held, false, 'never close while the lease remains owned');
      assert.equal(state.journal.unresolved, false, 'never close with an unresolved journal');
      if (settings.closeWait) await settings.closeWait.promise;
      state.closed = true;
      return { ok: true, completed: true, result: { status: 'closed', complete: true, leaseHeld: settings.badClose ? true : false } };
    }
  };
  adapters.onAuthorityLost = () => native.retainCustody();
  const options = {
    createNative: async arguments_ => {
      state.nativeCreates++; state.credentials = arguments_.credentials;
      assert.equal(arguments_.expectedMachineId, MACHINE);
      assert.equal(typeof arguments_.now, 'function');
      if (settings.createWait) await settings.createWait.promise;
      if (settings.createFails) throw new Error('private native error must not reach public output');
      return native;
    },
    now: () => timers.now, machineId: MACHINE, generatePassword: () => { state.passwordCreates++; return PASSWORD; },
    randomId: () => 'id-' + (++state.serial), timers, timeoutMs: 10
  };
  if (settings.persistOverride) options.persistCredential = (contract, context) => settings.persistOverride(contract, context, workflowProof);
  const session = createRepairSession(options);
  return { session, native, state, calls, passwords, timers,
    effects: () => calls.filter(call => EFFECTS.has(call.name)).map(call => call.name),
    workflowCalls: () => calls.filter(call => call.name.startsWith('workflow:')).map(call => call.name) };
}

async function check(name, test) {
  await test();
  checks++;
  console.log('  ok  ' + name);
}
async function runAll() {
  await check('pure module imports actual controller and flow without native effect dependencies', () => assert.equal(typeof createRepairSession, 'function'));
  await check('explicit confirmation denial performs no native or credential work', async () => {
    const f = fixture();
    const result = await f.session.run({ zoomPath: ZOOM, authorizeExactTarget: false });
    assert.equal(result.reason, 'target_authorization_required');
    assert.equal(f.state.nativeCreates, 0); assert.equal(f.state.passwordCreates, 0);
    assert.deepEqual(f.calls, []); assert.equal(f.session.hasUnresolvedCustody(), false);
  });
  await check('invalid selected executable performs no native work', async () => {
    for (const zoomPath of ['Zoom.exe', 'C:\\Users\\..\\Zoom.exe', 'C:\\Program Files\\Zoom\\other.exe', '\\\\server\\Zoom.exe']) {
      const f = fixture(); assert.equal((await f.session.run({ ...INPUT, zoomPath })).reason, 'invalid_request');
      assert.equal(f.state.nativeCreates, 0); assert.deepEqual(f.effects(), []);
    }
  });
  await check('successful core run preserves partial truth and closes only after completion and release', async () => {
    const f = fixture(); const progress = [];
    const result = await f.session.run({ ...INPUT, onProgress: value => progress.push(value) });
    assert.equal(result.success, true); assert.equal(result.status, 'workflow-verified');
    assert.equal(result.partial, true, 'optional preferences remain visibly incomplete');
    assert.ok(result.steps.some(step => step.id === 'zoom-config' && step.outcome === 'fail'));
    assert.ok(result.warnings.some(warning => warning.code === 'optional_preferences_not_applied'));
    assert.equal(result.receipt.zoomRelaunch, 'confirmed');
    assert.equal(f.state.closed, true); assert.equal(f.state.held, false); assert.equal(f.state.closeCalls, 1);
    const release = f.calls.findIndex(call => call.name === 'releaseLease');
    const close = f.calls.findIndex(call => call.name === 'close');
    assert.ok(release >= 0 && close > release);
    assert.equal(f.state.inspectCalls, 2);
    assert.equal(f.session.activeNative(), null); assert.equal(f.session.hasUnresolvedCustody(), false);
    assert.equal(f.session.inspect().nativeOwned, false);
    assert.ok(progress.length > 0);
    const expectedProgress = {
      preparing: 'Preparing the repair', 'checking-recovery': 'Checking previous repair work',
      'checking-readiness': 'Checking Zoom and repair prerequisites',
      'resetting-helper': 'Preparing the fresh helper account', 'launch-zoom': 'Opening Zoom in the fresh profile',
      'verify-profile': 'Checking the fresh profile', 'configure-helper': 'Applying helper settings',
      'seal-credential': 'Protecting the helper sign-in', 'persist-credential': 'Saving the protected sign-in',
      'verify-zoom': 'Confirming Zoom is running', 'checking-completion': 'Checking repair completion',
      'closing-worker': 'Finishing the repair'
    };
    for (const value of progress) {
      assert.deepEqual(Object.keys(value), ['step', 'label']);
      assert.equal(typeof value.label, 'string');
      assert.equal(value.label, expectedProgress[value.step]);
      assert.equal(Object.isFrozen(value), true);
    }
    assert.deepEqual([...new Set(progress.map(value => value.step))].sort(), Object.keys(expectedProgress).sort());
    assert.ok(!JSON.stringify(progress).includes(PASSWORD));
    assert.ok(!JSON.stringify(progress).includes(OPERATOR_PROFILE));
    assert.ok(!JSON.stringify(result).includes(OPERATOR_SID));
    assert.ok(!JSON.stringify(result).includes(CIPHER));
  });
  await check('one password is used across null SID creation and new SID launch/seal', async () => {
    const f = fixture(); assert.equal((await f.session.run(INPUT)).success, true);
    assert.equal(f.state.passwordCreates, 1); assert.equal(f.passwords.length, 3);
    assert.equal(f.passwords[0].sid, null);
    assert.deepEqual(f.passwords.slice(1).map(value => value.sid), [NEW_SID, NEW_SID]);
    assert.ok(f.passwords.every(value => value.password === PASSWORD));
    const context = f.calls.find(call => call.name === 'createDisabledAccount').context;
    await assert.rejects(f.state.credentials.withPassword(context, () => assert.fail('closed credential reused')), /credentials_invalid/);
  });
  await check('production persistence dispatch carries no caller ciphertext or binding', async () => {
    const f = fixture(); assert.equal((await f.session.run(INPUT)).success, true);
    const persisted = f.calls.find(call => call.name === 'workflow:persist-credential');
    assert.ok(persisted); assert.deepEqual(persisted.values, {});
    assert.deepEqual(Object.keys(persisted.context).sort(), ['lease', 'operation', 'profilePath']);
  });
  await check('explicit injected persistence is isolated and receives the exact sealed contract', async () => {
    let seen = 0;
    const f = fixture({ persistOverride(contract, context, receipt) {
      seen++; assert.equal(contract.ciphertext, CIPHER);
      assert.equal(contract.binding.accountSid, NEW_SID);
      return receipt(context, 'persist-credential', { stored: true, readbackVerified: true, storageProtected: true,
        ownerVerified: true, formatVersion: 2, protection: 'DPAPI-CurrentUser',
        ciphertextSha256: crypto.createHash('sha256').update(Buffer.from(CIPHER, 'base64')).digest('hex') });
    } });
    assert.equal((await f.session.run(INPUT)).success, true); assert.equal(seen, 1);
    assert.ok(!f.workflowCalls().includes('workflow:persist-credential'));
  });
  await check('known pre-destructive readiness refusal closes safely with no effects and permits a fresh later attempt', async () => {
    for(const reason of ['zoom_untrusted','credential_storage_unavailable','launch_privileges_unavailable','profile_privileges_unavailable']){
      const f=fixture({readinessChange(value){Object.assign(value,{status:'blocked',reason,closeSafe:true});}});
      const result=await f.session.run(INPUT);
      assert.equal(result.reason,reason);assert.equal(result.unresolved,false);
      assert.deepEqual(f.effects(),[]);assert.equal(f.state.passwordCreates,0);
      assert.equal(f.calls.some(value=>value.name==='acquireLease'),false);
      assert.equal(f.state.closeCalls,1);assert.equal(f.session.hasUnresolvedCustody(),false);
      assert.equal(f.session.activeNative(),null);
    }
  });
  await check('known readiness refusal cannot discard an unproved worker close', async()=>{
    const f=fixture({badClose:true,readinessChange(value){Object.assign(value,{status:'blocked',reason:'zoom_untrusted',closeSafe:true});}});
    assert.equal((await f.session.run(INPUT)).unresolved,true);
    assert.deepEqual(f.effects(),[]);assert.equal(f.session.activeNative(),f.native);
    assert.equal(f.session.hasUnresolvedCustody(),true);
  });
  await check('readiness timeout and late ready result never acquire a lease or resume effects',async()=>{
    const wait=deferred();let late;
    const f=fixture({readinessWait:wait,readinessChange(value){late={...value};}});
    const pending=f.session.run(INPUT);
    await flush();assert.ok(late,'fixture must reach readiness');
    f.timers.tick(11);assert.equal((await pending).unresolved,true);
    const count=f.calls.length;
    wait.resolve(late);await flush();
    assert.equal(f.calls.length,count);assert.deepEqual(f.effects(),[]);
    assert.equal(f.calls.some(value=>value.name==='acquireLease'),false);
    assert.equal(f.state.closeCalls,0);assert.equal(f.state.passwordCreates,0);
    assert.equal((await f.session.run(INPUT)).reason,'repair_recovery_required');
  });
  await check('incomplete, foreign and contradictory readiness never acquires a lease or touches the target', async () => {
    for(const change of [v=>{delete v.zoomHandleHeld;},v=>{v.credentialStorageGuardHeld=false;},
      v=>{v.zoomTrustVerified=false;},v=>{v.launchPrivilegesVerified=false;},v=>{v.profilePrivilegesVerified=false;},
      v=>{v.machineId='foreign';},v=>{v.operatorSid=OLD_SID;},v=>{v.zoomPath='C:\\Other\\Zoom.exe';},
      v=>{v.capturedAtMs=1;},v=>{v.effectsStarted=true;},v=>{v.status='blocked';v.reason='unknown';v.closeSafe=true;}]){
      const f=fixture({readinessChange:change});
      assert.equal((await f.session.run(INPUT)).unresolved,true);
      assert.deepEqual(f.effects(),[]);assert.equal(f.calls.some(value=>value.name==='acquireLease'),false);
      assert.equal(f.state.passwordCreates,0);assert.equal(f.state.closeCalls,0);
      assert.equal((await f.session.run(INPUT)).reason,'repair_recovery_required');
    }
  });
  await check('readiness is verified before the first machine lease and native mutation',async()=>{
    const f=fixture();assert.equal((await f.session.run(INPUT)).success,true);
    const names=f.calls.map(value=>value.name);
    assert.ok(names.indexOf('inspectRecovery')<names.indexOf('inspectRepairReadiness'));
    assert.ok(names.indexOf('inspectRepairReadiness')<names.indexOf('acquireLease'));
    assert.ok(names.indexOf('acquireLease')<names.indexOf('writeJournal'));
  });
  await check('prior unresolved recovery blocks every account/profile effect and repeat', async () => {
    const f = fixture({ priorUnresolved: true });
    assert.equal((await f.session.run(INPUT)).unresolved, true);
    assert.deepEqual(f.effects(), []); assert.equal(f.state.passwordCreates, 0);
    assert.equal(f.state.closeCalls, 0); assert.equal(f.session.activeNative(), f.native);
    assert.equal((await f.session.run(INPUT)).reason, 'repair_recovery_required');
    assert.equal(f.state.nativeCreates, 1);
  });
  await check('foreign machine and protected operator identity cannot enter the controller', async () => {
    for (const setting of [{ foreignMachine: true }, { badOperator: true }]) {
      const f = fixture(setting); assert.equal((await f.session.run(INPUT)).unresolved, true);
      assert.deepEqual(f.effects(), []); assert.equal(f.calls.some(call => call.name === 'acquireLease'), false);
    }
  });
  await check('operator target consent is scoped to native admission, not caller SID fields', async () => {
    const f = fixture({ kind: 'operator-target' });
    const result = await f.session.run({ ...INPUT, accountSid: OPERATOR_SID, profilePath: OPERATOR_PROFILE });
    assert.equal(result.success, true);
    const consent = f.calls.find(call => call.name === 'verifyOperatorTarget').context.consent;
    assert.equal(consent.accountSid, OLD_SID); assert.equal(consent.profilePath, PROFILE);
    assert.equal(consent.scope, 'purge-exact-local-user1');
    assert.equal(consent.operationId, 'id-1'); assert.equal(consent.generation, 1);
    assert.equal(consent.machineId, MACHINE); assert.equal(consent.confirmed, true);
  });
  await check('native denial of exact target executes no destructive effects', async () => {
    const f = fixture({ kind: 'operator-target', denyTarget: true });
    const result = await f.session.run(INPUT);
    assert.equal(result.success, false); assert.equal(result.unresolved, true);
    assert.deepEqual(f.effects(), []); assert.equal(f.state.passwordCreates, 0);
    assert.equal(f.state.closeCalls, 0);
  });
  await check('stale admission cannot write journal or reset the helper', async () => {
    const f = fixture({ staleAdmission: true });
    f.timers.now = 10000;
    assert.equal((await f.session.run(INPUT)).unresolved, true);
    assert.deepEqual(f.effects(), []); assert.equal(f.workflowCalls().length, 0);
    assert.equal((await f.session.run(INPUT)).unresolved, true); assert.equal(f.state.nativeCreates, 1);
  });
  await check('a concurrent click does not start a second native worker', async () => {
    const wait = deferred(); const f = fixture({ createWait: wait });
    const first = f.session.run(INPUT); await flushUntil(() => f.state.nativeCreates === 1);
    const second = await f.session.run(INPUT);
    assert.equal(second.reason, 'repair_already_running'); assert.equal(f.state.nativeCreates, 1);
    wait.resolve(); assert.equal((await first).success, true);
  });
  await check('native constructor failure is sanitized and blocks retry', async () => {
    const f = fixture({ createFails: true });
    const result = await f.session.run(INPUT);
    assert.equal(result.reason, 'repair_recovery_required'); assert.equal(result.unresolved, true);
    assert.ok(!JSON.stringify(result).includes('private native error'));
    assert.equal((await f.session.run(INPUT)).unresolved, true); assert.equal(f.state.nativeCreates, 1);
  });
  await check('late worker construction after deadline remains owned and cannot run effects', async () => {
    const wait = deferred(); const f = fixture({ createWait: wait });
    const pending = f.session.run(INPUT); await flushUntil(() => f.state.nativeCreates === 1);
    f.timers.tick(11); const result = await pending;
    assert.equal(result.unresolved, true); assert.equal(f.session.activeNative(), null);
    wait.resolve(); await flushUntil(() => f.session.activeNative() === f.native);
    assert.equal(f.state.retained, true); assert.deepEqual(f.effects(), []); assert.equal(f.state.closeCalls, 0);
    assert.equal((await f.session.run(INPUT)).unresolved, true); assert.equal(f.state.nativeCreates, 1);
  });
  await check('late acquisition acknowledgement cannot restart a timed-out controller', async () => {
    const wait = deferred(); const f = fixture({ acquireWait: wait });
    const pending = f.session.run(INPUT); await flushUntil(() => f.calls.some(call => call.name === 'acquireLease'));
    f.timers.tick(11); assert.equal((await pending).unresolved, true);
    wait.resolve(); await flush();
    assert.deepEqual(f.effects(), []); assert.equal(f.state.closeCalls, 0);
    assert.equal(f.session.activeNative(), f.native); assert.equal(f.session.hasUnresolvedCustody(), true);
  });
  await check('late profile step cannot continue configure or persist after outer deadline', async () => {
    const wait = deferred(); const f = fixture({ profileWait: wait });
    const pending = f.session.run(INPUT); await flushUntil(() => f.workflowCalls().includes('workflow:verify-profile'));
    f.timers.tick(11); assert.equal((await pending).unresolved, true);
    wait.resolve(); await flush();
    assert.ok(!f.workflowCalls().includes('workflow:configure-helper'));
    assert.ok(!f.workflowCalls().includes('workflow:persist-credential'));
    assert.equal(f.state.closeCalls, 0); assert.equal(f.session.hasUnresolvedCustody(), true);
  });
  await check('storage mismatch cannot complete or close the repair', async () => {
    const f = fixture({ badStorageHash: true });
    assert.equal((await f.session.run(INPUT)).unresolved, true);
    assert.equal(f.state.closeCalls, 0); assert.equal(f.session.activeNative(), f.native);
    assert.equal(f.state.journal.unresolved, true);
  });
  await check('unverified lease release cannot close the worker or free custody', async () => {
    const f = fixture({ badRelease: true });
    assert.equal((await f.session.run(INPUT)).unresolved, true);
    assert.equal(f.state.closeCalls, 0); assert.equal(f.session.hasUnresolvedCustody(), true);
  });
  await check('operator identity change at final inspection cannot clear custody', async () => {
    const f = fixture({ changedOperator: true });
    assert.equal((await f.session.run(INPUT)).unresolved, true);
    assert.equal(f.state.closeCalls, 0); assert.equal(f.session.activeNative(), f.native);
  });
  await check('malformed close receipt remains unresolved despite a close call', async () => {
    const f = fixture({ badClose: true });
    assert.equal((await f.session.run(INPUT)).unresolved, true);
    assert.equal(f.state.closeCalls, 1); assert.equal(f.session.activeNative(), f.native);
    assert.equal((await f.session.run(INPUT)).unresolved, true); assert.equal(f.state.nativeCreates, 1);
  });
  await check('late close completion does not clear a prior timeout or credential custody', async () => {
    const wait = deferred(); const f = fixture({ closeWait: wait });
    const pending = f.session.run(INPUT); await flushUntil(() => f.state.closeCalls === 1);
    f.timers.tick(11); assert.equal((await pending).unresolved, true);
    wait.resolve(); await flush();
    assert.equal(f.session.activeNative(), f.native); assert.equal(f.session.hasUnresolvedCustody(), true);
    const context = f.calls.find(call => call.name === 'createDisabledAccount').context;
    await assert.rejects(f.state.credentials.withPassword(context, () => assert.fail('uncertain credential reused')), /credentials_invalid/);
    assert.equal((await f.session.run(INPUT)).unresolved, true); assert.equal(f.state.closeCalls, 1);
  });
  await check('progress observer failure cannot grant cancellation or corrupt the result', async () => {
    const f = fixture();
    const result = await f.session.run({ ...INPUT, onProgress() { throw new Error(PASSWORD); } });
    assert.equal(result.success, true);
    assert.ok(!JSON.stringify(result).includes(PASSWORD));
  });
  await check('same session can create a fresh operation only after verified close', async () => {
    const f = fixture();
    assert.equal((await f.session.run(INPUT)).success, true);
    assert.equal((await f.session.run(INPUT)).success, true);
    assert.equal(f.state.nativeCreates, 2); assert.equal(f.state.passwordCreates, 2);
    assert.equal(f.session.inspect().generation, 2); assert.equal(f.session.hasUnresolvedCustody(), false);
    const acquisitions = f.calls.filter(call => call.name === 'acquireLease').map(call => call.context.operation);
    assert.notEqual(acquisitions[0].id, acquisitions[1].id);
    assert.equal(acquisitions[0].generation, 1); assert.equal(acquisitions[1].generation, 2);
  });
}
runAll().then(() => {
  finished = true;
  console.log('repair-session: ' + checks + ' checks passed');
}, error => {
  finished = true;
  console.error('FAIL repair-session:', error && error.stack || error);
  process.exitCode = 1;
});
