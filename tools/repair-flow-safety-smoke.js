'use strict';

// Execute the shipped handlers with inert adapters. No Electron, DOM,
// clipboard, Windows mutations, UI automation, or network access.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
function functionSource(source, name) {
  let start = source.indexOf(`function ${name}(`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `production ${name} exists`);
  return source.slice(start, end + 2);
}

(async () => {
  for (const missing of ['overlay', 'continue', 'cancel']) {
    let repairs = 0;
    let notice = '';
    const context = {
      fixConfirmOverlay: missing === 'overlay' ? null : {},
      fixConfirmContinue: missing === 'continue' ? null : {},
      fixConfirmCancel: missing === 'cancel' ? null : {},
      WIZARD: { FAIL_TITLE: 'Repair unavailable' },
      runFix: () => { repairs++; }, showNoticePane: (_tone, _title, text) => { notice = text; },
      setActions: () => {}
    };
    vm.runInNewContext(functionSource(renderer, 'showFixConfirm') + '\nshowFixConfirm();', context);
    check(repairs === 0 && notice.includes('confirmation'), `missing ${missing} never starts repair`);
  }

  const copyStart = renderer.indexOf("copyErrBtn.addEventListener('click',");
  const copyEnd = renderer.indexOf('\n});', copyStart);
  assert.ok(copyStart >= 0 && copyEnd > copyStart);
  for (const outcome of ['missing', 'error', 'sanitized']) {
    let click;
    const writes = [];
    const context = {
      copyErrBtn: { addEventListener: (_name, handler) => { click = handler; } },
      lastReceipt: null, logBuffer: ['private fixture log must never reach clipboard'], lastStageLabel: 'fixture',
      COPY_ERR_LABEL: 'Copy error details', setTimeout: fn => fn(),
      window: { electronAPI: { supportReport: async () => {
        if (outcome === 'error') throw new Error('offline fixture');
        return outcome === 'sanitized' ? { markdown: 'safe support fixture' } : null;
      } } },
      navigator: { clipboard: { writeText: async text => writes.push(text) } }
    };
    vm.runInNewContext(renderer.slice(copyStart, copyEnd + 4), context);
    await click();
    check(outcome === 'sanitized' ? writes.length === 1 && writes[0] === 'safe support fixture' : writes.length === 0,
      `${outcome} report cannot fall back to raw logs`);
    check(context.copyErrBtn.disabled === false, `${outcome} copy action is released`);
  }

  let busy;
  let scopes = [];
  const context = {
    updaterCtl: null, fixInProgress: false, helperSettingsCustodyUnverified: false, activeChildren: new Set(),
    process: { env: {}, execPath: 'fixture', argv: [], arch: 'x64', platform: 'win32', resourcesPath: 'fixture' },
    app: { getVersion: () => 'fixture', getPath: () => 'fixture', isPackaged: true },
    criticalOps: { active: () => scopes },
    updaterMod: { createUpdaterController: options => { busy = options.isBusy; return {}; } },
    autoUpdater: {}, updaterLog: {}, sendUpdateStatus() {}, isElevatedSync() {},
    spawnInstallerDetached() {}, confirmInstallNoticeShown() {}, readRegisteredInstallDir() {},
    fs: { existsSync: () => true }, path, shutdown: { request() {} }
  };
  vm.runInNewContext(functionSource(main, 'getUpdater') + '\ngetUpdater();', context);
  for (const name of ['updater', 'update-install', 'update-retry', 'update-download']) {
    scopes = [name];
    check(busy() === false, `${name} cannot block its own updater operation`);
  }
  for (const name of ['repair', 'shortcut', 'zoom-launch', 'zoom-install', 'zoom-validate']) {
    scopes = [name];
    check(busy() === true, `${name} defers update handoff`);
  }
  scopes = [];
  context.activeChildren.add({});
  check(busy() === true, 'unresolved native child custody defers update');
  context.activeChildren.clear();
  context.fixInProgress = true;
  check(busy() === true, 'repair defers update even without a scoped-operation record');
  context.fixInProgress = false;
  context.helperSettingsCustodyUnverified = true;
  check(busy() === true, 'unverified credential-child exit retains updater custody');

  const settingsStart = main.indexOf('  const settingsNonce =');
  const settingsEnd = main.indexOf('  // STEP 8: Relaunch Zoom', settingsStart);
  assert.ok(settingsStart > 0 && settingsEnd > settingsStart);
  const nonce = '0123456789abcdef0123456789abcdef';
  const sid = 'S-1-5-21-100-200-300-1001';
  const good = { code: 0, timedOut: false, stderr: '', stdout:
    `FIXER_HELPER_SETTINGS_CUSTODY_V1=CLOSED\nFIXER_HELPER_SETTINGS_V1=${nonce}|${sid}|OK|OK` };
  for (const [name, result] of [
    ['healthy', good],
    ['settings-failed', { ...good, code: 1, stdout: 'FIXER_HELPER_SETTINGS_CUSTODY_V1=CLOSED\nFIXER_HELPER_SETTINGS_V1=UNVERIFIED' }],
    ['timeout', { ...good, timedOut: true }], ['missing-status', { ...good, code: undefined }],
    ['stderr', { ...good, stderr: 'unexpected output' }],
    ['duplicate', { ...good, stdout: good.stdout + '\nFIXER_HELPER_SETTINGS_CUSTODY_V1=CLOSED' }],
    ['stale', { ...good, stdout: good.stdout.replace(nonce, '00000000000000000000000000000000') }],
    ['exception', null]
  ]) {
    const steps = [];
    const frame = {
      crypto: { randomBytes: () => ({ toString: () => nonce }) }, helperSID: sid,
      FIX_USER: 'user1', newUserProfile: 'C:\\Users\\user1', fixPass: 'synthetic fixture',
      windowsTools: { resolveTool: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' },
      getFirstRunScriptPath: () => 'C:\\Program Files\\1132 Fixer\\resources\\zoom-firstrun-setup.ps1', getIconPath: () => 'C:\\Program Files\\1132 Fixer\\resources\\icon.ico',
      buildHelperSettingsScript: () => 'inert child', buildHelperSettingsLaunchScript: () => 'inert parent',
      helperSettingsCustodyUnverified: false, criticalOps: { poll() {} }, send() {}, warnings: [],
      step: (...args) => steps.push(args), steps,
      runPSScript: async () => {
        check(frame.helperSettingsCustodyUnverified === true, `${name}: custody is latched before dispatch`);
        if (!result) throw new Error('synthetic transport failure');
        return result;
      }
    };
    vm.runInNewContext('this.flow = (async () => {\n' + main.slice(settingsStart, settingsEnd) + '\nreturn { proceed: true }; })();', frame);
    let outcome;
    try { outcome = await frame.flow; } catch (error) { check(name === 'exception', 'only the injected transport exception rejects'); }
    const closed = ['healthy', 'settings-failed'].includes(name);
    check(frame.helperSettingsCustodyUnverified === !closed, `${name}: only strict current exit proof releases custody`);
    check(closed ? outcome.proceed === true : name === 'exception' || outcome.error === 'helper_settings_custody_unverified', `${name}: unknown exit prevents relaunch`);
    if (closed) check(steps.every(item => item[2] === (name === 'healthy' ? 'ok' : 'fail')), `${name}: settings success requires its separate receipt`);
  }

  for (const signature of ["process.on('uncaughtException',", "app.on('render-process-gone',"]) {
    const start = main.indexOf(signature);
    const end = main.indexOf('\n});', start);
    assert.ok(start > 0 && end > start);
    let handler;
    let kills = 0, exits = 0;
    const frame = {
      helperSettingsCustodyUnverified: true, console: { error() {} }, dialog: { showErrorBox() {} },
      process: { on: (_name, fn) => { handler = fn; } },
      app: { on: (_name, fn) => { handler = fn; }, exit: () => { exits++; }, relaunch: () => { exits++; } },
      killActiveChildren: () => { kills++; return true; }
    };
    vm.runInNewContext(main.slice(start, end + 4), frame);
    handler(new Error('synthetic fatal'), {}, { reason: 'crashed' });
    check(kills === 0 && exits === 0, `${signature} retains uncertain settings child even with no tracked children`);
  }

  const admissionStart = main.indexOf('const CRITICAL_IPC =');
  const admissionEnd = main.indexOf('\nlet inactivityCtl', admissionStart);
  assert.ok(admissionStart > 0 && admissionEnd > admissionStart);
  for (const first of ['run-fix', 'create-shortcut', 'launch-zoom-helper']) {
    const listeners = {};
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const frame = {
      ipcMain: { handle: (name, fn) => { listeners[name] = fn; } },
      helperSettingsCustodyUnverified: false, shutdown: { isShuttingDown: () => false },
      updaterCtl: null, updaterMod: { STATES: { INSTALLING: 'installing', RESTARTING: 'restarting' } },
      criticalOps: { run: (_scope, fn) => fn() }
    };
    vm.runInNewContext(main.slice(admissionStart, admissionEnd), frame);
    for (const name of ['run-fix', 'create-shortcut', 'launch-zoom-helper']) frame.ipcMain.handle(name, async () => { await barrier; return { success: true }; });
    const pending = listeners[first]({});
    for (const name of ['run-fix', 'create-shortcut', 'launch-zoom-helper']) {
      const result = await listeners[name]({});
      check(result.success === false && result.error === 'repair_in_progress', `${first} excludes concurrent ${name}`);
    }
    release();
    check((await pending).success === true, `${first} releases admission after completion`);
    check((await listeners['create-shortcut']({})).success === true, `${first} does not leave admission locked`);
  }

  for (const result of [
    { code: 0, timedOut: false, stderr: '', stdout: 'C:\\Users\\operator\\OneDrive\\Desktop' },
    { code: 1, timedOut: false, stderr: '', stdout: 'C:\\Users\\operator\\Desktop' },
    { code: 0, timedOut: true, stderr: '', stdout: 'C:\\Users\\operator\\Desktop' },
    { code: 0, timedOut: false, stderr: '', stdout: '' },
    { code: 0, timedOut: false, stderr: '', stdout: '..\\Desktop' }
  ]) {
    const frame = { path, runPSCapture: async () => result };
    vm.runInNewContext(functionSource(main, 'getCanonicalUserDesktop') + '\nthis.lookup = getCanonicalUserDesktop;', frame);
    try { const desktop = await frame.lookup(); check(desktop === result.stdout && desktop.includes('OneDrive'), 'verified redirected Desktop is retained'); }
    catch (_) { check(result !== undefined && !result.stdout.includes('OneDrive'), 'unknown Desktop never falls back to a guessed folder'); }
  }
  console.log(`repair-flow-safety-smoke: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
