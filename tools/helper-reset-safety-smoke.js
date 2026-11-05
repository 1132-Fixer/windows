'use strict';

// Pure decision-contract tests only. Synthetic identities and paths below never
// reach Windows, Electron, a child process, a filesystem adapter or the network.
// A ready decision still requires native revalidation; it never authorizes deletion.
const assert = require('node:assert/strict');
const Module = require('node:module');

const ACCOUNT_SID = 'S-1-5-21-111-222-333-1001';
const CURRENT_SID = 'S-1-5-21-111-222-333-1002';
const MACHINE_SID = 'S-1-5-21-111-222-333';
const PROBES = ['binding', 'account', 'shutdown', 'sessions', 'processes', 'profile', 'logonFence', 'lease', 'journal'];
const OPTIONS = { nowMs: 1100, maxAgeMs: 5000 };
let passed = 0;
let failed = 0;
let evaluate;
const effects = [];

function fixture() {
  const common = {
    schemaVersion: 1,
    status: 'verified',
    complete: true,
    capturedAtMs: 1000,
    machineId: 'machine-a',
    accountSid: ACCOUNT_SID,
    operationId: 'repair-a',
    generation: 1,
    leaseNonce: 'lease-a'
  };
  return {
    schemaVersion: 1,
    operation: {
      id: 'repair-a', generation: 1, machineId: 'machine-a', machineSid: MACHINE_SID,
      accountSid: ACCOUNT_SID, accountName: 'user1', leaseNonce: 'lease-a'
    },
    probes: {
      binding: { ...common, machineSid: MACHINE_SID, accountName: 'user1', ownerVerified: true, storageProtected: true },
      account: {
        ...common, exists: true, isLocal: true, accountType: 'user', name: 'user1',
        currentUserSid: CURRENT_SID, currentUserProfilePath: 'C:\\Users\\operator',
        builtin: false, protected: false, enabled: false
      },
      shutdown: { ...common, outcome: 'complete', timedOut: false, spawnFailed: false, terminationConfirmed: true },
      sessions: { ...common, activeCount: 0, unknownOwnerCount: 0 },
      processes: { ...common, remainingCount: 0, unknownOwnerCount: 0 },
      profile: {
        ...common, exists: true, loaded: false, special: false, hiveLoaded: false,
        path: 'C:\\Users\\user1', profilesRoot: 'C:\\Users', ownerSid: ACCOUNT_SID,
        ownershipVerified: true, ancestorsReparseFree: true, leafReparseFree: true,
        profilesRootVerified: true, registeredSid: ACCOUNT_SID, registeredPath: 'C:\\Users\\user1'
      },
      logonFence: { ...common, kind: 'account-disabled', applied: true, appliedAtMs: 950 },
      lease: { ...common, scope: 'machine', held: true, exclusive: true, nonce: 'lease-a', unresolvedWriter: false, acquiredAtMs: 900, expiresAtMs: 6000 },
      journal: { ...common, unresolved: false, phase: 'validated' }
    }
  };
}

function test(name, fn) {
  try { fn(); passed++; }
  catch (error) {
    failed++;
    // Cases contain synthetic data only; keep output bounded and omit snapshots.
    console.error(`FAIL helper-reset-safety: ${name}: ${error.message}`);
  }
}

function resultShape(result) {
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.ok(result.decision === 'ready' || result.decision === 'blocked');
  assert.ok(Array.isArray(result.blockers));
  assert.ok(result.blockers.every(code => typeof code === 'string' && code.length > 0));
  assert.equal(new Set(result.blockers).size, result.blockers.length, 'blocker codes must be unique');
  assert.ok(result.expiresAtMs === null || Number.isSafeInteger(result.expiresAtMs));
  assert.equal(result.requiresNativeRevalidation, true, 'cached decisions never replace native revalidation');
  assert.ok(result.scope === null || (typeof result.scope === 'object' && !Array.isArray(result.scope)));
}

function decide(snapshot, options = OPTIONS) {
  const count = effects.length;
  const result = evaluate(snapshot, options);
  resultShape(result);
  assert.equal(effects.length, count, 'evaluation must not attempt an effect, even if it catches refusal');
  return result;
}

function ready(snapshot = fixture(), options = OPTIONS) {
  const result = decide(snapshot, options);
  assert.equal(result.decision, 'ready');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.scope, {
    operationId: 'repair-a', generation: 1, machineId: 'machine-a',
    accountSid: ACCOUNT_SID, leaseNonce: 'lease-a'
  });
  return result;
}

function blocked(snapshot, options = OPTIONS) {
  const result = decide(snapshot, options);
  assert.equal(result.decision, 'blocked', 'missing, contradictory or unknown evidence must block');
  assert.ok(result.blockers.length > 0, 'blocked decisions need useful reason codes');
  return result;
}

function reject(name, change, options = OPTIONS) {
  test(name, () => {
    ready(); // Prove the independent baseline before each single-field negative control.
    const snapshot = fixture();
    change(snapshot);
    blocked(snapshot, options);
  });
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

// Deny effect dependencies during both import and evaluation. This verifies the
// real module, without replacing it with a test implementation or OS fake.
const forbiddenImports = new Set([
  'fs', 'fs/promises', 'child_process', 'os', 'electron', 'net', 'http', 'https',
  'http2', 'dns', 'dns/promises', 'dgram', 'tls', 'worker_threads', 'cluster',
  'readline', 'readline/promises', 'timers', 'timers/promises'
]);
const originalLoad = Module._load;
const restores = [];
function forbid(object, key) {
  const original = object[key];
  if (typeof original !== 'function') return;
  object[key] = function () { effects.push(key); throw new Error(`unexpected effect: ${key}`); };
  restores.push(() => { object[key] = original; });
}

Module._load = function (request, parent, isMain) {
  if (forbiddenImports.has(request.replace(/^node:/, ''))) {
    effects.push(request);
    throw new Error(`unexpected effect dependency: ${request}`);
  }
  return originalLoad.call(this, request, parent, isMain);
};
for (const key of ['exit', 'kill', 'chdir', 'abort']) forbid(process, key);
for (const key of ['setTimeout', 'setInterval', 'setImmediate', 'fetch']) forbid(globalThis, key);
forbid(Date, 'now');

try {
  const safety = require('../src/main/helper-reset-safety');
  evaluate = safety.evaluateHelperResetSafety;

  test('exports only the pure contract', () => {
    assert.deepEqual(Object.keys(safety).sort(), ['MAX_AGE_MS', 'SNAPSHOT_SCHEMA_VERSION', 'evaluateHelperResetSafety']);
    assert.equal(safety.MAX_AGE_MS, 5000);
    assert.equal(safety.SNAPSHOT_SCHEMA_VERSION, 1);
    assert.equal(typeof evaluate, 'function');
    assert.equal(effects.length, 0);
  });
  test('complete consistent fresh evidence yields scoped readiness', () => {
    assert.equal(ready().expiresAtMs, 6000);
  });
  test('default TTL equals the documented maximum', () => {
    assert.deepEqual(ready(fixture(), { nowMs: 1100 }), ready());
  });
  test('age zero is fresh', () => { ready(fixture(), { nowMs: 1000, maxAgeMs: 5000 }); });
  test('short permitted TTL has its own expiry', () => {
    assert.equal(ready(fixture(), { nowMs: 1000, maxAgeMs: 1 }).expiresAtMs, 1001);
  });
  test('earliest probe governs expiration', () => {
    const snapshot = fixture();
    snapshot.probes.binding.capturedAtMs = 950;
    assert.equal(ready(snapshot).expiresAtMs, 5950);
  });
  test('lease expiration limits an otherwise fresh decision', () => {
    const snapshot = fixture();
    snapshot.probes.lease.expiresAtMs = 1200;
    assert.equal(ready(snapshot).expiresAtMs, 1200);
    blocked(snapshot, { ...OPTIONS, nowMs: 1200 });
  });
  test('fresh canonical registry paths compare case-insensitively', () => {
    const snapshot = fixture();
    snapshot.probes.profile.path = 'c:\\USERS\\USER1';
    assert.equal(ready(snapshot).decision, 'ready');
  });
  test('consistent independently verified alternate profile root is accepted', () => {
    const snapshot = fixture();
    snapshot.probes.profile.profilesRoot = 'D:\\Profiles';
    snapshot.probes.profile.path = 'D:\\Profiles\\user1';
    snapshot.probes.profile.registeredPath = 'd:\\profiles\\USER1';
    assert.equal(ready(snapshot).decision, 'ready');
  });
  test('exact TTL boundary is expired', () => { blocked(fixture(), { nowMs: 6000, maxAgeMs: 5000 }); });
  test('one millisecond before expiration remains fresh', () => { ready(fixture(), { nowMs: 5999, maxAgeMs: 5000 }); });
  test('short TTL boundary is expired', () => { blocked(fixture(), { nowMs: 1001, maxAgeMs: 1 }); });

  console.log('helper-reset-safety-smoke: malformed snapshots and time options');
  for (const [label, value] of [
    ['missing', undefined], ['null', null], ['boolean', false], ['number', 1],
    ['string', 'verified'], ['array', []], ['empty', {}]
  ]) test(`snapshot ${label}`, () => { blocked(value); });
  for (const [label, value] of [['missing', undefined], ['null', null], ['false', false], ['array', []], ['string', '1'], ['wrong', 2]]) {
    reject(`snapshot schema ${label}`, snapshot => { snapshot.schemaVersion = value; });
  }
  for (const container of ['operation', 'probes']) {
    for (const [label, value] of [['missing', undefined], ['null', null], ['array', []], ['number', 1], ['string', 'verified']]) {
      reject(`${container} ${label}`, snapshot => { snapshot[container] = value; });
    }
  }
  for (const [label, value] of [
    ['missing', undefined], ['null', null], ['zero', 0], ['negative', -1],
    ['fraction', 1100.5], ['string', '1100'], ['NaN', NaN], ['infinite', Infinity],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1]
  ]) test(`nowMs ${label}`, () => { blocked(fixture(), { ...OPTIONS, nowMs: value }); });
  for (const [label, value] of [
    ['null', null], ['zero', 0], ['negative', -1], ['fraction', 1.5], ['string', '5000'],
    ['NaN', NaN], ['infinite', Infinity], ['above ceiling', 5001], ['unsafe', Number.MAX_SAFE_INTEGER + 1]
  ]) test(`maxAgeMs ${label}`, () => { blocked(fixture(), { ...OPTIONS, maxAgeMs: value }); });

  console.log('helper-reset-safety-smoke: every probe must prove scope and freshness');
  for (const probe of PROBES) {
    for (const [label, value] of [['missing', undefined], ['null', null], ['array', []], ['string', 'verified']]) {
      reject(`${probe} ${label}`, snapshot => { snapshot.probes[probe] = value; });
    }
    for (const field of ['schemaVersion', 'status', 'complete', 'capturedAtMs', 'machineId', 'accountSid', 'operationId', 'generation', 'leaseNonce']) {
      reject(`${probe}.${field} missing`, snapshot => { delete snapshot.probes[probe][field]; });
      reject(`${probe}.${field} null`, snapshot => { snapshot.probes[probe][field] = null; });
    }
    for (const status of ['unknown', 'failed', 'timeout', 'unavailable', 'verified-partial']) {
      reject(`${probe} status ${status}`, snapshot => { snapshot.probes[probe].status = status; });
    }
    for (const value of [false, 0, 'true']) reject(`${probe} incomplete ${String(value)}`, snapshot => { snapshot.probes[probe].complete = value; });
    reject(`${probe} wrong schema`, snapshot => { snapshot.probes[probe].schemaVersion = 2; });
    reject(`${probe} replayed machine`, snapshot => { snapshot.probes[probe].machineId = 'machine-b'; });
    reject(`${probe} replayed account`, snapshot => { snapshot.probes[probe].accountSid = CURRENT_SID; });
    reject(`${probe} replayed operation`, snapshot => { snapshot.probes[probe].operationId = 'repair-b'; });
    reject(`${probe} replayed generation`, snapshot => { snapshot.probes[probe].generation = 2; });
    reject(`${probe} replayed lease`, snapshot => { snapshot.probes[probe].leaseNonce = 'lease-b'; });
    reject(`${probe} numeric generation string`, snapshot => { snapshot.probes[probe].generation = '1'; });
    reject(`${probe} future capture`, snapshot => { snapshot.probes[probe].capturedAtMs = 1101; });
    reject(`${probe} stale at boundary`, snapshot => { snapshot.probes[probe].capturedAtMs = 100; }, { nowMs: 5100, maxAgeMs: 5000 });
    reject(`${probe} negative capture`, snapshot => { snapshot.probes[probe].capturedAtMs = -1; });
    reject(`${probe} fractional capture`, snapshot => { snapshot.probes[probe].capturedAtMs = 1000.5; });
    reject(`${probe} capture string`, snapshot => { snapshot.probes[probe].capturedAtMs = '1000'; });
  }

  console.log('helper-reset-safety-smoke: identity and protected accounts');
  for (const field of ['id', 'generation', 'machineId', 'machineSid', 'accountSid', 'accountName', 'leaseNonce']) {
    reject(`operation.${field} missing`, snapshot => { delete snapshot.operation[field]; });
    reject(`operation.${field} null`, snapshot => { snapshot.operation[field] = null; });
  }
  for (const value of [0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    reject(`operation generation ${String(value)}`, snapshot => { snapshot.operation.generation = value; });
  }
  for (const field of ['id', 'machineId', 'leaseNonce']) {
    for (const value of ['', ' ', 1, false, []]) reject(`operation ${field} malformed ${JSON.stringify(value)}`, snapshot => { snapshot.operation[field] = value; });
  }
  for (const sid of [
    '', 'user1', 'S-1-5-18', MACHINE_SID, `${ACCOUNT_SID}-1`, `${ACCOUNT_SID} `,
    ` ${ACCOUNT_SID}`, 'S-1-5-21-111-222-333-500', 'S-1-5-21-111-222-333-501',
    'S-1-5-21-111-222-333-0', 'S-1-5-21-111-222-333-4294967296',
    'S-1-5-21-0111-222-333-1001', 'S-1-5-21-444-555-666-1001'
  ]) test(`unmanaged account SID ${sid}`, () => {
    ready();
    const snapshot = fixture();
    snapshot.operation.accountSid = sid;
    for (const probe of Object.values(snapshot.probes)) probe.accountSid = sid;
    snapshot.probes.profile.ownerSid = sid;
    snapshot.probes.profile.registeredSid = sid;
    assert.ok(blocked(snapshot).blockers.includes('invalid_operation_identity'));
  });
  reject('binding machine SID differs', snapshot => { snapshot.probes.binding.machineSid = 'S-1-5-21-444-555-666'; });
  reject('binding account name differs', snapshot => { snapshot.probes.binding.accountName = 'operator'; });
  reject('binding ownership unproved', snapshot => { snapshot.probes.binding.ownerVerified = false; });
  reject('binding storage unprotected', snapshot => { snapshot.probes.binding.storageProtected = false; });
  for (const value of ['operator', 'user1.other', 'user10', '', 'user1 ', 'user1\u0000']) {
    reject(`unmanaged account name ${JSON.stringify(value)}`, snapshot => { snapshot.operation.accountName = value; });
  }
  for (const field of ['exists', 'isLocal', 'accountType', 'name', 'currentUserSid', 'currentUserProfilePath', 'builtin', 'protected', 'enabled']) {
    reject(`account.${field} missing`, snapshot => { delete snapshot.probes.account[field]; });
  }
  for (const [field, value] of [
    ['exists', false], ['isLocal', false], ['accountType', 'group'], ['name', 'operator'],
    ['builtin', true], ['protected', true], ['enabled', true], ['enabled', 'false'],
    ['currentUserSid', ACCOUNT_SID], ['currentUserSid', 'unknown'], ['currentUserSid', ''],
    ['currentUserProfilePath', 'C:\\Users\\user1'], ['currentUserProfilePath', 'C:\\Users\\user1\\child']
  ]) reject(`unsafe account ${field} ${String(value)}`, snapshot => { snapshot.probes.account[field] = value; });

  console.log('helper-reset-safety-smoke: teardown, profiles, logon and writer fences');
  for (const [field, value] of [
    ['outcome', 'failed'], ['outcome', 'timeout'], ['outcome', 'unknown'],
    ['timedOut', true], ['spawnFailed', true], ['terminationConfirmed', false],
    ['timedOut', 'false'], ['spawnFailed', 'false'], ['terminationConfirmed', 'true']
  ]) reject(`shutdown ${field} ${String(value)}`, snapshot => { snapshot.probes.shutdown[field] = value; });
  for (const field of ['outcome', 'timedOut', 'spawnFailed', 'terminationConfirmed']) {
    reject(`shutdown ${field} missing`, snapshot => { delete snapshot.probes.shutdown[field]; });
  }
  for (const [probe, field] of [['sessions', 'activeCount'], ['sessions', 'unknownOwnerCount'], ['processes', 'remainingCount'], ['processes', 'unknownOwnerCount']]) {
    for (const value of [undefined, null, 1, -1, 0.5, '0', false, NaN, Infinity]) {
      reject(`${probe}.${field} ${String(value)}`, snapshot => { snapshot.probes[probe][field] = value; });
    }
  }
  for (const field of ['exists', 'loaded', 'special', 'hiveLoaded', 'path', 'profilesRoot', 'ownerSid', 'ownershipVerified', 'ancestorsReparseFree', 'leafReparseFree', 'profilesRootVerified', 'registeredSid', 'registeredPath']) {
    reject(`profile.${field} missing`, snapshot => { delete snapshot.probes.profile[field]; });
    reject(`profile.${field} null`, snapshot => { snapshot.probes.profile[field] = null; });
  }
  for (const [field, value] of [
    ['exists', false], ['loaded', true], ['loaded', 'false'], ['special', true], ['hiveLoaded', true],
    ['ownerSid', CURRENT_SID], ['ownershipVerified', false], ['ancestorsReparseFree', false], ['leafReparseFree', false],
    ['profilesRootVerified', false], ['profilesRootVerified', 'true'], ['registeredSid', CURRENT_SID],
    ['registeredPath', 'C:\\Users\\operator'], ['registeredPath', 'C:\\Users\\user1:stream']
  ]) reject(`unsafe profile ${field} ${String(value)}`, snapshot => { snapshot.probes.profile[field] = value; });
  for (const path of [
    '', '.', 'user1', 'C:user1', '\\Users\\user1', 'C:\\', 'C:\\Users',
    'C:\\Users\\operator', 'C:\\Users\\Public', 'C:\\Users\\Default', 'C:\\Windows\\user1',
    'C:\\Users\\user10', 'C:\\Users\\user1.other', 'C:\\Users\\user1\\child',
    'C:\\Users\\..\\Windows', 'C:\\Users\\.\\user1', 'C:\\Users\\user1\\..\\operator',
    'C:/Users/user1', 'C:\\Users\\user1.', 'C:\\Users\\user1 ', 'C:\\Users\\user1:stream',
    'C:\\Users\\user*', 'C:\\Users\\user?', '\\\\server\\share\\user1',
    '\\\\?\\C:\\Users\\user1', '\\\\.\\C:\\Users\\user1', 'C:\\Users\\user1\u0000',
    'C:\\Users\\user1\n', 'C:\\Users\\user1\r'
  ]) reject(`unsafe profile path ${JSON.stringify(path)}`, snapshot => { snapshot.probes.profile.path = path; });
  for (const root of ['', 'C:\\', 'C:\\Windows', 'C:Users', '\\\\server\\share', '\\\\?\\C:\\Users', 'C:\\Users\\..\\Users']) {
    reject(`invalid or inconsistent profiles root ${JSON.stringify(root)}`, snapshot => { snapshot.probes.profile.profilesRoot = root; });
  }
  for (const reserved of ['CON', 'PRN.txt', 'AUX', 'NUL', 'COM1', 'LPT9.log', 'COM\u00b9', 'LPT\u00b3']) {
    reject(`reserved device ancestor ${reserved}`, snapshot => {
      const root = `C:\\Users\\${reserved}`;
      snapshot.probes.profile.profilesRoot = root;
      snapshot.probes.profile.path = root + '\\user1';
      snapshot.probes.profile.registeredPath = root + '\\user1';
    });
  }
  reject('operator profile case variation is still protected', snapshot => { snapshot.probes.account.currentUserProfilePath = 'c:\\users\\USER1'; });
  reject('account and profile absent use a separate creation path', snapshot => { snapshot.probes.account.exists = false; snapshot.probes.profile.exists = false; });
  for (const [field, value] of [['kind', 'logoff-requested'], ['kind', 'unknown'], ['applied', false], ['applied', 'true']]) {
    reject(`logon fence ${field} ${String(value)}`, snapshot => { snapshot.probes.logonFence[field] = value; });
  }
  for (const field of ['kind', 'applied', 'appliedAtMs']) reject(`logon fence ${field} missing`, snapshot => { delete snapshot.probes.logonFence[field]; });
  for (const [field, value] of [
    ['scope', 'account'], ['held', false], ['exclusive', false], ['nonce', 'lease-b'],
    ['unresolvedWriter', true], ['held', 'true'], ['exclusive', 'true']
  ]) reject(`lease ${field} ${String(value)}`, snapshot => { snapshot.probes.lease[field] = value; });
  for (const field of ['scope', 'held', 'exclusive', 'nonce', 'unresolvedWriter', 'acquiredAtMs', 'expiresAtMs']) {
    reject(`lease ${field} missing`, snapshot => { delete snapshot.probes.lease[field]; });
  }
  for (const value of [null, 0, -1, 1100, 1099, 1200.5, '6000', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    reject(`lease invalid or expired deadline ${String(value)}`, snapshot => { snapshot.probes.lease.expiresAtMs = value; });
  }
  console.log('helper-reset-safety-smoke: coherent fence, shutdown and lease ordering');
  for (const value of [null, 0, -1, 1001, 950.5, '950', NaN, Infinity]) {
    reject(`invalid fence application time ${String(value)}`, snapshot => { snapshot.probes.logonFence.appliedAtMs = value; });
    reject(`invalid lease acquisition time ${String(value)}`, snapshot => { snapshot.probes.lease.acquiredAtMs = value; });
  }
  for (const probe of PROBES) {
    reject(`${probe} observed before writer lease`, snapshot => { snapshot.probes[probe].capturedAtMs = 899; });
  }
  reject('fence applied before exclusive lease', snapshot => { snapshot.probes.logonFence.appliedAtMs = 899; });
  for (const probe of ['account', 'shutdown', 'sessions', 'processes', 'profile']) {
    reject(`${probe} clearance precedes logon fence`, snapshot => { snapshot.probes[probe].capturedAtMs = 949; });
  }
  for (const probe of ['sessions', 'processes']) {
    test(`${probe} clear observation precedes shutdown confirmation`, () => {
      ready();
      const snapshot = fixture();
      snapshot.probes[probe].capturedAtMs = 999;
      assert.ok(blocked(snapshot).blockers.includes(probe + '_before_shutdown'));
    });
  }
  for (const probe of ['sessions', 'processes']) {
    test(`profile loaded-state precedes ${probe} clearance`, () => {
      ready();
      const snapshot = fixture();
      snapshot.probes[probe].capturedAtMs = 1001;
      assert.ok(blocked(snapshot).blockers.includes('profile_before_clearance'));
    });
  }
  test('ordered observations after fence and lease can be ready', () => {
    const snapshot = fixture();
    snapshot.probes.shutdown.capturedAtMs = 1001;
    snapshot.probes.sessions.capturedAtMs = 1002;
    snapshot.probes.processes.capturedAtMs = 1003;
    snapshot.probes.profile.capturedAtMs = 1004;
    assert.equal(ready(snapshot).decision, 'ready');
  });
  for (const [field, value] of [['unresolved', true], ['unresolved', 'false'], ['phase', 'deleting'], ['phase', 'interrupted'], ['phase', 'unknown']]) {
    reject(`journal ${field} ${String(value)}`, snapshot => { snapshot.probes.journal[field] = value; });
  }
  for (const field of ['unresolved', 'phase']) reject(`journal ${field} missing`, snapshot => { delete snapshot.probes.journal[field]; });

  console.log('helper-reset-safety-smoke: deterministic decisions and immutable inputs');
  test('deep-frozen valid input is unchanged and deterministic', () => {
    const snapshot = freezeDeep(fixture());
    const options = freezeDeep({ ...OPTIONS });
    const before = JSON.stringify(snapshot);
    const first = ready(snapshot, options);
    assert.deepEqual(ready(snapshot, options), first);
    assert.equal(JSON.stringify(snapshot), before);
  });
  test('deep-frozen blocked input returns useful reasons without mutation', () => {
    const snapshot = fixture();
    snapshot.probes.profile.loaded = true;
    snapshot.probes.processes.remainingCount = 1;
    freezeDeep(snapshot);
    const before = JSON.stringify(snapshot);
    assert.deepEqual(blocked(snapshot), blocked(snapshot));
    assert.equal(JSON.stringify(snapshot), before);
  });
  test('later generation invalidates unchanged earlier evidence', () => {
    const snapshot = fixture();
    snapshot.operation.generation = 2;
    blocked(snapshot);
  });
  test('new lease invalidates unchanged earlier evidence', () => {
    const snapshot = fixture();
    snapshot.operation.leaseNonce = 'lease-b';
    blocked(snapshot);
  });
  test('an earlier ready decision cannot keep a later stale snapshot ready', () => {
    const snapshot = fixture();
    ready(snapshot);
    blocked(snapshot, { nowMs: 6000, maxAgeMs: 5000 });
  });
  test('all-metadata cross-machine replay still conflicts with local SID binding', () => {
    const snapshot = fixture();
    snapshot.operation.machineSid = 'S-1-5-21-444-555-666';
    snapshot.probes.binding.machineSid = snapshot.operation.machineSid;
    blocked(snapshot);
  });
  test('combined missing-tool and loaded-profile failure never yields readiness', () => {
    const snapshot = fixture();
    snapshot.probes.sessions.status = 'unavailable';
    snapshot.probes.shutdown.terminationConfirmed = false;
    snapshot.probes.profile.loaded = true;
    snapshot.probes.journal.unresolved = true;
    blocked(snapshot);
  });
  test('no effect dependency or process/network/timer API was used', () => { assert.deepEqual(effects, []); });
} catch (error) {
  failed++;
  console.error(`FAIL helper-reset-safety: module contract unavailable: ${error.message}`);
} finally {
  Module._load = originalLoad;
  for (const restore of restores.reverse()) restore();
}

console.log(`helper-reset-safety-smoke: ${passed} passed, ${failed} failed; synthetic pure decisions only`);
if (failed) process.exitCode = 1;
