const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const config = require('./src/main/config');
const zoomDetect = require('./zoom-detect');
const { computeRunVerdict, deletionOutcome } = require('./run-verdict');

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

// ============================================================
// Portable-build update notice.
//
// electron-updater cannot update the portable target, so portable users
// were silently pinned to whatever version they downloaded — forever.
// Instead: fetch latest.yml from the public Releases repo (same feed the
// NSIS updater uses), compare versions, and surface a "download it" banner.
// Owner/repo mirror build.publish in package.json.
// ============================================================
const RELEASES_LATEST_URL = 'https://github.com/PrimeUpYourLife/1132-Fixer-Windows-Releases/releases/latest';
const LATEST_YML_URL = RELEASES_LATEST_URL + '/download/latest.yml';
const WEBSITE_URL = 'https://1132-fixer.xyz/';
const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000; // long-open apps re-check every 4h

// GitHub's /releases/latest/download/* is a 302 to the CDN; plain
// https.get does not follow redirects, so walk them (bounded).
function httpsGetText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `1132Fixer/${app.getVersion()}` }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return resolve(httpsGetText(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function isNewerVersion(candidate, current) {
  const a = String(candidate).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function checkPortableUpdate() {
  try {
    const body = await httpsGetText(LATEST_YML_URL);
    const m = /^version:\s*(\S+)/m.exec(body || '');
    if (!m) {
      console.warn(`${UPDATER} portable check: latest.yml had no version line`);
      return;
    }
    const latest = m[1].trim();
    if (isNewerVersion(latest, app.getVersion())) {
      console.log(`${UPDATER} portable check: v${latest} available (running v${app.getVersion()})`);
      sendUpdateStatus({ state: 'manual', version: latest });
    } else {
      console.log(`${UPDATER} portable check: up to date (v${app.getVersion()})`);
    }
  } catch (err) {
    // Non-fatal: offline or GitHub unreachable; retried on the next tick.
    console.warn(`${UPDATER} portable check failed: ${(err && err.message) || err}`);
  }
}

ipcMain.handle('open-download-page', () => {
  shell.openExternal(RELEASES_LATEST_URL);
  return { success: true };
});

ipcMain.handle('open-website', () => {
  shell.openExternal(WEBSITE_URL);
  return { success: true };
});

const FIX_USER = 'user1';
const FIX_PASS = 'user1';
// Default machine-wide install candidates only — the actual install is
// resolved by resolveZoomInstall() (W1-DETECT: 32-bit MSI, custom install
// dirs, and per-user installs all exist in the field).
const ZOOM_PATH = 'C:\\Program Files\\Zoom\\bin\\Zoom.exe';
// Working directory for Start-Process -Credential. Without an explicit
// -WorkingDirectory the new process inherits the caller's cwd, which for
// per-user NSIS installs is a path user1 has no ACLs on, producing
// "The directory name is invalid" (Win32 ERROR_DIRECTORY / 267).
// The Zoom install dir is the natural cwd and is readable by all local users.
const ZOOM_DIR  = 'C:\\Program Files\\Zoom\\bin';
const ZOOM_X86_PATH = 'C:\\Program Files (x86)\\Zoom\\bin\\Zoom.exe';

// ============================================================
// Machine-wide Zoom install resolution (W1-DETECT).
// The fix launches Zoom under the user1 helper account, so ONLY machine-wide
// installs are launchable. A per-user install (%APPDATA%\Zoom of the CURRENT
// user) is probed purely so preflight can explain the situation instead of a
// generic "not found" — it is never accepted as the launch path.
// Pure parsing/validation/copy lives in zoom-detect.js.
// ============================================================
// Resolved once per preflight scan and reused by the fix run and shortcut
// creation (both re-resolve if the cache is empty or the exe vanished).
let zoomInstall = null; // { path, dir, source, perUserPath }

async function resolveZoomInstall() {
  const perUserCandidate = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe')
    : '';
  const perUserPath = perUserCandidate && fs.existsSync(perUserCandidate)
    ? perUserCandidate
    : null;

  // Every resolved path is later interpolated into single-quoted PowerShell
  // (Zoom launch + helper-shortcut launcher), so validate here — the single
  // choke point — and treat an unsafe path as not found.
  const found = (p, dir, source) => {
    if (!zoomDetect.isSafeZoomPath(p)) {
      console.warn(`[zoom-detect] rejected unsafe Zoom path (${source}): ${p}`);
      return null;
    }
    return { path: p, dir, source, perUserPath };
  };

  const defaults = [
    { path: ZOOM_PATH, dir: ZOOM_DIR, source: 'default-x64' },
    { path: ZOOM_X86_PATH, dir: path.dirname(ZOOM_X86_PATH), source: 'default-x86' }
  ];
  for (const c of defaults) {
    if (fs.existsSync(c.path)) {
      const hit = found(c.path, c.dir, c.source);
      if (hit) return hit;
    }
  }

  // Registry fallback: a machine-wide MSI installed to a custom dir still
  // registers an HKLM uninstall key (64- or 32-bit view). One bounded PS
  // probe; any failure or timeout = no hit.
  const probe = await runPSCapture(`
    $keys = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    foreach ($k in $keys) {
      foreach ($i in (Get-ItemProperty -Path $k -EA SilentlyContinue)) {
        $dn = [string]$i.DisplayName
        if ($dn -like 'Zoom*' -and $dn -notlike 'Zoom Outlook*' -and $dn -notlike 'Zoom Plugin*') {
          if ($i.InstallLocation) { Write-Output ('InstallLocation=' + $i.InstallLocation) }
          if ($i.DisplayIcon)     { Write-Output ('DisplayIcon=' + $i.DisplayIcon) }
        }
      }
    }
  `, { timeoutMs: 10000 });
  if (!probe.timedOut && probe.code === 0) {
    for (const dir of zoomDetect.deriveCandidateDirs(probe.stdout)) {
      for (const exe of [path.join(dir, 'bin', 'Zoom.exe'), path.join(dir, 'Zoom.exe')]) {
        if (fs.existsSync(exe)) {
          const hit = found(exe, path.dirname(exe), 'registry');
          if (hit) return hit;
        }
      }
    }
  } else {
    console.warn(`[zoom-detect] registry probe ${probe.timedOut ? 'timed out' : `failed (exit ${probe.code})`} — treating as no registry hit`);
  }

  return { path: null, dir: null, source: null, perUserPath };
}

// Tools that must exist on PATH; the destructive flow can't run without them.
const REQUIRED_TOOLS = [
  'powershell.exe', 'taskkill.exe', 'robocopy.exe',
  'icacls.exe', 'takeown.exe', 'net.exe', 'reg.exe'
];
// Tools we'd like but can survive without — surfaced as warnings.
const OPTIONAL_TOOLS = ['quser.exe', 'logoff.exe'];

let mainWindow;

ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 720,
    minHeight: 640,
    backgroundColor: '#0F1724',
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

  // Hung renderer: offer a way out instead of a silently frozen window.
  // The fix engine runs in THIS process, so "keep waiting" is often right
  // while PowerShell grinds; the prompt says so instead of guessing.
  mainWindow.on('unresponsive', () => {
    if (fatalDialogShown) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '1132 Fixer',
      message: 'The 1132 Fixer window is not responding.',
      detail: fixInProgress
        ? 'A fix is still running in the background — give it a moment before restarting. It is safe to run the fix again after a restart.'
        : 'You can keep waiting or restart the app.',
      buttons: ['Keep waiting', 'Restart 1132 Fixer'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (choice === 1) {
      fatalDialogShown = true;
      killActiveChildren();
      app.relaunch();
      app.exit(1);
    }
  });

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
  // portable targets) — it gets a manual-download notice instead — and dev
  // runs have no app-update.yml, which used to produce a red-herring updater
  // error on every launch.
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  if (app.isPackaged && !isPortable) {
    const checkNow = () => {
      autoUpdater.checkForUpdates().catch((err) => {
        // Non-fatal: app continues without auto-update. Visible in logs now.
        console.warn(`${UPDATER} checkForUpdates rejected: ${(err && err.message) || err}`);
      });
    };
    setTimeout(checkNow, 3000);
    // Long-open sessions: re-check periodically. Skip while a fix is running
    // (never surprise the destructive flow) or once a download already landed.
    setInterval(() => {
      if (updateDownloaded || fixInProgress) return;
      checkNow();
    }, UPDATE_RECHECK_MS);
  } else if (app.isPackaged && isPortable) {
    setTimeout(checkPortableUpdate, 3000);
    setInterval(() => {
      if (!fixInProgress) checkPortableUpdate();
    }, UPDATE_RECHECK_MS);
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
// Fatal-path handling — the app must never die silently.
// Three uncovered paths before this existed: a main-process throw
// (window never appears, no message), a dead renderer (blank window),
// and a hung renderer (frozen window). Each now says what happened
// and what to do next, in the same voice as messages.js.
// ============================================================
let fatalDialogShown = false;

// Fix steps run as child processes (runProcess). Exiting Electron does NOT
// reliably end them on Windows, and an orphaned fix child mutating accounts/
// registry while a relaunched instance starts a second fix would mean two
// concurrent writers on system state. Every fatal exit path kills the tracked
// child TREE first; the fix is safe to re-run and repairs the interrupted run.
const activeChildren = new Set();
function killActiveChildren() {
  for (const child of activeChildren) {
    if (!child.pid) continue;
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
      console.warn(`fatal-path: killed child tree pid=${child.pid}`);
    } catch (err) {
      console.warn(`fatal-path: could not kill child pid=${child.pid}: ${err && err.message}`);
    }
  }
  activeChildren.clear();
}

process.on('uncaughtException', (err) => {
  console.error('FATAL uncaughtException:', (err && err.stack) || err);
  killActiveChildren(); // before the blocking dialog — never leave a writer running
  if (!fatalDialogShown) {
    fatalDialogShown = true;
    try {
      dialog.showErrorBox(
        '1132 Fixer hit a problem it could not recover from',
        'The app has to close. If a fix was running, run it again after ' +
        'restarting — the fix is safe to repeat and repairs partial runs.\n\n' +
        'Start 1132 Fixer again. If this keeps happening, report it at\n' +
        'https://github.com/PrimeUpYourLife/1132-Fixer-Windows/issues\n\n' +
        `Detail for support: ${(err && err.message) || err}`
      );
    } catch (_) { /* dialog itself failed — the console line above remains */ }
  }
  app.exit(1);
});

app.on('render-process-gone', (_event, _webContents, details) => {
  if (details && details.reason === 'clean-exit') return;
  console.error(`FATAL render-process-gone: reason=${details && details.reason} exitCode=${details && details.exitCode}`);
  if (fatalDialogShown) return;
  fatalDialogShown = true;
  const hadFix = fixInProgress;
  killActiveChildren(); // before the blocking dialog — never leave a writer running
  const fixNote = hadFix
    ? '\n\nA fix was running — it has been stopped. Run it again after restarting; the fix is safe to repeat and repairs partial runs.'
    : '';
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: '1132 Fixer',
    message: 'The 1132 Fixer window stopped working.',
    detail: `Windows ended the interface process (reason: ${(details && details.reason) || 'not reported'}).` +
            ' Restart the app to continue.' + fixNote,
    buttons: ['Restart 1132 Fixer', 'Close'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (choice === 0) app.relaunch();
  app.exit(1);
});


// ============================================================
// Path / process helpers
// ============================================================

function getIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, 'assets', 'icon.ico');
}

// The helper shortcut carries its own mark (two-user handoff), distinct from
// the application icon. Resolved the same way as getIconPath(): an INSTALLED
// path in both modes, so a created .lnk never points into a worktree or temp
// directory that will not exist on the user's machine tomorrow.
function getHelperIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, '1132-helper-shortcut.ico')
    : path.join(__dirname, 'assets', '1132-helper-shortcut.ico');
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
    activeChildren.add(child);
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
      activeChildren.delete(child);
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
  // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less files in the legacy
  // system codepage, which corrupts non-ASCII install paths interpolated
  // into the script (review P2 on custom Unicode Zoom dirs).
  await fs.promises.writeFile(tmp, '\ufeff' + scriptContent, 'utf8');
  try {
    return await runProcess('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
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
  // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less files in the legacy
  // system codepage, which corrupts non-ASCII install paths interpolated
  // into the script (review P2 on custom Unicode Zoom dirs).
  await fs.promises.writeFile(tmp, '\ufeff' + scriptContent, 'utf8');
  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
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

// Elevation cannot change for the lifetime of the process, so probe once and
// memoize. This check used to spawn net.exe on every preflight, every focus
// re-scan, and twice at renderer bootstrap.
let _elevatedPromise = null;
function isElevatedSync() {
  if (_elevatedPromise) return _elevatedPromise;
  // net.exe session is the standard Windows admin check: requires admin to enumerate sessions.
  _elevatedPromise = new Promise(resolve => {
    const child = spawn('net.exe', ['session'], { windowsHide: true });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
  return _elevatedPromise;
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

  // Kick off the PowerShell tool probe FIRST — it dominates preflight
  // wall-clock (~1-2s PS startup) and is independent of every other check,
  // so the elevation probe and sync fs checks run under it for free.
  const allTools = [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS];
  const probePromise = runPSCapture(`
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

  // Zoom executable — machine-wide only. resolveZoomInstall() also spots a
  // per-user install so the blocker explains it instead of a bare "not found".
  zoomInstall = await resolveZoomInstall();
  info.zoomInstall = zoomInstall;
  info.zoomPath = zoomInstall.path;
  if (!zoomInstall.path) {
    blockers.push({
      code: 'zoom_not_found',
      message: zoomDetect.zoomStatusMessage(zoomInstall)
    });
  }

  // Required + optional tools + Secondary Logon service (Start-Process -Credential needs it)
  const probe = await probePromise;
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
    status: presence.seclogon_status || 'not checked',
    startType: presence.seclogon_starttype || 'not checked'
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
  // SID translation happens INSIDE the same PS process — a separate
  // resolveSID() round trip costs a full powershell.exe startup.
  const r = await runPSCapture(`
    $user = '${username}'
    $userSid = ''
    try { $userSid = (New-Object System.Security.Principal.NTAccount($user)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
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
    Write-Output ("SID=" + $userSid)
  `);
  const lines = (r.stdout || '').split(/\r?\n/).map(s => s.trim());
  let method = 'unknown', result = 'NO', sid = '';
  for (const l of lines) {
    if (l.startsWith('METHOD=')) method = l.slice(7);
    else if (l.startsWith('RESULT=')) result = l.slice(7);
    else if (l.startsWith('SID=')) sid = l.slice(4);
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
  const literal = `C:\\Users\\${username}`;

  // The whole poll loop runs INSIDE one PowerShell process. The old
  // spawn-per-tick design paid ~0.5-1s of powershell.exe startup per second
  // of wait, roughly doubling the effective interval and burning up to 30
  // spawns. Internal loop: one spawn, 500ms ticks, same output protocol.
  //
  // Use [System.IO.File]::Exists instead of Test-Path: Test-Path throws on
  // access-denied NTFS ACLs (which the freshly-created user1 profile commonly
  // has against the calling admin account), whereas File.Exists returns false.
  const script = `
    $u = '${username}'
    $literal = '${literal.replace(/'/g, "''")}'
    $deadline = [DateTime]::UtcNow.AddSeconds(${Math.max(1, maxWaitSec)})
    $sid = ''; $key = ''; $lastReg = ''; $match = ''

    function Profile-Has-NTUserDat([string]$dir) {
      if (-not $dir) { return $false }
      try { return [System.IO.File]::Exists((Join-Path $dir 'NTUSER.DAT')) } catch { return $false }
    }

    do {
      if (-not $sid) {
        try { $sid = (New-Object System.Security.Principal.NTAccount($u)).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
        if ($sid) { $key = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\' + $sid }
      }
      $regPath = ''
      if ($key) {
        try {
          $rp = (Get-ItemProperty -Path $key -EA SilentlyContinue).ProfileImagePath
          if ($rp) { $regPath = $rp; $lastReg = $rp }
        } catch {}
      }
      if ($regPath -and (Profile-Has-NTUserDat $regPath)) { $match = 'registry|' + $regPath; break }
      if (Profile-Has-NTUserDat $literal) { $match = 'folder|' + $literal; break }
      try {
        $suf = Get-ChildItem 'C:\\Users' -Directory -Force -EA 0 |
          Where-Object { $_.Name -match ('^' + [Regex]::Escape($u) + '\\.') -and (Profile-Has-NTUserDat $_.FullName) } |
          Select-Object -First 1 -ExpandProperty FullName
        if ($suf) { $match = 'folder-suffixed|' + $suf; break }
      } catch {}
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    Write-Output ("SID=" + $sid)
    Write-Output ("KEY=" + $key)
    Write-Output ("REG=" + $lastReg)
    Write-Output ("MATCH=" + $match)
  `;

  const r = await runPSCapture(script, { timeoutMs: (maxWaitSec + 20) * 1000 });
  let lastSid = '', key = '', regPath = '', matchSrc = '', matchPath = '';
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('SID=')) lastSid = t.slice(4);
    else if (t.startsWith('KEY=')) key = t.slice(4);
    else if (t.startsWith('REG=')) regPath = t.slice(4);
    else if (t.startsWith('MATCH=')) {
      const pipe = t.indexOf('|', 6);
      if (pipe > 0) { matchSrc = t.slice(6, pipe); matchPath = t.slice(pipe + 1); }
    }
  }
  if (key) checkedKeys.push(key);
  if (regPath) checkedPaths.push(regPath);
  checkedPaths.push(literal);

  if (matchPath) {
    if (!checkedPaths.includes(matchPath)) checkedPaths.push(matchPath);
    if (matchSrc === 'registry')         send(`  Resolved via registry: ${matchPath}`, 'out');
    else if (matchSrc === 'folder')      send(`  Resolved via folder scan: ${matchPath}`, 'out');
    else                                 send(`  WARNING: Windows created suffixed profile '${matchPath}'.`, 'out');
    return { path: matchPath, source: matchSrc, checkedPaths, checkedKeys, sid: lastSid };
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
  // Per-step outcome ledger (additive — success/warnings/blockers/receipt all
  // keep their existing shapes). A 'fail' outcome marks a step whose result
  // invalidates the fix's purpose; computeRunVerdict turns any of those into
  // partial:true and the NEEDS ATTENTION headline instead of a silent green.
  const steps = [];
  const step = (id, label, outcome, detail = '') => steps.push({ id, label, outcome, detail });
  // Countable data-clear ledger, fed by every Remove-ProfileFolder pass:
  // each "  Deleting: <path>" line is one real removal attempt and each
  // "RESULT: STILL PRESENT" is one confirmed leftover. Aggregated into the
  // 'data-clear' step outcome and the receipt's `deleted N of M`.
  let clearAttempts = 0, clearFailures = 0, clearTimedOut = false;
  const tallyRemovals = (r) => {
    const out = (r && r.stdout) || '';
    clearAttempts += (out.match(/^\s*Deleting: /gm) || []).length;
    clearFailures += (out.match(/RESULT: STILL PRESENT/g) || []).length;
    if (r && r.timedOut) clearTimedOut = true;
  };

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
  send(`  Zoom present: ${pre.info.zoomPath || '(no machine-wide install)'} -> ${pre.info.zoomPath && fs.existsSync(pre.info.zoomPath) ? 'YES' : 'NO'}`, 'out');
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
  // Poll until no user1-owned processes remain, killing stragglers each tick.
  // Replaces the old fixed sleep(3s) + second taskkill + sleep(2s): positive
  // confirmation instead of hoping 5s was enough, and the common case
  // (nothing was running) clears in well under a second.
  const drain = await runPSCapture(`
    $u = '${FIX_USER}'
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    $clear = $false
    do {
      $procs = @()
      try {
        # -IncludeUserName THROWS (terminating) without elevation; the fix
        # flow is elevation-gated so this is the hot path, but fall back to
        # the slower CIM GetOwner walk rather than silently reporting clear.
        $procs = @(Get-Process -IncludeUserName -EA Stop |
          Where-Object { $_.UserName -and (($_.UserName -split '\\\\')[-1] -ieq $u) } |
          ForEach-Object { $_.Id })
      } catch {
        $procs = @(Get-CimInstance Win32_Process -EA SilentlyContinue |
          Where-Object {
            $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -EA SilentlyContinue
            $o -and ($o.User -ieq $u)
          } |
          ForEach-Object { $_.ProcessId })
      }
      if ($procs.Count -eq 0) { $clear = $true; break }
      $procs | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($clear) { Write-Output 'CLEAR' } else { Write-Output 'RESIDUAL' }
  `, { timeoutMs: 20000 });
  if ((drain.stdout || '').includes('RESIDUAL')) {
    send(`  WARNING: some ${FIX_USER} processes survived repeated kills; continuing.`, 'err');
    warnings.push({ code: 'kill_residual', message: `Some ${FIX_USER} processes were still alive after 6s of kill attempts.` });
  }
  if (drain.timedOut) {
    // Previously a timed-out drain probe read as "all clear" — fail-loud now.
    send(`  WARNING: could not confirm all ${FIX_USER} processes exited (check timed out).`, 'err');
    warnings.push({ code: 'kill_check_timeout', message: `Could not confirm every ${FIX_USER} process exited — the check timed out after 20s.` });
  }
  const step1Issues = [];
  if (realNotes.length) step1Issues.push('session logoff issues');
  if ((drain.stdout || '').includes('RESIDUAL')) step1Issues.push('some processes survived kill attempts');
  if (drain.timedOut) step1Issues.push('process check timed out');
  step('close-sessions', `Close ${FIX_USER} programs and sessions`, step1Issues.length ? 'warn' : 'ok', step1Issues.join('; '));

  // ============================================================
  // STEP 2: Pre-clean any leftover suffixed profile folders
  //         (e.g. user1.MACHINENAME) from earlier botched resets.
  // ============================================================
  send('[2/8] Removing leftover suffixed profile folders...', 'header');
  const suffixSweep = await runPSScript(`
    ${PS_REMOVE_PROFILE_HELPER}
    $u = '${FIX_USER}'
    $folders = Get-ChildItem 'C:\\Users' -Directory -Force -EA 0 | Where-Object { $_.Name -match ('^' + [Regex]::Escape($u) + '\\.') }
    if (-not $folders) { Write-Host '  None found.'; return }
    foreach ($f in $folders) {
      Write-Host "  Found: $($f.FullName)"
      Remove-ProfileFolder -Path $f.FullName
    }
  `, send, { heartbeatMs: 5000, heartbeatLabel: 'suffixed-profile cleanup', timeoutMs: 300000 });
  tallyRemovals(suffixSweep);

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
      return { success: false, error: 'delete_user_failed', warnings, steps };
    }
    send('  Account deleted.', 'out');
  } else {
    send('  Account does not exist - skipping account delete.', 'out');
  }

  const sourceProfile = `C:\\Users\\${FIX_USER}`;
  const profileFolderExisted = fs.existsSync(sourceProfile);
  if (profileFolderExisted) {
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
      return { success: false, error: 'delete_profile_timeout', warnings, steps };
    }
    if (delProfile.code !== 0) {
      send('ERROR: profile folder could not be removed. Reboot and try again.', 'err');
      return { success: false, error: 'delete_profile_failed', warnings, steps };
    }
    tallyRemovals(delProfile);
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
  const plSweep = await runPSScript(`
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
  tallyRemovals(plSweep);

  // Aggregate data-clear outcome across every removal pass above. A counted
  // leftover ("app only deleted 1 file" class) fails the step -> partial;
  // a timeout or unclean exit with clean counts is at least a warn.
  {
    const deletedCount = Math.max(0, clearAttempts - clearFailures);
    const clearRec = deletionOutcome(deletedCount, clearAttempts);
    let clearOutcome = clearRec.outcome;
    let clearDetail = clearRec.detail;
    if (clearOutcome === 'ok' && (clearTimedOut || suffixSweep.code !== 0 || plSweep.code !== 0)) {
      clearOutcome = 'warn';
      clearDetail += clearTimedOut
        ? ' — but the cleanup step timed out before it could re-check, so a leftover may remain'
        : ' — but the cleanup script did not exit cleanly';
    }
    if (clearOutcome === 'fail') {
      send(`  WARNING: old profile data only partially removed (${clearDetail}).`, 'err');
    }
    step('data-clear', `Clear old ${FIX_USER} profile data`, clearOutcome, clearDetail);
  }

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
  const flush = await runPSScript(`
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
  // A ProfSvc flush that timed out or died used to vanish into a green run
  // (#90). When a previous user1 existed the flush is what prevents the
  // TEMP-profile relapse, so its failure invalidates the fix's purpose.
  if (flush.timedOut || flush.code !== 0) {
    const profsvcNeeded = accountExisted || profileFolderExisted;
    const why = flush.timedOut ? 'timed out after 60 seconds' : `did not finish cleanly (exit ${flush.code})`;
    const detail = `The Windows profile service refresh ${why}. Windows may give ${FIX_USER} a temporary profile — if Error 1132 comes back, reboot once and run the fix again.`;
    send(`  WARNING: ${detail}`, 'err');
    step('profsvc-flush', 'Refresh Windows profile service', profsvcNeeded ? 'fail' : 'warn', detail);
    if (!profsvcNeeded) {
      warnings.push({ code: 'profsvc_flush_failed', message: detail });
    }
  } else {
    step('profsvc-flush', 'Refresh Windows profile service', 'ok', '');
  }

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
    return { success: false, error: 'create_user_failed', warnings, steps };
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
  step('create-account', `Create fresh ${FIX_USER} account`, adminCheck.inGroup ? 'ok' : 'warn',
    adminCheck.inGroup ? '' : `${FIX_USER} admin membership could not be verified`);

  // ============================================================
  // STEP 5: Launch Zoom once as user1 so Windows creates the profile.
  // ============================================================
  send(`[5/8] Launching Zoom as '${FIX_USER}'...`, 'header');
  // Re-check zoom in case it disappeared between preflight and now
  // (re-resolve — an uninstall/reinstall may also have MOVED it).
  let zi = zoomInstall;
  if (!zi || !zi.path || !fs.existsSync(zi.path)) {
    zi = zoomInstall = await resolveZoomInstall();
  }
  if (!zi.path) {
    send(`ERROR: ${zoomDetect.zoomStatusMessage(zi)}`, 'err');
    return { success: false, error: 'zoom_not_found', warnings };
  }
  const launchPs = `
    $pw = ConvertTo-SecureString '${FIX_PASS}' -AsPlainText -Force
    $cred = New-Object System.Management.Automation.PSCredential('${FIX_USER}', $pw)
    try {
      Start-Process -FilePath '${zi.path}' -WorkingDirectory '${zi.dir}' -Credential $cred -EA Stop
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
  // negative). Poll up to ~10s INSIDE one PS process — the old spawn-per-tick
  // loop paid a powershell.exe startup for each of up to 12 checks, and the
  // 400ms internal tick also spots Zoom sooner.
  const zpoll = await runPSCapture(`
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $hit = $false
    do {
      try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='Zoom.exe'" -EA SilentlyContinue
        foreach ($p in $procs) {
          $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner -EA SilentlyContinue
          if ($owner -and ($owner.User -ieq '${FIX_USER}')) { $hit = $true; break }
        }
      } catch {}
      if ($hit) { break }
      Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($hit) { Write-Output 'YES' } else { Write-Output 'NO' }
  `, { timeoutMs: 25000 });
  const zoomSeen = (zpoll.stdout || '').includes('YES');
  if (!zoomSeen) {
    send(`ERROR: Zoom.exe is not running as '${FIX_USER}' after launch.`, 'err');
    send('  Likely causes: Secondary Logon disabled, password policy mismatch, or Zoom crashed on startup.', 'err');
    send('  Try: sc.exe config seclogon start= demand && sc.exe start seclogon', 'err');
    return { success: false, error: 'launch_failed', warnings, steps };
  }
  send(`  Confirmed: Zoom.exe is running as ${FIX_USER}.`, 'out');
  step('launch-zoom', `Start Zoom as ${FIX_USER}`, 'ok', '');

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
    // Everything the fix exists to deliver per-user (consent, dark mode,
    // helper script) was skipped — that is a partial outcome, not a green run.
    step('profile-setup', `Set up the ${FIX_USER} profile`, 'fail',
      `The ${FIX_USER} profile did not appear within 30 seconds, so Zoom settings, camera/microphone consent, and the helper script were skipped. Sign into Zoom once as ${FIX_USER}, then run the fix again.`);
    send('Fix finished, but some outcomes need attention - see the summary below.', 'err');
    const earlyVerdict = computeRunVerdict(steps, warnings, []);
    return { success: true, partial: earlyVerdict.partial, steps, warnings, receipt: null };
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
      await Promise.all([
        runProcess('icacls.exe', [firstRunDst, '/grant', `${FIX_USER}:(R)`, '/C'], noop),
        runProcess('icacls.exe', [shortcutPath, '/grant', `${FIX_USER}:(RX)`, '/C'], noop)
      ]);
    } catch (err) {
      send(`    WARNING: firstrun deploy failed: ${err.message}`, 'err');
      warnings.push({ code: 'firstrun_deploy_failed', message: err.message });
    }
  }
  {
    const profileIssueCodes = ['firstrun_missing', 'shortcut_failed', 'firstrun_deploy_failed'];
    const profileIssues = warnings.filter(w => profileIssueCodes.includes(w.code));
    step('profile-setup', `Set up the ${FIX_USER} profile`,
      profileIssues.length ? 'warn' : 'ok', profileIssues.map(w => w.code).join(', '));
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
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', consentScript,
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
  // One PS pass replaces 7 serial taskkill spawns + a CIM sweep + a fixed
  // sleep(4s). Kill by image name OR install path, then poll until the whole
  // tree is confirmed gone — positive exit confirmation means file handles
  // (Zoom.us.ini) are released, typically within ~1s instead of always 4s.
  const zoomClose = await runPSCapture(`
    $u = '${FIX_USER}'
    $names = @('Zoom.exe','CptHost.exe','CptControl.exe','ZoomWebhook.exe',
               'Zoom_launcher.exe','ZoomTeamChat.exe','airhost.exe')
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
      $targets = @(Get-CimInstance Win32_Process -EA SilentlyContinue |
        Where-Object {
          ($names -contains $_.Name) -or
          ($_.ExecutablePath -and $_.ExecutablePath -like '*\\Zoom\\*')
        } |
        Where-Object {
          $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -EA SilentlyContinue
          $o -and ($o.User -ieq $u)
        })
      if ($targets.Count -eq 0) { break }
      $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue }
      Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($targets.Count -eq 0) { Write-Output 'CLEAR' } else { Write-Output ('RESIDUAL=' + $targets.Count) }
  `, { timeoutMs: 30000 });
  if ((zoomClose.stdout || '').includes('CLEAR')) {
    send('  Zoom closed.', 'out');
  } else {
    // Previously "Zoom closed." printed unconditionally — the ini write below
    // can silently lose against a still-open Zoom.us.ini handle.
    send('  WARNING: some Zoom processes may still be running for user1.', 'err');
    warnings.push({ code: 'zoom_close_residual', message: 'Some Zoom processes were still running when preferences were written — the dark-mode setting may not stick.' });
  }

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
    const iniWrite = await runPSScript(iniEdit, send);
    if (iniWrite.timedOut || iniWrite.code !== 0) {
      send('  WARNING: could not write dark mode into Zoom.us.ini.', 'err');
      warnings.push({ code: 'ini_write_failed', message: 'Could not write dark mode into Zoom.us.ini — Zoom may open in light mode. Cosmetic only; everything else still applies.' });
    }
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
  {
    const zoomCfgCodes = ['sid_unresolved', 'ini_seed_failed', 'ini_write_failed', 'pref_copy_failed', 'zoom_close_residual'];
    const cfgIssues = warnings.filter(w => zoomCfgCodes.includes(w.code));
    step('zoom-config', 'Apply Zoom preferences', cfgIssues.length ? 'warn' : 'ok',
      cfgIssues.map(w => w.code).join(', '));
  }

  // ============================================================
  // STEP 8: Relaunch Zoom so the new prefs take effect.
  // (No settle delay needed: prefs copy + icacls above are awaited and the
  // Zoom tree was confirmed exited before the ini write.)
  // ============================================================
  send(`[8/8] Relaunching Zoom as '${FIX_USER}'...`, 'header');
  const relaunch = await runPSScriptDetachedIO(launchPs);
  if (relaunch.code !== 0 && relaunch.code !== null) {
    warnings.push({ code: 'relaunch_failed', message: `Initial launch succeeded but relaunch exited with code ${relaunch.code}. Open Zoom manually.` });
  }

  // ============================================================
  // STEP 8.5: Outcome verification — cheap read-only re-checks of what the
  // fix exists to deliver, recorded into the receipt. No mutations:
  //   (a) consent registry values actually present for user1 (readback is
  //       authoritative — resolves the write-time UNVERIFIED cases),
  //   (b) FrameServer service state,
  //   (c) Zoom.exe running as user1 (the relaunch above is detached and was
  //       previously never confirmed).
  // ============================================================
  send('[V] Verifying fix outcomes...', 'header');
  const verify = await runPSCapture(`
    $sid = '${userSID || ''}'
    $u = '${FIX_USER}'
    function ConsentVal([string]$p) {
      try { return [string](Get-ItemProperty -Path $p -Name 'Value' -EA Stop).Value } catch { return '' }
    }
    foreach ($d in @('webcam','microphone')) {
      $hklm = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\' + $d
      $ok = ((ConsentVal $hklm) -eq 'Allow') -and ((ConsentVal ($hklm + '\\NonPackaged')) -eq 'Allow')
      Write-Output ('VERIFY_HKLM_' + $d + '=' + $(if ($ok) { 'YES' } else { 'NO' }))
    }
    $hkuLoaded = $false
    if ($sid) {
      $null = reg query "HKU\\$sid" 2>$null
      if ($LASTEXITCODE -eq 0) { $hkuLoaded = $true }
    }
    Write-Output ('VERIFY_HKU_LOADED=' + $(if ($hkuLoaded) { 'YES' } else { 'NO' }))
    if ($hkuLoaded) {
      foreach ($d in @('webcam','microphone')) {
        $hku = 'Registry::HKEY_USERS\\' + $sid + '\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\' + $d
        $ok = ((ConsentVal $hku) -eq 'Allow') -and ((ConsentVal ($hku + '\\NonPackaged')) -eq 'Allow')
        Write-Output ('VERIFY_USER_' + $d + '=' + $(if ($ok) { 'YES' } else { 'NO' }))
      }
    }
    $svc = Get-Service FrameServer -EA SilentlyContinue
    if ($svc) { Write-Output ('VERIFY_FRAMESERVER=' + [string]$svc.Status + '/' + [string]$svc.StartType) }
    else { Write-Output 'VERIFY_FRAMESERVER=MISSING' }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $hit = $false
    do {
      try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='Zoom.exe'" -EA SilentlyContinue
        foreach ($p in $procs) {
          $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -EA SilentlyContinue
          if ($o -and ($o.User -ieq $u)) { $hit = $true; break }
        }
      } catch {}
      if ($hit) { break }
      Start-Sleep -Milliseconds 400
    } while ([DateTime]::UtcNow -lt $deadline)
    Write-Output ('VERIFY_ZOOM_USER1=' + $(if ($hit) { 'YES' } else { 'NO' }))
  `, { timeoutMs: 30000 });

  const vout = verify.stdout || '';
  const vprobeFailed = verify.timedOut || !/VERIFY_/.test(vout);
  const vget = (k) => {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(vout);
    return m ? m[1].trim() : '';
  };

  // Receipt: start from the write-time consent receipt; when the consent
  // block was skipped entirely (script missing, SID unresolved) synthesize an
  // honest default instead of returning null and hiding the panel.
  const receipt = (typeof consentReceipt !== 'undefined') ? consentReceipt : {
    camera: 'UNVERIFIED', microphone: 'UNVERIFIED', hkuPath: 'skipped', frameServer: ''
  };
  // Readback is authoritative where it could see the values. It can upgrade
  // a write-time UNVERIFIED to OK (writes landed but the script died before
  // reporting) and downgrade an unbacked OK; POLICY-BLOCKED always stands.
  const finalizeConsent = (writeTime, userRead, hklmRead) => {
    if (writeTime === 'POLICY-BLOCKED') return writeTime;
    if (userRead === 'YES' || hklmRead === 'YES') return 'OK';
    if (vprobeFailed) return writeTime; // probe broke: keep the write-time status
    return 'UNVERIFIED';
  };
  receipt.camera     = finalizeConsent(receipt.camera,     vget('VERIFY_USER_webcam'),     vget('VERIFY_HKLM_webcam'));
  receipt.microphone = finalizeConsent(receipt.microphone, vget('VERIFY_USER_microphone'), vget('VERIFY_HKLM_microphone'));
  if (!vprobeFailed) {
    send(`  Consent readback: camera=${receipt.camera}, microphone=${receipt.microphone}`,
      (receipt.camera !== 'UNVERIFIED' && receipt.microphone !== 'UNVERIFIED') ? 'out' : 'err');
  }
  const consentBad = receipt.camera === 'UNVERIFIED' || receipt.microphone === 'UNVERIFIED';
  const consentPolicy = receipt.camera === 'POLICY-BLOCKED' || receipt.microphone === 'POLICY-BLOCKED';
  step('consent', 'Grant camera and microphone access',
    consentBad ? 'fail' : (consentPolicy ? 'warn' : 'ok'),
    consentBad
      ? `camera=${receipt.camera}, microphone=${receipt.microphone} — if Zoom cannot see them, sign in as ${FIX_USER} and enable Camera and Microphone for desktop apps under Settings > Privacy & security.`
      : `camera=${receipt.camera}, microphone=${receipt.microphone}`);

  // FrameServer readback refines the receipt; never downgrades an honest
  // 'restored-from-disabled' to plain 'ok'.
  const vfs = vget('VERIFY_FRAMESERVER');
  if (vfs === 'MISSING') {
    receipt.frameServer = 'missing';
  } else if (vfs.endsWith('/Disabled')) {
    receipt.frameServer = 'disabled-unfixable';
    if (!warnings.some(w => w.code === 'frameserver_disabled')) {
      warnings.push({ code: 'frameserver_disabled', message: 'Windows Camera Frame Server service is Disabled — cameras will not enumerate for any desktop app until it is set to Manual or Automatic.' });
    }
  } else if (vfs && !receipt.frameServer) {
    receipt.frameServer = 'ok';
  }

  // Zoom-under-user1 relaunch confirmation.
  if (vget('VERIFY_ZOOM_USER1') === 'YES') {
    send(`  Confirmed: Zoom.exe is running as ${FIX_USER}.`, 'out');
    step('relaunch', `Restart Zoom as ${FIX_USER}`, 'ok', '');
    receipt.zoomRelaunch = 'confirmed';
  } else if (vprobeFailed) {
    step('relaunch', `Restart Zoom as ${FIX_USER}`, 'warn', 'could not confirm the relaunch — the verification probe did not finish');
    warnings.push({ code: 'verify_probe_failed', message: 'The final verification probe did not finish; the receipt reflects what each step reported at the time.' });
    receipt.zoomRelaunch = 'unverified';
  } else {
    send(`  WARNING: Zoom.exe is not running as ${FIX_USER} after the relaunch.`, 'err');
    step('relaunch', `Restart Zoom as ${FIX_USER}`, 'fail',
      `Zoom did not start as ${FIX_USER} after the fix — double-click "Open Zoom with 1132 Helper" on your desktop to start it.`);
    receipt.zoomRelaunch = 'not-detected';
  }
  if (clearAttempts > 0) {
    receipt.dataClear = `deleted ${Math.max(0, clearAttempts - clearFailures)} of ${clearAttempts}`;
  }

  const verdict = computeRunVerdict(steps, warnings, []);
  if (verdict.partial) {
    send('Fix finished, but some outcomes need attention - see the summary below.', 'err');
  } else {
    send('Done. Zoom should appear momentarily.', 'success');
  }
  if (warnings.length) {
    send(`Completed with ${warnings.length} warning(s) - see above.`, 'err');
  }
  send(`NEXT STEP for ${FIX_USER}:`, 'header');
  send('  1. Sign into Zoom on first launch.', 'out');
  send('  2. Double-click "Apply Zoom Settings" on the desktop to', 'out');
  send('     push mirror-off, dual monitors, mute-on-join, etc.', 'out');
  return {
    success: true,
    partial: verdict.partial,
    steps,
    warnings,
    receipt
  };
}

// ============================================================
// Shortcut helpers.
// Windows can present several "Desktop" folders to the same user:
//   - The classic per-user Desktop (C:\Users\<name>\Desktop)
//   - OneDrive-redirected Desktop (C:\Users\<name>\OneDrive\Desktop)
//   - Public Desktop (C:\Users\Public\Desktop, visible to every account)
// We scan all three for an existing "Open Zoom with 1132 Helper.lnk" so we
// don't stack duplicates, and for creation we prefer the OS-canonical user
// Desktop (which honors OneDrive redirection).
//
// The shortcut was renamed in the 2026-08-07 branding correction. Installs
// made before that carry the old filename, which the scan would no longer
// recognize — so the app would create the new shortcut and leave the old one
// sitting beside it. LEGACY_SHORTCUT_FILENAMES is an EXPLICIT allowlist of
// exact previous names, used for recognition and for cleanup after a
// successful create. Exact names only: never a glob, never a prefix match, so
// a user's own shortcuts are never touched.
// ============================================================
const SHORTCUT_FILENAME = 'Open Zoom with 1132 Helper.lnk';
const LEGACY_SHORTCUT_FILENAMES = [
  `Launch Zoom as ${FIX_USER}.lnk`,
];
const LAUNCHER_SCRIPT_NAME = `launch-zoom-as-${FIX_USER}.ps1`;
const LAUNCHER_SCRIPT_PATH = () => path.join(app.getPath('appData'), '1132 Fixer', LAUNCHER_SCRIPT_NAME);

// Cached: the canonical Desktop path cannot change mid-session, and this
// used to cost a powershell.exe spawn on every shortcut check.
let _canonicalDesktop = null;
async function getCanonicalUserDesktop() {
  if (_canonicalDesktop) return _canonicalDesktop;
  // Ask Windows directly; this resolves to the OneDrive-redirected path when
  // that redirection is active on the current account.
  try {
    const r = await runPSCapture(`[Environment]::GetFolderPath('Desktop')`);
    const p = (r.stdout || '').trim();
    if (p) { _canonicalDesktop = p; return p; }
  } catch (_) { /* fall through */ }
  _canonicalDesktop = path.join(os.homedir(), 'Desktop');
  return _canonicalDesktop;
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

// Inspect MANY .lnk files in one PowerShell round trip (one WScript.Shell
// COM instance, one spawn) instead of a spawn per shortcut. Returns a map
// of lnkPath -> { target, arguments }; paths that failed inspection are absent.
async function inspectShortcuts(lnkPaths) {
  if (!lnkPaths.length) return {};
  const esc = s => String(s).replace(/'/g, "''");
  const list = lnkPaths.map(p => `'${esc(p)}'`).join(',');
  try {
    const r = await runPSCapture(`
      $s = New-Object -ComObject WScript.Shell
      $out = @{}
      foreach ($p in @(${list})) {
        try {
          $sc = $s.CreateShortcut($p)
          $out[$p] = @{ target = [string]$sc.TargetPath; arguments = [string]$sc.Arguments }
        } catch {}
      }
      $out | ConvertTo-Json -Compress -Depth 3
    `);
    const out = (r.stdout || '').trim();
    if (!out) return {};
    const parsed = JSON.parse(out);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
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

/**
 * Legacy shortcuts (exact previous filenames only) present in the app's own
 * three desktop locations. Used to recognize pre-rename installs and to clean
 * them up after the renamed shortcut is created successfully.
 */
async function findLegacyShortcuts() {
  const locations = await listDesktopLocations();
  const out = [];
  for (const loc of locations) {
    for (const name of LEGACY_SHORTCUT_FILENAMES) {
      const lnk = path.join(loc.path, name);
      if (fs.existsSync(lnk)) out.push({ kind: loc.kind, path: lnk, name });
    }
  }
  return out;
}

/**
 * Remove the exact legacy shortcuts. Never throws: a shortcut we cannot delete
 * (permissions on Public Desktop, file in use) is reported, not fatal — the
 * user still has a working renamed shortcut.
 */
async function removeLegacyShortcuts() {
  const found = await findLegacyShortcuts();
  const removed = [];
  const failed = [];
  for (const s of found) {
    try {
      fs.unlinkSync(s.path);
      removed.push(s.path);
    } catch (err) {
      failed.push({ path: s.path, error: err.message });
    }
  }
  return { removed, failed };
}

async function findExistingShortcuts() {
  const expectedScript = LAUNCHER_SCRIPT_PATH();
  const locations = await listDesktopLocations();
  const present = locations
    .map(loc => ({ kind: loc.kind, lnk: path.join(loc.path, SHORTCUT_FILENAME) }))
    .filter(loc => fs.existsSync(loc.lnk));
  if (!present.length) return [];

  // A shortcut that points at the right launcher script can still be stale:
  // the script bakes the Zoom path at creation time, and Zoom may since have
  // moved (x64 default -> x86/custom reinstall). When we know the current
  // machine-wide path, a mismatched baked path marks the shortcut invalid so
  // the post-fix flow rewrites the launcher. Unknown states never invalidate.
  let launcherStale = false;
  if (zoomInstall && zoomInstall.path && fs.existsSync(expectedScript)) {
    try {
      const baked = zoomDetect.extractLauncherZoomPath(fs.readFileSync(expectedScript, 'utf8'));
      if (baked && baked.toLowerCase() !== zoomInstall.path.toLowerCase()) {
        launcherStale = true;
        console.warn(`[zoom-detect] launcher script bakes '${baked}' but resolved install is '${zoomInstall.path}' — marking shortcut stale`);
      }
    } catch (_) { /* unreadable script -> cannot judge, leave validity alone */ }
  }

  const infoMap = await inspectShortcuts(present.map(l => l.lnk));
  return present.map(loc => {
    const info = infoMap[loc.lnk] || null;
    return {
      kind: loc.kind,
      path: loc.lnk,
      // null = inspection failed; treat conservatively as "unknown but present".
      valid: info ? (shortcutMatchesCurrentApp(info, expectedScript) && !launcherStale) : null,
      target: info ? info.target : null,
      arguments: info ? info.arguments : null
    };
  });
}

// ============================================================
// IPC: create-shortcut (current user's desktop, one-click re-launch)
// ============================================================
ipcMain.handle('create-shortcut', async () => {
  // The shortcut launches Zoom as user1, so it needs the machine-wide
  // install path — reuse the preflight resolution, re-resolve if stale.
  let zi = zoomInstall;
  if (!zi || !zi.path || !fs.existsSync(zi.path)) {
    zi = zoomInstall = await resolveZoomInstall();
  }
  if (!zi.path) {
    return { success: false, error: zoomDetect.zoomStatusMessage(zi) };
  }

  const desktop = await getCanonicalUserDesktop();
  const shortcutPath = path.join(desktop, SHORTCUT_FILENAME);
  const iconPath = getHelperIconPath();

  const scriptPath = LAUNCHER_SCRIPT_PATH();
  const scriptDir = path.dirname(scriptPath);
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    const scriptContent =
      `$p = ConvertTo-SecureString '${FIX_PASS}' -AsPlainText -Force\r\n` +
      `$c = New-Object System.Management.Automation.PSCredential('${FIX_USER}', $p)\r\n` +
      `Start-Process -FilePath '${zi.path}' -WorkingDirectory '${zi.dir}' -Credential $c\r\n`;
    // BOM for the same PS 5.1 legacy-encoding reason as runPSScriptDetachedIO.
    fs.writeFileSync(scriptPath, '\ufeff' + scriptContent, 'utf8');
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
    `$sc.Description = 'Starts Zoom using the dedicated helper account created by 1132 Fixer.'`,
    "$sc.Save()"
  ].join('; ');

  return new Promise((resolve) => {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { windowsHide: true }
    );
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => resolve({ success: false, error: err.message }));
    child.on('close', async code => {
      if (code !== 0) {
        return resolve({ success: false, error: stderr.trim() || `Exit ${code}` });
      }
      // Only after the renamed shortcut exists do we clear the old one, so a
      // failed create never leaves the user with no shortcut at all. Cleanup
      // failure is reported, never fatal.
      const cleanup = await removeLegacyShortcuts();
      resolve({
        success: true,
        path: shortcutPath,
        legacyRemoved: cleanup.removed,
        legacyRemovalFailed: cleanup.failed
      });
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
          if (res.statusCode === 413) return resolve({ success: false, error: 'Message too large — shorten it and try again.' });
          if (res.statusCode === 502) return resolve({ success: false, error: 'Feedback service could not reach GitHub — try again later.' });
          if (res.statusCode === 400) {
            let code = '';
            try { code = JSON.parse(data).error || ''; } catch (_) { /* generic below */ }
            if (code === 'bad_type') return resolve({ success: false, error: 'The support service can\'t accept this message type yet — please try again later.' });
            if (code === 'empty_text') return resolve({ success: false, error: 'Message is empty — write something first.' });
            return resolve({ success: false, error: 'Submission rejected — check the message and try again.' });
          }
          resolve({ success: false, error: 'Submission failed' });
        });
      });
      req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'Feedback service timed out' }); });
      req.on('error', () => resolve({ success: false, error: 'Network error' }));
      req.write(postData);
      req.end();
    });
  } catch (err) {
    // Never surface a raw exception as the whole message — the renderer shows
    // this string verbatim in the feedback modal.
    console.warn('submit-feedback failed before the request was sent:', err && err.message);
    return { success: false, error: 'Could not send right now. Check your internet connection and try again in a minute.' };
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
  // All three probes (base preflight, user1 existence, policy/FrameServer/HKU)
  // are independent and read-only — run them concurrently. This scan gates
  // the FIX NOW button on every launch and window-focus, so serial spawns
  // here were pure startup latency.
  const probePromise = runPSCapture(`
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
    # Helper-account health: existence + Administrators membership (SID-based,
    # same technique as verifyAdminMembership — Get-LocalGroupMember chokes on
    # orphaned SIDs, so fall back to net localgroup parsing).
    $out['user1_exists'] = $false
    try { if (Get-LocalUser -Name '${FIX_USER}' -EA SilentlyContinue) { $out['user1_exists'] = $true } } catch {}
    $out['user1_admin'] = $false
    if ($out['user1_exists']) {
      try {
        foreach ($m in (Get-LocalGroupMember -SID 'S-1-5-32-544' -EA Stop)) {
          $mSid = $null
          try { $mSid = $m.SID.Value } catch {}
          if (($sid -and $mSid -and ($mSid -eq $sid)) -or ($m.Name -ieq '${FIX_USER}') -or ($m.Name -like ('*\\' + '${FIX_USER}'))) {
            $out['user1_admin'] = $true; break
          }
        }
      } catch {
        try {
          $lg = (net localgroup administrators) 2>&1 | Out-String
          foreach ($l in ($lg -split "\`r?\`n")) {
            $t = $l.Trim()
            if ($t -ieq '${FIX_USER}' -or $t -like ('*\\' + '${FIX_USER}')) { $out['user1_admin'] = $true; break }
          }
        } catch {}
      }
    }
    $out | ConvertTo-Json -Compress
  `, { timeoutMs: 20000 });

  const [pre, probe] = await Promise.all([
    preflightCheck(),
    probePromise
  ]);
  const cards = {};

  // --- Admin --------------------------------------------------
  cards.admin = pre.info.elevated
    ? { status: 'ready', label: 'Administrator', message: 'Running elevated.' }
    : { status: 'blocked', label: 'Administrator', message: 'Not elevated. Close and re-launch with Run as administrator.' };

  // --- Zoom ---------------------------------------------------
  // preflightCheck() above refreshed zoomInstall; zoomStatusMessage covers
  // found (path + variant suffix), per-user-only, and not-found copy.
  cards.zoom = {
    status: pre.info.zoomInstall.path ? 'ready' : 'blocked',
    label: 'Zoom Workplace',
    message: zoomDetect.zoomStatusMessage(pre.info.zoomInstall)
  };

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

  // --- Helper user (user1) ------------------------------------
  // A user1 that exists WITH a profile AND admin rights is the normal,
  // healthy state after a successful fix — report it green. Amber is
  // reserved for states FIX NOW actually has to repair.
  const helperProfileDir = `C:\\Users\\${FIX_USER}`;
  const helperProfileExists = fs.existsSync(helperProfileDir);
  if (probeFailed) {
    cards.helperUser = { status: 'warning', label: 'Helper account', message: probeFailMsg };
  } else {
    const helperExists = !!probeData.user1_exists;
    const helperAdmin  = !!probeData.user1_admin;
    if (!helperExists && !helperProfileExists) {
      cards.helperUser = { status: 'ready', label: 'Helper account', message: `'${FIX_USER}' will be created on FIX NOW.` };
    } else if (helperExists && helperProfileExists && helperAdmin) {
      cards.helperUser = { status: 'ready', label: 'Helper account', message: `'${FIX_USER}' is set up — admin rights and profile present. FIX NOW rebuilds it fresh.` };
    } else if (helperExists && helperProfileExists) {
      cards.helperUser = { status: 'repairable', label: 'Helper account', message: `'${FIX_USER}' exists but is not in Administrators. FIX NOW will repair it.` };
    } else if (helperExists) {
      cards.helperUser = { status: 'repairable', label: 'Helper account', message: `'${FIX_USER}' account exists but no profile yet. FIX NOW will reset.` };
    } else {
      cards.helperUser = { status: 'warning', label: 'Helper account', message: `Stale profile folder at ${helperProfileDir} with no account. FIX NOW will clean it up.` };
    }
  }

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
    // Not-loaded is the NORMAL state while user1 is logged off — mounting the
    // hive is part of the fix procedure, not a defect to repair. Both states
    // are green; the message says which path FIX NOW takes.
    cards.hku = probeData.hku_loaded
      ? { status: 'ready', label: 'User registry hive', message: `HKU\\${probeData.hku_sid} active — consent will write live.` }
      : { status: 'ready', label: 'User registry hive', message: `Hive not loaded (normal while '${FIX_USER}' is logged off) — FIX NOW will mount NTUSER.DAT, write consent, then unmount.` };
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
    md.push(`camera:      ${receipt.camera || 'not recorded'}`);
    md.push(`microphone:  ${receipt.microphone || 'not recorded'}`);
    md.push(`hkuPath:     ${receipt.hkuPath || 'not recorded'}`);
    md.push(`frameServer: ${receipt.frameServer || 'not recorded'}`);
    md.push(`dataClear:   ${receipt.dataClear || 'not recorded'}`);
    md.push(`zoomRelaunch: ${receipt.zoomRelaunch || 'not recorded'}`);
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
