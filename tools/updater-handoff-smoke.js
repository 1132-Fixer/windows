'use strict';

/**
 * Static wiring for the update handoff (September 2026 repair) plus a
 * fixture run of scripts/finalize-update-metadata.mjs.
 *
 *  - main.js hands off through src/main/updater.js, never quitAndInstall
 *    or autoInstallOnAppQuit (both reach for resources/elevate.exe, which
 *    this package deliberately does not ship);
 *  - the installer is spawned with --updated /S --fixer-relaunch /D=<dir>,
 *    verbatim arguments and a quoted argv0;
 *  - build/installer.nsh relaunches only on --fixer-relaunch, from
 *    $INSTDIR, and never runs taskkill /T;
 *  - preload, allowlist and main handlers agree on the five new channels;
 *  - the renderer signals app-ready and pulls the initial status;
 *  - release.yml and ci.yml run finalize-update-metadata.mjs, and
 *    validate-release-assets.mjs checks the published latest.yml;
 *  - finalize-update-metadata.mjs strips isAdminRightsRequired and fails on
 *    a hash / size / version mismatch (fixture in a temp dir).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = read('main.js');
const nsh = read('build/installer.nsh');
const preload = read('preload.js');
const renderer = read('renderer.js');
const html = read('index.html');
const security = require('../src/main/electron-security');
const releaseYml = read('.github/workflows/release.yml');
const ciYml = read('.github/workflows/ci.yml');
const validate = read('scripts/validate-release-assets.mjs');
const pkg = JSON.parse(read('package.json'));

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('updater-handoff-smoke: main.js hands off through the controller');
check(main.includes("require('./src/main/updater')"), 'main requires src/main/updater');
check(main.includes("require('./src/main/updater-log')"), 'main requires the sanitized updater log');
check(main.includes("require('./src/main/shutdown')"), 'main requires the shutdown-reason controller');
check(/autoUpdater\.autoInstallOnAppQuit = false/.test(main), 'autoInstallOnAppQuit is false');
check(!/autoUpdater\.quitAndInstall\(/.test(main), 'quitAndInstall is never called');
check(!/autoUpdater\.on\('update-downloaded'/.test(main), 'main registers no updater events of its own (controller owns them once)');
check(/autoUpdater\.logger = \{/.test(main), 'electron-updater logs through the sanitized updater log');
check(/updater\.start\(\);/.test(main) && /updater\.check\('startup'\)/.test(main) && /updater\.check\('interval'\)/.test(main), 'startup evaluates the handoff, then checks; interval re-checks go through the controller');
check(/installOnExit\(reason\)/.test(main) && /before-quit/.test(main), 'a deferred update installs on exit through the controller');
check(/shutdown\.request\(shutdown\.REASONS\.USER_EXIT\)/.test(main), 'quit-app records user_exit');
check(/shutdown\.request\(shutdown\.REASONS\.ELEVATED_RELAUNCH\)/.test(main), 'elevated relaunch records its own reason');
check(/shutdown\.request\(shutdown\.REASONS\.SECOND_INSTANCE\)/.test(main), 'second instance records its own reason');
check(/requestShutdown: \(reason\) => shutdown\.request\(reason\)/.test(main), 'the controller quits through the shutdown controller (update_restart)');
check(/logs', 'updater\.log'/.test(main), 'updater log lives under userData/logs (survives the update)');

console.log('updater-handoff-smoke: installer spawn');
const spawnBlock = main.slice(main.indexOf('function installerSpawnOptions'), main.indexOf('let updaterCtl = null;'));
check(spawnBlock.includes('windowsVerbatimArguments: true'), 'verbatim arguments (unquoted /D=)');
check(spawnBlock.includes('argv0: `"${installerPath}"`'), 'installer path quoted as argv0');
check(spawnBlock.includes('detached: true') && spawnBlock.includes("stdio: 'ignore'"), 'detached, no inherited stdio');
check(spawnBlock.includes("child.once('spawn'") && spawnBlock.includes("child.once('error'"), 'launch confirmed by the spawn event, failures by the error event');
check(!spawnBlock.includes('activeChildren'), 'installer is not a tracked fix child');
check(/reg\.exe', \['query'/.test(main) && /INSTALL_REGISTRY_KEY/.test(main), 'registered install location is read from the registry');

console.log('updater-handoff-smoke: build/installer.nsh');
const code = nsh.split(/\r?\n/).filter((l) => !/^\s*;/.test(l)).join('\n');
const customInit = code.slice(code.indexOf('!macro customInit'), code.indexOf('!macroend', code.indexOf('!macro customInit')));
check(!/taskkill/.test(customInit), 'customInit runs no taskkill (the installer is inside the app process tree)');
check(!/taskkill[^\n]*\/T\b/.test(code), 'no taskkill /T anywhere');
check(/StdUtils\.TestParameter\} \$R0 "fixer-relaunch"/.test(code), 'relaunch is gated on --fixer-relaunch');
check(/Exec '"\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}" --updated --fixer-relaunch'/.test(code), 'relaunches the installed executable with the relaunch flags');
check(/SetOutPath "\$INSTDIR"/.test(code.slice(code.indexOf('customInstall'))), 'relaunch working directory is the install directory');
check(!/ExecShellAsUser|--force-run/.test(code), 'no de-elevated relaunch path of its own');
check(pkg.build.nsis.perMachine === true && pkg.build.nsis.oneClick === true, 'installer stays per-machine one-click');
check(pkg.build.nsis.include === 'build/installer.nsh', 'installer.nsh is the include electron-builder compiles');
check(!fs.existsSync(path.join(ROOT, 'build', 'installer.nsi')), 'no custom installer.nsi (would drop the uninstaller)');

console.log('updater-handoff-smoke: IPC surface');
const channels = ['install-update-now', 'defer-update', 'update-retry', 'update-continue', 'update-diagnostics', 'update-status-get', 'update-app-ready'];
for (const ch of channels) {
  check(security.IPC_INVOKE_CHANNELS.includes(ch), `${ch} is allowlisted`);
  check(preload.includes(`ipcRenderer.invoke('${ch}')`), `${ch} is exposed by preload`);
  check(main.includes(`ipcMain.handle('${ch}'`), `${ch} is handled by main`);
}
check(security.IPC_SEND_CHANNELS.includes('update-status'), 'update-status stays a send channel');

console.log('updater-handoff-smoke: renderer');
check(renderer.includes('signalUpdateAppReady()') && renderer.includes("window.electronAPI.updateAppReady()"), 'renderer signals app-ready to close out a verified handoff');
check(renderer.includes('api.updateStatus().then(handleUpdateStatus)'), 'renderer pulls the initial update status');
for (const id of ['ubRetry', 'ubContinue', 'ubDiag', 'ubOk', 'updateInstallOverlay', 'updateDiagOverlay', 'updateDiagCopy', 'updateDiagClose']) {
  check(html.includes(`id="${id}"`), `index.html has #${id}`);
}
check(html.includes('>Retry<') && html.includes('>Dismiss<') && html.includes('Continue with current version') && html.includes('View diagnostic details'), 'the recovery actions (Retry, Dismiss, Continue with current version, View diagnostic details) are in the markup');
check(html.includes('id="ubTitle"') && html.includes('id="ubMsg"') && html.includes('id="ubPage"') && html.includes('id="ubNotNow"'), 'banner has a title, a message, the download-page link and Not now');
check(!/quitAndInstall|elevate\.exe/.test(renderer), 'renderer never names updater internals');

console.log('updater-handoff-smoke: release pipeline');
check(/finalize-update-metadata\.mjs --dist dist --expect-version/.test(releaseYml), 'release.yml finalizes latest.yml against the tag before upload');
check(releaseYml.indexOf('finalize-update-metadata') < releaseYml.indexOf('Create GitHub Release'), 'finalize runs before the release is created');
check(/finalize-update-metadata\.mjs --dist dist/.test(ciYml), 'ci.yml runs the same finalize step');
check(/isAdminRightsRequired/.test(validate) && /sha512/.test(validate) && /matches tag/.test(validate), 'validate-release-assets checks flag, hash and tag on the published latest.yml');
check(fs.existsSync(path.join(ROOT, 'scripts', 'finalize-update-metadata.mjs')), 'finalize-update-metadata.mjs exists');

console.log('updater-handoff-smoke: finalize-update-metadata.mjs fixture');
{
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), '1132-meta-'));
  const bytes = crypto.randomBytes(4096);
  const name = `1132-Fixer-Setup-${pkg.version}.exe`;
  fs.writeFileSync(path.join(dist, name), bytes);
  const sha = crypto.createHash('sha512').update(bytes).digest('base64');
  const yml = [
    `version: ${pkg.version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: ${sha}`,
    `    size: ${bytes.length}`,
    '    isAdminRightsRequired: true',
    `path: ${name}`,
    `sha512: ${sha}`,
    "releaseDate: '2026-09-05T00:00:00.000Z'",
    ''
  ].join('\r\n');
  fs.writeFileSync(path.join(dist, 'latest.yml'), '﻿' + yml);
  const script = path.join(ROOT, 'scripts', 'finalize-update-metadata.mjs');
  const check1 = spawnSync(process.execPath, [script, '--dist', dist, '--check'], { encoding: 'utf8' });
  check(check1.status === 1 && /isAdminRightsRequired/.test(check1.stderr + check1.stdout), '--check fails while the flag is present');
  const run = spawnSync(process.execPath, [script, '--dist', dist, '--expect-version', pkg.version], { encoding: 'utf8' });
  check(run.status === 0, `finalize succeeds on a consistent dist (${(run.stderr || '').trim().slice(0, 120)})`);
  const out = fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8');
  check(!/isAdminRightsRequired/.test(out), 'flag removed');
  check(!out.includes('\r') && !out.startsWith('﻿') && out.endsWith('\n'), 'LF, no BOM, final newline');
  check(out.split('\n').includes(`version: ${pkg.version}`) && out.includes(`sha512: ${sha}`), 'version and sha512 preserved');
  const check2 = spawnSync(process.execPath, [script, '--dist', dist, '--check'], { encoding: 'utf8' });
  check(check2.status === 0, '--check passes after finalize');
  fs.writeFileSync(path.join(dist, name), crypto.randomBytes(4096));
  const bad = spawnSync(process.execPath, [script, '--dist', dist], { encoding: 'utf8' });
  check(bad.status === 1 && /sha512/.test(bad.stderr), 'a changed installer fails the hash check');
  const wrongVersion = spawnSync(process.execPath, [script, '--dist', dist, '--expect-version', '9.9.9'], { encoding: 'utf8' });
  check(wrongVersion.status === 1 && /expected 9\.9\.9/.test(wrongVersion.stderr), 'a tag/version mismatch fails');
}

if (failures) { console.error(`\nupdater-handoff-smoke: ${failures} FAIL`); process.exit(1); }
console.log('\nupdater-handoff-smoke: PASS');
