'use strict';

// Inert adapters only. No host probes, processes, accounts, profiles, files,
// services, credential stores or Native RPC are executed by these fixtures.
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
const originalLoad = Module._load;
const nativeAttempts = [];
const forbidden = new Set(['fs', 'fs/promises', 'child_process', 'os', 'electron', 'net', 'http', 'https', 'worker_threads']);
Module._load = function (name, ...args) {
  if (forbidden.has(name.replace(/^node:/, ''))) { nativeAttempts.push(name); throw new Error('Inert fixture forbids native import'); }
  return originalLoad.call(this, name, ...args);
};
const { createProvisionedHelperFlow, ProvisionedHelperFlowError, PROFILE_PATH, STEP_NAMES } = require('../src/main/provisioned-helper-flow');
const { computeRunVerdict } = require('../run-verdict');
const OPERATOR_SID = 'S-1-5-21-111-222-333-1002';
const HELPER_SID = 'S-1-5-21-111-222-333-1003';
const OTHER_SID = 'S-1-5-21-111-222-333-1004';
const MACHINE_SID = 'S-1-5-21-111-222-333';
const ZOOM_PATH = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
const OPERATOR_PROFILE = 'C:\\Users\\operator';
const EXE_HASH = 'a'.repeat(64);
const CIPHERTEXT = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
const CIPHER_HASH = crypto.createHash('sha256').update(Buffer.from(CIPHERTEXT, 'base64')).digest('hex');
const SECRET_ERROR = 'DO_NOT_EXPOSE_PRIVATE_NATIVE_ERROR_VALUE';
let passed = 0, failed = 0, finished = false;
process.once('beforeExit', () => {
  if (!finished) { console.error('FAIL provisioned-helper-flow: inert async suite did not finish'); process.exitCode = 1; }
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ticks = async () => { for (let count = 0; count < 24; count++) await Promise.resolve(); };
function config() {
  const configured = () => ({ status: 'configured', machinePolicy: 'not-denied', value: 'Allow',
    effectiveAccess: 'requires-app-runtime-verification' });
  return { camera: configured(), microphone: configured(),
    hive: { status: 'owned-loaded-reference', accountSid: HELPER_SID },
    frameServer: { status: 'running', action: 'read-only' }, optionalPreferences: { status: 'not-requested' } };
}
function fixture() {
  let time = 10000;
  const abort = new AbortController(), calls = [], stores = [], progress = [], events = [];
  const context = {
    operation: { id: 'repair-a', generation: 1, machineId: 'machine-a', machineSid: MACHINE_SID,
      accountName: 'user1', accountSid: HELPER_SID, leaseNonce: 'lease-a' },
    lease: { status: 'held', scope: 'machine', exclusive: true, machineVerified: true,
      operationId: 'repair-a', generation: 1, machineId: 'machine-a', machineSid: MACHINE_SID,
      nonce: 'lease-a', acquiredAtMs: 9000, expiresAtMs: 100000 },
    signal: abort.signal, profilePath: PROFILE_PATH, zoomPath: ZOOM_PATH,
    operatorSid: OPERATOR_SID, operatorProfilePath: OPERATOR_PROFILE, currentUserProtected: true
  };
  function common(step) {
    return { status: 'verified', complete: true, verified: true, operationId: 'repair-a', generation: 1,
      machineId: 'machine-a', accountSid: HELPER_SID, leaseNonce: 'lease-a', capturedAtMs: time,
      profilePath: PROFILE_PATH, registeredSid: HELPER_SID, registeredPath: PROFILE_PATH,
      operatorSid: OPERATOR_SID, operatorProfilePath: OPERATOR_PROFILE, currentUserProtected: true, step };
  }
  function proof(step) {
    const value = common(step);
    if (step === 'launch-zoom' || step === 'verify-zoom') Object.assign(value, {
      tokenSid: HELPER_SID, processId: 4242, creationFileTime: '132537600000000000', executablePath: ZOOM_PATH,
      executableSha256: EXE_HASH, liveHandleVerified: true,
      ...(step === 'launch-zoom' ? { launched: true, publisher: 'Zoom Communications, Inc.' }
        : { ready: true, configuration: config() })
    });
    if (step === 'verify-profile') Object.assign(value, { loaded: true, special: false, ownershipVerified: true, hiveOwnedReference: true });
    if (step === 'configure-helper') Object.assign(value, { configuration: config(), preferencesVerified: true });
    if (step === 'seal-credential') Object.assign(value, {
      ciphertext: CIPHERTEXT, protection: 'DPAPI-CurrentUser',
      binding: { schemaVersion: 1, operatorSid: OPERATOR_SID, operatorProfilePath: OPERATOR_PROFILE,
        accountName: 'user1', accountSid: HELPER_SID, profilePath: PROFILE_PATH,
        machineId: 'machine-a', machineSid: MACHINE_SID, operationId: 'repair-a', generation: 1,
        executablePath: ZOOM_PATH, executableSha256: EXE_HASH }
    });
    return value;
  }
  const controls = { native: (name) => proof(name), store: () => ({ ...common('persist-credential'),
    stored: true, readbackVerified: true, storageProtected: true, ownerVerified: true,
    formatVersion: 2, protection: 'DPAPI-CurrentUser', ciphertextSha256: CIPHER_HASH }) };
  const native = {
    runWorkflowStep(name, payload, values) {
      events.push(name);
      calls.push({ name, payload, values });
      assert.ok(STEP_NAMES.includes(name), 'Only maintained workflow steps may dispatch');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'signal'), false, 'Signal is host-only');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'zoomPath'), false, 'Zoom path is a launch value only');
      assert.deepEqual(Object.keys(values), name === 'launch-zoom' ? ['zoomPath'] : [], 'Exact native value shape');
      if (name === 'launch-zoom') assert.ok(values.zoomPath === ZOOM_PATH, 'Configured Zoom target');
      return controls.native(name, payload, values);
    }
  };
  const flow = createProvisionedHelperFlow({
    native, now: () => time,
    persistCredential(value, payload) { events.push('persist-credential'); stores.push({ value, payload }); return controls.store(value, payload); },
    onProgress(value) { progress.push(value); }
  });
  return { context, flow, controls, calls, stores, progress, events, common, proof, abort,
    time: value => { time = value; }, run: next => flow.run(next || context) };
}

async function rejectsTyped(promise, code) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof ProvisionedHelperFlowError, 'Failure must be a typed sanitized workflow error');
  assert.equal(caught.unresolved, true);
  if (code) assert.equal(caught.code, code);
  assert.equal(String(caught.message).includes(SECRET_ERROR), false, 'Raw adapter error must not escape');
  assert.equal(String(caught.stack).includes(SECRET_ERROR), false, 'Raw adapter stack must not escape');
  return caught;
}
async function test(name, run) {
  try { await run(); passed++; console.log('  ok  ' + name); }
  catch (_) { failed++; console.error('FAIL provisioned-helper-flow: ' + name); }
}

(async () => {
  await test('explicit adapters are mandatory and cannot create default effects', () => {
    for (const options of [undefined, {}, { native: {}, now: () => 1, persistCredential() {} },
      { native: { runWorkflowStep() {} }, now: () => 1 }, { native: { runWorkflowStep() {} }, persistCredential() {} }]) {
      assert.throws(() => createProvisionedHelperFlow(options), TypeError);
    }
    assert.deepEqual(nativeAttempts, []);
  });
  await test('exact five native steps and private ciphertext store complete only the verified core', async () => {
    const f = fixture(), value = await f.run();
    assert.deepEqual(f.calls.map(call => call.name), STEP_NAMES);
    assert.deepEqual(f.events, ['launch-zoom', 'verify-profile', 'configure-helper', 'seal-credential', 'persist-credential', 'verify-zoom']);
    assert.equal(f.stores.length, 1);
    assert.ok(f.stores[0].value.ciphertext === CIPHERTEXT, 'Ciphertext is delivered only to private store');
    assert.ok(f.stores[0].value.binding.operatorSid === OPERATOR_SID, 'Original operator binding');
    assert.ok(f.stores[0].value.binding.accountSid === HELPER_SID, 'New helper SID binding');
    assert.equal(Object.prototype.hasOwnProperty.call(f.stores[0].payload, 'signal'), false);
    assert.equal(value.status, 'verified'); assert.equal(value.complete, true); assert.equal(value.verified, true);
    assert.equal(value.accountSid, HELPER_SID); assert.equal(value.leaseNonce, 'lease-a');
    assert.equal(value.receipt.profileKind, 'canonical'); assert.equal(value.receipt.profilePath, PROFILE_PATH);
    assert.equal(value.receipt.zoomRelaunch, 'confirmed'); assert.equal(value.receipt.camera, 'OK');
    assert.equal(value.receipt.credential.readbackVerified, true);
    assert.equal(value.partial, true, 'Unapplied optional preferences must stay visible');
    assert.equal(computeRunVerdict(value.steps, value.warnings, []).partial, true, 'No unqualified UI completion');
    const publicJson = JSON.stringify(value), progressJson = JSON.stringify(f.progress);
    assert.ok(!publicJson.includes(CIPHERTEXT) && !publicJson.includes(OPERATOR_PROFILE), 'Public receipt has no private credential/operator profile');
    assert.ok(!progressJson.includes(CIPHERTEXT) && !progressJson.includes(HELPER_SID) && !progressJson.includes('[1/8]'), 'Progress has no secret or legacy cancel boundary');
    assert.ok(f.progress.every(item => Object.keys(item).sort().join(',') === 'label,step'));
  });
  const invalidContexts = [
    ['missing scope', f => ({ signal: f.abort.signal })],
    ['wrong account name', f => ({ ...f.context, operation: { ...f.context.operation, accountName: 'other' } })],
    ['foreign machine SID', f => ({ ...f.context, operation: { ...f.context.operation, machineSid: 'S-1-5-21-9-8-7' } })],
    ['builtin SID', f => ({ ...f.context, operation: { ...f.context.operation, accountSid: 'S-1-5-18' } })],
    ['current operator as helper', f => ({ ...f.context, operation: { ...f.context.operation, accountSid: OPERATOR_SID } })],
    ['unprotected current user', f => ({ ...f.context, currentUserProtected: false })],
    ['overlapping operator profile', f => ({ ...f.context, operatorProfilePath: 'C:\\Users' })],
    ['temporary target profile', f => ({ ...f.context, profilePath: 'C:\\Users\\TEMP' })],
    ['foreign lease nonce', f => ({ ...f.context, lease: { ...f.context.lease, nonce: 'another' } })],
    ['foreign lease operation', f => ({ ...f.context, lease: { ...f.context.lease, operationId: 'another' } })],
    ['expired lease', f => ({ ...f.context, lease: { ...f.context.lease, expiresAtMs: 10000 } })],
    ['missing signal', f => ({ ...f.context, signal: undefined })],
    ['fabricated signal', f => ({ ...f.context, signal: { aborted: false, addEventListener() {}, removeEventListener() {} } })],
    ['unsafe Zoom path', f => ({ ...f.context, zoomPath: 'C:\\Program Files\\Zoom\\..\\other\\Zoom.exe' })]
  ];
  for (const [name, change] of invalidContexts) await test('zero dispatch for ' + name, async () => {
    const f = fixture(); await rejectsTyped(f.run(change(f)));
    assert.equal(f.calls.length, 0); assert.equal(f.stores.length, 0);
  });
  await test('already-withdrawn authority has zero dispatch', async () => {
    const f = fixture(); f.abort.abort(SECRET_ERROR);
    await rejectsTyped(f.run(), 'authority_withdrawn'); assert.equal(f.calls.length, 0); assert.equal(f.stores.length, 0);
  });
  for (const [name, change] of [
    ['bare success', () => ({ success: true })], ['null proof', () => null], ['array proof', () => []],
    ['wrong step', value => ({ ...value, step: 'verify-zoom' })],
    ['foreign operation', value => ({ ...value, operationId: 'another' })],
    ['foreign generation', value => ({ ...value, generation: 2 })],
    ['foreign machine', value => ({ ...value, machineId: 'another' })],
    ['foreign SID', value => ({ ...value, accountSid: OTHER_SID })],
    ['foreign lease', value => ({ ...value, leaseNonce: 'another' })],
    ['wrong registered SID', value => ({ ...value, registeredSid: OTHER_SID })],
    ['wrong registered path', value => ({ ...value, registeredPath: 'C:\\Users\\TEMP' })],
    ['wrong profile', value => ({ ...value, profilePath: 'C:\\Users\\TEMP' })],
    ['unverified status', value => ({ ...value, status: 'success' })],
    ['incomplete proof', value => ({ ...value, complete: false })],
    ['unverified observation', value => ({ ...value, verified: false })],
    ['stale capture', value => ({ ...value, capturedAtMs: 9999 })],
    ['future capture', value => ({ ...value, capturedAtMs: 10001 })],
    ['operator mismatch', value => ({ ...value, operatorSid: OTHER_SID })],
    ['operator protection missing', value => ({ ...value, currentUserProtected: false })]
  ]) await test('invalid first native receipt stops all following effects: ' + name, async () => {
    const f = fixture(); f.controls.native = step => change(f.proof(step));
    await rejectsTyped(f.run()); assert.equal(f.calls.length, 1); assert.equal(f.stores.length, 0);
  });
  await test('accessor payload is rejected without invoking its getter', async () => {
    const f = fixture(); let read = false;
    f.controls.native = step => { const proof = f.proof(step); Object.defineProperty(proof, 'status', { get() { read = true; throw new Error(SECRET_ERROR); } }); return proof; };
    await rejectsTyped(f.run()); assert.equal(read, false); assert.equal(f.calls.length, 1); assert.equal(f.stores.length, 0);
  });
  for (const step of STEP_NAMES) await test('foreign SID at ' + step + ' prevents every later effect', async () => {
    const f = fixture(); f.controls.native = name => ({ ...f.proof(name), ...(name === step ? { accountSid: OTHER_SID } : {}) });
    await rejectsTyped(f.run()); assert.equal(f.calls.length, STEP_NAMES.indexOf(step) + 1); assert.equal(f.stores.length, step === 'verify-zoom' ? 1 : 0);
  });
  const failures = [
    ['launch-zoom', 'not launched', value => ({ ...value, launched: false })],
    ['launch-zoom', 'foreign token', value => ({ ...value, tokenSid: OTHER_SID })],
    ['launch-zoom', 'untrusted publisher', value => ({ ...value, publisher: 'Other publisher' })],
    ['launch-zoom', 'missing handle proof', value => ({ ...value, liveHandleVerified: false })],
    ['verify-profile', 'loaded profile unknown', value => ({ ...value, loaded: false })],
    ['verify-profile', 'special profile', value => ({ ...value, special: true })],
    ['verify-profile', 'profile ownership missing', value => ({ ...value, ownershipVerified: false })],
    ['verify-profile', 'borrowed hive reference', value => ({ ...value, hiveOwnedReference: false })],
    ['configure-helper', 'preferences proof missing', value => ({ ...value, preferencesVerified: false })],
    ['configure-helper', 'foreign hive', value => ({ ...value, configuration: { ...value.configuration, hive: { status: 'owned-loaded-reference', accountSid: OTHER_SID } } })],
    ['configure-helper', 'service mutation', value => ({ ...value, configuration: { ...value.configuration, frameServer: { status: 'running', action: 'restarted' } } })],
    ['seal-credential', 'wrong protection', value => ({ ...value, protection: 'DPAPI-LocalMachine' })],
    ['seal-credential', 'invalid ciphertext', value => ({ ...value, ciphertext: 'not base64' })],
    ['seal-credential', 'unexpected plaintext', value => ({ ...value, password: SECRET_ERROR })],
    ['seal-credential', 'foreign operator binding', value => ({ ...value, binding: { ...value.binding, operatorSid: OTHER_SID } })],
    ['seal-credential', 'foreign helper binding', value => ({ ...value, binding: { ...value.binding, accountSid: OTHER_SID } })],
    ['seal-credential', 'foreign executable binding', value => ({ ...value, binding: { ...value.binding, executableSha256: 'b'.repeat(64) } })],
    ['verify-zoom', 'Zoom not ready', value => ({ ...value, ready: false })],
    ['verify-zoom', 'PID reuse', value => ({ ...value, creationFileTime: '132537600000000001' })],
    ['verify-zoom', 'different process', value => ({ ...value, processId: 4243 })],
    ['verify-zoom', 'changed executable', value => ({ ...value, executableSha256: 'b'.repeat(64) })]
  ];
  for (const [step, name, change] of failures) await test('mandatory proof rejects ' + name, async () => {
    const f = fixture(); f.controls.native = current => current === step ? change(f.proof(current)) : f.proof(current);
    await rejectsTyped(f.run()); assert.equal(f.calls.length, STEP_NAMES.indexOf(step) + 1); assert.equal(f.stores.length, step === 'verify-zoom' ? 1 : 0);
  });
  for (const status of ['policy-denied', 'unverified']) await test('media ' + status + ' remains visible without policy or hive fallbacks', async () => {
    const f = fixture(); f.controls.native = step => {
      const proof = f.proof(step);
      if (proof.configuration) {
        proof.configuration.camera = { status, machinePolicy: status === 'policy-denied' ? 'denied' : 'unknown' };
        proof.configuration.microphone = { status, machinePolicy: status === 'policy-denied' ? 'denied' : 'not-denied' };
        proof.configuration.frameServer = { status: 'unverified', action: 'read-only' };
      }
      return proof;
    };
    const value = await f.run();
    assert.equal(value.verified, true); assert.equal(value.partial, true);
    assert.equal(value.receipt.camera, status === 'policy-denied' ? 'POLICY-BLOCKED' : 'UNVERIFIED');
    assert.equal(value.steps.find(step => step.id === 'consent').outcome, 'fail');
    assert.ok(value.warnings.some(warning => warning.code.startsWith('camera_')));
    assert.equal(computeRunVerdict(value.steps, value.warnings, []).partial, true);
    assert.deepEqual(f.calls.map(call => call.name), STEP_NAMES); assert.equal(f.stores.length, 1);
  });
  for (const status of ['stopped', 'paused', 'startpending', 'stoppending', 'continuepending', 'pausepending', 'unavailable', 'unverified']) {
    await test('known read-only camera service state stays advisory: ' + status, async () => {
      const f = fixture(); f.controls.native = step => {
        const proof = f.proof(step);
        if (proof.configuration) proof.configuration.frameServer = { status, action: 'read-only' };
        return proof;
      };
      const value = await f.run();
      assert.equal(value.verified, true); assert.equal(value.partial, true);
      assert.equal(value.receipt.frameServer, status);
      assert.ok(value.warnings.some(warning => warning.code === 'camera_service_unverified'));
      assert.deepEqual(f.calls.map(call => call.name), STEP_NAMES);
    });
  }
  await test('unknown camera service state is malformed evidence, not fabricated health', async () => {
    const f = fixture(); f.controls.native = step => {
      const proof = f.proof(step);
      if (proof.configuration) proof.configuration.frameServer = { status: 'invented-state', action: 'read-only' };
      return proof;
    };
    await rejectsTyped(f.run(), 'configuration_unverified'); assert.equal(f.calls.length, 3); assert.equal(f.stores.length, 0);
  });
  for (const [name, change] of [
    ['bare success', () => ({ success: true })], ['unread storage', value => ({ ...value, readbackVerified: false })],
    ['unprotected storage', value => ({ ...value, storageProtected: false })], ['unverified storage owner', value => ({ ...value, ownerVerified: false })],
    ['legacy format', value => ({ ...value, formatVersion: 1 })], ['unknown format', value => ({ ...value, formatVersion: undefined })],
    ['not stored', value => ({ ...value, stored: false })], ['different ciphertext', value => ({ ...value, ciphertextSha256: 'b'.repeat(64) })],
    ['foreign operator', value => ({ ...value, operatorSid: OTHER_SID })], ['foreign lease', value => ({ ...value, leaseNonce: 'another' })],
    ['stale storage receipt', value => ({ ...value, capturedAtMs: 9999 })]
  ]) await test('credential storage requires exact scoped readback: ' + name, async () => {
    const f = fixture(); const original = f.controls.store; f.controls.store = (value, payload) => change(original(value, payload));
    await rejectsTyped(f.run(), 'credential_store_unverified'); assert.equal(f.calls.length, 4); assert.equal(f.stores.length, 1);
  });
  await test('raw adapter exceptions and mutated typed errors never expose private text', async () => {
    for (const make of [() => new Error(SECRET_ERROR), () => { const error = new ProvisionedHelperFlowError('launch-zoom', 'launch_unverified'); error.message = SECRET_ERROR; return error; }]) {
      const f = fixture(); f.controls.native = () => { throw make(); };
      await rejectsTyped(f.run()); assert.equal(f.calls.length, 1); assert.equal(f.stores.length, 0);
    }
  });
  await test('authority withdrawal during pending native work prevents late continuation', async () => {
    const f = fixture(), pending = deferred(); f.controls.native = () => pending.promise;
    const running = f.run(); await ticks(); assert.equal(f.calls.length, 1);
    f.abort.abort(SECRET_ERROR); await rejectsTyped(running, 'authority_withdrawn');
    pending.resolve(f.proof('launch-zoom')); await ticks();
    assert.equal(f.calls.length, 1); assert.equal(f.stores.length, 0);
  });
  await test('authority withdrawal during storage never claims storage ended or completes', async () => {
    const f = fixture(), pending = deferred(); f.controls.store = () => pending.promise;
    const running = f.run(); for (let count = 0; count < 30 && !f.stores.length; count++) await ticks();
    assert.equal(f.stores.length, 1); f.abort.abort();
    await rejectsTyped(running, 'authority_withdrawn');
    pending.resolve({ ...f.common('persist-credential'), stored: true, readbackVerified: true,
      storageProtected: true, ownerVerified: true, formatVersion: 2, protection: 'DPAPI-CurrentUser', ciphertextSha256: CIPHER_HASH }); await ticks();
    assert.equal(f.calls.length, 4); assert.equal(f.stores.length, 1);
  });
  await test('slow storage is followed by a genuinely fresh final native observation', async () => {
    const f = fixture(); const store = f.controls.store;
    f.controls.store = (value, context) => { f.time(20000); return store(value, context); };
    const value = await f.run();
    assert.equal(value.capturedAtMs, 20000);
    assert.equal(f.events.at(-1), 'verify-zoom');
    assert.equal(value.receipt.zoomRelaunch, 'confirmed');
  });
  await test('lease expiry while native work is pending blocks all later dispatch', async () => {
    const f = fixture(), pending = deferred(); f.controls.native = () => pending.promise;
    const running = f.run(); await ticks(); f.time(100000); pending.resolve(f.proof('launch-zoom'));
    await rejectsTyped(running, 'lease_expired'); assert.equal(f.calls.length, 1); assert.equal(f.stores.length, 0);
  });
  await test('an old capture cannot become fresh merely because native work returned late', async () => {
    const f = fixture(), pending = deferred(), old = f.proof('launch-zoom'); f.controls.native = () => pending.promise;
    const running = f.run(); await ticks(); f.time(16000); pending.resolve(old);
    await rejectsTyped(running); assert.equal(f.calls.length, 1); assert.equal(f.stores.length, 0);
  });
  await test('concurrent workflow invocation cannot dispatch a second native transaction', async () => {
    const f = fixture(), pending = deferred(); f.controls.native = () => pending.promise;
    const running = f.run(); await ticks(); await rejectsTyped(f.run(), 'workflow_running');
    assert.equal(f.calls.length, 1); f.abort.abort(); await rejectsTyped(running, 'authority_withdrawn');
    pending.reject(new Error(SECRET_ERROR)); await ticks(); assert.equal(f.stores.length, 0);
  });
  assert.deepEqual(nativeAttempts, [], 'No native imports/effects');
  Module._load = originalLoad;
  console.log('provisioned-helper-flow-smoke: ' + passed + ' passed, ' + failed + ' failed; inert adapters only');
  if (failed) process.exitCode = 1;
  finished = true;
})().catch(() => {
  Module._load = originalLoad; console.error('FAIL provisioned-helper-flow: harness failure'); process.exitCode = 1; finished = true;
});
