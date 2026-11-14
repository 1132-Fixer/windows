'use strict';

// No native implementation lives here. Every adapter below must enforce its
// supplied identity/absence expectation atomically at the native effect, not
// merely trust an earlier JS decision. No name sweep, ACL takeover, service
// restart, rollback deletion, or generic filesystem-delete adapter is accepted.
//
// run(request, workflow) holds the machine lease through the supplied remaining
// application workflow. workflow receives the new bound SID and must return
// a fresh scoped { status:'verified', complete:true, verified:true, ... } receipt;
// a partial, stale or foreign result leaves the durable journal unresolved.
// The reset snapshot's journal probe reconciles PRIOR/unowned interruptions;
// it must separately prove ownership of this run's still-pending durable phase.
const { evaluateHelperResetSafety, MAX_AGE_MS } = require('./helper-reset-safety');
const windowsPath = require('node:path').win32;

const TARGET_ACCOUNT = 'user1';
const TARGET_PROFILE = 'C:\\Users\\user1';
const DEFAULT_STEP_TIMEOUT_MS = 30000;
const REQUIRED_ADAPTERS = Object.freeze([
  'acquireLease', 'releaseLease', 'readJournal', 'inspectAdmission', 'revalidateAdmission',
  'writeJournal', 'verifyOperatorTarget', 'revalidateEffect', 'persistBinding',
  'fenceAccount', 'shutdownAccount', 'captureResetSnapshot', 'purgeProfile',
  'deleteAccount', 'createDisabledAccount', 'createProfile', 'enableAccount',
  'verifyProvisionedState'
]);

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const samePath = value => typeof value === 'string' && value.toLowerCase() === TARGET_PROFILE.toLowerCase();
// Account creation/enabling is insufficient evidence of a usable Standard
// helper. Require the Native adapter's complete raw-SID membership readback at
// each boundary; a group name, partial enumeration or filtered admin token
// cannot authorize profile creation, launch or a completed journal.
const standardAccount = value => value.usersGroupSid === 'S-1-5-32-545' &&
  value.usersMembershipVerified === true && value.administratorsExcluded === true &&
  value.groupEnumerationComplete === true && value.standardAccountVerified === true &&
  value.membershipProofKind === 'raw-local-sid';
function currentProfileProtected(value) {
  if (value.currentUserProfilePathVerified !== true || typeof value.currentUserProfilePath !== 'string' ||
      !/^[A-Za-z]:\\/.test(value.currentUserProfilePath)) return false;
  const current = windowsPath.normalize(value.currentUserProfilePath).replace(/\\+$/, '').toLowerCase();
  const target = TARGET_PROFILE.toLowerCase();
  return target !== current && !target.startsWith(current + '\\') && !current.startsWith(target + '\\');
}
function localSid(value, machineSid) {
  if (typeof machineSid !== 'string' || !/^S-1-5-21-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)-(?:0|[1-9]\d*)$/.test(machineSid)) return false;
  if (!machineSid.split('-').slice(4).every(part => Number(part) <= 0xffffffff)) return false;
  if (typeof value !== 'string' || !value.startsWith(machineSid + '-')) return false;
  const rid = value.slice(machineSid.length + 1);
  return /^(?:0|[1-9]\d*)$/.test(rid) && Number(rid) >= 1000 && Number(rid) <= 0xffffffff;
}
function failure(stage, code) {
  const error = new Error(code);
  error.stage = stage;
  error.code = code;
  return error;
}

function createHelperResetController(options = {}) {
  const adapters = options.adapters;
  if (!record(adapters)) throw new TypeError('native adapters are required');
  for (const name of REQUIRED_ADAPTERS) {
    if (typeof adapters[name] !== 'function') throw new TypeError('Missing native adapter: ' + name);
  }
  if (adapters.onAuthorityLost !== undefined && typeof adapters.onAuthorityLost !== 'function') {
    throw new TypeError('Invalid authority-loss observer');
  }
  if (!record(adapters.capabilities) || adapters.capabilities.atomicIdentityExpectation !== true ||
      adapters.capabilities.exclusiveProfileCreation !== true || adapters.capabilities.completePurgeReadback !== true) {
    throw new TypeError('Native atomic identity, exclusive creation and purge-readback capabilities are required');
  }
  if (typeof options.now !== 'function') throw new TypeError('An explicit clock is required');
  if (options.authorizeTarget !== undefined && typeof options.authorizeTarget !== 'function') {
    throw new TypeError('Invalid exact-target authorization adapter');
  }
  const timeoutMs = options.stepTimeoutMs === undefined ? DEFAULT_STEP_TIMEOUT_MS : options.stepTimeoutMs;
  if (!positive(timeoutMs) || timeoutMs > 0x7fffffff) throw new TypeError('Invalid step deadline');
  const timers = options.timers || { setTimeout, clearTimeout };
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw new TypeError('Invalid timer adapter');
  let running = false;
  let unresolved = false;

  async function run(request, workflow) {
    if (running) return { status: 'blocked', reason: 'repair_already_running', unresolved: true };
    if (unresolved) return { status: 'blocked', reason: 'repair_recovery_required', unresolved: true };
    if (!record(request) || !id(request.operationId) || !positive(request.generation) ||
        !id(request.machineId) || (request.accountName !== undefined && request.accountName !== TARGET_ACCOUNT) ||
        typeof workflow !== 'function') return { status: 'blocked', reason: 'invalid_request', unresolved: false };
    running = true;
    let lease = null;
    let retainLease = false;
    let result;
    let previousProfile = 'absent';
    let stage = 'acquireLease';
    const authority = new AbortController();
    let retentionNotified = false;
    let op = {
      id: request.operationId, generation: request.generation, machineId: request.machineId,
      accountName: TARGET_ACCOUNT, accountSid: null
    };
    const clock = () => {
      const value = options.now();
      if (!positive(value)) throw failure(stage, 'invalid_clock');
      return value;
    };
    const context = extra => Object.freeze({
      operation: Object.freeze({ ...op }), lease: lease && Object.freeze({ ...lease }),
      profilePath: TARGET_PROFILE, ...extra
    });
    function loseAuthority(error, retainNative) {
      if (!authority.signal.aborted) authority.abort(error && error.code || 'repair_authority_lost');
      if (retainNative && !retentionNotified) {
        retentionNotified = true;
        try {
          if (adapters.onAuthorityLost) adapters.onAuthorityLost(context({ reason: 'controller_authority_lost' }));
        } catch (_) { /* An observer cannot make uncertain native work safe. */ }
      }
    }
    async function call(name, extra = {}, fn = adapters[name]) {
      stage = name;
      clock();
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => fn.call(adapters, context(extra))).catch(error => {
            loseAuthority(error, true);
            throw error;
          }),
          new Promise((resolve, reject) => {
            timer = timers.setTimeout(() => {
              const error = failure(name, 'native_step_timeout');
              loseAuthority(error, true);
              reject(error);
            }, timeoutMs);
          })
        ]);
      } finally { if (timer !== undefined) timers.clearTimeout(timer); }
    }
    function scoped(value, status = 'verified', accountSid = op.accountSid) {
      const now = clock();
      return record(value) && value.status === status && value.complete === true &&
        value.operationId === op.id && value.generation === op.generation &&
        value.machineId === op.machineId && value.leaseNonce === op.leaseNonce &&
        (!accountSid || value.accountSid === accountSid) && positive(value.capturedAtMs) &&
        value.capturedAtMs >= lease.acquiredAtMs && value.capturedAtMs <= now &&
        now - value.capturedAtMs < MAX_AGE_MS && lease.expiresAtMs > now;
    }
    function requireProof(condition, code) { if (!condition) throw failure(stage, code); }
    async function journal(phase, resolved = false) {
      // Set before dispatch: an interrupted or refused persistence operation is
      // uncertain, even when the adapter never returned its acknowledgement.
      retainLease = true;
      const proof = await call('writeJournal', { phase, unresolved: !resolved });
      requireProof(scoped(proof, 'persisted') && proof.storageProtected === true &&
        proof.phase === phase && proof.unresolved === !resolved, 'journal_persistence_unverified');
    }
    function admission(value, kind) {
      if (!scoped(value, 'verified', null) || value.kind !== kind || value.accountName !== TARGET_ACCOUNT ||
          value.isLocal !== true || value.currentUserProtected !== true || value.profileOwnershipVerified !== true ||
          typeof value.currentUserSid !== 'string' || !/^S-1-\d+(?:-\d+)+$/.test(value.currentUserSid) ||
          !currentProfileProtected(value) ||
          value.profileNamespaceVerified !== true || value.ancestorsReparseFree !== true ||
          value.profilesRootVerified !== true || typeof value.profilesRoot !== 'string' ||
          value.profilesRoot.toLowerCase() !== 'c:\\users' || !samePath(value.profilePath)) return false;
      if (kind === 'fresh-absent') return value.accountExists === false && value.accountLookupComplete === true &&
        value.profileExists === false && value.registeredProfileCount === 0 && value.unknownProfileCount === 0;
      return value.accountExists === true && value.builtin === false && value.protected === false &&
        localSid(value.accountSid, op.machineSid) && value.currentUserSid !== value.accountSid &&
        typeof value.currentUserSid === 'string' && /^S-1-\d+(?:-\d+)+$/.test(value.currentUserSid) &&
        value.profileExists === true && value.registeredSid === value.accountSid && samePath(value.registeredPath) && value.special === false &&
        value.leafReparseFree === true && typeof value.enabled === 'boolean';
    }
    function bound(value) {
      return record(value.binding) && value.binding.verified === true && value.binding.storageProtected === true &&
        value.binding.ownerVerified === true && value.binding.accountSid === value.accountSid &&
        value.binding.machineId === op.machineId && value.binding.machineSid === op.machineSid &&
        value.binding.accountName === TARGET_ACCOUNT && samePath(value.binding.profilePath);
    }
    async function effect(name, expectation, extra = {}) {
      const expected = Object.freeze({ accountSid: op.accountSid, accountName: TARGET_ACCOUNT,
        profilePath: TARGET_PROFILE, state: expectation });
      const check = await call('revalidateEffect', { effect: name, expected, ...extra });
      requireProof(scoped(check) && check.effect === name && check.expectation === expectation &&
        (op.accountSid !== null || check.accountSid === null) &&
        check.nativeIdentityVerified === true && check.preconditionsVerified === true &&
        check.atomicExpectationVerified === true && samePath(check.profilePath), 'native_effect_preconditions_unverified');
      const proof = await call(name, { expected, ...extra });
      requireProof(scoped(proof, 'verified', name === 'createDisabledAccount' ? null : op.accountSid) &&
        proof.atomicExpectationVerified === true && proof.nativeIdentityVerified === true &&
        samePath(proof.profilePath), 'native_effect_unverified');
      return proof;
    }
    async function bind(source, consent) {
      await journal('binding-account');
      const proof = await effect('persistBinding', source === 'created' ? 'disabled-account-profile-absent' : 'verified-operator-target', { source, consent });
      requireProof(proof.persisted === true && proof.storageProtected === true && proof.ownerVerified === true,
        'managed_binding_persistence_unverified');
    }
    async function verify(enabled) {
      const proof = await call('verifyProvisionedState', { expectedEnabled: enabled });
      requireProof(scoped(proof) && proof.bindingVerified === true && proof.profileVerified === true &&
        proof.enabled === enabled && samePath(proof.profilePath), 'provisioned_state_unverified');
      requireProof(standardAccount(proof), 'standard_account_unverified');
    }
    try {
      // Acquisition can itself have an uncertain outcome; do not start a
      // second attempt when its acknowledgement is missing or malformed.
      retainLease = true;
      const acquired = await call('acquireLease');
      if (record(acquired) && acquired.status === 'busy' && acquired.complete === true && acquired.acquired === false) {
        retainLease = false;
        throw failure(stage, 'writer_lease_busy');
      }
      requireProof(record(acquired) && acquired.status === 'held' && acquired.scope === 'machine' &&
        acquired.exclusive === true && acquired.operationId === op.id && acquired.generation === op.generation &&
        acquired.machineId === op.machineId && acquired.machineVerified === true && id(acquired.nonce) &&
        positive(acquired.acquiredAtMs) && acquired.acquiredAtMs <= clock() &&
        positive(acquired.expiresAtMs) && acquired.expiresAtMs > clock() &&
        localSid(acquired.machineSid + '-1000', acquired.machineSid), 'writer_lease_unverified');
      lease = Object.freeze({ ...acquired });
      op = { ...op, machineSid: lease.machineSid, leaseNonce: lease.nonce };
      retainLease = false;
      const previous = await call('readJournal');
      requireProof(scoped(previous, 'verified', null) && previous.storageProtected === true &&
        previous.unresolved === false && ['none', 'complete'].includes(previous.phase), 'interrupted_run_unresolved');
      let entry = await call('inspectAdmission');
      requireProof(scoped(entry, 'verified', null), 'admission_unverified');
      if (entry.kind === 'fresh-absent') {
        requireProof(admission(entry, 'fresh-absent'), 'fresh_namespace_unverified');
      } else if (entry.kind === 'bound-existing' || entry.kind === 'operator-target') {
        requireProof(admission(entry, entry.kind), 'target_identity_unverified');
        op = { ...op, accountSid: entry.accountSid };
        if (entry.kind === 'operator-target') {
          const consent = options.authorizeTarget
            ? await call('authorizeOperatorTarget', {}, options.authorizeTarget)
            : request.consent;
          requireProof(record(consent) && id(consent.id) && consent.confirmed === true &&
            consent.scope === 'purge-exact-local-user1' && consent.operationId === op.id &&
            consent.generation === op.generation && consent.machineId === op.machineId &&
            consent.accountSid === op.accountSid && samePath(consent.profilePath), 'target_consent_unverified');
          const verified = await call('verifyOperatorTarget', { consent: Object.freeze({ ...consent }) });
          requireProof(scoped(verified) && verified.consentVerified === true && verified.purgeAuthorized === true &&
            verified.consentId === consent.id && samePath(verified.profilePath), 'target_consent_unverified');
          await bind('operator-target', Object.freeze({ ...consent }));
        } else requireProof(bound(entry), 'managed_binding_unverified');
        await journal('fencing-account');
        const fenced = await effect('fenceAccount', 'bound-existing-account');
        requireProof(fenced.disabled === true, 'logon_fence_unverified');
        await journal('stopping-account');
        const stopped = await effect('shutdownAccount', 'disabled-bound-account');
        requireProof(stopped.outcome === 'complete' && stopped.timedOut === false && stopped.cleanupConfirmed === true &&
          stopped.terminationConfirmed === true && stopped.remainingSessions === 0 && stopped.remainingProcesses === 0 &&
          stopped.unknownOwnerCount === 0, 'shutdown_unverified');
        const snapshot = await call('captureResetSnapshot');
        const expectedOp = { ...op };
        requireProof(record(snapshot) && record(snapshot.operation) &&
          Object.keys(expectedOp).every(key => snapshot.operation[key] === expectedOp[key]), 'reset_snapshot_scope_mismatch');
        const journalProbe = record(snapshot.probes) && snapshot.probes.journal;
        requireProof(record(journalProbe) && journalProbe.currentOperationOwned === true &&
          journalProbe.priorUnresolved === false && journalProbe.storageProtected === true &&
          journalProbe.durablePhase === 'stopping-account', 'reset_journal_ownership_unverified');
        const profileProbe = snapshot.probes.profile;
        requireProof(record(profileProbe) && samePath(profileProbe.path) && samePath(profileProbe.registeredPath) &&
          typeof profileProbe.profilesRoot === 'string' && profileProbe.profilesRoot.toLowerCase() === 'c:\\users',
        'reset_profile_scope_mismatch');
        const policy = evaluateHelperResetSafety(snapshot, { nowMs: clock() });
        requireProof(policy.decision === 'ready', 'reset_policy_blocked');
        await journal('purging-profile');
        const purged = await effect('purgeProfile', 'disabled-bound-account-profile-unloaded');
        requireProof(purged.purgeComplete === true && purged.remainingOwnedPaths === 0 && purged.unknownPaths === 0 &&
          purged.profileFolderAbsent === true && purged.profileRegistrationAbsent === true,
        'profile_purge_incomplete');
        await journal('deleting-account');
        const deleted = await effect('deleteAccount', 'disabled-bound-account-profile-absent');
        requireProof(deleted.accountAbsent === true && deleted.profileFolderAbsent === true &&
          deleted.profileRegistrationAbsent === true, 'account_removal_unverified');
        previousProfile = 'purged';
      } else throw failure(stage, 'managed_target_unverified');

      // This check is after any old purge/removal and immediately precedes the
      // create phase. Creation itself must enforce absence atomically as well.
      entry = await call('revalidateAdmission', { expectedKind: 'fresh-absent' });
      requireProof(admission(entry, 'fresh-absent'), 'fresh_namespace_unverified');
      const previousSid = op.accountSid;
      op = { ...op, accountSid: null };
      await journal('creating-account');
      const created = await effect('createDisabledAccount', 'account-and-profile-absent');
      requireProof(created.created === true && created.disabled === true && created.isLocal === true &&
        created.accountName === TARGET_ACCOUNT && localSid(created.accountSid, op.machineSid) &&
        created.accountSid !== previousSid && created.currentUserProtected === true &&
        typeof created.currentUserSid === 'string' && /^S-1-\d+(?:-\d+)+$/.test(created.currentUserSid) &&
        created.currentUserSid !== created.accountSid,
      'created_identity_unverified');
      requireProof(standardAccount(created), 'standard_account_unverified');
      op = { ...op, accountSid: created.accountSid };
      await bind('created');
      await journal('creating-profile');
      const profile = await effect('createProfile', 'disabled-account-profile-absent');
      requireProof(profile.created === true && profile.registeredSid === op.accountSid && profile.ownershipVerified === true &&
        profile.loaded === false && profile.special === false && profile.ancestorsReparseFree === true &&
        profile.leafReparseFree === true, 'created_profile_unverified');
      await verify(false);
      await journal('enabling-account');
      const enabled = await effect('enableAccount', 'disabled-account-owned-profile');
      requireProof(enabled.enabled === true, 'account_enable_unverified');
      requireProof(standardAccount(enabled), 'standard_account_unverified');
      await journal('application-workflow');
      const workflowResult = await call('applicationWorkflow', {}, payload =>
        workflow(Object.freeze({ ...payload, signal: authority.signal })));
      requireProof(scoped(workflowResult) && workflowResult.verified === true && samePath(workflowResult.profilePath),
        'application_workflow_unverified');
      await verify(true);
      await journal('complete', true);
      retainLease = false;
      result = { status: 'workflow-verified', accountSid: op.accountSid, profilePath: TARGET_PROFILE,
        operationId: op.id, unresolved: false, requiresNativeEvidence: true,
        reset:{previousProfile,oldProfileAbsent:true,oldRegistrationAbsent:true,recreated:true} };
    } catch (error) {
      loseAuthority(error, retainLease || (error && error.code === 'native_step_timeout'));
      if (error && error.code === 'interrupted_run_unresolved') unresolved = true;
      if (retainLease || (error && error.code === 'native_step_timeout')) {
        unresolved = true; retainLease = true;
      }
      result = { status: 'blocked', reason: error && error.code || 'native_step_failed',
        stage: error && error.stage || stage, unresolved: unresolved || retainLease,
        accountSid: op.accountSid, profilePath: TARGET_PROFILE };
    } finally {
      if (lease && !retainLease) {
        try {
          const released = await call('releaseLease');
          requireProof(scoped(released, 'released', null) && released.nonce === lease.nonce, 'lease_release_unverified');
        } catch (_) {
          unresolved = true;
          result = { status: 'blocked', reason: 'lease_release_unverified', stage: 'releaseLease', unresolved: true,
            accountSid: op.accountSid, profilePath: TARGET_PROFILE };
        }
      }
      if (!authority.signal.aborted) authority.abort('operation_complete');
      running = false;
    }
    return result;
  }

  return Object.freeze({ run, isRunning: () => running, hasUnresolvedRun: () => unresolved });
}

module.exports = { createHelperResetController, REQUIRED_ADAPTERS, TARGET_ACCOUNT, TARGET_PROFILE, DEFAULT_STEP_TIMEOUT_MS };
