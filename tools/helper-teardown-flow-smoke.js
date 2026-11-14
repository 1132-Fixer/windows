'use strict';

// Run actual main orchestration with the real session/controller/policy and
// the canonical inert native fixture. Never start a worker or OS operation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Module = require('node:module');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const fixtureSource = fs.readFileSync(path.join(__dirname, 'repair-session-smoke.js'), 'utf8');
const nativeSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'helper-reset-windows.js'), 'utf8');
const messages = require('../messages');
function fn(name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(main);
  assert.ok(match, 'maintained main function missing: ' + name);
  const end = main.indexOf('\n}', match.index);
  assert.ok(end > match.index); return main.slice(match.index, end + 2);
}
function between(source, start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'canonical inert fixture boundary missing');
  return source.slice(first, last);
}
const nativeAttempts = [], restores = [], originalLoad = Module._load;
const forbidden = new Set(['fs', 'fs/promises', 'child_process', 'os', 'electron', 'net', 'http', 'https', 'worker_threads']);
Module._load = function (name, parent, isMain) {
  if (forbidden.has(name.replace(/^node:/, '')) || /helper-reset-windows|windows-repair-transport/.test(name)) {
    nativeAttempts.push(name); throw new Error('native dependency forbidden in teardown wiring');
  }
  return originalLoad.call(this, name, parent, isMain);
};
for (const [object, key] of [[process, 'kill'], [process, 'chdir'], [globalThis, 'setTimeout'], [globalThis, 'setInterval'], [globalThis, 'fetch'], [Date, 'now']]) {
  const original = object[key]; if (typeof original !== 'function') continue;
  object[key] = () => { nativeAttempts.push(key); throw new Error('native API forbidden in teardown wiring'); };
  restores.push(() => { object[key] = original; });
}
const { createRepairSession } = require('../src/main/repair-session');
// Share the maintained fixture definition, not its tests or harness. The
// selected declarations only construct inert adapters and deterministic clocks.
// Compiling here in the current realm preserves strict object comparisons.
const fixtureCode = between(fixtureSource, 'const MACHINE =', 'let checks =') +
  between(fixtureSource, 'class FakeTimers', '\nasync function check(');
const fixtureApi = Function('assert', 'crypto', 'createRepairSession', 'Buffer', fixtureCode +
  '\nreturn { fixture, flushUntil, flush, deferred, ZOOM, PROFILE, OLD_SID, NEW_SID };')(assert, crypto, createRepairSession, Buffer);
const { ZOOM, PROFILE, OLD_SID, NEW_SID, deferred, flush, flushUntil } = fixtureApi;
const DATA_EFFECTS = new Set(['purgeProfile', 'deleteAccount', 'createDisabledAccount', 'createProfile', 'enableAccount']);
function flow(settings = {}, options = {}) {
  const native = fixtureApi.fixture({ kind: 'bound-existing', ...settings });
  const state = { lookups: 0, requests: [], events: [], polls: [], legacyCalls: 0 };
  const context = {
    preflightCheck: options.preflight || (async () => ({ ok: true, blockers: [], warnings: [], info: { zoomPath: ZOOM, tools: { pwsh: true } } })),
    getRepairSession: () => {
      state.lookups++;
      return { run: input => { state.requests.push(input); return native.session.run(input); },
        hasUnresolvedCustody: () => native.session.hasUnresolvedCustody() };
    },
    criticalOps: { poll: value => state.polls.push(value) }, unresolvedProcessCustody: false,
    runProcess: () => { state.legacyCalls++; throw new Error('legacy process path forbidden'); },
    runPSScript: () => { state.legacyCalls++; throw new Error('legacy script path forbidden'); },
    runPSCapture: () => { state.legacyCalls++; throw new Error('legacy capture path forbidden'); }
  };
  const run = vm.runInNewContext('(' + fn('runFixFlow') + ')', context, { timeout: 1000 });
  const sender = {
    send(channel, payload) {
      state.events.push({ channel, payload });
      if (options.send) options.send(channel, payload);
    }
  };
  return { ...native, context, mainState: state, run: () => run({ sender }),
    dataEffects: () => native.calls.filter(call => DATA_EFFECTS.has(call.name)) };
}
function preflight(changes = {}) {
  const settings = { elevated: true, operator: 'operator', host: true, recovery: { status: 'clear', verified: true }, ...changes };
  const context = {
    isElevatedSync: async () => settings.elevated, os: { userInfo: () => ({ username: settings.operator }) },
    FIX_USER: 'user1', messages, zoomInstall: null, unresolvedProcessCustody: false, repairSession: null,
    resolvePowerShell7: () => { if (!settings.host) throw new Error('protected host unavailable'); return 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'; },
    resolveZoomInstall: async () => ({ path: ZOOM }), zoomDetect: { zoomStatusMessage: () => 'Zoom unavailable' },
    refreshRepairRecovery: async () => settings.recovery
  };
  return vm.runInNewContext('(' + fn('preflightCheck') + ')', context, { timeout: 1000 })();
}
let passed = 0, failed = 0, finished = false;
process.once('beforeExit', () => { if (!finished) { console.error('FAIL helper-teardown-flow: unfinished async suite'); process.exitCode = 1; } });
async function test(name, invoke) {
  try { await invoke(); passed++; }
  catch (error) { failed++; console.error('FAIL helper-teardown-flow: ' + name + ': ' + error.message); }
}
async function positive() {
  const f = flow(); const result = await f.run(); assert.equal(result.success, true, 'canonical bound-existing positive control');
  assert.equal(f.dataEffects().filter(call => call.name === 'purgeProfile').length, 1);
  return f;
}
function wrapAdapter(f, name, mutate) {
  const original = f.native.adapters[name];
  f.native.adapters[name] = async context => { const proof = await original(context); return mutate(proof, context); };
}
(async () => {
  await test('main delegates one authorized exact target transaction to real session/controller', async () => {
    const f = await positive(); const request = f.mainState.requests[0];
    assert.equal(request.authorizeExactTarget, true); assert.equal(request.zoomPath, ZOOM);
    assert.equal(Object.hasOwn(request, 'profilePath'), false, 'renderer/config cannot choose purge path');
    assert.equal(f.mainState.events[0].payload.kind, 'header'); assert.match(f.mainState.events[0].payload.line, /^\[1\/8\]/);
    const purge = f.dataEffects().find(call => call.name === 'purgeProfile');
    assert.equal(purge.context.profilePath, PROFILE); assert.equal(purge.context.operation.accountSid, OLD_SID);
    assert.equal(purge.context.operation.accountName, 'user1');
    const create = f.dataEffects().find(call => call.name === 'createDisabledAccount');
    assert.ok(create); assert.equal(f.mainState.legacyCalls, 0); assert.equal(f.state.closed, true);
    assert.equal(f.state.held, false); assert.equal(f.state.journal.unresolved, false);
  });
  await test('explicit exact-target legacy migration uses verified native consent before purge', async () => {
    const f = flow({ kind: 'operator-target' }); assert.equal((await f.run()).success, true);
    const consent = f.calls.find(call => call.name === 'verifyOperatorTarget');
    assert.ok(consent); assert.equal(consent.context.consent.scope, 'purge-exact-local-user1');
    assert.equal(consent.context.consent.accountSid, OLD_SID); assert.equal(consent.context.consent.profilePath, PROFILE);
    const bindingIndex = f.calls.findIndex(call => call.name === 'persistBinding');
    assert.ok(bindingIndex >= 0 && bindingIndex < f.calls.findIndex(call => call.name === 'purgeProfile'));
  });
  await test('fresh positively absent target bypasses teardown and creates exact disabled identity', async () => {
    const f = flow({ kind: 'fresh-absent' }); assert.equal((await f.run()).success, true);
    assert.equal(f.calls.some(call => ['purgeProfile', 'deleteAccount', 'shutdownAccount'].includes(call.name)), false);
    assert.equal(f.dataEffects().filter(call => call.name === 'createDisabledAccount').length, 1);
    assert.equal(f.calls.find(call => call.name === 'createProfile').context.operation.accountSid, NEW_SID);
  });
  for (const changes of [{ elevated: false }, { operator: 'user1' }, { host: false }, { recovery: { status: 'blocked', verified: false } }]) {
    await test('actual read-only preflight failure prevents even native worker construction', async () => {
      const f = flow({}, { preflight: () => preflight(changes) }); const result = await f.run();
      assert.equal(result.success, false); assert.equal(result.error, 'preflight_failed');
      assert.equal(f.state.nativeCreates, 0); assert.equal(f.mainState.lookups, 0); assert.equal(f.mainState.events.length, 0);
      assert.equal(f.calls.length, 0);
    });
  }
  await test('Windows Home missing quser/logoff does not weaken independently verified native session probes', async () => {
    const result = await preflight(); assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result.info.tools, 'quser.exe'), false); assert.equal(Object.hasOwn(result.info.tools, 'logoff.exe'), false);
    const f = flow({}, { preflight: async () => result }); assert.equal((await f.run()).success, true);
    assert.equal(f.mainState.legacyCalls, 0); assert.ok(f.calls.some(call => call.name === 'captureResetSnapshot'));
  });
  await test('last cooperative header cancellation reaches broker unchanged before native work', async () => {
    const cancellation = Object.assign(new Error('synthetic cancellation'), { code: 'ERR_1132_FIX_CANCELLED' });
    const f = flow({}, { send: (_channel, payload) => { if (payload.kind === 'header') throw cancellation; } });
    await assert.rejects(f.run(), error => error === cancellation);
    assert.equal(f.state.nativeCreates, 0); assert.equal(f.mainState.lookups, 0); assert.equal(f.calls.length, 0);
  });
  await test('display failure after transaction begins cannot interrupt native machine ownership', async () => {
    const f = flow({}, { send: (_channel, payload) => { if (payload.kind === 'out') throw new Error('renderer unavailable'); } });
    assert.equal((await f.run()).success, true); assert.equal(f.state.closed, true); assert.equal(f.state.journal.unresolved, false);
  });
  const shutdownCases = [
    ['failed shutdown', proof => { proof.outcome = 'failed'; }],
    ['timed-out shutdown', proof => { proof.timedOut = true; }],
    ['unknown shutdown', proof => { delete proof.outcome; }],
    ['unconfirmed cleanup', proof => { proof.cleanupConfirmed = false; }],
    ['unconfirmed termination', proof => { proof.terminationConfirmed = false; }],
    ['remaining sessions', proof => { proof.remainingSessions = 1; }],
    ['remaining processes', proof => { proof.remainingProcesses = 1; }],
    ['unknown process/session owner', proof => { proof.unknownOwnerCount = 1; }]
  ];
  for (const [name, mutate] of shutdownCases) await test(name + ' cannot reach profile purge or recreation', async () => {
    await positive(); const f = flow(); wrapAdapter(f, 'shutdownAccount', proof => { mutate(proof); return proof; });
    const result = await f.run(); assert.equal(result.success, false); assert.equal(f.dataEffects().length, 0);
    assert.equal(f.state.journal.unresolved, true); assert.equal(f.state.closed, false);
    assert.equal(f.context.unresolvedProcessCustody, true); assert.equal(f.session.hasUnresolvedCustody(), true);
  });
  const snapshotCases = [
    ['missing sessions', value => { delete value.probes.sessions; }],
    ['unknown session count', value => { delete value.probes.sessions.activeCount; }],
    ['active session', value => { value.probes.sessions.activeCount = 1; }],
    ['unknown session owner', value => { value.probes.sessions.unknownOwnerCount = 1; }],
    ['missing process evidence', value => { delete value.probes.processes; }],
    ['residual process', value => { value.probes.processes.remainingCount = 1; }],
    ['unknown process owner', value => { value.probes.processes.unknownOwnerCount = 1; }],
    ['missing profile proof', value => { delete value.probes.profile; }],
    ['loaded profile', value => { value.probes.profile.loaded = true; }],
    ['loaded hive', value => { value.probes.profile.hiveLoaded = true; }],
    ['special profile', value => { value.probes.profile.special = true; }],
    ['foreign profile owner', value => { value.probes.profile.ownerSid = NEW_SID; }],
    ['profile junction', value => { value.probes.profile.leafReparseFree = false; }],
    ['lost lease', value => { value.probes.lease.held = false; }],
    ['prior unresolved journal', value => { value.probes.journal.priorUnresolved = true; }],
    ['stale fence evidence', value => { value.probes.logonFence.appliedAtMs = value.probes.account.capturedAtMs + 1; }],
    ['unverified shutdown snapshot', value => { value.probes.shutdown.terminationConfirmed = false; }]
  ];
  for (const [name, mutate] of snapshotCases) await test(name + ' cannot reach data-erasing effects', async () => {
    await positive(); const f = flow(); wrapAdapter(f, 'captureResetSnapshot', proof => { mutate(proof); return proof; });
    const result = await f.run(); assert.equal(result.success, false); assert.equal(f.dataEffects().length, 0);
    assert.equal(f.state.held, true); assert.equal(f.state.closed, false); assert.equal(f.context.unresolvedProcessCustody, true);
  });
  await test('denied exact-target proof cannot silently adopt or purge', async () => {
    const f = flow({ kind: 'operator-target', denyTarget: true }); assert.equal((await f.run()).success, false);
    assert.equal(f.calls.some(call => ['fenceAccount', 'shutdownAccount', 'purgeProfile', 'createDisabledAccount'].includes(call.name)), false);
  });
  await test('lost native custody at final safety capture stops all purge/recreate followup', async () => {
    const f = flow(); f.native.adapters.captureResetSnapshot = async () => { f.state.retained = true; throw new Error('lost owned worker'); };
    assert.equal((await f.run()).success, false); assert.equal(f.dataEffects().length, 0); assert.equal(f.state.closed, false);
    assert.equal(f.context.unresolvedProcessCustody, true);
  });
  await test('shutdown timeout and late fulfillment never resume erase operations or reopen retry', async () => {
    const gate = deferred(), f = flow(); const original = f.native.adapters.shutdownAccount;
    f.native.adapters.shutdownAccount = async context => { const result = await original(context); await gate.promise; return result; };
    const pending = f.run(); await flushUntil(() => f.calls.some(call => call.name === 'shutdownAccount'));
    f.timers.tick(10); const result = await pending; assert.equal(result.success, false); assert.equal(f.dataEffects().length, 0);
    gate.resolve(); await flush(); assert.equal(f.dataEffects().length, 0); assert.equal(f.state.held, true);
    const count = f.state.nativeCreates; assert.equal((await f.run()).success, false); assert.equal(f.state.nativeCreates, count);
    assert.equal(f.state.closed, false); assert.equal(f.context.unresolvedProcessCustody, true);
  });
  for (const mutate of [value => { value.ready = false; }, value => { value.liveHandleVerified = false; }]) {
    await test('final Zoom verification failure cannot become successful repair or closed lane evidence', async () => {
      await positive(); const f = flow(); const original = f.native.runWorkflowStep;
      f.native.runWorkflowStep = async (name, context, values) => { const proof = await original(name, context, values); if (name === 'verify-zoom') mutate(proof); return proof; };
      const result = await f.run(); assert.equal(result.success, false); assert.equal(f.state.closed, false);
      assert.equal(f.state.journal.unresolved, true); assert.equal(f.context.unresolvedProcessCustody, true);
    });
  }
  await test('maintained repair path has no legacy name kill, forced unload, service restart or session CLI fallback', () => {
    const repair = fn('runFixFlow') + fn('getRepairSession');
    assert.doesNotMatch(repair, /taskkill|force.*unload|ProfSvc|quser|logoff|runPSScript/i);
    assert.doesNotMatch(nativeSource, /taskkill|Restart-Service[^\r\n]*ProfSvc|Stop-Service[^\r\n]*ProfSvc|forceUnload|quser\.exe|logoff\.exe/i);
    assert.match(nativeSource, /WTSEnumerateSessions/); assert.match(nativeSource, /Win32_UserProfile/);
    assert.deepEqual(nativeAttempts, []);
  });
  Module._load = originalLoad; for (const restore of restores.reverse()) restore();
  console.log('helper-teardown-flow-smoke: ' + passed + ' passed, ' + failed + ' failed; actual main/session/controller with inert native fixtures');
  if (failed) process.exitCode = 1; finished = true;
})().catch(error => {
  Module._load = originalLoad; for (const restore of restores.reverse()) restore();
  console.error('FAIL helper-teardown-flow harness:', error.stack || error); process.exitCode = 1; finished = true;
});
