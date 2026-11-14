'use strict';

// No child, process, account, service, filesystem or network operations. Every
// process event and deadline below belongs to a synthetic in-memory fixture.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
let finished = false;
process.once('beforeExit', () => {
  if (!finished) { console.error('FAIL bounded-process: unfinished async suite'); process.exitCode = 1; }
});

class FakeTimers {
  constructor() { this.now = 0; this.serial = 0; this.jobs = new Map(); }
  setTimeout(fn, delay) {
    const id = ++this.serial;
    this.jobs.set(id, { fn, at: this.now + delay });
    return id;
  }
  clearTimeout(id) { this.jobs.delete(id); }
  tick(ms) {
    const end = this.now + ms;
    let turns = 0;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > end) break;
      assert.ok(++turns < 10000, 'fake scheduler must remain bounded');
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].fn();
    }
    this.now = end;
  }
}

class FakePipe extends EventEmitter {
  constructor() { super(); this.destroyed = false; }
  destroy() { this.destroyed = true; }
}

// Payload references stay outside enumerable child/observer metadata.
const inputState = new WeakMap();
class FakeInput extends EventEmitter {
  constructor() { super(); inputState.set(this, { calls: 0, mode: 'auto', callback: null, bytes: null, reference: null }); }
  end(bytes, callback) {
    const state = inputState.get(this); state.calls++; state.bytes = Buffer.from(bytes); state.reference = bytes; state.callback = callback;
    if (state.mode === 'throw') throw new Error('synthetic private stdin failure');
    if (state.mode === 'auto') callback();
    return this;
  }
  flush(error) { const state = inputState.get(this); assert.equal(typeof state.callback, 'function'); state.callback(error); }
}

class FakeChild extends EventEmitter {
  constructor(pid = 101) {
    super(); this.pid = pid; this.stdout = new FakePipe(); this.stderr = new FakePipe(); this.stdin = new FakeInput();
    this.killCalls = [];
  }
  kill(signal) { this.killCalls.push(signal); return true; }
}

let factory;
let constants;
let passed = 0;
let failed = 0;
const nativeAttempts = [];
const originalLoad = Module._load;
const restores = [];
const forbidden = new Set([
  'child_process', 'fs', 'fs/promises', 'os', 'electron', 'net', 'http', 'https',
  'http2', 'dns', 'dns/promises', 'dgram', 'tls', 'worker_threads', 'cluster',
  'timers', 'timers/promises'
]);

function forbid(object, key) {
  const original = object[key];
  if (typeof original !== 'function') return;
  object[key] = () => { nativeAttempts.push(key); throw new Error('unexpected native API: ' + key); };
  restores.push(() => { object[key] = original; });
}

function fixture(extra = {}) {
  const child = new FakeChild();
  const timers = new FakeTimers();
  const activeChildren = new Set();
  const uncertain = [];
  const calls = [];
  const lines = [];
  const run = factory({
    spawn: (...args) => { calls.push(args); return child; },
    timers, activeChildren, onUncertain: value => uncertain.push(value), ...extra
  });
  return { child, timers, activeChildren, uncertain, calls, lines, run,
    start: (options = {}, callback = (line, kind) => lines.push({ line, kind })) =>
      run('fake.exe', ['synthetic'], callback, options) };
}

function observe(promise) {
  const state = { settled: false, rejected: false };
  promise.then(value => { state.settled = true; state.value = value; }, error => {
    state.settled = true; state.rejected = true; state.error = error;
  });
  return state;
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failed++; console.error(`FAIL bounded-process: ${name}: ${error && error.message || error}`); }
}

function clean(f) {
  assert.equal(f.timers.jobs.size, 0, 'no timers remain after settlement');
  assert.equal(f.child.stdout.destroyed, true);
  assert.equal(f.child.stderr.destroyed, true);
}

async function main() {
  Module._load = function (request, parent, isMain) {
    if (forbidden.has(request.replace(/^node:/, ''))) {
      nativeAttempts.push(request);
      throw new Error('unexpected native dependency: ' + request);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const key of ['exit', 'kill', 'chdir', 'abort']) forbid(process, key);
  for (const key of ['setTimeout', 'setInterval', 'setImmediate', 'fetch']) forbid(globalThis, key);
  forbid(Date, 'now');
  try {
    constants = require('../src/main/bounded-process');
    factory = constants.createBoundedProcessRunner;

    await test('factory exports mechanics and finite defaults only', () => {
      assert.deepEqual(Object.keys(constants).sort(), [
        'DEFAULT_EXIT_CLOSE_GRACE_MS', 'DEFAULT_MAX_OUTPUT_BYTES', 'DEFAULT_TERMINATION_GRACE_MS',
        'DEFAULT_TIMEOUT_MS', 'MAX_STDIN_INPUT_BYTES', 'createBoundedProcessRunner'
      ]);
      assert.equal(constants.DEFAULT_TIMEOUT_MS, 30000);
      assert.equal(constants.DEFAULT_EXIT_CLOSE_GRACE_MS, 500);
      assert.equal(constants.DEFAULT_TERMINATION_GRACE_MS, 1000);
      assert.equal(constants.MAX_STDIN_INPUT_BYTES, 8 * 1024 * 1024);
      assert.throws(() => factory({}), /spawn/);
    });

    await test('natural nonzero close preserves output and releases custody', async () => {
      const f = fixture(); const promise = f.start();
      assert.ok(f.activeChildren.has(f.child));
      f.child.stdout.emit('data', Buffer.from('first\r\nsecond'));
      f.child.stderr.emit('data', Buffer.from('warning\n'));
      f.child.emit('exit', 7); f.child.emit('close', 7);
      const result = await promise;
      assert.equal(result.code, 7); assert.equal(result.outcome, 'exited');
      assert.equal(result.stdout, 'first\r\nsecond'); assert.equal(result.stderr, 'warning\n');
      assert.equal(result.cleanupConfirmed, true); assert.equal(result.rootExitConfirmed, true);
      assert.equal(result.timedOut, false); assert.equal(result.stdoutTruncated, false);
      assert.equal(result.stdinComplete, true); assert.equal(inputState.get(f.child.stdin).calls, 0);
      assert.deepEqual(f.lines, [{ line: 'first', kind: 'out' }, { line: 'warning', kind: 'err' }, { line: 'second', kind: 'out' }]);
      assert.deepEqual(f.calls[0], ['fake.exe', ['synthetic'], { windowsHide: true }]);
      assert.equal(f.activeChildren.size, 0); assert.equal(f.uncertain.length, 0); clean(f);
    });

    for (const timeoutMs of [undefined, 0]) await test(`timeout ${String(timeoutMs)} selects finite default`, async () => {
      const f = fixture(); const promise = f.start({ timeoutMs }); const state = observe(promise);
      f.timers.tick(29999); await flush(); assert.equal(state.settled, false);
      f.timers.tick(1); assert.deepEqual(f.child.killCalls, ['SIGKILL']);
      f.timers.tick(999); await flush(); assert.equal(state.settled, false);
      f.timers.tick(1); const result = await promise;
      assert.equal(result.outcome, 'timeout'); assert.equal(result.timedOut, true);
      assert.equal(result.cleanupConfirmed, false); assert.equal(result.rootExitConfirmed, false);
      assert.equal(f.uncertain.length, 1); assert.ok(f.activeChildren.has(f.child)); clean(f);
      f.child.emit('close', null); assert.equal(f.activeChildren.size, 0);
    });

    for (const field of ['timeoutMs', 'exitCloseGraceMs', 'terminationGraceMs']) {
      for (const value of [null, -1, 1.5, '10', NaN, Infinity, 0x80000000]) {
        await test(`invalid ${field} ${String(value)} refuses before spawn`, async () => {
          const f = fixture(); await assert.rejects(f.start({ [field]: value }), TypeError);
          assert.equal(f.calls.length, 0); assert.equal(f.timers.jobs.size, 0);
          assert.equal(f.activeChildren.size, 0); assert.equal(f.uncertain.length, 0);
        });
      }
    }
    for (const field of ['exitCloseGraceMs', 'terminationGraceMs']) await test(`zero ${field} refuses before spawn`, async () => {
      const f = fixture(); await assert.rejects(f.start({ [field]: 0 }), TypeError); assert.equal(f.calls.length, 0);
    });

    for (const value of [null, 0, -1, 1.5, '5', NaN, Infinity, 16 * 1024 * 1024 + 1]) {
      await test(`invalid capture bound ${String(value)} refuses before spawn`, async () => {
        const f = fixture(); await assert.rejects(f.start({ maxOutputBytes: value }), TypeError);
        assert.equal(f.calls.length, 0); assert.equal(f.timers.jobs.size, 0);
      });
    }
    await test('invalid heartbeat label refuses before timer callback interpolation', async () => {
      const f = fixture();
      await assert.rejects(f.start({ heartbeatMs: 2, heartbeatLabel: { toString() { throw new Error('unsafe coercion'); } } }), TypeError);
      assert.equal(f.calls.length, 0); assert.equal(f.timers.jobs.size, 0);
    });

    await test('UTF8 stdin uses only owned pipe and is flushed before verified close', async () => {
      const f = fixture(); const payload = 'Synthetic Unicode input: Jos\u00e9 \u6771\u4eac \ud83d\ude00';
      const promise = f.start({ stdinInput: payload }); const state = inputState.get(f.child.stdin);
      assert.equal(state.bytes.toString('utf8'), payload); assert.equal(state.calls, 1);
      assert.equal(state.reference.every(byte => byte === 0), true, 'owned copy wiped after flush callback');
      assert.deepEqual(f.calls[0], ['fake.exe', ['synthetic'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }]);
      assert.equal(JSON.stringify(f.calls).includes(payload), false);
      f.child.emit('exit', 0); f.child.emit('close', 0); const result = await promise;
      assert.equal(result.stdinComplete, true); assert.equal(result.cleanupConfirmed, true);
      assert.equal(JSON.stringify(result).includes(payload), false); assert.equal(f.uncertain.length, 0); clean(f);
    });

    await test('caller Buffer is copied and backpressure or finish alone cannot confirm flushing', async () => {
      const f = fixture(); inputState.get(f.child.stdin).mode = 'pending'; const source = Buffer.from('owned-copy');
      const promise = f.start({ stdinInput: source }); const state = inputState.get(f.child.stdin);
      assert.notEqual(state.reference, source); source.fill(120); assert.equal(state.reference.toString(), 'owned-copy');
      f.child.stdin.emit('drain'); f.child.stdin.emit('finish');
      assert.equal(state.reference.toString(), 'owned-copy', 'in-flight bytes must not be wiped');
      f.child.stdin.flush(); assert.equal(state.reference.every(byte => byte === 0), true);
      f.child.emit('close', 0); const result = await promise;
      assert.equal(result.stdinComplete, true); assert.equal(result.cleanupConfirmed, true); assert.equal(source.toString(), 'xxxxxxxxxx'); clean(f);
    });
    await test('drain or finish without end callback cannot authorize a clean exit', async () => {
      const f = fixture(); inputState.get(f.child.stdin).mode = 'pending'; const promise = f.start({ stdinInput: 'pending bytes' });
      f.child.stdin.emit('drain'); f.child.stdin.emit('finish'); f.child.emit('close', 0);
      const result = await promise; assert.equal(result.stdinComplete, false); assert.equal(result.outcome, 'stdin-incomplete');
      assert.equal(result.cleanupConfirmed, false); assert.equal(f.uncertain.length, 1); clean(f);
    });

    for (const input of ['', Buffer.alloc(0)]) await test('explicit empty input still sends EOF and requires callback', async () => {
      const f = fixture(); inputState.get(f.child.stdin).mode = 'pending'; const promise = f.start({ stdinInput: input });
      assert.equal(inputState.get(f.child.stdin).calls, 1); assert.equal(inputState.get(f.child.stdin).bytes.length, 0);
      f.child.emit('close', 0); const result = await promise;
      assert.equal(result.stdinComplete, false); assert.equal(result.outcome, 'stdin-incomplete');
      assert.equal(result.cleanupConfirmed, false); assert.equal(f.activeChildren.size, 0); assert.equal(f.uncertain.length, 1); clean(f);
      f.child.stdin.flush(); assert.equal(result.stdinComplete, false);
    });

    for (const stdinInput of [null, 5, {}, ['invalid'], Buffer.alloc(8 * 1024 * 1024 + 1), '\u00e9'.repeat(4 * 1024 * 1024 + 1)]) {
      await test('invalid or byte-oversize stdin refuses before spawn', async () => {
        const f = fixture(); await assert.rejects(f.start({ stdinInput }), /Invalid bounded stdin input/);
        assert.equal(f.calls.length, 0); assert.equal(f.timers.jobs.size, 0); assert.equal(f.uncertain.length, 0);
      });
    }
    await test('exact stdin byte limit is supported without argv expansion', async () => {
      const f = fixture(); const promise = f.start({ stdinInput: Buffer.alloc(constants.MAX_STDIN_INPUT_BYTES, 65) });
      assert.equal(inputState.get(f.child.stdin).bytes.length, constants.MAX_STDIN_INPUT_BYTES);
      f.child.emit('close', 0); assert.equal((await promise).stdinComplete, true); clean(f);
    });
    await test('stdin option is read once so an accessor cannot swap in oversized bytes', async () => {
      const f = fixture(); let reads = 0;
      const promise = f.start({ get stdinInput() { return ++reads === 1 ? 'validated bytes' : Buffer.alloc(constants.MAX_STDIN_INPUT_BYTES + 1); } });
      assert.equal(reads, 1); assert.equal(inputState.get(f.child.stdin).bytes.toString(), 'validated bytes');
      f.child.emit('close', 0); assert.equal((await promise).stdinComplete, true); clean(f);
    });
    await test('stdin accessor failure is sanitized before any spawn', async () => {
      const f = fixture(); const payload = 'Private accessor exception';
      await assert.rejects(f.start({ get stdinInput() { throw new Error(payload); } }), error => error.message === 'Invalid bounded stdin input');
      assert.equal(f.calls.length, 0); assert.equal(f.uncertain.length, 0); assert.equal(f.timers.jobs.size, 0);
    });

    for (const mode of ['callback-error', 'event-error', 'throw', 'missing', 'stream-close']) await test(`stdin ${mode} cannot return verified success or leak payload in diagnostics`, async () => {
      const f = fixture(); const pipe = f.child.stdin; const payload = 'Private synthetic stdin bytes';
      inputState.get(pipe).mode = mode === 'throw' ? 'throw' : 'pending';
      if (mode === 'missing') f.child.stdin = null;
      const promise = f.start({ stdinInput: payload, terminationGraceMs: 2 });
      if (mode === 'callback-error') pipe.flush(Object.assign(new Error(payload), { code: 'EPIPE' }));
      if (mode === 'event-error') pipe.emit('error', Object.assign(new Error(payload), { code: 'EPIPE' }));
      if (mode === 'stream-close') pipe.emit('close');
      f.timers.tick(2); const result = await promise;
      assert.equal(result.stdinComplete, false); assert.equal(result.cleanupConfirmed, false);
      assert.equal(result.outcome, mode === 'missing' ? 'stdin-unavailable' : mode === 'stream-close' ? 'stdin-incomplete' : 'stdin-error');
      assert.equal(JSON.stringify(result).includes(payload), false); assert.equal(f.uncertain.length, 1);
      assert.deepEqual(Object.keys(f.uncertain[0]).sort(), ['child', 'exe', 'outcome', 'rootExitConfirmed']);
      assert.equal(f.uncertain[0].child, f.child); assert.equal(f.activeChildren.has(f.child), true); clean(f);
      if (mode !== 'missing') pipe.emit('error', new Error('late EPIPE'));
      f.child.emit('close', 0); assert.equal(f.activeChildren.size, 0);
      if (inputState.get(pipe).callback) pipe.flush(); assert.equal(result.stdinComplete, false);
    });

    await test('exit before stdin flush latches uncertainty despite late success callback', async () => {
      const f = fixture(); inputState.get(f.child.stdin).mode = 'pending';
      const promise = f.start({ stdinInput: 'pending bytes', terminationGraceMs: 2 });
      f.child.emit('exit', 0); f.timers.tick(2); const result = await promise;
      assert.equal(result.outcome, 'stdin-incomplete'); assert.equal(result.stdinComplete, false);
      assert.equal(result.rootExitConfirmed, true); assert.equal(result.cleanupConfirmed, false);
      assert.equal(inputState.get(f.child.stdin).reference.toString(), 'pending bytes');
      f.child.stdin.flush(); assert.equal(result.stdinComplete, false); assert.equal(f.uncertain.length, 1);
      assert.equal(f.activeChildren.has(f.child), true); f.child.emit('close', 0); assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('pending stdin deadline stays bounded and late callback cannot upgrade settled result', async () => {
      const f = fixture(); inputState.get(f.child.stdin).mode = 'pending';
      const promise = f.start({ stdinInput: 'pending bytes', timeoutMs: 1, terminationGraceMs: 2 });
      f.timers.tick(3); const result = await promise; const before = JSON.stringify(result);
      assert.equal(result.outcome, 'timeout'); assert.equal(result.stdinComplete, false); assert.equal(result.timedOut, true);
      assert.equal(inputState.get(f.child.stdin).reference.toString(), 'pending bytes');
      f.child.stdin.flush(); f.child.stdin.emit('error', new Error('late EPIPE')); assert.equal(JSON.stringify(result), before);
      assert.equal(f.activeChildren.has(f.child), true); f.child.emit('close', 0); assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('stdin failure with synchronous child close settles once without waiting full grace', async () => {
      const f = fixture({ terminate: child => { child.emit('close', 1); } }); inputState.get(f.child.stdin).mode = 'pending';
      const promise = f.start({ stdinInput: 'pending bytes' }); f.child.stdin.flush(new Error('EPIPE'));
      const result = await promise; assert.equal(result.outcome, 'stdin-error'); assert.equal(result.stdinComplete, false);
      assert.equal(result.cleanupConfirmed, false); assert.equal(f.uncertain.length, 1); assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('successful heartbeat stops at natural close', async () => {
      const f = fixture(); const promise = f.start({ heartbeatMs: 2, heartbeatLabel: 'synthetic stage' });
      f.timers.tick(4); assert.equal(f.lines.length, 2);
      assert.ok(f.lines.every(line => line.line.includes('synthetic stage')));
      f.child.emit('close', 0); assert.equal((await promise).outcome, 'exited');
      f.timers.tick(100000); assert.equal(f.lines.length, 2); clean(f);
    });

    await test('synchronous spawn throw is confirmed launch failure', async () => {
      const f = fixture({ spawn: () => { throw new Error('synthetic spawn failure'); } });
      const result = await f.start();
      assert.equal(result.outcome, 'spawn-error'); assert.equal(result.code, -1);
      assert.equal(result.cleanupConfirmed, true); assert.equal(result.rootExitConfirmed, false);
      assert.equal(f.uncertain.length, 0); assert.equal(f.activeChildren.size, 0);
      assert.equal(f.timers.jobs.size, 0);
    });

    await test('error without a PID is confirmed launch failure', async () => {
      const f = fixture(); f.child.pid = undefined; const promise = f.start();
      f.child.emit('error', new Error('synthetic unavailable executable'));
      const result = await promise;
      assert.equal(result.outcome, 'spawn-error'); assert.equal(result.cleanupConfirmed, true);
      assert.equal(result.rootExitConfirmed, false); assert.equal(f.activeChildren.size, 0);
      assert.equal(f.uncertain.length, 0); clean(f);
    });

    for (const [name, terminate] of [
      ['throw', () => { throw new Error('kill refused'); }], ['false', () => false],
      ['reject', () => Promise.reject(new Error('kill rejected'))],
      ['never settle', () => new Promise(() => {})]
    ]) await test(`termination ${name} cannot extend deadline`, async () => {
      const f = fixture({ terminate }); const promise = f.start({ timeoutMs: 10, terminationGraceMs: 4 });
      f.timers.tick(14); const result = await promise;
      assert.equal(result.outcome, 'timeout'); assert.equal(result.cleanupConfirmed, false);
      assert.equal(f.uncertain.length, 1); assert.ok(f.activeChildren.has(f.child)); clean(f);
      f.child.emit('close', 1); assert.equal(f.activeChildren.size, 0);
    });

    await test('exit without close settles after drain grace and retains custody', async () => {
      const f = fixture(); const promise = f.start({ timeoutMs: 10, exitCloseGraceMs: 3 });
      const state = observe(promise); f.child.emit('exit', 0);
      f.timers.tick(2); await flush(); assert.equal(state.settled, false);
      f.timers.tick(1); const result = await promise;
      assert.equal(result.outcome, 'exit-unclosed'); assert.equal(result.rootExitConfirmed, true);
      assert.equal(result.cleanupConfirmed, false); assert.equal(result.timedOut, false);
      assert.equal(f.uncertain.length, 1); assert.ok(f.activeChildren.has(f.child)); clean(f);
      f.child.emit('close', 0); assert.equal(f.activeChildren.size, 0);
    });

    await test('timeout then synchronous close preserves timeout and uncertainty', async () => {
      const f = fixture({ terminate: child => { child.emit('close', 9); return true; } });
      const promise = f.start({ timeoutMs: 10 }); f.timers.tick(10); const result = await promise;
      assert.equal(result.outcome, 'timeout'); assert.equal(result.timedOut, true);
      assert.equal(result.rootExitConfirmed, true); assert.equal(result.cleanupConfirmed, false);
      assert.equal(f.uncertain.length, 1); assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('running process error keeps custody and remains uncertain after close', async () => {
      const f = fixture(); const promise = f.start(); f.child.emit('error', new Error('synthetic process error'));
      f.child.emit('close', 1); const result = await promise;
      assert.equal(result.outcome, 'process-error'); assert.equal(result.cleanupConfirmed, false);
      assert.equal(result.rootExitConfirmed, true); assert.equal(f.uncertain.length, 1);
      assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('PID absence cannot erase custody after output proves the child started', async () => {
      const f = fixture(); f.child.pid = undefined; const promise = f.start({ terminationGraceMs: 2 });
      f.child.stdout.emit('data', Buffer.from('started\n'));
      f.child.emit('error', new Error('runtime failure'));
      f.timers.tick(2); const result = await promise;
      assert.equal(result.outcome, 'process-error'); assert.equal(result.cleanupConfirmed, false);
      assert.equal(f.uncertain.length, 1); assert.ok(f.activeChildren.has(f.child)); clean(f);
    });

    await test('late no-PID error cannot erase uncertain timeout custody', async () => {
      const f = fixture(); f.child.pid = undefined; const promise = f.start({ timeoutMs: 1, terminationGraceMs: 2 });
      f.timers.tick(1); f.child.emit('error', new Error('late failure'));
      f.timers.tick(2); const result = await promise;
      assert.equal(result.outcome, 'timeout'); assert.equal(result.cleanupConfirmed, false);
      assert.ok(f.activeChildren.has(f.child)); assert.equal(f.uncertain.length, 1); clean(f);
    });

    await test('stream error settles safely and late stream errors remain harmless', async () => {
      const f = fixture(); const promise = f.start({ terminationGraceMs: 2 });
      f.child.stdout.emit('error', new Error('broken stream')); f.timers.tick(2);
      const result = await promise;
      assert.equal(result.outcome, 'stream-error'); assert.equal(result.cleanupConfirmed, false);
      f.child.stdout.emit('error', new Error('late stdout')); f.child.stderr.emit('error', new Error('late stderr'));
      assert.equal(f.uncertain.length, 1); assert.ok(f.activeChildren.has(f.child)); clean(f);
      f.child.emit('close', 1); assert.equal(f.activeChildren.size, 0);
    });

    await test('exit then error without close uses termination grace exactly once', async () => {
      const f = fixture(); const promise = f.start({ exitCloseGraceMs: 3, terminationGraceMs: 5 });
      f.child.emit('exit', 2); f.child.emit('error', new Error('synthetic late root error'));
      f.child.emit('error', new Error('duplicate')); f.timers.tick(5); const result = await promise;
      assert.equal(result.outcome, 'process-error'); assert.equal(result.rootExitConfirmed, true);
      assert.equal(f.uncertain.length, 1); assert.equal(f.child.killCalls.length, 1);
      assert.ok(f.activeChildren.has(f.child)); clean(f);
    });

    for (const original of [Object.assign(new Error('cancel at checkpoint'), { code: 'ERR_FIX_CANCELLED' }), 'cancel-value', undefined]) {
      await test(`onLine rejection preserves original ${typeof original}`, async () => {
        const f = fixture(); const promise = f.start({ terminationGraceMs: 5 }, () => { throw original; });
        const state = observe(promise); f.child.stdout.emit('data', Buffer.from('checkpoint\n'));
        f.timers.tick(4); await flush(); assert.equal(state.settled, false);
        f.timers.tick(1); await flush(); assert.equal(state.settled, true);
        assert.equal(state.rejected, true); assert.equal(state.error, original);
        assert.equal(f.uncertain.length, 1); assert.equal(f.uncertain[0].outcome, 'callback-error');
        assert.ok(f.activeChildren.has(f.child)); clean(f);
      });
    }

    await test('callback failure racing close still rejects exact error', async () => {
      const original = new Error('stop'); const f = fixture({ terminate: child => { child.emit('close', 0); } });
      const promise = f.start({}, () => { throw original; }); const state = observe(promise);
      f.child.stdout.emit('data', Buffer.from('stop\n')); await flush();
      assert.equal(state.rejected, true); assert.equal(state.error, original);
      assert.equal(f.activeChildren.size, 0); assert.equal(f.uncertain.length, 1); clean(f);
    });

    await test('tail callback failure during actual close rejects without hanging', async () => {
      const original = new Error('tail'); const f = fixture();
      const promise = f.start({}, () => { throw original; }); const state = observe(promise);
      f.child.stdout.emit('data', Buffer.from('tail')); f.child.emit('close', 0); await flush();
      assert.equal(state.rejected, true); assert.equal(state.error, original);
      assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('heartbeat failure uses bounded rejection and cancels heartbeat timer', async () => {
      const original = new Error('heartbeat'); const f = fixture();
      const promise = f.start({ heartbeatMs: 2, terminationGraceMs: 3 }, () => { throw original; });
      const state = observe(promise); f.timers.tick(5); await flush();
      assert.equal(state.rejected, true); assert.equal(state.error, original);
      assert.equal(f.child.killCalls.length, 1); assert.equal(f.uncertain.length, 1); clean(f);
    });

    await test('uncertainty observer failure cannot hang or lose custody', async () => {
      const f = fixture({ onUncertain: () => { throw new Error('observer'); } });
      const promise = f.start({ timeoutMs: 1, terminationGraceMs: 1 }); f.timers.tick(2);
      assert.equal((await promise).cleanupConfirmed, false); assert.ok(f.activeChildren.has(f.child)); clean(f);
    });

    await test('UTF8 split across chunks is decoded without replacement and lines are joined', async () => {
      const f = fixture(); const promise = f.start(); const encoded = Buffer.from('A😀é\r\ntail');
      for (const byte of encoded) f.child.stdout.emit('data', Buffer.from([byte]));
      f.child.emit('close', 0); const result = await promise;
      assert.equal(result.stdout, 'A😀é\r\ntail'); assert.equal(result.stdoutTruncated, false);
      assert.deepEqual(f.lines.map(line => line.line), ['A😀é', 'tail']); clean(f);
    });

    await test('capture limit keeps complete code points and flags each truncated stream', async () => {
      const f = fixture(); const promise = f.start({ maxOutputBytes: 5 });
      f.child.stdout.emit('data', Buffer.from('A😀é\n')); f.child.stderr.emit('data', Buffer.from('abcdef'));
      f.child.emit('close', 0); const result = await promise;
      assert.equal(result.stdout, 'A😀'); assert.equal(Buffer.byteLength(result.stdout), 5);
      assert.equal(result.stderr, 'abcde'); assert.equal(result.stdoutTruncated, true);
      assert.equal(result.stderrTruncated, true); assert.equal(result.stdout.includes('�'), false); clean(f);
    });

    await test('newline-free output has bounded fragments and capture', async () => {
      const f = fixture(); const promise = f.start({ maxOutputBytes: 7 });
      f.child.stdout.emit('data', Buffer.from('x'.repeat(100000))); f.child.emit('close', 0);
      const result = await promise;
      assert.equal(result.stdout, 'x'.repeat(7)); assert.equal(result.stdoutTruncated, true);
      assert.ok(f.lines.every(line => line.line.length <= 16384));
      assert.equal(f.lines.reduce((sum, line) => sum + line.line.length, 0), 100000); clean(f);
    });

    await test('late close releases uncertain custody without changing settled result', async () => {
      const f = fixture(); const promise = f.start({ timeoutMs: 1, terminationGraceMs: 1 });
      let completions = 0; promise.then(() => completions++); f.timers.tick(2); const result = await promise;
      const before = JSON.stringify(result); f.child.emit('error', new Error('late'));
      f.child.stdout.emit('data', Buffer.from('ignored\n')); f.child.emit('exit', 99); f.child.emit('close', 99);
      f.child.emit('close', 99); f.timers.tick(100000); await flush();
      assert.equal(JSON.stringify(result), before); assert.equal(completions, 1);
      assert.equal(f.uncertain.length, 1); assert.equal(f.activeChildren.size, 0); clean(f);
    });

    await test('natural close then late error, exit, output and duplicate close are inert', async () => {
      const f = fixture(); const promise = f.start({ heartbeatMs: 2 });
      f.child.emit('close', 0); const result = await promise;
      f.child.emit('error', new Error('late')); f.child.emit('exit', 9); f.child.stdout.emit('data', Buffer.from('late'));
      f.child.stdout.emit('error', new Error('late stdout')); f.child.stderr.emit('error', new Error('late stderr'));
      f.child.emit('close', 9); f.timers.tick(100000);
      assert.equal(result.code, 0); assert.equal(result.outcome, 'exited'); assert.equal(result.stdout, '');
      assert.equal(f.uncertain.length, 0); assert.equal(f.lines.length, 0); clean(f);
    });

    await test('no native dependency or API was attempted', () => { assert.deepEqual(nativeAttempts, []); });
  } catch (error) {
    failed++; console.error(`FAIL bounded-process: contract unavailable: ${error && error.message || error}`);
  } finally {
    Module._load = originalLoad;
    for (const restore of restores.reverse()) restore();
  }
  console.log(`bounded-process-smoke: ${passed} passed, ${failed} failed; injected fake children and timers only`);
  if (failed) process.exitCode = 1;
  finished = true;
}

main().catch(error => { console.error('FAIL bounded-process harness:', error.message); process.exitCode = 1; finished = true; });
