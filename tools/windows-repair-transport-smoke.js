'use strict';

// Inert Node ChildProcess/stdio/filesystem fixtures only. No real PowerShell,
// child process, protected store, account, profile or browser operation runs.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
let createWindowsRepairTransport;
let BOOTSTRAP_ARGS;
let finished = false;
let passed = 0;
let failed = 0;
const nativeAttempts = [];
process.once('beforeExit', () => {
  if (!finished) { console.error('FAIL windows-repair-transport: unfinished async suite'); process.exitCode = 1; }
});

class FakeTimers {
  constructor() { this.now = 0; this.serial = 0; this.jobs = new Map(); }
  setTimeout(fn, ms) { const id = ++this.serial; this.jobs.set(id, { fn, at: this.now + ms }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  tick(ms) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      this.jobs.delete(next[0]); this.now = next[1].at; next[1].fn();
    }
    this.now = end;
  }
}
class FakeInput extends EventEmitter {
  constructor() { super(); this.writes = []; this.callbacks = []; this.accept = true; this.auto = true; this.ended = false; }
  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes));
    if (this.auto) callback(null); else this.callbacks.push(callback);
    return this.accept;
  }
  end() { this.ended = true; }
  flush(error = null) { assert.ok(this.callbacks.length); this.callbacks.shift()(error); }
}
class FakeChild extends EventEmitter {
  constructor() { super(); this.stdin = new FakeInput(); this.stdout = new EventEmitter(); this.stderr = new EventEmitter(); this.killCalls = 0; }
  kill() { this.killCalls++; throw new Error('transport must never kill its worker'); }
}

const source = Buffer.from('# synthetic maintained worker fixture\n', 'utf8');
const SHA = crypto.createHash('sha256').update(source).digest('hex');
const OP = { id: 'repair-a', generation: 1, machineId: 'machine-a' };
function fixture(extra = {}) {
  const timers = new FakeTimers();
  const children = [];
  const spawnCalls = [];
  const retained = [];
  const late = [];
  const transport = createWindowsRepairTransport({
    pwshPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', timers,
    fs: { realpathSync: value => value, statSync: () => ({ isFile: () => true }) },
    spawn: (...args) => { const child = new FakeChild(); children.push(child); spawnCalls.push(args); return child; },
    onRetained: value => retained.push(value), onLateResponse: value => late.push(value), ...extra
  });
  const config = { bootstrapLine: source.toString('base64'), scriptSha256: SHA, startArgs: BOOTSTRAP_ARGS,
    maxResponseBytes: 4096, startupTimeoutMs: 10,
    admission: { verified: true, kind: 'recovery-probe', machineId: 'machine-a', token: 'admission-a' } };
  const child = () => children[children.length - 1];
  function frame(value, target = child()) { target.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n')); }
  function ready(overrides = {}) {
    return { kind: 'ready', protocolVersion: 1, scriptSha256: SHA, workerNonce: 'worker-a', machineId: 'machine-a',
      shell: { major: 7, edition: 'Core', is64Bit: true }, storageProtected: true,
      capabilities: { atomicIdentityExpectation: true, exclusiveProfileCreation: true, completePurgeReadback: true }, ...overrides };
  }
  function response(id, command, result, overrides = {}) {
    return { kind: 'response', protocolVersion: 1, scriptSha256: SHA, workerNonce: 'worker-a',
      id, command, completed: true, ok: true, result, ...overrides };
  }
  async function open() { const promise = transport.start(config); frame(ready()); return await promise; }
  return { transport, config, timers, children, spawnCalls, retained, late, child, frame, ready, response, open };
}
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
function observe(promise) {
  const state = { settled: false };
  promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
async function rpc(f, session, id, command, result, context = {}) {
  const promise = session.request({ id, command, context }, { timeoutMs: 10 });
  f.frame(f.response(id, command, result)); return await promise;
}
async function leaseAndRelease(f, session) {
  const common = { operationId: OP.id, generation: OP.generation, machineId: OP.machineId, complete: true };
  await rpc(f, session, 'acquire-a', 'acquireLease', { ...common, status: 'held', scope: 'machine', exclusive: true, nonce: 'lease-a' }, { operation: OP });
  return await rpc(f, session, 'release-a', 'releaseLease', { ...common, status: 'released', nonce: 'lease-a', leaseNonce: 'lease-a' },
    { operation: OP, lease: { nonce: 'lease-a' } });
}
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (error) { failed++; console.error('FAIL windows-repair-transport: ' + name + ': ' + error.message); }
}

(async () => {
  const originalLoad = Module._load;
  const restores = [];
  const forbidden = new Set(['fs', 'fs/promises', 'child_process', 'os', 'electron', 'net', 'http', 'https', 'worker_threads']);
  Module._load = function (name, parent, main) {
    if (forbidden.has(name.replace(/^node:/, ''))) { nativeAttempts.push(name); throw new Error('native dependency denied'); }
    return originalLoad.call(this, name, parent, main);
  };
  for (const [object, key] of [[process, 'kill'], [process, 'exit'], [globalThis, 'setTimeout'], [globalThis, 'setInterval'], [globalThis, 'fetch']]) {
    const original = object[key]; object[key] = () => { nativeAttempts.push(key); throw new Error('native API denied'); };
    restores.push(() => { object[key] = original; });
  }
  try {
    ({ createWindowsRepairTransport, BOOTSTRAP_ARGS } = require('../src/main/windows-repair-transport'));
    await test('fixed argv contains no policy bypass, temp script, bootstrap body or credential', async () => {
      const f = fixture(); const session = await f.open();
      assert.equal(session.info().shell.major, 7); assert.equal(f.spawnCalls.length, 1);
      assert.deepEqual(f.spawnCalls[0][1], [...BOOTSTRAP_ARGS]);
      assert.deepEqual(f.spawnCalls[0][2], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      assert.equal(/ExecutionPolicy|Bypass|\.ps1|synthetic maintained/.test(BOOTSTRAP_ARGS.join(' ')), false);
      assert.equal(f.child().stdin.writes.length, 1);
      assert.equal(f.child().stdin.writes[0].toString(), f.config.bootstrapLine + '\n');
    });
    for (const value of ['pwsh.exe', '\\\\server\\share\\pwsh.exe', 'C:\\Windows\\System32\\powershell.exe', 'C:\\x\\pwsh.exe:stream']) {
      await test('invalid host path refuses before spawn', async () => {
        const f = fixture({ pwshPath: value });
        await assert.rejects(f.transport.start(f.config), error => error.code === 'invalid_pwsh_path');
        assert.equal(f.spawnCalls.length, 0);
      });
    }
    await test('script hash mismatch and altered loader refuse before spawn', async () => {
      const f = fixture();
      await assert.rejects(f.transport.start({ ...f.config, scriptSha256: '0'.repeat(64) }), error => error.code === 'script_mismatch');
      await assert.rejects(f.transport.start({ ...f.config, startArgs: ['-Command', 'untrusted'] }), error => error.code === 'invalid_config');
      assert.equal(f.spawnCalls.length, 0);
    });
    await test('opening requires an explicit recovery-probe admission, not invented persistence', async () => {
      const f = fixture(); await assert.rejects(f.transport.start({ ...f.config, admission: null }), error => error.code === 'admission_required');
      assert.equal(f.spawnCalls.length, 0);
    });
    await test('spawn refusal exposes no raw error and leaves no invented child custody', async () => {
      const f = fixture({ spawn: () => { throw new Error('private launch details'); } });
      await assert.rejects(f.transport.start(f.config), error => error.code === 'worker_spawn_failed' && !error.message.includes('private'));
      assert.equal(f.transport.currentSession(), null); assert.equal(f.retained.length, 0);
    });
    for (const code of ['unsupported_host', 'storage_unverified', 'native_failure', 'private raw error']) {
      await test('startup error exposes only useful allowlisted code and retains owned worker', async () => {
        const f = fixture(); const state = observe(f.transport.start(f.config));
        f.frame({ kind: 'startup-error', protocolVersion: 1, error: { code } }); await flush();
        assert.equal(state.error.code, code === 'private raw error' ? 'native_failure' : code);
        assert.equal(f.transport.currentSession().state().reason, 'startup_error'); assert.equal(f.child().killCalls, 0);
      });
    }
    for (const change of [r => { r.shell.major = 5; }, r => { r.shell.edition = 'Desktop'; },
      r => { r.shell.is64Bit = false; }, r => { r.scriptSha256 = '0'.repeat(64); },
      r => { r.machineId = 'foreign'; }, r => { r.storageProtected = false; },
      r => { r.capabilities.atomicIdentityExpectation = false; }]) await test('invalid Core/hash/machine/store handshake retains original handle', async () => {
      const f = fixture(); const promise = f.transport.start(f.config); const state = observe(promise);
      const ready = f.ready(); change(ready); f.frame(ready); await flush();
      assert.equal(state.error.code, 'invalid_ready'); assert.equal(f.retained.length, 1);
      assert.equal(f.retained[0].workerHandle, f.child()); assert.equal(f.child().killCalls, 0);
      await assert.rejects(f.transport.start({ ...f.config, admission: { ...f.config.admission, token: 'new' } }), error => error.code === 'worker_owned');
    });
    await test('startup timeout and late READY cannot reopen or replace worker', async () => {
      const f = fixture(); const state = observe(f.transport.start(f.config)); f.timers.tick(10); await flush();
      assert.equal(state.error.code, 'startup_timeout'); f.frame(f.ready());
      assert.equal(f.transport.currentSession().state().retained, true); assert.equal(f.spawnCalls.length, 1);
      assert.equal(f.child().killCalls, 0); assert.equal(f.timers.jobs.size, 0);
    });
    await test('bootstrap backpressure must drain even if READY already arrived', async () => {
      const f = fixture({ spawn: () => { const c = new FakeChild(); c.stdin.accept = false; f.children.push(c); return c; } });
      const promise = f.transport.start(f.config); const state = observe(promise); f.frame(f.ready()); await flush();
      assert.equal(state.settled, false); f.child().stdin.emit('drain');
      assert.equal((await promise).state().ready, true);
    });
    await test('correlated RPC result waits for write callback and drain', async () => {
      const f = fixture(); const s = await f.open(); const input = f.child().stdin;
      input.auto = false; input.accept = false;
      const state = observe(s.request({ id: 'read-a', command: 'readJournal', context: {} }, { timeoutMs: 10 }));
      f.frame(f.response('read-a', 'readJournal', { status: 'verified', complete: true })); await flush();
      assert.equal(state.settled, false); assert.equal(s.observe('read-a').authoritative, false);
      input.emit('drain'); await flush(); assert.equal(state.settled, false);
      input.flush(); await flush(); assert.equal(state.value.ok, true); assert.equal(f.timers.jobs.size, 0);
    });
    await test('a never-returned write callback is bounded even after valid response', async () => {
      const f = fixture(); const s = await f.open(); f.child().stdin.auto = false;
      const promise = s.request({ id: 'read-a', command: 'readJournal', context: {} }, { timeoutMs: 3 });
      f.frame(f.response('read-a', 'readJournal', { status: 'verified' }));
      f.timers.tick(3); assert.equal((await promise).error.code, 'command_timeout');
      f.child().stdin.flush(); assert.equal(s.state().retained, true); assert.equal(f.child().killCalls, 0);
    });
    await test('non-JSON prototype hooks cannot add unvalidated outbound fields', async () => {
      const f = fixture(); const s = await f.open(); let invoked = false;
      const context = Object.create({ toJSON() { invoked = true; return { password: 'should-never-serialize' }; } });
      const count = f.child().stdin.writes.length;
      assert.equal((await s.request({ id: 'read-a', command: 'readJournal', context })).error.code, 'invalid_request');
      assert.equal(invoked, false); assert.equal(f.child().stdin.writes.length, count);
    });
    await test('request timeout retains handle and observes late correlated result without authority', async () => {
      const f = fixture(); const s = await f.open();
      const promise = s.request({ id: 'native-a', command: 'purgeProfile', context: {} }, { timeoutMs: 3 });
      f.timers.tick(3); assert.equal((await promise).error.code, 'command_timeout');
      f.frame(f.response('native-a', 'purgeProfile', { status: 'verified', complete: true, purgeComplete: true }));
      assert.equal(f.late.length, 1); assert.equal(s.observe('native-a').result.purgeComplete, true);
      assert.equal(s.observe('native-a').authoritative, false); assert.equal(f.late[0].response.authoritative, false);
      assert.equal(s.state().retained, true);
      const count = f.child().stdin.writes.length;
      assert.equal((await s.request({ id: 'recovery-a', command: 'inspectRecovery', context: {} })).error.code, 'worker_retained');
      assert.equal((await s.close()).ok, false); assert.equal(f.child().stdin.writes.length, count);
      f.child().emit('close', 0); assert.equal(s.state().ownsWorker, true); assert.equal(f.child().killCalls, 0);
    });
    for (const change of [r => { r.id = 'unknown'; }, r => { r.command = 'deleteAccount'; },
      r => { r.workerNonce = 'foreign'; }, r => { r.scriptSha256 = '0'.repeat(64); },
      r => { r.completed = false; }, r => { r.result = null; }]) await test('foreign or incomplete response blocks without exposing raw output', async () => {
      const f = fixture(); const s = await f.open(); const promise = s.request({ id: 'read-a', command: 'readJournal', context: {} });
      const response = f.response('read-a', 'readJournal', { status: 'verified' }); change(response); f.frame(response);
      assert.equal((await promise).ok, false); assert.equal(s.state().retained, true); assert.equal(f.child().killCalls, 0);
    });
    for (const code of ['standard_account_unverified', 'standard_account_privileged']) {
      await test('native Standard-role failure retains its safe reason without private detail: ' + code, async () => {
        const f = fixture(), s = await f.open();
        const promise = s.request({ id:'role-a', command:'verifyProvisionedState', context:{} });
        const response = f.response('role-a', 'verifyProvisionedState', null,
          { ok:false, error:{ code, message:'private native detail', sid:'private identity' } });
        delete response.result;
        f.frame(response);
        const result = await promise;
        assert.equal(result.ok, false);
        assert.deepEqual(result.error, {code});
        assert.equal(JSON.stringify(result).includes('private'), false);
        assert.equal(f.child().killCalls, 0);
      });
    }
    await test('duplicate response cannot overwrite a settled receipt', async () => {
      const f = fixture(); const s = await f.open();
      await rpc(f, s, 'read-a', 'readJournal', { status: 'verified', complete: true });
      f.frame(f.response('read-a', 'readJournal', { status: 'different' }));
      assert.equal(s.state().reason, 'duplicate_response'); assert.equal(s.observe('read-a').result.status, 'verified');
    });
    await test('byte framing preserves split multibyte JSON and CRLF', async () => {
      const f = fixture(); const s = await f.open(); const promise = s.request({ id: 'read-a', command: 'readJournal', context: {} });
      const bytes = Buffer.from(JSON.stringify(f.response('read-a', 'readJournal', { text: 'José 東京 😀' })) + '\r\n');
      for (const byte of bytes) f.child().stdout.emit('data', Buffer.from([byte]));
      assert.equal((await promise).result.text, 'José 東京 😀'); assert.equal(s.state().retained, false);
    });
    await test('oversized newline-free output and invalid UTF8 remain bounded retained failures', async () => {
      const f = fixture(); const s = await f.open();
      f.child().stdout.emit('data', Buffer.alloc(5000, 65)); assert.equal(s.state().reason, 'oversized_frame');
      assert.equal(f.child().killCalls, 0);
      const g = fixture(); const other = await g.open();
      g.child().stdout.emit('data', Buffer.from([0xc3, 0x28, 10])); assert.equal(other.state().reason, 'invalid_frame');
    });
    await test('secret is stdin-only and cannot be echoed in results, errors or observations', async () => {
      const f = fixture(); const s = await f.open(); const secret = 'Synthetic-Secret-1132!';
      const promise = s.request({ id: 'create-a', command: 'createDisabledAccount', context: {}, secret });
      assert.equal(JSON.stringify(f.spawnCalls).includes(secret), false);
      assert.equal(JSON.parse(f.child().stdin.writes[1].toString()).secret, secret);
      f.frame(f.response('create-a', 'createDisabledAccount', { password: secret }));
      const result = await promise;
      assert.equal(result.error.code, 'secret_in_response'); assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(s.observe('create-a'), null); assert.equal(JSON.stringify(s.state()).includes(secret), false);
      assert.equal((await s.request({ id: 'bad', command: 'readJournal', context: {}, secret })).ok, false);
    });
    await test('a known credential cannot later become an RPC identifier or failure receipt', async () => {
      const f = fixture(); const s = await f.open(); const secret = 'fixture-helper-credential';
      const promise = s.request({ id: 'create-a', command: 'createDisabledAccount', context: {}, secret });
      f.frame(f.response('create-a', 'createDisabledAccount', { status: 'created', complete: true })); assert.equal((await promise).ok, true);
      const count = f.child().stdin.writes.length;
      const result = await s.request({ id: secret, command: 'readJournal', context: {} }, { timeoutMs: 3 });
      assert.equal(result.error.code, 'invalid_request'); assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(f.child().stdin.writes.length, count); assert.equal(f.timers.jobs.size, 0);
    });
    await test('fixed workflow commands use correlated RPC without an arbitrary execution command', async () => {
      const f = fixture(); const s = await f.open(); let serial = 0;
      for (const command of ['workflow-launch-zoom', 'workflow-verify-profile', 'workflow-configure-helper',
        'workflow-seal-credential', 'workflow-verify-zoom']) {
        assert.equal((await rpc(f, s, 'workflow-' + (++serial), command, { status: 'verified', complete: true }, { operation: OP })).ok, true);
      }
      const count = f.child().stdin.writes.length;
      for (const command of ['workflow-run-script', 'runProcess', 'powershell', 'workflow-launch-zoom -Command untrusted']) {
        assert.equal((await s.request({ id: 'invalid-' + (++serial), command, context: { operation: OP } })).error.code, 'invalid_request');
      }
      assert.equal(f.child().stdin.writes.length, count);
    });
    await test('workflow secrets are allowed only on launch and credential sealing', async () => {
      for (const command of ['workflow-launch-zoom', 'workflow-seal-credential']) {
        const f = fixture(); const s = await f.open(); const secret = 'SyntheticWorkflowSecret1132';
        const promise = s.request({ id: 'workflow-a', command, context: { operation: OP }, secret });
        assert.equal(JSON.parse(f.child().stdin.writes[1].toString()).secret, secret);
        f.frame(f.response('workflow-a', command, { status: 'verified', complete: true }));
        assert.equal((await promise).ok, true); assert.equal(JSON.stringify(f.spawnCalls).includes(secret), false);
        assert.equal(JSON.stringify(s.observe('workflow-a')).includes(secret), false);
      }
      for (const command of ['workflow-verify-profile', 'workflow-configure-helper', 'workflow-verify-zoom']) {
        const f = fixture(); const s = await f.open(); const count = f.child().stdin.writes.length;
        assert.equal((await s.request({ id: 'workflow-a', command, context: { operation: OP }, secret: 'SyntheticWorkflowSecret1132' })).error.code, 'invalid_request');
        assert.equal(f.child().stdin.writes.length, count);
      }
    });
    await test('write errors and worker exit keep late observers and custody without killing', async () => {
      const f = fixture(); const s = await f.open(); f.child().stdin.auto = false;
      const promise = s.request({ id: 'read-a', command: 'readJournal', context: {} });
      f.child().stdin.flush(new Error('private raw error text'));
      assert.equal((await promise).error.code, 'stdin_error'); f.child().emit('error', new Error('late'));
      f.frame(f.response('read-a', 'readJournal', { status: 'verified' })); assert.equal(f.late.length, 1);
      f.child().emit('exit', 1); f.child().emit('close', 1);
      assert.equal(s.state().ownsWorker, true); assert.equal(f.retained.length, 1); assert.equal(f.child().killCalls, 0);
    });
    await test('clean close needs matching release plus native close receipt and same child close', async () => {
      const f = fixture(); const s = await f.open(); await leaseAndRelease(f, s);
      const promise = s.close({ timeoutMs: 10 }); const state = observe(promise);
      f.frame(f.response('transport-close-1', 'close', { status: 'closed', complete: true, leaseHeld: false }));
      await flush(); assert.equal(state.settled, false);
      f.child().emit('exit', 0); f.child().emit('close', 0);
      assert.equal((await promise).ok, true); assert.equal(f.transport.currentSession(), null);
      assert.equal(f.child().killCalls, 0); assert.equal(f.timers.jobs.size, 0);
      f.child().emit('error', new Error('late after clean release')); assert.equal(f.retained.length, 0);
    });
    await test('recovery-only worker closes without clearing prior blocked native journal', async () => {
      const f = fixture(); const s = await f.open();
      await rpc(f, s, 'inspect-a', 'inspectRecovery', { status: 'verified', complete: true, unresolved: true });
      const promise = s.close({ timeoutMs: 10 });
      f.frame(f.response('transport-close-1', 'close', { status: 'closed', complete: true, leaseHeld: false }));
      f.child().emit('close', 0); assert.equal((await promise).ok, true);
      assert.equal(s.observe('inspect-a').result.unresolved, true);
    });
    await test('an effect without verified lease release cannot request close', async () => {
      const f = fixture(); const s = await f.open();
      await rpc(f, s, 'effect-a', 'writeJournal', { status: 'persisted', complete: true });
      const count = f.child().stdin.writes.length;
      assert.equal((await s.close()).error.code, 'close_unverified'); assert.equal(f.child().stdin.writes.length, count);
    });
    await test('foreign lease release cannot authorize close', async () => {
      const f = fixture(); const s = await f.open();
      const common = { operationId: OP.id, generation: OP.generation, machineId: OP.machineId, complete: true };
      await rpc(f, s, 'acquire-a', 'acquireLease', { ...common, status: 'held', scope: 'machine', exclusive: true, nonce: 'lease-a' }, { operation: OP });
      await rpc(f, s, 'release-a', 'releaseLease', { ...common, status: 'released', nonce: 'foreign', leaseNonce: 'foreign' }, { operation: OP });
      assert.equal((await s.close()).error.code, 'close_unverified');
      assert.equal((await s.request({ id: 'transport-close-forged', command: 'close', context: {} }, {}, true)).error.code, 'invalid_request');
    });
    await test('previous release cannot authorize later acquisition or effect', async () => {
      for (const command of ['acquireLease', 'writeJournal']) {
        const f = fixture(); const s = await f.open(); await leaseAndRelease(f, s);
        const result = command === 'acquireLease' ? { operationId: OP.id, generation: OP.generation, machineId: OP.machineId,
          complete: true, status: 'held', scope: 'machine', exclusive: true, nonce: 'lease-b' } : { status: 'persisted', complete: true };
        await rpc(f, s, 'later-a', command, result, { operation: OP });
        assert.equal((await s.close()).error.code, 'close_unverified'); assert.equal(f.child().killCalls, 0);
      }
    });
    await test('worker error followed by close cannot turn failure into clean release', async () => {
      const f = fixture(); const s = await f.open(); const promise = s.close({ timeoutMs: 10 });
      f.frame(f.response('transport-close-1', 'close', { status: 'closed', complete: true, leaseHeld: false }));
      await flush(); f.child().emit('error', new Error('private detail')); f.child().emit('close', 0);
      assert.equal((await promise).ok, false); assert.equal(s.state().retained, true);
      assert.equal(f.transport.currentSession(), s); assert.equal(f.child().killCalls, 0);
    });
    await test('close receipt without actual child close times out and retains custody', async () => {
      const f = fixture(); const s = await f.open(); const promise = s.close({ timeoutMs: 3 });
      f.frame(f.response('transport-close-1', 'close', { status: 'closed', complete: true, leaseHeld: false }));
      await flush(); f.timers.tick(3); assert.equal((await promise).error.code, 'close_timeout');
      f.child().emit('close', 0); assert.equal(s.state().ownsWorker, true); assert.equal(s.state().retained, true);
    });
    await test('fresh admission and new native nonce are required for a later clean session', async () => {
      const f = fixture(); const s = await f.open(); const close = s.close();
      f.frame(f.response('transport-close-1', 'close', { status: 'closed', complete: true, leaseHeld: false }));
      f.child().emit('close', 0); assert.equal((await close).ok, true);
      await assert.rejects(f.transport.start(f.config), error => error.code === 'admission_replayed');
      const next = f.transport.start({ ...f.config, admission: { ...f.config.admission, token: 'admission-b' } });
      f.frame(f.ready({ workerNonce: 'worker-b' })); const second = await next;
      assert.equal(second.info().workerNonce, 'worker-b'); assert.equal(f.children.length, 2);
    });
    await test('no native dependency or API ran', () => { assert.deepEqual(nativeAttempts, []); });
  } finally {
    Module._load = originalLoad; for (const restore of restores.reverse()) restore();
  }
  console.log('windows-repair-transport-smoke: ' + passed + ' passed, ' + failed + ' failed; inert owned-child fixtures only');
  if (failed) process.exitCode = 1;
  finished = true;
})().catch(error => { console.error('FAIL windows-repair-transport harness:', error.message); process.exitCode = 1; finished = true; });
