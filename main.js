const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn } = require('child_process');
const config = require('./src/main/config');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

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
    backgroundColor: '#0a1020',
    alwaysOnTop: true,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'icon.ico')
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);
}

app.whenReady().then(() => {
  createWindow();

  autoUpdater.on('update-downloaded', () => {
    setTimeout(() => {
      autoUpdater.quitAndInstall(true, true);
    }, 2000);
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runProcess(exe, args, onLine) {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const child = spawn(exe, args, { windowsHide: true });
    const emit = (buf, kind) => {
      const text = buf.toString();
      if (kind === 'err') stderrBuf += text; else stdoutBuf += text;
      text.split(/\r?\n/).forEach(line => {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed) onLine(trimmed, kind);
      });
    };
    child.stdout.on('data', d => emit(d, 'out'));
    child.stderr.on('data', d => emit(d, 'err'));
    child.on('error', err => {
      onLine(`Failed to launch ${exe}: ${err.message}`, 'err');
      resolve({ code: -1, stdout: stdoutBuf, stderr: stderrBuf });
    });
    child.on('close', code => resolve({ code, stdout: stdoutBuf, stderr: stderrBuf }));
  });
}

async function runPSScript(scriptContent, onLine) {
  const tmp = path.join(os.tmpdir(),
    `fixer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  await fs.promises.writeFile(tmp, scriptContent, 'utf8');
  try {
    return await runProcess('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      onLine);
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

async function runPSCapture(scriptContent) {
  const noop = () => {};
  return runPSScript(scriptContent, noop);
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
  `);
  let presence = null;
  try {
    const parsed = JSON.parse((probe.stdout || '').trim() || '{}');
    if (parsed && typeof parsed === 'object') presence = parsed;
  } catch (_) { /* presence stays null */ }
  if (presence === null) {
    // PS probe failed entirely. Treat all required tools as missing.
    blockers.push({
      code: 'tool_probe_failed',
      message: 'PowerShell probe failed — could not verify Windows tools. Treating powershell.exe as unavailable.'
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
  for (const t of OPTIONAL_TOOLS) {
    if (!presence[t]) {
      warnings.push({
        code: 'optional_tool_missing',
        message: `Optional tool not available: ${t} (session logoff may be skipped)`
      });
    }
  }
  // seclogon: warn only — Start-Process -Credential can auto-start it if StartType != Disabled.
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
  } else if (info.seclogon.status !== 'Running') {
    warnings.push({
      code: 'seclogon_not_running',
      message: `Secondary Logon service is ${info.seclogon.status}/${info.seclogon.startType}. Windows should auto-start it on demand; will surface a clearer error if launch fails.`
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
function Remove-ProfileFolder {
    param([Parameter(Mandatory=$true)][string]$Path)
    $ErrorActionPreference = 'Continue'
    if (-not [System.IO.Directory]::Exists($Path)) { Write-Host "  Already gone: $Path"; return }
    Write-Host "  Deleting: $Path"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Process takeown.exe -ArgumentList @('/F',$Path,'/A','/R','/D','Y') -Wait -WindowStyle Hidden
    Start-Process icacls.exe -ArgumentList @($Path,'/grant','*S-1-5-32-544:(OI)(CI)F','/T','/C','/Q') -Wait -WindowStyle Hidden
    Start-Process attrib.exe -ArgumentList @('-r','-h','-s',$Path,'/S','/D') -Wait -WindowStyle Hidden
    # Use cmd's rd /s /q rather than robocopy /MIR. Default Windows user
    # profiles contain XP-compat junction points (Application Data, Cookies,
    # Local Settings, etc.) with explicit DENY-Everyone ACEs. robocopy /MIR
    # follows them and stalls; .NET Directory.Delete throws on them. rd /s /q
    # is the canonical Win32 profile-delete approach: it removes junction
    # points themselves rather than recursing into them.
    $cmdExe = Join-Path $env:SystemRoot 'System32\\cmd.exe'
    $rdArgs = '/c rd /s /q "' + $Path + '"'
    $rc = Start-Process -FilePath $cmdExe -ArgumentList $rdArgs -Wait -WindowStyle Hidden -PassThru
    Write-Host ("    rd exit: " + $rc.ExitCode)
    # Fallback: if rd left anything behind (e.g. file in use), try .NET Delete.
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
  if (logoff.notes.length) {
    warnings.push({
      code: 'logoff_partial',
      message: `Session logoff issues: ${logoff.notes.join(', ')}`
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
  `, send);

  // ============================================================
  // STEP 3: Delete the existing user1 account, profile folder,
  //         and ProfileList registry entries.
  // ============================================================
  send('[3/8] Removing existing account and profile...', 'header');
  const accountExisted = await userExists(FIX_USER);
  if (accountExisted) {
    const del = await runProcess('net.exe', ['user', FIX_USER, '/delete'], send);
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
    const delProfile = await runPSScript(`
      ${PS_REMOVE_PROFILE_HELPER}
      $p = '${sourceProfile}'
      Remove-ProfileFolder -Path $p
      if (Test-Path $p) {
        Write-Host "  ERROR: $p still exists - a handle may still be open."
        Write-Host "         Reboot once and re-run."
        exit 1
      }
      Write-Host "  Profile folder deleted."
    `, send);
    if (delProfile.code !== 0) {
      send('ERROR: profile folder could not be removed. Reboot and try again.', 'err');
      return { success: false, error: 'delete_profile_failed', warnings };
    }
  } else {
    send(`  ${sourceProfile} did not exist - nothing to delete.`, 'out');
  }

  await runPSScript(`
    ${PS_REMOVE_PROFILE_HELPER}
    $u = '${FIX_USER}'
    $base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList'
    $cleaned = 0
    Get-ChildItem $base -EA SilentlyContinue | ForEach-Object {
      $p = (Get-ItemProperty $_.PSPath -EA SilentlyContinue).ProfileImagePath
      if ($p -and ($p -ieq ('C:\\Users\\' + $u) -or $p -like ('C:\\Users\\' + $u + '.*'))) {
        Write-Host "  Removing ProfileList entry: $($_.PSChildName)  ->  $p"
        Remove-Item $_.PSPath -Recurse -Force -EA SilentlyContinue
        $cleaned += 1
      }
    }
    Write-Host ("  Cleaned $cleaned ProfileList entries.")
    Get-ChildItem 'C:\\Users' -Directory -Force -EA 0 | Where-Object { $_.Name -ieq $u -or $_.Name -match ('^' + [Regex]::Escape($u) + '\\.') } | ForEach-Object {
      Write-Host "  Removing leftover: $($_.FullName)"
      Remove-ProfileFolder -Path $_.FullName
    }
  `, send);

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
  // STEP 5: Launch Zoom as user1 to materialize the profile.
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
  return { success: true, warnings };
});

// ============================================================
// IPC: create-shortcut (current user's desktop, one-click re-launch)
// ============================================================
ipcMain.handle('create-shortcut', async () => {
  const desktop = path.join(os.homedir(), 'Desktop');
  const shortcutPath = path.join(desktop, `Launch Zoom as ${FIX_USER}.lnk`);
  const iconPath = getIconPath();

  const scriptDir = path.join(app.getPath('appData'), '1132 Fixer');
  const scriptPath = path.join(scriptDir, `launch-zoom-as-${FIX_USER}.ps1`);
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

ipcMain.handle('show-shortcut-prompt', async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Yes, create shortcut', 'No thanks'],
    defaultId: 0,
    cancelId: 1,
    title: 'Create Desktop Shortcut',
    message: `Place a "Launch Zoom as ${FIX_USER}" shortcut on your desktop?`,
    detail: `One-click re-launch of Zoom as ${FIX_USER}. Windows may ask for the ${FIX_USER} password the first time (saved for later).`
  });
  return result.response === 0;
});

ipcMain.handle('show-fix-confirm', async () => {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Continue', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Confirm Fix - Destructive',
    message: `This will completely reset the local '${FIX_USER}' account.`,
    detail:
      `The fix will:\n` +
      `  - Log off any active '${FIX_USER}' session\n` +
      `  - Delete the local '${FIX_USER}' account\n` +
      `  - Delete C:\\Users\\${FIX_USER} and any suffixed copies\n` +
      `  - Wipe ProfileList registry entries for '${FIX_USER}'\n` +
      `  - Recreate '${FIX_USER}' (password: ${FIX_PASS}) as a local admin\n` +
      `  - Launch Zoom Workplace as '${FIX_USER}'\n` +
      `  - Deploy "Apply Zoom Settings" helper on the new desktop\n\n` +
      `Do NOT continue if you are currently signed in as '${FIX_USER}'.`
  });
  return result.response === 0;
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

ipcMain.handle('submit-feedback', async (event, type, text) => {
  try {
    const version = app.getVersion();
    const title = `[${type}] ${text.substring(0, 80)}${text.length > 80 ? '...' : ''}`;
    const body = `**Type:** ${type}\n**App Version:** ${version}\n**OS:** Windows ${os.release()}\n\n---\n\n${text}`;

    const token = config.GH_ISSUES_TOKEN;
    if (!token) {
      return { success: false, error: 'Feedback service not configured' };
    }

    const label = type === 'User Rating' ? 'user-rating' : type.toLowerCase().replace(' ', '-');
    const postData = JSON.stringify({ title, body, labels: [label] });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${config.GH_ISSUES_REPO}/issues`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': `1132Fixer/${version}`,
          'Accept': 'application/vnd.github+json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 201) resolve({ success: true });
          else resolve({ success: false, error: 'Submission failed' });
        });
      });
      req.on('error', () => resolve({ success: false, error: 'Network error' }));
      req.write(postData);
      req.end();
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});
