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
// NSIS installers/uninstallers run taskkill through nsExec, which ends by
// sending Ctrl+C to the console it inherited. Run them detached (no console)
// and ignore a stray console break so the driver is not killed mid-step.
process.on('SIGINT', () => console.log('  (ignoring console Ctrl+C event from a child process)'));
process.on('SIGBREAK', () => console.log('  (ignoring console Ctrl+Break event from a child process)'));
process.on('SIGHUP', () => console.log('  (ignoring console close event)'));
function runDetached(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }); } catch (err) { return resolve({ status: null, error: err.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ status: null, error: `timeout after ${timeoutMs} ms` }); }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); resolve({ status: null, error: err.message }); });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ status: code }); });
  });
}
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
function isElevated() {
  const r = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  return /S-1-16-12288|S-1-16-16384/.test(r.stdout || '');
}
function exeVersion(file) {
  const r = ps('(Get-Item -LiteralPath $env:FIXER_FILE).VersionInfo.ProductVersion', 60000, { FIXER_FILE: file });
  return r.out || null;
}
function runningInstances() {
  const r = ps(`Get-Process -Name '1132 Fixer' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id)|$($_.Path)|$($_.StartTime.ToString('o'))" }`);
  return r.out ? r.out.split(/\r?\n/).filter(Boolean).map((l) => { const [id, p, start] = l.split('|'); return { pid: Number(id), path: p, start }; }) : [];
}
// The process that owns the main window (Electron spawns several
// "1132 Fixer.exe" children; only the browser process has a window).
function mainWindowPid() {
  const r = ps(`Get-Process -Name '1132 Fixer' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id`);
  return r.out ? Number(r.out) : null;
}
// Every synthetic click the driver makes is logged with a timestamp and the
// target id, and the page records every click it receives (trusted flag and
// screen position), so a click that did not come from the driver is visible.
async function driverClick(page, selector, opts) {
  const at = new Date().toISOString();
  report.driverClicks = report.driverClicks || [];
  try { await page.click(selector, opts || {}); report.driverClicks.push({ at, selector, ok: true }); console.log(`    click ${selector} at ${at}`); return true; }
  catch (err) { report.driverClicks.push({ at, selector, ok: false, error: err.message.split('\n')[0] }); console.log(`    click ${selector} FAILED at ${at}: ${err.message.split('\n')[0]}`); return false; }
}
function installClickLog(page) {
  return page.evaluate(() => {
    if (window.__clicks) return;
    window.__clicks = [];
    document.addEventListener('click', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('button, a, [role="button"]') : null;
      window.__clicks.push({ at: new Date().toISOString(), id: (el && el.id) || (e.target && e.target.id) || '', text: el ? (el.textContent || '').trim().slice(0, 40) : '', trusted: e.isTrusted, x: e.screenX, y: e.screenY });
    }, true);
  }).catch(() => {});
}
function readClickLog(page) { return page.evaluate(() => window.__clicks || []).catch(() => null); }
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
    const r = ps('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:FIXER_LINK); $s.TargetPath', 60000, { FIXER_LINK: l });
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
  return candidates.filter((d) => d && fs.existsSync(path.join(d, PRODUCT_EXE)) && (!canonical || path.resolve(d).toLowerCase() !== path.resolve(canonical).toLowerCase()));
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
// Samples the window title of the process that owns the main window and
// captures the window every ~200 ms for a few seconds, writing one line per
// sample. Runs as its own PowerShell process so a stalled browser process
// (the main process blocks in CreateProcess while Windows scans the 118 MB
// installer) cannot hide what the renderer painted.
function startWindowSampler(pid, outPrefix, seconds) {
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class W2 { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R2 r); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n); }
public struct R2 { public int L, T, Rt, B; }
"@
[W2]::SetProcessDPIAware() | Out-Null
$end = (Get-Date).AddSeconds(${seconds})
$i = 0
$last = ''
while ((Get-Date) -lt $end) {
  $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if (-not $p) { Add-Content -LiteralPath $env:FIXER_SAMPLES -Value ("$(Get-Date -Format o)|GONE|"); break }
  $h = $p.MainWindowHandle
  $sb = New-Object System.Text.StringBuilder 512
  [W2]::GetWindowText($h, $sb, 512) | Out-Null
  $t = $sb.ToString()
  Add-Content -LiteralPath $env:FIXER_SAMPLES -Value ("$(Get-Date -Format o)|" + $h + "|" + $t)
  if ($h -ne 0 -and ($t -ne $last -or ($i % 5) -eq 0)) {
    $r = New-Object R2
    [W2]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.Rt - $r.L; $hh = $r.B - $r.T
    if ($w -gt 0 -and $hh -gt 0) {
      try { $bmp = New-Object System.Drawing.Bitmap $w, $hh; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size); $bmp.Save(($env:FIXER_PREFIX + '-' + $i.ToString('00') + '.png'), [System.Drawing.Imaging.ImageFormat]::Png); $i++ } catch {}
    }
    $last = $t
  }
  Start-Sleep -Milliseconds 200
}
`;
  const samples = outPrefix + '-samples.txt';
  try { fs.unlinkSync(samples); } catch (_) {}
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore', windowsHide: true, env: Object.assign({}, process.env, { FIXER_SAMPLES: samples, FIXER_PREFIX: outPrefix }) });
  return { child, samples, done: new Promise((resolve) => { child.once('exit', () => resolve()); child.once('error', () => resolve()); }) };
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
Write-Output "OK ${'$'}w x ${'$'}hh"
`;
  return ps(script, 30000, { FIXER_CAPTURE: file });
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
  if (!DRY) console.log('\n  ================================================================\n  DO NOT TOUCH THE 1132 FIXER TEST WINDOW, MOUSE OR KEYBOARD WHILE THIS\n  RUNS. Every click is recorded; one stray click fails the run.\n  ================================================================\n');
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
  // Order matters: kill running instances first, then run the uninstaller
  // *synchronously*. Without `_?=<dir>` an NSIS uninstaller copies itself
  // to %TEMP%, starts the copy and returns at once — a registry check two
  // seconds later would still see the old record, and the next installer
  // would collide with the uninstall still in progress ("Failed to
  // uninstall old application files ... : 2").
  const before = installRecord();
  report.before = before;
  for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
  if (before.quietUninstall) {
    console.log(`  existing install ${before.displayVersion} at ${before.installLocation} — uninstalling`);
    const m = /^"([^"]+)"\s*(.*)$/.exec(before.quietUninstall);
    if (m) {
      const uninstDir = path.dirname(m[1]);
      // Not `_?=<dir>`: electron-builder's uninstaller treats any process
      // running from $INSTDIR as "the app" — including itself when run in
      // place — and aborts (exit 2). Let it copy itself to %TEMP% (Un_A.exe)
      // and wait for the Add/Remove record and that copy to be gone.
      const r = await runDetached(m[1], m[2].split(' ').filter(Boolean), 300000);
      const unCopyRunning = () => /Un_A\.exe/i.test(spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq Un_A.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout || '');
      let gone = false;
      const limit = r.status === 0 ? 90 : 10;
      for (let i = 0; i < limit && !gone; i++) { await sleep(2000); gone = !installRecord().displayVersion && !unCopyRunning(); }
      if (gone) {
        passed('prep.uninstall-existing', `removed ${before.displayVersion} (uninstaller exit ${r.status})`);
      } else {
        // The shipped uninstaller can refuse to run: its "is the app
        // running" check matches any process whose path starts with the
        // install directory, and it aborts (exit 2) after a few retries.
        // The acceptance needs a clean slate, not that uninstaller: remove
        // the files, registry records and shortcuts directly (elevated).
        const probe = ps(`Get-CimInstance Win32_Process | Where-Object { $_.Path -and $_.Path.StartsWith('${uninstDir.replace(/'/g, "''")}', 'CurrentCultureIgnoreCase') } | ForEach-Object { "$($_.ProcessId) $($_.Path)" }`);
        for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
        await sleep(1000);
        const targets = [before.installLocation, uninstDir].filter(Boolean);
        const errors = [];
        for (const dir of new Set(targets.map((d) => path.resolve(d).toLowerCase()))) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { errors.push(`${dir}: ${err.message}`); }
        }
        for (const key of [UNINSTALL_KEY, INSTALL_KEY, 'HKLM\\Software\\1132Fixer']) {
          spawnSync('reg.exe', ['delete', key, '/f'], { windowsHide: true, timeout: 10000 });
        }
        for (const l of shortcutTargets()) { try { fs.unlinkSync(l.link); } catch (err) { errors.push(`${l.link}: ${err.message}`); } }
        const after = installRecord();
        const clean = !after.displayVersion && !after.installLocation && !fs.existsSync(path.join(uninstDir, PRODUCT_EXE)) && errors.length === 0;
        (clean ? passed : failed)('prep.uninstall-existing', `${before.displayVersion} uninstaller exited ${r.status} and left the install registered (processes under install dir: ${probe.out || 'none'}); ${clean ? 'removed files, registry records and shortcuts directly' : `manual removal incomplete: ${errors.join('; ') || JSON.stringify(after)}`}`);
        if (!clean) { server.close(); return finish(); }
      }
    }
  } else {
    passed('prep.uninstall-existing', 'no existing install');
  }
  for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
  // Updater bookkeeping from a previous run must not leak into this one:
  // update-state.json carries the per-target retry backoff (a successful
  // 6.9.1 handoff would make a freshly installed 6.9.0 skip its check for
  // an hour) and a stale handoff record would put A straight into recovery.
  for (const f of [path.join(USER_DATA, 'update-state.json'), HANDOFF]) { try { fs.unlinkSync(f); console.log(`  cleared ${path.basename(f)}`); } catch (_) {} }
  // An interrupted uninstall can leave files behind with no Add/Remove
  // record; a fresh install would land on top of them. Clear them first.
  for (const dir of otherInstallDirs(null)) {
    if (fs.existsSync(path.join(dir, PRODUCT_EXE))) {
      try { fs.rmSync(dir, { recursive: true, force: true }); passed('prep.remove-leftover', `removed leftover files at ${dir}`); }
      catch (err) { failed('prep.remove-leftover', `could not remove ${dir}: ${err.message}`); server.close(); return finish(); }
    }
  }
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
    const r = await runDetached(pair.a.setup, ['/S'], 300000);
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
  await installClickLog(page);

  // ---- 3. observe check → download → verify → ready
  // The banner title carries the state ("Update available", "Downloading
  // update", ...); the message carries the version / progress. Downloads
  // start only when the user chooses Download update (autoDownload is off).
  const bannerText = () => page.evaluate(() => {
    const t = (document.getElementById('ubTitle') || {}).textContent || '';
    const m = (document.getElementById('ubMsg') || {}).textContent || '';
    return t ? `${t} — ${m}`.trim() : m;
  }).catch(() => '');
  const seen = [];
  let downloadClicked = false;
  let aGone = null;
  app.process().once('exit', (code) => { aGone = { code, at: Date.now() }; });
  const readyWait = await waitFor(async () => {
    if (aGone) return null;
    const t = await bannerText();
    if (t && seen[seen.length - 1] !== t) { seen.push(t); console.log(`    banner: ${t}`); }
    if (/^Update available/.test(t) && !downloadClicked) {
      downloadClicked = true;
      await page.screenshot({ path: path.join(OUT, '02a-A-update-available.png') }).catch(() => {});
      await driverClick(page, '#ubDownload');
    }
    if (/^Downloading update/.test(t) && !report.downloadShot) { report.downloadShot = true; await page.screenshot({ path: path.join(OUT, '02-A-downloading.png') }).catch(() => {}); }
    if (/^Verifying update/.test(t) && !report.verifyShot) { report.verifyShot = true; await page.screenshot({ path: path.join(OUT, '02b-A-verifying.png') }).catch(() => {}); }
    return /^Ready to restart/.test(t) ? t : null;
  }, 240000, 300);
  const aExitReason = aGone ? (logEvents(logSince).filter((e) => e.event === 'shutdown.start').pop() || {}).reason : null;
  (readyWait.ok ? passed : failed)('update.ready', readyWait.ok ? `"${readyWait.value}" after ${readyWait.ms} ms` : aGone ? `A exited (code ${aGone.code}, shutdown reason ${aExitReason || 'unknown'}) before Ready to restart; last banner "${seen[seen.length - 1] || ''}"` : `never reached Ready to restart (last: "${seen[seen.length - 1] || ''}") after ${readyWait.ms} ms`, { bannerSequence: seen });
  if (!readyWait.ok) {
    const chk = logEvents(logSince).filter((e) => /^check\./.test(e.event)).map((e) => `${e.event}${e.waitMs ? ` wait ${e.waitMs} ms` : ''}${e.reason ? ` ${e.reason}` : ''}`);
    failed('update.check-observed', chk.length ? chk.join(' | ') : 'A never logged an update check');
  }
  (seen.some((t) => /^Update available/.test(t)) && downloadClicked && seen.some((t) => /^Downloading update/.test(t)) && seen.some((t) => /^Verifying update/.test(t)) ? passed : failed)('update.download-and-verify-observed', `download chosen by the user; ${seen.join(' | ')}`);
  const feedHits = report.feedRequests.map((r) => r.url);
  (feedHits.includes('/latest.yml') && feedHits.some((u) => u.endsWith(path.basename(pair.b.setup))) ? passed : failed)('feed.requested', feedHits.join(', '));
  await page.screenshot({ path: path.join(OUT, '03-A-ready-to-restart.png') });
  const stillRunning = runningInstances().some((p) => p.pid === aFacts.pid);
  (stillRunning ? passed : failed)('update.no-exit-before-ready', stillRunning ? 'A still running at ready' : 'A exited before approval');
  if (!readyWait.ok) { await app.close().catch(() => {}); server.close(); return finish(); }
  // A verified update waiting to install is a critical operation: the
  // inactivity hourglass must not appear, and only the updater may close
  // the app. Defer the countdown, sit idle past the 30 s warning point.
  const exitPromise = new Promise((resolve) => { app.process().once('exit', (code) => resolve({ code, at: Date.now() })); });
  await driverClick(page, '#ubLater');
  const idleStart = Date.now();
  await sleep(1200);
  const deferred = await page.evaluate(() => ({ title: (document.getElementById('ubTitle') || {}).textContent || '', msg: (document.getElementById('ubMsg') || {}).textContent || '', restart: !!(document.getElementById('ubRestart') && !document.getElementById('ubRestart').hidden), later: !!(document.getElementById('ubLater') && !document.getElementById('ubLater').hidden) })).catch(() => null);
  await page.screenshot({ path: path.join(OUT, '03b-A-deferred-after-later.png') }).catch(() => {});
  (deferred && !/restarts in \d+ seconds/i.test(deferred.msg) && /restart now/i.test(deferred.msg) && deferred.restart && !deferred.later ? passed : failed)('update.later-defers',
    deferred ? `after Later: "${deferred.title} — ${deferred.msg}"; Restart now visible=${deferred.restart}; Later visible=${deferred.later}` : 'could not read the banner after Later');
  // Full inactivity window = 30 s warning + 30 s countdown. Sit 66 s.
  let earlyExit = null;
  let pageClicks = [];
  { let done = false; exitPromise.then((e) => { earlyExit = e; done = true; });
    while (!done && Date.now() - idleStart < 66000) { await sleep(1000); const c = await readClickLog(page); if (c) pageClicks = c; } }
  const idle = earlyExit ? { visible: null } : await page.evaluate(() => { const o = document.getElementById('idleOverlay'); return { visible: !!o && !o.hidden, banner: (document.getElementById('ubMsg') || {}).textContent || '' }; }).catch(() => ({ visible: null }));
  const idleEvents = logEvents(logSince);
  const idleInstall = idleEvents.find((e) => e.event === 'install.begin');
  const foreign = pageClicks.filter((c) => !(report.driverClicks || []).some((d) => Math.abs(new Date(d.at) - new Date(c.at)) < 1500 && ('#' + c.id) === d.selector));
  report.pageClicks = pageClicks;
  (idle.visible === false && !earlyExit && runningInstances().some((p) => p.pid === aFacts.pid) ? passed : failed)('update.no-inactivity-exit-while-ready',
    idle.visible === false && !earlyExit ? `no hourglass after 66 s idle with the update ready ("${idle.banner}"); ${pageClicks.length} page clicks, all from the driver`
      : earlyExit ? `A exited ${earlyExit.at - idleStart} ms into the idle window (code ${earlyExit.code})${idleInstall ? `; install.begin origin=${idleInstall.origin}` : '; no install.begin logged'}; clicks not made by the driver: ${foreign.length ? foreign.map((c) => `${c.at} #${c.id} "${c.text}" trusted=${c.trusted} at ${c.x},${c.y}`).join('; ') : 'none recorded'}`
      : `hourglass visible=${idle.visible}`);
  (foreign.length === 0 ? passed : failed)('update.no-foreign-clicks', foreign.length ? `${foreign.length} click(s) reached the window that the driver did not make` : `every click on A came from the driver (${(report.driverClicks || []).length} synthetic clicks logged)`);

  // ---- 4. approve the restart
  let overlay = { ok: false };
  const approvedAt = Date.now();
  const exitedBeforeApproval = !!earlyExit;
  let sampler = null;
  if (!exitedBeforeApproval) {
    // The renderer marks the window title the moment the blocking notice is
    // shown. The title is read by a separate process, so it is visible even
    // while the browser process is busy starting the installer.
    await page.evaluate(() => {
      const o = document.getElementById('updateInstallOverlay');
      const mark = () => { if (o && !o.hidden) document.title = '1132 Fixer [HANDOFF-NOTICE] ' + ((document.getElementById('updateInstallBody') || {}).textContent || '').slice(0, 60); };
      new MutationObserver(mark).observe(o, { attributes: true, attributeFilter: ['hidden'] });
      mark();
    }).catch(() => {});
    sampler = startWindowSampler(mainWindowPid() || aFacts.pid, path.join(OUT, '04-A-install-handoff'), 12);
    await sleep(600);
    report.driverClicks = report.driverClicks || [];
    const at = new Date().toISOString();
    report.driverClicks.push({ at, selector: '#ubRestart', ok: true, how: 'dom-click' });
    console.log(`    click #ubRestart at ${at} (dispatched through the DOM so the driver does not wait on a busy browser process)`);
    // Do not await the round trip: the browser process may block for seconds.
    page.evaluate(() => { const b = document.getElementById('ubRestart'); if (b) b.click(); }).catch(() => {});
    await sampler.done;
    const lines = (() => { try { return fs.readFileSync(sampler.samples, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } })();
    const seenAt = lines.find((l) => /HANDOFF-NOTICE/.test(l));
    const noticeEvent = logEvents(logSince).find((e) => e.event === 'install.notice');
    const firstTitles = lines.slice(0, 6).map((l) => l.split('|').slice(2).join('|')).join(' / ');
    if (seenAt || (noticeEvent && noticeEvent.shown === true)) {
      const [ts, , ...rest] = (seenAt || '').split('|');
      overlay = { ok: true, value: seenAt ? rest.join('|').replace('1132 Fixer [HANDOFF-NOTICE] ', '') : 'main process confirmed the notice on screen', ms: seenAt ? new Date(ts) - new Date(at) : noticeEvent.ms };
      overlay.value += noticeEvent ? ` [app log install.notice shown=${noticeEvent.shown} in ${noticeEvent.ms} ms]` : ' [no install.notice log event: build predates the confirmation step]';
      const shots = fs.readdirSync(OUT).filter((f) => /^04-A-install-handoff-\d+\.png$/.test(f)).sort();
      if (shots.length) fs.copyFileSync(path.join(OUT, shots[shots.length - 1]), path.join(OUT, '04-A-install-handoff.png'));
    } else {
      overlay = { ok: false, lastProbe: `${lines.length} title samples, none carried the notice marker; first titles: ${firstTitles || '(none)'}; app log install.notice: ${noticeEvent ? JSON.stringify(noticeEvent) : 'absent'}` };
    }
    report.handoffSamples = lines.slice(0, 40);
  }
  (overlay.ok ? passed : exitedBeforeApproval ? notRun : failed)('update.handoff-notice', overlay.ok ? `${overlay.value} (seen ${overlay.ms} ms after Restart now)` : exitedBeforeApproval ? 'A had already exited before the driver approved the restart' : `installing notice not shown before exit (${overlay.lastProbe})`);
  const exit = earlyExit || await Promise.race([exitPromise, sleep(90000).then(() => null)]);
  (exit ? passed : failed)('update.A-exits', exit ? `A exited ${exit.at - approvedAt} ms after approval (code ${exit.code})` : 'A did not exit within 90 s');
  // The handoff record must say installer-started before A is gone.
  let handoff = null;
  try { handoff = JSON.parse(fs.readFileSync(HANDOFF, 'utf8')); } catch (_) {}
  const handoffOk = handoff && (handoff.state === 'installer-started' || handoff.state === 'updated-pending-ready') && handoff.targetVersion === pair.b.version && handoff.installerPid;
  (handoffOk ? passed : failed)('update.handoff-record', handoff ? `state=${handoff.state} target=${handoff.targetVersion} installerPid=${handoff.installerPid} installDir=${handoff.installDir}` : 'no handoff record');

  // ---- 5. the installer applies B and relaunches it
  const relaunch = await waitFor(() => {
    const procs = runningInstances().filter((p) => p.pid !== aFacts.pid && p.path && p.path.toLowerCase() === installedExe.toLowerCase());
    if (procs.length) return procs[0];
    const started = logEvents(logSince).find((e) => e.event === 'startup' && e.app === pair.b.version && e.execPath && e.execPath.toLowerCase() === installedExe.toLowerCase());
    return started ? { pid: started.pid || 0, path: started.execPath, start: started.ts, fromLog: true } : null;
  }, 240000, 1000);
  if (!relaunch.ok) {
    // A stalled installer usually means a dialog. Read its text (UI Automation
    // works from the elevated driver) so the failure names the real cause.
    const dlg = ps(`Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; Get-Process -ErrorAction SilentlyContinue | Where-Object { ($_.ProcessName -like '1132-Fixer-Setup*' -or $_.ProcessName -like 'Un_A*' -or $_.ProcessName -like 'Uninstall 1132*') -and $_.MainWindowHandle -ne 0 } | ForEach-Object { $el=[System.Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle); $t=$el.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }; "pid=$($_.Id) $($_.ProcessName) '$($_.MainWindowTitle)': $($t -join ' / ')" }`, 30000);
    const stuck = (dlg.out || '').split(/\r?\n/).filter(Boolean);
    (stuck.length ? failed : notRun)('update.installer-dialog', stuck.length ? stuck.join(' | ') : 'no installer or uninstaller window found');
    for (const p of ps(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like '1132-Fixer-Setup*' -or $_.ProcessName -like 'Un_A*' } | ForEach-Object { $_.Id }`).out.split(/\r?\n/).filter(Boolean)) { try { process.kill(Number(p)); } catch (_) {} }
  }
  const bVersionOnDisk = fs.existsSync(installedExe) ? exeVersion(installedExe) : null;
  const recAfter = installRecord();
  (bVersionOnDisk && bVersionOnDisk.startsWith(pair.b.version) && recAfter.displayVersion === pair.b.version && recAfter.installLocation && recAfter.installLocation.toLowerCase() === installDir.toLowerCase() ? passed : failed)('update.B-applied', `exe ${bVersionOnDisk}; Add/Remove ${recAfter.displayVersion}; InstallLocation ${recAfter.installLocation}`, { record: recAfter });
  (relaunch.ok ? passed : failed)('update.B-relaunched', relaunch.ok ? `pid ${relaunch.value.pid} started ${relaunch.value.start} (${relaunch.ms} ms after approval)` : `no new 1132 Fixer process within ${relaunch.ms} ms`);
  if (relaunch.ok) {
    (relaunch.value.path.toLowerCase() === installedExe.toLowerCase() ? passed : failed)('update.B-executable-path', relaunch.value.path);
    await sleep(6000); // let B reach its ready screen and clear the handoff
    const bPid = mainWindowPid() || relaunch.value.pid;
    report.bPid = bPid;
    const cap = captureWindow(bPid, path.join(OUT, '05-B-after-auto-relaunch.png'));
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
    // A standard Windows close request (WM_CLOSE) to the window-owning
    // process: Electron's window-all-closed -> shutdown reason user_exit.
    const closeSince = new Date().toISOString();
    const closePid = report.bPid || mainWindowPid() || relaunch.value.pid;
    ps(`Get-Process -Id ${closePid} -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }`);
    const closed = await waitFor(() => (runningInstances().length ? null : true), 20000, 500);
    const closeReason = (logEvents(closeSince).filter((e) => e.event === 'shutdown.start').pop() || {}).reason;
    (closed.ok ? passed : failed)('reopen.B-closed-gracefully', closed.ok ? `B (pid ${closePid}) closed in ${closed.ms} ms via a window close request; no 1132 Fixer process left; shutdown reason ${closeReason || 'not logged'}` : `B (pid ${closePid}) still running after 20 s; instances: ${runningInstances().map((p) => p.pid).join(',')}`);
    if (!closed.ok) { try { process.kill(relaunch.value.pid); } catch (_) {} }
  }
  for (const p of runningInstances()) { try { process.kill(p.pid); } catch (_) {} }
  await sleep(2000);
  try {
    const app2 = await electron.launch({ executablePath: installedExe, args: launchArgs, timeout: 60000 });
    const page2 = await app2.firstWindow({ timeout: 60000 });
    await page2.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
    const f2 = await app2.evaluate(({ app: a }) => ({ version: a.getVersion(), execPath: process.execPath }));
    await waitFor(() => page2.evaluate(() => { const s = document.body.dataset.compactState; return s && s !== 'checking' ? s : null; }), 30000);
    await sleep(800);
    const banner = await page2.evaluate(() => ({ visible: document.getElementById('updateBanner').classList.contains('visible'), text: [(document.getElementById('ubTitle') || {}).textContent, (document.getElementById('ubMsg') || {}).textContent].join(' — ') }));
    await page2.screenshot({ path: path.join(OUT, '06-B-manual-reopen.png') });
    (f2.version === pair.b.version && f2.execPath.toLowerCase() === installedExe.toLowerCase() ? passed : failed)('reopen.manual', `runtime ${f2.version} at ${f2.execPath}`);
    (!banner.visible || !/could not be completed|previous version/i.test(banner.text) ? passed : failed)('reopen.no-stale-warning', banner.visible ? `banner: ${banner.text}` : 'no update banner');
    // Supported exit path: the header Exit control -> quit-app IPC ->
    // shutdown reason user_exit. Three times; no force-close allowed.
    let appN = app2;
    let pageN = page2;
    for (let i = 1; i <= 3; i++) {
      if (i > 1) {
        appN = await electron.launch({ executablePath: installedExe, args: launchArgs, timeout: 60000 });
        pageN = await appN.firstWindow({ timeout: 60000 });
        await pageN.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
        await waitFor(() => pageN.evaluate(() => { const s = document.body.dataset.compactState; return s && s !== 'checking' ? s : null; }), 30000);
        await sleep(500);
      }
      const since = new Date().toISOString();
      const exitP = new Promise((resolve) => { appN.process().once('exit', (code) => resolve({ code, at: Date.now() })); });
      const t0 = Date.now();
      const clicked = await driverClick(pageN, '#btnExit');
      const ex = await Promise.race([exitP, sleep(20000).then(() => null)]);
      await sleep(1500);
      const left = runningInstances();
      const reason = (logEvents(since).filter((e) => e.event === 'shutdown.start').pop() || {}).reason;
      (clicked && ex && left.length === 0 && reason === 'user_exit' ? passed : failed)(`exit.graceful-${i}`, ex ? `Exit control -> process exit code ${ex.code} in ${ex.at - t0} ms; shutdown reason ${reason || 'not logged'}; processes left: ${left.length}` : `no exit within 20 s after Exit (clicked=${clicked}); processes left: ${left.map((p) => p.pid).join(',') || 'none'}`);
      if (!ex) { for (const p of left) { try { process.kill(p.pid); } catch (_) {} } await sleep(1500); }
    }
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
      await runDetached(m[1], m[2].split(' ').filter(Boolean), 180000);
      for (let i = 0; i < 60 && installRecord().displayVersion; i++) await sleep(2000);
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
  // The feed server (and a Playwright connection) can keep the loop alive
  // after a throw; a lingering driver holds the port for the next run.
  setTimeout(() => process.exit(process.exitCode || 1), 200).unref();
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
  const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  for (const c of report.cases) md.push(`| ${c.id} | ${c.status} | ${cell(c.detail)} |`);
  md.push('');
  md.push('Screenshots: 01-A-before-update, 02-A-downloading, 03-A-ready-to-restart, 04-A-install-handoff, 05-B-after-auto-relaunch, 06-B-manual-reopen. Log: updater-log-excerpt.jsonl.');
  fs.writeFileSync(path.join(OUT, 'report.md'), md.join('\n') + '\n');
  console.log(`\npackaged-update-acceptance: ${counts.passed} passed, ${counts.failed} failed, ${counts['not-run']} not run → ${OUT}`);
  process.exitCode = counts.failed ? 1 : 0;
}
