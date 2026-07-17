const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const config = require('./src/main/config');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
// Differential (blockmap) downloads from GitHub are a recurring source of
// stuck / never-completing updates in the field. The full installer is small
// enough that a plain download is the reliable choice.
autoUpdater.disableDifferentialDownload = true;

// ============================================================
// Updater state machine.
//
// Old behavior force-called quitAndInstall() 2 seconds after the download
// finished — even while the destructive fix flow was mid-run, and with no
// UI at all. To the user that read as "the app randomly closed / froze /
// the update never finished". New rules:
//   - Everything is surfaced to the renderer via 'update-status' events.
//   - App idle (no fix started): visible 10s countdown, then restart+install.
//   - Fix running or already ran: NEVER auto-restart. Banner offers
//     "Restart now"; otherwise autoInstallOnAppQuit installs on exit.
// ============================================================
const UPDATER = '[updater]';
let fixInProgress = false;
let fixHasRun = false;
let updateDownloaded = false;
let updateVersion = '';
let updateRestartTimer = null;

function sendUpdateStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', payload);
    }
  } catch (_) { /* renderer gone — nothing to notify */ }
}

function cancelUpdateRestartCountdown() {
  if (updateRestartTimer) {
    clearTimeout(updateRestartTimer);
    updateRestartTimer = null;
  }
}

let _lastUpdaterProgressPct = -10;
autoUpdater.on('checking-for-update', () => {
  console.log(`${UPDATER} checking-for-update`);
});
autoUpdater.on('update-available', (info) => {
  updateVersion = (info && info.version) || '';
  console.log(`${UPDATER} update-available version=${updateVersion}`);
  sendUpdateStatus({ state: 'downloading', version: updateVersion, percent: 0 });
});
autoUpdater.on('update-not-available', (info) => {
  console.log(`${UPDATER} update-not-available current=${info && info.version}`);
  sendUpdateStatus({ state: 'idle' });
});
autoUpdater.on('error', (err) => {
  console.warn(`${UPDATER} error: ${(err && err.message) || err}`);
  cancelUpdateRestartCountdown();
  // Non-fatal: the app works without the update; retried on next launch.
  sendUpdateStatus({ state: 'error' });
});
autoUpdater.on('download-progress', (p) => {
  const pct = Math.floor((p && p.percent) || 0);
  if (pct - _lastUpdaterProgressPct >= 5 || pct >= 100) {
    _lastUpdaterProgressPct = pct;
    const mb = (n) => Math.round((n || 0) / 1024 / 1024);
    console.log(`${UPDATER} download-progress ${pct}% (${mb(p && p.transferred)}MB / ${mb(p && p.total)}MB)`);
    sendUpdateStatus({ state: 'downloading', version: updateVersion, percent: pct });
  }
});
autoUpdater.on('update-downloaded', (info) => {
  updateDownloaded = true;
  updateVersion = (info && info.version) || updateVersion;
  console.log(`${UPDATER} update-downloaded version=${updateVersion}`);
  if (fixInProgress || fixHasRun) {
    // Never yank the app out from under a running or just-finished fix —
    // that was the #1 "update didn't complete / app died mid-fix" report.
    sendUpdateStatus({ state: 'deferred', version: updateVersion });
  } else {
    const seconds = 10;
    sendUpdateStatus({ state: 'restarting', version: updateVersion, seconds });
    updateRestartTimer = setTimeout(() => {
      updateRestartTimer = null;
      autoUpdater.quitAndInstall(true, true);
    }, seconds * 1000);
  }
});

ipcMain.handle('install-update-now', () => {
  if (!updateDownloaded) return { success: false };
  cancelUpdateRestartCountdown();
  autoUpdater.quitAndInstall(true, true);
  return { success: true };
});

ipcMain.handle('defer-update', () => {
  cancelUpdateRestartCountdown();
  if (updateDownloaded) {
    // autoInstallOnAppQuit picks it up when the user exits.
    sendUpdateStatus({ state: 'deferred', version: updateVersion });
  }
  return { success: true };
});

const FIX_USER = 'user1';
const FIX_PASS = 'user1';
const ZOOM_PATH = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
// Working directory for Start-Process -Credential. Without an explicit
// -WorkingDirectory the new process inherits the caller's cwd, which for
// per-user NSIS installs is a path user1 has no ACLs on, producing
// "The directory name is invalid" (Win32 ERROR_DIRECTORY / 267).
// The Zoom install dir is the natural cwd and is readable by all local users.
const ZOOM_DIR  = 'C:\\Program Files\\Zoom\\bin';

// Tools that must exist on PATH; the destructive flow can't run without them.
const REQUIRED_TOOLS = [
  'powershell.exe', 'taskkill.exe', 'robocopy.exe',
  'icacls.exe', 'takeown.exe', 'net.exe', 'reg.exe'
];
// Tools we'd like but can survive without — surfaced as warnings.
const OPTIONAL_TOOLS = ['quser.exe', 'logoff.exe'];

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0a1020',
    // NOTE: no alwaysOnTop. The old always-on-top + frameless window had no
    // drag region either, so it sat immovable above everything — including
    // the Zoom window this app launches. That's most of the "frozen/glitchy"
    // feedback. The header is now a real drag region (see index.html).
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    // getIconPath() resolves packaged (resources/icon.ico) vs dev
    // (assets/icon.ico); the old literal only existed when packaged.
    icon: getIconPath()
  });

  // Avoid the white flash / half-painted first frame on slower machines.
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);
}

// Single-instance lock. Without it, the post-update relaunch (and users
// double-clicking during the silent install) produced two elevated windows
// fighting over the same PowerShell children.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  // Auto-update only makes sense for the packaged NSIS install. The portable
  // exe has no installer to hand off to (electron-updater cannot update
  // portable targets) and dev runs have no app-update.yml — both used to
  // produce a red-herring updater error on every launch.
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged && !isPortable) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        // Non-fatal: app continues without auto-update. Visible in logs now.
        console.warn(`${UPDATER} checkForUpdates rejected: ${(err && err.message) || err}`);
      });
    }, 3000);
  } else {
    console.log(`${UPDATER} skipped (packaged=${app.isPackaged}, portable=${isPortable})`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// ============================================================
// Path / process helpers
// ============================================================

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.ico');
}

function getFirstRunScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'zoom-firstrun-setup.ps1')
    : path.join(__dirname, 'scripts', 'zoom-firstrun-setup.ps1');
}

function getMediaConsentScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'grant-media-consent.ps1')
    : path.join(__dirname, 'scripts', 'grant-media-consent.ps1');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runProcess(exe, args, onLine, opts = {}) {
  const { heartbeatMs = 0, heartbeatLabel = '', timeoutMs = 0 } = opts;
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    let lastOutputAt = Date.now();
    const started = Date.now();
    const child = spawn(exe, args, { windowsHide: true });
    const emit = (buf, kind) => {
      const text = buf.toString();
      if (kind === 'err') stderrBuf += text; else stdoutBuf += text;
      lastOutputAt = Date.now();
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed) onLine(trimmed, kind);
      });
    };
    child.stdout.on('data', d => emit(d, 'out'));
    child.stderr.on('data', d => emit(d, 'err'));

    let hbTimer = null;
    if (heartbeatMs > 0) {
      hbTimer = setInterval(() => {
        const idleSec = Math.round((Date.now() - lastOutputAt) / 1000);
        const elapsedSec = Math.round((Date.now() - started) / 1000);
        if (idleSec >= Math.round(heartbeatMs / 1000)) {
          const label = heartbeatLabel || exe;
          onLine(`  ... still working (${label}; elapsed ${elapsedSec}s, idle ${idleSec}s)`, 'out');
        }
      }, heartbeatMs);
    }

    let killTimer = null;
    let timedOut = false;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        onLine(`  TIMEOUT after ${Math.round(timeoutMs / 1000)}s — killing ${exe}`, 'err');
        try { child.kill('SIGKILL'); } catch (_) {}
      }, timeoutMs);
    }

    const cleanup = () => {
      if (hbTimer) clearInterval(hbTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    child.on('error', err => {
      cleanup();
      onLine(`Failed to launch ${exe}: ${err.message}`, 'err');
      resolve({ code: -1, stdout: stdoutBuf, stderr: stderrBuf, timedOut });
    });
    child.on('close', code => {
      cleanup();
      resolve({ code, stdout: stdoutBuf, stderr: stderrBuf, timedOut });
    });
  });
}

async function runPSScript(scriptContent, onLine, opts = {}) {
  const tmp = path.join(os.tmpdir(),
    `fixer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  await fs.promises.writeFile(tmp, scriptContent, 'utf8');
  try {
    return await runProcess('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      onLine, opts);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// Like runPSScript, but with stdio:'ignore' so the spawned PowerShell
// does NOT have stdin/stdout/stderr pipes back to us. Used for the Zoom
// launch: Start-Process -Credential / CreateProcessWithLogonW makes the
// launched process inherit the parent's std handles, and Zoom keeps its
// stderr pipe open after launch — which would block the parent PS from
// exiting (and freeze run-fix at Step 5). With 'ignore', Zoom inherits
// closed handles, has nothing to write to, and PS exits cleanly.
// We can't capture the PS output here, so callers should verify success
// out-of-band (e.g. by polling Get-Process / Win32_Process).
async function runPSScriptDetachedIO(scriptContent) {
  const tmp = path.join(os.tmpdir(),
    `fixer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  await fs.promises.writeFile(tmp, scriptContent, 'utf8');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {
      fs.promises.unlink(tmp).catch(() => {});
      resolve({ code: -1 });
    });
    child.on('close', code => {
      fs.promises.unlink(tmp).catch(() => {});
      resolve({ code });
    });
  });
}

async function runPSCapture(scriptContent, opts = {}) {
  const noop = () => {};
  return runPSScript(scriptContent, noop, opts);
}

function isElevatedSync() {
  // net.exe session is the standard Windows admin check: requires admin to enumerate sessions.
  return new Promise(resolve => {
    const child = spawn('net.exe', ['session'], { windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

function userExists(username) {
  return new Promise(resolve => {
    const child = spawn('net.exe', ['user', username], { windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

// ============================================================
// Preflight: required + optional tool presence, environment sanity.
// Returns { ok, blockers: [{code,message}], warnings: [{code,message}], info: {...} }.
// ============================================================
async function preflightCheck() {
  const blockers = [];
  const warnings = [];
  const info = {};

  // Elevation
  const elevated = await isElevatedSync();
  info.elevated = elevated;
  if (!elevated) {
    blockers.push({
      code: 'not_elevated',
      message: 'Process is not running as Administrator. UAC-elevate and retry.'
    });
  }

  // Logged-in user must not be user1
  const interactiveUser = (os.userInfo().username || '').toLowerCase();
  info.interactiveUser = interactiveUser;
  if (interactiveUser === FIX_USER.toLowerCase()) {
    blockers.push({
      code: 'running_as_target',
      message: `You are signed in AS '${FIX_USER}'. Sign in as a different administrator.`
    });
  }

  // Bundled firstrun script
  const firstRun = getFirstRunScriptPath();
  info.firstRunScript = firstRun;
  if (!fs.existsSync(firstRun)) {
    warnings.push({
      code: 'firstrun_missing',
      message: `Bundled helper not found at ${firstRun}. Skip deploy + shortcut after fix.`
    });
  }

  // Zoom executable
  info.zoomPath = ZOOM_PATH;
  if (!fs.existsSync(ZOOM_PATH)) {
    blockers.push({
      code: 'zoom_not_found',
      message: `Zoom Workplace not found at ${ZOOM_PATH}. Install the machine-wide MSI.`
    });
  }

  // Required + optional tools + Secondary Logon service (Start-Process -Credential needs it)
  const allTools = [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS];
  const probe = await runPSCapture(`
    $tools = @(${allTools.map(t => `'${t}'`).join(',')})
    $r = @{}
    foreach ($t in $tools) {
      try { $r[$t] = [bool](Get-Command $t -EA SilentlyContinue) } catch { $r[$t] = $false }
    }
    $svc = Get-Service seclogon -EA SilentlyContinue
    if ($svc) {
      $r['seclogon_status']    = [string]$svc.Status
      $r['seclogon_starttype'] = [string]$svc.StartType
    } else {
      $r['seclogon_status']    = 'MISSING'
      $r['seclogon_starttype'] = 'MISSING'
    }
    $r | ConvertTo-Json -Compress
  `, { timeoutMs: 20000 });
  let presence = null;
  try {
    const parsed = JSON.parse((probe.stdout || '').trim() || '{}');
    if (parsed && typeof parsed === 'object') presence = parsed;
  } catch (_) { /* presence stays null */ }
  if (presence === null) {
    // PS probe failed (or timed out). Treat all required tools as missing.
    blockers.push({
      code: probe.timedOut ? 'tool_probe_timeout' : 'tool_probe_failed',
      message: probe.timedOut
        ? 'PowerShell probe timed out after 20s — Windows tool inventory unavailable. Antivirus or Defender may be blocking powershell.exe.'
        : 'PowerShell probe failed — could not verify Windows tools. Treating powershell.exe as unavailable.'
    });
    presence = {};
    for (const t of REQUIRED_TOOLS) presence[t] = false;
    for (const t of OPTIONAL_TOOLS) presence[t] = false;
  }
  info.tools = presence;
  info.seclogon = {
    status: presence.seclogon_status || 'unknown',
    startType: presence.seclogon_starttype || 'unknown'
  };
  for (const t of REQUIRED_TOOLS) {
    if (!presence[t]) {
      blockers.push({
        code: 'missing_tool',
        message: `Required Windows tool not on PATH: ${t}`
      });
    }
  }
  // OPTIONAL_TOOLS (quser.exe, logoff.exe) ship on Windows Pro/Enterprise only;
  // absent by design on Home. tryLogoffUser gates on info.tools and falls back
  // to taskkill alone, so we don't surface this to the user as a warning.
  // seclogon: Start-Process -Credential can auto-start it if StartType is Manual or Automatic.
  if (info.seclogon.status === 'MISSING') {
    warnings.push({
      code: 'seclogon_missing',
      message: 'Secondary Logon service (seclogon) not found. Launching Zoom as user1 will likely fail.'
    });
  } else if (info.seclogon.startType === 'Disabled') {
    blockers.push({
      code: 'seclogon_disabled',
      message: 'Secondary Logon service (seclogon) is Disabled. Start-Process -Credential cannot run. Run "sc.exe config seclogon start= demand" from an admin shell and retry.'
    });
  } else if (info.seclogon.status !== 'Running' && info.seclogon.startType !== 'Manual') {
    // Stopped+Manual is the Windows default and healthy — service will auto-start on first credential launch.
    // Anything else stopped (e.g. Stopped+Automatic) is an anomaly worth flagging.
    warnings.push({
      code: 'seclogon_not_running',
      message: `Secondary Logon service is ${info.seclogon.status}/${info.seclogon.startType} (expected Running or Manual). Windows should auto-start it on demand; will surface a clearer error if launch fails.`
    });
  }

  return { ok: blockers.length === 0, blockers, warnings, info };
}

// ============================================================
// Step-1 logoff helper. Returns { triedQuser, foundSessions,
// loggedOff, notes }. Visible in run-fix output so a swallowed
// failure here never makes diagnosis harder.
// ============================================================
async function tryLogoffUser(username, toolPresence, send) {
  const result = { triedQuser: false, foundSessions: 0, loggedOff: 0, notes: [] };
  if (toolPresence && toolPresence['quser.exe'] === false) {
    send(`  quser.exe unavailable - skipping session enumeration (taskkill still runs).`, 'out');
    result.notes.push('quser_missing');
    return result;
  }
  result.triedQuser = true;
  const r = await runPSCapture(`
    $u = '${username}'
    $sessions = @()
    try {
      $raw = quser 2>$null
      $lec = $LASTEXITCODE
      if ($lec -ne 0 -and -not $raw) {
        Write-Output ("QUSER_EXIT=" + $lec)
        return
      }
      foreach ($line in $raw) {
        if ($line -match ('^>?\\s*' + [Regex]::Escape($u) + '\\s+\\S*\\s+(\\d+)')) {
          $sessions += $Matches[1]
        }
      }
    } catch {
      Write-Output ("QUSER_EXC=" + $_.Exception.Message)
      return
    }
    if ($sessions.Count -eq 0) {
      Write-Output "NO_SESSIONS"
      return
    }
    $loggedOff = 0
    foreach ($sid in $sessions) {
      try {
        logoff $sid 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { $loggedOff += 1 }
        else { Write-Output ("LOGOFF_FAIL=" + $sid + ":" + $LASTEXITCODE) }
      } catch {
        Write-Output ("LOGOFF_EXC=" + $sid + ":" + $_.Exception.Message)
      }
    }
    Write-Output ("SESSIONS=" + ($sessions -join ','))
    Write-Output ("LOGGED_OFF=" + $loggedOff)
  `);
  const out = (r.stdout || '').trim();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t === 'NO_SESSIONS') {
      send('  No active sessions for user1.', 'out');
    } else if (t.startsWith('SESSIONS=')) {
      const ids = t.slice(9).split(',').filter(Boolean);
      result.foundSessions = ids.length;
      send(`  Found ${ids.length} session(s): ${ids.join(', ')}`, 'out');
    } else if (t.startsWith('LOGGED_OFF=')) {
      result.loggedOff = parseInt(t.slice(11), 10) || 0;
      send(`  Logged off ${result.loggedOff} session(s).`, 'out');
    } else if (t.startsWith('QUSER_EXIT=')) {
      result.notes.push('quser_exit_' + t.slice(11));
      send(`  WARNING: quser returned exit code ${t.slice(11)}. Skipping logoff.`, 'err');
    } else if (t.startsWith('QUSER_EXC=')) {
      result.notes.push('quser_exception');
      send(`  WARNING: quser threw: ${t.slice(10)}`, 'err');
    } else if (t.startsWith('LOGOFF_FAIL=')) {
      result.notes.push('logoff_fail_' + t.slice(12));
      send(`  WARNING: logoff failed for session: ${t.slice(12)}`, 'err');
    } else if (t.startsWith('LOGOFF_EXC=')) {
      result.notes.push('logoff_exception');
      send(`  WARNING: logoff threw: ${t.slice(11)}`, 'err');
    }
  }
  return result;
}

// ============================================================
// Resolve the user's SID via NTAccount translation.
// Returns '' if not resolvable.
// ============================================================
async function resolveSID(username) {
  const r = await runPSCapture(`
    try { (New-Object System.Security.Principal.NTAccount('${username}')).Translate([System.Security.Principal.SecurityIdentifier]).Value }
    catch { '' }
  `);
  return (r.stdout || '').trim();
}

// ============================================================
// Verify user is in local Administrators (S-1-5-32-544) by SID.
// Falls back to `net localgroup` parsing. Returns { inGroup, method, raw }.
// ============================================================
async function verifyAdminMembership(username) {
  const sid = await resolveSID(username);
  const r = await runPSCapture(`
    $user = '${username}'
    $userSid = '${sid}'
    $result = 'NO'
    $method = 'none'
    try {
      $members = Get-LocalGroupMember -SID 'S-1-5-32-544' -EA Stop
      $method = 'Get-LocalGroupMember'
      foreach ($m in $members) {
        $mSid = $null
        try { $mSid = $m.SID.Value } catch {}
        if ($mSid -and $userSid -and ($mSid -eq $userSid)) { $result = 'YES'; break }
        if ($m.Name -ieq $user) { $result = 'YES'; break }
        if ($m.Name -like ('*\\' + $user)) { $result = 'YES'; break }
      }
    } catch {
      try {
        $out = (net localgroup administrators) 2>&1 | Out-String
        $method = 'net-localgroup'
        $lines = $out -split "\`r?\`n"
        foreach ($l in $lines) {
          $t = $l.Trim()
          if ($t -ieq $user -or $t -like ('*\\' + $user)) { $result = 'YES'; break }
        }
      } catch {
        $method = 'failed'
      }
    }
    Write-Output ("METHOD=" + $method)
    Write-Output ("RESULT=" + $result)
  `);
  const lines = (r.stdout || '').split(/\r?\n/).map(s => s.trim());
  let method = 'unknown', result = 'NO';
  for (const l of lines) {
    if (l.startsWith('METHOD=')) method = l.slice(7);
    else if (l.startsWith('RESULT=')) result = l.slice(7);
  }
  return { inGroup: result === 'YES', method, sid };
}

// ============================================================
// Profile resolution: registry ProfileImagePath first, folder scan fallback.
// Polls up to maxWaitSec. One consolidated PS call per iteration to keep
// total wall-clock close to the target wait.
// Returns { path, source, checkedPaths, checkedKeys, sid }.
// ============================================================
async function resolveUserProfilePath(username, maxWaitSec, send) {
  const checkedPaths = [];
  const checkedKeys = [];
  let lastSid = '';
  const literal = `C:\\Users\\${username}`;

  // Use [System.IO.File]::Exists instead of Test-Path: Test-Path throws on
  // access-denied NTFS ACLs (which the freshly-created user1 profile commonly
  // has against the calling admin account), whereas File.Exists returns false.
  const tickScript = `
    $u = '${username}'
    $sid = ''
    try { $sid = (New-Object System.Security.Principal.NTAccount($u)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
    Write-Output ("SID=" + $sid)

    $regPath = ''
    if ($sid) {
      $key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\' + $sid
      Write-Output ("KEY=" + $key)
      try {
        $rp = (Get-ItemProperty -Path $key -EA SilentlyContinue).ProfileImagePath
        if ($rp) { $regPath = $rp }
      } catch {}
    }
    Write-Output ("REG=" + $regPath)

    function Profile-Has-NTUserDat([string]$dir) {
      if (-not $dir) { return $false }
      try { return [System.IO.File]::Exists((Join-Path $dir 'NTUSER.DAT')) } catch { return $false }
    }

    if ($regPath -and (Profile-Has-NTUserDat $regPath)) {
      Write-Output ("MATCH=registry|" + $regPath)
      return
    }
    $literal = '${literal.replace(/'/g, "''")}'
    if (Profile-Has-NTUserDat $literal) {
      Write-Output ("MATCH=folder|" + $literal)
      return
    }
    try {
      $suf = Get-ChildItem 'C:\\Users' -Directory -Force -EA 0 |
        Where-Object { $_.Name -match ('^' + [Regex]::Escape($u) + '\\.') -and (Profile-Has-NTUserDat $_.FullName) } |
        Select-Object -First 1 -ExpandProperty FullName
      if ($suf) { Write-Output ("MATCH=folder-suffixed|" + $suf) }
    } catch {}
  `;

  for (let i = 0; i < maxWaitSec; i++) {
    const r = await runPSCapture(tickScript);
    let sid = '', key = '', regPath = '', matchSrc = '', matchPath = '';
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('SID=')) sid = t.slice(4);
      else if (t.startsWith('KEY=')) key = t.slice(4);
      else if (t.startsWith('REG=')) regPath = t.slice(4);
      else if (t.startsWith('MATCH=')) {
        const pipe = t.indexOf('|', 6);
        if (pipe > 0) { matchSrc = t.slice(6, pipe); matchPath = t.slice(pipe + 1); }
      }
    }
    if (sid) lastSid = sid;
    if (key && !checkedKeys.includes(key)) checkedKeys.push(key);
    if (regPath && !checkedPaths.includes(regPath)) checkedPaths.push(regPath);
    if (!checkedPaths.includes(literal)) checkedPaths.push(literal);

    if (matchPath) {
      if (!checkedPaths.includes(matchPath)) checkedPaths.push(matchPath);
      if (matchSrc === 'registry')         send(`  Resolved via registry: ${matchPath}`, 'out');
      else if (matchSrc === 'folder')      send(`  Resolved via folder scan: ${matchPath}`, 'out');
      else                                 send(`  WARNING: Windows created suffixed profile '${matchPath}'.`, 'out');
      return { path: matchPath, source: matchSrc, checkedPaths, checkedKeys, sid: lastSid };
    }
    await sleep(1000);
  }

  return { path: null, source: 'not_found', checkedPaths, checkedKeys, sid: lastSid };
}

// ============================================================
// Robust profile-folder delete helper, inlined into PS scripts that need it.
// ============================================================
const PS_REMOVE_PROFILE_HELPER = `
function Unload-UserHive {
    param([string]$Sid)
    if (-not $Sid) { return }
    $hkuPath = 'Registry::HKEY_USERS\\' + $Sid
    if (Test-Path $hkuPath) {
        Write-Host ("    Unloading HKU\\" + $Sid + " (NTUSER.DAT)")
        # GC + collect to release any RegistryKey handles PS may still hold.
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
        $rc = Start-Process reg.exe -ArgumentList @('unload', ('HKU\\' + $Sid)) -Wait -WindowStyle Hidden -PassThru
        Write-Host ("    reg unload exit: " + $rc.ExitCode)
    }
}
function Remove-ProfileFolder {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [string]$Sid = ''
    )
    $ErrorActionPreference = 'Continue'
    if (-not [System.IO.Directory]::Exists($Path)) { Write-Host "  Already gone: $Path"; return }
    Write-Host "  Deleting: $Path"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # Unload the user's NTUSER.DAT hive first — otherwise the file is open
    # and rd /s /q will leave it behind, even with full admin ownership.
    Unload-UserHive -Sid $Sid

    # PASS 1: rd /s /q FIRST.
    # Default Windows user profiles contain XP-compat junction points
    # (Application Data, Cookies, Local Settings, My Documents, etc.) with
    # explicit DENY-Everyone ACEs. rd /s /q is the only built-in that
    # removes junction reparse points themselves rather than recursing into
    # them. Running takeown /R or icacls /T from the profile root FIRST
    # makes both tools chase those junctions back into AppData and stall
    # for many minutes — that was the "hung on delete user1" symptom.
    $cmdExe = Join-Path $env:SystemRoot 'System32\\cmd.exe'
    $rdArgs = '/c rd /s /q "' + $Path + '"'
    Write-Host "    Pass 1: rd /s /q ..."
    $rc1 = Start-Process -FilePath $cmdExe -ArgumentList $rdArgs -Wait -WindowStyle Hidden -PassThru
    Write-Host ("    rd pass-1 exit: " + $rc1.ExitCode)
    if (-not [System.IO.Directory]::Exists($Path)) {
        $sw.Stop()
        Write-Host ("  RESULT: gone in {0:N1}s (pass 1)" -f $sw.Elapsed.TotalSeconds)
        return
    }

    # PASS 2: targeted ownership + ACL grant — non-recursive on the root,
    # then walk top-level children explicitly while SKIPPING reparse
    # points. This fixes ACL/ownership on real residue without chasing
    # junctions.
    Write-Host "    Pass 1 left residue; running targeted takeown/icacls/attrib (no junction chase)..."
    Start-Process takeown.exe -ArgumentList @('/F',$Path,'/A','/D','Y') -Wait -WindowStyle Hidden | Out-Null
    Start-Process icacls.exe -ArgumentList @($Path,'/grant','*S-1-5-32-544:(OI)(CI)F','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
    Start-Process attrib.exe -ArgumentList @('-r','-h','-s',$Path,'/D') -Wait -WindowStyle Hidden | Out-Null

    $kids = @()
    try {
        $kids = Get-ChildItem -LiteralPath $Path -Force -EA SilentlyContinue
    } catch {}
    foreach ($k in $kids) {
        $isReparse = $false
        try { $isReparse = (($k.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) } catch {}
        if ($isReparse) {
            Write-Host ("    skip junction: " + $k.Name)
            # Remove the junction entry itself (does not recurse into target).
            try {
                Start-Process $cmdExe -ArgumentList ('/c rd /q "' + $k.FullName + '"') -Wait -WindowStyle Hidden | Out-Null
            } catch {}
            continue
        }
        Write-Host ("    fix ACL + attrib: " + $k.Name)
        try {
            if ($k.PSIsContainer) {
                Start-Process takeown.exe -ArgumentList @('/F',$k.FullName,'/A','/R','/D','Y') -Wait -WindowStyle Hidden | Out-Null
                Start-Process icacls.exe -ArgumentList @($k.FullName,'/grant','*S-1-5-32-544:(OI)(CI)F','/T','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
                Start-Process attrib.exe -ArgumentList @('-r','-h','-s',$k.FullName,'/S','/D') -Wait -WindowStyle Hidden | Out-Null
            } else {
                Start-Process takeown.exe -ArgumentList @('/F',$k.FullName,'/A') -Wait -WindowStyle Hidden | Out-Null
                Start-Process icacls.exe -ArgumentList @($k.FullName,'/grant','*S-1-5-32-544:F','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
                Start-Process attrib.exe -ArgumentList @('-r','-h','-s',$k.FullName) -Wait -WindowStyle Hidden | Out-Null
            }
        } catch {}
    }

    # PASS 3: rd /s /q again now that ACLs are corrected.
    Write-Host "    Pass 3: rd /s /q (retry) ..."
    $rc2 = Start-Process -FilePath $cmdExe -ArgumentList $rdArgs -Wait -WindowStyle Hidden -PassThru
    Write-Host ("    rd pass-3 exit: " + $rc2.ExitCode)

    # PASS 4: final .NET fallback for any single locked file.
    if ([System.IO.Directory]::Exists($Path)) {
        try { [System.IO.Directory]::Delete($Path,$true) } catch { Write-Host ("    .NET Delete: " + $_.Exception.Message) }
    }

    $sw.Stop()
    if ([System.IO.Directory]::Exists($Path)) {
        Write-Host ("  RESULT: STILL PRESENT after {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    } else {
        Write-Host ("  RESULT: gone in {0:N1}s" -f $sw.Elapsed.TotalSeconds)
    }
}
`;

// ============================================================
// IPC: preflight (renderer can call this to display blockers)
// ============================================================
ipcMain.handle('preflight', async () => {
  return preflightCheck();
});

// ============================================================
// IPC: run-fix - the destructive flow
// ============================================================
ipcMain.handle('run-fix', async (event) => {
  // A fix in progress must never be interrupted by an update restart.
  cancelUpdateRestartCountdown();
  fixInProgress = true;
  fixHasRun = true;
  try {
    return await runFixFlow(event);
  } finally {
    fixInProgress = false;
    if (updateDownloaded) {
      sendUpdateStatus({ state: 'deferred', version: updateVersion });
    }
  }
});

async function runFixFlow(event) {
  const send = (line, kind = 'out') => event.sender.send('fix-log', { line, kind });
  const noop = () => {};
  const warnings = [];

  // ----- Defense-in-depth elevation guard --------------------
  if (!await isElevatedSync()) {
    send('ERROR: This action requires Administrator. Re-launch the app elevated.', 'err');
    return { success: false, error: 'not_elevated' };
  }

  // ----- Preflight -------------------------------------------
  send('[0/8] Running environment preflight...', 'header');
  const pre = await preflightCheck();
  for (const t of REQUIRED_TOOLS) {
    const ok = pre.info.tools && pre.info.tools[t];
    send(`  ${ok ? 'OK ' : 'MISS'}  ${t}`, ok ? 'out' : 'err');
  }
  for (const t of OPTIONAL_TOOLS) {
    const ok = pre.info.tools && pre.info.tools[t];
    send(`  ${ok ? 'OK ' : 'opt '}  ${t}${ok ? '' : ' (optional)'}`, 'out');
  }
  send(`  Zoom present: ${pre.info.zoomPath} -> ${fs.existsSync(pre.info.zoomPath) ? 'YES' : 'NO'}`, 'out');
  send(`  Firstrun script: ${pre.info.firstRunScript} -> ${fs.existsSync(pre.info.firstRunScript) ? 'YES' : 'NO'}`, 'out');
  send(`  Interactive user: ${pre.info.interactiveUser}`, 'out');
  for (const w of pre.warnings) {
    warnings.push(w);
    send(`  WARN [${w.code}]: ${w.message}`, 'err');
  }
  if (!pre.ok) {
    for (const b of pre.blockers) {
      send(`  BLOCK [${b.code}]: ${b.message}`, 'err');
    }
    return {
      success: false,
      error: 'preflight_failed',
      blockers: pre.blockers,
      warnings
    };
  }

  // ============================================================
  // STEP 1: Kill user1 processes; attempt explicit session logoff
  //         via quser/logoff (diagnostics surfaced).
  // ============================================================
  send(`[1/8] Terminating '${FIX_USER}' processes and sessions...`, 'header');
  await runProcess('taskkill.exe',
    ['/F', '/FI', `USERNAME eq ${FIX_USER}`], send);
  const logoff = await tryLogoffUser(FIX_USER, pre.info.tools, send);
  // quser_missing is the expected path on Windows Home (no quser.exe shipped);
  // taskkill alone is sufficient, so it should not raise a warning.
  const realNotes = logoff.notes.filter(n => n !== 'quser_missing');
  if (realNotes.length) {
    warnings.push({
      code: 'logoff_partial',
      message: `Session logoff issues: ${realNotes.join(', ')}`
    });
  }
  await sleep(3000);
  await runProcess('taskkill.exe',
    ['/F', '/FI', `USERNAME eq ${FIX_USER}`], noop);
  await sleep(2000);

  // ============================================================
  // STEP 2: Pre-clean any leftover suffixed profile folders
  //         (e.g. user1.MACHINENAME) from earlier botched resets.
  // ============================================================
  send('[2/8] Removing leftover suffixed profile folders...', 'header');
  await runPSScript(`
    ${PS_REMOVE_PROFILE_HELPER}
    $u = '${FIX_USER}'
    $folders = Get-ChildItem 'C:\\Users' -Directory -Force -EA 0 | Where-Object { $_.Name -match ('^' + [Regex]::Escape($u) + '\\.') }
    if (-not $folders) { Write-Host '  None found.'; return }
    foreach ($f in $folders) {
      Write-Host "  Found: $($f.FullName)"
      Remove-ProfileFolder -Path $f.FullName
    }
  `, send, { heartbeatMs: 5000, heartbeatLabel: 'suffixed-profile cleanup', timeoutMs: 300000 });

  // ============================================================
  // STEP 3: Delete the existing user1 account, profile folder,
  //         and ProfileList registry entries.
  // ============================================================
  send('[3/8] Removing existing account and profile...', 'header');
  const accountExisted = await userExists(FIX_USER);

  // Resolve SID BEFORE deleting the account. Once `net user /delete` runs,
  // NTAccount lookup fails. We still need the SID to unload the user's
  // NTUSER.DAT hive before deleting the profile folder.
  let preDeleteSid = '';
  if (accountExisted) {
    preDeleteSid = await resolveSID(FIX_USER);
    send(`  Resolved SID: ${preDeleteSid || '(none)'}`, 'out');
  }

  if (accountExisted) {
    const del = await runProcess('net.exe', ['user', FIX_USER, '/delete'], send,
      { heartbeatMs: 5000, heartbeatLabel: 'net user /delete', timeoutMs: 60000 });
    if (del.code !== 0) {
      send(`ERROR: failed to delete account '${FIX_USER}'.`, 'err');
      return { success: false, error: 'delete_user_failed', warnings };
    }
    send('  Account deleted.', 'out');
  } else {
    send('  Account does not exist - skipping account delete.', 'out');
  }

  const sourceProfile = `C:\\Users\\${FIX_USER}`;
  if (fs.existsSync(sourceProfile)) {
    send(`  Removing profile folder ${sourceProfile} (rd /s /q first; ACL fix only on residue)...`, 'out');
    const delProfile = await runPSScript(`
      ${PS_REMOVE_PROFILE_HELPER}
      $p = '${sourceProfile}'
      $sid = '${preDeleteSid}'
      Remove-ProfileFolder -Path $p -Sid $sid
      if (Test-Path $p) {
        Write-Host "  ERROR: $p still exists - a handle may still be open."
        Write-Host "         Reboot once and re-run."
        exit 1
      }
      Write-Host "  Profile folder deleted."
    `, send, { heartbeatMs: 5000, heartbeatLabel: 'profile delete', timeoutMs: 480000 });
    if (delProfile.timedOut) {
      send('ERROR: profile delete timed out after 8 minutes. A handle is likely still open (Zoom, antivirus, search indexer).', 'err');
      send('  Try: reboot, then re-run the fix.', 'err');
      return { success: false, error: 'delete_profile_timeout', warnings };
    }
    if (delProfile.code !== 0) {
      send('ERROR: profile folder could not be removed. Reboot and try again.', 'err');
      return { success: false, error: 'delete_profile_failed', warnings };
    }
  } else {
    send(`  ${sourceProfile} did not exist - nothing to delete.`, 'out');
  }

  // Wider ProfileList sweep. Match entries TWO ways:
  //   1. ProfileImagePath points at C:\Users\user1 (or user1.SOMETHING).
  //   2. PSChildName == preDeleteSid OR preDeleteSid + ".bak".
  //
  // The second match catches the post-1132-reset failure mode where UPS
  // renamed the live <sid> key to <sid>.bak (Event 1515) and minted a
  // fresh <sid> key whose ProfileImagePath now references
  // C:\Users\TEMP.<machine>.NNN. A path-only match misses the broken
  // primary key, leaving Windows to keep falling back to TEMP profiles.
  //
  // Folder sweep also widened: any ProfileImagePath we removed becomes
  // an orphan folder candidate, regardless of name shape.
  await runPSScript(`
    ${PS_REMOVE_PROFILE_HELPER}
    $u = '${FIX_USER}'
    $preDeleteSid = '${preDeleteSid}'
    $base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList'
    $cleaned = 0
    $orphanPaths = New-Object System.Collections.Generic.HashSet[string]
    Get-ChildItem $base -EA SilentlyContinue | ForEach-Object {
      $name = $_.PSChildName
      $p = (Get-ItemProperty $_.PSPath -EA SilentlyContinue).ProfileImagePath
      $matchByPath = $p -and ($p -ieq ('C:\\Users\\' + $u) -or $p -like ('C:\\Users\\' + $u + '.*'))
      $matchBySid  = $preDeleteSid -and ($name -ieq $preDeleteSid -or $name -ieq ($preDeleteSid + '.bak'))
      if ($matchByPath -or $matchBySid) {
        if ($p) { [void]$orphanPaths.Add($p) }
        Write-Host "  Removing ProfileList entry: $name  ->  $p"
        Remove-Item $_.PSPath -Recurse -Force -EA SilentlyContinue
        $cleaned += 1
      }
    }
    Write-Host ("  Cleaned $cleaned ProfileList entries.")
    foreach ($orphan in $orphanPaths) {
      if (Test-Path $orphan) {
        Write-Host "  Removing orphan folder (from ProfileList): $orphan"
        Remove-ProfileFolder -Path $orphan
      }
    }
    Get-ChildItem 'C:\\Users' -Directory -Force -EA 0 | Where-Object { $_.Name -ieq $u -or $_.Name -match ('^' + [Regex]::Escape($u) + '\\.') } | ForEach-Object {
      Write-Host "  Removing leftover: $($_.FullName)"
      Remove-ProfileFolder -Path $_.FullName
    }
  `, send, { heartbeatMs: 5000, heartbeatLabel: 'leftover cleanup', timeoutMs: 300000 });

  // ============================================================
  // STEP 3b: Flush retained User Profile Service hive handles.
  //
  // ProfSvc (User Profile Service, hosted under svchost.exe) caches
  // loaded registry hives. After a delete+recreate cycle, a stale
  // handle into the deleted C:\Users\user1\AppData\Local\Microsoft\
  // Windows\UsrClass.dat can survive and block the NEXT user1 logon's
  // hive load (Event 1509: "Windows was unable to load ... UsrClass.dat").
  // UPS responds by renaming the SID key to <sid>.bak and minting a
  // TEMP profile (Event 1511/1515). Restarting ProfSvc forces it to
  // drop every retained hive handle. Tolerate failure - ProfSvc lives
  // in a shared svchost group; restart can be denied. Fall back to
  // sc.exe stop/start, then reg flush as last resort.
  // ============================================================
  send('[3b/8] Flushing User Profile Service hive cache...', 'header');
  await runPSScript(`
    try {
      $svc = Get-Service ProfSvc -EA Stop
      if ($svc.Status -eq 'Running') {
        try {
          Restart-Service ProfSvc -Force -EA Stop
          Write-Host '  ProfSvc restarted via Restart-Service.'
        } catch {
          Write-Host ('  Restart-Service failed: ' + $_.Exception.Message)
          $stop  = & sc.exe stop  ProfSvc 2>&1
          Start-Sleep -Seconds 2
          $start = & sc.exe start ProfSvc 2>&1
          Write-Host ('  sc.exe stop output:  ' + (($stop  | Out-String).Trim()))
          Write-Host ('  sc.exe start output: ' + (($start | Out-String).Trim()))
        }
      } else {
        Write-Host ('  ProfSvc status=' + $svc.Status + '; nothing to flush.')
      }
    } catch {
      Write-Host ('  WARNING: could not inspect ProfSvc: ' + $_.Exception.Message)
    }
    # Belt-and-suspenders: flush HKLM hive writes so the next logon
    # reads fresh ProfileList data, not cached.
    & reg.exe flush HKLM 2>&1 | Out-Null
    Write-Host '  HKLM flushed.'
  `, send, { heartbeatMs: 5000, heartbeatLabel: 'profsvc flush', timeoutMs: 60000 });

  // ============================================================
  // STEP 4: Recreate the account, add to Administrators,
  //         and VERIFY membership (no silent best-effort).
  // ============================================================
  send(`[4/8] Creating account '${FIX_USER}' and verifying admin membership...`, 'header');
  const create = await runProcess('net.exe',
    ['user', FIX_USER, FIX_PASS, '/add'], send);
  if (create.code !== 0) {
    send(`ERROR: failed to create '${FIX_USER}'.`, 'err');
    send('  Common cause: password complexity policy rejected the password.', 'err');
    return { success: false, error: 'create_user_failed', warnings };
  }
  send(`  Account '${FIX_USER}' created.`, 'out');

  // First try Add-LocalGroupMember by well-known SID; fallback to net localgroup.
  await runPSScript(`
    try { Add-LocalGroupMember -SID 'S-1-5-32-544' -Member '${FIX_USER}' -EA Stop; Write-Host '  Add-LocalGroupMember OK.' }
    catch {
      Write-Host ('  Add-LocalGroupMember failed: ' + $_.Exception.Message)
      $r = net localgroup administrators '${FIX_USER}' /add 2>&1
      Write-Host ('  net localgroup fallback: ' + ($r | Out-String).Trim())
    }
  `, send);

  // Verify
  const adminCheck = await verifyAdminMembership(FIX_USER);
  send(`  user1 in Administrators: ${adminCheck.inGroup ? 'YES' : 'NO'} (check method: ${adminCheck.method})`, adminCheck.inGroup ? 'out' : 'err');
  if (!adminCheck.inGroup) {
    warnings.push({
      code: 'admin_add_unverified',
      message: `'${FIX_USER}' is not visible in the local Administrators group. Zoom will still launch, but future Zoom updates or other admin actions performed by user1 may fail. Open lusrmgr.msc and add user1 to Administrators manually if needed.`
    });
    send('  WARNING: user1 admin membership could not be verified.', 'err');
    send('  Zoom will still launch as user1, but admin-only actions later may fail.', 'err');
  }

  // ============================================================
  // STEP 5: Launch Zoom once as user1 so Windows creates the profile.
  // ============================================================
  send(`[5/8] Launching Zoom as '${FIX_USER}'...`, 'header');
  // Re-check zoom in case it disappeared between preflight and now.
  if (!fs.existsSync(ZOOM_PATH)) {
    send(`ERROR: Zoom not found at ${ZOOM_PATH}.`, 'err');
    return { success: false, error: 'zoom_not_found', warnings };
  }
  const launchPs = `
    $pw = ConvertTo-SecureString '${FIX_PASS}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${FIX_USER}', $pw)
    try {
      Start-Process -FilePath '${ZOOM_PATH}' -WorkingDirectory '${ZOOM_DIR}' -Credential $cred -EA Stop
      Write-Host '  Zoom launched as ${FIX_USER}.'
    } catch {
      Write-Host ('  Launch failed: ' + $_.Exception.Message)
      exit 1
    }
  `;
  send(`  Dispatching Zoom launch (detached) ...`, 'out');
  const launch = await runPSScriptDetachedIO(launchPs);
  if (launch.code !== 0 && launch.code !== null) {
    // Detached PS exited non-zero — usually a PSCredential / Start-Process failure.
    // We can't capture the exact error here (stdio is ignored), so use the verify
    // poll below to distinguish "Zoom didn't start" from "PS misbehaved".
    send(`  Launch script exited with code ${launch.code}; verifying via Win32_Process...`, 'err');
  }

  // Verify Zoom is actually running as user1. With stdio:'ignore' on the
  // launcher we have no other signal. Use Win32_Process via Get-CimInstance
  // + Invoke-CimMethod GetOwner (CimInstance has NO GetOwner method itself —
  // earlier code used $_.GetOwner() which always threw and forced a false
  // negative). Poll up to ~9 s (Start-Process + CreateProcessWithLogonW can
  // take a few seconds for the first launch on a brand-new profile).
  let zoomSeen = false;
  for (let i = 0; i < 12; i++) {
    const r = await runPSCapture(`
      try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='Zoom.exe'" -EA SilentlyContinue
        $hit = $false
        foreach ($p in $procs) {
          $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner -EA SilentlyContinue
          if ($owner -and ($owner.User -ieq '${FIX_USER}')) { $hit = $true; break }
        }
        if ($hit) { Write-Output 'YES' } else { Write-Output 'NO' }
      } catch { Write-Output 'ERR' }
    `);
    if ((r.stdout || '').trim() === 'YES') { zoomSeen = true; break; }
    await sleep(750);
  }
  if (!zoomSeen) {
    send(`ERROR: Zoom.exe is not running as '${FIX_USER}' after launch.`, 'err');
    send('  Likely causes: Secondary Logon disabled, password policy mismatch, or Zoom crashed on startup.', 'err');
    send('  Try: sc.exe config seclogon start= demand && sc.exe start seclogon', 'err');
    return { success: false, error: 'launch_failed', warnings };
  }
  send(`  Confirmed: Zoom.exe is running as ${FIX_USER}.`, 'out');

  // ============================================================
  // STEP 6: Resolve the new user1 profile via registry first,
  //         folder fallback. Deploy firstrun + desktop shortcut.
  // ============================================================
  send('[6/8] Resolving new user1 profile path...', 'header');
  const profile = await resolveUserProfilePath(FIX_USER, 30, send);
  if (!profile.path) {
    send('  Checked registry keys:', 'err');
    profile.checkedKeys.forEach(k => send(`    - ${k}`, 'err'));
    send('  Checked folder paths:', 'err');
    profile.checkedPaths.forEach(p => send(`    - ${p}`, 'err'));
    send('  Skipping firstrun deploy + per-user Zoom config.', 'err');
    warnings.push({
      code: 'profile_not_materialized',
      message: `user1 profile did not appear within 30s. Registry keys checked: ${profile.checkedKeys.join('; ') || '(none)'}. Folders checked: ${profile.checkedPaths.join('; ') || '(none)'}.`
    });
    send('Done with warnings. Zoom should appear shortly.', 'success');
    return { success: true, warnings };
  }
  const newUserProfile = profile.path;
  send(`  Profile source: ${profile.source}, path: ${newUserProfile}`, 'out');
  if (profile.sid) send(`  SID: ${profile.sid}`, 'out');

  // Pre-seed ACLs on the freshly-created profile's registry hive files
  // (NTUSER.DAT + UsrClass.dat). Without an explicit grant, NTFS
  // inheritance on the new profile can leave SYSTEM/Administrators
  // without traverse rights in edge cases (e.g. after nuke-acls.ps1
  // runs broad-stroke against the user1 subtree). When UPS can't read
  // UsrClass.dat on the next user1 logon it emits Event 1509 and falls
  // back to a TEMP profile - exact failure mode observed in the wild
  // and verified via Application log.
  //
  // Raw-SID grants (icacls `*` prefix) survive even if the account is
  // later deleted; NTAccount lookup fails for deleted accounts but the
  // ACE itself remains valid for the same SID on recreate.
  if (profile.sid) {
    await runPSScript(`
      $sid = '${profile.sid}'
      $base = '${newUserProfile}'
      $targets = @(
        (Join-Path $base 'NTUSER.DAT'),
        (Join-Path $base 'AppData\\Local\\Microsoft\\Windows\\UsrClass.dat')
      )
      foreach ($f in $targets) {
        if (Test-Path $f) {
          $out = & icacls.exe $f /grant ('*' + $sid + ':(F)') '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' 2>&1
          Write-Host ('  icacls ' + $f + ': ' + (($out | Out-String).Trim()))
        } else {
          Write-Host ('  (skipped, not yet present: ' + $f + ')')
        }
      }
    `, send, { heartbeatMs: 5000, heartbeatLabel: 'hive acl seed', timeoutMs: 30000 });
  }

  send('  Deploying first-run setup helper...', 'out');
  const firstRunSrc = getFirstRunScriptPath();
  const firstRunDst = path.join(newUserProfile, 'Documents', 'zoom-firstrun-setup.ps1');
  const shortcutPath = path.join(newUserProfile, 'Desktop', 'Apply Zoom Settings.lnk');
  if (!fs.existsSync(firstRunSrc)) {
    send(`    WARNING: bundled firstrun script not found at ${firstRunSrc}. Skipping.`, 'err');
    warnings.push({ code: 'firstrun_missing', message: `Bundled firstrun script not found at ${firstRunSrc}.` });
  } else {
    try {
      fs.mkdirSync(path.join(newUserProfile, 'Documents'), { recursive: true });
      fs.mkdirSync(path.join(newUserProfile, 'Desktop'), { recursive: true });
      fs.copyFileSync(firstRunSrc, firstRunDst);
      send(`    Copied: ${firstRunDst}`, 'out');

      const iconForShortcut = getIconPath();
      const esc = s => String(s).replace(/'/g, "''");
      const shortcutPs = `
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut('${esc(shortcutPath)}')
        $lnk.TargetPath = 'powershell.exe'
        $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "${firstRunDst.replace(/"/g, '\\"')}"'
        $lnk.WorkingDirectory = '${esc(path.join(newUserProfile, 'Documents'))}'
        $lnk.IconLocation = '${esc(iconForShortcut)},0'
        $lnk.Description = 'Apply standard Zoom UI settings - run after signing into Zoom'
        $lnk.Save()
      `;
      await runPSScript(shortcutPs, send);
      if (fs.existsSync(shortcutPath)) {
        send(`    Shortcut: ${shortcutPath}`, 'out');
      } else {
        send('    WARNING: shortcut creation failed.', 'err');
        warnings.push({ code: 'shortcut_failed', message: 'Could not create Apply Zoom Settings shortcut on user1 desktop.' });
      }
      await runProcess('icacls.exe',
        [firstRunDst, '/grant', `${FIX_USER}:(R)`, '/C'], noop);
      await runProcess('icacls.exe',
        [shortcutPath, '/grant', `${FIX_USER}:(RX)`, '/C'], noop);
    } catch (err) {
      send(`    WARNING: firstrun deploy failed: ${err.message}`, 'err');
      warnings.push({ code: 'firstrun_deploy_failed', message: err.message });
    }
  }

  // ============================================================
  // STEP 7: Per-user Zoom config (no GPO, no media):
  //          - Windows dark mode (HKU\<SID>\...\Personalize)
  //          - Force-close all Zoom processes for the new user
  //          - Edit Zoom.us.ini to set theme.mode=2 (dark)
  //          - Mirror device-preference files (camera, mirror
  //            toggle) from your profile into the new one.
  // ============================================================
  send('[7/8] Configuring per-user Zoom preferences...', 'header');

  const userSID = profile.sid || (await resolveSID(FIX_USER));
  if (userSID) {
    await runPSScript(`
      $sid = '${userSID}'
      $null = reg query "HKU\\$sid" 2>$null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  Setting Windows dark mode for '${FIX_USER}'..."
        reg add "HKU\\$sid\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme   /t REG_DWORD /d 0 /f | Out-Null
        reg add "HKU\\$sid\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme /t REG_DWORD /d 0 /f | Out-Null
        Write-Host "  Dark mode set."
      } else {
        Write-Host "  WARNING: HKU\\$sid not loaded; skipping Windows dark mode."
      }
    `, send);

    // Grant camera + microphone consent for desktop (non-packaged) apps so
    // Zoom can access them under user1 without manual Settings > Privacy
    // trips. Delegated to scripts/grant-media-consent.ps1 (bundled via
    // extraResources). Script emits KEY=VALUE diagnostic lines that we
    // parse below; logic lives in PS for testability + reuse from CLI.
    const consentScript = getMediaConsentScriptPath();
    if (!fs.existsSync(consentScript)) {
      send(`  WARNING: grant-media-consent.ps1 not found at ${consentScript}; skipping consent grant.`, 'err');
      warnings.push({ code: 'consent_script_missing', message: `Bundled media-consent helper missing at ${consentScript}.` });
    } else {
      send('  Granting camera + microphone consent for desktop apps...', 'out');
      const consentResult = {
        cam_user: null, mic_user: null, cam_hklm: null, mic_hklm: null,
        hku_already_loaded: false, hku_loaded_temp: false,
        hku_unload_ok: false, hku_unload_failed: null,
        hku_load_failed: null,
        gpo_deny_camera: false, gpo_deny_microphone: false,
        frameserver_restored: false, frameserver_disabled: false, frameserver_missing: false
      };
      const consent = await runProcess('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', consentScript,
         '-Sid', userSID, '-User', FIX_USER, '-ProfilePath', newUserProfile],
        (line, kind) => {
          send(`    ${line}`, kind);
          const t = (line || '').trim();
          // Parse structured markers
          if (t === 'GPO_DENY_CAMERA') {
            consentResult.gpo_deny_camera = true;
            warnings.push({ code: 'gpo_deny_camera', message: 'Camera access is blocked by Windows organization/privacy policy (LetAppsAccessCamera = Force Deny). 1132 Fixer cannot override this. Ask your Windows administrator or use a non-managed device.' });
          } else if (t === 'GPO_DENY_MICROPHONE') {
            consentResult.gpo_deny_microphone = true;
            warnings.push({ code: 'gpo_deny_microphone', message: 'Microphone access is blocked by Windows organization/privacy policy (LetAppsAccessMicrophone = Force Deny). 1132 Fixer cannot override this. Ask your Windows administrator or use a non-managed device.' });
          } else if (t === 'HKU_ALREADY_LOADED=YES') {
            consentResult.hku_already_loaded = true;
          } else if (t === 'HKU_LOADED_TEMP=YES') {
            consentResult.hku_loaded_temp = true;
          } else if (t.startsWith('HKU_LOAD_FAILED=')) {
            consentResult.hku_load_failed = t.slice(16);
            warnings.push({ code: 'consent_hku_load_failed', message: `HKU\\${userSID} hive could not be loaded for per-user consent: ${t.slice(16)}. First-run reassertion in zoom-firstrun-setup.ps1 will retry from inside user1's session.` });
          } else if (t === 'HKU_UNLOAD_OK=YES') {
            consentResult.hku_unload_ok = true;
          } else if (t.startsWith('HKU_UNLOAD_FAILED=')) {
            consentResult.hku_unload_failed = t.slice(18);
            warnings.push({ code: 'consent_hku_unload_failed', message: `HKU\\${userSID} hive could not be unloaded after consent write: ${t.slice(18)}. NTUSER.DAT may stay locked until reboot.` });
          } else if (t === 'HKU_NOT_LOADED') {
            // Legacy marker — only push warning if no specific HKU_LOAD_FAILED already emitted.
            if (!consentResult.hku_load_failed) {
              warnings.push({ code: 'consent_hku_not_loaded', message: `HKU\\${userSID} hive was not loaded and could not be loaded for per-user consent. Per-user camera/mic consent skipped at main step; first-run will retry.` });
            }
          } else if (t === 'FRAMESERVER_RESTORED') {
            consentResult.frameserver_restored = true;
          } else if (t === 'FRAMESERVER_DISABLED') {
            consentResult.frameserver_disabled = true;
            warnings.push({ code: 'frameserver_disabled', message: 'Windows Camera Frame Server service is Disabled and could not be re-enabled. Cameras will not enumerate for any desktop app until FrameServer is set to Manual or Automatic.' });
          } else if (t === 'FRAMESERVER_MISSING') {
            consentResult.frameserver_missing = true;
            warnings.push({ code: 'frameserver_missing', message: 'FrameServer service not present on this Windows build (unusual on Win10/11) — cameras may not enumerate.' });
          } else if (t.startsWith('ERROR=')) {
            warnings.push({ code: 'consent_script_error', message: t.slice(6) });
          } else if (t.startsWith('HKLM_WRITE_FAIL=')) {
            warnings.push({ code: 'consent_hklm_write_fail', message: `HKLM consent write failed: ${t.slice(16)}` });
          } else if (t.startsWith('HKU_WRITE_FAIL=')) {
            warnings.push({ code: 'consent_hku_write_fail', message: `HKU consent write failed: ${t.slice(15)}` });
          } else if (t.startsWith('CAM_USER_GRANTED=')) consentResult.cam_user = t.slice(17) === 'YES';
          else if   (t.startsWith('MIC_USER_GRANTED=')) consentResult.mic_user = t.slice(17) === 'YES';
          else if   (t.startsWith('CAM_HKLM_GRANTED=')) consentResult.cam_hklm = t.slice(17) === 'YES';
          else if   (t.startsWith('MIC_HKLM_GRANTED=')) consentResult.mic_hklm = t.slice(17) === 'YES';
        },
        { heartbeatMs: 5000, heartbeatLabel: 'media-consent', timeoutMs: 30000 });
      if (consent.code !== 0) {
        warnings.push({ code: 'consent_exit_nonzero', message: `grant-media-consent.ps1 exited with code ${consent.code}.` });
      }
      // Policy is authoritative — if GPO denies, registry-level claim of
      // "fixed" is misleading. Treat policy-denied as NOT-OK, separate
      // status from registry-not-verified.
      const camPolicyBlock = consentResult.gpo_deny_camera;
      const micPolicyBlock = consentResult.gpo_deny_microphone;
      const camRegOk = consentResult.cam_user === true || consentResult.cam_hklm === true;
      const micRegOk = consentResult.mic_user === true || consentResult.mic_hklm === true;
      const camStatus = camPolicyBlock ? 'POLICY-BLOCKED'
                      : camRegOk        ? 'OK'
                      :                   'UNVERIFIED';
      const micStatus = micPolicyBlock ? 'POLICY-BLOCKED'
                      : micRegOk        ? 'OK'
                      :                   'UNVERIFIED';
      send(`  Consent: camera=${camStatus}, microphone=${micStatus} (per-user cam=${consentResult.cam_user}, mic=${consentResult.mic_user}; HKLM cam=${consentResult.cam_hklm}, mic=${consentResult.mic_hklm})`,
           (camStatus === 'OK' && micStatus === 'OK') ? 'out' : 'err');
      if (camStatus === 'UNVERIFIED') warnings.push({ code: 'camera_consent_unverified', message: 'Camera consent write did not verify. user1 may need to enable Camera access manually in Settings > Privacy & security > Camera, OR the FrameServer service may be Disabled.' });
      if (micStatus === 'UNVERIFIED') warnings.push({ code: 'mic_consent_unverified',    message: 'Microphone consent write did not verify. user1 may need to enable Microphone access manually in Settings > Privacy & security > Microphone.' });
      // Stash receipt fields on the response so renderer can show a clean
      // outcome panel rather than parsing logs.
      // (Exposed below in the final return alongside warnings.)
      var consentReceipt = {
        camera: camStatus,
        microphone: micStatus,
        hkuPath: consentResult.hku_already_loaded ? 'session'
              : consentResult.hku_loaded_temp     ? 'temp-load'
              :                                     'skipped',
        frameServer: consentResult.frameserver_disabled ? 'disabled-unfixable'
                  :  consentResult.frameserver_restored ? 'restored-from-disabled'
                  :  consentResult.frameserver_missing  ? 'missing'
                  :                                       'ok'
      };
    }
  } else {
    send(`  WARNING: could not resolve SID for '${FIX_USER}'; skipping dark mode.`, 'err');
    warnings.push({ code: 'sid_unresolved', message: `Could not translate '${FIX_USER}' to a SID; dark mode skipped.` });
  }

  const newZoomDir = path.join(newUserProfile, 'AppData', 'Roaming', 'Zoom', 'data');
  const srcZoomDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Zoom', 'data');
  const zoomIni = path.join(newZoomDir, 'Zoom.us.ini');

  let iniFound = false;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(zoomIni)) { iniFound = true; break; }
    await sleep(1000);
  }
  if (!iniFound) {
    try {
      fs.mkdirSync(newZoomDir, { recursive: true });
      fs.writeFileSync(zoomIni, 'com.zoom.client.theme.mode=2\r\n');
      send('  Seeded Zoom.us.ini with dark mode.', 'out');
    } catch (err) {
      send(`  WARNING: could not seed Zoom.us.ini: ${err.message}`, 'err');
      warnings.push({ code: 'ini_seed_failed', message: err.message });
    }
  }

  send('  Force-closing Zoom (full process tree)...', 'out');
  const zoomProcs = [
    'Zoom.exe', 'CptHost.exe', 'CptControl.exe', 'ZoomWebhook.exe',
    'Zoom_launcher.exe', 'ZoomTeamChat.exe', 'airhost.exe'
  ];
  for (const proc of zoomProcs) {
    await runProcess('taskkill.exe',
      ['/F', '/IM', proc, '/FI', `USERNAME eq ${FIX_USER}`], noop);
  }
  await runPSScript(`
    Get-CimInstance Win32_Process |
      Where-Object {
        if (-not $_.ExecutablePath) { return $false }
        if ($_.ExecutablePath -notlike '*\\Zoom\\*') { return $false }
        $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -EA SilentlyContinue
        return ($o -and ($o.User -ieq '${FIX_USER}'))
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
  `, noop);
  await sleep(4000);
  send('  Zoom closed.', 'out');

  if (fs.existsSync(zoomIni)) {
    send('  Writing dark mode to Zoom.us.ini...', 'out');
    const iniEdit = `
      $p = '${zoomIni.replace(/'/g, "''")}'
      $c = Get-Content -LiteralPath $p -Raw -EA 0
      if (-not $c) { $c = '' }
      if ($c -match '(?m)^com\\.zoom\\.client\\.theme\\.mode\\s*=') {
        $c = [Regex]::Replace($c, '(?m)^com\\.zoom\\.client\\.theme\\.mode\\s*=.*', 'com.zoom.client.theme.mode=2')
      } else {
        $c = 'com.zoom.client.theme.mode=2' + [Environment]::NewLine + $c
      }
      [IO.File]::WriteAllText($p, $c)
    `;
    await runPSScript(iniEdit, send);
  }

  if (fs.existsSync(srcZoomDir)) {
    send('  Copying device/preference files from your profile...', 'out');
    try { fs.mkdirSync(newZoomDir, { recursive: true }); } catch {}
    const prefFiles = [
      'viper.ini',
      'transcoding.ini',
      'zoomus.zmdb.kvs.enc.db',
      'zoomus.zmdb.kvs.enc.db-journal'
    ];
    let copied = 0;
    for (const f of prefFiles) {
      const srcF = path.join(srcZoomDir, f);
      const dstF = path.join(newZoomDir, f);
      if (fs.existsSync(srcF)) {
        try {
          fs.copyFileSync(srcF, dstF);
          send(`    Copied: ${f}`, 'out');
          copied++;
        } catch (err) {
          send(`    WARNING: failed to copy ${f}: ${err.message}`, 'err');
          warnings.push({ code: 'pref_copy_failed', message: `${f}: ${err.message}` });
        }
      }
    }
    if (copied === 0) {
      send('    NOTE: no preference files were copied (none present in source).', 'out');
    }
    await runProcess('icacls.exe',
      [newZoomDir, '/grant', `${FIX_USER}:(OI)(CI)F`, '/T', '/C'], noop);
  } else {
    send(`  NOTE: ${srcZoomDir} not found. Skipping prefs copy.`, 'out');
  }

  await sleep(2000);

  // ============================================================
  // STEP 8: Relaunch Zoom so the new prefs take effect.
  // ============================================================
  send(`[8/8] Relaunching Zoom as '${FIX_USER}'...`, 'header');
  const relaunch = await runPSScriptDetachedIO(launchPs);
  if (relaunch.code !== 0 && relaunch.code !== null) {
    warnings.push({ code: 'relaunch_failed', message: `Initial launch succeeded but relaunch exited with code ${relaunch.code}. Open Zoom manually.` });
  }

  send('Done. Zoom should appear momentarily.', 'success');
  if (warnings.length) {
    send(`Completed with ${warnings.length} warning(s) - see above.`, 'err');
  }
  send(`NEXT STEP for ${FIX_USER}:`, 'header');
  send('  1. Sign into Zoom on first launch.', 'out');
  send('  2. Double-click "Apply Zoom Settings" on the desktop to', 'out');
  send('     push mirror-off, dual monitors, mute-on-join, etc.', 'out');
  return {
    success: true,
    warnings,
    // typeof guard — consentReceipt is set inside the consent-script block;
    // if that block was skipped (script missing), receipt stays undefined.
    receipt: (typeof consentReceipt !== 'undefined') ? consentReceipt : null
  };
}

// ============================================================
// Shortcut helpers.
// Windows can present several "Desktop" folders to the same user:
//   - The classic per-user Desktop (C:\Users\<name>\Desktop)
//   - OneDrive-redirected Desktop (C:\Users\<name>\OneDrive\Desktop)
//   - Public Desktop (C:\Users\Public\Desktop, visible to every account)
// We scan all three for an existing "Launch Zoom as user1.lnk" so we don't
// stack duplicates, and for creation we prefer the OS-canonical user Desktop
// (which honors OneDrive redirection).
// ============================================================
const SHORTCUT_FILENAME = `Launch Zoom as ${FIX_USER}.lnk`;
const LAUNCHER_SCRIPT_NAME = `launch-zoom-as-${FIX_USER}.ps1`;
const LAUNCHER_SCRIPT_PATH = () => path.join(app.getPath('appData'), '1132 Fixer', LAUNCHER_SCRIPT_NAME);

async function getCanonicalUserDesktop() {
  // Ask Windows directly; this resolves to the OneDrive-redirected path when
  // that redirection is active on the current account.
  try {
    const r = await runPSCapture(`[Environment]::GetFolderPath('Desktop')`);
    const p = (r.stdout || '').trim();
    if (p) return p;
  } catch (_) { /* fall through */ }
  return path.join(os.homedir(), 'Desktop');
}

async function listDesktopLocations() {
  const seen = new Set();
  const out = [];
  const canonical = await getCanonicalUserDesktop();
  const push = (kind, p) => {
    if (!p) return;
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, path: p });
  };
  push('user', canonical);
  push('user', path.join(os.homedir(), 'Desktop'));
  if (process.env.OneDrive)         push('onedrive', path.join(process.env.OneDrive, 'Desktop'));
  if (process.env.OneDriveConsumer) push('onedrive', path.join(process.env.OneDriveConsumer, 'Desktop'));
  if (process.env.OneDriveCommercial) push('onedrive', path.join(process.env.OneDriveCommercial, 'Desktop'));
  push('public', path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'));
  return out;
}

async function inspectShortcut(lnkPath) {
  const esc = s => String(s).replace(/'/g, "''");
  try {
    const r = await runPSCapture(`
      try {
        $s = New-Object -ComObject WScript.Shell
        $sc = $s.CreateShortcut('${esc(lnkPath)}')
        @{ target = [string]$sc.TargetPath; arguments = [string]$sc.Arguments } | ConvertTo-Json -Compress
      } catch { Write-Output '' }
    `);
    const out = (r.stdout || '').trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch (_) {
    return null;
  }
}

function shortcutMatchesCurrentApp(info, expectedScript) {
  if (!info) return false;
  const target = (info.target || '').toLowerCase();
  const argsStr = (info.arguments || '').toLowerCase();
  // Our shortcuts launch powershell.exe -File <expectedScript>. Either condition
  // alone could match an unrelated PowerShell shortcut, so require both.
  const targetOk = target.endsWith('\\powershell.exe') || target === 'powershell.exe';
  const argsOk = argsStr.includes(expectedScript.toLowerCase());
  return targetOk && argsOk;
}

async function findExistingShortcuts() {
  const expectedScript = LAUNCHER_SCRIPT_PATH();
  const locations = await listDesktopLocations();
  const found = [];
  for (const loc of locations) {
    const lnk = path.join(loc.path, SHORTCUT_FILENAME);
    if (!fs.existsSync(lnk)) continue;
    const info = await inspectShortcut(lnk);
    found.push({
      kind: loc.kind,
      path: lnk,
      // null = inspection failed; treat conservatively as "unknown but present".
      valid: info ? shortcutMatchesCurrentApp(info, expectedScript) : null,
      target: info ? info.target : null,
      arguments: info ? info.arguments : null
    });
  }
  return found;
}

// ============================================================
// IPC: create-shortcut (current user's desktop, one-click re-launch)
// ============================================================
ipcMain.handle('create-shortcut', async () => {
  const desktop = await getCanonicalUserDesktop();
  const shortcutPath = path.join(desktop, SHORTCUT_FILENAME);
  const iconPath = getIconPath();

  const scriptPath = LAUNCHER_SCRIPT_PATH();
  const scriptDir = path.dirname(scriptPath);
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptContent =
      `$p = ConvertTo-SecureString '${FIX_PASS}' -AsPlainText -Force\r\n` +
      `$c = New-Object System.Management.Automation.PSCredential('${FIX_USER}', $p)\r\n` +
      `Start-Process -FilePath '${ZOOM_PATH}' -WorkingDirectory '${ZOOM_DIR}' -Credential $c\r\n`;
    fs.writeFileSync(scriptPath, scriptContent, 'utf8');
  } catch (err) {
    return { success: false, error: `Failed to write launcher script: ${err.message}` };
  }

  const escape = s => s.replace(/'/g, "''");
  const ps = [
    "$s = New-Object -ComObject WScript.Shell",
    `$sc = $s.CreateShortcut('${escape(shortcutPath)}')`,
    "$sc.TargetPath = 'powershell.exe'",
    `$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${escape(scriptPath)}"'`,
    `$sc.IconLocation = '${escape(iconPath)}'`,
    `$sc.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')`,
    `$sc.Description = 'Launch Zoom as ${FIX_USER}'`,
    "$sc.Save()"
  ].join('; ');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => resolve({ success: false, error: err.message }));
    child.on('close', code => {
      if (code === 0) resolve({ success: true, path: shortcutPath });
      else resolve({ success: false, error: stderr.trim() || `Exit ${code}` });
    });
  });
});

ipcMain.handle('shortcut-exists', async () => {
  const found = await findExistingShortcuts();
  // valid === null means we found the shortcut but COM inspection failed —
  // err on the side of "present" so we don't accidentally re-prompt. Only
  // valid === true is treated as a confirmed match.
  const anyValid = found.some(f => f.valid === true);
  const anyKnownStale = found.some(f => f.valid === false);
  const primary = found.find(f => f.kind === 'user') || found[0] || null;
  return {
    exists: found.length > 0,
    valid: anyValid && !anyKnownStale,
    stale: anyKnownStale,
    path: primary ? primary.path : null,
    locations: found
  };
});

ipcMain.handle('is-elevated', async () => {
  return isElevatedSync();
});

ipcMain.handle('quit-app', () => {
  app.quit();
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-system-info', () => {
  return {
    version: app.getVersion(),
    os: `Windows ${os.release()}`,
    admin: true
  };
});

// Feedback is relayed through feedback-proxy/, which holds the GitHub token
// server-side. The app ships NO credential: it posts plain JSON to a public
// url. Anything embedded here would be extractable from app.asar in the
// shipped installer, which is exactly how the old hardcoded token leaked.
// The proxy builds the issue title/body/labels itself, so a tampered client
// can't forge labels or issue content.
ipcMain.handle('submit-feedback', async (event, type, text) => {
  try {
    const version = app.getVersion();
    const endpoint = config.FEEDBACK_PROXY_URL;
    if (!endpoint) {
      return { success: false, error: 'Feedback service not configured' };
    }

    let url;
    try {
      url = new URL('/feedback', endpoint);
    } catch (_) {
      return { success: false, error: 'Feedback service misconfigured' };
    }
    // Refuse to send user text over plaintext http (localhost aside, for dev).
    if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      return { success: false, error: 'Feedback service must use https' };
    }

    const postData = JSON.stringify({
      type,
      text,
      version,
      os: `Windows ${os.release()}`
    });

    return new Promise((resolve) => {
      const transport = url.protocol === 'https:' ? https : require('http');
      const req = transport.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `1132Fixer/${version}`,
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 201) return resolve({ success: true });
          if (res.statusCode === 429) return resolve({ success: false, error: 'Too many submissions — try again later.' });
          if (res.statusCode === 503) return resolve({ success: false, error: 'Feedback service not configured' });
          resolve({ success: false, error: 'Submission failed' });
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Feedback service timed out' }); });
      req.on('error', () => resolve({ success: false, error: 'Network error' }));
      req.write(postData);
      req.end();
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ============================================================
// IPC: preflight-scan — Slice C premium UX surface.
// Builds on preflightCheck() with extra read-only probes the
// Preflight Scan screen needs: user1 account state, GPO media
// policy, FrameServer service state, HKU hive load state.
// Pure read — never mutates. Status enum:
//   'ready'      = green, nothing to do
//   'repairable' = amber, FIX NOW will repair
//   'warning'    = yellow, advisory, fix can still run
//   'blocked'    = red, manual action required first
// ============================================================
ipcMain.handle('preflight-scan', async () => {
  const pre = await preflightCheck();
  const cards = {};

  // --- Admin --------------------------------------------------
  cards.admin = pre.info.elevated
    ? { status: 'ready', label: 'Administrator', message: 'Running elevated.' }
    : { status: 'blocked', label: 'Administrator', message: 'Not elevated. Close and re-launch with Run as administrator.' };

  // --- Zoom ---------------------------------------------------
  cards.zoom = fs.existsSync(ZOOM_PATH)
    ? { status: 'ready', label: 'Zoom Workplace', message: ZOOM_PATH }
    : { status: 'blocked', label: 'Zoom Workplace', message: `Not found at ${ZOOM_PATH}. Install the machine-wide MSI.` };

  // --- Helper user (user1) ------------------------------------
  const helperExists = await userExists(FIX_USER);
  const helperProfileDir = `C:\\Users\\${FIX_USER}`;
  const helperProfileExists = fs.existsSync(helperProfileDir);
  if (!helperExists && !helperProfileExists) {
    cards.helperUser = { status: 'ready', label: 'Helper account', message: `'${FIX_USER}' will be created on FIX NOW.` };
  } else if (helperExists && helperProfileExists) {
    cards.helperUser = { status: 'repairable', label: 'Helper account', message: `'${FIX_USER}' exists with profile. FIX NOW will rebuild it.` };
  } else if (helperExists) {
    cards.helperUser = { status: 'repairable', label: 'Helper account', message: `'${FIX_USER}' account exists but no profile yet. FIX NOW will reset.` };
  } else {
    cards.helperUser = { status: 'warning', label: 'Helper account', message: `Stale profile folder at ${helperProfileDir} with no account. FIX NOW will clean it up.` };
  }

  // --- Cam / Mic policy + FrameServer + HKU (single PS round trip)
  const probe = await runPSCapture(`
    $out = @{}
    function GetPolicy([string]$name) {
      try {
        $v = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy' -Name $name -EA Stop
        return [int]$v.$name
      } catch { return -1 }
    }
    $out['cam_policy'] = GetPolicy 'LetAppsAccessCamera'
    $out['mic_policy'] = GetPolicy 'LetAppsAccessMicrophone'
    try {
      $svc = Get-Service FrameServer -EA Stop
      $out['fs_status']    = [string]$svc.Status
      $out['fs_starttype'] = [string]$svc.StartType
    } catch {
      $out['fs_status']    = 'MISSING'
      $out['fs_starttype'] = 'MISSING'
    }
    # HKU hive — informational only (renderer maps to 'will load temp' vs 'already loaded')
    $sid = $null
    try { $sid = (New-Object Security.Principal.NTAccount('${FIX_USER}')).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
    if ($sid) {
      $null = reg query "HKU\\$sid" 2>$null
      $out['hku_loaded'] = ($LASTEXITCODE -eq 0)
      $out['hku_sid']    = $sid
    } else {
      $out['hku_loaded'] = $false
      $out['hku_sid']    = ''
    }
    $out | ConvertTo-Json -Compress
  `, { timeoutMs: 20000 });

  let probeData = {};
  let probeFailed = false;
  if (probe.timedOut) {
    probeFailed = true;
  } else {
    try {
      probeData = JSON.parse((probe.stdout || '').trim() || '{}');
    } catch (_) {
      probeFailed = true;
    }
  }
  const probeFailMsg = probe.timedOut
    ? 'Probe timed out after 20s — Windows Defender or another AV may be holding PowerShell. FIX NOW can still run, but skip this check first.'
    : 'PowerShell probe failed — could not read this value. FIX NOW can still run.';

  const policyCard = (label, val) => {
    if (probeFailed) return { status: 'warning', label, message: probeFailMsg };
    // val: 0 = Force Allow, 1 = User in control, 2 = Force Deny, -1 = no policy
    if (val === 2) return { status: 'blocked',   label, message: `Blocked by Windows organization/privacy policy (Force Deny). 1132 Fixer cannot override this.` };
    if (val === 0) return { status: 'ready',     label, message: 'Allowed by policy (Force Allow).' };
    if (val === 1) return { status: 'ready',     label, message: 'Under user control (no Force Deny).' };
    if (val === -1) return { status: 'ready',    label, message: 'No restrictive policy detected.' };
    return { status: 'warning', label, message: 'Could not read policy registry.' };
  };
  cards.camPolicy = policyCard('Camera policy',     probeData.cam_policy);
  cards.micPolicy = policyCard('Microphone policy', probeData.mic_policy);

  // FrameServer
  if (probeFailed) {
    cards.frameServer = { status: 'warning', label: 'Camera Frame Server', message: probeFailMsg };
  } else {
    const fsStatus = probeData.fs_status;
    const fsStart  = probeData.fs_starttype;
    if (fsStatus === 'MISSING') {
      cards.frameServer = { status: 'blocked', label: 'Camera Frame Server', message: 'Service not present on this Windows build — cameras will not enumerate.' };
    } else if (fsStart === 'Disabled') {
      cards.frameServer = { status: 'repairable', label: 'Camera Frame Server', message: 'Disabled. FIX NOW will set it to Manual so cameras can enumerate.' };
    } else if (fsStatus === 'Running' || fsStart === 'Manual' || fsStart === 'Automatic') {
      cards.frameServer = { status: 'ready', label: 'Camera Frame Server', message: `${fsStatus} / ${fsStart}.` };
    } else {
      cards.frameServer = { status: 'warning', label: 'Camera Frame Server', message: `${fsStatus} / ${fsStart} — unexpected state.` };
    }
  }

  // HKU hive
  if (probeFailed) {
    cards.hku = { status: 'warning', label: 'User registry hive', message: probeFailMsg };
  } else if (probeData.hku_sid) {
    cards.hku = probeData.hku_loaded
      ? { status: 'ready',      label: 'User registry hive', message: `HKU\\${probeData.hku_sid} active — consent will write live.` }
      : { status: 'repairable', label: 'User registry hive', message: `HKU\\${probeData.hku_sid} not loaded — FIX NOW will mount NTUSER.DAT, write consent, then unmount.` };
  } else {
    cards.hku = { status: 'ready', label: 'User registry hive', message: `No '${FIX_USER}' SID yet — fresh create, nothing to mount.` };
  }

  // App version
  cards.version = { status: 'ready', label: 'App version', message: `1132 Fixer v${app.getVersion()}` };

  // Roll up overall readiness for renderer convenience.
  const statuses = Object.values(cards).map(c => c.status);
  let overall = 'ready';
  if (statuses.includes('blocked'))           overall = 'blocked';
  else if (statuses.includes('repairable'))   overall = 'repairable';
  else if (statuses.includes('warning'))      overall = 'warning';

  return {
    cards,
    overall,
    canRunFix: !statuses.includes('blocked'),
    blockers: pre.blockers,
    warnings: pre.warnings,
    info: pre.info
  };
});

// ============================================================
// IPC: support-report — sanitized markdown bundle for support.
// Caller passes the renderer-held context (last receipt, log tail);
// main process adds version/OS/preflight and sanitizes user-identifying
// strings before returning. Renderer presents Copy button.
// ============================================================
ipcMain.handle('support-report', async (_event, context = {}) => {
  const { receipt = null, logTail = '', stage = '' } = context;
  const version = app.getVersion();
  const osLine = `Windows ${os.release()}`;
  const elevated = await isElevatedSync();
  let preflight = null;
  try { preflight = await preflightCheck(); } catch (_) {}

  const currentUser = (os.userInfo().username || '').trim();
  const homeDir = (os.homedir() || '').trim();
  const hostname = (os.hostname() || '').trim();
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Belt-and-braces: never redact the operator name when it collides with
  // the public helper-account constant FIX_USER ('user1'). The bare-username
  // regex would otherwise corrupt every legitimate "Account 'user1' created"
  // log line. preflightCheck() already blocks this case via 'running_as_target',
  // but defense-in-depth keeps the sanitizer safe even if that gate moves.
  const safeToRedactBareUser = currentUser && currentUser.toLowerCase() !== FIX_USER.toLowerCase();

  const sanitize = (text) => {
    if (!text || typeof text !== 'string') return '';
    let out = text;
    // SID pattern (S-1-5-21-x-y-z-w)
    out = out.replace(/S-1-5-21-\d+-\d+-\d+-\d+/g, 'S-1-5-21-XXXX-XXXX-XXXX-XXXX');
    // Current user home path (case-insensitive)
    if (homeDir) {
      out = out.replace(new RegExp(escRe(homeDir), 'gi'), 'C:\\Users\\<you>');
    }
    // C:\Users\<currentUser>  (in case homedir-replace missed casing)
    if (currentUser) {
      const safeUser = escRe(currentUser);
      out = out.replace(new RegExp(`C:\\\\Users\\\\${safeUser}`, 'gi'), 'C:\\Users\\<you>');
      if (safeToRedactBareUser) {
        // Bare username at word boundary. Guarded above so we never strip
        // the public 'user1' helper-account name from the log.
        out = out.replace(new RegExp(`\\b${safeUser}\\b`, 'gi'), '<you>');
      }
    }
    // Machine name — appears in stale "user1.MACHINENAME" profile-folder
    // residue and in Windows path enumerations. Redact bare hostname; the
    // \b boundary keeps it from mangling unrelated substrings.
    if (hostname) {
      out = out.replace(new RegExp(`\\b${escRe(hostname)}\\b`, 'gi'), '<host>');
    }
    return out;
  };

  const md = [];
  md.push('## 1132 Fixer — Support Report');
  md.push('');
  md.push(`- **App version:** ${version}`);
  md.push(`- **OS:** ${osLine}`);
  md.push(`- **Administrator:** ${elevated ? 'YES' : 'NO'}`);
  if (stage) md.push(`- **Last stage reached:** ${stage}`);
  md.push('');
  if (preflight) {
    md.push('### Preflight summary');
    md.push(`- OK: ${preflight.ok}`);
    md.push(`- Blockers: ${preflight.blockers.length} — ${preflight.blockers.map(b => b.code).join(', ') || 'none'}`);
    md.push(`- Warnings: ${preflight.warnings.length} — ${preflight.warnings.map(w => w.code).join(', ') || 'none'}`);
    if (preflight.info && preflight.info.seclogon) {
      md.push(`- Secondary Logon: ${preflight.info.seclogon.status} / ${preflight.info.seclogon.startType}`);
    }
    md.push('');
  }
  if (receipt) {
    md.push('### Last fix receipt');
    md.push('```');
    md.push(`camera:      ${receipt.camera || 'n/a'}`);
    md.push(`microphone:  ${receipt.microphone || 'n/a'}`);
    md.push(`hkuPath:     ${receipt.hkuPath || 'n/a'}`);
    md.push(`frameServer: ${receipt.frameServer || 'n/a'}`);
    md.push('```');
    md.push('');
  }
  if (logTail) {
    md.push('### Recent log (sanitized — last ~80 lines)');
    md.push('```');
    const tail = logTail.split(/\r?\n/).slice(-80).join('\n');
    md.push(sanitize(tail));
    md.push('```');
  }
  return { success: true, markdown: md.join('\n') };
});
