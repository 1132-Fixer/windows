'use strict';

// Execute maintained main wiring with inert processes, durable-store models,
// native sessions and Electron callbacks. Read source only; no OS command runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createBoundedProcessRunner } = require('../src/main/bounded-process');
const messages = require('../messages');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function section(start, end) {
  const first = main.indexOf(start), last = main.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'maintained production section missing: ' + start);
  return main.slice(first, last);
}
function fn(name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(main);
  assert.ok(match, 'maintained production function missing: ' + name);
  const end = main.indexOf('\n}', match.index);
  assert.ok(end > match.index, 'production function boundary missing: ' + name);
  return main.slice(match.index, end + 2);
}
function event(name) {
  const start = "app.on('" + name + "',";
  return section(start, '\n});') + '\n});';
}
const handlerSource = section("ipcMain.handle('run-fix',", '\n});') + '\n});';
const runnerSource = section('const boundedProcessRunner =', '\n});') + '\n});\n' + fn('runProcess');
const custodySource = section('let processCustodyStore = null;', 'function hasOwnedWork()') + '\n' +
  ['hasOwnedWork', 'hasActiveLocalWork', 'refreshRepairRecovery', 'retainFatalCustody'].map(fn).join('\n');
const fatalSource = section("process.on('uncaughtException',", '\n// ============================================================\n// Path / process helpers');
const windowCloseSource = section("  mainWindow.on('close',", '\n  });') + '\n  });';
class Clock {
  constructor() { this.now = 1000; this.serial = 0; this.jobs = new Map(); }
  setTimeout(fn, ms) { const id = ++this.serial; this.jobs.set(id, { at: this.now + ms, fn }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  tick(ms) {
    const end = this.now + ms; let guard = 0;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      assert.ok(++guard < 10000); this.jobs.delete(next[0]); this.now = next[1].at; next[1].fn();
    }
    this.now = end;
  }
}
class Child extends EventEmitter {
  constructor() {
    super(); this.pid = 123; this.kills = 0;
    this.stdout = new EventEmitter(); this.stderr = new EventEmitter();
    this.stdout.destroy = this.stderr.destroy = () => {};
    this.stdin = new EventEmitter(); this.stdin.end = (_bytes, callback) => callback();
  }
  kill() { this.kills++; return true; }
}
function durableStore() {
  const pending = new Map(), events = [];
  let serial = 0;
  const faults = {};
  return { pending, events, faults,
    begin(kind) {
      events.push('begin');
      if (faults.begin || pending.size) throw new Error('durable admission refused');
      const token = 'command-' + (++serial); pending.set(token, { kind, state: 'pending' }); return token;
    },
    complete(token, result) {
      events.push('complete'); assert.ok(pending.has(token)); assert.equal(result.cleanupConfirmed, true);
      if (faults.complete) throw new Error('durable completion refused');
      pending.delete(token);
    },
    retain(token, reason) {
      events.push('retain'); assert.ok(pending.has(token));
      if (faults.retain) throw new Error('durable retention refused');
      pending.set(token, { state: 'unresolved', reason });
    },
    inspect() { if (faults.inspect) throw new Error('unknown store'); return { blocked: pending.size > 0 }; }
  };
}
function fixture(options = {}) {
  const clock = new Clock(), child = new Child(), store = options.store || durableStore();
  const handlers = new Map(), appHandlers = new Map();
  const state = { spawns: 0, warnings: [], polls: [], dialogs: [], exits: 0, relaunches: 0, installs: 0,
    prevented: 0, releases: 0, reacquires: 0, elevationCalls: 0, recoveryCalls: 0, parsed: [], store };
  const context = vm.createContext({
    Buffer, Set, path, fs: {}, messages, Date: { now: () => clock.now },
    crypto: { randomBytes: () => Buffer.from('synthetic-id') },
    os: { hostname: () => 'machine-a' }, RECOVERY_PROBE_SCRIPT: 'fixed-read-only-probe', PROBE_TIMEOUT_MS: 8000,
    activeChildren: new Set(), fixInProgress: false, unresolvedProcessCustody: false, repairSession: null,
    nativeRecovery: { status: 'clear', verified: true }, fatalDialogShown: false, inactivityCtl: null,
    createProcessCustodyStore: () => store,
    createBoundedProcessRunner: deps => createBoundedProcessRunner({ ...deps, timers: clock }),
    spawn: () => { store.events.push('spawn'); state.spawns++; return child; },
    appLog: { warn: value => state.warnings.push(value) },
    criticalOps: { poll: value => state.polls.push(value), addSource: (name, callback) => handlers.set(name, callback) },
    app: { on: (name, callback) => appHandlers.set(name, callback), getPath: () => 'C:\\Mock\\AppData',
      exit: () => { state.exits++; }, relaunch: () => { state.relaunches++; },
      releaseSingleInstanceLock: () => { state.releases++; }, requestSingleInstanceLock: () => { state.reacquires++; },
      getAppPath: () => 'C:\\Mock\\app.asar', isPackaged: true },
    mainWindow: { on: (_name, callback) => appHandlers.set('window-close', callback) },
    process: { on: (name, callback) => handlers.set(name, callback), execPath: 'C:\\Mock\\Fixer.exe', argv: ['C:\\Mock\\Fixer.exe'] },
    dialog: { showErrorBox: (...args) => state.dialogs.push(args), showMessageBoxSync: () => 0 },
    shutdown: { note: () => 'user_exit', REASONS: { SYSTEM_SHUTDOWN: 'system_shutdown' } },
    updaterCtl: { isReady: () => true, installOnExit: () => { state.installs++; } },
    isElevatedSync: async () => false,
    elevCtl: { relaunchElevated: async () => { state.elevationCalls++; return { started: true, outcome: 'started' }; } },
    lastRelaunchOutcome: null, console: { warn: () => {} },
    runPSCapture: async () => { state.recoveryCalls++; return { synthetic: true }; },
    parseRecoveryProbeResult: (result, scope) => { state.parsed.push({ result, scope }); return { status: 'clear', verified: true }; }
  });
  vm.runInContext(custodySource + '\n' + runnerSource, context, { timeout: 1000 });
  return { context, state, store, clock, child, handlers, appHandlers,
    pendingTokens: () => vm.runInContext('processCustodyTokens.size', context) };
}
function repairContext(overrides = {}) {
  const state = { flowCalls: 0, polls: [], deferred: 0, updates: 0 };
  let handler;
  const context = {
    ipcMain: { handle: (channel, callback) => { assert.equal(channel, 'run-fix'); handler = callback; } },
    repairSession: null, unresolvedProcessCustody: false, fixInProgress: false, fixHasRun: false,
    criticalOps: { poll: value => state.polls.push(value) },
    updaterCtl: { isReady: () => true, defer: () => { state.deferred++; }, getStatus: () => ({ state: 'ready' }) },
    sendUpdateStatus: () => { state.updates++; },
    runFixFlow: async () => { state.flowCalls++; return { success: true }; }, ...overrides
  };
  vm.runInNewContext(handlerSource, context, { timeout: 1000 });
  return { context, state, invoke: () => handler({ sender: {} }) };
}
const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function observe(promise) {
  const state = { settled: false };
  promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
let passed = 0, failed = 0, finished = false;
process.once('beforeExit', () => { if (!finished) { console.error('FAIL process-wiring: unfinished async suite'); process.exitCode = 1; } });
async function test(name, invoke) {
  try { await invoke(); passed++; }
  catch (error) { failed++; console.error('FAIL process-wiring: ' + name + ': ' + error.message); }
}
(async () => {
  await test('actual process wrapper persists admission before spawn and completion after real close', async () => {
    const f = fixture(); const pending = f.context.runProcess('mock.exe', [], () => {});
    assert.deepEqual(f.store.events, ['begin', 'spawn']); assert.equal(f.store.pending.size, 1);
    f.child.emit('close', 0); const result = await pending;
    assert.equal(result.cleanupConfirmed, true); assert.equal(result.code, 0);
    assert.deepEqual(f.store.events, ['begin', 'spawn', 'complete']); assert.equal(f.store.pending.size, 0);
    assert.equal(f.pendingTokens(), 0); assert.equal(f.context.unresolvedProcessCustody, false);
  });
  await test('confirmed nonzero exit is distinct from unknown native cleanup', async () => {
    const f = fixture(); const pending = f.context.runProcess('mock.exe', [], () => {});
    f.child.emit('close', 1); const result = await pending;
    assert.equal(result.code, 1); assert.equal(result.cleanupConfirmed, true); assert.equal(f.store.pending.size, 0);
  });
  await test('production elevation uses durable child custody before accepting its receipt', async () => {
    const f=fixture();
    assert.ok(main.includes('createElevationController({runTimed:runElevationProcess})'));
    vm.runInContext(fn('runElevationProcess'),f.context);
    const pending=f.context.runElevationProcess('mock.exe',[],10,{stdinInput:Buffer.from('synthetic protected input')});
    assert.deepEqual(f.store.events,['begin','spawn']);
    f.child.emit('close',0);const result=await pending;
    assert.equal(result.outcome,'ok');assert.equal(result.stdinComplete,true);
    assert.equal(result.cleanupConfirmed,true);assert.equal(f.store.pending.size,0);
  });
  await test('elevation deadline cannot abandon a still-owned child or its persistent marker', async () => {
    const f=fixture();vm.runInContext(fn('runElevationProcess'),f.context);
    const pending=f.context.runElevationProcess('mock.exe',[],10,{terminationGraceMs:5});
    f.clock.tick(15);const result=await pending;
    assert.equal(result.outcome,'launch-error');assert.equal(result.cleanupConfirmed,false);
    assert.equal(f.context.unresolvedProcessCustody,true);assert.equal(f.store.pending.size,1);
    assert.equal(f.context.hasOwnedWork(),true);assert.equal(f.state.spawns,1);
    await f.context.runElevationProcess('mock.exe',[],10);assert.equal(f.state.spawns,1);
  });
  await test('durable admission failure prevents any process spawn', async () => {
    const f = fixture(); f.store.faults.begin = true;
    await assert.rejects(f.context.runProcess('mock.exe', [], () => {}), error => error.code === 'ERR_PROCESS_CLEANUP_UNVERIFIED');
    assert.equal(f.state.spawns, 0); assert.equal(f.context.unresolvedProcessCustody, true);
  });
  await test('completion persistence failure retains native exclusion and blocks retries', async () => {
    const f = fixture(); f.store.faults.complete = true;
    const pending = f.context.runProcess('mock.exe', [], () => {}); f.child.emit('close', 0);
    await assert.rejects(pending); assert.equal(f.context.unresolvedProcessCustody, true);
    assert.equal(f.store.pending.size, 1); assert.equal(f.pendingTokens(), 1);
    await assert.rejects(f.context.runProcess('second.exe', [], () => {})); assert.equal(f.state.spawns, 1);
  });
  await test('timeout retains durable custody across late close and simulated application restart', async () => {
    const f = fixture(); const pending = f.context.runProcess('mock.exe', [], () => {}, { timeoutMs: 10, terminationGraceMs: 5 });
    f.clock.tick(15); await assert.rejects(pending, error => error.code === 'ERR_PROCESS_CLEANUP_UNVERIFIED');
    assert.equal(f.context.unresolvedProcessCustody, true); assert.equal(f.store.pending.size, 1);
    assert.equal(f.context.activeChildren.has(f.child), true); assert.deepEqual(f.state.warnings, ['process-cleanup-unverified']);
    f.child.emit('close', 0); assert.equal(f.context.activeChildren.size, 0); assert.equal(f.store.pending.size, 1);
    const successor = fixture({ store: f.store }); assert.equal(successor.context.hasOwnedWork(), true);
    await assert.rejects(successor.context.runProcess('retry.exe', [], () => {}));
    assert.equal(successor.state.spawns, 0); assert.equal(f.clock.jobs.size, 0);
  });
  await test('inherited pipes prevent process evidence from becoming verified success', async () => {
    const f = fixture(); const pending = f.context.runProcess('mock.exe', [], () => {}, { exitCloseGraceMs: 5 });
    f.child.emit('exit', 0); f.clock.tick(5);
    await assert.rejects(pending, error => error.code === 'ERR_PROCESS_CLEANUP_UNVERIFIED');
    assert.equal(f.store.pending.size, 1); f.child.emit('close', 0);
  });
  for (const output of ['stdout', 'stderr']) await test('truncated ' + output + ' cannot be parsed as complete evidence', async () => {
    const f = fixture(); const pending = f.context.runProcess('mock.exe', [], () => {}, { maxOutputBytes: 2 });
    f.child[output].emit('data', Buffer.from('12345')); f.child.emit('close', 0);
    await assert.rejects(pending, error => error.code === 'ERR_PROCESS_OUTPUT_TRUNCATED');
    assert.equal(f.context.unresolvedProcessCustody, false); assert.equal(f.store.pending.size, 0);
  });
  await test('protected PS wrapper uses fixed args plus copied stdin and wipes its preparation buffer', async () => {
    const f = fixture(); const source = 'synthetic Unicode \u6771\u4eac'; const input = Buffer.from(source);
    let observed;
    f.context.preparePowerShellScript = script => { assert.equal(script, source); return { exe: 'C:\\Protected\\pwsh.exe', args: ['fixed-bootstrap'], input }; };
    f.context.runProcess = async (exe, args, _onLine, options) => { observed = { exe, args: [...args], input: Buffer.from(options.stdinInput) }; return { stdinComplete: true, code: 0 }; };
    vm.runInContext(fn('runPSScript') + '\n' + fn('runPSCapture'), f.context);
    await f.context.runPSCapture(source, { timeoutMs: 7 });
    assert.equal(observed.exe, 'C:\\Protected\\pwsh.exe'); assert.deepEqual(observed.args, ['fixed-bootstrap']);
    assert.equal(observed.input.toString(), source); assert.equal(input.every(byte => byte === 0), true);
  });
  await test('incomplete stdin rejects and still wipes the caller preparation buffer', async () => {
    const f = fixture(); const input = Buffer.from('synthetic source');
    f.context.preparePowerShellScript = () => ({ exe: 'C:\\Protected\\pwsh.exe', args: ['fixed'], input });
    f.context.runProcess = async () => ({ stdinComplete: false, code: 0 });
    vm.runInContext(fn('runPSScript'), f.context);
    await assert.rejects(f.context.runPSScript('synthetic', () => {}), error => error.code === 'ERR_PROCESS_INPUT_INCOMPLETE');
    assert.equal(input.every(byte => byte === 0), true);
  });
  await test('repair handler refuses unresolved generic custody before updater or session work', async () => {
    const f = repairContext({ unresolvedProcessCustody: true }); const result = await f.invoke();
    assert.equal(result.success, false); assert.equal(result.error, 'process_cleanup_unverified');
    assert.equal(f.state.flowCalls, 0); assert.equal(f.state.deferred, 0);
  });
  await test('second repair cannot release first repair busy exclusion', async () => {
    const gate = deferred(); let calls = 0;
    const f = repairContext({ runFixFlow: async () => { calls++; return gate.promise; } });
    const first = f.invoke(), second = f.invoke(); const state = observe(second);
    try {
      await flush(); assert.equal(calls, 1); assert.equal(state.settled, true); assert.equal(state.value.success, false);
      assert.equal(f.context.fixInProgress, true); assert.equal(f.state.deferred, 1);
    } finally { gate.resolve({ success: true }); await Promise.allSettled([first, second]); }
    assert.equal(f.context.fixInProgress, false);
  });
  for (const [code, expected] of [['ERR_PROCESS_CLEANUP_UNVERIFIED', 'process_cleanup_unverified'], ['ERR_PROCESS_OUTPUT_TRUNCATED', 'command_output_incomplete']]) {
    await test('repair handler preserves useful failure ' + code, async () => {
      const error = Object.assign(new Error('synthetic'), { code }); const f = repairContext({ runFixFlow: async () => { throw error; } });
      const result = await f.invoke(); assert.equal(result.error, expected); assert.equal(f.context.fixInProgress, false);
      assert.deepEqual(f.state.polls, ['fix-start', 'fix-end']); assert.equal(f.state.updates, 1);
    });
  }
  await test('last cooperative cancellation retains its original broker error', async () => {
    const error = Object.assign(new Error('cancel'), { code: 'ERR_1132_FIX_CANCELLED' });
    const f = repairContext({ runFixFlow: async () => { throw error; } });
    await assert.rejects(f.invoke(), value => value === error); assert.equal(f.context.fixInProgress, false);
  });
  await test('confirmed repair defers updater and exits busy scope normally', async () => {
    const f = repairContext(); assert.equal((await f.invoke()).success, true);
    assert.equal(f.state.flowCalls, 1); assert.equal(f.state.deferred, 1); assert.equal(f.context.fixInProgress, false);
  });
  await test('main constructs one maintained repair session and scopes the native factory to protected transport', async () => {
    const f = fixture(); let configuration, nativeOptions, transportOptions, constructions = 0;
    const session = { inspect: () => ({ running: false }), hasUnresolvedCustody: () => false };
    const transport = {};
    f.context.helperCred = { generateHelperPassword: () => 'inert-private-password' };
    f.context.resolvePowerShell7 = () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    f.context.createRepairSession = options => { constructions++; configuration = options; return session; };
    f.context.createWindowsRepairTransport = options => { transportOptions = options; return transport; };
    f.context.createHelperResetWindows = options => { nativeOptions = options; return {}; };
    vm.runInContext(fn('getRepairSession'), f.context);
    assert.equal(f.context.getRepairSession(), session); assert.equal(f.context.getRepairSession(), session); assert.equal(constructions, 1);
    assert.equal(configuration.machineId, 'machine-a'); assert.equal(configuration.generatePassword, f.context.helperCred.generateHelperPassword);
    const credentials = { withPassword() { throw new Error('credentials must stay lazy'); } };
    await configuration.createNative({ credentials, expectedMachineId: 'machine-a' });
    assert.equal(nativeOptions.credentials, credentials); assert.equal(nativeOptions.transport, transport);
    assert.equal(nativeOptions.admission.kind, 'recovery-probe'); assert.equal(nativeOptions.admission.machineId, 'machine-a');
    assert.equal(transportOptions.pwshPath, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    transportOptions.onRetained(); assert.equal(f.context.unresolvedProcessCustody, true); assert.ok(f.state.polls.includes('native-custody'));
    assert.equal(f.state.spawns, 0);
  });
  for (const field of ['running', 'nativeOwned', 'pendingNative']) await test('session ' + field + ' owns work even if separate UI busy flag was lost', () => {
    const f = fixture(); f.context.repairSession = { inspect: () => ({ [field]: true }), hasUnresolvedCustody: () => false };
    assert.equal(f.context.hasActiveLocalWork(), true); assert.equal(f.context.hasOwnedWork(), true);
  });
  await test('unknown session or store inspection blocks work conservatively', () => {
    const f = fixture(); f.store.faults.inspect = true; assert.equal(f.context.hasOwnedWork(), true);
    assert.equal(f.context.unresolvedProcessCustody, true);
    const g = fixture(); g.context.repairSession = { inspect() { throw new Error('unknown native owner'); } };
    assert.equal(g.context.hasActiveLocalWork(), true); assert.equal(g.context.unresolvedProcessCustody, true);
  });
  await test('actual updater and inactivity callbacks share the maintained owned-work guard', () => {
    const f = fixture(); const match = main.match(/isBusy: ([^\n]+),/); assert.ok(match);
    const isBusy = vm.runInContext('(' + match[1] + ')', f.context); assert.equal(isBusy(), false);
    f.context.nativeRecovery = { status: 'blocked' }; assert.equal(isBusy(), true);
    const line = main.split('\n').find(value => value.startsWith("criticalOps.addSource('process-custody'"));
    assert.ok(line); vm.runInContext(line, f.context); assert.equal(f.handlers.get('process-custody')(), true);
  });
  for (const mode of ['unresolved', 'persistent', 'native-active', 'unknown-recovery']) await test('quit and elevation cannot abandon ' + mode + ' ownership', async () => {
    const f = fixture();
    if (mode === 'unresolved') f.context.unresolvedProcessCustody = true;
    if (mode === 'persistent') f.store.begin('previous-command');
    if (mode === 'native-active') f.context.repairSession = { inspect: () => ({ nativeOwned: true }), hasUnresolvedCustody: () => false };
    if (mode === 'unknown-recovery') f.context.nativeRecovery = { status: 'blocked' };
    vm.runInContext(windowCloseSource + '\n' + event('before-quit') + '\n' + fn('relaunchElevated'), f.context);
    f.appHandlers.get('before-quit')({ preventDefault: () => { f.state.prevented++; } });
    assert.equal(f.state.prevented, 1); assert.equal(f.state.installs, 0);
    f.appHandlers.get('window-close')({ preventDefault: () => { f.state.prevented++; } }); assert.equal(f.state.prevented, 2);
    assert.equal(await f.context.relaunchElevated(), false); assert.equal(f.state.releases, 0); assert.equal(f.state.elevationCalls, 0);
  });
  await test('verified idle state can quit and install while elevation still preserves single-instance handoff', async () => {
    const f = fixture(); vm.runInContext(event('before-quit') + '\n' + fn('relaunchElevated'), f.context);
    f.appHandlers.get('before-quit')({ preventDefault: () => { f.state.prevented++; } });
    assert.equal(f.state.prevented, 0); assert.equal(f.state.installs, 1);
    assert.equal(await f.context.relaunchElevated(), true); assert.equal(f.state.releases, 1); assert.equal(f.state.elevationCalls, 1);
  });
  for (const fatal of ['uncaughtException', 'render-process-gone']) await test('fatal ' + fatal + ' retains markers and native owner without restart or PID kill', () => {
    const f = fixture(); const token = f.store.begin('pending-command');
    vm.runInContext('processCustodyTokens.add(' + JSON.stringify(token) + ')', f.context);
    let retained = 0;
    f.context.repairSession = { inspect: () => ({ nativeOwned: true }), hasUnresolvedCustody: () => true,
      activeNative: () => ({ retainCustody: () => { retained++; } }) };
    vm.runInContext(fatalSource, f.context);
    if (fatal === 'uncaughtException') f.handlers.get(fatal)();
    else f.appHandlers.get(fatal)({}, {}, { reason: 'crashed' });
    assert.equal(f.context.unresolvedProcessCustody, true); assert.equal(f.store.pending.size, 1);
    assert.equal(f.store.pending.get(token).state, 'unresolved'); assert.equal(retained, 1);
    assert.equal(f.state.exits, 0); assert.equal(f.state.relaunches, 0); assert.equal(f.child.kills, 0);
  });
  await test('fresh native recovery delegates exact process result, expected machine and clock', async () => {
    const f = fixture(); const result = await f.context.refreshRepairRecovery();
    assert.equal(result.status, 'clear'); assert.equal(f.state.recoveryCalls, 1);
    assert.equal(f.state.parsed[0].scope.expectedMachineId, 'machine-a'); assert.equal(f.state.parsed[0].scope.nowMs, f.clock.now);
    f.context.runPSCapture = async () => { throw new Error('denied'); };
    assert.equal((await f.context.refreshRepairRecovery()).status, 'blocked');
    assert.equal(f.context.hasOwnedWork(), true);
  });
  await test('recovery cannot queue a second probe behind active native custody', async () => {
    const f = fixture(); f.context.repairSession = { inspect: () => ({ nativeOwned: true }), hasUnresolvedCustody: () => false };
    const result = await f.context.refreshRepairRecovery(); assert.equal(result.status, 'blocked'); assert.equal(f.state.recoveryCalls, 0);
  });
  await test('startup awaits read-only recovery before opening a window, with UAC fully inert', async () => {
    const body = section('app.whenReady().then(async () => {', '  createWindow();').replace('app.whenReady().then(async () => {', '') + '  createWindow();';
    const gates = [deferred(),deferred()], events = [];
    let probe=0;
    const run = vm.runInNewContext('(async () => {' + body + '\n})', {
      singleInstanceReady: Promise.resolve(true), process: { argv: ['--already-attempted'] }, ELEVATE_RETRY_FLAG: '--already-attempted',
      refreshRepairRecovery: () => { events.push('recovery'); return gates[probe++].promise; }, createWindow: () => events.push('window'),
      shutdown: { request() { throw new Error('unexpected handoff'); }, REASONS: {} }
    });
    const pending = run(); await flush(); assert.deepEqual(events, ['recovery']);
    gates[0].resolve({status:'clear'}); await flush(); assert.deepEqual(events,['recovery','recovery']);
    gates[1].resolve({ status: 'blocked' }); await pending; assert.deepEqual(events, ['recovery','recovery','window']);
  });
  await test('recovery messages never promise unconditional safe retries', () => {
    for (const copy of [messages.PROCESS_RECOVERY, messages.friendlyError('unknown'), messages.unexpectedFixFailure(null)]) {
      assert.ok(copy.length > 20); assert.equal(/safe to (?:run|repeat)|has been stopped/i.test(copy), false);
    }
    assert.ok(messages.friendlyError('process_cleanup_unverified').includes('Do not start another fix'));
    assert.ok(messages.friendlyError('command_output_incomplete').includes('incomplete'));
  });
  console.log('process-wiring-smoke: ' + passed + ' passed, ' + failed + ' failed; actual main functions, inert adapters only');
  if (failed) process.exitCode = 1; finished = true;
})().catch(error => { console.error('FAIL process-wiring harness:', error.stack || error); process.exitCode = 1; finished = true; });
