'use strict';

/**
 * Public-feed update acceptance for a shipped older 1132 Fixer (Windows).
 *
 * Installs a *published* older installer (default: the real 6.3.3 asset),
 * launches it from the installed path, and lets it update itself through the
 * production feed (this repository's GitHub Releases `latest.yml`) to the
 * expected published version. Nothing is mocked: no local feed, no rewritten
 * app-update.yml. It then proves the same things the pair driver proves —
 * same directory, shortcuts, Add/Remove record, no side-by-side copy, data
 * intact — plus that the new version can be removed with its own uninstaller
 * (the entry Windows Settings runs) and that the published release does not
 * offer an update to itself.
 *
 * Run (elevated session), after the release is published:
 *
 *   node tools/packaged-legacy-update-acceptance.js --setup <path\1132-Fixer-Setup-6.3.3.exe>
 *        --target 6.4.0 [--asset <path\1132-Fixer-Setup-6.4.0.exe>] [--out update-acceptance/legacy-evidence]
 *
 * 6.3.1-6.3.3 relaunch through electron-builder's --force-run, which starts
 * the app de-elevated; the app then re-launches itself elevated, so Windows
 * shows ONE approval prompt for the relaunch. Approve it when it appears.
 * The final step installs the published asset given by --asset (checksum
 * verified by the caller) so the machine is left on the real release.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { createSanitizer } = require('../src/main/updater-log');
const args = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };

const SETUP = path.resolve(argOf('--setup', path.join(ROOT, 'update-acceptance', 'real-6.3.3', '1132-Fixer-Setup-6.3.3.exe')));
const TARGET = argOf('--target', '');
const ASSET = argOf('--asset', '');
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'update-acceptance', 'legacy-evidence')));
const FEED = 'https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml';
const PRODUCT_EXE = '1132 Fixer.exe';
const USER_DATA = path.join(process.env.APPDATA || '', '1132-fixer');
const UPDATER_LOG = path.join(USER_DATA, 'logs', 'updater.log');
const HANDOFF = path.join(USER_DATA, 'update-handoff.json');
const STATE = path.join(USER_DATA, 'update-state.json');
const UNINSTALL_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c20c91ed-7fa6-5700-98ba-65c22b67c802';
const INSTALL_KEY = 'HKLM\\Software\\c20c91ed-7fa6-5700-98ba-65c22b67c802';

const sanitize = createSanitizer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('SIGINT', () => console.log('  (ignoring console Ctrl+C event from a child process)'));
process.on('SIGBREAK', () => console.log('  (ignoring console Ctrl+Break event from a child process)'));
process.on('SIGHUP', () => console.log('  (ignoring console close event)'));
fs.mkdirSync(OUT, { recursive: true });

const report = { startedAt: new Date().toISOString(), setup: SETUP, target: TARGET, feed: FEED, cases: [] };
function record(id, status, detail, extra) {
  const row = { id, status, detail: sanitize(detail || ''), ...(extra || {}) };
  report.cases.push(row);
  console.log(`  ${status === 'passed' ? ' ok ' : status === 'failed' ? 'FAIL' : 'skip'}  ${id}${detail ? ` — ${row.detail}` : ''}`);
  return row;
}
const passed = (id, d, x) => record(id, 'passed', d, x);
const failed = (id, d, x) => record(id, 'failed', d, x);
const notRun = (id, d, x) => record(id, 'not-run', d, x);

function ps(script, timeoutMs = 60000, env = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: Object.assign({}, process.env, env) });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function regValue(key, name) {
  const r = spawnSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return null;
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(r.stdout || '');
  return m ? m[1] : null;
}
function isElevated() { return /S-1-16-12288|S-1-16-16384/.test(spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', timeout: 5000, windowsHide: true }).stdout || ''); }
function exeVersion(file) { return ps('(Get-Item -LiteralPath $env:FIXER_FILE).VersionInfo.ProductVersion', 60000, { FIXER_FILE: file }).out || null; }
function runningInstances() {
  const r = ps(`Get-Process -Name '1132 Fixer' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)|$($_.MainWindowHandle)" }`);
  return r.out ? r.out.split(/\r?\n/).filter(Boolean).map((l) => { const [id, p, h] = l.split('|'); return { pid: Number(id), path: p, window: h !== '0' }; }) : [];
}
function installRecord() {
  return {
    displayVersion: regValue(UNINSTALL_KEY, 'DisplayVersion'),
    uninstallString: regValue(UNINSTALL_KEY, 'UninstallString'),
    quietUninstall: regValue(UNINSTALL_KEY, 'QuietUninstallString'),
    installLocation: regValue(INSTALL_KEY, 'InstallLocation')
  };
}
function shortcutTargets() {
  const links = [
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', '1132 Fixer.lnk'),
    path.join(process.env.USERPROFILE || '', 'Desktop', '1132 Fixer.lnk'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '1132 Fixer.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '1132 Fixer.lnk')
  ];
  return links.filter((l) => fs.existsSync(l)).map((l) => ({ link: l, target: ps('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:FIXER_LINK); $s.TargetPath', 60000, { FIXER_LINK: l }).out }));
}
function installDirs() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  return [path.join(pf, '1132 Fixer'), path.join(pf, '1132 Fixer', '1132 Fixer'), path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '1132 Fixer'), path.join(process.env.LOCALAPPDATA || '', 'Programs', '1132 Fixer')]
    .filter((d) => d && fs.existsSync(path.join(d, PRODUCT_EXE)));
}
function logEvents(since) {
  try { return fs.readFileSync(UPDATER_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } }).filter((e) => !since || (e.ts && e.ts >= since)); } catch (_) { return []; }
}
function waitFor(pred, timeoutMs, everyMs = 1000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      let v = null;
      try { v = await pred(); } catch (_) { v = null; }
      if (v) return resolve({ ok: true, value: v, ms: Date.now() - t0 });
      if (Date.now() - t0 > timeoutMs) return resolve({ ok: false, ms: Date.now() - t0 });
      setTimeout(tick, everyMs);
    };
    tick();
  });
}
function runDetached(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }); } catch (err) { return resolve({ status: null, error: err.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ status: null, error: `timeout after ${timeoutMs} ms` }); }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); resolve({ status: null, error: err.message }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ status: code }); });
  });
}
function fetchText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': '1132-fixer-legacy-acceptance' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); return resolve(fetchText(new URL(res.headers.location, url).href, hops + 1)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8'); res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}
function captureWindow(pid, file) {
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }
public struct R { public int L, T, Rt, B; }
"@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Id ${pid} -ErrorAction Stop
$h = $p.MainWindowHandle
if ($h -eq 0) { Write-Output 'NOWINDOW'; exit 1 }
[W]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 400
$r = New-Object R
[W]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Rt - $r.L; $hh = $r.B - $r.T
if ($w -le 0 -or $hh -le 0) { Write-Output 'NORECT'; exit 1 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($env:FIXER_CAPTURE, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK ${'$'}w x ${'$'}hh"`;
  return ps(script, 30000, { FIXER_CAPTURE: file });
}
async function uninstallInstalled(label) {
  const rec = installRecord();
  if (!rec.quietUninstall) { passed(`${label}.no-existing-install`, 'nothing registered'); return true; }
  const m = /^"([^"]+)"\s*(.*)$/.exec(rec.quietUninstall);
  for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
  await sleep(1000);
  const r = await runDetached(m[1], m[2].split(' ').filter(Boolean), 300000);
  let gone = false;
  for (let i = 0; i < 60 && !gone; i++) { await sleep(2000); gone = !installRecord().displayVersion && !/Un_A\.exe/i.test(spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Un_A.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || ''); }
  const dirsLeft = installDirs();
  (gone && dirsLeft.length === 0 ? passed : failed)(`${label}.uninstall-existing`, `${rec.displayVersion} via its own uninstaller: exit ${r.status}; record gone=${gone}; files left: ${dirsLeft.join(', ') || 'none'}`);
  return gone && dirsLeft.length === 0;
}

(async () => {
  console.log(`packaged-legacy-update-acceptance: setup=${SETUP} target=${TARGET} out=${OUT}`);
  console.log('\n  ================================================================\n  DO NOT TOUCH THE 1132 FIXER TEST WINDOW. Approve the ONE Windows\n  approval prompt that appears when the updated app relaunches.\n  ================================================================\n');
  if (!TARGET) { failed('args', '--target <version> is required'); return finish(); }
  if (!fs.existsSync(SETUP)) { failed('args', `setup not found: ${SETUP}`); return finish(); }
  (isElevated() ? passed : failed)('host.elevated', isElevated() ? 'elevated session' : 'not elevated');
  if (!isElevated()) return finish();
  const legacyVersion = (/Setup-(\d+\.\d+\.\d+)/.exec(path.basename(SETUP)) || [])[1] || '?';

  // ---- 0. the production feed must already expose the target
  let feedYml = '';
  try { feedYml = await fetchText(FEED); } catch (err) { failed('feed.reachable', `${FEED}: ${err.message}`); return finish(); }
  const feedVersion = (/^version:\s*(\S+)/m.exec(feedYml) || [])[1];
  const feedPath = (/^path:\s*(\S+)/m.exec(feedYml) || [])[1];
  const feedAdmin = /isAdminRightsRequired/.test(feedYml);
  (feedVersion === TARGET && feedPath === `1132-Fixer-Setup-${TARGET}.exe` && !feedAdmin ? passed : failed)('feed.exposes-target', `latest.yml version=${feedVersion} path=${feedPath} isAdminRightsRequired=${feedAdmin}`);
  if (feedVersion !== TARGET) return finish();

  // ---- 1. clean slate (the installed build's own uninstaller), test-only state cleared
  if (!(await uninstallInstalled('prep'))) return finish();
  for (const f of [STATE, HANDOFF]) { try { fs.unlinkSync(f); } catch (_) {} }
  const marker = path.join(USER_DATA, 'acceptance-marker.json');
  fs.mkdirSync(USER_DATA, { recursive: true });
  const markerValue = { token: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString() };
  fs.writeFileSync(marker, JSON.stringify(markerValue));

  // ---- 2. install the published older version
  const inst = await runDetached(SETUP, ['/S'], 300000);
  await sleep(2000);
  const rec = installRecord();
  const dirs = installDirs();
  const legacyDir = rec.installLocation || dirs[0];
  const legacyExe = legacyDir ? path.join(legacyDir, PRODUCT_EXE) : null;
  const legacyOnDisk = legacyExe && fs.existsSync(legacyExe) ? exeVersion(legacyExe) : null;
  (inst.status === 0 && rec.displayVersion === legacyVersion && legacyOnDisk && legacyOnDisk.startsWith(legacyVersion) ? passed : failed)('install.legacy', `installer exit ${inst.status}; Add/Remove ${rec.displayVersion}; InstallLocation ${rec.installLocation}; exe ${legacyOnDisk}; dirs ${dirs.join(', ')}`);
  if (!legacyExe || !fs.existsSync(legacyExe)) return finish();
  const linksA = shortcutTargets();
  (linksA.length > 0 && linksA.every((l) => l.target.toLowerCase() === legacyExe.toLowerCase()) ? passed : failed)('install.legacy.shortcuts', linksA.map((l) => `${path.basename(path.dirname(l.link))}\\${path.basename(l.link)} -> ${l.target}`).join('; ') || 'no shortcuts');

  // ---- 3. launch it and let it update through the real feed
  let playwright;
  try { playwright = require('playwright'); } catch (_) { failed('deps.playwright', 'playwright not installed'); return finish(); }
  const { _electron: electron } = playwright;
  const logSince = new Date().toISOString();
  let app, page;
  try {
    app = await electron.launch({ executablePath: legacyExe, timeout: 60000 });
    page = await app.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  } catch (err) { failed('launch.legacy', err.message); return finish(); }
  const facts = await app.evaluate(({ app: a }) => ({ version: a.getVersion(), execPath: process.execPath, pid: process.pid })).catch(() => null);
  (facts && facts.version === legacyVersion && facts.execPath.toLowerCase() === legacyExe.toLowerCase() ? passed : failed)('launch.legacy', facts ? `runtime ${facts.version} at ${facts.execPath} pid ${facts.pid}` : 'no runtime facts');
  await sleep(2500);
  await page.screenshot({ path: path.join(OUT, '01-legacy-before-update.png') }).catch(() => {});
  const seen = [];
  const exitP = new Promise((resolve) => { app.process().once('exit', (code) => resolve({ code, at: Date.now() })); });
  let exited = null;
  exitP.then((e) => { exited = e; });
  const t0 = Date.now();
  while (!exited && Date.now() - t0 < 420000) {
    const t = await page.evaluate(() => (document.getElementById('ubMsg') || {}).textContent || '').catch(() => '');
    if (t && seen[seen.length - 1] !== t) { seen.push(t); console.log(`    banner: ${t}`); await page.screenshot({ path: path.join(OUT, `02-legacy-${String(seen.length).padStart(2, '0')}.png`) }).catch(() => {}); }
    await sleep(1000);
  }
  (exited ? passed : failed)('legacy.exits-for-update', exited ? `${legacyVersion} exited (code ${exited.code}) ${exited.at - t0} ms after launch; banner sequence: ${seen.join(' | ') || '(none)'}` : `${legacyVersion} still running after 7 min; banner sequence: ${seen.join(' | ') || '(none)'}`);
  (seen.some((s) => /download|update/i.test(s)) ? passed : failed)('legacy.discovered-update', seen.join(' | ') || 'no update banner text seen');
  if (!exited) { await app.close().catch(() => {}); return finish(); }

  // ---- 4. the published installer applies in place and relaunches
  const applied = await waitFor(() => { const r = installRecord(); return r.displayVersion === TARGET ? r : null; }, 240000, 2000);
  const targetExe = legacyExe;
  const onDisk = fs.existsSync(targetExe) ? exeVersion(targetExe) : null;
  (applied.ok && onDisk && onDisk.startsWith(TARGET) && applied.value.installLocation && applied.value.installLocation.toLowerCase() === legacyDir.toLowerCase() ? passed : failed)('update.applied-same-directory', applied.ok ? `Add/Remove ${applied.value.displayVersion}; InstallLocation ${applied.value.installLocation}; exe ${onDisk}` : `Add/Remove still ${installRecord().displayVersion} after ${applied.ms} ms; exe ${onDisk}`);
  console.log('    waiting for the relaunched app (approve the Windows prompt if it appears)');
  const relaunch = await waitFor(() => { const w = runningInstances().find((p) => p.window && p.path && p.path.toLowerCase() === targetExe.toLowerCase()); return w || null; }, 300000, 2000);
  (relaunch.ok ? passed : failed)('update.relaunched', relaunch.ok ? `pid ${relaunch.value.pid} at ${relaunch.value.path} after ${relaunch.ms} ms` : `no ${TARGET} window within ${relaunch.ms} ms`);
  if (relaunch.ok) {
    await sleep(6000);
    const cap = captureWindow(relaunch.value.pid, path.join(OUT, '03-target-after-relaunch.png'));
    (cap.code === 0 ? passed : notRun)('update.relaunch-screenshot', cap.out || cap.err);
  }
  const ev = logEvents(logSince);
  const startedNew = ev.find((e) => e.event === 'startup' && e.app === TARGET);
  const recovery = ev.find((e) => e.event === 'state' && e.to === 'recovery');
  const upToDate = ev.find((e) => e.event === 'check.up-to-date');
  (startedNew && !recovery ? passed : failed)('update.new-version-log', startedNew ? `startup app=${startedNew.app} execPath=${startedNew.execPath}${recovery ? '; RECOVERY state entered' : ''}` : 'no startup entry from the new version yet');
  (upToDate ? passed : notRun)('release.no-self-update', upToDate ? `check.up-to-date latest=${upToDate.latest}` : 'new version has not completed a feed check yet');

  // ---- 5. records after the update
  const dirsAfter = installDirs();
  (dirsAfter.length === 1 && dirsAfter[0].toLowerCase() === legacyDir.toLowerCase() ? passed : failed)('records.no-side-by-side', dirsAfter.join(', '));
  const linksB = shortcutTargets();
  (linksB.length > 0 && linksB.every((l) => l.target.toLowerCase() === targetExe.toLowerCase()) ? passed : failed)('records.shortcuts', linksB.map((l) => `${path.basename(path.dirname(l.link))}\\${path.basename(l.link)} -> ${l.target}`).join('; ') || 'no shortcuts');
  const recB = installRecord();
  (recB.displayVersion === TARGET && recB.uninstallString && recB.uninstallString.toLowerCase().includes(legacyDir.toLowerCase()) && recB.quietUninstall ? passed : failed)('records.uninstall-repaired', `DisplayVersion ${recB.displayVersion}; UninstallString ${recB.uninstallString}; QuietUninstallString ${recB.quietUninstall}`);
  let markerAfter = null;
  try { markerAfter = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (_) {}
  (markerAfter && markerAfter.token === markerValue.token ? passed : failed)('data.intact', markerAfter ? 'app data written before the update is unchanged' : 'marker missing');

  // ---- 6. close the relaunched app through its Exit control, reopen manually
  for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
  await sleep(2000);
  try {
    const app2 = await electron.launch({ executablePath: targetExe, timeout: 60000 });
    const page2 = await app2.firstWindow({ timeout: 60000 });
    await page2.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    await waitFor(() => page2.evaluate(() => { const s = document.body.dataset.compactState; return s && s !== 'checking' ? s : null; }), 30000);
    await sleep(3000);
    const f2 = await app2.evaluate(({ app: a }) => ({ version: a.getVersion(), execPath: process.execPath }));
    const footer = await page2.evaluate(() => (document.getElementById('appVersion') || {}).textContent || '').catch(() => '');
    const banner = await page2.evaluate(() => ({ visible: document.getElementById('updateBanner').classList.contains('visible'), text: [(document.getElementById('ubTitle') || {}).textContent, (document.getElementById('ubMsg') || {}).textContent].join(' — ') })).catch(() => ({ visible: false, text: '' }));
    await page2.screenshot({ path: path.join(OUT, '04-target-manual-reopen.png') }).catch(() => {});
    (f2.version === TARGET && f2.execPath.toLowerCase() === targetExe.toLowerCase() ? passed : failed)('reopen.manual', `runtime ${f2.version} at ${f2.execPath}; footer "${footer}"`);
    (!banner.visible || !/could not|previous version|available|download/i.test(banner.text) ? passed : failed)('reopen.no-stale-or-self-update-banner', banner.visible ? `banner: ${banner.text}` : 'no update banner');
    const ev2 = logEvents(logSince);
    const upToDate2 = ev2.find((e) => e.event === 'check.up-to-date' && e.app === TARGET);
    (upToDate2 ? passed : failed)('release.no-self-update', upToDate2 ? `check.up-to-date latest=${upToDate2.latest}` : 'no check.up-to-date logged by the new version');
    const since = new Date().toISOString();
    const exitP2 = new Promise((resolve) => { app2.process().once('exit', (code) => resolve({ code, at: Date.now() })); });
    const tExit = Date.now();
    await page2.click('#btnExit').catch(() => {});
    const ex = await Promise.race([exitP2, sleep(20000).then(() => null)]);
    await sleep(1500);
    const left = runningInstances();
    const reason = (logEvents(since).filter((e) => e.event === 'shutdown.start').pop() || {}).reason;
    (ex && left.length === 0 && reason === 'user_exit' ? passed : failed)('exit.graceful', ex ? `Exit control -> exit code ${ex.code} in ${ex.at - tExit} ms; shutdown reason ${reason || 'not logged'}; processes left ${left.length}` : 'no exit within 20 s');
    if (!ex) { for (const p of left) { try { process.kill(p.pid); } catch (_) {} } }
  } catch (err) { failed('reopen.manual', err.message); }

  // ---- 7. the new version uninstalls with its own uninstaller (the Settings entry)
  const ok = await uninstallInstalled('uninstall.new-version');

  // ---- 8. leave the machine on the published asset
  if (ASSET && fs.existsSync(ASSET) && ok) {
    const r = await runDetached(ASSET, ['/S'], 300000);
    await sleep(2000);
    const recF = installRecord();
    const exeF = recF.installLocation ? path.join(recF.installLocation, PRODUCT_EXE) : null;
    (r.status === 0 && recF.displayVersion === TARGET && exeF && fs.existsSync(exeF) ? passed : failed)('final.published-asset-installed', `installer exit ${r.status}; Add/Remove ${recF.displayVersion}; InstallLocation ${recF.installLocation}`);
  } else {
    notRun('final.published-asset-installed', ASSET ? 'skipped (uninstall did not complete)' : 'no --asset given');
  }
  try { fs.unlinkSync(marker); } catch (_) {}
  return finish();
})().catch((err) => { failed('driver', `threw: ${err && err.stack || err}`); finish(); setTimeout(() => process.exit(1), 200).unref(); });

function finish() {
  report.finishedAt = new Date().toISOString();
  const counts = { passed: 0, failed: 0, 'not-run': 0 };
  for (const c of report.cases) counts[c.status] = (counts[c.status] || 0) + 1;
  report.summary = counts;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = [`# Public-feed update acceptance — ${path.basename(SETUP)} → ${TARGET}`, '', `Host: ${os.release()} ${process.arch}. Feed: ${FEED}. Started ${report.startedAt}, finished ${report.finishedAt}.`, '', '| Case | Result | Detail |', '| --- | --- | --- |'];
  for (const c of report.cases) md.push(`| ${c.id} | ${c.status} | ${String(c.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  md.push('', `**${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run.**`, '');
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n'));
  console.log(`\npackaged-legacy-update-acceptance: ${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run → ${OUT}`);
  process.exitCode = counts.failed ? 1 : 0;
}
