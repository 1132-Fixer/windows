'use strict';

// Pure evidence fixtures only. Never read the machine namespace or launch a
// shell, worker, profile operation or child process.
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
const nativeAttempts = [];
const forbidden = new Set(['fs', 'fs/promises', 'child_process', 'os', 'electron', 'net', 'http', 'https', 'worker_threads']);
Module._load = function (name, parent, main) {
  if (forbidden.has(name.replace(/^node:/, ''))) { nativeAttempts.push(name); throw new Error('native dependency forbidden'); }
  return originalLoad.call(this, name, parent, main);
};
let api;
const restores = [];
for (const [object, key] of [[process, 'kill'], [process, 'chdir'], [globalThis, 'setTimeout'], [globalThis, 'setInterval'], [globalThis, 'fetch'], [Date, 'now']]) {
  const original = object[key];
  if (typeof original !== 'function') continue;
  object[key] = () => { nativeAttempts.push(key); throw new Error('native API forbidden'); };
  restores.push(() => { object[key] = original; });
}
try { api = require('../src/main/repair-recovery'); }
catch (error) { Module._load = originalLoad; for (const restore of restores.reverse()) restore(); throw error; }
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; }
  catch (error) { failed++; console.error('FAIL repair-recovery: ' + name + ': ' + error.message); }
}
const clone = value => JSON.parse(JSON.stringify(value));
const context = { expectedMachineId: 'DESKTOP-NVH6QUO', nowMs: 101000 };
function acl(directory) {
  return { ownerSid: 'S-1-5-32-544', protected: true, canonical: true,
    rules: ['S-1-5-18', 'S-1-5-32-544'].map(sid => ({ sid, allow: true, inherited: false, rights: 2032127, inheritance: directory ? 3 : 0, propagation: 0 })) };
}
function fixture() {
  const paths = ['C:\\', 'C:\\ProgramData', 'C:\\ProgramData\\1132 Fixer', api.STATE_ROOT];
  const lease = { status: 'held', scope: 'machine', exclusive: true, operationId: 'repair-one', generation: 1,
    machineId: context.expectedMachineId, machineSid: 'S-1-5-21-11-22-33', machineVerified: true,
    nonce: 'lease-one', acquiredAtMs: 90000, expiresAtMs: 3690000, unresolved: false };
  const journal = { status: 'persisted', complete: true, schemaVersion: 1, operationId: lease.operationId,
    generation: lease.generation, machineId: lease.machineId, accountSid: lease.machineSid + '-1001',
    leaseNonce: lease.nonce, capturedAtMs: 100000, profilePath: 'C:\\Users\\user1', phase: 'complete', unresolved: false, storageProtected: true };
  const file = (name, document) => ({ state: 'present', path: api.STATE_ROOT + '\\' + name, verified: true,
    reparseFree: true, exclusiveRead: true, acl: acl(false), document });
  return { schemaVersion: 1, kind: 'repair-recovery', machineId: context.expectedMachineId,
    startedAtMs: 100500, capturedAtMs: 100600, status: 'observed', complete: true, reason: null,
    namespace: { state: 'present', missingPath: null, nodes: paths.map((path, index) => ({ path, reparseFree: true, acl: index < 2 ? null : acl(true) })), observation: 'point-in-time' },
    lease: file('lease.json', lease), journal: file('journal.json', journal) };
}
function processResult(evidence) {
  return { code: 0, timedOut: false, cleanupConfirmed: true, stdinComplete: true,
    stdoutTruncated: false, stderrTruncated: false, outcome: 'exited', stdout: JSON.stringify(evidence) + '\n', stderr: '' };
}
function parse(evidence, options = context) { return api.parseRecoveryProbeResult(processResult(evidence), options); }
function rejectMutation(name, mutate) {
  test(name, () => {
    const evidence = fixture(); assert.equal(parse(evidence).status, 'clear', 'positive control before mutation');
    mutate(evidence); const result = parse(evidence); assert.equal(result.blocked, true); assert.equal(result.unresolved, true);
  });
}
function absent(name) { return { state: 'absent', path: api.STATE_ROOT + '\\' + name, verified: true }; }

test('matching completed native records clear only point-in-time startup state', () => {
  const result = parse(fixture()); assert.equal(result.status, 'clear'); assert.equal(result.verified, true);
  assert.equal(result.leaseHeld, false); assert.equal(result.observation, 'point-in-time');
  assert.equal(result.leaseState, 'released'); assert.equal(result.journalState, 'complete'); assert.equal(result.expiresAtMs, 105500);
});
test('verified empty existing namespace is clear', () => {
  const value = fixture(); value.lease = absent('lease.json'); value.journal = absent('journal.json');
  assert.equal(parse(value).status, 'clear');
});
for (const missingIndex of [2, 3]) test('only positively absent product-directory leaf can establish fresh absence', () => {
  const value = fixture(); value.lease = absent('lease.json'); value.journal = absent('journal.json');
  value.namespace = { state: 'absent', missingPath: value.namespace.nodes[missingIndex].path,
    nodes: value.namespace.nodes.slice(0, missingIndex), observation: 'point-in-time' };
  assert.equal(parse(value).status, 'clear');
});
test('clean native admission release can have no journal because no repair started', () => {
  const value = fixture(); value.journal = absent('journal.json'); assert.equal(parse(value).status, 'clear');
});
test('completed historical records need no unexpired old lease', () => {
  const value = fixture(); value.startedAtMs = 4000000; value.capturedAtMs = 4000100;
  assert.equal(parse(value, { ...context, nowMs: 4000200 }).status, 'clear');
  value.lease.document.unresolved = true;
  assert.equal(parse(value, { ...context, nowMs: 4000200 }).reason, 'recovery_required', 'expiry never resolves interrupted effects');
});
for (const [field, invalid] of Object.entries({ code: 1, timedOut: true, cleanupConfirmed: false, stdinComplete: false,
  stdoutTruncated: true, stderrTruncated: true, outcome: 'exit-unclosed', stderr: 'unverified warning' })) {
  test('incomplete process ' + field + ' cannot clear even with valid JSON', () => {
    const result = processResult(fixture()); assert.equal(api.parseRecoveryProbeResult(result, context).status, 'clear');
    result[field] = invalid; assert.equal(api.parseRecoveryProbeResult(result, context).reason, 'probe_process_unverified');
  });
}
test('oversized, duplicate-key, multi-frame, whitespace-variant and malformed JSON fail closed', () => {
  const valid = processResult(fixture()); const body = valid.stdout.trim();
  for (const stdout of ['x'.repeat(api.MAX_RESULT_BYTES + 1), '{bad}', body + '\n' + body,
    body.replace('{', '{"schemaVersion":1,'), body.replace('{', '{ ')]) {
    assert.equal(api.parseRecoveryProbeResult({ ...valid, stdout }, context).blocked, true);
  }
});
test('throwing input properties cannot escape fail-closed parsing', () => {
  const result = api.parseRecoveryProbeResult({ get code() { throw new Error('unknown process metadata'); } }, context);
  assert.equal(result.blocked, true); assert.equal(result.reason, 'probe_evidence_invalid');
});
for (const options of [{ ...context, expectedMachineId: 'foreign' }, { ...context, nowMs: 100599 },
  { ...context, nowMs: 105500 }, { ...context, ttlMs: 0 }, { ...context, ttlMs: api.MAX_AGE_MS + 1 },
  { ...context, nowMs: NaN }, { expectedMachineId: context.expectedMachineId }]) {
  test('scope and freshness context cannot be guessed or extended', () => { assert.equal(parse(fixture(), options).blocked, true); });
}
const mutations = [
  ['wrong machine observation', value => { value.machineId = 'foreign'; }],
  ['incomplete observation', value => { value.complete = false; }],
  ['invented clear status', value => { value.status = 'clear'; }],
  ['future capture', value => { value.capturedAtMs = context.nowMs + 1; }],
  ['capture predates start', value => { value.capturedAtMs = value.startedAtMs - 1; }],
  ['unbounded observation span', value => { value.startedAtMs = 96000; }],
  ['unknown envelope fields', value => { value.trusted = true; }],
  ['missing namespace node', value => { value.namespace.nodes.pop(); }],
  ['wrong ancestor', value => { value.namespace.nodes[0].path = 'D:\\'; }],
  ['reparse ancestor', value => { value.namespace.nodes[1].reparseFree = false; }],
  ['missing OS ancestor is not fresh product absence', value => { value.namespace.state = 'absent'; value.namespace.missingPath = 'C:\\ProgramData'; value.namespace.nodes = value.namespace.nodes.slice(0, 1); }],
  ['unknown namespace observation', value => { value.namespace.observation = 'atomic'; }],
  ['private directory owner', value => { value.namespace.nodes[2].acl.ownerSid = 'S-1-5-21-1-2-3-1001'; }],
  ['unprotected directory ACL', value => { value.namespace.nodes[3].acl.protected = false; }],
  ['noncanonical ACL', value => { value.namespace.nodes[3].acl.canonical = false; }],
  ['unrelated ACE principal', value => { value.namespace.nodes[3].acl.rules[0].sid = 'S-1-1-0'; }],
  ['missing SYSTEM rule', value => { value.namespace.nodes[3].acl.rules[0].sid = 'S-1-5-32-544'; }],
  ['deny rule', value => { value.namespace.nodes[3].acl.rules[0].allow = false; }],
  ['inherited private rule', value => { value.namespace.nodes[3].acl.rules[0].inherited = true; }],
  ['incomplete ACL rights', value => { value.namespace.nodes[3].acl.rules[0].rights = 1179785; }],
  ['wrong directory propagation', value => { value.namespace.nodes[3].acl.rules[0].propagation = 2; }],
  ['wrong directory inheritance', value => { value.namespace.nodes[3].acl.rules[0].inheritance = 0; }],
  ['extra ACL rule', value => { value.namespace.nodes[3].acl.rules.push(clone(value.namespace.nodes[3].acl.rules[0])); }],
  ['wrong lease path', value => { value.lease.path = 'C:\\elsewhere\\lease.json'; }],
  ['unverified absence', value => { value.lease = absent('lease.json'); value.lease.verified = false; }],
  ['journal without lease', value => { value.lease = absent('lease.json'); }],
  ['present file under absent parent', value => { value.namespace.state = 'absent'; value.namespace.missingPath = api.STATE_ROOT; value.namespace.nodes.pop(); }],
  ['file reparse', value => { value.lease.reparseFree = false; }],
  ['held native lease cannot be read exclusively', value => { value.lease.exclusiveRead = false; }],
  ['file owner mismatch', value => { value.journal.acl.ownerSid = 'S-1-1-0'; }],
  ['inherited file ACL', value => { value.lease.acl.rules[0].inheritance = 3; }],
  ['unresolved lease', value => { value.lease.document.unresolved = true; }],
  ['unknown lease state', value => { value.lease.document.status = 'unknown'; }],
  ['nonboolean lease state', value => { value.lease.document.unresolved = 'false'; }],
  ['foreign lease machine', value => { value.lease.document.machineId = 'foreign'; }],
  ['unverified machine lease', value => { value.lease.document.machineVerified = false; }],
  ['nonmachine lease scope', value => { value.lease.document.scope = 'process'; }],
  ['nonexclusive lease record', value => { value.lease.document.exclusive = false; }],
  ['malformed machine SID', value => { value.lease.document.machineSid = 'S-1-5-21-4294967296-2-3'; }],
  ['lease acquisition future', value => { value.lease.document.acquiredAtMs = 100601; }],
  ['lease duration unknown', value => { value.lease.document.expiresAtMs++; }],
  ['unknown lease field', value => { value.lease.document.partial = false; }],
  ['partial journal', value => { value.journal.document.partial = true; }],
  ['unknown journal phase', value => { value.journal.document.phase = 'releasing-owned-resources'; }],
  ['unresolved journal', value => { value.journal.document.unresolved = true; }],
  ['false completion', value => { value.journal.document.complete = false; }],
  ['foreign operation', value => { value.journal.document.operationId = 'foreign'; }],
  ['foreign generation', value => { value.journal.document.generation++; }],
  ['foreign lease nonce', value => { value.journal.document.leaseNonce = 'foreign'; }],
  ['foreign SID domain', value => { value.journal.document.accountSid = 'S-1-5-21-12-22-33-1001'; }],
  ['protected account RID', value => { value.journal.document.accountSid = 'S-1-5-21-11-22-33-500'; }],
  ['wrong profile target', value => { value.journal.document.profilePath = 'C:\\Users\\other'; }],
  ['journal predates lease', value => { value.journal.document.capturedAtMs = 89999; }],
  ['journal capture future', value => { value.journal.document.capturedAtMs = 100601; }],
  ['storage protection missing', value => { value.journal.document.storageProtected = false; }]
];
for (const [name, mutate] of mutations) rejectMutation(name, mutate);
for (const reason of ['lease_busy', 'read_denied', 'state_invalid', 'storage_unverified', 'probe_timeout']) test('native ' + reason + ' is useful blocked evidence, never absence', () => {
  const value = fixture(); value.status = 'blocked'; value.complete = false; value.reason = reason;
  value.namespace = value.lease = value.journal = null;
  const result = parse(value); assert.equal(result.reason, reason); assert.equal(result.blocked, true); assert.equal(result.verified, false);
});
test('fixed script has only read opens and no native worker, policy override, process or storage mutation', () => {
  const script = api.RECOVERY_PROBE_SCRIPT;
  assert.match(script, /\[IO\.FileAccess\]::Read,\[IO\.FileShare\]::None/);
  assert.match(script, /\[Environment\]::MachineName/);
  assert.match(script, /AreAccessRulesProtected/);
  assert.match(script, /FileNotFoundException/);
  assert.doesNotMatch(script, /Add-Type|DllImport|Start-Process|New-Item|Set-Acl|CreateDirectory|CreateNew|WriteAll|SetLength|\.Write\(|ExecutionPolicy|taskkill|Get-LocalUser|Get-CimInstance/i);
});
test('pure module attempted no native dependency', () => { assert.deepEqual(nativeAttempts, []); });
Module._load = originalLoad;
for (const restore of restores.reverse()) restore();
console.log('repair-recovery-smoke: ' + passed + ' passed, ' + failed + ' failed; pure canonical evidence fixtures only');
if (failed) process.exitCode = 1;
