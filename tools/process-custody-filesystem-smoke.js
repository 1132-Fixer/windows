'use strict';

// Opt-in, real-filesystem recovery fixtures. All writes stay in a fresh child
// of the explicitly selected AI-Recovery root. All children are this driver's
// fixed, bounded Node fixtures. No PowerShell, UI, native repair, service,
// account, profile, network operation or cleanup/delete command is available.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path').win32;
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createProcessCustodyStore } = require('../src/main/process-custody');
const { createBoundedProcessRunner } = require('../src/main/bounded-process');

const APPROVED_ROOT = 'C:\\src\\AI-Recovery\\1132-Fixer';
const RUN_NAME = /^process-custody-fs-\d{8}T\d{6}Z-[a-f0-9]{32}$/;
const LABEL = /^(closed|refused|interrupted|retained|unknown|partial)$/;
const ACTIONS = new Set(['noop', 'leave-pending', 'inspect-blocked', 'inspect-clear']);
const FIXTURE_SCHEMA = '1132-process-custody-filesystem-fixture/1';
const RECEIPT_SCHEMA = '1132-process-custody-filesystem-smoke/1';
const SOURCES = Object.freeze([
  '../src/main/process-custody.js', '../src/main/bounded-process.js', './process-custody-filesystem-smoke.js'
]);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const randomId = () => crypto.randomBytes(16).toString('hex');
let unresolvedChild = false;
let finished = false;
process.once('beforeExit', () => {
  if (!finished) {
    console.error('FAIL process-custody-filesystem: fixture did not produce its final receipt');
    process.exitCode = 1;
  }
});

function samePath(a, b) { return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase(); }
function canonicalLocal(value) {
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value) &&
    !/[\x00-\x1f"<>|?*]/.test(value) && !value.slice(2).includes(':') &&
    path.normalize(value) === value && !value.endsWith('\\');
}
function below(value, parent) {
  return canonicalLocal(value) && value.toLowerCase().startsWith(parent.toLowerCase() + '\\');
}
function guardExisting(target, directory) {
  assert.equal(canonicalLocal(target), true, 'fixture path must be canonical and local');
  const root = path.parse(target).root;
  let current = root;
  const entries = [root];
  for (const part of target.slice(root.length).split('\\')) { current = path.join(current, part); entries.push(current); }
  let leaf;
  for (const entry of entries) {
    const stat = fs.lstatSync(entry);
    assert.equal(stat.isSymbolicLink(), false, 'fixture path cannot contain a symlink or junction');
    assert.equal(samePath(fs.realpathSync.native(entry), entry), true, 'fixture realpath cannot redirect');
    if (entry !== target || directory) assert.equal(stat.isDirectory(), true, 'fixture ancestor must be a directory');
    else assert.equal(stat.isFile(), true, 'fixture entry must be a file');
    leaf = stat;
  }
  return leaf;
}
function checkedRoot(value) {
  assert.equal(process.platform, 'win32', 'this explicit filesystem receipt requires Windows');
  assert.equal(process.release.name, 'node');
  assert.equal(process.versions.electron, undefined, 'fixture execution requires ordinary Node');
  assert.equal(below(value, APPROVED_ROOT), true, 'root must be an existing child of C:\\src\\AI-Recovery\\1132-Fixer');
  guardExisting(value, true);
  return value;
}
function checkedRun(value) {
  checkedRoot(path.dirname(value));
  assert.equal(RUN_NAME.test(path.basename(value)), true, 'unrecognized fresh fixture directory');
  guardExisting(value, true);
  return value;
}
function insideRun(runRoot, value) {
  assert.equal(below(value, runRoot), true, 'fixture escaped its fresh directory');
  return value;
}
function immutableFile(runRoot, file, bytes) {
  insideRun(runRoot, file);
  guardExisting(path.dirname(file), true);
  const fd = fs.openSync(file, 'wx+', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(count > 0, 'fixture write must advance'); offset += count;
    }
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd);
    assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1); assert.equal(stat.size, bytes.length);
    const actual = Buffer.alloc(bytes.length);
    let read = 0;
    while (read < actual.length) {
      const count = fs.readSync(fd, actual, read, actual.length - read, read);
      assert.ok(count > 0, 'fixture readback must advance'); read += count;
    }
    assert.equal(actual.equals(bytes), true, 'fixture bytes must read back exactly');
    const named = guardExisting(file, false);
    assert.equal(named.dev, stat.dev); assert.equal(named.ino, stat.ino);
  } finally { fs.closeSync(fd); }
}
function jsonFile(runRoot, file, value) {
  immutableFile(runRoot, file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}
function newStore(runRoot, label) {
  assert.equal(LABEL.test(label), true);
  checkedRun(runRoot);
  return createProcessCustodyStore({ fs, directory: insideRun(runRoot, path.join(runRoot, label)), randomId, now: Date.now });
}
function sourceHashes() {
  return SOURCES.map(relative => {
    const file = path.resolve(__dirname, relative);
    assert.equal(below(file, 'C:\\src'), true, 'maintained fixture source must remain under C:\\src');
    guardExisting(file, false);
    return { file: file.slice('C:\\src\\'.length).replace(/\\/g, '/'), sha256: hash(fs.readFileSync(file)) };
  });
}
function readFixture(runRoot) {
  checkedRun(runRoot);
  const file = insideRun(runRoot, path.join(runRoot, 'fixture.json'));
  const stat = guardExisting(file, false);
  assert.ok(stat.size > 0 && stat.size < 32768, 'fixture manifest must be bounded');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(value.schema, FIXTURE_SCHEMA);
  assert.equal(samePath(value.runRoot, runRoot), true);
  assert.match(value.fixtureId, /^[a-f0-9]{32}$/);
  assert.deepEqual(sourceHashes(), value.sources, 'child must use the exact reviewed source bytes');
  return value;
}
function parseArguments(argv) {
  if (argv.length === 2 && argv[0] === '--root') return { root: argv[1] };
  if (argv.length === 6 && argv[0] === '--fixture-child' && argv[2] === '--run-root' && argv[4] === '--store') {
    assert.equal(ACTIONS.has(argv[1]), true, 'unknown fixture child action');
    assert.equal(LABEL.test(argv[5]), true, 'unknown fixture store');
    return { action: argv[1], runRoot: argv[3], label: argv[5] };
  }
  throw new Error('Opt-in required: node tools/process-custody-filesystem-smoke.js --root <existing approved recovery child>');
}
function childMain(options) {
  const fixture = readFixture(options.runRoot);
  const store = newStore(options.runRoot, options.label);
  let value;
  if (options.action === 'noop') value = { closedNormally: true };
  else if (options.action === 'leave-pending') {
    const token = store.begin('fixture-interruption');
    assert.equal(store.inspect().pendingCount, 1);
    value = { leftPending: true, id: token.id };
    // Normal fixture-process exit models interruption after the durable marker
    // and before any completion acknowledgement; it cannot complete the token.
  } else {
    const before = store.inspect();
    if (options.action === 'inspect-blocked') {
      assert.equal(before.blocked, true, 'fresh process must retain unresolved evidence');
      let dispatched = false;
      assert.throws(() => { store.begin('forbidden-fixture'); dispatched = true; });
      assert.equal(dispatched, false, 'fresh blocked store cannot acknowledge a dispatch token');
      value = { inspection: before, beginRejected: true, dispatched: false };
    } else {
      assert.equal(before.complete, true); assert.equal(before.blocked, false);
      value = { inspection: before };
    }
  }
  process.stdout.write(JSON.stringify({ schema: FIXTURE_SCHEMA, fixtureId: fixture.fixtureId,
    action: options.action, label: options.label, value }) + '\n');
}
function inventory(runRoot) {
  const stack = [{ file: runRoot, depth: 0 }];
  const result = [];
  while (stack.length) {
    const item = stack.pop();
    assert.ok(item.depth <= 3, 'fixture inventory depth exceeded');
    guardExisting(item.file, true);
    for (const name of fs.readdirSync(item.file).sort()) {
      const file = insideRun(runRoot, path.join(item.file, name));
      const stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) stack.push({ file, depth: item.depth + 1 });
      else {
        guardExisting(file, false);
        assert.ok(stat.size <= 32768, 'fixture file exceeds inventory bound');
        result.push({ file: path.relative(runRoot, file).replace(/\\/g, '/'), bytes: stat.size,
          sha256: hash(fs.readFileSync(file)), dev: stat.dev, ino: stat.ino, nlink: stat.nlink });
        assert.ok(result.length <= 128, 'fixture inventory exceeded its bound');
      }
    }
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}
async function main(options) {
  const root = checkedRoot(options.root);
  const beganAt = new Date().toISOString();
  const stamp = beganAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runRoot = insideRun(root, path.join(root, 'process-custody-fs-' + stamp + '-' + randomId()));
  guardExisting(root, true);
  fs.mkdirSync(runRoot, { recursive: false, mode: 0o700 });
  checkedRun(runRoot);
  const fixture = { schema: FIXTURE_SCHEMA, fixtureId: randomId(), createdAtUtc: beganAt, runRoot,
    sources: sourceHashes() };
  jsonFile(runRoot, path.join(runRoot, 'fixture.json'), fixture);
  const results = [], children = [];

  async function runChild(action, label, config = {}) {
    assert.equal(unresolvedChild, false, 'an uncertain child prevents further fixture dispatch');
    checkedRun(runRoot);
    assert.equal(ACTIONS.has(action), true); assert.equal(LABEL.test(label), true);
    const args = [__filename, '--fixture-child', action, '--run-root', runRoot, '--store', label];
    const owned = new Set();
    const cwd = config.refuse ? insideRun(runRoot, path.join(runRoot, 'missing-child-cwd')) : runRoot;
    if (config.refuse) {
      assert.throws(() => fs.lstatSync(cwd), error => error.code === 'ENOENT');
      guardExisting(runRoot, true);
    } else guardExisting(cwd, true);
    const runner = createBoundedProcessRunner({
      activeChildren: owned,
      onUncertain: () => { unresolvedChild = true; },
      spawn(executable, actualArgs, spawnOptions) {
        assert.equal(executable, process.execPath); assert.deepEqual(actualArgs, args);
        if (config.beforeSpawn) config.beforeSpawn();
        // A minimal child environment excludes NODE_OPTIONS, NODE_PATH and
        // coverage/preload hooks. No shell, PATH executable lookup or detach.
        const env = { TEMP: runRoot, TMP: runRoot };
        for (const key of ['SystemRoot', 'WINDIR', 'COMPUTERNAME']) {
          if (typeof process.env[key] === 'string') env[key] = process.env[key];
        }
        return spawn(process.execPath, args, { ...spawnOptions, shell: false, detached: false, cwd, env });
      }
    });
    const outcome = await runner(process.execPath, args, () => {}, {
      timeoutMs: 5000, terminationGraceMs: 1000, exitCloseGraceMs: 1000, maxOutputBytes: 32768
    });
    children.push({ action, label, outcome: outcome.outcome, code: outcome.code, timedOut: outcome.timedOut,
      cleanupConfirmed: outcome.cleanupConfirmed, rootExitConfirmed: outcome.rootExitConfirmed, remainingOwnedHandles: owned.size });
    assert.equal(outcome.cleanupConfirmed, true, 'fixture child must be proved closed/refused');
    assert.equal(outcome.timedOut, false); assert.equal(owned.size, 0);
    if (config.refuse) {
      assert.equal(outcome.outcome, 'spawn-error'); assert.equal(outcome.rootExitConfirmed, false);
      return { outcome };
    }
    assert.equal(outcome.code, 0, 'fixture child failed: ' + outcome.stderr.slice(0, 200));
    assert.equal(outcome.outcome, 'exited'); assert.equal(outcome.rootExitConfirmed, true);
    const frame = JSON.parse(outcome.stdout.trim());
    assert.equal(frame.schema, FIXTURE_SCHEMA); assert.equal(frame.fixtureId, fixture.fixtureId);
    assert.equal(frame.action, action); assert.equal(frame.label, label);
    return { outcome, value: frame.value };
  }
  async function test(name, action) {
    const startedAtUtc = new Date().toISOString();
    try {
      await action(); results.push({ name, status: 'PASS', startedAtUtc, finishedAtUtc: new Date().toISOString() });
    } catch (error) {
      results.push({ name, status: 'FAIL', startedAtUtc, finishedAtUtc: new Date().toISOString(),
        reason: String(error && error.message || 'fixture-failed').slice(0, 400) });
    }
  }

  await test('durable pending exists before actual fixture spawn; observed child close permits completion', async () => {
    const store = newStore(runRoot, 'closed');
    const token = store.begin('fixture-command');
    let markerObserved = false;
    const child = await runChild('noop', 'closed', { beforeSpawn() {
      const pending = path.join(runRoot, 'closed', token.id + '.pending.json');
      guardExisting(pending, false);
      const value = JSON.parse(fs.readFileSync(pending, 'utf8'));
      assert.equal(value.id, token.id); assert.equal(value.type, 'pending');
      assert.equal(store.inspect().pendingCount, 1); markerObserved = true;
    } });
    assert.equal(markerObserved, true);
    store.complete(token, child.outcome);
    const readback = await runChild('inspect-clear', 'closed');
    assert.equal(readback.value.inspection.completedCount, 1);
  });
  await test('fixed Node startup refusal permits only spawn-error completion', async () => {
    const store = newStore(runRoot, 'refused'); const token = store.begin('fixture-refused');
    const child = await runChild('noop', 'refused', { refuse: true });
    store.complete(token, child.outcome);
    assert.equal((await runChild('inspect-clear', 'refused')).value.inspection.completedCount, 1);
  });
  await test('exited fixture leaves pending; another actual Node instance rejects new dispatch', async () => {
    const interrupted = await runChild('leave-pending', 'interrupted');
    assert.equal(interrupted.value.leftPending, true);
    const before = inventory(runRoot).filter(file => file.file.startsWith('interrupted/'));
    const readback = await runChild('inspect-blocked', 'interrupted');
    assert.equal(readback.value.inspection.pendingCount, 1); assert.equal(readback.value.beginRejected, true);
    assert.deepEqual(inventory(runRoot).filter(file => file.file.startsWith('interrupted/')), before);
  });
  await test('retained ownership survives new process and cannot be completed later', async () => {
    const store = newStore(runRoot, 'retained'); const token = store.begin('fixture-retained');
    store.retain(token, 'fixture-unknown');
    assert.throws(() => store.complete(token, { cleanupConfirmed: true, rootExitConfirmed: true, outcome: 'exited', timedOut: false }));
    const readback = await runChild('inspect-blocked', 'retained');
    assert.equal(readback.value.inspection.retainedCount, 1);
  });
  await test('unknown actual file is never interpreted as an empty store', async () => {
    const directory = insideRun(runRoot, path.join(runRoot, 'unknown'));
    guardExisting(runRoot, true); fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    immutableFile(runRoot, path.join(directory, 'unexpected.tmp'), Buffer.from('unfinished fixture\n'));
    const readback = await runChild('inspect-blocked', 'unknown');
    assert.equal(readback.value.inspection.complete, false);
  });
  await test('partial actual pending record remains blocked through fresh-process readback', async () => {
    const directory = insideRun(runRoot, path.join(runRoot, 'partial'));
    guardExisting(runRoot, true); fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    immutableFile(runRoot, path.join(directory, randomId() + '.pending.json'), Buffer.from('{"schema":'));
    const before = inventory(runRoot).filter(file => file.file.startsWith('partial/'));
    const readback = await runChild('inspect-blocked', 'partial');
    assert.equal(readback.value.inspection.complete, false);
    assert.deepEqual(inventory(runRoot).filter(file => file.file.startsWith('partial/')), before);
  });

  await test('maintained source hashes remain unchanged throughout the receipt', async () => {
    assert.deepEqual(sourceHashes(), fixture.sources, 'maintained source changed during the receipt');
  });
  const device = typeof process.env.COMPUTERNAME === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(process.env.COMPUTERNAME)
    ? process.env.COMPUTERNAME : 'unreported';
  const receipt = { schema: RECEIPT_SCHEMA, createdAtUtc: beganAt, completedAtUtc: new Date().toISOString(),
    platform: process.platform, node: process.version,
    device: { value: device, source: 'COMPUTERNAME environment; verified device identity belongs to parent command receipt' },
    verificationLayer: 'real Windows filesystem marker/readback and bounded synthetic Node lifecycle; no native repair or power-loss acceptance',
    filesystemType: 'not queried; file dev/ino/nlink are recorded; parent must attest NTFS independently',
    preservedRunRoot: runRoot, fixtureId: fixture.fixtureId, sources: fixture.sources,
    results, children, unresolvedChild, files: inventory(runRoot),
    passed: results.filter(result => result.status === 'PASS').length,
    failed: results.filter(result => result.status === 'FAIL').length, deleted: false, nativeRepairRun: false };
  const receiptFile = insideRun(runRoot, path.join(runRoot, 'receipt.json'));
  jsonFile(runRoot, receiptFile, receipt);
  process.stdout.write(JSON.stringify({ schema: RECEIPT_SCHEMA, receiptFile, sha256: hash(fs.readFileSync(receiptFile)),
    passed: receipt.passed, failed: receipt.failed, unresolvedChild, deleted: false }) + '\n');
  if (receipt.failed || unresolvedChild) process.exitCode = 1;
  finished = true;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.action) { childMain(options); finished = true; }
  else main(options).catch(error => {
    console.error('FAIL process-custody-filesystem: ' + String(error.message).slice(0, 400)); process.exitCode = 1; finished = true;
  });
} catch (error) {
  console.error('FAIL process-custody-filesystem: ' + String(error.message).slice(0, 400)); process.exitCode = 1; finished = true;
}
