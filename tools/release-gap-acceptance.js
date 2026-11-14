'use strict';

// Disposable hosted-runner diagnostics. Never run installers on the operator PC.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { _electron: electron } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'release-gap-evidence');
const version = require('../package.json').version;
const report = { sourceHead: process.env.GITHUB_SHA, version, evidenceClass: 'hosted-runner-diagnostic',
  releaseEligible: false, cases: [], limitations: ['UAC accept/cancel not observed', 'Windows Home not tested',
    'real helper repair and six support journeys remain required'] };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let currentApp = null;
let closeUnverified = false;
const diagnosticCopies = new Map();
function saveReport() {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
}
function record(id, detail) { report.cases.push({ id, status: 'passed', detail }); saveReport(); console.log(`PASS ${id}`); }
async function run(exe, args, timeout = 180000) {
  await new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      // Retain the original child handle. Stop this run rather than overlap installers.
      child.kill(); reject(new Error(`child deadline: ${path.basename(exe)}`));
    }, timeout);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${path.basename(exe)}`)); });
  });
}
async function closeApp() {
  if (closeUnverified) throw new Error('App close unverified; runner retains custody until job teardown');
  if (currentApp) {
    let timer;
    try {
      await Promise.race([currentApp.close(), new Promise((_, reject) => {
        timer = setTimeout(() => { closeUnverified = true; reject(new Error('App close exceeded 20 seconds; no further installer may run')); }, 20000);
      })]);
      currentApp = null;
    } finally { clearTimeout(timer); }
  }
}
async function diagnose(id, action) {
  try { await action(); }
  catch (error) {
    report.cases.push({ id, status: 'failed', detail: String(error.stack || error) });
    saveReport();
    console.error(error); process.exitCode = 1;
    if (currentApp) {
      try { await currentApp.windows()[0].screenshot({ path: path.join(out, `${id}-failed.png`) }); } catch (_) { /* preserve the original failure */ }
    }
  } finally { await closeApp(); }
}
async function open(exe, expected, extraEnv = {}) {
  const asar = require('@electron/asar');
  const archive = path.join(path.dirname(exe), 'resources', 'app.asar');
  // Upgrade tests replace archives at the same path; cached offsets belong
  // to the previous version, not the newly installed package.
  asar.uncache(archive);
  assert.equal(JSON.parse(asar.extractFile(archive, 'package.json').toString()).version, expected);
  const sourceHash = hash(exe);
  const archiveHash = hash(archive);
  const key = sourceHash + archiveHash;
  let diagnosticExe = diagnosticCopies.get(key);
  if (!diagnosticExe) {
    const copy = path.join(process.env.RUNNER_TEMP, `fixer-ui-${key.slice(0, 16)}`);
    fs.cpSync(path.dirname(exe), copy, { recursive: true });
    diagnosticExe = path.join(copy, path.basename(exe));
    await require('../scripts/stamp-exe-manifest').stampExecutionLevel(diagnosticExe, 'asInvoker');
    assert.equal(hash(exe), sourceHash, 'installed/extracted executable remains unchanged');
    assert.equal(hash(path.join(copy, 'resources', 'app.asar')), archiveHash);
    diagnosticCopies.set(key, diagnosticExe);
  }
  currentApp = await electron.launch({ executablePath: diagnosticExe, timeout: 45000,
    env: { ...process.env, ...extraEnv } });
  const page = await currentApp.firstWindow({ timeout: 45000 });
  await page.waitForLoadState('domcontentloaded');
  assert.equal(await currentApp.evaluate(({ app }) => app.getVersion()), expected);
  // Do not request shutdown while startup still owns Windows probe children.
  await page.waitForFunction(() => !document.getElementById('wizChecking').classList.contains('active'), null, { timeout: 90000 });
  return page;
}
async function uninstall(dir, id) {
  await closeApp();
  const name = fs.readdirSync(dir).find(n => /^Uninstall.*\.exe$/i.test(n));
  assert.ok(name, 'the current 6.5.0 uninstaller exists');
  // Match electron-builder's ExecWait contract. _?= must be last; without
  // it NSIS starts a temporary copy and the original process exits early.
  await run(path.join(dir, name), ['/S', '/KEEP_APP_DATA', `_?=${dir}`]);
  assert.equal(fs.existsSync(path.join(dir, '1132 Fixer.exe')), false);
  record(id, '6.5.0 uninstaller exited successfully and removed the app executable');
}
async function faultScreens(exe, mode, env) {
  for (const kind of ['error', 'timeout']) {
    const page = await open(exe, version, env);
    await currentApp.evaluate(({ ipcMain }, faultKind) => {
      ipcMain.removeHandler('startup-status');
      ipcMain.handle('startup-status', () => ({ elevated: true, state: 'ready', runningAsTarget: false }));
      ipcMain.removeHandler('preflight-scan');
      ipcMain.handle('preflight-scan', () => ({
        cards: { admin: { status: 'ready', label: 'Administrator' }, zoom: { status: 'unknown', label: 'Zoom Workplace' } },
        overall: 'unknown', canRunFix: false, blockers: [], warnings: [], info: {},
        scanIssues: [{ operation: 'windows-checks', kind: faultKind, code: faultKind === 'timeout' ? 'ETIMEDOUT' : 'EACCES' }]
      }));
    }, kind);
    await page.reload();
    await page.getByText('Unable to complete', { exact: true }).first().waitFor();
    const text = await page.locator('.wiz-pane.active').innerText();
    assert.match(text, /Windows tools, Zoom and Secondary Logon/i);
    if (kind === 'error') assert.doesNotMatch(text, /did not finish in time/);
    else assert.match(text, /did not finish in time/);
    assert.equal(await page.locator('#fixBtn').isVisible(), false);
    assert.equal(await page.locator('#rescanBtn').innerText(), 'Try again');
    await page.screenshot({ path: path.join(out, `${mode}-${kind}.png`) });
    record(`${mode}.startup-${kind}`, 'Packaged renderer names the injected operation and keeps Fix now unavailable');
    // Retry must replace the fault pane with a fresh result, not leave stale UI.
    await currentApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('preflight-scan');
      ipcMain.handle('preflight-scan', () => ({ cards: { zoom: { status: 'blocked', label: 'Zoom Workplace' } },
        canRunFix: false, overall: 'blocked', blockers: [], warnings: [], info: {} }));
    });
    await page.click('#rescanBtn');
    await page.getByText('Action required', { exact: true }).first().waitFor();
    record(`${mode}.retry-${kind}`, 'Try again left the injected failure and displayed the fresh blocked result');
    await closeApp();
  }
  const page = await open(exe, version, env);
  // A user check is correctly refused while startup owns child processes.
  await page.waitForFunction(() => !document.getElementById('wizChecking').classList.contains('active'), null, { timeout: 90000 });
  // Fault injection is confined to this test process. App bytes and security settings stay intact.
  await currentApp.evaluate(({ app }) => {
    const load = process.getBuiltinModule('module').createRequire(
      process.getBuiltinModule('path').join(app.getAppPath(), 'package.json'));
    const { autoUpdater } = load('electron-updater');
    autoUpdater.checkForUpdates = async () => {
      const error = new Error('getaddrinfo ENOTFOUND'); error.code = 'ENOTFOUND'; throw error;
    };
    const https = process.getBuiltinModule('https');
    const { EventEmitter } = process.getBuiltinModule('events');
    https.get = () => {
      const req = new EventEmitter(); req.destroy = () => {}; req.setTimeout = () => req;
      process.nextTick(() => req.emit('error', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })));
      return req;
    };
  });
  await page.click('#aboutBtn');
  await page.focus('#autoUpdateToggle');
  if (await page.locator('#autoUpdateToggle').isChecked()) await page.keyboard.press('Space');
  await page.waitForFunction(() => document.getElementById('autoUpdateState').textContent === 'Off');
  await page.click('#updateCheckNowBtn');
  await page.waitForFunction(() => {
    const s = document.getElementById('updateSettingsStatus').textContent;
    return s.trim().length > 0 && !/Checking for updates/.test(s);
  }, null, { timeout: 45000 });
  const text = await page.locator('#updateSettingsStatus').innerText();
  assert.match(text, /could|unable|internet|offline|failed/i, `offline result: ${text}`);
  assert.doesNotMatch(text, /latest version|up to date/i);
  assert.equal(await page.locator('#autoUpdateToggle').isChecked(), false);
  await page.screenshot({ path: path.join(out, `${mode}-offline.png`) });
  record(`${mode}.offline-check`, text);
  await closeApp();
}
async function supportJourneys(exe, mode, env) {
  const page = await open(exe, version, env);
  for (const [journey, field, submit, status, back] of [
    ['contact', 'fbContactText', 'fbContactSubmit', 'fbContactStatus', 'fbContactBack'],
    ['bug', 'fbBugText', 'fbBugSubmit', 'fbBugStatus', 'fbBugBack'],
    ['rating', 'fbRatingText', 'fbRatingSubmit', 'fbRatingStatus', 'fbRatingBack']
  ]) {
    if (journey === 'contact') await page.click('#btnSupport');
    await page.click(`[data-mode="${journey}"]`);
    const draft = `Release ${version} disposable acceptance diagnostic: verify unavailable support keeps this test draft.`;
    await page.fill(`#${field}`, draft);
    if (journey === 'rating') await page.click('[data-cat="overall"] [data-val="5"]');
    await page.click(`#${submit}`);
    await page.waitForFunction(id => {
      const e = document.getElementById(id);
      return e && e.classList.contains('err') && e.textContent.trim().length > 0;
    }, status, { timeout: 45000 });
    assert.equal(await page.locator(`#${field}`).inputValue(), draft);
    const detail = await page.locator(`#${status}`).innerText();
    await page.screenshot({ path: path.join(out, `${mode}-support-${journey}.png`) });
    record(`${mode}.support-${journey}`, `Live configured endpoint: failure shown, draft kept. ${detail}`);
    await page.click(`#${back}`);
  }
  await closeApp();
}
(async () => {
  assert.equal(process.platform, 'win32');
  assert.equal(process.env.GITHUB_ACTIONS, 'true');
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.ok(process.env.RUNNER_TEMP);
  fs.mkdirSync(out, { recursive: true });
  const installDir = path.join(process.env.RUNNER_TEMP, 'fixer-650-acceptance');
  assert.equal(fs.existsSync(installDir), false, 'fresh disposable install directory');
  const userData = path.join(process.env.APPDATA, '1132-fixer');
  assert.equal(fs.existsSync(userData), false, 'no existing app state on disposable runner');
  const setup = path.join(dist, `1132-Fixer-Setup-${version}.exe`);
  const portable = path.join(dist, `1132-Fixer-Portable-${version}.exe`);
  report.packages = { setup: { name: path.basename(setup), sha256: hash(setup) },
    portable: { name: path.basename(portable), sha256: hash(portable) } };
  const retained = path.join(root, 'retained-candidate');
  if (fs.existsSync(retained)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(retained, 'release-candidate.json')));
    const { verifyCandidateManifest } = await import('../scripts/release-candidate.mjs');
    verifyCandidateManifest({ dist: retained, manifest, head: manifest.sourceHead, version,
      setupSha256: report.packages.setup.sha256, portableSha256: report.packages.portable.sha256 });
    report.driverHead = report.sourceHead;
    report.sourceHead = manifest.sourceHead;
    report.candidate = manifest;
    record('candidate.exact-retained-bytes', 'All retained asset sizes and SHA-256 values verified before installation');
  }
  const baselineDir = path.join(root, 'baseline-640');
  const baseline = path.join(baselineDir, '1132-Fixer-Setup-6.4.0.exe');
  const baselineManifest = fs.readFileSync(path.join(baselineDir, 'checksums-sha256.txt'), 'utf8');
  assert.ok(baselineManifest.split(/\r?\n/).some(line => line.trim() === `${hash(baseline)}  ${path.basename(baseline)}`));
  record('baseline.checksum', 'Published 6.4.0 Setup matches its checksum manifest');
  const exe = path.join(installDir, '1132 Fixer.exe');
  await run(setup, ['/S', '/allusers', `/D=${installDir}`]);
  await open(exe, version);
  record('setup.clean-install', 'Exact Setup installed; payload version ' + version + ' verified and byte-identical app.asar launched through diagnostic host');
  await closeApp();
  const runtimeHash = hash(path.join(installDir, 'resources', 'app.asar'));
  assert.equal(runtimeHash, hash(path.join(dist, 'win-unpacked', 'resources', 'app.asar')));
  record('setup.payload-binding', 'Installed app.asar matches the packaged build');
  await diagnose('setup.fault-diagnostics', () => faultScreens(exe, 'setup'));
  await diagnose('setup.support-diagnostics', () => supportJourneys(exe, 'setup'));
  await uninstall(installDir, 'setup.clean-uninstall');
  // Keep userData to test preservation. Never execute 6.4.0's uninstaller.
  await run(baseline, ['/S', '/allusers', `/D=${installDir}`]);
  await open(exe, '6.4.0'); await closeApp();
  record('upgrade.baseline-launch', 'Published 6.4.0 installed; its unchanged app.asar launched through diagnostic host');
  fs.mkdirSync(userData, { recursive: true });
  const marker = path.join(userData, 'release-upgrade-marker.txt');
  fs.writeFileSync(marker, 'preserve-during-650-upgrade');
  const pref = require('../src/main/update-preference').createUpdatePreference({ userDataDir: userData });
  assert.equal(pref.set(false).ok, true);
  await run(setup, ['/S', '/allusers', `/D=${installDir}`]);
  const page = await open(exe, version);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve-during-650-upgrade');
  assert.equal(hash(path.join(installDir, 'resources', 'app.asar')), runtimeHash);
  await page.click('#aboutBtn');
  await page.waitForFunction(() => document.getElementById('autoUpdateState').textContent === 'Off');
  assert.equal(await page.locator('#autoUpdateToggle').isChecked(), false);
  record('upgrade.640-to-650', 'Same install path, correct payload/version, app data and OFF preference preserved');
  await uninstall(installDir, 'upgrade.uninstall-650');
  const extract = path.join(process.env.RUNNER_TEMP, 'fixer-portable-650');
  const sevenZip = path.join(process.env.ProgramFiles, '7-Zip', '7z.exe');
  await run(sevenZip, ['x', portable, `-o${extract}`, '-y']);
  const payload = fs.readdirSync(extract, { recursive: true }).find(n => /app-64\.7z$/i.test(n));
  assert.ok(payload, 'Portable x64 payload exists');
  const runtime = path.join(extract, 'runtime');
  await run(sevenZip, ['x', path.join(extract, payload), `-o${runtime}`, '-y']);
  const portableExe = path.join(runtime, '1132 Fixer.exe');
  assert.equal(hash(path.join(runtime, 'resources', 'app.asar')), runtimeHash);
  const env = { PORTABLE_EXECUTABLE_DIR: extract, PORTABLE_EXECUTABLE_FILE: portable };
  await open(portableExe, version, env); await closeApp();
  record('portable.extract-launch', 'Exact Portable payload extracted; unchanged app.asar matches Setup and launches through diagnostic host');
  await diagnose('portable.fault-diagnostics', () => faultScreens(portableExe, 'portable', env));
  await diagnose('portable.support-diagnostics', () => supportJourneys(portableExe, 'portable', env));
})().catch(error => {
  report.cases.push({ id: 'driver', status: 'failed', detail: String(error.stack || error) });
  console.error(error); process.exitCode = 1;
}).finally(async () => {
  try { await closeApp(); } catch (error) { report.cases.push({ id: 'closeout', status: 'failed', detail: error.message }); process.exitCode = 1; }
  saveReport();
  // A failed close cannot permit overlapping installs. The disposable hosted
  // job owns remaining runtime processes and tears them down at job completion.
  if (closeUnverified) process.exit(1);
});
