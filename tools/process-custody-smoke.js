'use strict';

// An in-memory filesystem only. Never inspect or change the host filesystem,
// spawn a child, launch Electron, or operate on an account/profile/service.
const assert = require('node:assert/strict');
const path = require('node:path').win32;
const Module = require('node:module');
const originalLoad = Module._load;
const forbidden = [];
let api;
try {
  Module._load = function (name, parent, main) {
    if (/^(?:node:)?(?:fs|child_process|os|http|https|net|tls)$/.test(name) || name === 'electron') {
      forbidden.push(name); throw new Error('custody module attempted a native dependency');
    }
    return originalLoad.call(this, name, parent, main);
  };
  api = require('../src/main/process-custody');
} finally { Module._load = originalLoad; }
const { createProcessCustodyStore, MAX_RECORD_BYTES, MAX_RECORD_FILES } = api;
const DIRECTORY = 'C:\\Users\\operator\\AppData\\1132Fixer\\process-custody-v1';
const PARENT = path.dirname(DIRECTORY);
const CLOSED = Object.freeze({ cleanupConfirmed: true, rootExitConfirmed: true, outcome: 'exited', timedOut: false });
const REFUSED = Object.freeze({ cleanupConfirmed: true, rootExitConfirmed: false, outcome: 'spawn-error', timedOut: false });
let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('PASS process-custody: ' + name); }
  catch (error) { failed++; console.error('FAIL process-custody: ' + name + ': ' + error.message); }
}
function error(code) { return Object.assign(new Error(code), { code }); }

function fixture() {
  const nodes = new Map();
  const handles = new Map();
  const calls = [];
  let inode = 1, handle = 0, serial = 0;
  const key = value => value.toLowerCase();
  function put(target, type = 'directory', bytes = Buffer.alloc(0)) {
    const node = { path: target, type, ino: inode++, dev: 42, nlink: 1, symlink: false, bytes: Buffer.from(bytes) };
    nodes.set(key(target), node); return node;
  }
  function node(target) { const value = nodes.get(key(target)); if (!value) throw error('ENOENT'); return value; }
  function stat(value) { return { ino: value.ino, dev: value.dev, nlink: value.nlink, size: value.bytes.length,
    isFile: () => value.type === 'file', isDirectory: () => value.type === 'directory', isSymbolicLink: () => value.symlink }; }
  function checked(method, target) {
    calls.push({ method, target });
    if (f.fail) f.fail(method, target);
  }
  let current = path.parse(PARENT).root;
  put(current);
  for (const part of PARENT.slice(current.length).split('\\')) { current = path.join(current, part); put(current); }
  const io = {
    lstatSync(target) { checked('lstat', target); return stat(node(target)); },
    realpathSync(target) { checked('realpath', target); const value = node(target); return value.redirect || value.path; },
    mkdirSync(target, options) {
      checked('mkdir', target); assert.equal(options.recursive, false);
      if (nodes.has(key(target))) throw error('EEXIST');
      assert.equal(node(path.dirname(target)).type, 'directory'); put(target);
    },
    readdirSync(target) {
      checked('readdir', target); assert.equal(node(target).type, 'directory');
      return [...nodes.values()].filter(item => key(path.dirname(item.path)) === key(target)).map(item => path.basename(item.path));
    },
    openSync(target, flags) {
      checked('open', target);
      let value;
      if (flags === 'wx+') {
        if (nodes.has(key(target))) throw error('EEXIST');
        assert.equal(node(path.dirname(target)).type, 'directory'); value = put(target, 'file');
      } else { assert.equal(flags, 'r'); value = node(target); }
      assert.equal(value.type, 'file');
      const fd = ++handle; handles.set(fd, value); return fd;
    },
    writeSync(fd, bytes, offset, length, position) {
      const value = handles.get(fd); assert.ok(value); checked('write', value.path);
      if (f.shortWrite === 0) return 0;
      const count = Math.min(length, f.shortWrite || length);
      const next = Buffer.alloc(Math.max(value.bytes.length, position + count)); value.bytes.copy(next);
      bytes.copy(next, position, offset, offset + count); value.bytes = next;
      if (f.onWrite) f.onWrite(value);
      return count;
    },
    readSync(fd, bytes, offset, length, position) {
      const value = handles.get(fd); assert.ok(value); checked('read', value.path);
      const count = Math.max(0, Math.min(length, value.bytes.length - position));
      value.bytes.copy(bytes, offset, position, position + count); return count;
    },
    fstatSync(fd) { const value = handles.get(fd); assert.ok(value); checked('fstat', value.path); return stat(value); },
    fsyncSync(fd) { const value = handles.get(fd); assert.ok(value); checked('fsync', value.path); },
    closeSync(fd) { assert.ok(handles.has(fd)); handles.delete(fd); }
  };
  const f = { io, nodes, handles, calls, put, node, fail: null, onWrite: null, shortWrite: null, time: 1000,
    ids: null,
    store() { return createProcessCustodyStore({ fs: io, directory: DIRECTORY, now: () => f.time,
      randomId: () => f.ids ? f.ids.shift() : (++serial).toString(16).padStart(32, '0') }); },
    files() { return [...nodes.values()].filter(value => value.type === 'file'); },
    record(type, token) { return node(path.join(DIRECTORY, token.id + '.' + type + '.json')); },
    mutate(type, token, change) {
      const value = f.record(type, token); const data = JSON.parse(value.bytes.toString('utf8'));
      change(data); value.bytes = Buffer.from(JSON.stringify(data));
    }
  };
  return f;
}

test('import is inert and a missing guarded leaf is clear without writes', () => {
  assert.deepEqual(forbidden, []);
  const f = fixture(); const store = f.store();
  assert.equal(store.inspect().blocked, false);
  assert.equal(f.calls.some(call => ['mkdir', 'write', 'fsync'].includes(call.method)), false);
  assert.equal(f.handles.size, 0);
});
for (const proof of [CLOSED, REFUSED]) test('verified ' + proof.outcome + ' is clear after a fresh instance', () => {
  const f = fixture(); const store = f.store(); const token = store.begin();
  assert.equal(store.inspect().pendingCount, 1);
  assert.equal(f.store().inspect().blocked, true);
  assert.deepEqual(store.complete(token, proof), { complete: true, cleanupConfirmed: true });
  const fresh = f.store().inspect();
  assert.equal(fresh.blocked, false); assert.equal(fresh.completedCount, 1);
  assert.equal(f.files().length, 2); assert.equal(f.handles.size, 0);
});
test('multiple commands owned by this instance may coexist and finish in either order', () => {
  const f = fixture(); const store = f.store(); const a = store.begin('tool-probe'); const b = store.begin('zoom-probe');
  assert.equal(store.inspect().pendingCount, 2);
  store.complete(b, CLOSED); assert.equal(store.inspect().pendingCount, 1);
  store.complete(a, CLOSED); assert.equal(f.store().inspect().blocked, false);
});
test('a new instance cannot adopt or bypass an unfinished token', () => {
  const f = fixture(); const first = f.store(); const token = first.begin(); const fresh = f.store();
  assert.throws(() => fresh.complete(token, CLOSED), { code: 'custody-token-unverified' });
  assert.throws(() => fresh.begin(), { code: 'custody-prior-unresolved' });
  assert.equal(f.files().length, 1);
});
test('same-instance membership cannot adopt a replaced pending record', () => {
  const f = fixture(); const store = f.store(); const token = store.begin();
  f.mutate('pending', token, value => { value.owner = 'f'.repeat(32); });
  assert.throws(() => store.begin(), { code: 'custody-prior-unresolved' });
  assert.throws(() => store.complete(token, CLOSED), { code: 'custody-retained' });
  assert.equal(f.files().length, 1);
});
test('retention persists and cannot be cleared by completion, repeat or restart', () => {
  const f = fixture(); const store = f.store(); const token = store.begin();
  store.retain(token, 'timeout'); assert.deepEqual(store.retain(token, 'timeout'), { retained: true });
  assert.throws(() => store.complete(token, CLOSED), { code: 'custody-retained' });
  assert.throws(() => store.begin(), { code: 'custody-prior-unresolved' });
  assert.equal(f.store().inspect().retainedCount, 1); assert.equal(f.files().length, 2);
});
for (const proof of [{ cleanupConfirmed: false, outcome: 'exited' },
  { cleanupConfirmed: true, outcome: 'timeout', rootExitConfirmed: true },
  { cleanupConfirmed: true, outcome: 'exited', rootExitConfirmed: false },
  { cleanupConfirmed: true, outcome: 'spawn-error', rootExitConfirmed: true },
  { ...CLOSED, timedOut: true }, { pid: 1234, exited: true }]) {
  test('contradictory or PID-only completion is refused: ' + JSON.stringify(proof), () => {
    const f = fixture(); const store = f.store(); const token = store.begin();
    assert.throws(() => store.complete(token, proof), { code: 'custody-completion-unverified' });
    assert.equal(store.inspect().blocked, true); assert.equal(f.store().inspect().blocked, true);
    assert.equal(f.files().length, 1);
  });
}
test('copied and forged tokens cannot complete an owned command', () => {
  const f = fixture(); const store = f.store(); const token = store.begin();
  for (const foreign of [{ ...token }, Object.freeze({ id: token.id }), null, token.id]) {
    assert.throws(() => store.complete(foreign, CLOSED), { code: 'custody-token-unverified' });
  }
  assert.equal(store.inspect().pendingCount, 1); store.complete(token, CLOSED);
  assert.throws(() => store.complete(token, CLOSED), { code: 'custody-token-unverified' });
});
for (const component of ['C:\\Users', PARENT, DIRECTORY]) test('redirected or reparse component blocks dispatch: ' + component, () => {
  for (const redirect of [false, true]) {
    const f = fixture(); f.put(DIRECTORY);
    const target = f.node(component);
    if (redirect) target.redirect = 'C:\\other'; else target.symlink = true;
    const store = f.store(); let dispatched = 0;
    assert.equal(store.inspect().blocked, true);
    assert.throws(() => { store.begin(); dispatched++; });
    assert.equal(dispatched, 0); assert.equal(f.files().length, 0);
  }
});
for (const failure of ['EACCES', 'EPERM', 'EIO']) test('denied or failed storage is never an empty store: ' + failure, () => {
  const f = fixture(); f.fail = (method, target) => { if (method === 'lstat' && target === PARENT) throw error(failure); };
  const store = f.store(); let dispatched = 0;
  assert.equal(store.inspect().complete, false);
  assert.throws(() => { store.begin(); dispatched++; }); assert.equal(dispatched, 0);
});
test('missing parent is not interpreted as an absent dedicated store', () => {
  const f = fixture(); f.nodes.delete(PARENT.toLowerCase()); const store = f.store();
  assert.equal(store.inspect().blocked, true); assert.throws(() => store.begin()); assert.equal(f.files().length, 0);
});
for (const phase of ['write', 'fsync']) test('interrupted pending ' + phase + ' leaves a durable blocker and no dispatch', () => {
  const f = fixture(); const store = f.store(); let dispatched = 0;
  f.fail = method => { if (method === phase) throw error('EIO'); };
  assert.throws(() => { store.begin(); dispatched++; }); assert.equal(dispatched, 0);
  f.fail = null; assert.equal(store.inspect().blocked, true); assert.equal(f.store().inspect().blocked, true);
  assert.equal(f.files().length, 1); assert.equal(f.handles.size, 0);
});
test('zero-length write cannot return a token', () => {
  const f = fixture(); f.shortWrite = 0; assert.throws(() => f.store().begin());
  assert.equal(f.store().inspect().blocked, true); assert.equal(f.handles.size, 0);
});
test('ordinary partial writes are completed and verified by exact handle readback', () => {
  const f = fixture(); f.shortWrite = 3; const store = f.store(); const token = store.begin();
  store.complete(token, CLOSED); assert.equal(f.store().inspect().blocked, false);
});
test('a replaced path cannot acknowledge the original file handle', () => {
  const f = fixture(); f.onWrite = value => { f.onWrite = null; f.put(value.path, 'file', value.bytes); };
  const store = f.store(); let token;
  assert.throws(() => { token = store.begin(); }, { code: 'custody-record-unverified' });
  assert.equal(token, undefined);
  assert.equal(store.inspect().blocked, true);
  assert.equal(f.store().inspect().blocked, true);
  assert.equal(f.handles.size, 0);
});
test('incomplete completion write preserves pending ownership after restart', () => {
  const f = fixture(); const store = f.store(); const token = store.begin();
  f.fail = (method, target) => { if (method === 'write' && target.endsWith('.complete.json')) throw error('EIO'); };
  assert.throws(() => store.complete(token, CLOSED), { code: 'custody-completion-unverified' });
  f.fail = null; assert.equal(store.inspect().blocked, true); assert.equal(f.store().inspect().blocked, true);
  assert.equal(f.record('pending', token).bytes.length > 0, true);
});
test('failed retained write still leaves the original pending record unresolved', () => {
  const f = fixture(); const store = f.store(); const token = store.begin();
  f.fail = (method, target) => { if (method === 'open' && target.endsWith('.retained.json')) throw error('EACCES'); };
  assert.throws(() => store.retain(token, 'timeout'), { code: 'custody-retention-unverified' });
  f.fail = null; assert.equal(store.inspect().blocked, true); assert.equal(f.store().inspect().blocked, true);
  assert.throws(() => store.complete(token, CLOSED), { code: 'custody-retained' });
});
for (const change of [value => { value.pendingSha256 = '0'.repeat(64); },
  value => { value.owner = 'f'.repeat(32); }, value => { value.capturedAtMs = 1; },
  value => { value.pid = 1234; }, value => { value.outcome = 'kill-requested'; }]) {
  test('malformed or foreign completion cannot clear a pending record', () => {
    const f = fixture(); const store = f.store(); const token = store.begin(); store.complete(token, CLOSED);
    f.mutate('complete', token, change); const fresh = f.store().inspect();
    assert.equal(fresh.blocked, true); assert.equal(fresh.complete, false);
  });
}
test('a valid retained record overrides an otherwise valid completion', () => {
  const f = fixture(); const store = f.store(); const token = store.begin(); store.retain(token, 'timeout');
  const retained = JSON.parse(f.record('retained', token).bytes.toString());
  delete retained.reason; retained.type = 'complete'; retained.outcome = 'exited';
  f.put(path.join(DIRECTORY, token.id + '.complete.json'), 'file', Buffer.from(JSON.stringify(retained)));
  const fresh = f.store().inspect(); assert.equal(fresh.blocked, true); assert.equal(fresh.retainedCount, 1);
});
for (const content of [' ', '{}', '{', Buffer.from([0xff]), 'x'.repeat(MAX_RECORD_BYTES + 1)]) {
  test('empty, malformed, oversized or invalid UTF-8 pending data fails closed', () => {
    const f = fixture(); const token = f.store().begin();
    f.record('pending', token).bytes = Buffer.from(content);
    assert.equal(f.store().inspect().blocked, true);
  });
}
test('an orphan completion is not safe evidence', () => {
  const f = fixture(); const store = f.store(); const token = store.begin(); store.complete(token, CLOSED);
  f.nodes.delete(path.join(DIRECTORY, token.id + '.pending.json').toLowerCase());
  assert.equal(f.store().inspect().blocked, true);
});
for (const name of ['unexpected.tmp', 'escape', 'A'.repeat(32) + '.pending.json']) test('unknown directory entries block: ' + name, () => {
  const f = fixture(); f.put(DIRECTORY); f.put(path.join(DIRECTORY, name), 'file', Buffer.from('{}'));
  assert.equal(f.store().inspect().blocked, true); assert.throws(() => f.store().begin());
});
test('hard-linked records are refused', () => {
  const f = fixture(); const token = f.store().begin(); f.record('pending', token).nlink = 2;
  assert.equal(f.store().inspect().blocked, true);
});
test('identifier collision never overwrites or retries an existing record', () => {
  const f = fixture(); const store = f.store(); const token = store.begin(); store.complete(token, CLOSED);
  const before = Buffer.from(f.record('pending', token).bytes); f.ids = [token.id];
  assert.throws(() => store.begin(), { code: 'custody-id-collision' });
  assert.equal(f.record('pending', token).bytes.equals(before), true); assert.equal(f.files().length, 2);
});
test('invalid IDs, clocks and backdated completion cannot dispatch or claim closure', () => {
  for (const invalid of ['', '../escape', 'f'.repeat(31), 1]) {
    const f = fixture(); f.ids = [invalid]; assert.throws(() => f.store().begin()); assert.equal(f.files().length, 0);
  }
  const f = fixture(); const store = f.store(); const token = store.begin(); f.time = 999;
  assert.throws(() => store.complete(token, CLOSED)); assert.equal(f.store().inspect().blocked, true);
});
test('bounded inventory refuses an excess of entries without opening records', () => {
  const f = fixture(); f.put(DIRECTORY);
  f.io.readdirSync = () => new Array(MAX_RECORD_FILES + 1).fill('0'.repeat(32) + '.pending.json');
  assert.equal(f.store().inspect().blocked, true); assert.equal(f.calls.some(call => call.method === 'open'), false);
});
test('untrusted path, metadata and incomplete adapters are rejected before I/O', () => {
  const f = fixture();
  for (const directory of ['relative', '\\\\server\\share\\custody', 'C:\\data\\..\\custody', 'C:\\data\\custody:stream', 'C:\\']) {
    assert.throws(() => createProcessCustodyStore({ fs: f.io, directory, randomId: () => '1'.repeat(32), now: () => 1 }), TypeError);
  }
  assert.throws(() => createProcessCustodyStore({ fs: {}, directory: DIRECTORY, randomId: () => '1'.repeat(32), now: () => 1 }), TypeError);
  const store = f.store(); assert.throws(() => store.begin('private path C:\\user'), TypeError);
  assert.equal(f.calls.length, 0);
});

console.log('process-custody-smoke: ' + passed + ' passed, ' + failed + ' failed; in-memory filesystem only');
if (failed) process.exitCode = 1;
