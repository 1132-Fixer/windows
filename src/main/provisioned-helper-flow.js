'use strict';

// The controller has already purged/recreated the exact helper and owns its
// durable journal/lease. This module performs no native, file or credential
// effects itself. It does not introduce cancellable log-string checkpoints.
// context.signal is host-only authority: abort stops later dispatch, never
// kills the native worker or asserts that an in-flight effect has ended.
// persistCredential({ciphertext, protection, binding}, nativeContext) must
// return a fresh scoped step:'persist-credential' receipt with stored:true,
// readbackVerified:true, storageProtected:true, ownerVerified:true and SHA-256
// of the decoded ciphertext bytes, with formatVersion:2. Existing legacy files
// are not a proof; the default host adapter routes the fixed Native store verb.
const path = require('node:path').win32;
const crypto = require('node:crypto');
const { MAX_AGE_MS } = require('./helper-reset-safety');

const PROFILE_PATH = 'C:\\Users\\user1';
const STEP_NAMES = Object.freeze(['launch-zoom', 'verify-profile', 'configure-helper', 'seal-credential', 'verify-zoom']);
const FRAME_SERVER_STATES = Object.freeze(['running', 'stopped', 'paused', 'startpending', 'stoppending',
  'continuepending', 'pausepending', 'unavailable', 'unverified']);
const LABELS = Object.freeze({
  'launch-zoom': 'Opening Zoom',
  'verify-profile': 'Checking the fresh profile',
  'configure-helper': 'Checking Zoom permissions',
  'seal-credential': 'Protecting the helper sign-in',
  'verify-zoom': 'Confirming Zoom is running',
  'persist-credential': 'Saving the protected sign-in'
});
const CODES = Object.freeze({
  invalid_context: 'The repair context could not be verified.',
  invalid_clock: 'The repair clock could not be verified.',
  lease_expired: 'The repair lease is no longer current.',
  authority_withdrawn: 'The repair no longer has authority to continue.',
  workflow_running: 'The helper workflow is already running.',
  native_step_unverified: 'A required native step could not be verified.',
  native_scope_unverified: 'A native result did not match this repair.',
  profile_unverified: 'The fresh helper profile could not be verified.',
  launch_unverified: 'Zoom could not be verified in the fresh helper profile.',
  configuration_unverified: 'The permission result could not be verified.',
  credential_unverified: 'The protected helper sign-in could not be verified.',
  credential_store_unverified: 'The protected helper sign-in was not verified in storage.'
});
class ProvisionedHelperFlowError extends Error {
  constructor(stage, code) {
    const safeCode = Object.prototype.hasOwnProperty.call(CODES, code) ? code : 'native_step_unverified';
    super(CODES[safeCode]);
    this.name = 'ProvisionedHelperFlowError';
    this.code = safeCode;
    this.stage = STEP_NAMES.includes(stage) || stage === 'persist-credential' ? stage : 'context';
    this.unresolved = true;
  }
}
const failure = (stage, code) => new ProvisionedHelperFlowError(stage, code);
const positive = value => Number.isSafeInteger(value) && value > 0;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const sameProfile = value => typeof value === 'string' && value.toLowerCase() === PROFILE_PATH.toLowerCase();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function dataRecord(value, stage, code = 'native_scope_unverified') {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure(stage, code);
    const result = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw failure(stage, code);
      result[key] = descriptor.value;
    }
    return result;
  } catch (_) { throw failure(stage, code); }
}
function sid(value) {
  if (typeof value !== 'string' || !/^S-1-[0-9]+(?:-[0-9]+){1,15}$/.test(value)) return false;
  const pieces = value.split('-');
  return /^(0|[1-9][0-9]*)$/.test(pieces[2]) && Number(pieces[2]) <= 0xffffffffffff
    && pieces.slice(3).every(piece => /^(0|[1-9][0-9]*)$/.test(piece) && Number(piece) <= 0xffffffff);
}
function localSid(value, machine) {
  if (typeof machine !== 'string' || !/^S-1-5-21-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)-(?:0|[1-9][0-9]*)$/.test(machine)
    || !machine.split('-').slice(4).every(piece => Number(piece) <= 0xffffffff) || !sid(value) || !value.startsWith(machine + '-')) return false;
  return Number(value.slice(machine.length + 1)) >= 1000;
}
function absoluteFile(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || value.includes('/')) return false;
  return value.slice(3).split('\\').every(piece => piece && piece !== '.' && piece !== '..'
    && !/[<>:"|?*\x00-\x1f]/.test(piece) && !/[. ]$/.test(piece)
    && !/^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(piece));
}
function sameFile(left, right) {
  return absoluteFile(left) && absoluteFile(right) && path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}
function operatorProtected(operatorSid, operatorProfile, accountSid) {
  if (!sid(operatorSid) || operatorSid === accountSid || !absoluteFile(operatorProfile)) return false;
  const current = path.normalize(operatorProfile).toLowerCase(), target = PROFILE_PATH.toLowerCase();
  return current !== target && !current.startsWith(target + '\\') && !target.startsWith(current + '\\');
}
function creationTime(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
}

function createProvisionedHelperFlow({ native, now, persistCredential, onProgress } = {}) {
  if (!native || typeof native.runWorkflowStep !== 'function' || typeof now !== 'function' || typeof persistCredential !== 'function'
    || (onProgress !== undefined && typeof onProgress !== 'function')) throw new TypeError('Explicit native, clock, credential-store and optional progress adapters are required');
  let running = false;
  async function run(input) {
    if (running) throw failure('context', 'workflow_running');
    let context, operation, lease, signal, zoomPath;
    let lastNow = 0;
    function clock() {
      let value;
      try { value = now(); } catch (_) { throw failure('context', 'invalid_clock'); }
      if (!positive(value) || value < lastNow) throw failure('context', 'invalid_clock');
      lastNow = value;
      return value;
    }
    try {
      context = dataRecord(input, 'context', 'invalid_context');
      operation = dataRecord(context.operation, 'context', 'invalid_context');
      lease = dataRecord(context.lease, 'context', 'invalid_context');
      signal = context.signal;
      zoomPath = context.zoomPath;
      const time = clock();
      if (!(signal instanceof AbortSignal) || !identifier(operation.id) || !positive(operation.generation)
        || !identifier(operation.machineId) || !identifier(operation.leaseNonce) || operation.accountName !== 'user1'
        || !localSid(operation.accountSid, operation.machineSid) || !sameProfile(context.profilePath)
        || context.currentUserProtected !== true || !operatorProtected(context.operatorSid, context.operatorProfilePath, operation.accountSid)
        || !absoluteFile(zoomPath) || path.basename(zoomPath).toLowerCase() !== 'zoom.exe'
        || lease.status !== 'held' || lease.scope !== 'machine' || lease.exclusive !== true || lease.machineVerified !== true
        || lease.operationId !== operation.id || lease.generation !== operation.generation || lease.machineId !== operation.machineId
        || lease.machineSid !== operation.machineSid || lease.nonce !== operation.leaseNonce
        || !positive(lease.acquiredAtMs) || lease.acquiredAtMs > time || !positive(lease.expiresAtMs)) throw failure('context', 'invalid_context');
    } catch (error) {
      if (error instanceof ProvisionedHelperFlowError) throw failure(error.stage, error.code);
      throw failure('context', 'invalid_context');
    }
    // Only these immutable fields cross the Native RPC boundary. In particular,
    // neither host AbortSignal nor the caller's extra fields are serialized.
    const nativeContext = Object.freeze({
      operation: Object.freeze({ id: operation.id, generation: operation.generation, machineId: operation.machineId,
        machineSid: operation.machineSid, accountName: 'user1', accountSid: operation.accountSid, leaseNonce: operation.leaseNonce }),
      lease: Object.freeze({ status: 'held', scope: 'machine', exclusive: true, machineVerified: true,
        operationId: lease.operationId, generation: lease.generation, machineId: lease.machineId, machineSid: lease.machineSid,
        nonce: lease.nonce, acquiredAtMs: lease.acquiredAtMs, expiresAtMs: lease.expiresAtMs }),
      profilePath: PROFILE_PATH
    });
    const steps = [], warnings = [];
    const warningCodes = new Set();
    let identity = null;
    function requireProof(condition, stage, code) { if (!condition) throw failure(stage, code); }
    function authority(stage) {
      if (signal.aborted) throw failure(stage, 'authority_withdrawn');
      const time = clock();
      if (time >= lease.expiresAtMs) throw failure(stage, 'lease_expired');
      return time;
    }
    function warn(code, message) {
      if (!warningCodes.has(code)) { warningCodes.add(code); warnings.push({ code, message }); }
    }
    function progress(step) {
      if (!onProgress) return;
      try {
        const returned = onProgress(Object.freeze({ step, label: LABELS[step] }));
        if (returned && typeof returned.then === 'function') {
          Promise.resolve(returned).catch(() => {});
          warn('progress_unverified', 'Some progress updates could not be confirmed. The repair result is shown below.');
        }
      } catch (_) { warn('progress_unverified', 'Some progress updates could not be confirmed. The repair result is shown below.'); }
    }
    async function ownedAwait(stage, invoke) {
      authority(stage);
      let listener;
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => { authority(stage); return invoke(); }),
          new Promise((resolve, reject) => {
            listener = () => reject(failure(stage, 'authority_withdrawn'));
            signal.addEventListener('abort', listener, { once: true });
            if (signal.aborted) listener();
          })
        ]);
        authority(stage);
        return result;
      } catch (_) {
        // Do not inspect or rethrow adapter errors, including instances of our
        // public error type whose fields could have been replaced by getters.
        authority(stage);
        throw failure(stage, stage === 'persist-credential' ? 'credential_store_unverified' : 'native_step_unverified');
      } finally { if (listener) signal.removeEventListener('abort', listener); }
    }
    function scoped(value, stage, startedAt, expectedStep = stage) {
      const code = stage === 'persist-credential' ? 'credential_store_unverified' : 'native_scope_unverified';
      const proof = dataRecord(value, stage, code);
      const time = authority(stage);
      requireProof(proof.status === 'verified' && proof.complete === true && proof.verified === true
        && proof.step === expectedStep && proof.operationId === operation.id && proof.generation === operation.generation
        && proof.machineId === operation.machineId && proof.accountSid === operation.accountSid && proof.leaseNonce === operation.leaseNonce
        && sameProfile(proof.profilePath) && proof.registeredSid === operation.accountSid && sameProfile(proof.registeredPath)
        && positive(proof.capturedAtMs) && proof.capturedAtMs >= lease.acquiredAtMs && proof.capturedAtMs >= startedAt
        && proof.capturedAtMs <= time && time - proof.capturedAtMs < MAX_AGE_MS
        && proof.currentUserProtected === true && operatorProtected(proof.operatorSid, proof.operatorProfilePath, operation.accountSid)
        && proof.operatorSid === context.operatorSid && sameFile(proof.operatorProfilePath, context.operatorProfilePath),
      stage, code);
      if (identity) requireProof(proof.operatorSid === identity.sid && sameFile(proof.operatorProfilePath, identity.profile), stage, code);
      else identity = Object.freeze({ sid: proof.operatorSid, profile: proof.operatorProfilePath });
      return proof;
    }
    async function nativeStep(name) {
      const start = authority(name);
      progress(name);
      const value = await ownedAwait(name, () => native.runWorkflowStep(name, nativeContext, name === 'launch-zoom' ? { zoomPath } : {}));
      return scoped(value, name, start);
    }
    function processProof(proof, stage, launch) {
      requireProof(proof.tokenSid === operation.accountSid && positive(proof.processId) && proof.processId <= 0xffffffff
        && creationTime(proof.creationFileTime) && proof.liveHandleVerified === true && sameFile(proof.executablePath, zoomPath)
        && validHash(proof.executableSha256), stage, 'launch_unverified');
      if (launch) requireProof(proof.processId === launch.processId && proof.creationFileTime === launch.creationFileTime
        && proof.executableSha256 === launch.executableSha256 && sameFile(proof.executablePath, launch.executablePath), stage, 'launch_unverified');
    }
    function configuration(value, stage) {
      const config = dataRecord(value, stage, 'configuration_unverified');
      const devices = {};
      for (const name of ['camera', 'microphone']) {
        const device = dataRecord(config[name], stage, 'configuration_unverified');
        requireProof(['configured', 'policy-denied', 'unverified'].includes(device.status)
          && ['not-denied', 'denied', 'unknown'].includes(device.machinePolicy), stage, 'configuration_unverified');
        if (device.status === 'configured') requireProof(device.machinePolicy === 'not-denied' && device.value === 'Allow'
          && device.effectiveAccess === 'requires-app-runtime-verification', stage, 'configuration_unverified');
        else requireProof(device.value === undefined && device.effectiveAccess === undefined
          && (device.status === 'policy-denied' ? device.machinePolicy === 'denied' : device.machinePolicy !== 'denied'), stage, 'configuration_unverified');
        devices[name] = Object.freeze({ status: device.status, machinePolicy: device.machinePolicy,
          ...(device.status === 'configured' ? { value: 'Allow', effectiveAccess: 'requires-app-runtime-verification' } : {}) });
      }
      const hive = dataRecord(config.hive, stage, 'configuration_unverified');
      const frameServer = dataRecord(config.frameServer, stage, 'configuration_unverified');
      const optional = dataRecord(config.optionalPreferences, stage, 'configuration_unverified');
      requireProof(hive.status === 'owned-loaded-reference' && hive.accountSid === operation.accountSid
        && frameServer.action === 'read-only' && FRAME_SERVER_STATES.includes(frameServer.status)
        && optional.status === 'not-requested', stage, 'configuration_unverified');
      return Object.freeze({ ...devices, frameServer: Object.freeze({ status: frameServer.status, action: 'read-only' }),
        hiveStatus: 'owned-loaded-reference', optionalPreferences: 'not-requested' });
    }
    running = true;
    try {
      authority('launch-zoom');
      const launched = await nativeStep('launch-zoom');
      requireProof(launched.launched === true && ['Zoom Communications, Inc.', 'Zoom Video Communications, Inc.'].includes(launched.publisher),
        'launch-zoom', 'launch_unverified');
      processProof(launched, 'launch-zoom');
      steps.push({ id: 'launch-zoom', label: 'Open Zoom in the fresh profile', outcome: 'ok', detail: '' });
      const profile = await nativeStep('verify-profile');
      requireProof(profile.loaded === true && profile.special === false && profile.ownershipVerified === true && profile.hiveOwnedReference === true,
        'verify-profile', 'profile_unverified');
      steps.push({ id: 'profile-setup', label: 'Verify the fresh helper profile', outcome: 'ok', detail: '' });
      const configured = await nativeStep('configure-helper');
      requireProof(configured.preferencesVerified === true, 'configure-helper', 'configuration_unverified');
      configuration(configured.configuration, 'configure-helper');
      const sealed = await nativeStep('seal-credential');
      requireProof(sealed.protection === 'DPAPI-CurrentUser' && typeof sealed.ciphertext === 'string'
        && sealed.ciphertext.length > 0 && sealed.ciphertext.length <= 65536 && sealed.ciphertext.length % 4 === 0
        && /^[A-Za-z0-9+/]+={0,2}$/.test(sealed.ciphertext)
        && Buffer.from(sealed.ciphertext, 'base64').toString('base64') === sealed.ciphertext
        && sealed.password === undefined && sealed.plaintext === undefined && sealed.secret === undefined,
      'seal-credential', 'credential_unverified');
      const binding = dataRecord(sealed.binding, 'seal-credential', 'credential_unverified');
      requireProof(binding.schemaVersion === 1 && binding.operatorSid === identity.sid && sameFile(binding.operatorProfilePath, identity.profile)
        && binding.accountName === 'user1' && binding.accountSid === operation.accountSid && sameProfile(binding.profilePath)
        && binding.machineId === operation.machineId && binding.machineSid === operation.machineSid && binding.operationId === operation.id
        && binding.generation === operation.generation && sameFile(binding.executablePath, launched.executablePath)
        && binding.executableSha256 === launched.executableSha256, 'seal-credential', 'credential_unverified');
      const privateBinding = Object.freeze({ schemaVersion: 1, operatorSid: identity.sid, operatorProfilePath: identity.profile,
        accountName: 'user1', accountSid: operation.accountSid, profilePath: PROFILE_PATH, machineId: operation.machineId,
        machineSid: operation.machineSid, operationId: operation.id, generation: operation.generation,
        executablePath: launched.executablePath, executableSha256: launched.executableSha256 });
      const privateCredential = Object.freeze({ ciphertext: sealed.ciphertext, protection: 'DPAPI-CurrentUser', binding: privateBinding });
      const ciphertextSha256 = hash(Buffer.from(sealed.ciphertext, 'base64'));
      const persistStart = authority('persist-credential');
      progress('persist-credential');
      const persistedValue = await ownedAwait('persist-credential', () => persistCredential(privateCredential, nativeContext));
      const persisted = scoped(persistedValue, 'persist-credential', persistStart);
      requireProof(persisted.stored === true && persisted.readbackVerified === true && persisted.storageProtected === true
        && persisted.ownerVerified === true && persisted.formatVersion === 2 && persisted.protection === 'DPAPI-CurrentUser'
        && persisted.ciphertextSha256 === ciphertextSha256, 'persist-credential', 'credential_store_unverified');
      // Observe Zoom AFTER durable storage. A slow store cannot refresh an old
      // launch observation by stamping a new JS time on the aggregate receipt.
      const verified = await nativeStep('verify-zoom');
      requireProof(verified.ready === true, 'verify-zoom', 'launch_unverified');
      processProof(verified, 'verify-zoom', launched);
      const finalConfiguration = configuration(verified.configuration, 'verify-zoom');
      scoped(verified, 'verify-zoom', verified.capturedAtMs);
      const permission = name => finalConfiguration[name].status === 'configured' ? 'OK'
        : finalConfiguration[name].status === 'policy-denied' ? 'POLICY-BLOCKED' : 'UNVERIFIED';
      const consentBad = ['camera', 'microphone'].some(name => finalConfiguration[name].status !== 'configured');
      for (const name of ['camera', 'microphone']) if (finalConfiguration[name].status !== 'configured') {
        warn(name + '_' + finalConfiguration[name].status.replace('-', '_'), finalConfiguration[name].status === 'policy-denied'
          ? 'A Windows policy blocks ' + name + ' access. Ask whoever manages this PC to allow it.'
          : 'The ' + name + ' permission could not be confirmed. Check it in Windows Settings if Zoom cannot use it.');
      }
      steps.push({ id: 'consent', label: 'Confirm camera and microphone permissions', outcome: consentBad ? 'fail' : 'ok',
        detail: consentBad ? 'Some media permissions need attention. No machine policy was bypassed.' : '' });
      warn('optional_preferences_not_applied', 'Optional Zoom preferences were not applied by this repair.');
      steps.push({ id: 'zoom-config', label: 'Apply optional Zoom preferences', outcome: 'fail', detail: 'Optional Zoom preferences were not applied.' });
      if (finalConfiguration.frameServer.status !== 'running') warn('camera_service_unverified', 'The camera service was checked without changing it and could not be confirmed running.');
      steps.push({ id: 'helper-sign-in', label: 'Save protected helper sign-in', outcome: 'ok', detail: '' });
      steps.push({ id: 'relaunch', label: 'Confirm Zoom is running in the fresh profile', outcome: 'ok', detail: '' });
      authority('verify-zoom');
      return Object.freeze({
        status: 'verified', complete: true, verified: true, success: true, partial: true,
        operationId: operation.id, generation: operation.generation, machineId: operation.machineId,
        accountSid: operation.accountSid, leaseNonce: operation.leaseNonce,
        capturedAtMs: verified.capturedAtMs, profilePath: PROFILE_PATH,
        registeredSid: operation.accountSid, registeredPath: PROFILE_PATH, currentUserProtected: true,
        steps: Object.freeze(steps.map(step => Object.freeze(step))), warnings: Object.freeze(warnings.map(value => Object.freeze(value))),
        receipt: Object.freeze({ camera: permission('camera'), microphone: permission('microphone'),
          hkuPath: 'owned-loaded-reference', frameServer: finalConfiguration.frameServer.status,
          configuration: finalConfiguration, zoomRelaunch: 'confirmed', profileKind: 'canonical', profilePath: PROFILE_PATH,
          credential: Object.freeze({ stored: true, readbackVerified: true, formatVersion: 2 }) })
      });
    } finally { running = false; }
  }
  return Object.freeze({ run });
}

module.exports = { createProvisionedHelperFlow, ProvisionedHelperFlowError, PROFILE_PATH, STEP_NAMES };
