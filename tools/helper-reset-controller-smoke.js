'use strict';

// All adapters, identities, clocks and effects are synthetic. No native host,
// account, profile, child process, service, browser or filesystem API is used.
const assert = require('node:assert/strict');
const Module = require('node:module');
let createHelperResetController;
let REQUIRED_ADAPTERS;
let TARGET_PROFILE;
const OLD_SID = 'S-1-5-21-111-222-333-1001';
const NEW_SID = 'S-1-5-21-111-222-333-1003';
const MACHINE_SID = 'S-1-5-21-111-222-333';
const REQUEST = { operationId: 'repair-a', generation: 1, machineId: 'machine-a' };
const STANDARD_ACCOUNT = Object.freeze({ usersGroupSid:'S-1-5-32-545', usersMembershipVerified:true,
  administratorsExcluded:true, groupEnumerationComplete:true, standardAccountVerified:true,
  membershipProofKind:'raw-local-sid' });
const nativeAttempts = [];
let passed = 0;
let failed = 0;
let harnessFinished = false;
// Inert test clocks do not keep Node alive. A lost/never-settled await must
// therefore fail at beforeExit rather than silently leave the process green.
process.once('beforeExit', () => {
  if (!harnessFinished) {
    console.error('FAIL helper-reset-controller: async harness did not finish');
    process.exitCode = 1;
  }
});

class FakeTimers {
  constructor() { this.jobs = new Map(); this.serial = 0; this.now = 1000; }
  setTimeout(fn, ms) { const id = ++this.serial; this.jobs.set(id, { fn, at: this.now + ms }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  tick(ms) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.now = next[1].at; this.jobs.delete(next[0]); next[1].fn();
    }
    this.now = end;
  }
}

function fixture(kind = 'fresh-absent') {
  const timers = new FakeTimers();
  const calls = [];
  const effects = [];
  const state = { held: false, journal: { phase: 'none', unresolved: false }, kind, generation: 1 };
  function proof(ctx, extra = {}, status = 'verified') {
    return { status, complete: true, operationId: ctx.operation.id, generation: ctx.operation.generation,
      machineId: ctx.operation.machineId, leaseNonce: ctx.operation.leaseNonce || 'lease-a',
      accountSid: ctx.operation.accountSid, capturedAtMs: timers.now, profilePath: TARGET_PROFILE, ...extra };
  }
  function admission(ctx, selected) {
    const common = { kind: selected, accountName: 'user1', isLocal: true, currentUserProtected: true,
      currentUserSid: 'S-1-5-21-111-222-333-1002', profileOwnershipVerified: true,
      currentUserProfilePath: 'C:\\Users\\operator', currentUserProfilePathVerified: true,
      profileNamespaceVerified: true, profilesRootVerified: true, profilesRoot: 'C:\\Users',
      ancestorsReparseFree: true, leafReparseFree: true, accountLookupComplete: true,
      builtin: false, protected: false, special: false, enabled: true };
    if (selected === 'fresh-absent') return proof(ctx, { ...common, accountExists: false, profileExists: false,
      registeredProfileCount: 0, unknownProfileCount: 0 });
    return proof(ctx, { ...common, accountExists: true, profileExists: true, accountSid: OLD_SID,
      registeredSid: OLD_SID, registeredPath: TARGET_PROFILE, binding: { verified: true, storageProtected: true, ownerVerified: true,
        accountSid: OLD_SID, machineId: 'machine-a', machineSid: MACHINE_SID,
        accountName: 'user1', profilePath: TARGET_PROFILE } });
  }
  const adapters = {
    capabilities: { atomicIdentityExpectation: true, exclusiveProfileCreation: true, completePurgeReadback: true },
    acquireLease(ctx) {
      if (state.held) return { status: 'busy', complete: true, acquired: false };
      state.held = true;
      return { status: 'held', scope: 'machine', exclusive: true, nonce: 'lease-a', machineVerified: true,
        machineId: 'machine-a', machineSid: MACHINE_SID, operationId: ctx.operation.id,
        generation: ctx.operation.generation, acquiredAtMs: 900, expiresAtMs: 100000 };
    },
    releaseLease(ctx) { state.held = false; return proof(ctx, { nonce: 'lease-a' }, 'released'); },
    readJournal: ctx => proof(ctx, { ...state.journal, storageProtected: true }),
    inspectAdmission: ctx => admission(ctx, state.kind),
    revalidateAdmission: ctx => admission(ctx, 'fresh-absent'),
    writeJournal(ctx) {
      state.journal = { phase: ctx.phase, unresolved: ctx.unresolved, operationId: ctx.operation.id,
        generation: ctx.operation.generation, machineId: ctx.operation.machineId, leaseNonce: ctx.operation.leaseNonce };
      return proof(ctx, { ...state.journal, storageProtected: true }, 'persisted');
    },
    verifyOperatorTarget: ctx => proof(ctx, { consentVerified: true, purgeAuthorized: true, consentId: ctx.consent.id }),
    revalidateEffect: ctx => proof(ctx, { effect: ctx.effect, expectation: ctx.expected.state,
      nativeIdentityVerified: true, preconditionsVerified: true, atomicExpectationVerified: true }),
    persistBinding: ctx => proof(ctx, { persisted: true, ownerVerified: true, storageProtected: true,
      atomicExpectationVerified: true, nativeIdentityVerified: true }),
    fenceAccount: ctx => proof(ctx, { disabled: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    shutdownAccount: ctx => proof(ctx, { outcome: 'complete', timedOut: false, cleanupConfirmed: true,
      terminationConfirmed: true, remainingSessions: 0, remainingProcesses: 0, unknownOwnerCount: 0,
      atomicExpectationVerified: true, nativeIdentityVerified: true }),
    captureResetSnapshot(ctx) {
      assert.equal(state.held, true);
      assert.equal(state.journal.operationId, ctx.operation.id);
      assert.equal(state.journal.leaseNonce, ctx.operation.leaseNonce);
      assert.equal(state.journal.phase, 'stopping-account');
      assert.equal(state.journal.unresolved, true);
      const common = { schemaVersion: 1, status: 'verified', complete: true, capturedAtMs: timers.now,
        machineId: 'machine-a', accountSid: OLD_SID, operationId: ctx.operation.id,
        generation: ctx.operation.generation, leaseNonce: 'lease-a' };
      return { schemaVersion: 1, operation: { ...ctx.operation }, probes: {
        binding: { ...common, ownerVerified: true, storageProtected: true, machineSid: MACHINE_SID, accountName: 'user1' },
        account: { ...common, exists: true, isLocal: true, accountType: 'user', name: 'user1',
          builtin: false, protected: false, enabled: false, currentUserSid: 'S-1-5-21-111-222-333-1002',
          currentUserProfilePath: 'C:\\Users\\operator' },
        shutdown: { ...common, outcome: 'complete', timedOut: false, spawnFailed: false, terminationConfirmed: true },
        sessions: { ...common, activeCount: 0, unknownOwnerCount: 0 },
        processes: { ...common, remainingCount: 0, unknownOwnerCount: 0 },
        profile: { ...common, exists: true, loaded: false, special: false, hiveLoaded: false,
          path: TARGET_PROFILE, profilesRoot: 'C:\\Users', registeredPath: TARGET_PROFILE, registeredSid: OLD_SID,
          ownerSid: OLD_SID, ownershipVerified: true, profilesRootVerified: true,
          ancestorsReparseFree: true, leafReparseFree: true },
        logonFence: { ...common, kind: 'account-disabled', applied: true, appliedAtMs: 950 },
        lease: { ...common, scope: 'machine', held: true, exclusive: true, nonce: 'lease-a',
          unresolvedWriter: false, acquiredAtMs: 900, expiresAtMs: 100000 },
        journal: { ...common, unresolved: false, phase: 'validated', currentOperationOwned: true,
          priorUnresolved: false, storageProtected: true, durablePhase: state.journal.phase }
      } };
    },
    purgeProfile: ctx => proof(ctx, { purgeComplete: true, remainingOwnedPaths: 0, unknownPaths: 0,
      profileFolderAbsent: true, profileRegistrationAbsent: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    deleteAccount: ctx => proof(ctx, { accountAbsent: true, profileFolderAbsent: true,
      profileRegistrationAbsent: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    createDisabledAccount: ctx => proof(ctx, { ...STANDARD_ACCOUNT, created: true, disabled: true, isLocal: true, accountName: 'user1',
      accountSid: NEW_SID, currentUserSid: 'S-1-5-21-111-222-333-1002',
      currentUserProtected: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    createProfile: ctx => proof(ctx, { created: true, registeredSid: ctx.operation.accountSid,
      ownershipVerified: true, loaded: false, special: false, ancestorsReparseFree: true, leafReparseFree: true,
      atomicExpectationVerified: true, nativeIdentityVerified: true }),
    enableAccount: ctx => proof(ctx, { ...STANDARD_ACCOUNT, enabled: true, atomicExpectationVerified: true, nativeIdentityVerified: true }),
    verifyProvisionedState: ctx => proof(ctx, { ...STANDARD_ACCOUNT, bindingVerified: true, profileVerified: true, enabled: ctx.expectedEnabled })
  };
  const mutations = new Set(['writeJournal', 'persistBinding', 'fenceAccount', 'shutdownAccount', 'purgeProfile',
    'deleteAccount', 'createDisabledAccount', 'createProfile', 'enableAccount']);
  for (const name of REQUIRED_ADAPTERS) {
    const original = adapters[name];
    adapters[name] = ctx => { calls.push({ name, ctx }); if (mutations.has(name)) effects.push(name); return original(ctx); };
  }
  const build = () => createHelperResetController({ adapters, timers, now: () => timers.now, stepTimeoutMs: 10 });
  const controller = build();
  const workflow = async ctx => { calls.push({ name: 'workflow', ctx }); assert.equal(state.held, true); return proof(ctx, { verified: true }); };
  return { controller, build, adapters, state, calls, effects, timers, workflow, proof, admission,
    run: (request = REQUEST, next = workflow) => controller.run(request, next) };
}

function consent() {
  return { id: 'consent-a', confirmed: true, scope: 'purge-exact-local-user1', operationId: 'repair-a',
    generation: 1, machineId: 'machine-a', accountSid: OLD_SID, profilePath: TARGET_PROFILE };
}
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failed++; console.error(`FAIL helper-reset-controller: ${name}: ${error.message}`); }
}
async function ticks() { for (let n = 0; n < 20; n++) await Promise.resolve(); }

(async () => {
  const originalLoad = Module._load;
  const restores = [];
  const denied = new Set(['fs', 'fs/promises', 'child_process', 'os', 'electron', 'net', 'http', 'https', 'worker_threads']);
  Module._load = function (name, parent, main) {
    if (denied.has(name.replace(/^node:/, ''))) { nativeAttempts.push(name); throw new Error('native import denied'); }
    return originalLoad.call(this, name, parent, main);
  };
  for (const [object, key] of [[process, 'kill'], [process, 'exit'], [globalThis, 'setTimeout'],
    [globalThis, 'setInterval'], [globalThis, 'fetch']]) {
    const original = object[key];
    object[key] = () => { nativeAttempts.push(key); throw new Error('native API denied'); };
    restores.push(() => { object[key] = original; });
  }
  try {
    ({ createHelperResetController, REQUIRED_ADAPTERS, TARGET_PROFILE } = require('../src/main/helper-reset-controller'));
    await test('every native adapter is mandatory and no missing adapter starts work', () => {
      for (const name of REQUIRED_ADAPTERS) {
        const f = fixture(); delete f.adapters[name];
        assert.throws(f.build, new RegExp(name)); assert.equal(f.effects.length, 0);
      }
      const f = fixture(); f.adapters.capabilities.atomicIdentityExpectation = false;
      assert.throws(f.build, /atomic/); assert.equal(f.effects.length, 0);
    });
    await test('fresh creation bypasses teardown and binds disabled SID before profile or enable', async () => {
      const f = fixture(); const result = await f.run();
      assert.equal(result.status, 'workflow-verified'); assert.equal(result.accountSid, NEW_SID);
      assert.deepEqual(result.reset,{previousProfile:'absent',oldProfileAbsent:true,oldRegistrationAbsent:true,recreated:true});
      for (const name of ['fenceAccount', 'shutdownAccount', 'captureResetSnapshot', 'purgeProfile', 'deleteAccount']) {
        assert.equal(f.calls.some(call => call.name === name), false);
      }
      const names = f.calls.map(call => call.name);
      assert.ok(names.indexOf('writeJournal') < names.indexOf('createDisabledAccount'));
      assert.ok(names.indexOf('createDisabledAccount') < names.indexOf('persistBinding'));
      assert.ok(names.indexOf('persistBinding') < names.indexOf('createProfile'));
      assert.ok(names.indexOf('createProfile') < names.indexOf('enableAccount'));
      assert.equal(f.state.journal.unresolved, false); assert.equal(f.state.held, false);
      assert.equal(f.timers.jobs.size, 0);
    });
    await test('bound existing reset proves full purge before deletion and recreation', async () => {
      const f = fixture('bound-existing'); const result = await f.run();
      assert.equal(result.status, 'workflow-verified');
      assert.deepEqual(result.reset,{previousProfile:'purged',oldProfileAbsent:true,oldRegistrationAbsent:true,recreated:true});
      const names = f.calls.map(call => call.name);
      assert.ok(names.indexOf('fenceAccount') < names.indexOf('shutdownAccount'));
      assert.ok(names.indexOf('shutdownAccount') < names.indexOf('captureResetSnapshot'));
      assert.ok(names.indexOf('captureResetSnapshot') < names.indexOf('purgeProfile'));
      assert.ok(names.indexOf('purgeProfile') < names.indexOf('deleteAccount'));
      assert.ok(names.indexOf('deleteAccount') < names.indexOf('createDisabledAccount'));
      for (const name of ['fenceAccount', 'shutdownAccount', 'purgeProfile', 'deleteAccount',
        'createDisabledAccount', 'persistBinding', 'createProfile', 'enableAccount']) {
        const index = names.indexOf(name);
        assert.equal(names[index - 1], 'revalidateEffect', name + ' needs immediate native precondition checking');
      }
    });
    await test('authorized operator-target migration binds before any account or process change', async () => {
      const f = fixture('operator-target'); const result = await f.run({ ...REQUEST, consent: consent() });
      assert.equal(result.status, 'workflow-verified');
      const names = f.calls.map(call => call.name);
      assert.ok(names.indexOf('verifyOperatorTarget') < names.indexOf('persistBinding'));
      assert.ok(names.indexOf('persistBinding') < names.indexOf('fenceAccount'));
      const firstBind = f.calls.find(call => call.name === 'persistBinding');
      assert.equal(firstBind.ctx.operation.accountSid, OLD_SID); assert.equal(firstBind.ctx.consent.confirmed, true);
    });
    for (const kind of ['legacy-unbound', 'unknown', 'name-match-only']) await test(kind + ' makes no account/process effects', async () => {
      const f = fixture(kind); const result = await f.run();
      assert.equal(result.status, 'blocked'); assert.equal(f.effects.length, 0); assert.equal(f.state.held, false);
    });
    for (const change of [c => { c.confirmed = false; }, c => { c.accountSid = NEW_SID; },
      c => { c.profilePath = 'C:\\Users\\operator'; }, c => { c.operationId = 'another'; },
      c => { c.generation = 2; }, c => { c.machineId = 'another'; }, c => { c.scope = 'launch-only'; }]) {
      await test('operator target requires exact scoped purge consent', async () => {
        const f = fixture('operator-target'); const c = consent(); change(c);
        assert.equal((await f.run({ ...REQUEST, consent: c })).status, 'blocked'); assert.equal(f.effects.length, 0);
      });
    }
    await test('historical binding absence alone does not replace verified operator consent', async () => {
      const f = fixture('operator-target');
      assert.equal((await f.run()).reason, 'target_consent_unverified'); assert.equal(f.effects.length, 0);
    });
    for (const [field, value] of [['currentUserProtected', false], ['accountSid', 'S-1-5-18'],
      ['currentUserSid', OLD_SID], ['isLocal', false], ['profilePath', 'C:\\Users\\operator'],
      ['profileOwnershipVerified', false], ['ancestorsReparseFree', false], ['leafReparseFree', false],
      ['special', true], ['registeredSid', NEW_SID]]) await test('unsafe bound admission ' + field, async () => {
      const f = fixture('bound-existing');
      f.adapters.inspectAdmission = ctx => ({ ...f.admission(ctx, 'bound-existing'), [field]: value });
      assert.equal((await f.run()).status, 'blocked'); assert.equal(f.effects.length, 0);
    });
    for (const [field, value] of [['accountExists', true], ['profileExists', true], ['registeredProfileCount', 1],
      ['unknownProfileCount', 1], ['accountLookupComplete', false], ['profileNamespaceVerified', false]]) {
      await test('fresh absence cannot be inferred from ' + field, async () => {
        const f = fixture(); f.adapters.revalidateAdmission = ctx => ({ ...f.admission(ctx, 'fresh-absent'), [field]: value });
        assert.equal((await f.run()).status, 'blocked'); assert.equal(f.effects.includes('createDisabledAccount'), false);
      });
    }
    await test('unresolved prior journal blocks before admission and all effects', async () => {
      const f = fixture(); f.state.journal = { phase: 'purging-profile', unresolved: true };
      assert.equal((await f.run()).reason, 'interrupted_run_unresolved'); assert.equal(f.effects.length, 0);
      assert.equal(f.calls.some(call => call.name === 'inspectAdmission'), false);
      assert.equal(f.controller.hasUnresolvedRun(), true);
    });
    await test('unknown lease acquisition acknowledgement blocks retry without any account effect', async () => {
      const f = fixture(); f.adapters.acquireLease = () => ({ status: 'held', exclusive: true });
      assert.equal((await f.run()).reason, 'writer_lease_unverified');
      assert.equal(f.controller.hasUnresolvedRun(), true); assert.equal(f.effects.length, 0);
      assert.equal((await f.run()).reason, 'repair_recovery_required');
    });
    await test('positively refused busy lease causes no native effects', async () => {
      const f = fixture(); f.state.held = true;
      assert.equal((await f.run()).reason, 'writer_lease_busy');
      assert.equal(f.effects.length, 0); assert.equal(f.controller.hasUnresolvedRun(), false);
    });
    await test('prior unfinished journal remains blocking after controller recreation', async () => {
      const f = fixture(); f.state.journal = { phase: 'creating-account', unresolved: true };
      const first = await f.run(); assert.equal(first.unresolved, true); assert.equal(f.state.held, false);
      const restarted = f.build(); const result = await restarted.run(REQUEST, f.workflow);
      assert.equal(result.reason, 'interrupted_run_unresolved'); assert.equal(result.unresolved, true);
      assert.equal(f.effects.length, 0);
    });
    for (const path of [TARGET_PROFILE, 'C:\\Users\\USER1\\child', 'C:\\Users', 'C:\\']) {
      await test('overlapping current profile prevents any target effect', async () => {
        const f = fixture('bound-existing');
        f.adapters.inspectAdmission = ctx => ({ ...f.admission(ctx, 'bound-existing'), currentUserProfilePath: path });
        assert.equal((await f.run()).status, 'blocked'); assert.equal(f.effects.length, 0);
      });
    }
    await test('active own journal is not silently projected as a resolved policy record', async () => {
      const f = fixture('bound-existing'); const original = f.adapters.captureResetSnapshot;
      f.adapters.captureResetSnapshot = ctx => { const s = original(ctx); delete s.probes.journal.currentOperationOwned; return s; };
      assert.equal((await f.run()).reason, 'reset_journal_ownership_unverified');
      assert.equal(f.effects.includes('purgeProfile'), false); assert.equal(f.state.journal.unresolved, true);
    });
    await test('loaded profile policy failure never purges or creates', async () => {
      const f = fixture('bound-existing'); const original = f.adapters.captureResetSnapshot;
      f.adapters.captureResetSnapshot = ctx => { const s = original(ctx); s.probes.profile.loaded = true; return s; };
      assert.equal((await f.run()).reason, 'reset_policy_blocked');
      assert.equal(f.effects.includes('purgeProfile'), false); assert.equal(f.effects.includes('createDisabledAccount'), false);
      assert.equal(f.controller.hasUnresolvedRun(), true); assert.equal(f.state.held, true);
    });
    await test('a policy-ready snapshot for another root cannot authorize canonical target purge', async () => {
      const f = fixture('bound-existing'); const original = f.adapters.captureResetSnapshot;
      f.adapters.captureResetSnapshot = ctx => {
        const s = original(ctx); s.probes.profile.path = 'D:\\Profiles\\user1';
        s.probes.profile.registeredPath = 'D:\\Profiles\\user1'; s.probes.profile.profilesRoot = 'D:\\Profiles'; return s;
      };
      assert.equal((await f.run()).reason, 'reset_profile_scope_mismatch');
      assert.equal(f.effects.includes('purgeProfile'), false); assert.equal(f.effects.includes('createDisabledAccount'), false);
    });
    for (const [field, value] of [['purgeComplete', false], ['remainingOwnedPaths', 1], ['unknownPaths', 1],
      ['profileFolderAbsent', false], ['profileRegistrationAbsent', false]]) await test('purge residue blocks account removal and fresh setup: ' + field, async () => {
      const f = fixture('bound-existing'); const original = f.adapters.purgeProfile;
      f.adapters.purgeProfile = ctx => ({ ...original(ctx), [field]: value });
      assert.equal((await f.run()).reason, 'profile_purge_incomplete');
      assert.equal(f.effects.includes('deleteAccount'), false); assert.equal(f.effects.includes('createDisabledAccount'), false);
      assert.equal(f.controller.hasUnresolvedRun(), true); assert.equal(f.state.journal.unresolved, true);
    });
    await test('effect-time native identity refusal prevents purge despite prior pure readiness', async () => {
      const f = fixture('bound-existing'); const original = f.adapters.revalidateEffect;
      f.adapters.revalidateEffect = ctx => ({ ...original(ctx), preconditionsVerified: ctx.effect !== 'purgeProfile' });
      assert.equal((await f.run()).reason, 'native_effect_preconditions_unverified');
      assert.equal(f.effects.includes('purgeProfile'), false); assert.equal(f.state.held, true);
    });
    await test('SID replacement at effect-time prevents touching the substituted identity', async () => {
      const f = fixture('bound-existing'); const original = f.adapters.revalidateEffect;
      f.adapters.revalidateEffect = ctx => ({ ...original(ctx),
        accountSid: ctx.effect === 'purgeProfile' ? NEW_SID : ctx.operation.accountSid });
      assert.equal((await f.run()).reason, 'native_effect_preconditions_unverified');
      assert.equal(f.effects.includes('purgeProfile'), false);
    });
    await test('journal write failure before create latches recovery and never creates', async () => {
      const f = fixture(); f.adapters.writeJournal = () => { throw new Error('synthetic persistence failure'); };
      assert.equal((await f.run()).status, 'blocked'); assert.equal(f.effects.includes('createDisabledAccount'), false);
      assert.equal(f.controller.hasUnresolvedRun(), true); assert.equal(f.state.held, true);
      const count = f.calls.length; assert.equal((await f.run()).reason, 'repair_recovery_required'); assert.equal(f.calls.length, count);
    });
    await test('binding failure leaves created account disabled and never creates profile or enables', async () => {
      const f = fixture(); f.adapters.persistBinding = ctx => f.proof(ctx, { persisted: false,
        storageProtected: true, ownerVerified: true, atomicExpectationVerified: true, nativeIdentityVerified: true });
      assert.equal((await f.run()).reason, 'managed_binding_persistence_unverified');
      assert.equal(f.effects.includes('createProfile'), false); assert.equal(f.effects.includes('enableAccount'), false);
      assert.equal(f.state.journal.unresolved, true); assert.equal(f.state.held, true);
    });
    await test('main authorization receives the freshly admitted exact SID before any binding or shutdown', async () => {
      const f = fixture('operator-target');
      let admitted;
      const controller = createHelperResetController({ adapters: f.adapters, now: () => f.timers.now,
        timers: f.timers, stepTimeoutMs: 10, authorizeTarget: ctx => {
          admitted = ctx;
          assert.equal(f.effects.length, 0);
          return { id: 'consent-a', confirmed: true, scope: 'purge-exact-local-user1',
            operationId: ctx.operation.id, generation: ctx.operation.generation, machineId: ctx.operation.machineId,
            accountSid: ctx.operation.accountSid, profilePath: ctx.profilePath };
        } });
      const result = await controller.run(REQUEST, async ctx => f.proof(ctx, { verified: true }));
      assert.equal(admitted.operation.accountSid, OLD_SID);
      assert.equal(result.status, 'workflow-verified');
      assert.ok(f.effects.includes('purgeProfile'));
    });
    for (const consentResult of [null, {confirmed:true}, {id:'consent-a',confirmed:true,scope:'purge-exact-local-user1',
      operationId:'repair-a',generation:1,machineId:'machine-a',accountSid:NEW_SID,profilePath:'C:\\Users\\user1'}]) {
      await test('missing or mismatched dynamic authorization invokes no native effect', async () => {
        const f = fixture('operator-target');
        const controller = createHelperResetController({ adapters: f.adapters, now: () => f.timers.now,
          timers: f.timers, stepTimeoutMs: 10, authorizeTarget: () => consentResult });
        const result = await controller.run(REQUEST, async ctx => f.proof(ctx, { verified: true }));
        assert.equal(result.reason, 'target_consent_unverified');
        assert.equal(f.effects.length, 0);
        assert.equal(f.state.held, false);
      });
    }
    await test('same-instance concurrent invocation cannot acquire another writer lease', async () => {
      const f = fixture(); let release;
      f.adapters.inspectAdmission = ctx => new Promise(resolve => { release = () => resolve(f.admission(ctx, 'fresh-absent')); });
      const first = f.run(); await ticks(); assert.equal(f.controller.isRunning(), true);
      const before = f.calls.length; assert.equal((await f.run()).reason, 'repair_already_running'); assert.equal(f.calls.length, before);
      release(); assert.equal((await first).status, 'workflow-verified');
    });
    await test('native adapter timeout is bounded without releasing uncertain lease', async () => {
      const f = fixture(); f.adapters.createDisabledAccount = () => new Promise(() => {});
      const promise = f.run();
      for (let n = 0; n < 20 && f.state.journal.phase !== 'creating-account'; n++) await ticks();
      await ticks(); f.timers.tick(10); const result = await promise;
      assert.equal(result.reason, 'native_step_timeout'); assert.equal(result.unresolved, true);
      assert.equal(f.state.held, true); assert.equal(f.controller.hasUnresolvedRun(), true);
      assert.equal(f.timers.jobs.size, 0);
    });
    for (const lateOutcome of ['fulfill', 'reject']) await test('late creation ' + lateOutcome + ' cannot resume a timed-out transaction', async () => {
      const f = fixture(); let pending;
      f.adapters.createDisabledAccount = ctx => new Promise((resolve, reject) => { pending = { ctx, resolve, reject }; });
      const promise = f.run();
      for (let n = 0; n < 30 && !pending; n++) await ticks();
      assert.ok(pending, 'fixture must reach the deferred native effect');
      f.timers.tick(10); assert.equal((await promise).reason, 'native_step_timeout');
      const count = f.calls.length;
      if (lateOutcome === 'fulfill') pending.resolve(f.proof(pending.ctx, { created: true, disabled: true,
        isLocal: true, accountName: 'user1', accountSid: NEW_SID, currentUserSid: 'S-1-5-21-111-222-333-1002',
        currentUserProtected: true, atomicExpectationVerified: true, nativeIdentityVerified: true }));
      else pending.reject(new Error('synthetic late rejection'));
      await ticks(); assert.equal(f.calls.length, count);
      for (const name of ['persistBinding', 'createProfile', 'enableAccount', 'workflow', 'releaseLease']) {
        assert.equal(f.calls.some(call => call.name === name), false, name + ' cannot continue after timeout');
      }
      assert.equal(f.controller.hasUnresolvedRun(), true); assert.equal(f.state.held, true);
      assert.equal((await f.run()).reason, 'repair_recovery_required'); assert.equal(f.calls.length, count);
    });
    await test('late lease acknowledgement after acquisition timeout cannot start journal or admission work', async () => {
      const f = fixture(); let pending;
      f.adapters.acquireLease = ctx => new Promise(resolve => { pending = { ctx, resolve }; });
      const promise = f.run(); await ticks(); assert.ok(pending);
      f.timers.tick(10); assert.equal((await promise).reason, 'native_step_timeout');
      const count = f.calls.length; f.state.held = true;
      pending.resolve({ status: 'held', scope: 'machine', exclusive: true, nonce: 'lease-a', machineVerified: true,
        machineId: 'machine-a', machineSid: MACHINE_SID, operationId: 'repair-a', generation: 1,
        acquiredAtMs: 900, expiresAtMs: 100000 });
      await ticks(); assert.equal(f.calls.length, count); assert.equal(f.effects.length, 0);
      assert.equal(f.controller.hasUnresolvedRun(), true); assert.equal(f.state.held, true);
      assert.equal((await f.run()).reason, 'repair_recovery_required');
    });
    await test('workflow deadline revokes authority before late completion can dispatch another step', async () => {
      const f = fixture();
      let resume;
      let workflowContext;
      let followups = 0;
      const retained = [];
      f.adapters.onAuthorityLost = value => retained.push(value);
      const running = f.run(REQUEST, async ctx => {
        workflowContext = ctx;
        await new Promise(resolve => { resume = resolve; });
        if (ctx.signal.aborted) return f.proof(ctx, { verified: false });
        ++followups;
        return f.proof(ctx, { verified: true });
      });
      for (let n = 0; n < 40 && !resume; n++) await ticks();
      assert.ok(resume, 'positive fixture reaches the active workflow');
      assert.equal(workflowContext.signal.aborted, false);
      f.timers.tick(10);
      const result = await running;
      assert.equal(result.reason, 'native_step_timeout');
      assert.equal(workflowContext.signal.aborted, true);
      assert.equal(result.unresolved, true);
      assert.equal(f.state.held, true);
      assert.equal(retained.length, 1);
      resume(); await ticks();
      assert.equal(followups, 0);
      assert.equal(f.state.journal.unresolved, true);
      assert.equal(f.state.journal.phase, 'application-workflow');
    });
    await test('completed workflow contexts cannot be reused after lease release', async () => {
      const f = fixture();
      let saved;
      const result = await f.run(REQUEST, async ctx => { saved = ctx; return f.proof(ctx, { verified: true }); });
      assert.equal(result.status, 'workflow-verified');
      assert.equal(saved.signal.aborted, true);
      assert.equal(f.state.held, false);
    });
    await test('unverified downstream workflow cannot clear the journal or release its lease', async () => {
      const f = fixture(); assert.equal((await f.run(REQUEST, async () => ({ verified: false }))).reason, 'application_workflow_unverified');
      assert.equal(f.state.journal.phase, 'application-workflow'); assert.equal(f.state.journal.unresolved, true);
      assert.equal(f.state.held, true);
    });
    for (const [label, change] of [
      ['bare boolean assertion', () => ({ verified: true })],
      ['foreign operation', value => ({ ...value, operationId: 'other-operation' })],
      ['foreign SID', value => ({ ...value, accountSid: OLD_SID })],
      ['foreign lease', value => ({ ...value, leaseNonce: 'other-lease' })],
      ['stale receipt', value => ({ ...value, capturedAtMs: 1 })],
      ['different profile', value => ({ ...value, profilePath: 'C:\\Users\\operator' })]
    ]) await test('workflow receipt rejects ' + label, async () => {
      const f = fixture();
      const result = await f.run(REQUEST, async ctx => change(f.proof(ctx, { verified: true })));
      assert.equal(result.reason, 'application_workflow_unverified');
      assert.equal(f.state.journal.unresolved, true); assert.equal(f.state.held, true);
    });
    for (const boundary of ['createDisabledAccount', 'enableAccount', 'verifyProvisionedState']) {
      for (const [field, invalid] of [['usersGroupSid','S-1-5-32-544'], ['usersMembershipVerified',false],
        ['administratorsExcluded',false], ['groupEnumerationComplete',false], ['standardAccountVerified',false],
        ['membershipProofKind','localized-name']]) {
        for (const missing of [false, true]) await test('unsafe Standard role blocks ' + boundary + ': ' + field + (missing ? ' missing' : ' invalid'), async () => {
          const f = fixture(), original = f.adapters[boundary];
          f.adapters[boundary] = ctx => {
            const proof = original(ctx);
            if (missing) delete proof[field]; else proof[field] = invalid;
            return proof;
          };
          const result = await f.run();
          assert.equal(result.reason, 'standard_account_unverified');
          assert.equal(result.unresolved, true);
          assert.equal(f.calls.some(call => call.name === 'workflow'), false);
          assert.equal(f.calls.some(call => call.name === 'releaseLease'), false);
          assert.notEqual(f.state.journal.phase, 'complete');
          if (boundary === 'createDisabledAccount') assert.equal(f.effects.includes('createProfile'), false);
          if (boundary !== 'enableAccount') assert.equal(f.effects.includes('enableAccount'), false);
        });
      }
    }
    await test('final Standard-role regression cannot finish the journal or release custody', async () => {
      const f = fixture(), original = f.adapters.verifyProvisionedState;
      f.adapters.verifyProvisionedState = ctx => ({ ...original(ctx), administratorsExcluded: ctx.expectedEnabled !== true });
      assert.equal((await f.run()).reason, 'standard_account_unverified');
      assert.equal(f.calls.some(call => call.name === 'workflow'), true);
      assert.notEqual(f.state.journal.phase, 'complete');
      assert.equal(f.state.held, true);
    });
    await test('there is no service restart or arbitrary-path cleanup fallback', async () => {
      const f = fixture('unknown');
      f.adapters.restartService = () => { throw new Error('must not be used'); };
      f.adapters.deleteFolder = () => { throw new Error('must not be used'); };
      await f.run(); assert.equal(f.effects.length, 0); assert.deepEqual(nativeAttempts, []);
    });
  } finally {
    Module._load = originalLoad; for (const restore of restores.reverse()) restore();
  }
  console.log(`helper-reset-controller-smoke: ${passed} passed, ${failed} failed; inert adapters only`);
  if (failed) process.exitCode = 1;
  harnessFinished = true;
})().catch(error => {
  console.error('FAIL helper-reset-controller harness:', error.message);
  process.exitCode = 1; harnessFinished = true;
});
