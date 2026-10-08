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

function fakeChild(options = {}) {
  const child = new EventEmitter();
  child.pid = 11320;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroyedByTest = false;
  child.stderr.destroyedByTest = false;
  child.stdout.destroy = () => { child.stdout.destroyedByTest = true; };
  child.stderr.destroy = () => { child.stderr.destroyedByTest = true; };
  child.stdin = new EventEmitter();
  child.writes = [];
  child.kills = [];
  child.stdin.end = (data, encoding) => child.writes.push({ data, encoding });
  child.kill = signal => {
    child.kills.push(signal);
    if (options.childKillThrows) throw options.childKillThrows;
    return Object.prototype.hasOwnProperty.call(options, 'childKillResult') ? options.childKillResult : true;
  };
  return child;
}

function harness(options = {}) {
  const child = fakeChild(options);
  const activeChildren = new Set();
  const unprovedChildTrees = new WeakSet();
  const timers = new Map();
  const cancelledTimers = [];
  const calls = [];
  const kills = [];
  const lines = [];
  let taskkillCall = 0;
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
        getReport: Object.prototype.hasOwnProperty.call(options, 'getReport') ? options.getReport :
          () => ({ sharedObjects: ['ntdll.dll', 'kernel32.dll', 'kernelbase.dll'].map(name => `D:\\Windows\\System32\\${name}`) })
      })
    },
    spawn: (exe, args, opts) => {
      calls.push({ exe, args: Array.from(args), opts });
      if (options.spawnError) throw options.spawnError;
      return child;
    },
    spawnSync: (exe, args, opts) => {
      kills.push({ exe, args: Array.from(args), opts });
      if (typeof options.onTaskkill === 'function') options.onTaskkill({ child, call: kills.length });
      if (options.taskkillThrows) throw options.taskkillThrows;
      if (Array.isArray(options.taskkillResults)) {
        const index = Math.min(taskkillCall++, Math.max(0, options.taskkillResults.length - 1));
        const next = options.taskkillResults[index];
        if (next instanceof Error) throw next;
        return next;
      }
      taskkillCall++;
      return options.taskkillResult || { status: 0 };
    },
    activeChildren,
    unprovedChildTrees,
    setTimeout: startTimer('timeout'),
    clearTimeout: clearTimer,
    setInterval: startTimer('interval'),
    clearInterval: clearTimer,
    Date: { now: () => clock },
    StringDecoder,
    Buffer,
    console: { warn: message => lines.push({ line: String(message), kind: 'warn' }) }
  };
  vm.createContext(context);
  vm.runInContext([
    wrapperSource('spawnWindowsTool'),
    wrapperSource('spawnWindowsToolSync'),
    wrapperSource('childTreeCustody'),
    functionSource('terminateChildTree'),
    functionSource('terminationEvidence'),
    functionSource('killActiveChildren'),
    functionSource('runProcess'),
    functionSource('runPSScript'),
    functionSource('normalizeLaunchExceptionClass'),
    functionSource('normalizeLaunchInteger'),
    functionSource('launchCaptureErrorMetadata'),
    functionSource('runPSScriptLaunchCapture')
  ].join('\n'), context, { filename: 'main.js:windows-process-smoke' });
  return {
    child, timers, cancelledTimers, calls, kills, lines, activeChildren, unprovedChildTrees,
    run: (name, args = [], opts = {}) => context.runProcess(name, args, (line, kind) => lines.push({ line, kind }), opts),
    script: (script, opts = {}) => context.runPSScript(script, (line, kind) => lines.push({ line, kind }), opts),
    launchCapture: script => context.runPSScriptLaunchCapture(script),
    killAll: () => context.killActiveChildren(),
    advance: ms => { clock += ms; },
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
    let replacementTargeted = false;
    const h = harness({ onTaskkill: () => { replacementTargeted = true; } });
    const pending = h.script('Write-Output 1', { timeoutMs: 30000 });
    const staleDeadline = Array.from(h.timers.values()).find(timer => timer.kind === 'timeout' && timer.ms === 30000);
    check(!!staleDeadline, 'shortcut runner exposes its bounded deadline to the fake clock');
    h.child.emit('close', 0);
    const result = await pending;
    // The same number now represents an unrelated process. Even an already
    // queued copy of the old callback must not use it after successful close.
    h.advance(30001);
    staleDeadline.fn();
    check(result.code === 0 && h.kills.length === 0 && !replacementTargeted,
      'successful close clears and fences the deadline before PID reuse');
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
    const h = harness({ env: { SystemRoot: 'C:\\Fake tools', PATH: 'C:\\Fake tools' }, getReport: null });
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
      'deadline settles after whole-tree termination is proved');
    check(h.kills.length === 1 && h.kills[0].exe === 'D:\\Windows\\System32\\taskkill.exe' &&
      JSON.stringify(h.kills[0].args) === JSON.stringify(['/PID', '11320', '/T', '/F']) && h.child.kills.length === 0,
      'deadline uses trusted taskkill for the entire process tree without killing the parent directly');
    check(h.timers.size === 0 && h.activeChildren.size === 0,
      'deadline clears heartbeat, timer and cancellation custody');
    const before = h.lines.length;
    h.child.emit('close', 0);
    h.child.emit('error', new Error('late timeout error'));
    check(result.code === -1 && h.lines.length === before, 'late timeout events do not report a second outcome');
  }
  {
    let replacementTargeted = false;
    const h = harness({
      taskkillResults: [{ status: 5 }, { status: 0 }],
      onTaskkill: ({ call }) => { if (call > 1) replacementTargeted = true; }
    });
    const pending = h.script('Write-Output 1', { timeoutMs: 40, heartbeatMs: 5 });
    let resolved = false;
    pending.then(() => { resolved = true; });
    h.fire('timeout', 40);
    h.child.emit('exit', 0);
    h.child.exitCode = 0;
    h.child.emit('close', 0);
    const stoppedAfterReuse = h.killAll();
    await Promise.resolve();
    check(!resolved && stoppedAfterReuse === false && h.kills.length === 1 && !replacementTargeted &&
      h.child.kills.length === 0,
      'failed tree kill, original exit and PID reuse never target the replacement process');
    check(h.activeChildren.has(h.child) && h.unprovedChildTrees.has(h.child),
      'unproved termination retains strong child custody and blocks completion');
  }
  {
    const h = harness({ taskkillResults: [{ status: 5 }] });
    const pending = h.script('Write-Output 1', { timeoutMs: 40, heartbeatMs: 5 });
    let resolved = false;
    pending.then(() => { resolved = true; });
    h.fire('timeout', 40);
    await Promise.resolve();
    check(!resolved && h.activeChildren.has(h.child) && h.unprovedChildTrees.has(h.child),
      'a failed tree kill cannot settle the timed-out child or release custody');
    check(h.kills.length === 1 && h.child.kills.length === 0 &&
      h.lines.some(item => /termination is unproved/.test(item.line)),
      'tree termination makes one attempt without destroying the identifiable parent');
    h.child.exitCode = 0;
    h.child.emit('close', 0);
    await Promise.resolve();
    check(!resolved && h.activeChildren.has(h.child),
      'a later direct-child close cannot hide an unproved surviving tree');
  }
  {
    const h = harness();
    const pending = h.run('net.exe', [], { timeoutMs: 40 });
    let resolved = false;
    pending.then(() => { resolved = true; });
    const queuedDeadline = Array.from(h.timers.values()).find(timer => timer.kind === 'timeout' && timer.ms === 40);
    h.advance(39);
    h.child.exitCode = 7;
    h.child.emit('exit', 7);
    check(!Array.from(h.timers.values()).some(timer => timer.ms === 40) &&
      Array.from(h.timers.values()).some(timer => timer.ms === 500),
    'exit at deadline-minus-one clears the main deadline and starts bounded close grace');
    queuedDeadline.fn();
    await Promise.resolve();
    check(!resolved && h.kills.length === 0 && h.child.kills.length === 0,
      'an already queued deadline cannot kill after owned-child exit');
    h.child.stdout.emit('data', Buffer.from('tail output\n'));
    h.fire('timeout', 500);
    const result = await pending;
    h.child.emit('close', 7);
    check(result.code === 7 && result.stdout === 'tail output\n' && result.timedOut === false &&
      h.activeChildren.size === 0,
    'delayed close cannot deadlock custody or overwrite the completed exit outcome');
    check(h.kills.length === 0 && h.child.kills.length === 0,
      'a benign surviving descendant may hold inherited pipes through close grace without any PID kill');
  }
  {
    const h = harness();
    const pending = h.run('net.exe', [], { timeoutMs: 40 });
    const queuedDeadline = Array.from(h.timers.values()).find(timer => timer.kind === 'timeout' && timer.ms === 40);
    h.advance(39);
    h.child.exitCode = 0;
    h.child.emit('exit', 0);
    h.child.stdin.emit('error', Object.assign(new Error('private source must not be logged'), { code: 'EPIPE' }));
    queuedDeadline.fn();
    await Promise.resolve();
    check(h.kills.length === 0 && h.child.kills.length === 0 &&
      h.activeChildren.has(h.child) && !h.unprovedChildTrees.has(h.child) &&
      Array.from(h.timers.values()).some(timer => timer.kind === 'timeout' && timer.ms === 500) &&
      !h.lines.some(item => item.line.includes('private source')),
    'post-exit stdin failure leaves the bounded close grace in control without killing a reused PID');
    h.child.stdout.emit('data', Buffer.from('tail output\n'));
    h.fire('timeout', 500);
    const result = await pending;
    const settledLineCount = h.lines.length;
    const settledCancellationCount = h.cancelledTimers.length;
    h.child.emit('close', 0);
    await Promise.resolve();
    check(result.code === -1 && result.errorCode === 'stdin_failed' && result.stdout === 'tail output\n' &&
      result.timedOut === false &&
      h.kills.length === 0 && h.child.kills.length === 0 && h.activeChildren.size === 0 &&
      !h.unprovedChildTrees.has(h.child) && h.timers.size === 0,
    'post-exit stdin failure settles once through close grace and clears all custody');
    check(h.lines.length === settledLineCount && h.cancelledTimers.length === settledCancellationCount,
      'late close after post-exit stdin failure is a no-op');
  }
  {
    const h = harness({ taskkillResults: [{ status: 1 }] });
    const pending = h.run('net.exe', [], { timeoutMs: 0 });
    let resolved = false;
    pending.then(() => { resolved = true; });
    const stopped = h.killAll();
    h.child.exitCode = 0;
    h.child.emit('close', 0);
    await Promise.resolve();
    const stoppedAgain = h.killAll();
    check(stopped === false && stoppedAgain === false && !resolved && h.kills.length === 1 && h.child.kills.length === 0 &&
      h.activeChildren.has(h.child) && h.unprovedChildTrees.has(h.child),
      'fatal cleanup retains custody and never retries an unproved PID');
  }
  {
    const h = harness();
    const pending = h.script('Write-Output 1', { timeoutMs: 40 });
    h.child.stdin.emit('error', Object.assign(new Error('private source must not be logged'), { code: 'EPIPE' }));
    const result = await pending;
    check(result.code === -1 && result.errorCode === 'stdin_failed' && result.stderr === '' &&
      !h.lines.some(line => line.line.includes('private source')),
      'stdin failure returns a safe stage code without exposing private script text');
    check(h.child.kills.length === 0 && h.kills.length === 1 && h.activeChildren.size === 0 && h.timers.size === 0,
      'stdin failure clears process resources only after trusted whole-tree termination');
  }
  {
    const privateDetail = 'PRIVATE PRE-LAUNCH DETAIL';
    const privateScript = "Write-Output 'PRIVATE CREDENTIAL SENTINEL'";
    const launchError = Object.assign(new Error(privateDetail), {
      name: 'System.ComponentModel.Win32Exception', code: 'EACCES', errno: -13
    });
    const h = harness({ spawnError: launchError });
    const result = await h.launchCapture(privateScript);
    check(result.code === -1 && result.stdout === '' && result.timedOut === false &&
      result.errorCode === 'EACCES' && result.exceptionClass === 'System.ComponentModel.Win32Exception' &&
      result.nativeCode === -13,
    'pre-launch spawn failure returns only the exception class and numeric native code');
    check(!JSON.stringify(result).includes(privateDetail) && !JSON.stringify(result).includes(privateScript) &&
      h.child.writes.length === 0,
    'pre-launch failure cannot expose the private message or credential-bearing script');
  }
  {
    const h = harness();
    const pending = h.launchCapture("Write-Output 'STARTED'");
    h.child.stdout.emit('data', Buffer.from('STARTED\n'));
    h.child.emit('exit', 7);
    check(!Array.from(h.timers.values()).some(timer => timer.ms === 30000) &&
      Array.from(h.timers.values()).some(timer => timer.ms === 500),
    'observed launch-process exit clears the main deadline before close grace');
    h.fire('timeout', 500);
    const result = await pending;
    check(result.code === 7 && result.stdout === 'STARTED\n' && result.timedOut === false && h.child.kills.length === 0,
      'inherited handles cannot overwrite a completed launch outcome at the old deadline');
  }
  {
    const h = harness();
    const pending = h.launchCapture("Write-Output 'STARTED'");
    const queuedDeadline = Array.from(h.timers.values()).find(timer => timer.ms === 30000);
    h.child.stdout.emit('data', Buffer.from('STARTED\n'));
    h.child.emit('exit', 0);
    h.child.stdin.emit('error', Object.assign(new Error('private source must not be logged'), { code: 'EPIPE' }));
    queuedDeadline.fn();
    await Promise.resolve();
    check(h.child.kills.length === 0 &&
      Array.from(h.timers.values()).some(timer => timer.kind === 'timeout' && timer.ms === 500),
    'late launch stdin failure cannot kill after observed exit or cancel close grace');
    h.fire('timeout', 500);
    const result = await pending;
    const settledResult = JSON.stringify(result);
    h.child.emit('close', 0);
    await Promise.resolve();
    check(result.code === 0 && result.errorCode === null && result.stdout === 'STARTED\n' &&
      result.timedOut === false && h.child.kills.length === 0 && h.timers.size === 0,
    'late launch stdin failure preserves the observed success and settles once');
    check(JSON.stringify(result) === settledResult && h.child.kills.length === 0 && h.timers.size === 0 &&
      !JSON.stringify(result).includes('private source'),
      'late close is a no-op and launch capture exposes no private stdin error text');
  }
  {
    const h = harness();
    const pending = h.launchCapture("Write-Output 'STARTED'");
    h.child.emit('error', Object.assign(new Error('private launch detail'), { code: 'EACCES' }));
    const result = await pending;
    check(result.code === -1 && result.errorCode === 'EACCES' &&
      !JSON.stringify(result).includes('private launch detail'),
    'launch capture preserves a non-secret process error code without its private message');
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
  {
    const handlerStart = source.indexOf("ipcMain.handle('run-fix'");
    const overlapGuard = source.indexOf('if (fixInProgress || activeChildren.size > 0)', handlerStart);
    const repairStart = source.indexOf('fixInProgress = true', handlerStart);
    check(handlerStart >= 0 && overlapGuard > handlerStart && overlapGuard < repairStart,
      'repair overlap is rejected before a new destructive run takes ownership');
    check(!source.includes('CHILD_TREE_KILL_ATTEMPTS') &&
      source.includes("result.taskkillError = 'retry-blocked'") &&
      source.includes('custody.treeKillAttempted = true'),
    'production custody permits one tree-kill attempt per ChildProcess identity');
    const shortcutStart = source.indexOf("ipcMain.handle('create-shortcut'");
    const shortcutEnd = source.indexOf('// "Open Zoom"', shortcutStart);
    const shortcutHandler = source.slice(shortcutStart, shortcutEnd);
    check(/await runPSScript\(ps,[\s\S]*timeoutMs:\s*30000/.test(shortcutHandler) &&
      !/setTimeout\(|spawnWindowsToolSync\(|child\.kill\(/.test(shortcutHandler),
    'shortcut creation uses the trusted runner with no private timer or bare-PID kill');
    check(!/\bfunction\s+userExists\s*\(/.test(source) && !/\bUSER_EXISTS_TIMEOUT_MS\b/.test(source),
      'the unreachable userExists raw-PID timeout helper is removed after the repository-wide call graph found no caller');
    const rawPidTreeKills = source.match(/spawnWindowsToolSync\('taskkill\.exe',\s*\['\/PID',\s*String\([^)]*\),\s*'\/T',\s*'\/F'\]/g) || [];
    check(rawPidTreeKills.length === 1 && functionSource('terminateChildTree').includes(rawPidTreeKills[0]),
      'all product raw-PID tree termination is confined to verified ChildProcess custody');
  }
  if (failures) throw new Error(`windows-process-smoke: ${failures} failures in ${checks} checks`);
  console.log(`windows-process-smoke: ${checks} checks passed`);
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
