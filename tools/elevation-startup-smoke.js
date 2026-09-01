'use strict';

/**
 * Elevation, relaunch, and bounded-startup contracts for 1132 Fixer.
 * Static wiring plus unit tests of the token/integrity parsers.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const elev = require('../src/main/elevation');
const messages = require('../messages');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const security = fs.readFileSync(path.join(ROOT, 'src', 'main', 'electron-security.js'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'compact-shell.js'), 'utf8');
const afterPack = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack-verify-manifest.js'), 'utf8');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('elevation-startup-smoke: non-elevated startup requests elevation');
check(main.includes('relaunchElevated'), 'main can relaunch elevated');
check(main.includes('if (!elevated)') && main.includes('relaunchElevated()'),
  'non-elevated whenReady attempts relaunch before the window');
check(/Start-Process[\s\S]*-Verb RunAs/.test(fs.readFileSync(path.join(ROOT, 'src', 'main', 'elevation.js'), 'utf8')),
  'relaunch uses Windows runas');

console.log('elevation-startup-smoke: already-elevated does not relaunch');
check(main.includes('if (await isElevatedSync()) return false'),
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
check(main.includes("cards.frameServer = { status: 'warning'"),
  'missing Frame Server is a warning, not a Ready blocker');
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
check(shell.includes('overflow: hidden') && shell.includes('overflow: hidden !important'),
  'compact root does not add a wizard scrollbar');

console.log('elevation-startup-smoke: packaged manifest verification is in the build');
check(pkg.build && pkg.build.win && pkg.build.win.requestedExecutionLevel === 'requireAdministrator',
  'electron-builder requests requireAdministrator');
check(pkg.build.afterPack === './scripts/after-pack-verify-manifest.js', 'afterPack verifies the exe manifest');
check(afterPack.includes('assertRequireAdministrator'), 'afterPack fails the build if the manifest is missing');
check(afterPack.includes('requestedExecutionLevel: \'requireAdministrator\'') || afterPack.includes('stampRequireAdministrator'),
  'afterPack stamps requireAdministrator before verify');
check(afterPack.includes('CopyElevateHelper') && afterPack.includes('__uninstaller.exe'),
  'afterPack strips elevate.exe and stamps the NSIS uninstaller');

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

if (failures) {
  console.error(`elevation-startup-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('elevation-startup-smoke: all checks passed');
