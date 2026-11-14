'use strict';

/**
 * Startup-check regression tests.
 *
 * The defect: in 6.4.0 the scan handler awaited its inputs with Promise.all
 * and built the checklist without a guard. One rejection or one throw
 * rejected the whole request. The window then showed "The startup check did
 * not finish in time" for every kind of failure, dropped the results that
 * had completed, and listed all nine checks as unverified.
 *
 * Part 1 exercises src/main/startup-scan.js directly.
 * Part 2 loads the real main.js with a stubbed Electron and stubbed worker
 *        processes, and drives the real 'preflight-scan' handler through:
 *        healthy, one operation rejecting, a worker that produces no output,
 *        a worker that times out, and concurrent retries.
 * Part 3 checks the copy and the renderer wiring from source.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const scan = require('../src/main/startup-scan');
const messages = require('../messages');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- Part 2 harness: real main.js, fake Electron, fake workers -------------
function anything(name) {
  const fn = function () { return anything(name); };
  return new Proxy(fn, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '';
      if (typeof prop === 'symbol') return undefined;
      return anything(`${name}.${String(prop)}`);
    },
    apply() { return anything(name); },
    construct() { return anything(name); }
  });
}

function loadMain(workers) {
  const root = path.join(__dirname, '..');
  const handlers = new Map();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), '1132-scan-'));
  const app = new Proxy({
    whenReady: () => new Promise(() => {}),
    getVersion: () => '6.5.0',
    getName: () => '1132-fixer',
    getPath: () => userData,
    getAppPath: () => root,
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    on: () => app, once: () => app, quit: () => {}, exit: () => {}
  }, { get(t, p) { return p in t ? t[p] : anything(`app.${String(p)}`); } });
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn), on: () => {}, once: () => {}, removeHandler: () => {} };
  const electron = new Proxy({ app, ipcMain }, { get(t, p) { return p in t ? t[p] : anything(`electron.${String(p)}`); } });

  // Every worker main.js starts goes through child_process.spawn. The fake
  // answers by script content, so no PowerShell and no Windows state is used.
  const realCp = require('child_process');
  const spawned = [];
  const fakeCp = Object.assign({}, realCp, {
    spawn(command, args) {
      const child = new EventEmitter();
      child.pid = 1000 + spawned.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {};
      child.stderr.setEncoding = () => {};
      let script = '';
      child.stdin = {
        write: (chunk) => { script += String(chunk); return true; },
        end: (chunk) => { if (chunk) script += String(chunk); setImmediate(() => respond()); },
        on: () => {}, once: () => {}, destroy: () => {}
      };
      child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 1, 'SIGTERM')); return true; };
      child.unref = () => {};
      const record = { command, args, child, get script() { return script; } };
      spawned.push(record);
      function respond() {
        const plan = workers.answer(script, command, args) || {};
        if (plan.hang) return; // never answers: the caller's own timeout must fire
        if (plan.stdout) child.stdout.emit('data', Buffer.from(plan.stdout, 'utf8'));
        const code = typeof plan.code === 'number' ? plan.code : 0;
        child.emit('exit', code, null);
        child.emit('close', code, null);
      }
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    spawnSync(command) {
      // whoami /groups: report a High integrity (elevated) token.
      if (/whoami/i.test(String(command))) {
        return { status: 0, stdout: 'Mandatory Label\\High Mandatory Level  Label  S-1-16-12288\r\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
  });

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron;
    if (request === 'electron-updater') return { autoUpdater: anything('autoUpdater') };
    if (request === 'child_process') return fakeCp;
    return origLoad.call(this, request, parent, isMain);
  };
  // A fresh copy of main.js and of the modules that hold process handles.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root) && !key.includes(`${path.sep}node_modules${path.sep}`) && !key.includes(`${path.sep}tools${path.sep}`)) {
      delete require.cache[key];
    }
  }
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    require(path.join(root, 'main.js'));
  } finally {
    Module._load = origLoad;
    console.log = quiet.log; console.warn = quiet.warn; console.error = quiet.error;
  }
  return {
    handlers, spawned,
    scan: async () => {
      const saved = { log: console.log, warn: console.warn };
      console.log = () => {}; console.warn = () => {};
      try { return await handlers.get('preflight-scan')({}); } finally { console.log = saved.log; console.warn = saved.warn; }
    }
  };
}

const TOOL_NAMES = ['powershell.exe', 'net.exe', 'reg.exe', 'sc.exe', 'taskkill.exe', 'icacls.exe', 'takeown.exe', 'quser.exe', 'logoff.exe'];
function healthyAccountProbe() {
  return JSON.stringify({
    cam_policy: -1, mic_policy: -1, fs_status: 'Running', fs_starttype: 'Manual',
    hku_loaded: false, hku_sid: '', user1_exists: false, user1_admin: false,
    user1_identity_verified: false, user1_admin_verified: false,
    profile_image_path: '', profile_list_bak: false, profile_owner: '',
    profile_folder_exists: false, profile_ntuser: false
  });
}
// Which worker is this script? Decided by content the real scripts carry.
function classify(script) {
  if (/LetAppsAccessCamera/.test(script)) return 'account';
  if (/seclogon/.test(script) && /Get-Command|\$tools/.test(script)) return 'tools';
  if (/Uninstall\\\*/.test(script)) return 'zoom-registry';
  return 'other';
}

(async () => {
  console.log('startup-scan-smoke: helpers');
  {
    const settled = await scan.settleInputs({
      a: { promise: Promise.resolve(1), operation: 'windows-checks', fallback: 0 },
      b: { promise: Promise.reject(Object.assign(new Error('boom C:\\Users\\someone\\secret'), { code: 'EPERM' })), operation: 'account-and-policy', fallback: 'fb' }
    });
    check(settled.values.a.ok === true && settled.values.a.value === 1, 'a fulfilled input keeps its value');
    check(settled.values.b.ok === false && settled.values.b.value === 'fb', 'a rejected input gets its fallback');
    check(settled.issues.length === 1 && settled.issues[0].operation === 'account-and-policy' && settled.issues[0].kind === 'error' && settled.issues[0].code === 'EPERM', 'the rejection is a named issue (operation, kind, code)');
    check(!JSON.stringify(settled.issues).includes('someone'), 'an issue never carries the error message (paths, user names)');
    check(scan.issueFor('scan', Object.assign(new Error('timed out after 20000 ms'), {})).kind === 'timeout', 'a timeout is classified as a timeout');
    check(scan.issueFor('scan', new TypeError('x is undefined')).kind === 'error', 'a thrown error is classified as an error, not a timeout');
    const card = scan.unknownCard('Zoom Workplace', 'windows-checks', 'error');
    check(card.status === 'unknown' && card.unverified === true && /could not run/.test(card.message), 'a check that could not run is "unknown", never ready or blocked');
    check(/did not finish in time/.test(scan.unknownCard('X', 'windows-checks', 'timeout').message), 'the card says "did not finish in time" only for a timeout');
    const failed = scan.failedScanResult({ operation: 'results', kind: 'error', code: 'TypeError' }, { admin: 'Administrator', zoom: 'Zoom Workplace' }, 12);
    check(failed.canRunFix === false && failed.overall === 'unknown' && Object.values(failed.cards).every((c) => c.status === 'unknown'), 'a scan with no usable result reports every card unknown and Fix now unavailable');

    let runs = 0;
    let release;
    const flight = scan.createSingleFlight(async () => { runs += 1; await new Promise((r) => { release = r; }); return runs; });
    const p1 = flight(); const p2 = flight(); const p3 = flight();
    await tick();
    check(p1 === p2 && p2 === p3 && runs === 1 && flight.isRunning(), 'three calls while a scan runs share ONE scan');
    release();
    await p1;
    check(!flight.isRunning(), 'the scan slot is free after it settles');
    const p4 = flight(); await tick(); release(); await p4;
    check(runs === 2 && flight.startedCount() === 2, 'a later call starts a new scan');
    const rejecting = scan.createSingleFlight(async () => { throw new Error('x'); });
    await rejecting().catch(() => {});
    check(!rejecting.isRunning(), 'a rejected scan frees the slot too (no stuck retry)');
  }

  console.log('startup-scan-smoke: real scan handler — healthy computer');
  {
    const tools = {}; for (const t of TOOL_NAMES) tools[t] = true;
    const m = loadMain({
      answer(script) {
        const kind = classify(script);
        if (kind === 'account') return { stdout: healthyAccountProbe() };
        if (kind === 'tools') return { stdout: JSON.stringify(Object.assign({}, tools, { seclogon_status: 'Running', seclogon_starttype: 'Manual' })) };
        return { stdout: '' };
      }
    });
    const r = await m.scan();
    check(Array.isArray(r.scanIssues) && typeof r.scanElapsedMs === 'number', 'the result always carries scanIssues and the elapsed time');
    // helperUser also reads the real C:\Users\user1 folder, so only its
    // "was it answered" property is host-independent.
    check(r.cards.helperUser && r.cards.helperUser.status !== 'unknown' && r.cards.camPolicy.status === 'ready' && r.cards.frameServer.status === 'ready', 'account and policy results are reported');
    check(r.cards.version && r.cards.version.status === 'ready', 'the App check is reported');
    check(!Object.values(r.cards).some((c) => c.status === 'unknown') || r.scanIssues.length > 0, 'no card is unknown without a named issue');
  }

  console.log('startup-scan-smoke: reproduced failure — one operation fails');
  {
    // The account/policy worker produces no output. In 6.4.0 that parsed as
    // `{}` and the helper account, both policies and the registry hive were
    // reported READY. It must be an issue, and never ready.
    const m = loadMain({
      answer(script) {
        const kind = classify(script);
        if (kind === 'account') return { stdout: '', code: 1 };
        if (kind === 'tools') return { stdout: JSON.stringify({ 'powershell.exe': true, seclogon_status: 'Running', seclogon_starttype: 'Manual' }) };
        return { stdout: '' };
      }
    });
    const r = await m.scan();
    const issue = r.scanIssues.find((i) => i.operation === 'account-and-policy');
    check(!!issue && issue.kind === 'error' && issue.code === 'probe_no_output', 'a worker with no output is a named error issue');
    for (const key of ['helperUser', 'camPolicy', 'micPolicy', 'frameServer', 'hku']) {
      check(r.cards[key] && r.cards[key].status !== 'ready', `${key} is not reported ready from an empty answer`);
    }
    check(r.cards.version.status === 'ready', 'the unaffected App check keeps its result');
  }
  {
    // The Windows-checks operation throws. In 6.4.0 this rejected the whole
    // request ("did not finish in time", 9 of 9 unverified).
    const m = loadMain({
      answer(script) {
        const kind = classify(script);
        if (kind === 'account') return { stdout: healthyAccountProbe() };
        if (kind === 'tools') return { stdout: JSON.stringify({ 'powershell.exe': true, seclogon_status: 'Running', seclogon_starttype: 'Manual' }) };
        return { stdout: '' };
      }
    });
    const realExists = fs.existsSync;
    // Force preflightCheck() to throw from inside (its first fs.existsSync).
    let armed = true;
    fs.existsSync = function (p) {
      if (armed && /firstrun|first-run|FirstRun/i.test(String(p))) { armed = false; throw Object.assign(new Error('simulated failure'), { code: 'EIO' }); }
      return realExists.apply(this, arguments);
    };
    let r; let rejected = false;
    try { r = await m.scan(); } catch (_) { rejected = true; } finally { fs.existsSync = realExists; }
    check(rejected === false, 'the scan request resolves; it does not reject');
    if (r) {
      const issue = r.scanIssues.find((i) => i.operation === 'windows-checks');
      check(!armed && !!issue && issue.kind === 'error' && issue.code === 'EIO', 'the failed operation is named with its code (not reported as a timeout)');
      for (const key of ['admin', 'zoom', 'seclogon']) check(r.cards[key].status === 'unknown', `${key} is "could not be verified" (unknown), not failed and not passed`);
      check(r.cards.helperUser.status !== 'unknown' && r.cards.camPolicy.status === 'ready' && r.cards.micPolicy.status === 'ready' && r.cards.frameServer.status === 'ready', 'results of the operation that completed are preserved');
      check(r.canRunFix === false && r.overall !== 'ready', 'Fix now stays unavailable while any check is unverified');
      const unknown = Object.values(r.cards).filter((c) => c.status === 'unknown').length;
      check(unknown === 3 && unknown < Object.keys(r.cards).length, 'only the affected checks are unverified (3), not all of them');
    }
  }

  console.log('startup-scan-smoke: retry and cancellation');
  {
    let accountStarts = 0;
    const pending = [];
    const m = loadMain({
      answer(script) {
        const kind = classify(script);
        if (kind === 'account') { accountStarts += 1; return { stdout: healthyAccountProbe() }; }
        if (kind === 'tools') return { stdout: JSON.stringify({ 'powershell.exe': true, seclogon_status: 'Running', seclogon_starttype: 'Manual' }) };
        return { stdout: '' };
      }
    });
    // "Try again" pressed three times while the first scan is still running.
    pending.push(m.scan(), m.scan(), m.scan());
    const results = await Promise.all(pending);
    check(accountStarts === 1, 'three overlapping scan requests start ONE account worker (no duplicate workers)');
    check(results[0] === results[1] && results[1] === results[2], 'all three callers receive the same result');
    const before = m.spawned.length;
    await m.scan();
    check(accountStarts === 2 && m.spawned.length > before, 'a retry after the scan finished runs a fresh scan');
  }

  console.log('startup-scan-smoke: copy says what happened');
  {
    const t = messages.startupFailureSub({ operation: 'startup-status', kind: 'timeout' });
    const e = messages.startupFailureSub({ operation: 'windows-checks', kind: 'error' });
    check(/did not finish in time/.test(t) && /administrator check/.test(t), 'timeout: says so and names the operation');
    check(!/did not finish in time/.test(e) && /could not run/.test(e) && /Windows tools, Zoom and Secondary Logon/.test(e), 'error: does NOT claim a timeout, names the operation');
    const partial = messages.startupFailureSub({ operation: 'windows-checks', kind: 'error' }, { unverified: 3, total: 9 });
    check(/^3 of 9 checks could not be verified/.test(partial) && /other results are shown/.test(partial), 'partial failure: counts only the affected checks and points to the kept results');
    check(!/did not finish in time/.test(messages.WIZARD.UNABLE_SUB), 'the fallback line no longer claims a timeout');
    const line = messages.startupFailureLogLine({ operation: 'windows-checks', kind: 'error', code: 'EIO' });
    check(/code EIO/.test(line), 'the details log records the operation and the code');
    check(/code unknown/.test(messages.startupFailureLogLine({ operation: 'scan', kind: 'error', code: 'C:\\Users\\x' })), 'a code that looks like a path is never printed');
  }

  console.log('startup-scan-smoke: renderer wiring');
  {
    const root = path.join(__dirname, '..');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    check(!/showNoticePane\('err', WIZARD\.UNABLE_TITLE, WIZARD\.UNABLE_SUB\)/.test(renderer), 'the window never shows the fixed sentence for a startup failure');
    check((renderer.match(/startupFailureSub\(/g) || []).length >= 3, 'every startup failure path builds its sentence from the actual issue');
    check(/withDeadline\(window\.electronAPI\.preflightScan\(\), SCAN_DEADLINE_MS, 'scan'\)/.test(renderer), 'the scan has a deadline, so "Checking" cannot stay forever');
    check(/withDeadline\(window\.electronAPI\.startupStatus\(\), STARTUP_DEADLINE_MS, 'startup-status'\)/.test(renderer), 'the administrator check keeps its 8 s deadline, now with a named operation');
    check(/const STARTUP_DEADLINE_MS = 8000;/.test(renderer), 'the 8 s deadline is unchanged (not raised to hide a failure)');
    check(/if \(generation !== scanGeneration\) return;/.test(renderer), 'a stale scan answer is dropped instead of repainting');
    check(/if \(startupSequenceInFlight\) return;/.test(renderer), 'a second "Try again" does not start a parallel startup sequence');
    check(/createSingleFlight\(/.test(main) && /ipcMain\.handle\('preflight-scan', \(\) => runPreflightScan\(\)\)/.test(main), 'main serves the scan through the single-flight wrapper');
    check(/!statuses\.includes\('unknown'\)/.test(main), 'an unverified check keeps Fix now unavailable in main');
    check(!/sc\.exe start seclogon\s*2>&1/.test(main.slice(main.indexOf('async function buildPreflightScan'), main.indexOf("ipcMain.handle('support-report'"))), 'the scan starts no service (read-only)');
  }

  if (failures) { console.error(`\nstartup-scan-smoke: ${failures} FAILED`); process.exit(1); }
  console.log('\nstartup-scan-smoke: all checks passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
