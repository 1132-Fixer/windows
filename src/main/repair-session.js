'use strict';

// Product orchestration only. Native construction is injected; importing this
// file cannot start a worker, access credentials, touch disk or alter Windows.
const path = require('node:path').win32;
const { createHelperResetController, TARGET_PROFILE, TARGET_ACCOUNT, DEFAULT_STEP_TIMEOUT_MS } = require('./helper-reset-controller');
const { createProvisionedHelperFlow, STEP_NAMES } = require('./provisioned-helper-flow');
const { MAX_AGE_MS } = require('./helper-reset-safety');

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROGRESS_LABELS = Object.freeze({
  preparing: 'Preparing the repair',
  'checking-recovery': 'Checking previous repair work',
  'checking-readiness': 'Checking Zoom and repair prerequisites',
  'resetting-helper': 'Preparing the fresh helper account',
  'launch-zoom': 'Opening Zoom in the fresh profile',
  'verify-profile': 'Checking the fresh profile',
  'configure-helper': 'Applying helper settings',
  'seal-credential': 'Protecting the helper sign-in',
  'persist-credential': 'Saving the protected sign-in',
  'verify-zoom': 'Confirming Zoom is running',
  'checking-completion': 'Checking repair completion',
  'closing-worker': 'Finishing the repair'
});
const PROGRESS_STEPS = new Set(Object.keys(PROGRESS_LABELS));
if (STEP_NAMES.some(step => !PROGRESS_STEPS.has(step))) throw new Error('A workflow step needs fixed repair progress copy.');
const PUBLIC_REASONS = new Set(['repair_already_running', 'repair_recovery_required',
  'target_authorization_required', 'invalid_request', 'writer_lease_busy',
  'target_consent_unverified', 'target_identity_unverified', 'managed_target_unverified',
  'managed_binding_unverified', 'fresh_namespace_unverified', 'interrupted_run_unresolved',
  'lease_release_unverified', 'native_step_timeout', 'zoom_untrusted',
  'credential_storage_unavailable', 'launch_privileges_unavailable', 'profile_privileges_unavailable']);
const READINESS_FAILURES = new Set(['zoom_untrusted', 'credential_storage_unavailable',
  'launch_privileges_unavailable', 'profile_privileges_unavailable']);

function validSid(value) {
  return typeof value === 'string' && /^S-1-\d+(?:-\d+)+$/.test(value)
    && value.split('-').slice(2).every(part => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 0xffffffff);
}
function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string'
    && path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}
function absolutePath(value) {
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value)
    && !/[\x00-\x1f\x7f"'<>|?*\/]/.test(value) && !value.slice(2).includes(':')
    && value.slice(3).split('\\').every(part => part && part !== '.' && part !== '..');
}
function protectedOperator(value) {
  if (!record(value) || !validSid(value.operatorSid) || !absolutePath(value.operatorProfilePath)
      || value.currentUserProfilePathVerified !== true || value.currentUserProtected !== true) return false;
  const current = path.normalize(value.operatorProfilePath).replace(/\\+$/, '').toLowerCase();
  const target = TARGET_PROFILE.toLowerCase();
  return current !== target && !current.startsWith(target + '\\') && !target.startsWith(current + '\\');
}
function clearRecovery(value, machineId, previous) {
  return record(value) && value.status === 'clear' && value.complete === true
    && value.machineId === machineId && value.storageProtected === true
    && value.blocked === false && value.leaseHeld === false && protectedOperator(value)
    && (!previous || (value.operatorSid === previous.operatorSid
      && samePath(value.operatorProfilePath, previous.operatorProfilePath)));
}
function readinessScope(value, machineId, recovery, startedAtMs, time, zoomPath) {
  return record(value) && value.complete === true && value.effectsStarted === false &&
    value.machineId === machineId && protectedOperator(value) &&
    value.operatorSid === recovery.operatorSid && samePath(value.operatorProfilePath, recovery.operatorProfilePath) &&
    samePath(value.profilePath, TARGET_PROFILE) && samePath(value.zoomPath, zoomPath) &&
    positive(value.capturedAtMs) && value.capturedAtMs >= startedAtMs && value.capturedAtMs <= time &&
    time - value.capturedAtMs < MAX_AGE_MS;
}
function safeReason(value) { return PUBLIC_REASONS.has(value) ? value : 'repair_recovery_required'; }
function closedWorker(value) {
  return record(value) && value.ok === true && value.completed === true && record(value.result) &&
    value.result.status === 'closed' && value.result.complete === true && value.result.leaseHeld === false;
}
function blocked(reason, unresolved) {
  return Object.freeze({ success: false, status: 'blocked', reason: safeReason(reason), error:safeReason(reason), unresolved });
}

function createRepairSession(options = {}) {
  const { createNative, now, machineId, generatePassword, randomId, persistCredential } = options;
  if (typeof createNative !== 'function' || typeof now !== 'function' || !identifier(machineId)
      || typeof generatePassword !== 'function' || typeof randomId !== 'function'
      || (persistCredential !== undefined && typeof persistCredential !== 'function')) {
    throw new TypeError('Explicit native factory, clock, machine identity, password and ID generators are required.');
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_STEP_TIMEOUT_MS : options.timeoutMs;
  const timers = options.timers || { setTimeout, clearTimeout };
  if (!positive(timeoutMs) || timeoutMs > 0x7fffffff || typeof timers.setTimeout !== 'function'
      || typeof timers.clearTimeout !== 'function') throw new TypeError('Valid bounded-operation timers are required.');
  let running = false;
  let unresolved = false;
  let generation = 0;
  let owned = null;

  function retain(operation) {
    unresolved = true;
    if (!operation) return;
    operation.unresolved = true;
    if (operation.native && !operation.retentionNotified) {
      operation.retentionNotified = true;
      try { operation.native.retainCustody('repair_session_unresolved'); } catch (_) { /* Uncertainty remains owned. */ }
    }
  }
  function nativeUnresolved(operation) {
    if (!operation || !operation.native) return false;
    try {
      const value = operation.native.hasUnresolvedCustody();
      if (value !== false) { retain(operation); return true; }
      return false;
    } catch (_) { retain(operation); return true; }
  }
  function hasUnresolvedCustody() {
    return unresolved || nativeUnresolved(owned)
      || !!(owned && owned.controller && owned.controller.hasUnresolvedRun());
  }
  function inspect() {
    return Object.freeze({
      running, unresolved: hasUnresolvedCustody(), generation,
      nativeOwned: !!(owned && owned.native),
      pendingNative: !!(owned && owned.pending > 0),
      stage: owned ? owned.stage : 'idle'
    });
  }

  async function run(input = {}) {
    if (running) return blocked('repair_already_running', hasUnresolvedCustody());
    if (hasUnresolvedCustody()) return blocked('repair_recovery_required', true);
    if (!record(input) || !absolutePath(input.zoomPath)
        || path.basename(input.zoomPath).toLowerCase() !== 'zoom.exe'
        || (input.onProgress !== undefined && typeof input.onProgress !== 'function')) return blocked('invalid_request', false);
    // This value is supplied only by main's explicit confirmation path. It
    // authorizes constructing exact consent AFTER native admission, never an
    // unscoped renderer claim about account identity or ownership.
    if (input.authorizeExactTarget !== true) return blocked('target_authorization_required', false);
    if (!Number.isSafeInteger(generation + 1)) return blocked('invalid_request', false);
    let operationId;
    try { operationId = randomId(); } catch (_) { return blocked('invalid_request', false); }
    if (!identifier(operationId)) return blocked('invalid_request', false);
    running = true;
    const operation = {
      id: operationId, generation: ++generation, native: null, controller: null,
      password: null, credentialKey: null, pending: 0, stage: 'preparing',
      unresolved: false, retentionNotified: false, completed: false, lastNow: 0
    };
    owned = operation;
    const notify = step => {
      if (!PROGRESS_STEPS.has(step) || owned !== operation || operation.completed || operation.unresolved) return;
      operation.stage = step;
      if (!input.onProgress) return;
      try {
        const returned = input.onProgress(Object.freeze({ step, label: PROGRESS_LABELS[step] }));
        if (returned && typeof returned.then === 'function') Promise.resolve(returned).catch(() => {});
      } catch (_) { /* A display observer cannot authorize or cancel native work. */ }
    };
    const clock = () => {
      const value = now();
      if (!positive(value) || value < operation.lastNow) throw new Error('invalid_clock');
      operation.lastNow = value;
      return value;
    };
    async function bounded(step, invoke) {
      notify(step);
      clock();
      let timer;
      let expired = false;
      operation.pending++;
      const pending = Promise.resolve().then(invoke);
      pending.then(() => { operation.pending--; }, () => { operation.pending--; });
      try {
        const value = await Promise.race([
          pending,
          new Promise((resolve, reject) => {
            timer = timers.setTimeout(() => {
              expired = true; retain(operation);
              reject(new Error('native_step_timeout'));
            }, timeoutMs);
          })
        ]);
        clock();
        if (expired || operation.unresolved) throw new Error('repair_recovery_required');
        return value;
      } finally { if (timer !== undefined) timers.clearTimeout(timer); }
    }
    const credentials = Object.freeze({
      async withPassword(context, usePassword) {
        if (owned !== operation || operation.completed || operation.unresolved || typeof usePassword !== 'function'
            || !record(context) || !record(context.operation)) throw new Error('credentials_invalid');
        const op = context.operation;
        if (op.id !== operation.id || op.generation !== operation.generation || op.machineId !== machineId
            || op.accountName !== TARGET_ACCOUNT || !identifier(op.leaseNonce)) throw new Error('credentials_invalid');
        // SID is deliberately excluded: creation starts at null and returns the
        // newly attested SID. The password remains bound to the same operation.
        const key = [op.id, op.generation, op.machineId, op.leaseNonce].join('|');
        if (operation.credentialKey !== null && operation.credentialKey !== key) throw new Error('credentials_invalid');
        if (operation.password === null) {
          const password = generatePassword();
          if (typeof password !== 'string' || password.length < 20 || password.length > 128
              || /[\x00-\x1f\x7f]/.test(password)) throw new Error('credentials_invalid');
          operation.password = password;
          operation.credentialKey = key;
        }
        return usePassword(operation.password);
      }
    });
    let workflowResult;
    try {
      const native = await bounded('preparing', async () => {
        const value = await createNative({ credentials, expectedMachineId: machineId, now: clock });
        operation.native = value;
        if (operation.unresolved || owned !== operation || operation.completed) retain(operation);
        return value;
      });
      if (!record(native) || !record(native.adapters) || typeof native.inspectRecovery !== 'function'
          || typeof native.inspectRepairReadiness !== 'function'
          || typeof native.runWorkflowStep !== 'function' || typeof native.close !== 'function'
          || typeof native.hasUnresolvedCustody !== 'function' || typeof native.retainCustody !== 'function') {
        throw new Error('native_configuration_invalid');
      }
      if (nativeUnresolved(operation)) throw new Error('repair_recovery_required');
      const recovery = await bounded('checking-recovery', () => native.inspectRecovery());
      if (!clearRecovery(recovery, machineId)) throw new Error('repair_recovery_required');
      // This must precede even lease acquisition and target-account fencing.
      // The fixed Native worker retains the verified executable/storage guards
      // and rechecks them immediately before each destructive boundary. This
      // receipt is readiness evidence, never a durable effect authorization.
      const readinessStarted = clock();
      const readiness = await bounded('checking-readiness', () => native.inspectRepairReadiness({zoomPath:input.zoomPath}));
      if (!readinessScope(readiness, machineId, recovery, readinessStarted, clock(), input.zoomPath)) {
        throw new Error('repair_recovery_required');
      }
      if (readiness.status === 'blocked' && READINESS_FAILURES.has(readiness.reason) && readiness.closeSafe === true) {
        // A fully known refusal before account/profile work can close normally.
        // A timeout, malformed result, retained worker or unproved close still
        // falls into durable retention below and may not be retried blindly.
        const closed = await bounded('closing-worker', () => native.close());
        if (!closedWorker(closed) || nativeUnresolved(operation)) {
          throw new Error('repair_recovery_required');
        }
        operation.completed = true;
        owned = null;
        return blocked(readiness.reason, false);
      }
      if (readiness.status !== 'ready' || !identifier(readiness.readinessId) ||
          !/^[a-f0-9]{64}$/.test(readiness.zoomSha256) || readiness.zoomTrustVerified !== true ||
          readiness.zoomHandleHeld !== true || readiness.credentialStoragePreconditionsVerified !== true ||
          readiness.credentialStorageGuardHeld !== true || readiness.launchPrivilegesVerified !== true ||
          readiness.profilePrivilegesVerified !== true) throw new Error('repair_recovery_required');
      const controller = createHelperResetController({
        adapters: native.adapters, now: clock, timers, stepTimeoutMs: timeoutMs,
        authorizeTarget(context) {
          if (owned !== operation || operation.completed || operation.unresolved
              || input.authorizeExactTarget !== true || !record(context) || !record(context.operation)) return null;
          const op = context.operation;
          if (op.id !== operation.id || op.generation !== operation.generation || op.machineId !== machineId
              || op.accountName !== TARGET_ACCOUNT || !validSid(op.accountSid)
              || op.accountSid === recovery.operatorSid || !samePath(context.profilePath, TARGET_PROFILE)) return null;
          const consentId = randomId();
          if (!identifier(consentId) || consentId === operation.id) return null;
          return Object.freeze({ id: consentId, confirmed: true, scope: 'purge-exact-local-user1',
            operationId: op.id, generation: op.generation, machineId: op.machineId,
            accountSid: op.accountSid, profilePath: context.profilePath });
        }
      });
      operation.controller = controller;
      const flow = createProvisionedHelperFlow({
        native, now: clock, onProgress: value => notify(value && value.step),
        // Production persistence is a fixed native verb over worker-owned sealed
        // state. The override is explicit dependency injection for isolated tests.
        persistCredential: persistCredential
          ? (contract, context) => persistCredential(contract, context)
          : (_contract, context) => native.runWorkflowStep('persist-credential', context, {})
      });
      notify('resetting-helper');
      const result = await controller.run({ operationId: operation.id, generation: operation.generation, machineId },
        async context => {
          workflowResult = await flow.run({ ...context, zoomPath: input.zoomPath,
            operatorSid: recovery.operatorSid, operatorProfilePath: recovery.operatorProfilePath,
            currentUserProtected: recovery.currentUserProtected });
          return workflowResult;
        });
      if (!result || result.status !== 'workflow-verified' || result.unresolved !== false
          || controller.hasUnresolvedRun() || nativeUnresolved(operation) || !workflowResult
          || !record(result.reset) || !['absent','purged'].includes(result.reset.previousProfile)
          || result.reset.oldProfileAbsent !== true || result.reset.oldRegistrationAbsent !== true || result.reset.recreated !== true) {
        retain(operation);
        return blocked(result && result.reason, true);
      }
      const completed = await bounded('checking-completion', () => native.inspectRecovery());
      if (!clearRecovery(completed, machineId, recovery)) throw new Error('repair_recovery_required');
      const closed = await bounded('closing-worker', () => native.close());
      if (!closedWorker(closed)) {
        throw new Error('native_close_unverified');
      }
      if (nativeUnresolved(operation)) throw new Error('repair_recovery_required');
      // JS strings cannot be zeroized. Drop this closure's secret reference only
      // after journal completion, verified lease release and owned worker close.
      operation.password = null;
      operation.credentialKey = null;
      operation.completed = true;
      owned = null;
      return Object.freeze({ success: true, status: 'workflow-verified', unresolved: false,
        partial: workflowResult.partial === true,
        steps:[{id:'data-clear',label:'Clear the old helper profile',outcome:'ok',detail:result.reset.previousProfile==='purged'
          ? 'The old exact profile and its registration were removed before recreation.'
          : 'The exact account and profile namespace were verified absent before creation.'},...workflowResult.steps],
        warnings: workflowResult.warnings,
        receipt:{...workflowResult.receipt,dataClear:result.reset.previousProfile==='purged'?'old profile fully removed':'old profile absent; fresh creation',reset:result.reset},
        requiresNativeEvidence: result.requiresNativeEvidence === true });
    } catch (_) {
      retain(operation);
      return blocked('repair_recovery_required', true);
    } finally {
      running = false;
    }
  }

  return Object.freeze({ run, hasUnresolvedCustody,
    activeNative: () => owned && owned.native || null, inspect });
}

module.exports = { createRepairSession };
