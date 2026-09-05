'use strict';

/**
 * Real packaged update acceptance for 1132 Fixer (Windows).
 *
 * Installs version A with the real NSIS installer, launches it from the
 * installed path (the shortcut target), serves version B through
 * electron-updater's provider, approves the restart, and proves that:
 *
 *   - version A downloads and verifies B and reaches "Ready to restart";
 *   - A exits only after the installer process is confirmed started;
 *   - the installer applies B to the SAME install directory;
 *   - B reopens by itself, from the canonical installed executable, and
 *     its own updater log records the verified relaunch and completion;
 *   - a manual reopen still opens B; shortcuts, the Add/Remove record and
 *     the registered install location all point at B; no second copy
 *     exists; app data written before the update is still there.
 *
 * Run (elevated Windows session, UAC on or off):
 *
 *   node tools/build-update-test-pair.js
 *   node tools/packaged-update-acceptance.js [--builds update-acceptance/builds]
 *        [--out update-acceptance/evidence] [--port 47831] [--keep]
 *        [--scale 1] [--dry-run]
 *
 * Why elevated: the installer is per-machine (RequestExecutionLevel admin)
 * and the app's manifest requires administrator. From a non-elevated shell
 * every launch would need a UAC approval that no automation can click.
 * --dry-run checks the preconditions and the feed server only. Every case
 * that cannot run is reported as not-run, never as passed. The reboot step
 * of the acceptance list is reported as not-run: this driver cannot
 * survive a reboot; run the manual-reopen check again after one.
 *
 * Evidence: <out>/report.json, <out>/report.md, screenshots of A before
 * the update, the ready state, the install handoff notice, B after the
 * automatic relaunch (window capture), B after manual reopen, and the
 * sanitized updater log excerpt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { createSanitizer } = require('../src/main/updater-log');
const args = process.argv.slice(2);
const argOf = (flag, dflt) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };
const has = (flag) => args.includes(flag);

const BUILDS = path.resolve(argOf('--builds', path.join(ROOT, 'update-acceptance', 'builds')));
const OUT = path.resolve(argOf('--out', path.join(ROOT, 'update-acceptance', 'evidence')));
const PORT = Number(argOf('--port', 47831));
const KEEP = has('--keep');
const DRY = has('--dry-run');
const SCALE = Number(argOf('--scale', 1));
const PRODUCT_EXE = '1132 Fixer.exe';
const USER_DATA = path.join(process.env.APPDATA || '', '1132-fixer');
const UPDATER_LOG = path.join(USER_DATA, 'logs', 'updater.log');
const HANDOFF = path.join(USER_DATA, 'update-handoff.json');
const UNINSTALL_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\c20c91ed-7fa6-5700-98ba-65c22b67c802';
const INSTALL_KEY = 'HKLM\\Software\\c20c91ed-7fa6-5700-98ba-65c22b67c802';

const sanitize = createSanitizer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const report = { startedAt: new Date().toISOString(), host: {}, pair: null, cases: [], feedRequests: [] };
function record(id, status, detail, extra) {
  const row = { id, status, detail: sanitize(detail || ''), ...(extra || {}) };
  report.cases.push(row);
  console.log(`  ${status === 'passed' ? ' ok ' : status === 'failed' ? 'FAIL' : 'skip'}  ${id}${detail ? ` — ${row.detail}` : ''}`);
  return row;
}
const passed = (id, d, x) => record(id, 'passed', d, x);
const failed = (id, d, x) => record(id, 'failed', d, x);
const notRun = (id, d, x) => record(id, 'not-run', d, x);

// ---------------------------------------------------------------- helpers
function ps(script, timeoutMs = 60000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function regValue(key, name) {
  const r = spawnSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return null;
  const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(r.stdout || '');
  return m ? m[1] : null;
}
function isElevated() {
  const r = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return /S-1-16-12288|S-1-16-16384/.test(r.stdout || '');
}
function exeVersion(file) {
  const r = ps(`(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.ProductVersion`);
  return r.out || null;
}
function runningInstances() {
  const r = ps(`Get-Process -Name '1132 Fixer' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)|$($_.StartTime.ToString('o'))" }`);
  return r.out ? r.out.split(/\r?\n/).filter(Boolean).map((l) => { const [id, p, start] = l.split('|'); return { pid: Number(id), path: p, start }; }) : [];
}
function shortcutTargets() {
  const links = [
    path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', '1132 Fixer.lnk'),
    path.join(process.env.USERPROFILE || '', 'Desktop', '1132 Fixer.lnk'),
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '1132 Fixer.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '1132 Fixer.lnk')
  ];
  const out = [];
  for (const l of links) {
    if (!fs.existsSync(l)) continue;
    const r = ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${l.replace(/'/g, "''")}'); $s.TargetPath`);
    out.push({ link: l, target: r.out });
  }
  return out;
}
function installRecord() {
  return {
    displayVersion: regValue(UNINSTALL_KEY, 'DisplayVersion'),
    uninstallString: regValue(UNINSTALL_KEY, 'UninstallString'),
    quietUninstall: regValue(UNINSTALL_KEY, 'QuietUninstallString'),
    installLocation: regValue(INSTALL_KEY, 'InstallLocation'),
    legacyInstallPath: regValue('HKLM\\Software\\1132Fixer', 'InstallPath')
  };
}
function otherInstallDirs(canonical) {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', '1132 Fixer'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', '1132 Fixer', '1132 Fixer'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '1132 Fixer'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '1132 Fixer')
  ];
  return candidates.filter((d) => d && fs.existsSync(path.join(d, PRODUCT_EXE)) && path.resolve(d).toLowerCase() !== path.resolve(canonical).toLowerCase());
}
function readLog() {
  try { return fs.readFileSync(UPDATER_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } }); } catch (_) { return []; }
}
function logEvents(since) {
  return readLog().filter((e) => !since || (e.ts && e.ts >= since));
}
function waitFor(pred, timeoutMs, everyMs = 500) {
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
// Capture a top-level window of a process by PID (works for a window this
// driver did not launch — the automatically relaunched B).
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
$bmp.Save('${file.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK ${'$'}w x ${'$'}hh"
`;
  return ps(script, 30000);
}

// ---------------------------------------------------------------- feed server
function startFeed(pair) {
  const bDir = pair.b.dir;
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const name = path.posix.basename(url);
    const file = path.join(bDir, name);
    report.feedRequests.push({ at: new Date().toISOString(), method: req.method, url, range: req.headers.range || null });
    if (!name || !fs.existsSync(file) || path.dirname(path.resolve(file)) !== path.resolve(bDir)) {
      res.writeHead(404); res.end('not found'); return;
    }
    const st = fs.statSync(file);
    const type = name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'none', 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------- main
(async () => {
  console.log(`packaged-update-acceptance: builds=${BUILDS} out=${OUT} port=${PORT}${DRY ? ' (dry run)' : ''}`);
  report.host = { platform: process.platform, release: os.release(), arch: process.arch, elevated: isElevated(), node: process.version, scale: SCALE };
  if (process.platform !== 'win32') { notRun('host.windows', 'not Windows'); return finish(); }
  passed('host.windows', `Windows ${os.release()} ${process.arch}`);
  const pairFile = path.join(BUILDS, 'pair.json');
  if (!fs.existsSync(pairFile)) { failed('builds.present', `${pairFile} missing — run node tools/build-update-test-pair.js first`); return finish(); }
  const pair = JSON.parse(fs.readFileSync(pairFile, 'utf8'));
  report.pair = { a: pair.a.version, b: pair.b.version, feed: pair.feed };
  const feedUrl = new URL(pair.feed);
  if (Number(feedUrl.port) !== PORT) { failed('builds.feed-port', `pair built for ${pair.feed}, driver listening on ${PORT}`); return finish(); }
  for (const [label, b] of [['A', pair.a], ['B', pair.b]]) {
    const ok = fs.existsSync(b.setup) && fs.existsSync(b.latestYml);
    (ok ? passed : failed)(`builds.${label}`, ok ? `${path.basename(b.setup)} (${fs.statSync(b.setup).size} bytes)` : `missing ${b.setup} or latest.yml`);
  }
  const bYml = fs.readFileSync(pair.b.latestYml, 'utf8');
  const bMeta = { version: (/^version:\s*(\S+)/m.exec(bYml) || [])[1], path: (/^path:\s*(\S+)/m.exec(bYml) || [])[1], sha512: (/^sha512:\s*(\S+)/m.exec(bYml) || [])[1], size: Number((/^\s+size:\s*(\d+)/m.exec(bYml) || [])[1]) };
  const bBytes = fs.readFileSync(pair.b.setup);
  const bHash = crypto.createHash('sha512').update(bBytes).digest('base64');
  (bMeta.version === pair.b.version && bMeta.path === path.basename(pair.b.setup) && bMeta.sha512 === bHash && bMeta.size === bBytes.length && !/isAdminRightsRequired/.test(bYml) ? passed : failed)('feed.metadata-consistent', `latest.yml version=${bMeta.version} path=${bMeta.path} size=${bMeta.size} sha512=${bMeta.sha512 === bHash ? 'matches' : 'DIFFERS'} adminFlag=${/isAdminRightsRequired/.test(bYml)}`);

  let server = null;
  try { server = await startFeed(pair); passed('feed.server', `http://127.0.0.1:${PORT}/ serving ${pair.b.dir}`); }
  catch (err) { failed('feed.server', `could not listen on ${PORT}: ${err.message}`); return finish(); }

  if (!report.host.elevated) {
    notRun('host.elevated', 'this session is not elevated: the per-machine installer and the requireAdministrator app would each need a Windows approval prompt that automation cannot answer. Re-run from an elevated (Run as administrator) terminal.');
    for (const id of ['install.A', 'launch.A', 'update.ready', 'update.handoff', 'update.A-exits', 'update.B-applied', 'update.B-relaunched', 'update.B-executable-path', 'update.B-log', 'reopen.manual', 'records.shortcuts', 'records.registry', 'records.no-side-by-side', 'data.intact', 'reboot.reopen']) notRun(id, 'requires an elevated session');
    server.close();
    return finish();
  }
  passed('host.elevated', 'elevated session');
  if (DRY) { notRun('dry-run', 'preconditions and feed server verified; nothing installed'); server.close(); return finish(); }

  let playwright;
  try { playwright = require('playwright-core'); } catch (_) { failed('host.playwright', 'playwright-core not installed (npm ci)'); server.close(); return finish(); }
  const { _electron: electron } = playwright;

  // ---- 0. clean slate: remove any existing install (state recorded first)
  const before = installRecord();
  report.before = before;
  if (before.quietUninstall) {
    console.log(`  existing install ${before.displayVersion} at ${before.installLocation} — uninstalling`);
    const m = /^"([^"]+)"\s*(.*)$/.exec(before.quietUninstall);
    if (m) {
      const r = spawnSync(m[1], m[2].split(' ').filter(Boolean), { windowsHide: true, timeout: 180000 });
      await sleep(2000);
      const gone = !installRecord().displayVersion;
      (gone ? passed : failed)('prep.uninstall-existing', gone ? `removed ${before.displayVersion} (exit ${r.status})` : `still registered after uninstall (exit ${r.status})`);
    }
  } else {
    passed('prep.uninstall-existing', 'no existing install');
  }
  for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
  try { fs.unlinkSync(HANDOFF); } catch (_) {}
  const pending = path.join(process.env.LOCALAPPDATA || '', '1132-fixer-updater', 'pending');
  fs.rmSync(pending, { recursive: true, force: true });

  // App data written before the update must survive it.
  const marker = path.join(USER_DATA, 'acceptance-marker.json');
  fs.mkdirSync(USER_DATA, { recursive: true });
  const markerValue = { token: crypto.randomBytes(8).toString('hex'), at: new Date().toISOString() };
  fs.writeFileSync(marker, JSON.stringify(markerValue));
  const logSince = new Date().toISOString();

  // ---- 1. install A with the real installer
  {
    const r = spawnSync(pair.a.setup, ['/S'], { windowsHide: true, timeout: 300000 });
    await sleep(1500);
    const rec = installRecord();
    const exe = rec.installLocation ? path.join(rec.installLocation, PRODUCT_EXE) : null;
    const v = exe && fs.existsSync(exe) ? exeVersion(exe) : null;
    (r.status === 0 && rec.displayVersion === pair.a.version && v && v.startsWith(pair.a.version) ? passed : failed)('install.A', `installer exit ${r.status}; Add/Remove ${rec.displayVersion}; InstallLocation ${rec.installLocation}; exe ${v}`, { record: rec });
    report.installDir = rec.installLocation;
  }
  const installDir = report.installDir;
  const installedExe = installDir ? path.join(installDir, PRODUCT_EXE) : null;
  if (!installedExe || !fs.existsSync(installedExe)) { failed('install.A.exe', 'installed executable not found'); server.close(); return finish(); }
  const links = shortcutTargets();
  (links.length > 0 && links.every((l) => l.target.toLowerCase() === installedExe.toLowerCase()) ? passed : failed)('install.A.shortcuts', links.map((l) => `${path.basename(path.dirname(l.link))}\\${path.basename(l.link)} -> ${l.target}`).join('; ') || 'no shortcuts found');

  // ---- 2. launch A from the installed (shortcut target) path
  const launchArgs = SCALE !== 1 ? [`--force-device-scale-factor=${SCALE}`] : [];
  let app;
  let page;
  try {
    app = await electron.launch({ executablePath: installedExe, args: launchArgs, timeout: 60000 });
    page = await app.firstWindow({ timeout: 60000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  } catch (err) {
    failed('launch.A', `could not launch ${installedExe}: ${err.message}`); server.close(); return finish();
  }
  const aFacts = await app.evaluate(({ app: a }) => ({ version: a.getVersion(), execPath: process.execPath, packaged: a.isPackaged, pid: process.pid }));
  (aFacts.version === pair.a.version && aFacts.execPath.toLowerCase() === installedExe.toLowerCase() && aFacts.packaged ? passed : failed)('launch.A', `runtime ${aFacts.version} at ${aFacts.execPath} pid ${aFacts.pid}`);
  await waitFor(() => page.evaluate(() => { const s = document.body.dataset.compactState; return s && s !== 'checking' ? s : null; }), 30000);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, '01-A-before-update.png') });

  // ---- 3. observe check → download → verify → ready
  const bannerText = () => page.evaluate(() => (document.getElementById('ubMsg') || {}).textContent || '').catch(() => '');
  const seen = [];
  const readyWait = await waitFor(async () => {
    const t = await bannerText();
    if (t && seen[seen.length - 1] !== t) { seen.push(t); console.log(`    banner: ${t}`); }
    if (/^Downloading update/.test(t) && !report.downloadShot) { report.downloadShot = true; await page.screenshot({ path: path.join(OUT, '02-A-downloading.png') }).catch(() => {}); }
    return /^Ready to restart/.test(t) ? t : null;
  }, 240000, 300);
  (readyWait.ok ? passed : failed)('update.ready', readyWait.ok ? `"${readyWait.value}" after ${readyWait.ms} ms` : `never reached Ready to restart (last: "${seen[seen.length - 1] || ''}") after ${readyWait.ms} ms`, { bannerSequence: seen });
  (seen.some((t) => /^Downloading update/.test(t)) && seen.some((t) => /^Verifying update/.test(t)) ? passed : failed)('update.download-and-verify-observed', seen.join(' | '));
  const feedHits = report.feedRequests.map((r) => r.url);
  (feedHits.includes('/latest.yml') && feedHits.some((u) => u.endsWith(path.basename(pair.b.setup))) ? passed : failed)('feed.requested', feedHits.join(', '));
  await page.screenshot({ path: path.join(OUT, '03-A-ready-to-restart.png') });
  const stillRunning = runningInstances().some((p) => p.pid === aFacts.pid);
  (stillRunning ? passed : failed)('update.no-exit-before-ready', stillRunning ? 'A still running at ready' : 'A exited before approval');
  if (!readyWait.ok) { await app.close().catch(() => {}); server.close(); return finish(); }

  // ---- 4. approve the restart
  const exitPromise = new Promise((resolve) => { app.process().once('exit', (code) => resolve({ code, at: Date.now() })); });
  await page.click('#ubRestart');
  const overlay = await waitFor(() => page.evaluate(() => { const o = document.getElementById('updateInstallOverlay'); return o && !o.hidden ? (document.getElementById('updateInstallBody') || {}).textContent : null; }), 15000, 200).catch(() => ({ ok: false }));
  if (overlay.ok) await page.screenshot({ path: path.join(OUT, '04-A-install-handoff.png') }).catch(() => {});
  (overlay.ok ? passed : failed)('update.handoff-notice', overlay.ok ? overlay.value : 'installing notice not shown before exit');
  const approvedAt = Date.now();
  const exit = await Promise.race([exitPromise, sleep(90000).then(() => null)]);
  (exit ? passed : failed)('update.A-exits', exit ? `A exited ${exit.at - approvedAt} ms after approval (code ${exit.code})` : 'A did not exit within 90 s');
  // The handoff record must say installer-started before A is gone.
  let handoff = null;
  try { handoff = JSON.parse(fs.readFileSync(HANDOFF, 'utf8')); } catch (_) {}
  const handoffOk = handoff && (handoff.state === 'installer-started' || handoff.state === 'updated-pending-ready') && handoff.targetVersion === pair.b.version && handoff.installerPid;
  (handoffOk ? passed : failed)('update.handoff-record', handoff ? `state=${handoff.state} target=${handoff.targetVersion} installerPid=${handoff.installerPid} installDir=${handoff.installDir}` : 'no handoff record');

  // ---- 5. the installer applies B and relaunches it
  const relaunch = await waitFor(() => {
    const procs = runningInstances().filter((p) => p.pid !== aFacts.pid && p.path && p.path.toLowerCase() === installedExe.toLowerCase());
    return procs.length ? procs[0] : null;
  }, 240000, 1000);
  const bVersionOnDisk = fs.existsSync(installedExe) ? exeVersion(installedExe) : null;
  const recAfter = installRecord();
  (bVersionOnDisk && bVersionOnDisk.startsWith(pair.b.version) && recAfter.displayVersion === pair.b.version && recAfter.installLocation && recAfter.installLocation.toLowerCase() === installDir.toLowerCase() ? passed : failed)('update.B-applied', `exe ${bVersionOnDisk}; Add/Remove ${recAfter.displayVersion}; InstallLocation ${recAfter.installLocation}`, { record: recAfter });
  (relaunch.ok ? passed : failed)('update.B-relaunched', relaunch.ok ? `pid ${relaunch.value.pid} started ${relaunch.value.start} (${relaunch.ms} ms after approval)` : `no new 1132 Fixer process within ${relaunch.ms} ms`);
  if (relaunch.ok) {
    (relaunch.value.path.toLowerCase() === installedExe.toLowerCase() ? passed : failed)('update.B-executable-path', relaunch.value.path);
    await sleep(6000); // let B reach its ready screen and clear the handoff
    const cap = captureWindow(relaunch.value.pid, path.join(OUT, '05-B-after-auto-relaunch.png'));
    (cap.code === 0 ? passed : notRun)('update.B-screenshot', cap.code === 0 ? cap.out : `window capture unavailable: ${cap.out || cap.err}`);
  }
  // Evidence from B's own log: the relaunch was verified and completed.
  const events = logEvents(logSince);
  const verified = events.find((e) => e.event === 'relaunch.verified');
  const complete = events.find((e) => e.event === 'update.complete');
  const startedB = events.find((e) => e.event === 'startup' && e.app === pair.b.version);
  (verified && verified.to === pair.b.version && verified.execPath && verified.execPath.toLowerCase() === installedExe.toLowerCase() ? passed : failed)('update.B-log', verified ? `relaunch.verified ${verified.from} -> ${verified.to} at ${verified.execPath} (${verified.reason})` : 'no relaunch.verified entry in the updater log');
  (complete ? passed : failed)('update.B-complete', complete ? `update.complete version ${complete.version} (handoff cleared on ready)` : 'no update.complete entry (B never reported ready)');
  (startedB ? passed : failed)('update.B-runtime-version', startedB ? `B logged startup as app=${startedB.app} mode=${startedB.mode} arch=${startedB.arch}` : 'no startup entry from B');
  const handoffGone = !fs.existsSync(HANDOFF);
  (handoffGone ? passed : failed)('update.handoff-cleared', handoffGone ? 'handoff record removed after B was ready' : 'handoff record still present');
  const keyEvents = ['startup', 'check.start', 'metadata.resolved', 'download.start', 'download.progress', 'verify.ok', 'state', 'install.begin', 'install.location', 'installer.invoke', 'installer.started', 'shutdown.start', 'relaunch.verified', 'update.complete', 'update.failed', 'relaunch.failed'];
  const excerpt = events.filter((e) => keyEvents.includes(e.event) && !(e.event === 'state' && e.to === 'downloading' && e.from === 'downloading')).map((e) => JSON.stringify(e));
  fs.writeFileSync(path.join(OUT, 'updater-log-excerpt.jsonl'), excerpt.join('\n') + '\n');
  passed('evidence.log-excerpt', `${excerpt.length} entries in updater-log-excerpt.jsonl`);

  // ---- 6. close B, reopen manually from the installed path
  if (relaunch.ok) {
    ps(`Get-Process -Id ${relaunch.value.pid} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`);
    const closed = await waitFor(() => (runningInstances().some((p) => p.pid === relaunch.value.pid) ? null : true), 20000, 500);
    (closed.ok ? passed : failed)('reopen.B-closed-gracefully', closed.ok ? `B closed in ${closed.ms} ms via its window` : 'B did not close in 20 s');
    if (!closed.ok) { try { process.kill(relaunch.value.pid); } catch (_) {} }
  }
  try {
    const app2 = await electron.launch({ executablePath: installedExe, args: launchArgs, timeout: 60000 });
    const page2 = await app2.firstWindow({ timeout: 60000 });
    await page2.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    const f2 = await app2.evaluate(({ app: a }) => ({ version: a.getVersion(), execPath: process.execPath }));
    await waitFor(() => page2.evaluate(() => { const s = document.body.dataset.compactState; return s && s !== 'checking' ? s : null; }), 30000);
    await sleep(800);
    const banner = await page2.evaluate(() => ({ visible: document.getElementById('updateBanner').classList.contains('visible'), text: (document.getElementById('ubMsg') || {}).textContent }));
    await page2.screenshot({ path: path.join(OUT, '06-B-manual-reopen.png') });
    (f2.version === pair.b.version && f2.execPath.toLowerCase() === installedExe.toLowerCase() ? passed : failed)('reopen.manual', `runtime ${f2.version} at ${f2.execPath}`);
    (!banner.visible || !/could not be completed|previous version/i.test(banner.text) ? passed : failed)('reopen.no-stale-warning', banner.visible ? `banner: ${banner.text}` : 'no update banner');
    await app2.close().catch(() => {});
  } catch (err) {
    failed('reopen.manual', `could not relaunch ${installedExe}: ${err.message}`);
  }
  notRun('reboot.reopen', 'this driver cannot reboot the host; after a reboot, open 1132 Fixer and confirm the footer shows ' + pair.b.version);

  // ---- 7. records
  const linksAfter = shortcutTargets();
  (linksAfter.length > 0 && linksAfter.every((l) => l.target.toLowerCase() === installedExe.toLowerCase()) ? passed : failed)('records.shortcuts', linksAfter.map((l) => `${path.basename(path.dirname(l.link))}\\${path.basename(l.link)} -> ${l.target}`).join('; '));
  (recAfter.displayVersion === pair.b.version && recAfter.uninstallString && recAfter.uninstallString.toLowerCase().includes(installDir.toLowerCase()) ? passed : failed)('records.registry', `DisplayVersion ${recAfter.displayVersion}; UninstallString ${recAfter.uninstallString}; InstallLocation ${recAfter.installLocation}; legacy InstallPath ${recAfter.legacyInstallPath}`);
  const others = otherInstallDirs(installDir);
  (others.length === 0 ? passed : failed)('records.no-side-by-side', others.length ? `other copies: ${others.join(', ')}` : `only ${installDir}`);
  const pendingLeft = fs.existsSync(pending) ? fs.readdirSync(pending) : [];
  passed('records.updater-cache', pendingLeft.length ? `pending cache still holds ${pendingLeft.join(', ')} (electron-updater keeps it; cleared on next successful check)` : 'pending cache empty');

  // ---- 8. data intact
  let markerAfter = null;
  try { markerAfter = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (_) {}
  (markerAfter && markerAfter.token === markerValue.token ? passed : failed)('data.intact', markerAfter ? 'app data written before the update is unchanged' : 'app data marker missing after the update');
  try { fs.unlinkSync(marker); } catch (_) {}

  // ---- 9. leave the host as found?
  if (!KEEP) {
    const q = installRecord().quietUninstall;
    const m = q && /^"([^"]+)"\s*(.*)$/.exec(q);
    if (m) {
      spawnSync(m[1], m[2].split(' ').filter(Boolean), { windowsHide: true, timeout: 180000 });
      passed('cleanup.uninstalled-B', `removed test version ${pair.b.version} (use --keep to leave it installed)`);
    }
  } else {
    notRun('cleanup.uninstalled-B', '--keep: test version left installed');
  }
  server.close();
  return finish();
})().catch((err) => {
  failed('driver', `threw: ${err && err.stack || err}`);
  finish();
});

function finish() {
  report.finishedAt = new Date().toISOString();
  const counts = { passed: 0, failed: 0, 'not-run': 0 };
  for (const c of report.cases) counts[c.status] = (counts[c.status] || 0) + 1;
  report.summary = counts;
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  const md = [];
  md.push('# Packaged update acceptance — 1132 Fixer for Windows');
  md.push('');
  md.push(`Run: ${report.startedAt} → ${report.finishedAt}. Host: ${JSON.stringify(report.host)}.`);
  if (report.pair) md.push(`Pair: A ${report.pair.a} → B ${report.pair.b}, feed ${report.pair.feed}.`);
  if (report.installDir) md.push(`Install directory: ${sanitize(report.installDir)}`);
  md.push('');
  md.push(`**${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run.**`);
  md.push('');
  md.push('| Case | Status | Detail |');
  md.push('| --- | --- | --- |');
  for (const c of report.cases) md.push(`| ${c.id} | ${c.status} | ${String(c.detail).replace(/\|/g, '\\|')} |`);
  md.push('');
  md.push('Screenshots: 01-A-before-update, 02-A-downloading, 03-A-ready-to-restart, 04-A-install-handoff, 05-B-after-auto-relaunch, 06-B-manual-reopen. Log: updater-log-excerpt.jsonl.');
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n') + '\n');
  console.log(`\npackaged-update-acceptance: ${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run → ${OUT}`);
  process.exitCode = counts.failed ? 1 : 0;
}
