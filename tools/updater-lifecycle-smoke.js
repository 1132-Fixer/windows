'use strict';

/**
 * Deterministic lifecycle tests for the updater controller
 * (src/main/updater.js), the handoff record, the retry policy, the
 * shutdown-reason controller and the sanitized updater log.
 *
 * Everything the controller touches is injected: a fake electron-updater
 * emitter, a temp userData directory with a real (random) installer file
 * so hashes are real, fake timers, a recording spawn, and a recording
 * requestShutdown. No Electron, no network, no UAC.
 *
 * Numbered cases follow the acceptance list of the September 2026 updater
 * repair: 1 no update … 25 settings intact.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const updater = require('../src/main/updater');
const { createUpdaterLog, createSanitizer } = require('../src/main/updater-log');
const shutdownMod = require('../src/main/shutdown');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

const CURRENT = '6.3.3';
const TARGET = '6.4.0';
const INSTALL_DIR = 'C:\\Program Files\\1132 Fixer\\1132 Fixer';
const EXEC = path.win32.join(INSTALL_DIR, '1132 Fixer.exe');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `1132-upd-${label}-`));
}

function makeInstaller(dir, name, bytes = 64 * 1024) {
  const pending = path.join(dir, 'updater-cache', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const file = path.join(pending, name);
  const buf = crypto.randomBytes(bytes);
  fs.writeFileSync(file, buf);
  return { file, sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length };
}

function infoFor(inst, version = TARGET, name) {
  return {
    version,
    files: [{ url: name || `1132-Fixer-Setup-${version}.exe`, sha512: inst.sha512, size: inst.size }],
    path: name || `1132-Fixer-Setup-${version}.exe`,
    sha512: inst.sha512,
    releaseDate: '2026-09-05T00:00:00.000Z',
    downloadedFile: inst.file
  };
}

function makeEnv(opts = {}) {
  const dir = opts.dir || tmpDir(opts.label || 'env');
  const au = new EventEmitter();
  au.checkForUpdates = async () => {
    if (typeof opts.onCheck === 'function') await opts.onCheck(au);
    return { updateInfo: null };
  };
  const statuses = [];
  const timers = [];
  let clock = opts.now || 1_800_000_000_000;
  const spawnCalls = [];
  const shutdowns = [];
  const log = createUpdaterLog({ file: path.join(dir, 'logs', 'updater.log'), sanitize: (s) => String(s) });
  const ctl = updater.createUpdaterController({
    autoUpdater: au,
    log,
    emit: (p) => statuses.push(p),
    currentVersion: opts.currentVersion || CURRENT,
    execPath: opts.execPath || EXEC,
    argv: opts.argv || ['1132 Fixer.exe'],
    arch: opts.arch || 'x64',
    platform: 'win32',
    userDataDir: dir,
    isPackaged: opts.isPackaged !== false,
    isPortable: !!opts.isPortable,
    isElevated: opts.isElevated || (async () => true),
    isBusy: opts.isBusy || (() => false),
    spawnInstaller: opts.spawnInstaller || (async (file, args) => { spawnCalls.push({ file, args }); return { ok: true, pid: 4242 }; }),
    spawnInstallerSync: opts.spawnInstallerSync || ((file, args) => { spawnCalls.push({ file, args, sync: true }); return { ok: true, pid: 4343 }; }),
    readRegisteredInstallDir: opts.readRegisteredInstallDir || (async () => INSTALL_DIR),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    requestShutdown: (reason) => shutdowns.push(reason),
    restartCountdownSeconds: opts.countdown || 10
  });
  return {
    dir, au, ctl, statuses, timers, spawnCalls, shutdowns, log,
    advance: (ms) => { clock += ms; },
    fireTimers: () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); },
    liveTimers: () => timers.filter((t) => !t.cleared),
    states: () => statuses.map((s) => s.state),
    last: () => statuses[statuses.length - 1],
    handoff: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, updater.HANDOFF_FILE), 'utf8')); } catch (_) { return null; } },
    stateDoc: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, updater.STATE_FILE), 'utf8')); } catch (_) { return {}; } }
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Verification hashes a real file (stream I/O), so "settled" means the
// controller is no longer verifying — bounded so a hang fails, not spins.
let settleTarget = null;
async function settle() {
  for (let i = 0; i < 20; i++) await tick();
  if (!settleTarget) return;
  const t0 = Date.now();
  while (settleTarget.getState() === 'verifying' && Date.now() - t0 < 5000) await sleep(10);
  for (let i = 0; i < 20; i++) await tick();
}

// Drives a check → available → downloaded flow on a fresh env.
async function driveToReady(env, inst, info) {
  settleTarget = env.ctl;
  env.ctl.start();
  await env.ctl.check('startup');
  env.au.emit('checking-for-update');
  env.au.emit('update-available', info || infoFor(inst));
  env.au.emit('download-progress', { percent: 50, transferred: 1, total: 2 });
  env.au.emit('update-downloaded', info || infoFor(inst));
  await settle();
}

(async () => {
  console.log('updater-lifecycle-smoke: pure helpers');
  {
    check(updater.compareSemver('6.4.0', '6.3.3') === 1, 'semver: 6.4.0 > 6.3.3');
    check(updater.compareSemver('6.4.0-beta.1', '6.4.0') === -1, 'semver: prerelease sorts below release');
    check(updater.compareSemver('6.4.0', '6.4.0') === 0, 'semver: equal');
    check(updater.channelOf('6.4.0-beta.2') === 'beta' && updater.channelOf('6.4.0') === 'stable', 'channel from version');
    check(updater.samePath('C:\\Program Files\\1132 Fixer\\1132 Fixer\\', 'c:\\program files\\1132 fixer\\1132 fixer'), 'samePath ignores case and trailing separator');
    const args = updater.buildInstallerArgs({ installDir: INSTALL_DIR, relaunch: true });
    check(args[0] === '--updated' && args[1] === '/S', 'installer args: --updated /S first (keeps app data, silent)');
    check(args.includes('--fixer-relaunch'), 'installer args: relaunch flag present when requested');
    check(args[args.length - 1] === `/D=${INSTALL_DIR}` && !/^"/.test(args[args.length - 1]), 'installer args: /D= is last and unquoted (path with spaces)');
    check(!updater.buildInstallerArgs({ installDir: INSTALL_DIR, relaunch: false }).includes('--fixer-relaunch'), 'installer args: no relaunch flag for install-on-exit');
  }

  console.log('updater-lifecycle-smoke: 1. no update available');
  {
    const env = makeEnv({ label: 'noupdate' });
    env.ctl.start();
    const p = env.ctl.check('startup');
    env.au.emit('checking-for-update');
    env.au.emit('update-not-available', { version: CURRENT });
    await p; await settle();
    check(env.ctl.getState() === 'idle', 'ends idle');
    check(env.states().includes('checking'), 'passed through checking');
    check(env.shutdowns.length === 0 && env.spawnCalls.length === 0, 'no shutdown, no installer');
  }

  console.log('updater-lifecycle-smoke: 2. update available but not yet downloaded');
  {
    const env = makeEnv({ label: 'avail' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    env.ctl.start();
    await env.ctl.check('startup');
    env.au.emit('update-available', infoFor(inst));
    check(env.ctl.getState() === 'downloading', 'state is downloading');
    check(env.states().includes('available'), 'available was observed');
    const r = await env.ctl.installNow('user');
    check(r.ok === false && r.reason === 'not-ready', 'install refused before readiness');
    check(env.shutdowns.length === 0 && env.liveTimers().length === 0, 'no shutdown, no countdown before the download lands');
  }

  console.log('updater-lifecycle-smoke: 3. download succeeds → verified → ready');
  {
    const env = makeEnv({ label: 'ready' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    check(env.ctl.getState() === 'ready', 'state is ready');
    check(env.states().includes('verifying'), 'verifying state observed');
    check(env.last().version === TARGET && env.last().current === CURRENT, 'payload carries target and current versions');
    check(env.liveTimers().length === 1 && env.liveTimers()[0].ms === 10000, 'one restart countdown armed (10 s)');
    check(env.shutdowns.length === 0, 'app not quitting while merely ready');
    const logText = fs.readFileSync(env.log.file, 'utf8');
    check(/"event":"verify.ok"/.test(logText) && /"event":"download.start"/.test(logText), 'log records download start and verification');
  }

  console.log('updater-lifecycle-smoke: 4. download fails');
  {
    const env = makeEnv({ label: 'dlfail' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    env.ctl.start();
    await env.ctl.check('startup');
    env.au.emit('update-available', infoFor(inst));
    env.au.emit('error', Object.assign(new Error('net::ERR_CONNECTION_RESET https://objects.githubusercontent.com/x?X-Amz-Signature=abc'), { code: 'ERR_UPDATER' }));
    check(env.ctl.getState() === 'failed' && env.last().stage === 'download', 'failed at the download stage');
    check(env.last().canRetry === true, 'retry offered');
    check(env.shutdowns.length === 0, 'no shutdown on download failure');
    const st = await env.ctl.check('interval');
    check(st.ok === true || st.reason === 'backoff', 'a later check is allowed or deferred by backoff, never crashes');
  }

  console.log('updater-lifecycle-smoke: 5. metadata is invalid');
  {
    const inst = { sha512: 'x'.repeat(88), size: 10, file: 'nope' };
    const bad = [
      [{ version: 'banana', files: [] }, 'metadata-version-invalid'],
      [{ version: '6.3.3', files: [{ url: '1132-Fixer-Setup-6.3.3.exe', sha512: inst.sha512, size: 1 }] }, 'metadata-version-current'],
      [{ version: '6.2.0', files: [{ url: '1132-Fixer-Setup-6.2.0.exe', sha512: inst.sha512, size: 1 }] }, 'metadata-version-older'],
      [{ version: '6.4.0', files: [] }, 'metadata-no-installer'],
      [{ version: '6.4.0', files: [{ url: 'Other-App-6.4.0.exe', sha512: inst.sha512, size: 1 }] }, 'metadata-artifact-name'],
      [{ version: '6.4.0', files: [{ url: '1132-Fixer-Setup-6.3.9.exe', sha512: inst.sha512, size: 1 }] }, 'metadata-artifact-version-mismatch'],
      [{ version: '6.4.0', files: [{ url: '1132-Fixer-Setup-6.4.0.exe', sha512: '', size: 1 }] }, 'metadata-sha512-missing'],
      [{ version: '6.4.0-beta.1', files: [{ url: '1132-Fixer-Setup-6.4.0-beta.1.exe', sha512: inst.sha512, size: 1 }] }, 'metadata-prerelease-on-stable'],
      [null, 'metadata-missing']
    ];
    for (const [info, reason] of bad) {
      const v = updater.validateUpdateInfo(info, { currentVersion: CURRENT, arch: 'x64', channel: 'stable' });
      check(!v.ok && v.reason === reason, `rejects ${reason}`);
    }
    const okBeta = updater.validateUpdateInfo({ version: '6.4.0-beta.1', files: [{ url: '1132-Fixer-Setup-6.4.0-beta.1.exe', sha512: inst.sha512, size: 1 }] }, { currentVersion: '6.4.0-beta.0', arch: 'x64', channel: 'beta' });
    check(okBeta.ok, 'beta channel accepts a newer prerelease');
    const env = makeEnv({ label: 'metabad' });
    env.ctl.start();
    await env.ctl.check('startup');
    env.au.emit('update-available', { version: 'banana', files: [] });
    check(env.ctl.getState() === 'failed' && env.last().stage === 'metadata', 'live flow: bad metadata → failed(metadata)');
    check(env.shutdowns.length === 0, 'no shutdown on bad metadata');
  }

  console.log('updater-lifecycle-smoke: 6. checksum / integrity verification fails');
  {
    const env = makeEnv({ label: 'sha' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    const info = infoFor(inst);
    info.files[0].sha512 = crypto.createHash('sha512').update('tampered').digest('base64');
    info.sha512 = info.files[0].sha512;
    await driveToReady(env, inst, info);
    check(env.ctl.getState() === 'failed' && env.last().stage === 'verify' && env.last().reason === 'sha512-mismatch', 'sha512 mismatch → failed(verify)');
    check(env.liveTimers().length === 0 && env.shutdowns.length === 0, 'no countdown, no shutdown after a failed verification');

    const env2 = makeEnv({ label: 'size' });
    const inst2 = makeInstaller(env2.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    const info2 = infoFor(inst2);
    info2.files[0].size = inst2.size + 1;
    await driveToReady(env2, inst2, info2);
    check(env2.last().reason === 'size-mismatch', 'size mismatch → failed(verify)');

    const env3 = makeEnv({ label: 'missing' });
    const inst3 = makeInstaller(env3.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    const info3 = infoFor(inst3);
    info3.downloadedFile = path.join(env3.dir, 'nowhere', `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env3, inst3, info3);
    check(env3.last().reason === 'downloaded-file-missing', 'missing downloaded file → failed(verify)');
  }

  console.log('updater-lifecycle-smoke: 7. architecture does not match');
  {
    const env = makeEnv({ label: 'arch' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}-arm64.exe`);
    env.ctl.start();
    await env.ctl.check('startup');
    env.au.emit('update-available', infoFor(inst, TARGET, `1132-Fixer-Setup-${TARGET}-arm64.exe`));
    check(env.ctl.getState() === 'failed' && env.last().reason === 'metadata-arch-mismatch', 'arm64 artifact refused on x64');
    const v = updater.validateUpdateInfo({ version: TARGET, files: [{ url: `1132-Fixer-Setup-${TARGET}-arm64.exe`, sha512: inst.sha512, size: inst.size }] }, { currentVersion: CURRENT, arch: 'arm64', channel: 'stable' });
    check(v.ok && v.file.arch === 'arm64', 'arm64 artifact accepted on arm64');
  }

  console.log('updater-lifecycle-smoke: 8. update becomes ready to install');
  {
    const env = makeEnv({ label: 'ready2' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    check(env.ctl.isReady() && env.last().state === 'ready' && env.last().seconds === 10, 'ready payload with countdown seconds');
    const d = env.ctl.defer();
    check(d.ok && env.last().deferred === true && env.liveTimers().length === 0, 'defer cancels the countdown and marks deferred');
  }

  console.log('updater-lifecycle-smoke: 9. application does not exit before readiness');
  {
    const env = makeEnv({ label: 'noexit' });
    settleTarget = env.ctl;
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    env.ctl.start();
    await env.ctl.check('startup');
    env.au.emit('update-available', infoFor(inst));
    env.au.emit('download-progress', { percent: 99 });
    check(env.shutdowns.length === 0 && env.spawnCalls.length === 0 && env.liveTimers().length === 0, 'nothing exits or spawns during download');
    env.au.emit('update-downloaded', infoFor(inst));
    check(env.ctl.getState() === 'verifying' && env.shutdowns.length === 0, 'verifying: still no exit');
    await settle();
    check(env.ctl.getState() === 'ready' && env.shutdowns.length === 0, 'ready: still no exit until the countdown or the user says so');
    env.fireTimers();
    await settle();
    check(env.shutdowns.length === 1 && env.shutdowns[0] === 'update_restart', 'countdown → exactly one update_restart shutdown');
    check(env.spawnCalls.length === 1 && env.spawnCalls[0].file === inst.file, 'installer spawned once from the verified file');
    check(env.states().indexOf('installing') < env.states().indexOf('restarting'), 'installing precedes restarting');
  }

  console.log('updater-lifecycle-smoke: 10. install handoff occurs exactly once');
  {
    const env = makeEnv({ label: 'once' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    const [a, b, c] = await Promise.all([env.ctl.installNow('user'), env.ctl.installNow('user'), env.ctl.installNow('countdown')]);
    check(a.ok === true, 'first install request runs');
    check(b.ok === false && c.ok === false, 'concurrent requests are refused');
    check(env.spawnCalls.length === 1 && env.shutdowns.length === 1, 'one spawn, one shutdown');
    env.fireTimers();
    await settle();
    check(env.spawnCalls.length === 1 && env.shutdowns.length === 1, 'a late countdown does not hand off again');
    const rec = env.handoff();
    check(rec && rec.state === 'installer-started' && rec.installerPid === 4242 && rec.targetVersion === TARGET, 'handoff record: installer-started with pid and target');
    check(rec.currentVersion === CURRENT && rec.execPath === EXEC && rec.installDir === INSTALL_DIR && rec.channel === 'stable', 'handoff record: current version, exe path, install dir, channel');
    check(rec.artifact && rec.artifact.sha512 === inst.sha512 && rec.artifact.size === inst.size && typeof rec.timestamp === 'string', 'handoff record: artifact identity and timestamp');
    check(!JSON.stringify(rec).match(/token|password|secret/i), 'handoff record carries no secrets');
    check(env.ctl.hasHandedOff(), 'controller reports handoff');
  }

  console.log('updater-lifecycle-smoke: 11. duplicate updater events do not cause repeated shutdown');
  {
    const env = makeEnv({ label: 'dupe' });
    settleTarget = env.ctl;
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    env.ctl.start();
    await env.ctl.check('startup');
    env.au.emit('update-available', infoFor(inst));
    env.au.emit('update-available', infoFor(inst));
    env.au.emit('update-downloaded', infoFor(inst));
    env.au.emit('update-downloaded', infoFor(inst));
    env.au.emit('update-downloaded', infoFor(inst));
    await settle();
    check(env.liveTimers().length === 1, 'three downloaded events → one countdown');
    env.fireTimers();
    await settle();
    env.au.emit('update-downloaded', infoFor(inst));
    await settle();
    check(env.shutdowns.length === 1 && env.spawnCalls.length === 1, 'still one shutdown and one spawn');
    check(env.ctl._test.eventCounts['update-downloaded'] === 4, 'duplicates counted in diagnostics');
  }

  console.log('updater-lifecycle-smoke: 12. installer launch fails');
  {
    const env = makeEnv({ label: 'spawnfail', spawnInstaller: async () => ({ ok: false, error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }) });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    const r = await env.ctl.installNow('user');
    check(r.ok === false && r.reason === 'installer-missing', 'ENOENT → installer-missing');
    check(env.ctl.getState() === 'failed' && env.last().stage === 'installer-launch', 'failed at installer-launch');
    check(env.shutdowns.length === 0, 'app stays open when the installer does not start');
    check(env.handoff().state === 'failed' && env.handoff().failure === 'installer-missing', 'handoff record marked failed');
    check(env.stateDoc().attempts[TARGET].count === 1, 'attempt recorded');
    const env2 = makeEnv({ label: 'spawnelev', spawnInstaller: async () => ({ ok: false, error: Object.assign(new Error('UNKNOWN'), { code: 'UNKNOWN' }) }) });
    const inst2 = makeInstaller(env2.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env2, inst2);
    const r2 = await env2.ctl.installNow('user');
    check(r2.reason === 'installer-elevation-refused', 'UNKNOWN (ERROR_ELEVATION_REQUIRED) → installer-elevation-refused');
  }

  console.log('updater-lifecycle-smoke: 13. relaunch succeeds with the target version');
  {
    const dir = tmpDir('relaunch');
    const rec = updater.buildHandoffRecord({ currentVersion: CURRENT, targetVersion: TARGET, execPath: EXEC, installDir: INSTALL_DIR, channel: 'stable', artifact: { name: 'x', sha512: 'y', size: 1 }, relaunchRequested: true, attempt: 1, timestamp: new Date(1_800_000_000_000).toISOString(), state: 'installer-started', installerPid: 77 });
    fs.writeFileSync(path.join(dir, updater.HANDOFF_FILE), JSON.stringify(rec));
    const env = makeEnv({ label: 'relaunch', dir, currentVersion: TARGET, argv: ['1132 Fixer.exe', '--updated', '--fixer-relaunch'] });
    const v = env.ctl.start();
    check(v.state === 'updated' && v.reason === 'relaunch-verified', 'new process verifies the relaunch');
    check(env.last().state === 'updated' && env.last().version === TARGET, 'renderer told: updated to target');
    check(env.handoff() && env.handoff().state === 'updated-pending-ready', 'record kept until the app is ready');
    const logText = fs.readFileSync(env.log.file, 'utf8');
    check(/"event":"relaunch.verified"/.test(logText) && logText.includes(TARGET), 'log records the relaunched runtime version');
    check(/"execPath":"C:\\\\Program Files\\\\1132 Fixer\\\\1132 Fixer\\\\1132 Fixer.exe"/.test(logText), 'log records the relaunched executable path');
    env.ctl.markAppReady();
    check(env.handoff() === null, 'handoff cleared after ready');
    check(/"event":"update.complete"/.test(fs.readFileSync(env.log.file, 'utf8')), 'log records completion');
    env.ctl.continueCurrent();
    check(env.ctl.getState() === 'idle', 'OK dismisses the updated banner');
  }

  console.log('updater-lifecycle-smoke: 14. relaunch opens an unexpected previous version');
  {
    const dir = tmpDir('prev');
    const rec = updater.buildHandoffRecord({ currentVersion: CURRENT, targetVersion: TARGET, execPath: EXEC, installDir: INSTALL_DIR, channel: 'stable', artifact: { name: 'x', sha512: 'y', size: 1 }, relaunchRequested: true, attempt: 1, timestamp: new Date(1_800_000_000_000).toISOString(), state: 'installer-started', installerPid: 77 });
    fs.writeFileSync(path.join(dir, updater.HANDOFF_FILE), JSON.stringify(rec));
    const env = makeEnv({ label: 'prev', dir, currentVersion: CURRENT, argv: ['1132 Fixer.exe', '--updated', '--fixer-relaunch'] });
    const v = env.ctl.start();
    check(v.state === 'recovery' && v.reason === 'previous-version-running', 'previous version → recovery');
    check(env.last().state === 'recovery' && env.last().version === TARGET && env.last().current === CURRENT, 'renderer told: recovery with both versions');
    check(env.handoff().state === 'failed', 'record marked failed (not cleared silently)');
    check(/"event":"relaunch.failed"/.test(fs.readFileSync(env.log.file, 'utf8')), 'log records the failed relaunch');
    env.ctl.markAppReady();
    check(env.handoff() !== null, 'ready does not clear a failed handoff');
  }

  console.log('updater-lifecycle-smoke: 15. relaunch opens the wrong executable path');
  {
    const dir = tmpDir('wrongpath');
    const rec = updater.buildHandoffRecord({ currentVersion: CURRENT, targetVersion: TARGET, execPath: EXEC, installDir: INSTALL_DIR, channel: 'stable', artifact: { name: 'x', sha512: 'y', size: 1 }, relaunchRequested: true, attempt: 1, timestamp: new Date(1_800_000_000_000).toISOString(), state: 'installer-started' });
    fs.writeFileSync(path.join(dir, updater.HANDOFF_FILE), JSON.stringify(rec));
    const env = makeEnv({ label: 'wrongpath', dir, currentVersion: TARGET, execPath: 'C:\\Users\\Someone\\AppData\\Local\\Temp\\1132 Fixer\\1132 Fixer.exe', argv: ['x', '--fixer-relaunch'] });
    const v = env.ctl.start();
    check(v.state === 'recovery' && v.reason === 'unexpected-executable-path', 'wrong path → recovery (unexpected-executable-path)');
    const evShort = updater.evaluateStartup({ record: rec, currentVersion: TARGET, execPath: 'C:\\PROGRAM FILES\\1132 FIXER\\1132 FIXER\\1132 FIXER.EXE', argv: [], nowMs: 1_800_000_000_000 + 1000 });
    check(evShort.state === 'updated', 'same path in different case is the same installation');
  }

  console.log('updater-lifecycle-smoke: 16. single-instance locking during restart (shutdown reasons)');
  {
    let quits = 0;
    const sd = shutdownMod.createShutdownController({ quit: () => { quits++; } });
    const a = sd.request('update_restart');
    const b = sd.request('inactive_exit');
    const c = sd.request('user_exit');
    check(a.accepted && !b.accepted && !c.accepted, 'first shutdown reason wins');
    check(quits === 1, 'quit called once for three requests');
    check(sd.reason() === 'update_restart' && sd.isUpdateRestart(), 'reason is update_restart');
    check(sd.duplicates().length === 2, 'duplicates recorded');
    const sd2 = shutdownMod.createShutdownController({ quit: () => {} });
    sd2.note('system_shutdown');
    check(sd2.request('user_exit').accepted === false && sd2.reason() === 'system_shutdown', 'a noted external shutdown is not overwritten');
    check(shutdownMod.REASONS.SECOND_INSTANCE === 'second_instance', 'second-instance reason exists for the lock path');
  }

  console.log('updater-lifecycle-smoke: 17. stale process cleanup does not kill the new process');
  {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    const spawnBlock = main.slice(main.indexOf('function installerSpawnOptions'), main.indexOf('let updaterCtl = null;'));
    check(spawnBlock.length > 100 && !spawnBlock.includes('activeChildren.add'), 'installer is never tracked as a fix child (killActiveChildren cannot reach it)');
    check(spawnBlock.includes('detached: true') && spawnBlock.includes("stdio: 'ignore'"), 'installer spawned detached with ignored stdio');
    check(!/customInit[\s\S]*?taskkill[\s\S]*?\/T[\s\S]*?!macroend/.test(nsh.slice(nsh.indexOf('!macro customInit'), nsh.indexOf('!macroend', nsh.indexOf('!macro customInit')))), 'customInit has no taskkill /T (it would kill the installer inside the app process tree)');
    const nshCode = nsh.split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join('\n');
    check(!/taskkill[^\n]*\/T\b/.test(nshCode), 'installer.nsh never kills a process tree');
    check(main.includes("autoUpdater.autoInstallOnAppQuit = false"), 'autoInstallOnAppQuit is off (no elevate.exe path)');
    check(!/autoUpdater\.quitAndInstall/.test(main), 'quitAndInstall is not called anywhere');
  }

  console.log('updater-lifecycle-smoke: 18. paths containing spaces');
  {
    const spaced = 'C:\\Users\\Pat Smith\\AppData\\Local\\Programs\\1132 Fixer';
    const env = makeEnv({ label: 'spaces', execPath: path.win32.join(spaced, '1132 Fixer.exe'), readRegisteredInstallDir: async () => spaced });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    const r = await env.ctl.installNow('user');
    check(r.ok === true, 'install proceeds from a spaced install directory');
    const args = env.spawnCalls[0].args;
    check(args[args.length - 1] === `/D=${spaced}`, '/D= carries the spaced directory verbatim');
    check(env.handoff().installDir === spaced, 'handoff record keeps the spaced directory');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    check(main.includes('windowsVerbatimArguments: true') && main.includes('argv0: `"${installerPath}"`'), 'spawn keeps /D= unquoted and quotes the installer path itself');
  }

  console.log('updater-lifecycle-smoke: 19. per-user installation and install-location checks');
  {
    const perUser = 'C:\\Users\\Pat Smith\\AppData\\Local\\Programs\\1132 Fixer';
    const envMismatch = makeEnv({ label: 'loc', execPath: path.win32.join(perUser, '1132 Fixer.exe'), readRegisteredInstallDir: async () => INSTALL_DIR });
    const inst = makeInstaller(envMismatch.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(envMismatch, inst);
    const r = await envMismatch.ctl.installNow('user');
    check(r.ok === false && r.reason === 'install-location-mismatch', 'registered location elsewhere → refused (no side-by-side install)');
    check(envMismatch.shutdowns.length === 0 && envMismatch.spawnCalls.length === 0, 'no spawn, no exit on location mismatch');
    const envNoReg = makeEnv({ label: 'noreg', execPath: path.win32.join(perUser, '1132 Fixer.exe'), readRegisteredInstallDir: async () => null });
    const inst2 = makeInstaller(envNoReg.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(envNoReg, inst2);
    const r2 = await envNoReg.ctl.installNow('user');
    check(r2.ok === true && envNoReg.spawnCalls[0].args.includes(`/D=${perUser}`), 'no registry record → /D pins the running installation');
  }

  console.log('updater-lifecycle-smoke: 20. elevation boundary behaviour');
  {
    const env = makeEnv({ label: 'elev', isElevated: async () => false });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    const r = await env.ctl.installNow('user');
    check(r.ok === false && r.reason === 'elevation-required', 'non-elevated process refuses to hand off');
    check(env.spawnCalls.length === 0 && env.shutdowns.length === 0, 'no installer, no exit without elevation');
    check(env.ctl.getState() === 'failed' && env.last().stage === 'elevation', 'failed(elevation) is reported for recovery UI');
    const envDev = makeEnv({ label: 'dev', isPackaged: false });
    const c = await envDev.ctl.check('startup');
    check(c.ok === false && c.reason === 'not-installed-build', 'development run never checks or installs');
    const envPortable = makeEnv({ label: 'portable', isPortable: true });
    const c2 = await envPortable.ctl.check('startup');
    check(c2.ok === false && c2.reason === 'not-installed-build', 'portable run never checks or installs through this path');
  }

  console.log('updater-lifecycle-smoke: 21. interrupted installation');
  {
    const dir = tmpDir('interrupted');
    const rec = updater.buildHandoffRecord({ currentVersion: CURRENT, targetVersion: TARGET, execPath: EXEC, installDir: INSTALL_DIR, channel: 'stable', artifact: { name: 'x', sha512: 'y', size: 1 }, relaunchRequested: true, attempt: 1, timestamp: new Date(1_800_000_000_000).toISOString(), state: 'installing' });
    fs.writeFileSync(path.join(dir, updater.HANDOFF_FILE), JSON.stringify(rec));
    const env = makeEnv({ label: 'interrupted', dir, currentVersion: CURRENT });
    const v = env.ctl.start();
    check(v.state === 'recovery' && v.reason === 'installer-not-started', 'record without installer-started → recovery');
    const stale = updater.evaluateStartup({ record: Object.assign({}, rec, { state: 'installer-started' }), currentVersion: CURRENT, execPath: EXEC, argv: [], nowMs: 1_800_000_000_000 + updater.HANDOFF_MAX_AGE_MS + 1 });
    check(stale.state === 'idle' && stale.clear === true, 'a week-old record is discarded, not reported');
  }

  console.log('updater-lifecycle-smoke: 22. recovery after a failed update');
  {
    const dir = tmpDir('recover');
    const rec = updater.buildHandoffRecord({ currentVersion: CURRENT, targetVersion: TARGET, execPath: EXEC, installDir: INSTALL_DIR, channel: 'stable', artifact: { name: 'x', sha512: 'y', size: 1 }, relaunchRequested: true, attempt: 1, timestamp: new Date(1_800_000_000_000).toISOString(), state: 'installer-started' });
    fs.writeFileSync(path.join(dir, updater.HANDOFF_FILE), JSON.stringify(rec));
    let checks = 0;
    const env = makeEnv({ label: 'recover', dir, currentVersion: CURRENT, onCheck: () => { checks++; } });
    env.ctl.start();
    check(env.ctl.getState() === 'recovery', 'starts in recovery');
    const d = env.ctl.diagnostics();
    check(d.state === 'recovery' && d.handoff && d.handoff.targetVersion === TARGET && Array.isArray(d.recent), 'diagnostics carry the handoff and log tail');
    const r = await env.ctl.retry('user');
    check(r.ok === true && checks === 1, 'Retry update runs a fresh check');
    check(env.handoff() === null, 'retry clears the failed record');
    const dir2 = tmpDir('recover2');
    fs.writeFileSync(path.join(dir2, updater.HANDOFF_FILE), JSON.stringify(rec));
    const env2 = makeEnv({ label: 'recover2', dir: dir2, currentVersion: CURRENT });
    env2.ctl.start();
    env2.ctl.continueCurrent();
    check(env2.ctl.getState() === 'idle' && env2.handoff() === null, 'Continue with current version returns to idle and clears the record');
  }

  console.log('updater-lifecycle-smoke: 23. prevention of an update/restart loop');
  {
    const dir = tmpDir('loop');
    const env = makeEnv({ label: 'loop', dir });
    const inst = makeInstaller(dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    await env.ctl.installNow('user'); // attempt 1 (spawn ok) → restarting
    // Simulate the next launch: same version still running (install failed).
    const env2 = makeEnv({ label: 'loop2', dir });
    settleTarget = env2.ctl;
    env2.ctl.start();
    check(env2.ctl.getState() === 'recovery', 'second launch sees the failed handoff');
    await env2.ctl.retry('user');
    env2.au.emit('update-available', infoFor(inst));
    env2.au.emit('update-downloaded', infoFor(inst));
    await settle();
    check(env2.ctl.getState() === 'ready' && env2.liveTimers().length === 1, 'attempt 2 may still count down automatically');
    env2.fireTimers();
    await settle();
    check(env2.shutdowns.length === 1, 'attempt 2 handed off');
    const env3 = makeEnv({ label: 'loop3', dir });
    settleTarget = env3.ctl;
    env3.ctl.start();
    await env3.ctl.retry('user');
    env3.au.emit('update-available', infoFor(inst));
    env3.au.emit('update-downloaded', infoFor(inst));
    await settle();
    check(env3.ctl.getState() === 'ready' && env3.last().deferred === true && env3.liveTimers().length === 0, 'after two failed attempts no automatic countdown is armed');
    await env3.ctl.installNow('user');
    const env4 = makeEnv({ label: 'loop4', dir });
    settleTarget = env4.ctl;
    env4.ctl.start();
    await env4.ctl.retry('user');
    env4.au.emit('update-available', infoFor(inst));
    env4.au.emit('update-downloaded', infoFor(inst));
    await settle();
    await env4.ctl.installNow('user');
    const env5 = makeEnv({ label: 'loop5', dir });
    env5.ctl.start();
    const blocked = await env5.ctl.retry('user');
    check(blocked.ok === false && blocked.reason === 'retry-limit-reached', `after ${updater.MAX_TOTAL_INSTALL_ATTEMPTS} attempts retry stops`);
    check(env5.last().state === 'recovery' && env5.last().canRetry === false, 'recovery banner offers the manual download instead of retry');
    const bo = await env5.ctl.check('interval');
    check(bo.ok === false && bo.reason === 'backoff', 'automatic re-check waits out the backoff after a failure');
    env5.advance(updater.BACKOFF_MS[updater.BACKOFF_MS.length - 1] + 1);
    const policy = updater.retryPolicy(env5.stateDoc(), TARGET, 1_800_000_000_000 + updater.BACKOFF_MS[3] + 1);
    check(policy.autoCheckAllowed === true && policy.installAllowed === false, 'backoff expires, install stays blocked');
  }

  console.log('updater-lifecycle-smoke: 24. handoff state is cleared only after the new build is ready');
  {
    const dir = tmpDir('clear');
    const rec = updater.buildHandoffRecord({ currentVersion: CURRENT, targetVersion: TARGET, execPath: EXEC, installDir: INSTALL_DIR, channel: 'stable', artifact: { name: 'x', sha512: 'y', size: 1 }, relaunchRequested: true, attempt: 1, timestamp: new Date(1_800_000_000_000).toISOString(), state: 'installer-started' });
    fs.writeFileSync(path.join(dir, updater.HANDOFF_FILE), JSON.stringify(rec));
    const env = makeEnv({ label: 'clear', dir, currentVersion: TARGET, argv: ['x', '--fixer-relaunch'] });
    env.ctl.start();
    await env.ctl.check('startup');
    check(env.handoff() !== null && env.handoff().state === 'updated-pending-ready', 'record survives start and a check');
    const envAgain = makeEnv({ label: 'clear-again', dir, currentVersion: TARGET });
    envAgain.ctl.start();
    check(envAgain.ctl.getState() === 'updated', 'a crash before ready leaves the record; the next start still reports updated');
    envAgain.ctl.markAppReady();
    envAgain.ctl.markAppReady();
    check(envAgain.handoff() === null, 'cleared once the app is ready (idempotent)');
  }

  console.log('updater-lifecycle-smoke: 25. existing settings and application data remain intact');
  {
    const env = makeEnv({ label: 'settings' });
    const settingsFile = path.join(env.dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ shortcut: true, theme: 'navy' }));
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    await env.ctl.installNow('user');
    check(fs.readFileSync(settingsFile, 'utf8') === JSON.stringify({ shortcut: true, theme: 'navy' }), 'settings file untouched by the handoff');
    check(env.spawnCalls[0].args[0] === '--updated', '--updated tells the installer to keep app data');
    const entries = fs.readdirSync(env.dir).sort();
    check(entries.includes('settings.json') && entries.includes(updater.HANDOFF_FILE) && entries.includes(updater.STATE_FILE) && entries.includes('logs'), 'only updater files were added next to settings');
  }

  console.log('updater-lifecycle-smoke: install on exit (deferred update, user exits)');
  {
    const env = makeEnv({ label: 'onexit' });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    env.ctl.defer();
    const r = env.ctl.installOnExit('user_exit');
    check(r.ok === true && env.spawnCalls.length === 1 && env.spawnCalls[0].sync === true, 'deferred update installs when the user exits');
    check(!env.spawnCalls[0].args.includes('--fixer-relaunch'), 'install on exit does not relaunch the app');
    check(env.handoff().relaunchRequested === false && env.handoff().state === 'installer-started', 'record says no relaunch was requested');
    const env2 = makeEnv({ label: 'onexit2' });
    const inst2 = makeInstaller(env2.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env2, inst2);
    check(env2.ctl.installOnExit('update_restart').ok === false, 'an update restart never triggers a second install on exit');
  }

  console.log('updater-lifecycle-smoke: busy (repair running) blocks install');
  {
    let busy = true;
    const env = makeEnv({ label: 'busy', isBusy: () => busy });
    const inst = makeInstaller(env.dir, `1132-Fixer-Setup-${TARGET}.exe`);
    await driveToReady(env, inst);
    check(env.ctl.getState() === 'ready' && env.last().deferred === true && env.liveTimers().length === 0, 'ready while busy → deferred, no countdown');
    const r = await env.ctl.installNow('user');
    check(r.ok === false && r.reason === 'busy' && env.shutdowns.length === 0, 'install refused while a repair runs');
    busy = false;
    const r2 = await env.ctl.installNow('user');
    check(r2.ok === true, 'install proceeds once the repair finished');
  }

  console.log('updater-lifecycle-smoke: sanitized log');
  {
    const s = createSanitizer({ homeDir: 'C:\\Users\\patsmith', username: 'patsmith', hostname: 'PAT-PC' });
    check(s('https://objects.githubusercontent.com/a/b.exe?X-Amz-Signature=abc&token=ghp_secret') === 'https://objects.githubusercontent.com/a/b.exe?…', 'URL query string stripped');
    check(s('token ghp_ABCDEFGHIJKLMNOP') === 'token ghp_<redacted>', 'GitHub token redacted');
    check(s('C:\\Users\\patsmith\\AppData\\Roaming\\1132-fixer').startsWith('C:\\Users\\<you>'), 'home directory replaced');
    check(s('C:\\Program Files\\1132 Fixer\\1132 Fixer\\1132 Fixer.exe') === 'C:\\Program Files\\1132 Fixer\\1132 Fixer\\1132 Fixer.exe', 'install path kept (needed for diagnosis)');
    check(s('host PAT-PC user1 fine') === 'host <host> user1 fine', 'hostname redacted, helper account name kept');
    const dir = tmpDir('log');
    const log = createUpdaterLog({ file: path.join(dir, 'logs', 'updater.log'), sanitize: s, maxBytes: 600 });
    log.info('one', { url: 'https://x.test/a?sig=1', nested: { authorization: 'Bearer abc', ok: 1 } });
    const line = JSON.parse(fs.readFileSync(log.file, 'utf8').trim());
    check(line.event === 'one' && line.url === 'https://x.test/a?…' && line.nested.authorization === '<redacted>', 'entries are JSON with sanitized fields');
    for (let i = 0; i < 20; i++) log.info('fill', { i, pad: 'x'.repeat(40) });
    check(fs.existsSync(`${log.file}.1`), 'log rotates past maxBytes');
    check(log.tail(3).length === 3, 'tail returns the last lines');
  }

  if (failures) {
    console.error(`\nupdater-lifecycle-smoke: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('\nupdater-lifecycle-smoke: PASS');
})().catch((err) => {
  console.error('updater-lifecycle-smoke: threw', err);
  process.exit(1);
});
