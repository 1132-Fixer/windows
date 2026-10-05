'use strict';

// Drive the actual main-process functions with bounded, observable fake
// children. No Electron, Windows account or destructive command is started.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const windowsTools = require('../src/main/windows-tools');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function functionSource(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `production function ${name} exists`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `production function ${name} closes`);
  return source.slice(start, end + 2);
}
function wrapperSource(name) {
  const declaration = source.match(new RegExp(`const ${name} = [^\\n]+;`));
  assert.ok(declaration, `production wrapper ${name} exists`);
  return declaration[0];
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 11320;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.writes = [];
  child.kills = [];
  child.stdin.end = (data, encoding) => child.writes.push({ data, encoding });
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}

function harness(options = {}) {
  const child = fakeChild();
  const activeChildren = new Set();
  const timers = new Map();
  const cancelledTimers = [];
  const calls = [];
  const kills = [];
  const lines = [];
  let nextTimer = 1;
  let clock = 0;
  const startTimer = kind => (fn, ms) => {
    const id = nextTimer++;
    timers.set(id, { fn, ms, kind });
    return id;
  };
  const clearTimer = id => {
    cancelledTimers.push(id);
    timers.delete(id);
  };
  const context = {
    windowsTools: {
      ...windowsTools,
      resolveTool: name => windowsTools.resolveTool(name, {
        env: options.env || { SystemRoot: 'D:\\Windows', PATH: 'C:\\Fake tools' },
        arch: 'x64',
        existsSync: options.existsSync || (value => ['D:\\Windows', 'D:\\Windows\\System32'].includes(value))
      })
    },
    spawn: (exe, args, opts) => {
      calls.push({ exe, args: Array.from(args), opts });
      if (options.spawnError) throw options.spawnError;
      return child;
    },
    spawnSync: (exe, args, opts) => { kills.push({ exe, args: Array.from(args), opts }); return { status: 0 }; },
    activeChildren,
    setTimeout: startTimer('timeout'),
    clearTimeout: clearTimer,
    setInterval: startTimer('interval'),
    clearInterval: clearTimer,
    Date: { now: () => clock },
    StringDecoder,
    Buffer
  };
  vm.createContext(context);
  vm.runInContext([
    wrapperSource('spawnWindowsTool'),
    wrapperSource('spawnWindowsToolSync'),
    functionSource('runProcess'),
    functionSource('runPSScript')
  ].join('\n'), context, { filename: 'main.js:windows-process-smoke' });
  return {
    child, timers, cancelledTimers, calls, kills, lines, activeChildren,
    run: (name, args = [], opts = {}) => context.runProcess(name, args, (line, kind) => lines.push({ line, kind }), opts),
    script: (script, opts = {}) => context.runPSScript(script, (line, kind) => lines.push({ line, kind }), opts),
    fire: (kind, ms) => {
      const item = Array.from(timers.entries()).find(([, timer]) => timer.kind === kind && timer.ms === ms);
      assert.ok(item, `${kind} timer ${ms}ms exists`);
      clock += ms;
      if (kind === 'timeout') timers.delete(item[0]);
      item[1].fn();
    }
  };
}

let checks = 0;
let failures = 0;
function check(condition, name) {
  checks++;
  if (condition) console.log(`  ok  ${name}`);
  else { failures++; console.error(`FAIL  ${name}`); }
}

(async () => {
  console.log('windows-process-smoke: actual runner and transport');
  {
    const h = harness();
    const secret = "smoke-password-\u65e5\u672c\u8a9e-'-$`";
    const script = `$pw = '${secret.replace(/'/g, "''")}'; Write-Output 'READY'`;
    const pending = h.script(script, { timeoutMs: 40, heartbeatMs: 5 });
    const call = h.calls[0];
    check(call.exe === 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'production PowerShell wrapper chooses an absolute system executable');
    check(JSON.stringify(call.args) === JSON.stringify(windowsTools.PS_STDIN_ARGS) &&
      !JSON.stringify(call.args).includes(secret) && !call.args.includes('-File'),
      'production caller source and credential never enter argv or a temp-file argument');
    check(h.child.writes.length === 1 && h.child.writes[0].data === windowsTools.prepareScript(script) &&
      h.child.writes[0].encoding === 'utf8', 'production runner writes the complete UTF-8 script once and ends stdin');
    check(h.activeChildren.has(h.child), 'live child belongs to cancellation custody');
    h.child.stdout.emit('data', Buffer.from('READY\n', 'utf8'));
    h.child.stderr.emit('data', Buffer.from('diagnostic\n', 'utf8'));
    h.child.emit('close', 0);
    const result = await pending;
    check(result.code === 0 && result.stdout === 'READY\n' && result.stderr === 'diagnostic\n' && !result.timedOut,
      'normal close preserves stdout, stderr and success status');
    check(h.timers.size === 0 && h.activeChildren.size === 0 && h.cancelledTimers.length === 2,
      'normal close clears heartbeat, deadline and child custody once');
    const before = h.lines.length;
    h.child.emit('close', 1);
    h.child.emit('error', Object.assign(new Error('late failure'), { code: 'EACCES' }));
    h.child.stdout.emit('data', Buffer.from('late output'));
    check(h.lines.length === before && h.cancelledTimers.length === 2 && result.code === 0,
      'late close, error and output cannot alter a settled result or duplicate logs');
  }
  {
    const h = harness();
    const pending = h.script("Write-Output 'José — 日本語'", { timeoutMs: 40 });
    const bytes = Buffer.from('José — 日本語\n', 'utf8');
    // Split inside multibyte characters, not merely between complete lines.
    for (let offset = 0; offset < bytes.length; offset++) h.child.stdout.emit('data', bytes.subarray(offset, offset + 1));
    const errorBytes = Buffer.from('Échec — 日本語\n', 'utf8');
    for (let offset = 0; offset < errorBytes.length; offset++) h.child.stderr.emit('data', errorBytes.subarray(offset, offset + 1));
    h.child.emit('close', 0);
    const result = await pending;
    check(result.stdout === 'José — 日本語\n' && result.stderr === 'Échec — 日本語\n',
      'arbitrary stdout and stderr chunk boundaries preserve UTF-8 exactly');
  }
  {
    const h = harness();
    const pending = h.run('net.exe', ['user', 'user1'], { timeoutMs: 40 });
    check(h.calls[0].exe === 'D:\\Windows\\System32\\net.exe' && h.child.writes[0].data === undefined,
      'native runner resolves the real system tool and closes unused stdin');
    h.child.stdout.emit('data', Buffer.from('partial result\n'));
    h.child.emit('error', Object.assign(new Error('spawn blocked by policy'), { code: 'EACCES' }));
    const result = await pending;
    h.child.emit('close', 1);
    check(result.code === -1 && result.errorCode === 'EACCES' && result.stdout === 'partial result\n' &&
      result.stderr.includes('spawn blocked by policy'), 'spawn event error retains actionable details and prior output');
    check(h.timers.size === 0 && h.activeChildren.size === 0, 'spawn event failure clears all process resources');
  }
  {
    const h = harness({ spawnError: Object.assign(new Error('system executable missing'), { code: 'ENOENT' }) });
    const result = await h.run('reg.exe');
    check(result.code === -1 && result.errorCode === 'ENOENT' && result.stderr === 'system executable missing',
      'synchronous launch failure returns structured evidence');
    check(h.timers.size === 0 && h.activeChildren.size === 0 && h.child.writes.length === 0,
      'synchronous launch failure leaves no timer, child custody or stdin write');
  }
  {
    const h = harness({ env: { PATH: 'C:\\Fake tools' }, existsSync: () => false });
    const result = await h.script('Write-Output 1');
    check(result.code === -1 && result.errorCode === 'WINDOWS_SYSTEM_ROOT_UNAVAILABLE' && h.calls.length === 0,
      'missing Windows root returns a diagnostic without searching attacker-controlled PATH');
    const unsupported = harness();
    const denied = await unsupported.run('untrusted.exe');
    check(denied.code === -1 && denied.errorCode === 'WINDOWS_TOOL_NOT_ALLOWED' && unsupported.calls.length === 0,
      'unregistered native executables cannot cross the production spawn boundary');
  }
  {
    const h = harness();
    const pending = h.script('Write-Output 1', { timeoutMs: 40, heartbeatMs: 5 });
    h.fire('timeout', 40);
    const result = await pending;
    check(result.code === -1 && result.errorCode === 'ETIMEDOUT' && result.timedOut,
      'deadline settles without waiting for child close');
    check(h.kills.length === 1 && h.kills[0].exe === 'D:\\Windows\\System32\\taskkill.exe' &&
      JSON.stringify(h.kills[0].args) === JSON.stringify(['/PID', '11320', '/T', '/F']) && h.child.kills[0] === 'SIGKILL',
      'deadline uses trusted taskkill for the entire process tree and direct-child fallback');
    check(h.timers.size === 0 && h.activeChildren.size === 0,
      'deadline clears heartbeat, timer and cancellation custody');
    const before = h.lines.length;
    h.child.emit('close', 0);
    h.child.emit('error', new Error('late timeout error'));
    check(result.code === -1 && h.lines.length === before, 'late timeout events do not report a second outcome');
  }
  {
    const h = harness();
    const pending = h.script('Write-Output 1', { timeoutMs: 40 });
    h.child.stdin.emit('error', Object.assign(new Error('private source must not be logged'), { code: 'EPIPE' }));
    const result = await pending;
    check(result.code === -1 && result.errorCode === 'stdin_failed' && result.stderr === '' &&
      !h.lines.some(line => line.line.includes('private source')),
      'stdin failure returns a safe stage code without exposing private script text');
    check(h.child.kills.length === 1 && h.activeChildren.size === 0 && h.timers.size === 0,
      'stdin failure kills the child and clears process resources');
  }
  {
    const h = harness();
    const pending = h.run('taskkill.exe', ['/INVALID']);
    check(Array.from(h.timers.values()).some(timer => timer.kind === 'timeout' && timer.ms === 60000),
      'native commands have a default finite deadline');
    h.child.emit('close', 2);
    const result = await pending;
    check(result.code === 2 && !result.timedOut, 'native nonzero exit is preserved');
  }
  if (failures) throw new Error(`windows-process-smoke: ${failures} failures in ${checks} checks`);
  console.log(`windows-process-smoke: ${checks} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
