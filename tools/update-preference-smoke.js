'use strict';

/**
 * "Automatic app updates" regression tests.
 *
 * Part 1: the preference store (src/main/update-preference.js) — default,
 *         explicit choice, persistence across a new process, a damaged file.
 * Part 2: the updater controller (src/main/updater.js) with the preference
 *         injected — every unattended path must stop when it is off, the
 *         manual path must keep working, and turning it back on must
 *         restore the earlier behaviour.
 * Part 3: source wiring — main.js, preload.js, the IPC allowlist and the
 *         About dialog all use the one preference.
 *
 * No Electron, no network, no installer: a fake electron-updater emitter, a
 * temp userData folder with a real file so hashes are real, fake timers.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const prefMod = require('../src/main/update-preference');
const updater = require('../src/main/updater');
const { createUpdaterLog } = require('../src/main/updater-log');
const security = require('../src/main/electron-security');
const messages = require('../messages');
const uiState = require('../ui-state');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

const CURRENT = '6.4.0';
const TARGET = '6.5.0';
const INSTALL_DIR = 'C:\\Program Files\\1132 Fixer\\1132 Fixer';
const EXEC = path.win32.join(INSTALL_DIR, '1132 Fixer.exe');
const tmpDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `1132-pref-${label}-`));
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeInstaller(dir) {
  const pending = path.join(dir, 'updater-cache', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  const file = path.join(pending, `1132-Fixer-Setup-${TARGET}.exe`);
  const buf = crypto.randomBytes(32 * 1024);
  fs.writeFileSync(file, buf);
  return { file, sha512: crypto.createHash('sha512').update(buf).digest('base64'), size: buf.length };
}
function infoFor(inst) {
  const name = `1132-Fixer-Setup-${TARGET}.exe`;
  return { version: TARGET, files: [{ url: name, sha512: inst.sha512, size: inst.size }], path: name, sha512: inst.sha512, releaseDate: '2026-11-14T00:00:00.000Z', downloadedFile: inst.file };
}

function makeEnv(label, opts = {}) {
  const dir = tmpDir(label);
  const pref = prefMod.createUpdatePreference({ userDataDir: dir });
  if (typeof opts.initial === 'boolean') pref.set(opts.initial);
  const au = new EventEmitter();
  const calls = { check: 0, download: 0 };
  au.checkForUpdates = async () => { calls.check += 1; if (opts.onCheck) await opts.onCheck(au); return { updateInfo: null }; };
  au.downloadUpdate = async () => { calls.download += 1; return []; };
  const statuses = [];
  const timers = [];
  const spawnCalls = [];
  const shutdowns = [];
  const log = createUpdaterLog({ file: path.join(dir, 'logs', 'updater.log'), sanitize: (s) => String(s) });
  const ctl = updater.createUpdaterController({
    autoUpdater: au, log, emit: (p) => statuses.push(p),
    currentVersion: CURRENT, execPath: EXEC, argv: ['1132 Fixer.exe'], arch: 'x64', platform: 'win32',
    userDataDir: dir, isPackaged: true, isPortable: false,
    isElevated: async () => true, isBusy: () => false, hasUpdateConfig: () => true,
    spawnInstaller: async (file, args) => { spawnCalls.push({ file, args }); return { ok: true, pid: 4242 }; },
    readRegisteredInstallDir: async () => INSTALL_DIR,
    now: () => 1_800_000_000_000,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
    requestShutdown: (reason) => shutdowns.push(reason),
    restartCountdownSeconds: 10,
    automaticEnabled: () => pref.isEnabled()
  });
  const countdownTimers = () => timers.filter((t) => !t.cleared && t.ms === 10000);
  return { dir, pref, au, ctl, calls, statuses, timers, spawnCalls, shutdowns, countdownTimers, last: () => statuses[statuses.length - 1] };
}

async function settle(ctl) {
  for (let i = 0; i < 20; i++) await tick();
  const t0 = Date.now();
  while (ctl.getState() === 'verifying' && Date.now() - t0 < 5000) await sleep(10);
  for (let i = 0; i < 20; i++) await tick();
}

// A user-requested check that finds an update, then a user-requested download.
async function manualToReady(env, inst) {
  env.ctl.start();
  const p = env.ctl.check('user');
  env.au.emit('checking-for-update');
  env.au.emit('update-available', infoFor(inst));
  await p;
  await env.ctl.download('user');
  env.au.emit('update-downloaded', infoFor(inst));
  await settle(env.ctl);
}

(async () => {
  console.log('update-preference-smoke: the preference store');
  {
    const dir = tmpDir('store');
    const p = prefMod.createUpdatePreference({ userDataDir: dir });
    const d = p.get();
    check(d.enabled === true && d.explicit === false && d.source === 'default', 'no saved preference: automatic updates ON, reported as a default (not an explicit choice)');
    check(!fs.existsSync(path.join(dir, prefMod.SETTINGS_FILE)), 'reading the default writes nothing');

    const off = p.set(false);
    check(off.ok === true && off.preference.enabled === false && off.preference.explicit === true, 'turning off is saved and reported as explicit');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, prefMod.SETTINGS_FILE), 'utf8'));
    check(onDisk.automaticUpdates.enabled === false && typeof onDisk.automaticUpdates.setAt === 'string', 'the choice is on disk immediately, with the time it was made');
    check(!fs.existsSync(path.join(dir, `${prefMod.SETTINGS_FILE}.tmp`)), 'atomic write leaves no temporary file');

    // A new process (app restart, Windows restart, or the upgraded version)
    // builds a new store over the same userData folder.
    const next = prefMod.createUpdatePreference({ userDataDir: dir }).get();
    check(next.enabled === false && next.explicit === true && next.source === 'saved', 'a new process reads the saved OFF: it is not reset or re-enabled');

    p.set(true);
    const again = prefMod.createUpdatePreference({ userDataDir: dir }).get();
    check(again.enabled === true && again.explicit === true, 'turning on again is saved as an explicit ON');

    check(p.set('yes').ok === false && p.set(1).ok === false && p.set(null).ok === false, 'only true or false can be saved');
    check(p.get().enabled === true, 'a rejected value changes nothing');

    // Other settings in the same file are kept.
    fs.writeFileSync(path.join(dir, prefMod.SETTINGS_FILE), JSON.stringify({ schema: 1, other: { keep: 'me' }, automaticUpdates: { enabled: true, setAt: 'x' } }));
    const q = prefMod.createUpdatePreference({ userDataDir: dir });
    q.set(false);
    check(JSON.parse(fs.readFileSync(path.join(dir, prefMod.SETTINGS_FILE), 'utf8')).other.keep === 'me', 'saving keeps other keys in the settings file');
  }
  {
    const dir = tmpDir('damaged');
    fs.writeFileSync(path.join(dir, prefMod.SETTINGS_FILE), '{ not json');
    const d = prefMod.createUpdatePreference({ userDataDir: dir }).get();
    check(d.enabled === false && d.explicit === false && d.source === 'unreadable', 'a damaged settings file reads as OFF (unknown choice never re-enables updates)');
    fs.writeFileSync(path.join(dir, prefMod.SETTINGS_FILE), JSON.stringify({ automaticUpdates: 'on' }));
    check(prefMod.createUpdatePreference({ userDataDir: dir }).get().enabled === false, 'a malformed entry reads as OFF');
    fs.writeFileSync(path.join(dir, prefMod.SETTINGS_FILE), JSON.stringify({ schema: 1 }));
    const e = prefMod.createUpdatePreference({ userDataDir: dir }).get();
    check(e.enabled === true && e.source === 'default', 'a settings file with no update entry is the default, not a choice');
  }
  {
    const dir = tmpDir('writefail');
    const failingFs = Object.assign({}, fs, { writeFileSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } });
    const p = prefMod.createUpdatePreference({ userDataDir: dir, fs: failingFs });
    const r = p.set(false);
    check(r.ok === false && r.reason === 'write-failed', 'a failed save is reported as not saved');
    check(r.preference.enabled === true && p.get().enabled === true, 'a failed save does not change the value in use');
  }

  console.log('update-preference-smoke: OFF stops every unattended path');
  {
    const env = makeEnv('off-check', { initial: false });
    env.ctl.start();
    const s = await env.ctl.check('startup');
    const i = await env.ctl.check('interval');
    check(s.ok === false && s.reason === 'automatic-updates-off', 'startup check is refused');
    check(i.ok === false && i.reason === 'automatic-updates-off', 'interval (background) check is refused');
    check(env.calls.check === 0, 'no request reaches the update service');
    check(env.ctl.getState() === 'idle' && !env.statuses.some((x) => x.state === 'checking'), 'the banner never shows "Checking for updates"');
  }
  {
    const env = makeEnv('off-manual', { initial: false });
    const inst = makeInstaller(env.dir);
    env.ctl.start();
    const p = env.ctl.check('user');
    env.au.emit('checking-for-update');
    env.au.emit('update-available', infoFor(inst));
    const r = await p;
    check(r.ok === true && env.calls.check === 1, 'manual "Check for updates" runs with automatic updates off');
    check(env.ctl.getState() === 'available', 'a found update is offered');
    check(env.calls.download === 0 && env.spawnCalls.length === 0, 'checking downloads nothing and installs nothing');
    await env.ctl.download('user');
    env.au.emit('update-downloaded', infoFor(inst));
    await settle(env.ctl);
    check(env.ctl.getState() === 'ready', 'a download the user asked for completes and is verified');
    check(env.countdownTimers().length === 0, 'no restart countdown is started');
    check(env.last().deferred === true && env.last().seconds === 0 && env.last().automatic === false, 'status says: ready, waiting for the user, automatic off');
    check(env.spawnCalls.length === 0, 'the installer has not started');

    const exit = await env.ctl.installOnExit('user_exit');
    const idle = await env.ctl.installOnExit('inactive_exit');
    check(exit.ok === false && exit.reason === 'automatic-updates-off', 'exiting the app does not install the update');
    check(idle.ok === false && idle.reason === 'automatic-updates-off', 'the inactivity exit does not install the update');
    const cd = await env.ctl.installNow('countdown');
    check(cd.ok === false && cd.reason === 'automatic-updates-off', 'a stray countdown request is refused at the install gate');
    check(env.spawnCalls.length === 0 && env.shutdowns.length === 0, 'still nothing installed, app still running');

    const now = await env.ctl.installNow('user');
    check(now.ok === true && env.spawnCalls.length === 1, '"Restart now" (explicit) installs');
  }

  console.log('update-preference-smoke: turning OFF while something is in progress');
  {
    const env = makeEnv('toggle-countdown', { initial: true });
    const inst = makeInstaller(env.dir);
    await manualToReady(env, inst);
    check(env.ctl.getState() === 'ready' && env.countdownTimers().length === 1, 'with automatic ON a downloaded update starts the restart countdown');
    env.pref.set(false);
    const r = env.ctl.onAutomaticChanged(false);
    check(r.stopped.includes('restart-countdown') && env.countdownTimers().length === 0, 'turning OFF cancels the running countdown');
    check(env.ctl.getState() === 'ready' && env.last().deferred === true, 'the downloaded update is kept, waiting for the user');
    for (const t of env.timers) if (!t.cleared) t.fn();
    await settle(env.ctl);
    check(env.spawnCalls.length === 0, 'no installer starts after the countdown time passes');
    check((await env.ctl.installOnExit('user_exit')).ok === false, 'the queued update does not install on exit');
  }
  {
    // The countdown timer fires after the preference changed but before
    // onAutomaticChanged ran: the timer itself re-reads the preference.
    const env = makeEnv('toggle-race', { initial: true });
    const inst = makeInstaller(env.dir);
    await manualToReady(env, inst);
    env.pref.set(false);
    for (const t of env.timers.slice()) if (!t.cleared) t.fn();
    await settle(env.ctl);
    check(env.spawnCalls.length === 0, 'a countdown that fires after OFF was saved does not install');
  }
  {
    const env = makeEnv('toggle-check', { initial: true });
    const inst = makeInstaller(env.dir);
    let release;
    const gate = new Promise((r) => { release = r; });
    env.au.checkForUpdates = async () => { env.calls.check += 1; await gate; return { updateInfo: null }; };
    env.ctl.start();
    const p = env.ctl.check('startup');
    await tick();
    check(env.ctl.getState() === 'checking', 'an automatic check is in flight');
    env.pref.set(false);
    const r = env.ctl.onAutomaticChanged(false);
    check(r.stopped.includes('automatic-check') && env.ctl.getState() === 'idle', 'turning OFF ends the automatic check in the interface');
    env.au.emit('update-available', infoFor(inst));
    release();
    await p;
    await settle(env.ctl);
    check(env.ctl.getState() === 'idle', 'the late answer of that check is discarded: no update is offered');
    check(env.calls.download === 0 && env.spawnCalls.length === 0, 'nothing downloaded, nothing installed');
  }
  {
    const env = makeEnv('toggle-installing', { initial: true });
    const inst = makeInstaller(env.dir);
    await manualToReady(env, inst);
    await env.ctl.installNow('user');
    const st = env.ctl.getState();
    env.pref.set(false);
    const r = env.ctl.onAutomaticChanged(false);
    check((st === 'installing' || st === 'restarting') && r.uninterruptible === true, 'an install that already started is reported as not safely interruptible');
    check(env.spawnCalls.length === 1, 'no second installer is started');
  }

  console.log('update-preference-smoke: ON restores the intended behaviour');
  {
    const env = makeEnv('on', { initial: false });
    const inst = makeInstaller(env.dir);
    env.pref.set(true);
    env.ctl.onAutomaticChanged(true);
    env.ctl.start();
    const p = env.ctl.check('startup');
    env.au.emit('checking-for-update');
    env.au.emit('update-available', infoFor(inst));
    const r = await p;
    check(r.ok === true && env.calls.check === 1, 'the startup check runs again');
    check(env.calls.download === 0, 'the download still waits for the user (unchanged 6.4 behaviour)');
    await env.ctl.download('user');
    env.au.emit('update-downloaded', infoFor(inst));
    await settle(env.ctl);
    check(env.countdownTimers().length === 1 && env.last().automatic === true, 'a downloaded update starts the restart countdown again');
  }
  {
    // No saved preference at all: identical to earlier releases.
    const env = makeEnv('default');
    env.ctl.start();
    const r = await env.ctl.check('startup');
    check(r.ok === true && env.calls.check === 1, 'no saved preference: automatic checks run (documented default)');
    check(!fs.existsSync(path.join(env.dir, prefMod.SETTINGS_FILE)), 'the default is never written as if the user chose it');
  }

  console.log('update-preference-smoke: interface copy matches the behaviour');
  {
    const U = messages.UPDATE_SETTINGS;
    check(U.TOGGLE_LABEL === 'Automatic app updates', 'the switch is labelled "Automatic app updates"');
    check(U.CHECK_BUTTON === 'Check for updates', 'the manual action is labelled "Check for updates"');
    const off = uiState.updateBannerView({ state: 'ready', deferred: true, automatic: false, version: TARGET });
    check(off.restartBtn === true && !/when you exit/i.test(off.msg), 'OFF + downloaded: banner does not promise an install on exit');
    check(/only when you choose Restart now/.test(off.msg), 'OFF + downloaded: banner says it installs only on Restart now');
    const on = uiState.updateBannerView({ state: 'ready', deferred: true, automatic: true, version: TARGET });
    check(/installs when you exit/.test(on.msg), 'ON + deferred: banner keeps the install-on-exit wording');
    const failedOff = uiState.updateBannerView({ state: 'failed', stage: 'check', automatic: false });
    check(!/next time the app starts/.test(failedOff.msg), 'OFF + failed check: no promise of an automatic retry');
  }

  console.log('update-preference-smoke: one preference, wired everywhere');
  {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
    check(/automaticEnabled:\s*automaticUpdatesEnabled/.test(main), 'the updater controller receives the preference');
    check(/updaterCtl\.isReady\(\)\s*&&\s*automaticUpdatesEnabled\(\)/.test(main), 'the exit path asks the preference before install-on-exit');
    check(/checkPortableUpdate\('startup'\)/.test(main) && /checkPortableUpdate\('interval'\)/.test(main), 'portable automatic checks pass their origin');
    check(!/setTimeout\(checkPortableUpdate,/.test(main), 'no portable check is scheduled without an origin');
    check(/origin !== 'user' && !automaticUpdatesEnabled\(\)/.test(main), 'the portable check refuses automatic origins when OFF');
    check((main.match(/createUpdatePreference\(/g) || []).length === 1, 'main.js creates exactly one preference store');
    for (const ch of ['update-preference-get', 'update-preference-set', 'update-check-now']) {
      check(security.IPC_INVOKE_CHANNELS.includes(ch), `IPC allowlist has ${ch}`);
      check(main.includes(`ipcMain.handle('${ch}'`), `main.js handles ${ch}`);
      check(preload.includes(`'${ch}'`), `preload exposes ${ch}`);
    }
    check(security.validateInvoke('update-preference-set', [false]).ok === true, 'the set channel accepts false');
    check(security.validateInvoke('update-preference-set', [true]).args[0] === true, 'the set channel passes true through');
    for (const bad of ['false', 0, null, undefined, {}, 'on']) {
      check(security.validateInvoke('update-preference-set', [bad]).ok === false, `the set channel rejects ${JSON.stringify(bad)}`);
    }
    check(/id="autoUpdateToggle"/.test(html) && /role="switch"/.test(html), 'About dialog has the switch (role="switch")');
    check(/<label class="update-switch" for="autoUpdateToggle">/.test(html), 'the switch has a real label');
    check(/id="updateCheckNowBtn"/.test(html), 'About dialog has "Check for updates"');
    check(/id="updateSettingsStatus"[^>]*role="status"/.test(html), 'results are announced through a status region');
    const aboutStart = html.indexOf('id="aboutOverlay"');
    const settingsPos = html.indexOf('id="updateSettings"');
    const aboutEnd = html.indexOf('id="fixConfirmOverlay"');
    check(aboutStart !== -1 && settingsPos > aboutStart && settingsPos < aboutEnd, 'the setting lives in the About dialog');
    check(/id="aboutBtn"/.test(html) && /class="app-footer-right"[\s\S]*id="aboutBtn"/.test(html), 'About opens from the footer, which every screen shows (including Unable to complete)');
    check(/autoUpdateToggle\.checked = !wanted;/.test(renderer), 'the switch holds its old position until the save is confirmed');
  }

  if (failures) { console.error(`\nupdate-preference-smoke: ${failures} FAILED`); process.exit(1); }
  console.log('\nupdate-preference-smoke: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
