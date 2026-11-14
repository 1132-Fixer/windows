'use strict';

/**
 * Elevation, relaunch, and bounded-startup contracts for 1132 Fixer.
 * Static wiring plus unit tests of the token/integrity parsers.
 */

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const elev = require('../src/main/elevation');
const ps7 = require('../src/main/powershell7');
const bounded = require('../src/main/bounded-process');
const messages = require('../messages');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const security = fs.readFileSync(path.join(ROOT, 'src', 'main', 'electron-security.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'compact-shell.js'), 'utf8');
const afterPack = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack-verify-manifest.js'), 'utf8');
const boundedSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'bounded-process.js'), 'utf8');
const asynchronous = [];
let finished = false;
process.once('beforeExit', () => { if (!finished) { console.error('FAIL elevation-startup: unfinished async checks'); process.exitCode = 1; } });
function shippedFunction(source, name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!match) throw new Error('Maintained function missing: ' + name);
  const end = source.indexOf('\n}', match.index);
  if (end < 0) throw new Error('Maintained function boundary missing: ' + name);
  return source.slice(match.index, end + 2);
}
function shippedHandler(channel, adapters) {
  const start = main.indexOf("ipcMain.handle('" + channel + "',");
  const end = main.indexOf('\n});', start);
  if (start < 0 || end < start) throw new Error('Maintained IPC handler missing: ' + channel);
  let handler;
  vm.runInNewContext(main.slice(start, end + 4), { ...adapters, ipcMain: { handle: (_name, fn) => { handler = fn; } } }, { timeout: 1000 });
  return handler;
}

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('elevation-startup-smoke: non-elevated startup requests elevation');
check(main.includes('relaunchElevated'), 'main can relaunch elevated');
check(main.includes('if (!elevated)') && main.includes('relaunchElevated()'),
  'non-elevated whenReady attempts relaunch before the window');
{
  const elevSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'elevation.js'), 'utf8');
  check(/Start-Process[\s\S]*-Verb RunAs/.test(elevSrc), 'relaunch uses Windows runas');
  check(elevSrc.includes('preparePowerShellScript') && elevSrc.includes('resolvePowerShell7') && elevSrc.includes('stdinInput') &&
    ps7.PWSH_PATH === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' && ps7.SCRIPT_ARGS.includes('-Command'),
    'relaunch uses the maintained protected Core7 host, fixed bootstrap and bounded stdin');
  check(!/WindowsPowerShell|ExecutionPolicy|taskkill/.test(elevSrc), 'elevation selects no legacy host, policy bypass or PID tree kill');
  check(!elevSrc.includes('fixer-elev-') && !/['"]-File['"]/.test(elevSrc) && !/writeFileSync|os\.tmpdir/.test(elevSrc),
    'relaunch does not write a temp .ps1 (SAC blocks unknown scripts)');
  check(/Start-Process -FilePath '/.test(elevSrc) && !/Start-Process[^\n]*-LiteralPath/.test(elevSrc),
    'Start-Process uses its supported -FilePath parameter');
  check(elevSrc.includes('createBoundedProcessRunner') && boundedSource.includes("child.on('close', onClose)") &&
    elev.EXIT_CLOSE_GRACE_MS === bounded.DEFAULT_EXIT_CLOSE_GRACE_MS,
    'shared bounded runner reads output through actual close with inherited-handle grace');
  asynchronous.push(async () => {
    const fakeFs = { realpathSync: value => value,
      lstatSync: value => ({ isSymbolicLink: () => false, isFile: () => value === ps7.PWSH_PATH }) };
    const run = vm.runInNewContext('(' + shippedFunction(elevSrc, 'runPsCommand') + ')', {
      preparePowerShellScript: script => ps7.preparePowerShellScript(script, { fs: fakeFs })
    });
    const script = elev.buildRelaunchScript('C:\\Mock\\1132 Fixer.exe', ['--self-elevate-attempted']);
    let call;
    await run(script, 50, async (exe, args, timeoutMs, options) => { call = { exe, args, timeoutMs, options }; return { outcome: 'ok' }; });
    check(call.exe === ps7.PWSH_PATH && JSON.stringify(call.args) === JSON.stringify(ps7.SCRIPT_ARGS), 'actual elevation helper selects only protected Core7 bootstrap');
    check(call.options.stdinInput.toString('utf8') === script && !call.args.join(' ').includes('1132 Fixer.exe'), 'actual UAC script stays in stdin, outside argv');
    check(call.timeoutMs === 50, 'actual helper preserves bounded UAC deadline');
    let spawns = 0;
    const denied = await run(script, 50, async () => { spawns++; }, () => { throw new Error('host unavailable'); });
    check(denied.outcome === 'launch-error' && spawns === 0, 'unavailable protected host has no alternate executable fallback');
  });
}

console.log('elevation-startup-smoke: already-elevated does not relaunch');
check(/if \(await isElevatedSync\(\)\) \{[^\n]*return false;/.test(main),
  'relaunchElevated no-ops when already elevated');
check(main.includes('process.argv.includes(ELEVATE_RETRY_FLAG)'),
  'retry flag prevents a relaunch loop');

console.log('elevation-startup-smoke: UAC cancel reaches Administrator access required');
check(messages.WIZARD.ADMIN_TITLE === 'Administrator access required', 'admin heading');
check(messages.WIZARD.ADMIN_SUB.includes('fresh Windows setup used for Zoom'), 'admin explanation');
check(html.includes('Restart as administrator'), 'primary Restart as administrator in markup');
check(html.includes('id="closeBtn"') && html.includes('>Close<'), 'Close secondary exists');
check(renderer.includes('showAdminRequired()'), 'renderer has admin-required state');
check(renderer.includes("status.state === 'need-elevation'"), 'startup-status need-elevation drives that state');

console.log('elevation-startup-smoke: elevation cannot remain Admin rights unknown');
check(!renderer.includes('Admin rights unknown'), 'renderer never paints Admin rights unknown');
check(main.includes('return false') && main.includes("ipcMain.handle('is-elevated'"),
  'is-elevated catch returns false, not throw/unknown');
check(fs.readFileSync(path.join(ROOT, 'src', 'main', 'elevation.js'), 'utf8').includes('TOKEN_ELEVATED'),
  'probe reads TOKEN_ELEVATION');
check(!fs.readFileSync(path.join(ROOT, 'src', 'main', 'elevation.js'), 'utf8').includes('net.exe'),
  'elevation module does not use net.exe session');
check(!main.includes("spawn('net.exe', ['session']"), 'main no longer uses net session as elevation');

console.log('elevation-startup-smoke: every preflight stage resolves, rejects, or times out');
check(elev.ELEVATION_PROBE_MS > 0 && elev.STARTUP_DEADLINE_MS > 0, 'probe and startup have deadlines');
check(fs.readFileSync(path.join(ROOT, 'src', 'main', 'elevation.js'), 'utf8').includes('function snapshot'),
  'elevation controller has a synchronous snapshot');
check(fs.readFileSync(path.join(ROOT, 'src', 'main', 'elevation.js'), 'utf8').includes('whoami.exe'),
  'snapshot uses whoami integrity SID');
check(renderer.includes('STARTUP_DEADLINE_MS'), 'renderer races startup against a deadline');
check(main.includes("ipcMain.handle('startup-status'"), 'startup-status IPC exists');
check(preload.includes("startupStatus: () => ipcRenderer.invoke('startup-status')"),
  'preload exposes startupStatus');
check(security.includes("'startup-status'"), 'startup-status is allowlisted');

console.log('elevation-startup-smoke: startup timeout reaches actionable failure');
check(messages.WIZARD.UNABLE_TITLE === 'Unable to complete', 'Unable to complete copy');
check(messages.WIZARD.TRY_AGAIN === 'Try again', 'Try again copy');
check(renderer.includes('showUnableToComplete'), 'timeout handler exists');
check(renderer.includes("err.stage = 'startup-status'"), 'timeout records the stage');

console.log('elevation-startup-smoke: successful preflight reaches Ready to fix Zoom');
check(renderer.includes("status.state === 'need-elevation'") && renderer.includes('WIZARD.READY_TITLE'),
  'elevated startup shows Ready copy');
check(renderer.includes('runEnvironmentScan({ quiet: true })'),
  'full scan is quiet and cannot put Checking back on screen');
check(renderer.includes("if (!quiet)") && renderer.includes("setWizardPane('checking')"),
  'Checking pane is only set on a non-quiet scan');

console.log('elevation-startup-smoke: Frame Server cannot produce a false all-good result');
asynchronous.push(async () => {
  const handler = shippedHandler('preflight-scan', {
    preflightCheck: async () => ({ ok: true, info: { elevated: true, zoomPath: 'C:\\Mock\\Zoom.exe', zoomInstall: {} }, blockers: [], warnings: [] }),
    zoomDetect: { zoomStatusMessage: () => 'Synthetic Zoom installation' }, app: { getVersion: () => '6.4.0' }
  });
  const result = await handler();
  check(result.cards.frameServer.status === 'warning' && /not.*verified|not.*confirmed/i.test(result.cards.frameServer.message), 'actual Frame Server card remains explicitly unverified warning');
  check(result.canRunFix === true && result.overall === 'repairable', 'unknown Frame Server does not invent health success or block independent repair readiness');
});
check(!/Everything looks good/.test(messages.WIZARD.READY_TITLE + messages.WIZARD.READY_SUB),
  'Ready copy is not an all-good Zoom-health claim');

console.log('elevation-startup-smoke: Fix now and Open Zoom');
check(renderer.includes('await window.electronAPI.runFix()'), 'Fix now still invokes run-fix');
check(renderer.includes('showFixConfirm()'), 'Fix now still confirms first');
check(renderer.includes('launchBtn.hidden = !launch'), 'Open Zoom is gated by setActions launch');
check(renderer.includes("setActions({ fix: true, shortcutOption: true, details: true })") &&
  !/setActions\(\{[^}]*launch:\s*true[^}]*\}\);\s*runEnvironmentScan/.test(renderer),
  'Open Zoom is not enabled on the landing/startup path');

console.log('elevation-startup-smoke: cancellation, retry, success still exist');
check(renderer.includes('onFixButtonClick') && renderer.includes('showNoticePane'),
  'repair notice/success path remains');
check(shell.includes('requestCancel') && shell.includes('Try again') === false || renderer.includes("rescanLabel: WIZARD.TRY_AGAIN"),
  'Try again is wired for startup failure');

console.log('elevation-startup-smoke: layout and keyboard');
check(main.includes('function compactWindowBounds'), 'window uses compact centered bounds');
check(!main.includes('Math.max(minWidth, workArea.width)'), 'window does not start at work-area width');
check(renderer.includes("event.key !== 'Enter'") && renderer.includes('primary.click()'),
  'Enter activates the visible primary action');
check(/body \{[^}]*overflow: hidden/.test(html) && /\.workspace \{[^}]*overflow: hidden/.test(html) && !/\.wiz-pane\.active \{[^}]*overflow-y:\s*auto[^}]*\}[\s\S]*APP SHELL/.test(html.slice(html.indexOf('APP SHELL'))),
  'app root and workspace do not add a wizard scrollbar');

console.log('elevation-startup-smoke: packaged manifest verification is in the build');
check(pkg.build && pkg.build.win && pkg.build.win.requestedExecutionLevel === 'requireAdministrator',
  'electron-builder requests requireAdministrator');
check(pkg.build.afterPack === './scripts/after-pack-verify-manifest.js', 'afterPack verifies the exe manifest');
check(afterPack.includes('assertRequireAdministrator'), 'afterPack fails the build if the manifest is missing');
check(afterPack.includes('requestedExecutionLevel: \'requireAdministrator\'') || afterPack.includes('stampRequireAdministrator'),
  'afterPack stamps requireAdministrator before verify');
check(afterPack.includes('CopyElevateHelper') && afterPack.includes('__uninstaller.exe') && !/stampRequireAdmin\((?:file|uninstaller)/.test(afterPack.slice(afterPack.indexOf('__uninstaller.exe'))),
  'afterPack strips elevate.exe and leaves the NSIS uninstaller unmodified (its CRC must stay valid)');

console.log('elevation-startup-smoke: parser unit tests');
{
  const tokenTrue = elev.parseTokenProbe('TOKEN_ELEVATED=1\n');
  const tokenFalse = elev.parseTokenProbe('TOKEN_ELEVATED=0');
  const tokenBad = elev.parseTokenProbe('nope');
  check(tokenTrue.ok && tokenTrue.elevated === true, 'TOKEN_ELEVATED=1 is elevated');
  check(tokenFalse.ok && tokenFalse.elevated === false, 'TOKEN_ELEVATED=0 is not elevated');
  check(!tokenBad.ok, 'garbage token probe is not a pass');
  const high = elev.parseWhoamiIntegrity(`Mandatory Label\\High Mandatory Level  ${elev.HIGH_IL_SID}`);
  const medium = elev.parseWhoamiIntegrity('Mandatory Label\\Medium Mandatory Level  S-1-16-8192');
  check(high.ok && high.elevated === true, 'High IL SID is elevated');
  check(medium.ok && medium.elevated === false, 'Medium IL SID is not elevated');
  const argsPack = elev.relaunchArgList({
    isPackaged: true, appPath: 'C:\\app', argv: ['C:\\1132 Fixer.exe', '--foo'], retryFlag: '--self-elevate-attempted'
  });
  check(argsPack.includes('--self-elevate-attempted') && argsPack.includes('--foo'),
    'packaged relaunch preserves user args and adds retry flag');
  const argsDev = elev.relaunchArgList({
    isPackaged: false, appPath: 'G:\\app', argv: ['electron.exe', 'G:\\app'], retryFlag: '--self-elevate-attempted'
  });
  check(argsDev[0] === 'G:\\app' && argsDev.includes('--self-elevate-attempted'),
    'dev relaunch keeps the app path');
}

asynchronous.push(async () => {
  for (const [recovery, expected] of [[{ status: 'clear', verified: true }, 'ready'], [{ status: 'blocked', verified: false }, 'blocked'], [{ status: 'checking', verified: false }, 'blocked']]) {
    const handler = shippedHandler('startup-status', { Date: { now: () => 1000 }, elevation: { logStage: () => {} },
      elevCtl: { snapshot: () => ({ elevated: true, method: 'integrity-level' }) }, os: { userInfo: () => ({ username: 'operator' }) },
      FIX_USER: 'user1', nativeRecovery: recovery });
    const result = await handler();
    check(result.state === expected && (expected !== 'blocked' || result.stage === 'repair-recovery'), 'shipped startup cannot show Ready from unknown native recovery');
  }
});
(async () => {
  for (const invoke of asynchronous) {
    try { await invoke(); } catch (error) { check(false, 'shipped function check failed: ' + error.message); }
  }
  if (failures) { console.error('elevation-startup-smoke: ' + failures + ' failure(s)'); process.exitCode = 1; }
  else console.log('elevation-startup-smoke: all checks passed; shipped helpers use inert adapters');
  finished = true;
})().catch(error => { console.error('FAIL elevation-startup harness:', error.message); process.exitCode = 1; finished = true; });
