const { app, BrowserWindow, dialog, ipcMain, shell, screen, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { spawn, spawnSync } = require('child_process');
const windowsTools = require('./src/main/windows-tools');
// System tools never use the app directory, current directory or PATH.
const spawnWindowsTool = (name, args, opts) => spawn(windowsTools.resolveTool(name), args, opts);
const spawnWindowsToolSync = (name, args, opts) => spawnSync(windowsTools.resolveTool(name), args, opts);
const electronSecurity = require('./src/main/electron-security');
electronSecurity.installIpcAllowlist(ipcMain);
const elevation = require('./src/main/elevation');
const elevCtl = elevation.createElevationController();
const config = require('./src/main/config');
const supportClient = require('./src/main/support-client');
const zoomDetect = require('./zoom-detect');
const messages = require('./messages');
const helperCred = require('./helper-credential');
const profileSafety = require('./profile-safety');
const { computeRunVerdict, deletionOutcome, consentOutcome, profsvcRefreshResult } = require('./run-verdict');

const updaterMod = require('./src/main/updater');
const { createUpdaterLog } = require('./src/main/updater-log');
const shutdownMod = require('./src/main/shutdown');

// The download starts only when the user chooses "Download update"; the
// controller calls autoUpdater.downloadUpdate() exactly once per version.
autoUpdater.autoDownload = false;
// The install handoff is owned by src/main/updater.js, never by
// electron-updater's quitAndInstall()/autoInstallOnAppQuit. Those paths
// start the installer through resources/elevate.exe whenever latest.yml
// says isAdminRightsRequired, and this package does not ship that helper
// (docs/security/BINARY-POLICY.md) — the spawn failed after app.quit() was
// already scheduled, so 6.3.1–6.3.3 closed and never installed anything.
autoUpdater.autoInstallOnAppQuit = false;
// Differential (blockmap) downloads from GitHub are a recurring source of
// stuck / never-completing updates in the field. The full installer is small
// enough that a plain download is the reliable choice.
autoUpdater.disableDifferentialDownload = true;
autoUpdater.disableWebInstaller = true;

// ============================================================
// Updater wiring. The state machine, verification, handoff record, retry
// policy and relaunch validation live in src/main/updater.js; this file
// only supplies the Electron / process / registry adapters and the IPC.
// Every event is logged (sanitized) to <userData>/logs/updater.log, which
// survives the update and can be read after a failed relaunch.
// ============================================================
const UPDATER = '[updater]';
let fixInProgress = false;
let fixHasRun = false;
let portableNotice = null; // { version } when the portable build found a newer release

const updaterLog = createUpdaterLog({
  file: path.join(app.getPath('userData'), 'logs', 'updater.log'),
  mirror: console
});
// electron-updater's own lines (feed resolution, download URL, cache reuse)
// go through the same sanitizer: query strings and tokens never reach disk.
autoUpdater.logger = {
  info: (m) => updaterLog.info('library', { message: String(m) }),
  warn: (m) => updaterLog.warn('library', { message: String(m) }),
  error: (m) => updaterLog.error('library', { message: String(m) }),
  debug: () => {}
};

const shutdown = shutdownMod.createShutdownController({ quit: () => app.quit(), log: updaterLog });

// ============================================================
// Critical operations and the inactivity exit.
//
// criticalOps is the one answer to "may the app close by itself right
// now?". Scoped operations (a repair, the shortcut writer, the Zoom
// installer, an elevated relaunch, a blocking native dialog) register
// themselves through the IPC wrapper below or explicitly; the update
// lifecycle is a source (any state from checking to restarting, and a
// verified update waiting to install). The inactivity controller
// (src/main/inactivity.js) suspends while anything is active and starts a
// fresh timer when it ends. Its exit is a graceful shutdown with reason
// inactive_exit — never a kill, and never confused with update_restart.
// ============================================================
const criticalOpsMod = require('./src/main/critical-ops');
const inactivityMod = require('./src/main/inactivity');
const appLog = createUpdaterLog({ file: path.join(app.getPath('userData'), 'logs', 'app.log'), mirror: console });
const criticalOps = criticalOpsMod.createCriticalOps({ log: appLog });
criticalOps.addSource('updater', () => !!updaterCtl && (updaterCtl.isCritical() || updaterCtl.isReady()));
criticalOps.addSource('repair', () => fixInProgress);
const CRITICAL_IPC = Object.freeze({
  'run-fix': 'repair',
  'create-shortcut': 'shortcut',
  'launch-zoom-helper': 'zoom-launch',
  'preflight': 'zoom-validate',
  'preflight-scan': 'zoom-validate',
  'relaunch-elevated': 'elevated-relaunch',
  'install-update-now': 'update-install',
  'update-download': 'update-download',
  'update-retry': 'update-retry'
});
{
  // Every handler named above is a critical operation for as long as it
  // runs (including when it throws). Wraps the allowlisted ipcMain.handle.
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => origHandle(channel, CRITICAL_IPC[channel]
    ? (event, ...args) => criticalOps.run(CRITICAL_IPC[channel], () => listener(event, ...args))
    : listener);
}

let inactivityCtl = null;
function sendInactivityStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('inactivity-status', payload);
      // A warning in a window nobody is looking at: ask for attention once,
      // stop asking when it is dismissed or the app is about to close.
      if (payload && payload.event === 'warning' && !mainWindow.isFocused()) mainWindow.flashFrame(true);
      if (payload && (payload.event === 'dismiss' || payload.event === 'exiting')) mainWindow.flashFrame(false);
    }
  } catch (_) { /* renderer gone — the main-process timer keeps its own time */ }
}
function getInactivity() {
  if (inactivityCtl) return inactivityCtl;
  inactivityCtl = inactivityMod.createInactivityController({
    emit: sendInactivityStatus,
    requestExit: (reason) => shutdown.request(reason),
    criticalOps,
    log: appLog
  });
  return inactivityCtl;
}
// Starts the fresh timer once the app has reached a settled first screen
// (the renderer says so); a window that never gets there still starts the
// timer after a minute so an abandoned "Unable to complete" screen closes.
function startInactivityTimer(why) {
  const ctl = getInactivity();
  appLog.info('inactivity.start-requested', { why, state: ctl.getState() });
  ctl.start();
}

ipcMain.handle('user-activity', (_event, kind) => {
  if (inactivityCtl) inactivityCtl.activity(kind, 'renderer');
  return { ok: true };
});
ipcMain.handle('inactivity-keep-open', () => {
  if (inactivityCtl) inactivityCtl.keepOpen('button');
  return { ok: true };
});
ipcMain.handle('inactivity-close-now', () => {
  if (inactivityCtl) return inactivityCtl.closeNow('button');
  shutdown.request(shutdown.REASONS.USER_EXIT);
  return { accepted: true };
});
ipcMain.handle('inactivity-status-get', () => (inactivityCtl ? inactivityCtl.status() : { state: 'ACTIVE', remainingMs: null }));

function sendUpdateStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', payload);
    }
  } catch (_) { /* renderer gone — nothing to notify */ }
  // The update lifecycle is a critical-operation source; re-evaluate it on
  // every state change so the inactivity timer suspends and resumes.
  criticalOps.poll('update-status');
}

// Bounded registry read of the location the NSIS installer will update.
function readRegistryValue(key, name) {
  try {
    const r = spawnWindowsToolSync('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    if (r.status !== 0) return null;
    const m = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, 'mi').exec(r.stdout || '');
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}
async function readRegisteredInstallDir() {
  return readRegistryValue(updaterMod.INSTALL_REGISTRY_KEY, 'InstallLocation')
    || readRegistryValue(updaterMod.LEGACY_INSTALL_REGISTRY_KEY, 'InstallPath');
}

// Starts the NSIS installer detached from this process. windowsVerbatimArguments
// keeps `/D=<dir>` unquoted (NSIS requires that, even with spaces) while argv0
// quotes the installer path itself. Resolves once Windows confirms the process
// started, or with the spawn error.
function installerSpawnOptions(installerPath) {
  return {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
    argv0: `"${installerPath}"`,
    cwd: path.dirname(installerPath)
  };
}
// Polls the renderer until the blocking "Installing update" notice is
// visible (or the timeout passes). Read-only: it never changes the page.
async function confirmInstallNoticeShown(timeoutMs) {
  const t0 = Date.now();
  const probe = "(function(){var o=document.getElementById('updateInstallOverlay');return !!o&&!o.hidden;})()";
  while (Date.now() - t0 < timeoutMs) {
    let shown = false;
    try {
      if (!mainWindow || mainWindow.isDestroyed()) return { shown: false, ms: Date.now() - t0, reason: 'no-window' };
      shown = await mainWindow.webContents.executeJavaScript(probe, true);
    } catch (_) { shown = false; }
    if (shown) {
      // One more frame so the compositor has painted it.
      await new Promise((r) => setTimeout(r, 80));
      return { shown: true, ms: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { shown: false, ms: Date.now() - t0, reason: 'timeout' };
}
function spawnInstallerDetached(installerPath, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(installerPath, args, installerSpawnOptions(installerPath));
    } catch (err) {
      return resolve({ ok: false, error: err });
    }
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      done(child.pid ? { ok: true, pid: child.pid } : { ok: false, error: new Error('installer start not confirmed') });
    }, opts.timeoutMs || 5000);
    child.once('spawn', () => { try { child.unref(); } catch (_) { /* ignore */ } done({ ok: true, pid: child.pid }); });
    child.once('error', (err) => done({ ok: false, error: err }));
    child.once('exit', (code, signal) => {
      updaterLog.info('installer.exit-observed', { code, signal, pid: child.pid });
      if (!settled) done({ ok: false, error: Object.assign(new Error(`installer exited immediately with code ${code}`), { code: 'EEXIT', exitCode: code }) });
    });
  });
}
function spawnInstallerSync(installerPath, args) {
  try {
    const child = spawn(installerPath, args, installerSpawnOptions(installerPath));
    child.once('error', (err) => updaterLog.error('installer.spawn-error', { error: err }));
    try { child.unref(); } catch (_) { /* ignore */ }
    return child.pid ? { ok: true, pid: child.pid } : { ok: false, error: new Error('no pid') };
  } catch (err) {
    return { ok: false, error: err };
  }
}

let updaterCtl = null;
function getUpdater() {
  if (updaterCtl) return updaterCtl;
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  updaterCtl = updaterMod.createUpdaterController({
    autoUpdater,
    log: updaterLog,
    emit: sendUpdateStatus,
    currentVersion: app.getVersion(),
    execPath: process.execPath,
    argv: process.argv,
    arch: process.arch,
    platform: process.platform,
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    isPortable,
    isElevated: () => isElevatedSync(),
    isBusy: () => fixInProgress,
    hasUpdateConfig: () => fs.existsSync(path.join(process.resourcesPath, 'app-update.yml')),
    spawnInstaller: spawnInstallerDetached,
    spawnInstallerSync,
    confirmNotice: confirmInstallNoticeShown,
    readRegisteredInstallDir,
    requestShutdown: (reason) => shutdown.request(reason)
  });
  return updaterCtl;
}

ipcMain.handle('install-update-now', async () => getUpdater().installNow('user'));
ipcMain.handle('defer-update', () => getUpdater().defer());
ipcMain.handle('update-download', async () => getUpdater().download('user'));
ipcMain.handle('update-dismiss', () => getUpdater().dismiss());
ipcMain.handle('update-retry', async () => getUpdater().retry('user'));
ipcMain.handle('update-continue', () => getUpdater().continueCurrent());
ipcMain.handle('update-diagnostics', () => getUpdater().diagnostics());
ipcMain.handle('update-status-get', () => {
  const status = getUpdater().getStatus();
  if (status.state === 'idle' && portableNotice) return { state: 'manual', version: portableNotice.version };
  return status;
});
ipcMain.handle('update-app-ready', () => {
  getUpdater().markAppReady();
  // The inactivity timer starts fresh only now — after a relaunched build
  // has proved itself and the first screen is settled.
  startInactivityTimer('app-ready');
  return { ok: true };
});

// ============================================================
// Portable-build update notice.
//
// electron-updater cannot update the portable target, so portable users
// were silently pinned to whatever version they downloaded — forever.
// Instead: fetch latest.yml from the release feed (same feed the NSIS
// updater uses), compare versions, and surface a "download it" banner.
// URLs mirror build.publish in package.json: the feed is this repository's
// public GitHub Releases (1132-Fixer/windows latest.yml). HTTPS only;
// first hop and every redirect must pass isAllowedUpdaterUrl. The leftover
// PrimeUpYourLife/1132-Fixer-Windows-Releases channel is still live for
// residual v5.5.1 clients and must not be deleted. Current builds do not
// fetch it - that GitHub path is not on the allowlist.
// ============================================================
const RELEASES_LATEST_URL = 'https://github.com/1132-Fixer/windows/releases/latest';
const LATEST_YML_URL = 'https://github.com/1132-Fixer/windows/releases/latest/download/latest.yml';
const UPDATE_RECHECK_MS = 4 * 60 * 60 * 1000; // long-open apps re-check every 4h

// GitHub's /releases/latest/download/* is a 302 to the CDN; plain
// https.get does not follow redirects, so walk them (bounded).
function httpsGetText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (!electronSecurity.isAllowedUpdaterUrl(url)) {
      return reject(new Error('updater URL not allowed'));
    }
    const req = https.get(url, { headers: { 'User-Agent': `1132Fixer/${app.getVersion()}` }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        if (!electronSecurity.isAllowedUpdaterUrl(next)) {
          return reject(new Error('updater redirect not allowed'));
        }
        return resolve(httpsGetText(next, redirectsLeft - 1));
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
      portableNotice = { version: latest };
      sendUpdateStatus({ state: 'manual', version: latest });
    } else {
      console.log(`${UPDATER} portable check: up to date (v${app.getVersion()})`);
    }
  } catch (err) {
    // Non-fatal: offline or GitHub unreachable; retried on the next tick.
    console.warn(`${UPDATER} portable check failed: ${(err && err.message) || err}`);
  }
}

ipcMain.handle('open-download-page', async () => {
  return electronSecurity.openExternalSafe(shell.openExternal.bind(shell), RELEASES_LATEST_URL);
});

// Explore modal: the renderer sends a
// destination KEY, never a URL. The key→URL map is trusted main-process
// data (electron-security.EXPLORE_DESTINATIONS); the schema layer already
// rejected unknown keys, and openExternalSafe still validates the mapped
// URL against the https allowlist — the map is not a bypass.
ipcMain.handle('open-explore-destination', async (_event, key) => {
  const url = electronSecurity.exploreDestinationUrl(key);
  if (!url) return { success: false, reason: 'destination not allowed' };
  return electronSecurity.openExternalSafe(shell.openExternal.bind(shell), url);
});

// "Explore Our Products" on the completed-repair screen. The destination
// is config.PRODUCTS_URL (src/main/config.js), never an IPC argument; the
// renderer hides the section unless this reports it available, and every
// open goes through the https allowlist. A browser failure is reported as
// { success: false } — no dialog, and the repair result is untouched.
ipcMain.handle('products-page-available', () => electronSecurity.productsPageAvailability(config.PRODUCTS_URL));
ipcMain.handle('open-products-page', async () => {
  const check = electronSecurity.productsPageAvailability(config.PRODUCTS_URL);
  if (!check.available) return { success: false, reason: check.reason };
  try {
    return await electronSecurity.openExternalSafe(shell.openExternal.bind(shell), config.PRODUCTS_URL);
  } catch (err) {
    console.warn(`[discovery] openExternal failed: ${(err && err.message) || err}`);
    return { success: false, reason: 'browser did not open' };
  }
});

const FIX_USER = 'user1';
// There is NO static password (security design, option A — SEC-A6, #33/#76).
// Every fix run mints a fresh CSPRNG password (helper-credential.js) at
// STEP 4; the delete->recreate model means the run that mints it also writes
// every consumer (launch, relaunch, DPAPI-sealed shortcut blob), so no
// old-password knowledge is ever needed and nothing plaintext hits disk.
// Default machine-wide install candidates only — the actual install is
// resolved by resolveZoomInstall() (32-bit MSI, custom install
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
// Machine-wide Zoom install resolution.
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

  const defaultsHit = profileSafety.discoverZoomExe(p => fs.existsSync(p));
  if (defaultsHit.path) {
    const hit = found(defaultsHit.path, defaultsHit.dir, defaultsHit.source);
    if (hit) return hit;
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

// ============================================================
// Zoom Workplace guided recovery card.
// Three IPCs, all renderer-argument-free by design:
//   zoom-open-download    opens EXACTLY the official admin download URL —
//                         the allowlisted catalog constant. The handler
//                         ignores IPC arguments entirely, so the renderer
//                         can never steer openExternal anywhere else.
//   zoom-choose-installer native file picker + full validation chain on the
//                         SELECTED file only: .msi extension -> OLE magic
//                         (0xD0CF11E0) -> Authenticode (Status Valid + Zoom
//                         publisher CN, exact match) -> MSI Template
//                         architecture vs the OS architecture. Any failed
//                         check = explained refusal naming that check;
//                         nothing is ever executed on failure.
//   zoom-run-installer    launches msiexec /i on the path the validation
//                         call just approved (main-process state — never a
//                         renderer-supplied path). Normal UAC flow; no
//                         credentials requested or stored. Installer exit
//                         fires 'zoom-installer-done' so the renderer runs
//                         the promised read-only re-scan.
// ============================================================

// The exact bytes the validation chain approved: { path, sha256 }. The launch
// step re-hashes and refuses if the file changed on disk after it was checked
// — a swap in a user-writable download folder would otherwise reach msiexec
// with this app's elevation (a check-to-use race).
let pendingInstaller = null;

// SHA-256 of a file, streamed so a large MSI never loads fully into memory.
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

ipcMain.handle('zoom-open-download', async () => {
  try {
    const opened = await electronSecurity.openExternalSafe(
      shell.openExternal.bind(shell),
      messages.ZOOM_RECOVERY.DOWNLOAD_URL
    );
    return { success: opened.success === true };
  } catch (_) {
    // Offline / no browser handler — renderer shows the Offline state.
    return { success: false };
  }
});

ipcMain.handle('zoom-choose-installer', async () => {
  pendingInstaller = null;
  const pick = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose the Zoom Workplace MSI installer',
    filters: [{ name: 'Windows Installer package', extensions: ['msi'] }],
    properties: ['openFile']
  });
  if (pick.canceled || !pick.filePaths || !pick.filePaths.length) return { canceled: true };
  const picked = electronSecurity.isSafeUserSelectedPath(pick.filePaths[0], { ext: '.msi' });
  if (!picked.ok) {
    return { ok: false, message: messages.zoomInstallerRefusal('not_msi_ext') };
  }
  const file = picked.path;

  // (i) It IS an MSI: extension + OLE compound-file magic.
  if (!/\.msi$/i.test(file)) {
    return { ok: false, message: messages.zoomInstallerRefusal('not_msi_ext') };
  }
  let head = null;
  try {
    const fd = await fs.promises.open(file, 'r');
    try {
      head = Buffer.alloc(4);
      await fd.read(head, 0, 4, 0);
    } finally { await fd.close(); }
  } catch (err) {
    return { ok: false, message: messages.zoomInstallerRefusal('unreadable', err && err.message) };
  }
  if (!zoomDetect.hasMsiMagic(head)) {
    return { ok: false, message: messages.zoomInstallerRefusal('not_msi_magic') };
  }

  // The path is interpolated into single-quoted PowerShell for the two
  // probes below. Doubling single quotes neutralizes quote breakout; control
  // characters have no business in a real dialog-returned path and are
  // refused outright.
  if ([...file].some(ch => ch.charCodeAt(0) < 0x20)) {
    return { ok: false, message: messages.zoomInstallerRefusal('unreadable', 'unsupported characters in the file path') };
  }
  const quoted = electronSecurity.psSingleQuote(file);
  if (!quoted.ok) {
    return { ok: false, message: messages.zoomInstallerRefusal('unreadable', 'unsupported characters in the file path') };
  }
  const psPath = quoted.literal.slice(1, -1);

  // (ii) Authenticode: Status must be Valid AND the signer CN must exactly
  // match one of the two accepted Zoom publisher names — no substrings.
  const sigProbe = await runPSCapture(`
    $sig = Get-AuthenticodeSignature -LiteralPath '${psPath}'
    Write-Output ('SIG_STATUS=' + [string]$sig.Status)
    if ($sig.SignerCertificate) { Write-Output ('SIG_SUBJECT=' + $sig.SignerCertificate.Subject) }
  `, { timeoutMs: 60000 });
  if (sigProbe.timedOut || sigProbe.code !== 0) {
    return { ok: false, message: messages.zoomInstallerRefusal('signature', sigProbe.timedOut ? 'the signature check timed out' : 'the signature check could not run') };
  }
  const sigStatus  = ((/^SIG_STATUS=(.*)$/m.exec(sigProbe.stdout) || [])[1] || '').trim();
  const sigSubject = ((/^SIG_SUBJECT=(.*)$/m.exec(sigProbe.stdout) || [])[1] || '').trim();
  if (sigStatus !== 'Valid') {
    return { ok: false, message: messages.zoomInstallerRefusal('signature', sigStatus || 'unreadable') };
  }
  const cn = zoomDetect.subjectCn(sigSubject);
  if (!messages.ZOOM_RECOVERY.PUBLISHERS.includes(cn)) {
    return { ok: false, message: messages.zoomInstallerRefusal('publisher', cn || sigSubject) };
  }

  // (iii) Architecture: MSI Summary-Information Template (property 7) vs
  // the OS architecture. PROCESSOR_ARCHITEW6432 first — under WOW/emulation
  // it carries the REAL OS architecture (incl. ARM64) while
  // PROCESSOR_ARCHITECTURE reports the emulated one.
  const archProbe = await runPSCapture(`
    try {
      $wi = New-Object -ComObject WindowsInstaller.Installer
      $db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @('${psPath}', 0))
      $si = $db.GetType().InvokeMember('SummaryInformation', 'GetProperty', $null, $db, $null)
      $t  = $si.GetType().InvokeMember('Property', 'GetProperty', $null, $si, @(7))
      Write-Output ('MSI_TEMPLATE=' + [string]$t)
    } catch {
      Write-Output ('MSI_TEMPLATE_ERROR=' + $_.Exception.Message)
    }
  `, { timeoutMs: 30000 });
  const template = ((/^MSI_TEMPLATE=(.*)$/m.exec(archProbe.stdout) || [])[1] || '').trim();
  if (!template) {
    const perr = ((/^MSI_TEMPLATE_ERROR=(.*)$/m.exec(archProbe.stdout) || [])[1] || '').trim();
    return { ok: false, message: messages.zoomInstallerRefusal('architecture', `The installer's architecture could not be read${perr ? ` (${perr})` : ''}.`) };
  }
  const osArch = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE || '';
  const cmp = zoomDetect.archCompare(template, osArch);
  if (!cmp.ok) {
    return { ok: false, message: messages.zoomInstallerRefusal('architecture', cmp.message) };
  }

  // Pin the exact bytes that just passed every check. The launch step
  // re-hashes and refuses if they change — nothing runs on a mismatch.
  let sha256;
  try {
    sha256 = await sha256File(file);
  } catch (err) {
    return { ok: false, message: messages.zoomInstallerRefusal('unreadable', err && err.message) };
  }
  pendingInstaller = { path: file, sha256 };
  return { ok: true, fileName: path.basename(file) };
});

ipcMain.handle('zoom-run-installer', async () => {
  // Runs ONLY the descriptor the validation call just approved — never an IPC
  // argument. One shot: the pending descriptor is consumed immediately.
  const pending = pendingInstaller;
  pendingInstaller = null;
  if (!pending) return { started: false };
  const { path: file, sha256 } = pending;

  // Re-verify the bytes are the ones that passed validation. On a user-
  // writable path (e.g. Downloads) another process could swap the file
  // between the checks and this launch; msiexec would then run the
  // replacement with this app's elevation. Any change = refuse, run nothing.
  try {
    const now = await sha256File(file);
    if (now !== sha256) {
      return { started: false, message: messages.zoomInstallerRefusal('changed') };
    }
  } catch (err) {
    return { started: false, message: messages.zoomInstallerRefusal('unreadable', err && err.message) };
  }

  let settled = false;
  const notifyDone = (code) => {
    if (settled) return;
    settled = true;
    // The one automatic behavior the card copy promises: when the installer
    // finishes, the renderer re-runs the read-only environment scan.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('zoom-installer-done', { code });
    }
  };
  // The whole installer run is a critical operation: the inactivity exit
  // must not close 1132 Fixer while Windows Installer is still working.
  const releaseInstaller = criticalOps.begin('zoom-installer');
  try {
    // Deliberately NOT added to activeChildren: quitting 1132 Fixer must
    // never kill a Windows Installer transaction mid-flight.
    const child = spawnWindowsTool('msiexec.exe', ['/i', file], { windowsHide: false });
    child.on('error', () => { notifyDone(-1); releaseInstaller(); });
    child.on('exit', (code) => { notifyDone(code); releaseInstaller(); });
    return { started: true };
  } catch (_) {
    releaseInstaller();
    return { started: false };
  }
});

// Tools that must exist in the Windows system folder before repair starts.
const REQUIRED_TOOLS = [
  'powershell.exe', 'taskkill.exe', 'robocopy.exe',
  'icacls.exe', 'takeown.exe', 'net.exe', 'reg.exe',
  'sc.exe', 'attrib.exe', 'cmd.exe'
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

function compactWindowBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(520, Math.max(440, workArea.width - 64));
  // 600 fits the tallest state (five-stage Fixing + actions + two-row
  // footer) without leaving the Ready state mostly empty.
  const height = Math.min(600, Math.max(560, workArea.height - 64));
  const x = workArea.x + Math.max(0, Math.round((workArea.width - width) / 2));
  const y = workArea.y + Math.max(0, Math.round((workArea.height - height) / 2));
  return { x, y, width, height };
}

function createWindow() {
  const bounds = compactWindowBounds();
  const minWidth = 440;
  const minHeight = 520;
  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth,
    minHeight,
    backgroundColor: '#0F1724',
    // NOTE: no alwaysOnTop. The old always-on-top + frameless window had no
    // drag region either, so it sat immovable above everything — including
    // the Zoom window this app launches. That's most of the "frozen/glitchy"
    // feedback. The header is now a real drag region (see index.html).
    frame: false,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: electronSecurity.rendererWebPreferences(path.join(__dirname, 'preload.js')),
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
    // A blocking native dialog is a critical operation: the inactivity
    // countdown must not run out behind it.
    const releaseDialog = criticalOps.begin('dialog');
    let choice = 0;
    try {
    choice = dialog.showMessageBoxSync(mainWindow, {
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
    } finally {
      releaseDialog();
      if (inactivityCtl) inactivityCtl.activity('dialog', 'unresponsive-dialog');
    }
    if (choice === 1) {
      if (!killActiveChildren()) {
        console.error('fatal-path: restart blocked because child-tree termination is unproved');
        return;
      }
      fatalDialogShown = true;
      app.relaunch();
      app.exit(1);
    }
  });

  electronSecurity.hardenWebContents(mainWindow.webContents, { appRoot: app.getAppPath() });
  mainWindow.loadFile('index.html');
  mainWindow.setMenu(null);
}

// Self-elevation flag (see relaunchElevated below) — declared before the
// single-instance block because the lock handling special-cases it.
const ELEVATE_RETRY_FLAG = elevCtl.retryFlag;

// Single-instance lock. Without it, the post-update relaunch (and users
// double-clicking during the silent install) produced two elevated windows
// fighting over the same PowerShell children.
//
// Elevated-relaunch race: the elevated instance starts while its
// non-elevated parent is still shutting down. The parent releases its lock
// before spawning, but the release can lag the process teardown — the
// child's first lock attempt then fails and it used to die silently
// (launch → UAC accepted → nothing opens). A child carrying
// ELEVATE_RETRY_FLAG retries briefly instead; every other second instance
// still quits immediately.
let singleInstanceLockOwned = false;
const singleInstanceReady = (async () => {
  if (app.requestSingleInstanceLock()) {
    singleInstanceLockOwned = true;
    return true;
  }
  if (!process.argv.includes(ELEVATE_RETRY_FLAG)) return false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) {
      singleInstanceLockOwned = true;
      return true;
    }
  }
  return false;
})();
singleInstanceReady.then(got => {
  if (!got) { shutdown.request(shutdown.REASONS.SECOND_INSTANCE); return; }
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
});

// ============================================================
// Self-elevation (operator request 2026-08-23). The packaged exe already
// carries requestedExecutionLevel=requireAdministrator, so Windows prompts
// before it starts; this covers every run that still arrives non-elevated
// (dev runs, launchers that strip the manifest). One automatic attempt per
// launch — the relaunched instance carries a flag so a declined prompt can
// never loop — and the renderer's "Restart as administrator" button retries
// on demand. Start-Process -Verb RunAs IS the Windows approval prompt: the
// app never sees, asks for, or stores a password.
// ============================================================

// Last relaunch outcome, reported to the renderer so "View details" can say
// whether Windows approval was cancelled, timed out, or never asked
// (PowerShell missing). One of: started | declined | timeout |
// launch-error | failed | already-elevated | lock-lost | null.
let lastRelaunchOutcome = null;

function reacquireSingleInstanceLock() {
  try {
    singleInstanceLockOwned = app.requestSingleInstanceLock() === true;
  } catch (_) {
    singleInstanceLockOwned = false;
  }
  if (!singleInstanceLockOwned) {
    lastRelaunchOutcome = 'lock-lost';
    shutdown.request(shutdown.REASONS.SECOND_INSTANCE);
  }
  return singleInstanceLockOwned;
}

async function relaunchElevated() {
  if (await isElevatedSync()) { lastRelaunchOutcome = 'already-elevated'; return false; }
  const exe = process.execPath;
  app.releaseSingleInstanceLock();
  singleInstanceLockOwned = false;
  let started = false;
  try {
    const r = await elevCtl.relaunchElevated({
      execPath: exe,
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      argv: process.argv
    });
    started = !!r.started;
    lastRelaunchOutcome = r.outcome || (started ? 'started' : 'failed');
  } catch (err) {
    started = false;
    lastRelaunchOutcome = 'failed';
    console.warn(`[startup] elevation.relaunch threw: ${(err && err.message) || err}`);
  }
  if (!started) reacquireSingleInstanceLock();
  return started;
}

app.whenReady().then(async () => {
  // Second instance (except the elevated-relaunch retry) — quitting; never
  // open a window from it.
  if (!await singleInstanceReady) return;
  // Automatic attempt, before any window: launch → Windows approval prompt
  // → elevated instance opens and this one exits. Declined/failed → the
  // window opens anyway and explains, with a retry button (never a loop:
  // the relaunched instance carries ELEVATE_RETRY_FLAG).
  if (!process.argv.includes(ELEVATE_RETRY_FLAG)) {
    let elevated = false;
    try { elevated = await isElevatedSync(); } catch (_) { /* treated as not elevated */ }
    if (!elevated) {
      let started = false;
      try { started = await relaunchElevated(); } catch (_) { /* stay un-elevated */ }
      if (started) { shutdown.request(shutdown.REASONS.ELEVATED_RELAUNCH); return; }
      if (!singleInstanceLockOwned) return;
    }
  }
  createWindow();

  // Inactivity exit: main-process timer, renderer reports activity. Window
  // focus is activity; sleep and session lock pause the clock and the real
  // elapsed time is evaluated on resume (warning first, never an immediate
  // exit). The timer itself starts when the renderer reports ready
  // (update-app-ready), or after a minute at the latest.
  getInactivity();
  app.on('browser-window-focus', () => { if (inactivityCtl) inactivityCtl.activity('focus', 'window'); });
  powerMonitor.on('suspend', () => { if (inactivityCtl) inactivityCtl.pause('sleep'); });
  powerMonitor.on('resume', () => { if (inactivityCtl) inactivityCtl.resume('resume'); });
  powerMonitor.on('lock-screen', () => { if (inactivityCtl) inactivityCtl.pause('lock'); });
  powerMonitor.on('unlock-screen', () => { if (inactivityCtl) inactivityCtl.resume('unlock'); });
  powerMonitor.on('shutdown', () => { shutdown.note(shutdown.REASONS.SYSTEM_SHUTDOWN); });
  setTimeout(() => startInactivityTimer('window-open-fallback'), 60000);

  // Auto-update only makes sense for the packaged NSIS install. The portable
  // exe has no installer to hand off to (electron-updater cannot update
  // portable targets) — it gets a manual-download notice instead — and dev
  // runs have no app-update.yml, which used to produce a red-herring updater
  // error on every launch.
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  // Evaluate what the previous process left behind (a handoff record from
  // an install we started) before any new check: a relaunch that came back
  // as the wrong version is reported, never silently re-checked over.
  const updater = getUpdater();
  updater.start();
  if (app.isPackaged && !isPortable) {
    // The controller refuses duplicate checks, checks during a fix, and
    // checks inside the backoff window after a failed handoff.
    setTimeout(() => { updater.check('startup').catch(() => {}); }, 3000);
    // Long-open sessions: re-check periodically.
    setInterval(() => { updater.check('interval').catch(() => {}); }, UPDATE_RECHECK_MS);
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
  shutdown.note(shutdown.REASONS.USER_EXIT);
  app.quit();
});

app.on('before-quit', (event) => {
  // A quit that nothing in this process asked for (OS session end, a
  // Windows-initiated close) is recorded as such; the first named reason
  // wins so an update restart is never mislabelled.
  const reason = shutdown.note(shutdown.REASONS.SYSTEM_SHUTDOWN);
  // No warning can reopen and no countdown can fire once shutdown began.
  if (inactivityCtl) inactivityCtl.dispose();
  if (!killActiveChildren()) {
    event.preventDefault();
    console.error('fatal-path: quit blocked because child-tree termination is unproved');
    return;
  }
  // A verified update the user deferred installs silently as the app exits
  // (no relaunch — the user chose to leave). Excluded for an update restart
  // (the installer is already running) and for fatal / relaunch exits.
  if (updaterCtl && updaterCtl.isReady()) {
    const r = updaterCtl.installOnExit(reason);
    updaterLog.info('install-on-exit', { reason, result: r });
  }
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
// child TREE first. A fatal exit proceeds only after Windows confirms that
// termination; otherwise this process keeps custody and does not relaunch.
const activeChildren = new Set();
const unprovedChildTrees = new WeakSet();
const childTreeCustody = new WeakMap();
function terminateChildTree(child) {
  const result = {
    treeTerminated: false,
    taskkillStatus: null,
    taskkillError: null,
    taskkillSignal: null,
    taskkillAttempts: [],
    parentIdentifiable: false
  };
  const custody = child && childTreeCustody.get(child);
  const parentIsIdentifiable = !!(custody && Number.isInteger(custody.pid) && custody.pid > 0 &&
    !custody.exitObserved && child.exitCode === null && child.signalCode === null);
  result.parentIdentifiable = parentIsIdentifiable;
  if (!custody) {
    result.taskkillError = 'unregistered-child';
    return result;
  }
  if (custody.treeKillAttempted) {
    result.taskkillError = 'retry-blocked';
    return result;
  }
  if (!parentIsIdentifiable) {
    result.taskkillError = 'parent-not-live';
    return result;
  }

  // spawnSync blocks delivery of the child's exit event. A failed call can
  // therefore outlive the original process while Windows reuses its numeric
  // PID. Mark the original ChildProcess identity before the one permitted
  // tree-kill attempt. No later path may target that PID again.
  custody.treeKillAttempted = true;
  const evidence = { attempt: 1, status: null, error: null, signal: null };
  try {
    const killed = spawnWindowsToolSync('taskkill.exe', ['/PID', String(custody.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10000
    });
    evidence.status = Number.isInteger(killed && killed.status) ? killed.status : null;
    evidence.error = killed && killed.error
      ? String(killed.error.code || killed.error.name || 'process-error')
      : null;
    evidence.signal = killed && killed.signal ? String(killed.signal) : null;
  } catch (err) {
    evidence.error = String((err && (err.code || err.name)) || 'exception');
  }
  result.taskkillAttempts.push(evidence);
  result.taskkillStatus = evidence.status;
  result.taskkillError = evidence.error;
  result.taskkillSignal = evidence.signal;
  result.treeTerminated = evidence.status === 0 && !evidence.error && !evidence.signal;
  return result;
}

function terminationEvidence(result) {
  const attempts = result.taskkillAttempts.map(item =>
    `${item.attempt}:${item.status === null ? 'none' : item.status}/${item.error || 'none'}/${item.signal || 'none'}`
  ).join(',');
  return `taskkillAttempts=${result.taskkillAttempts.length}[${attempts}]` +
    ` taskkillStatus=${result.taskkillStatus === null ? 'none' : result.taskkillStatus}` +
    ` taskkillError=${result.taskkillError || 'none'}` +
    ` taskkillSignal=${result.taskkillSignal || 'none'}` +
    ` parentIdentifiable=${result.parentIdentifiable}`;
}

function killActiveChildren() {
  let allTerminated = true;
  for (const child of activeChildren) {
    const result = terminateChildTree(child);
    if (result.treeTerminated) {
      unprovedChildTrees.delete(child);
      activeChildren.delete(child);
      console.warn(`fatal-path: killed child tree pid=${child.pid} ${terminationEvidence(result)}`);
    } else {
      unprovedChildTrees.add(child);
      allTerminated = false;
      console.warn(`fatal-path: retained child custody pid=${child && child.pid || 'none'} ${terminationEvidence(result)}`);
    }
  }
  return allTerminated;
}

process.on('uncaughtException', (err) => {
  console.error('FATAL uncaughtException:', (err && err.stack) || err);
  const childrenStopped = killActiveChildren();
  if (!fatalDialogShown) {
    fatalDialogShown = true;
    try {
      dialog.showErrorBox(
        '1132 Fixer hit a problem it could not recover from',
        (childrenStopped
          ? 'The app has to close. If a fix was running, run it again after restarting — the fix is safe to repeat and repairs partial runs.\n\n'
          : 'Windows did not confirm that the active repair process tree stopped. ' +
            'The app will stay open and will not start another repair. After Windows confirms the process has ended, close the app and restart it.\n\n') +
        'Start 1132 Fixer again. If this keeps happening, report it at\n' +
        'https://github.com/1132-Fixer/windows/issues\n\n' +
        `Detail for support: ${(err && err.message) || err}`
      );
    } catch (_) { /* dialog itself failed — the console line above remains */ }
  }
  if (!childrenStopped) return;
  app.exit(1);
});

app.on('render-process-gone', (_event, _webContents, details) => {
  if (details && details.reason === 'clean-exit') return;
  console.error(`FATAL render-process-gone: reason=${details && details.reason} exitCode=${details && details.exitCode}`);
  if (fatalDialogShown) return;
  fatalDialogShown = true;
  const hadFix = fixInProgress;
  const childrenStopped = killActiveChildren();
  const fixNote = hadFix
    ? (childrenStopped
      ? '\n\nA fix was running — it has been stopped. Run it again after restarting; the fix is safe to repeat and repairs partial runs.'
      : '\n\nWindows did not confirm that the repair process tree stopped. The app will stay open and will not start another repair.')
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
  if (!childrenStopped) return;
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
    ? path.join(process.resourcesPath, profileSafety.PRIMARY_SHORTCUT_ICON)
    : path.join(__dirname, 'assets', profileSafety.PRIMARY_SHORTCUT_ICON);
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
  const { heartbeatMs = 0, heartbeatLabel = '', timeoutMs = 60000, stdin = null } = opts;
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let stderrBuf = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let settled = false;
    let terminationUnproved = false;
    let lastOutputAt = Date.now();
    const started = Date.now();
    let child;
    try {
      child = spawnWindowsTool(exe, args, { windowsHide: true });
    } catch (err) {
      onLine(`Failed to launch ${exe}: ${err.message}`, 'err');
      resolve({ code: -1, stdout: '', stderr: err.message, timedOut: false, errorCode: err.code || 'launch_error' });
      return;
    }
    activeChildren.add(child);
    const custody = {
      pid: child.pid,
      exitObserved: false,
      treeKillAttempted: false
    };
    childTreeCustody.set(child, custody);
    let killTimer = null;
    let closeGraceTimer = null;
    let timedOut = false;
    let postExitErrorCode = null;
    child.once('exit', (code) => {
      custody.exitObserved = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (settled || terminationUnproved || unprovedChildTrees.has(child)) return;
      // `close` normally follows after stdout/stderr drain. A descendant can
      // keep inherited pipes open after the owned child exits, so bound that
      // drain without letting the old deadline target a reused numeric PID.
      closeGraceTimer = setTimeout(() => finish(postExitErrorCode ? -1 : code, postExitErrorCode), 500);
    });
    const emit = (buf, kind) => {
      if (settled || terminationUnproved || unprovedChildTrees.has(child)) return;
      const text = (kind === 'err' ? stderrDecoder : stdoutDecoder).write(buf);
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
        if (settled || terminationUnproved || unprovedChildTrees.has(child)) return;
        const idleSec = Math.round((Date.now() - lastOutputAt) / 1000);
        const elapsedSec = Math.round((Date.now() - started) / 1000);
        if (idleSec >= Math.round(heartbeatMs / 1000)) {
          const label = heartbeatLabel || exe;
          onLine(`  ... still working (${label}; elapsed ${elapsedSec}s, idle ${idleSec}s)`, 'out');
        }
      }, heartbeatMs);
    }

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        if (settled || custody.exitObserved) return;
        timedOut = true;
        onLine(`  TIMEOUT after ${Math.round(timeoutMs / 1000)}s — killing ${exe}`, 'err');
        // Kill the TREE, not just the direct child: the profile
        // traversal steps run takeown/icacls via Start-Process inside
        // powershell.exe, and killing only PS orphans a recursive tool
        // mid-cycle — it keeps grinding (and holding profile handles)
        // invisibly. Same idiom as killActiveChildren.
        terminationUnproved = true;
        const termination = terminateChildTree(child);
        if (!termination.treeTerminated) {
          unprovedChildTrees.add(child);
          stopTimers();
          onLine(`  BLOCKED: child-tree termination is unproved; retaining custody (${terminationEvidence(termination)})`, 'err');
          return;
        }
        unprovedChildTrees.delete(child);
        terminationUnproved = false;
        finish(-1, 'ETIMEDOUT');
      }, timeoutMs);
    }

    const stopTimers = () => {
      if (hbTimer) clearInterval(hbTimer);
      if (killTimer) clearTimeout(killTimer);
      if (closeGraceTimer) clearTimeout(closeGraceTimer);
      hbTimer = null;
      killTimer = null;
      closeGraceTimer = null;
    };

    const cleanup = () => {
      stopTimers();
      unprovedChildTrees.delete(child);
      activeChildren.delete(child);
      childTreeCustody.delete(child);
    };

    const finish = (code, errorCode = null) => {
      if (settled || terminationUnproved || unprovedChildTrees.has(child)) return;
      stdoutBuf += stdoutDecoder.end();
      stderrBuf += stderrDecoder.end();
      settled = true;
      cleanup();
      resolve({ code, stdout: stdoutBuf, stderr: stderrBuf, timedOut, errorCode });
    };
    child.on('error', err => {
      if (settled || terminationUnproved || unprovedChildTrees.has(child)) return;
      stderrBuf += err.message;
      onLine(`Failed to launch ${exe}: ${err.message}`, 'err');
      finish(-1, err.code || 'launch_error');
    });
    child.on('close', code => {
      if (!terminationUnproved && !unprovedChildTrees.has(child)) {
        finish(postExitErrorCode ? -1 : code, postExitErrorCode);
      }
    });
    // Caller source can contain a helper credential. It is sent through a
    // private pipe, never embedded in PowerShell argv or a temporary script.
    child.stdin.on('error', () => {
      if (settled) return;
      if (custody.exitObserved) {
        if (!terminationUnproved && !unprovedChildTrees.has(child)) {
          postExitErrorCode = 'stdin_failed';
        }
        return;
      }
      terminationUnproved = true;
      const termination = terminateChildTree(child);
      if (!termination.treeTerminated) {
        unprovedChildTrees.add(child);
        stopTimers();
        onLine(`Failed to stop child after stdin failure; retaining custody (${terminationEvidence(termination)})`, 'err');
        return;
      }
      unprovedChildTrees.delete(child);
      terminationUnproved = false;
      finish(-1, 'stdin_failed');
    });
    child.stdin.end(stdin === null ? undefined : stdin, 'utf8');
  });
}

// Keep UTF-8 input and output together in the shared transport (#93 #111).
// Windows PowerShell 5.1 writes REDIRECTED stdout/stderr in the legacy OEM
// codepage while runProcess decodes the pipes as UTF-8, so any non-ASCII
// character in captured output arrived corrupted \u2014 most damagingly the
// OneDrive-redirected, localized Desktop path from
// [Environment]::GetFolderPath('Desktop') ("\u00c1rea de Trabalho", "\u0420\u0430\u0431\u043e\u0447\u0438\u0439
// \u0441\u0442\u043e\u043b", accented user names), which then fed shortcut creation a folder
// that does not exist. Forcing the console output encoding to UTF-8 as the
// script's first statement makes PS emit what Node decodes. try/catch: the
// setter needs a console handle; the shared preamble falls back to UTF-8
// stream writers when PowerShell starts without a console.
async function runPSScript(scriptContent, onLine, opts = {}) {
  return runProcess('powershell.exe', windowsTools.PS_STDIN_ARGS,
    onLine, { ...opts, stdin: windowsTools.prepareScript(scriptContent) });
}

// Zoom-launch runner. Start-Process -Credential
// (CreateProcessWithLogonW) makes the launched Zoom inherit the parent
// PowerShell's std handles. The old stdio:'ignore' variant existed because
// with plain runPSScript pipes, Zoom held our stderr pipe open after PS
// exited, so the 'close' event never fired and run-fix froze at Step 5 —
// but 'ignore' also threw away the launcher's bounded phase diagnostics.
// This variant keeps BOTH properties:
//   - detach semantics preserved: Start-Process without -Wait creates a
//     free-standing process; PS exits right after dispatch, and we resolve
//     on 'exit' (process ended) instead of 'close' (pipes drained), so a
//     Zoom that inherited our pipe handles can never wedge the step. The
//     pipes are destroyed after a short drain race; Zoom writing to a
//     broken pipe is the same do-nothing sink 'ignore' gave it.
//   - the launcher's own output (written before PS exits) is captured and
//     returned. Only a closed, non-secret phase marker reaches the log.
// The 30s guard kills only powershell.exe (never the credential-launched
// Zoom — child.kill targets the PS pid alone). Callers still verify launch
// success out-of-band by polling Win32_Process — capture is evidence, the
// poll stays the authority.
function normalizeLaunchExceptionClass(value) {
  const text = typeof value === 'string' ? value : '';
  return /^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(text) ? text : 'none';
}

function normalizeLaunchInteger(value) {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 4294967295) return 'none';
  return String(value);
}

function launchCaptureErrorMetadata(error) {
  const nativeCode = normalizeLaunchInteger(error && error.errno);
  return {
    exceptionClass: normalizeLaunchExceptionClass(error && error.name),
    nativeCode: nativeCode === 'none' ? null : Number(nativeCode)
  };
}

function parseLaunchPhaseMarkers(stdout) {
  const prefix = 'FIXER_LAUNCH_PHASE_V1 ';
  const pattern = /^FIXER_LAUNCH_PHASE_V1 phase=(pre_launch|credential|start_process) outcome=(success|failure) exceptionClass=(none|[A-Za-z][A-Za-z0-9_.]{0,127}) hresult=(none|-?\d{1,12}) nativeCode=(none|-?\d{1,12})$/;
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim());
  const candidates = lines.filter(line => line.startsWith(prefix));
  if (!candidates.length || candidates.length > 2) return [];
  const markers = [];
  for (const line of candidates) {
    const match = pattern.exec(line);
    if (!match) return [];
    const marker = { phase: match[1], outcome: match[2], exceptionClass: match[3], hresult: match[4], nativeCode: match[5] };
    if (marker.outcome === 'success' &&
        (marker.exceptionClass !== 'none' || marker.hresult !== 'none' || marker.nativeCode !== 'none')) return [];
    markers.push(marker);
  }
  const credential = markers[0];
  if (credential.phase === 'pre_launch') {
    return credential.outcome === 'failure' && markers.length === 1 ? markers : [];
  }
  if (credential.phase !== 'credential') return [];
  if (credential.outcome === 'failure') return markers.length === 1 ? markers : [];
  if (markers.length !== 2 || markers[1].phase !== 'start_process') return [];
  return markers;
}

function formatLaunchDiagnostics(launch) {
  const result = launch && typeof launch === 'object' ? launch : {};
  let markers = parseLaunchPhaseMarkers(result.stdout);
  const exitCode = Number.isSafeInteger(result.code) ? String(result.code) : 'none';
  const timeout = result.timedOut === true;
  if (markers.length) {
    const terminal = markers[markers.length - 1];
    const exitConsistent = terminal.outcome === 'success' ? result.code === 0 : result.code !== 0;
    if (!exitConsistent || timeout) markers = [];
  }
  const markerPresent = markers.length > 0;
  if (!markerPresent) {
    markers = [{
      phase: 'pre_launch',
      outcome: 'failure',
      exceptionClass: normalizeLaunchExceptionClass(result.exceptionClass),
      hresult: normalizeLaunchInteger(result.hresult),
      nativeCode: normalizeLaunchInteger(result.nativeCode)
    }];
  }
  return markers.map(marker =>
    `Launch diagnostic: phase=${marker.phase} outcome=${marker.outcome}` +
    ` exceptionClass=${marker.exceptionClass} hresult=${marker.hresult} nativeCode=${marker.nativeCode}` +
    ` exitCode=${exitCode} timeout=${timeout} markerPresent=${markerPresent}`);
}

async function runPSScriptLaunchCapture(scriptContent) {
  return new Promise((resolve) => {
    let stdoutBuf = '';
    const outputDecoder = new StringDecoder('utf8');
    const errorDecoder = new StringDecoder('utf8');
    let settled = false;
    let exitObserved = false;
    let killTimer = null;
    let timedOut = false;
    let processErrorCode = null;
    let processExceptionClass = 'none';
    let processNativeCode = null;
    let child;
    try {
      child = spawnWindowsTool('powershell.exe', windowsTools.PS_STDIN_ARGS, { windowsHide: true });
    } catch (err) {
      const metadata = launchCaptureErrorMetadata(err);
      resolve({ code: -1, stdout: '', timedOut: false, errorCode: err.code || 'launch_error', ...metadata });
      return;
    }
    child.stdout.on('data', d => { if (!settled) stdoutBuf += outputDecoder.write(d); });
    child.stderr.on('data', d => { if (!settled) stdoutBuf += errorDecoder.write(d); });
    const settle = (code) => {
      if (settled) return;
      stdoutBuf += outputDecoder.end() + errorDecoder.end();
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      try { child.stdout.destroy(); } catch (_) {}
      try { child.stderr.destroy(); } catch (_) {}
      resolve({ code, stdout: stdoutBuf, timedOut, errorCode: processErrorCode,
        exceptionClass: processExceptionClass, nativeCode: processNativeCode });
    };
    killTimer = setTimeout(() => {
      if (exitObserved) return;
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      settle(-1);
    }, 30000);
    child.on('error', (err) => {
      processErrorCode = String((err && (err.code || err.name)) || 'process-error');
      const metadata = launchCaptureErrorMetadata(err);
      processExceptionClass = metadata.exceptionClass;
      processNativeCode = metadata.nativeCode;
      settle(-1);
    });
    child.stdin.on('error', (err) => {
      processErrorCode = 'stdin-error';
      const metadata = launchCaptureErrorMetadata(err);
      processExceptionClass = metadata.exceptionClass;
      processNativeCode = metadata.nativeCode;
      try { child.kill('SIGKILL'); } catch (_) {}
      settle(-1);
    });
    child.stdin.end(windowsTools.prepareScript(scriptContent), 'utf8');
    child.on('exit', (code) => {
      exitObserved = true;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      // PS has exited; give any tail output one short drain race, then
      // stop waiting on pipes Zoom may hold open forever.
      const grace = setTimeout(() => settle(code), 500);
      child.once('close', () => { clearTimeout(grace); settle(code); });
    });
  });
}

async function runPSCapture(scriptContent, opts = {}) {
  const noop = () => {};
  return runPSScript(scriptContent, noop, opts);
}

// Elevation cannot change for the lifetime of the process, so probe once and
// memoize. The probe reads TOKEN_ELEVATION (with an integrity-SID fallback).
// It never uses net.exe session, username, or an unbounded child process.
function isElevatedSync() {
  return elevCtl.isElevated().then((r) => r.elevated === true).catch(() => false);
}

// Bounded: `net user` can stall behind a slow Workstation/NetLogon lookup.
// On timeout the account is reported as absent, which only makes the fix
// take its create path — safe, because creation is idempotent.
const USER_EXISTS_TIMEOUT_MS = 15000;
function userExists(username) {
  return new Promise(resolve => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const child = spawnWindowsTool('net.exe', ['user', username], { windowsHide: true });
    const timer = setTimeout(() => {
      try { spawnWindowsToolSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch (_) {}
      done(false);
    }, USER_EXISTS_TIMEOUT_MS);
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
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
    $paths = @{}
    foreach ($t in $tools) {
      $paths[$t] = Resolve-FixerTool $t
      $r[$t] = [bool](Test-Path -LiteralPath $paths[$t] -PathType Leaf -ErrorAction Stop)
    }
    $r['tool_paths'] = $paths
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
      message: 'Not running as Administrator. Close the app, right-click its icon and choose "Run as administrator", then try again.'
    });
  }

  // Logged-in user must not be user1
  const interactiveUser = (os.userInfo().username || '').toLowerCase();
  info.interactiveUser = interactiveUser;
  if (interactiveUser === FIX_USER.toLowerCase()) {
    blockers.push({
      code: 'running_as_target',
      message: `You are signed in as '${FIX_USER}' — the fix rebuilds this very account. Sign out, sign in as a different administrator account, then run 1132 Fixer again.`
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
  const inventory = windowsTools.parseProbe(probe, allTools);
  info.tools = inventory.tools;
  info.toolPaths = inventory.tool_paths || {};
  info.toolProbe = { exitCode: probe.code, errorCode: probe.errorCode || null, timedOut: !!probe.timedOut };
  info.seclogon = {
    ...inventory.seclogon,
    selfHeal: 'none'
  };
  if (!inventory.ok) {
    blockers.push({
      code: inventory.diagnostic.code,
      message: inventory.diagnostic.code === 'tool_probe_timeout'
        ? messages.WINDOWS_TOOLS.PROBE_TIMEOUT : messages.WINDOWS_TOOLS.PROBE_FAILED
    });
    // No valid inventory means unknown, not absent. Never infer service or
    // per-tool failures from a failed process or incomplete response.
    return { ok: false, blockers, warnings, info };
  }
  const missingTools = REQUIRED_TOOLS.filter(t => inventory.tools[t] === false);
  if (missingTools.length) {
    blockers.push({ code: 'missing_tool', tools: missingTools, message: messages.WINDOWS_TOOLS.MISSING });
    // A missing dependency cannot be repaired by starting another tool.
    return { ok: false, blockers, warnings, info };
  }
  // OPTIONAL_TOOLS (quser.exe, logoff.exe) ship on Windows Pro/Enterprise only;
  // absent by design on Home. tryLogoffUser gates on info.tools and falls back
  // to taskkill alone, so we don't surface this to the user as a warning.
  //
  // seclogon is a HARD GATE with self-heal. Field reports
  // (#54 #58 #64 #66 #70 #72) show Stopped/Manual passing preflight and the
  // fix then finishing with a silent no-op launch — "Windows auto-starts it
  // on demand" is not reliable evidence. Green now requires the service
  // actually Running: a Stopped-but-startable service gets ONE bounded start
  // attempt right here, and a failed attempt is a blocker, not a warning.
  if (info.seclogon.status === 'MISSING') {
    blockers.push({
      code: 'seclogon_missing',
      message: 'Secondary Logon service (seclogon) not found. Launching Zoom as user1 will likely fail.'
    });
  } else if (info.seclogon.startType === 'Disabled') {
    blockers.push({
      code: 'seclogon_disabled',
      message: 'Secondary Logon service (seclogon) is Disabled. Start-Process -Credential cannot run. Run "sc.exe config seclogon start= demand" from an admin shell and retry.'
    });
  } else if (info.seclogon.status !== 'Running' && elevated &&
             (info.seclogon.startType === 'Manual' || info.seclogon.startType === 'Automatic')) {
    const heal = await runPSCapture(`
      $null = & (Resolve-FixerTool 'sc.exe') start seclogon 2>&1
      $deadline = [DateTime]::UtcNow.AddSeconds(8)
      do {
        try { if ((Get-Service seclogon -EA Stop).Status -eq 'Running') { Write-Output 'SECLOGON_HEAL=RUNNING'; exit 0 } } catch {}
        Start-Sleep -Milliseconds 400
      } while ([DateTime]::UtcNow -lt $deadline)
      $st = ''
      try { $st = [string](Get-Service seclogon -EA Stop).Status } catch { $st = 'unreadable' }
      Write-Output ('SECLOGON_HEAL=FAILED=' + $st)
    `, { timeoutMs: 10000 });
    if (heal.code === 0 && !heal.timedOut && /^SECLOGON_HEAL=RUNNING\s*$/m.test(heal.stdout || '')) {
      info.seclogon.status = 'Running';
      info.seclogon.selfHeal = 'started';
    } else {
      const m = /SECLOGON_HEAL=FAILED=(.*)$/m.exec(heal.stdout || '');
      const st = (m && m[1].trim()) || (heal.timedOut ? 'start attempt timed out' : 'state unreadable');
      info.seclogon.selfHeal = 'start-failed';
      blockers.push({
        code: 'seclogon_start_failed',
        message: `Secondary Logon service (seclogon) is stopped and did not start (state after the attempt: ${st}). Zoom cannot be launched as ${FIX_USER} without it. Run "sc.exe start seclogon" from an admin shell, then re-check.`
      });
    }
  } else if (info.seclogon.status !== 'Running') {
    // Residual states only: not elevated (the not_elevated blocker already
    // gates the fix) or an unexpected StartType we cannot self-heal.
    blockers.push({
      code: 'seclogon_not_running',
      message: `Secondary Logon service is ${info.seclogon.status}/${info.seclogon.startType} and was not started. Launching Zoom as ${FIX_USER} may fail until it runs.`
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
      $raw = & (Resolve-FixerTool 'quser.exe') 2>$null
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
        & (Resolve-FixerTool 'logoff.exe') $sid 2>&1 | Out-Null
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
// Resolve exactly one local-machine account SID. A domain account with the
// same leaf name is not the helper account. A SID from the deleted account
// generation is also not valid after recreation.
// ============================================================
async function readLocalAccountIdentity(username) {
  const failed = { verified: false, exists: false, sid: '' };
  const userLiteral = String(username || '').replace(/'/g, "''");
  const r = await runPSCapture(`
    $u = '${userLiteral}'
    $accounts = @()
    try {
      $filter = "Name='" + $u.Replace("'", "''") + "'"
      $accounts = @(Get-CimInstance Win32_UserAccount -Filter $filter -EA Stop |
        ForEach-Object {
          [pscustomobject]@{
            name = [string]$_.Name
            domain = [string]$_.Domain
            localAccount = [bool]$_.LocalAccount
            sid = [string]$_.SID
          }
        })
    } catch { exit 1 }
    [pscustomobject]@{
      machine = [System.Environment]::MachineName
      accounts = @($accounts)
    } | ConvertTo-Json -Compress -Depth 3
  `, { timeoutMs: 15000 });
  if (r.timedOut || r.code !== 0) return failed;
  try {
    const payload = JSON.parse((r.stdout || '').trim());
    const machine = payload && typeof payload.machine === 'string' ? payload.machine : '';
    if (!payload || typeof payload !== 'object' || !machine ||
        !Object.prototype.hasOwnProperty.call(payload, 'accounts')) return failed;
    const rawAccounts = payload.accounts;
    const accounts = Array.isArray(rawAccounts)
      ? rawAccounts
      : (rawAccounts === null ? [] : [rawAccounts]);
    if (accounts.some(account => !account || typeof account !== 'object' ||
        typeof account.name !== 'string' || typeof account.domain !== 'string' ||
        typeof account.localAccount !== 'boolean' || typeof account.sid !== 'string')) return failed;
    const matches = accounts.filter(account => account.localAccount === true &&
      String(account.name || '').toLowerCase() === String(username || '').toLowerCase() &&
      String(account.domain || '').toLowerCase() === machine.toLowerCase());
    if (matches.length > 1) return failed;
    if (matches.length === 0) return { verified: true, exists: false, sid: '' };
    if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/i.test(matches[0].sid)) return failed;
    return { verified: true, exists: true, sid: matches[0].sid };
  } catch (_) {
    return failed;
  }
}

async function resolveSID(username, staleSid = '') {
  const identity = await readLocalAccountIdentity(username);
  if (!identity.verified || !identity.exists) return '';
  if (staleSid && identity.sid.toLowerCase() === String(staleSid).toLowerCase()) return '';
  return identity.sid;
}

// Delete one local account generation by SID. A name is only a receipt
// field: it never selects the mutation target. The script emits exactly one
// closed JSON receipt and never copies command errors or account data to it.
function exactSidLocalUserDeleteScript(expectedSid, expectedName, trustedModuleRoot = '') {
  const sidLiteral = String(expectedSid || '').replace(/'/g, "''");
  const nameLiteral = String(expectedName || '').replace(/'/g, "''");
  const moduleRootLiteral = String(trustedModuleRoot || '').replace(/'/g, "''");
  const moduleRootExpression = moduleRootLiteral
    ? `'${moduleRootLiteral}'`
    : "(Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.LocalAccounts')";
  return String.raw`
    $ErrorActionPreference = 'Stop'
    $expectedSidText = '${sidLiteral}'
    $expectedName = '${nameLiteral}'
    $pre = 'unknown'
    $deletion = 'not-run'
    $expectedSidPost = 'unknown'
    $namePost = 'unknown'
    try {
      if ($expectedSidText -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { throw 'invalid SID' }
      $trustedModuleRoot = [IO.Path]::GetFullPath(${moduleRootExpression}).TrimEnd('\')
      $trustedPrefix = $trustedModuleRoot + '\'
      $trustedManifests = @([IO.Directory]::GetFiles(
        $trustedModuleRoot,
        'Microsoft.PowerShell.LocalAccounts.psd1',
        [IO.SearchOption]::AllDirectories) | Where-Object {
          [IO.Path]::GetFullPath([string]$_).StartsWith($trustedPrefix, [StringComparison]::OrdinalIgnoreCase)
        })
      if ($trustedManifests.Count -ne 1) { throw 'trusted LocalAccounts module is unavailable or ambiguous' }
      $trustedManifest = [IO.Path]::GetFullPath([string]$trustedManifests[0])
      $trustedModuleBase = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($trustedManifest)).TrimEnd('\')
      if (-not $trustedModuleBase.StartsWith($trustedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'trusted LocalAccounts module escaped its root'
      }
      $loaded = @(Import-Module -Name $trustedManifest -Force -PassThru -EA Stop)
      $exactModules = @($loaded | Where-Object {
        $_ -and [IO.Path]::GetFullPath([string]$_.ModuleBase).TrimEnd('\') -ieq $trustedModuleBase
      })
      if ($exactModules.Count -ne 1) { throw 'trusted LocalAccounts module identity is ambiguous' }
      $getLocalUser = $exactModules[0].ExportedCommands['Get-LocalUser']
      $removeLocalUser = $exactModules[0].ExportedCommands['Remove-LocalUser']
      if ($null -eq $getLocalUser -or $null -eq $removeLocalUser -or
          [IO.Path]::GetFullPath([string]$getLocalUser.Module.ModuleBase).TrimEnd('\') -ine $trustedModuleBase -or
          [IO.Path]::GetFullPath([string]$removeLocalUser.Module.ModuleBase).TrimEnd('\') -ine $trustedModuleBase) {
        throw 'trusted LocalAccounts commands are unavailable'
      }
      $expectedSid = [System.Security.Principal.SecurityIdentifier]::new($expectedSidText)
      $before = @(& $getLocalUser -EA Stop)
      $sidMatches = @($before | Where-Object { $_.SID -and [string]$_.SID.Value -ieq $expectedSidText })
      $nameMatches = @($before | Where-Object { [string]$_.Name -ieq $expectedName })
      if ($sidMatches.Count -eq 1 -and [string]$sidMatches[0].Name -ieq $expectedName -and
          $nameMatches.Count -eq 1 -and [string]$nameMatches[0].SID.Value -ieq $expectedSidText) {
        $pre = 'exact'
        try {
          & $removeLocalUser -SID $expectedSid -Confirm:$false -EA Stop
          $deletion = 'success'
        } catch {
          $deletion = 'failed'
        }
      } else {
        $pre = 'mismatch'
      }
      try {
        $after = @(& $getLocalUser -EA Stop)
        $sidAfter = @($after | Where-Object { $_.SID -and [string]$_.SID.Value -ieq $expectedSidText })
        $nameAfter = @($after | Where-Object { [string]$_.Name -ieq $expectedName })
        $expectedSidPost = if ($sidAfter.Count -eq 0) { 'absent' } else { 'present' }
        if ($nameAfter.Count -eq 0) { $namePost = 'absent' }
        elseif ($nameAfter.Count -ne 1) { $namePost = 'ambiguous' }
        elseif ([string]$nameAfter[0].SID.Value -ieq $expectedSidText) { $namePost = 'expected' }
        else { $namePost = 'replacement' }
      } catch {
        $expectedSidPost = 'unknown'
        $namePost = 'unknown'
      }
    } catch {
      $pre = 'unknown'
    }
    [ordered]@{
      marker = 'FIXER_LOCAL_USER_DELETE_V1'
      pre = $pre
      deletion = $deletion
      expectedSidPost = $expectedSidPost
      namePost = $namePost
    } | ConvertTo-Json -Compress
    if ($pre -eq 'exact' -and $deletion -eq 'success' -and
        $expectedSidPost -eq 'absent' -and $namePost -eq 'absent') { exit 0 }
    exit 1
  `;
}

function exactSidLocalUserDeleteProved(result) {
  if (!result || result.timedOut || result.code !== 0 || typeof result.stdout !== 'string') return false;
  const text = result.stdout.trim();
  if (!text || text.includes('\n') || text.includes('\r')) return false;
  try {
    const receipt = JSON.parse(text);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !== 'deletion,expectedSidPost,marker,namePost,pre') return false;
    return receipt.marker === 'FIXER_LOCAL_USER_DELETE_V1' && receipt.pre === 'exact' &&
      receipt.deletion === 'success' && receipt.expectedSidPost === 'absent' && receipt.namePost === 'absent';
  } catch (_) {
    return false;
  }
}

// Disable one local account generation by its exact SID before destructive
// profile work. This keeps the SID as retry authority while preventing a new
// helper logon from reopening the profile during quarantine. The trusted OS
// module is bound by its versioned manifest and exported command identities.
const PS_EXACT_SID_LOCAL_USER_DISABLE_HELPER = String.raw`
function Disable-FixerLocalUserBySid {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$ExpectedSid,
    [Parameter(Mandatory=$true)][string]$ExpectedName,
    [string]$TrustedModuleRoot = ''
  )
  if ($ExpectedSid -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$' -or
      [string]::IsNullOrWhiteSpace($ExpectedName)) {
    throw 'invalid local account identity'
  }
  if ([string]::IsNullOrWhiteSpace($TrustedModuleRoot)) {
    $TrustedModuleRoot = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.LocalAccounts'
  }
  $trustedRoot = [IO.Path]::GetFullPath($TrustedModuleRoot).TrimEnd('\')
  $trustedPrefix = $trustedRoot + '\'
  $trustedManifests = @([IO.Directory]::GetFiles(
    $trustedRoot,
    'Microsoft.PowerShell.LocalAccounts.psd1',
    [IO.SearchOption]::AllDirectories) | Where-Object {
      [IO.Path]::GetFullPath([string]$_).StartsWith($trustedPrefix, [StringComparison]::OrdinalIgnoreCase)
    })
  if ($trustedManifests.Count -ne 1) { throw 'trusted LocalAccounts module is unavailable or ambiguous' }
  $trustedManifest = [IO.Path]::GetFullPath([string]$trustedManifests[0])
  $trustedModuleBase = [IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($trustedManifest)).TrimEnd('\')
  if (-not $trustedModuleBase.StartsWith($trustedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'trusted LocalAccounts module escaped its root'
  }
  $loaded = @(Import-Module -Name $trustedManifest -Force -PassThru -EA Stop)
  $exactModules = @($loaded | Where-Object {
    $_ -and [IO.Path]::GetFullPath([string]$_.ModuleBase).TrimEnd('\') -ieq $trustedModuleBase
  })
  if ($exactModules.Count -ne 1) { throw 'trusted LocalAccounts module identity is ambiguous' }
  $getLocalUser = $exactModules[0].ExportedCommands['Get-LocalUser']
  $disableLocalUser = $exactModules[0].ExportedCommands['Disable-LocalUser']
  if ($null -eq $getLocalUser -or $null -eq $disableLocalUser -or
      [IO.Path]::GetFullPath([string]$getLocalUser.Module.ModuleBase).TrimEnd('\') -ine $trustedModuleBase -or
      [IO.Path]::GetFullPath([string]$disableLocalUser.Module.ModuleBase).TrimEnd('\') -ine $trustedModuleBase) {
    throw 'trusted LocalAccounts commands are unavailable'
  }
  $before = @(& $getLocalUser -EA Stop)
  $sidMatches = @($before | Where-Object { $_.SID -and [string]$_.SID.Value -ieq $ExpectedSid })
  $nameMatches = @($before | Where-Object { [string]$_.Name -ieq $ExpectedName })
  if ($sidMatches.Count -ne 1 -or [string]$sidMatches[0].Name -ine $ExpectedName -or
      $nameMatches.Count -ne 1 -or [string]$nameMatches[0].SID.Value -ine $ExpectedSid) {
    throw 'exact local account identity changed before disable'
  }
  $enabledProperty = $sidMatches[0].PSObject.Properties['Enabled']
  if ($null -eq $enabledProperty -or $enabledProperty.Value -isnot [bool]) {
    throw 'exact local account enabled state is unavailable'
  }
  if ([bool]$enabledProperty.Value) {
    $expectedSidObject = [System.Security.Principal.SecurityIdentifier]::new($ExpectedSid)
    & $disableLocalUser -SID $expectedSidObject -Confirm:$false -EA Stop | Out-Null
  }
  $after = @(& $getLocalUser -EA Stop)
  $sidAfter = @($after | Where-Object { $_.SID -and [string]$_.SID.Value -ieq $ExpectedSid })
  $nameAfter = @($after | Where-Object { [string]$_.Name -ieq $ExpectedName })
  $enabledAfter = if ($sidAfter.Count -eq 1) { $sidAfter[0].PSObject.Properties['Enabled'] } else { $null }
  if ($sidAfter.Count -ne 1 -or $null -eq $enabledAfter -or $enabledAfter.Value -isnot [bool] -or
      [bool]$enabledAfter.Value -or
      [string]$sidAfter[0].Name -ine $ExpectedName -or $nameAfter.Count -ne 1 -or
      [string]$nameAfter[0].SID.Value -ine $ExpectedSid) {
    throw 'exact local account disable was not proved'
  }
}
`;

function exactSidLocalUserDisableScript(expectedSid, expectedName, trustedModuleRoot = '') {
  const sidLiteral = String(expectedSid || '').replace(/'/g, "''");
  const nameLiteral = String(expectedName || '').replace(/'/g, "''");
  const rootLiteral = String(trustedModuleRoot || '').replace(/'/g, "''");
  const rootArgument = rootLiteral ? ` -TrustedModuleRoot '${rootLiteral}'` : '';
  return String.raw`
    ${PS_EXACT_SID_LOCAL_USER_DISABLE_HELPER}
    $ErrorActionPreference = 'Stop'
    $pre = 'unknown'
    $disable = 'not-run'
    $expectedSidPost = 'unknown'
    $namePost = 'unknown'
    try {
      Disable-FixerLocalUserBySid -ExpectedSid '${sidLiteral}' -ExpectedName '${nameLiteral}'${rootArgument}
      $pre = 'exact'
      $disable = 'success'
      $expectedSidPost = 'disabled'
      $namePost = 'expected'
    } catch {}
    [ordered]@{
      marker = 'FIXER_LOCAL_USER_DISABLE_V1'
      pre = $pre
      disable = $disable
      expectedSidPost = $expectedSidPost
      namePost = $namePost
    } | ConvertTo-Json -Compress
    if ($pre -eq 'exact' -and $disable -eq 'success' -and
        $expectedSidPost -eq 'disabled' -and $namePost -eq 'expected') { exit 0 }
    exit 1
  `;
}

function exactSidLocalUserDisableProved(result) {
  if (!result || result.timedOut || result.code !== 0 || typeof result.stdout !== 'string') return false;
  const text = result.stdout.trim();
  if (!text || text.includes('\n') || text.includes('\r')) return false;
  try {
    const receipt = JSON.parse(text);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !== 'disable,expectedSidPost,marker,namePost,pre') return false;
    return receipt.marker === 'FIXER_LOCAL_USER_DISABLE_V1' && receipt.pre === 'exact' &&
      receipt.disable === 'success' && receipt.expectedSidPost === 'disabled' && receipt.namePost === 'expected';
  } catch (_) {
    return false;
  }
}

// Retain a native Process handle before the second owner-SID check. Windows
// cannot reuse that process identity while the handle is held, so Kill never
// acts on a later process that inherited the same numeric PID.
const PS_EXACT_SID_PROCESS_STOP_HELPER = String.raw`
function Stop-FixerOwnedProcessBySid {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Candidate,
    [Parameter(Mandatory=$true)][string]$ExpectedSid
  )
  if ($ExpectedSid -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') {
    throw 'invalid process owner SID'
  }
  $processId = [int]$Candidate.ProcessId
  if ($processId -le 0 -or $null -eq $Candidate.CreationDate) {
    throw 'process identity is incomplete'
  }
  $candidateCreation = ([DateTime]$Candidate.CreationDate).ToUniversalTime().Ticks
  $heldProcess = $null
  try {
    try { $heldProcess = [System.Diagnostics.Process]::GetProcessById($processId) }
    catch [System.ArgumentException] { return 'GONE' }
    $heldHandle = $heldProcess.SafeHandle
    if ($null -eq $heldHandle -or $heldHandle.IsInvalid -or $heldHandle.IsClosed) {
      throw 'process handle custody is unavailable'
    }
    $refreshed = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $processId) -EA Stop)
    if ($refreshed.Count -eq 0) { return 'GONE' }
    if ($refreshed.Count -ne 1 -or [int]$refreshed[0].ProcessId -ne $processId -or
        $null -eq $refreshed[0].CreationDate -or
        ([DateTime]$refreshed[0].CreationDate).ToUniversalTime().Ticks -ne $candidateCreation) {
      throw 'process identity changed before termination'
    }
    $owner = Invoke-CimMethod -InputObject $refreshed[0] -MethodName GetOwnerSid -EA Stop
    if (-not $owner -or $owner.ReturnValue -ne 0 -or -not $owner.Sid -or
        [string]$owner.Sid -ine $ExpectedSid) {
      throw 'process owner changed before termination'
    }
    if ($heldProcess.HasExited) { return 'GONE' }
    $heldProcess.Kill()
    if (-not $heldProcess.WaitForExit(2000)) {
      throw 'owned process termination was not proved'
    }
    return 'TERMINATED'
  } finally {
    if ($null -ne $heldProcess) { $heldProcess.Dispose() }
  }
}
`;

// After the exact local SID is disabled, the final pass is observation-only.
// Any residual or uncertain owner keeps cleanup blocked; no bare PID is ever
// targeted in this race-sensitive window.
function exactSidFinalDrainScript(expectedSid) {
  const sidLiteral = String(expectedSid || '').replace(/'/g, "''");
  return String.raw`
    $sid = '${sidLiteral}'
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    $state = 'UNKNOWN'
    try {
      do {
        $owned = [System.Collections.Generic.List[object]]::new()
        $unknown = $false
        foreach ($process in @(Get-CimInstance Win32_Process -EA Stop)) {
          $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -EA Stop
          if (-not $owner -or $owner.ReturnValue -ne 0 -or -not $owner.Sid) {
            $unknown = $true
            continue
          }
          if ([string]$owner.Sid -ieq $sid) { $owned.Add($process) }
        }
        if ($unknown) { throw 'process owner inventory is incomplete' }
        if ($owned.Count -eq 0) { $state = 'CLEAR'; break }
        Start-Sleep -Milliseconds 250
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($state -ne 'CLEAR') { $state = 'RESIDUAL' }
    } catch { $state = 'UNKNOWN' }
    Write-Output ('FIXER_HELPER_FINAL_DRAIN_V1=' + $state)
    if ($state -eq 'CLEAR') { exit 0 }
    exit 1
  `;
}

// ============================================================
// Check whether the exact local-account SID is in Administrators
// (S-1-5-32-544). Returns an explicit verification state; a same-name domain
// principal must never stand in for the helper account.
// user1 must NOT be a member (SEC-A6) — the fix flow uses this to detect
// a legacy admin user1 and to confirm the membership removal took.
// ============================================================
async function verifyAdminMembership(expectedSid) {
  const sidLiteral = String(expectedSid || '').replace(/'/g, "''");
  const r = await runPSCapture(`
    $userSid = '${sidLiteral}'
    $result = 'UNKNOWN'
    $method = 'none'
    try {
      $members = Get-LocalGroupMember -SID 'S-1-5-32-544' -EA Stop
      $method = 'Get-LocalGroupMember'
      $result = 'NO'
      foreach ($m in $members) {
        $mSid = $null
        try { $mSid = $m.SID.Value } catch {}
        if ($mSid -and $userSid -and ($mSid -eq $userSid)) { $result = 'YES'; break }
      }
    } catch {
      $method = 'failed'
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
  const verified = !r.timedOut && r.code === 0 && method === 'Get-LocalGroupMember' &&
    (result === 'YES' || result === 'NO') && !!sid &&
    sid.toLowerCase() === String(expectedSid || '').toLowerCase();
  return { inGroup: verified && result === 'YES', method, sid, verified };
}

// Resolve a local directory to an OS object identity, not only path text.
// ProfileList paths are untrusted registry data. The helper rejects UNC and
// device namespaces, opens every component without following reparse points,
// and returns the final handle path plus {volume serial, 128-bit file ID}.
// Empty output means a genuinely absent path. Every other lookup failure is
// terminating so cleanup never falls back to a name or lexical alias.
const PS_PROFILE_PATH_IDENTITY_HELPER = String.raw`
if (-not ('FixerProfileIdentityV1' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class FixerProfileIdentityV1 {
  private const uint FILE_SHARE_ALL = 0x00000007;
  private const uint FILE_SHARE_READ_WRITE = 0x00000003;
  private const uint DELETE_ACCESS = 0x00010000;
  private const uint FILE_READ_ATTRIBUTES = 0x00000080;
  private const uint OPEN_EXISTING = 3;
  private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
  private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
  private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
  private const int FILE_ID_INFO_CLASS = 18;
  private const int FILE_RENAME_INFO_CLASS = 3;
  private const int FILE_DISPOSITION_INFO_CLASS = 4;

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ATTRIBUTE_TAG_INFO {
    public uint FileAttributes;
    public uint ReparseTag;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_128 {
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
    public byte[] Identifier;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_ID_INFO {
    public ulong VolumeSerialNumber;
    public FILE_ID_128 FileId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
    uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

  [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
  private static extern bool GetFileAttributeTagInfo(
    SafeFileHandle handle, int infoClass, out FILE_ATTRIBUTE_TAG_INFO info, uint size);

  [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
  private static extern bool GetFileIdInfo(
    SafeFileHandle handle, int infoClass, out FILE_ID_INFO info, uint size);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern uint GetFinalPathNameByHandleW(
    SafeFileHandle handle, StringBuilder path, uint size, uint flags);

  [DllImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(
    SafeFileHandle handle, int infoClass, IntPtr info, uint size);

  private static SafeFileHandle OpenNoFollow(string path, out int error) {
    SafeFileHandle handle = CreateFileW(path, 0, FILE_SHARE_ALL, IntPtr.Zero,
      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    error = handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    return handle;
  }

  private static string DescribeDirectoryHandle(SafeFileHandle handle, bool includeResolvedPath) {
    FILE_ATTRIBUTE_TAG_INFO tag;
    if (!GetFileAttributeTagInfo(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, out tag,
        (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
      throw new IOException("profile path contains a reparse point");
    }
    if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
      throw new IOException("profile path is not a directory");
    }
    FILE_ID_INFO id;
    if (!GetFileIdInfo(handle, FILE_ID_INFO_CLASS, out id,
        (uint)Marshal.SizeOf(typeof(FILE_ID_INFO)))) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    if (id.FileId.Identifier == null || id.FileId.Identifier.Length != 16) {
      throw new IOException("profile file identity is incomplete");
    }
    string identity = id.VolumeSerialNumber.ToString("X16") + ":" +
      BitConverter.ToString(id.FileId.Identifier).Replace("-", String.Empty);
    if (!includeResolvedPath) return identity;
    var finalPath = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, finalPath, (uint)finalPath.Capacity, 0);
    if (length == 0 || length >= finalPath.Capacity) {
      throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    string resolved = finalPath.ToString();
    if (resolved.StartsWith(@"\\?\", StringComparison.Ordinal)) resolved = resolved.Substring(4);
    return identity + "|" + resolved;
  }

  private static string DescribeDirectoryHandle(SafeFileHandle handle) {
    return DescribeDirectoryHandle(handle, true);
  }

  private static void RequireIdentity(string actualIdentity, string expectedIdentity) {
    if (!String.Equals(actualIdentity, expectedIdentity, StringComparison.Ordinal)) {
      throw new IOException("receipt-identity");
    }
  }

  private static void RequireReceipt(string receipt, string expectedIdentity, string expectedResolvedPath) {
    string[] parts = receipt.Split(new char[] { '|' }, 2);
    if (parts.Length != 2) throw new IOException("receipt-format");
    if (!String.Equals(parts[0], expectedIdentity, StringComparison.Ordinal)) {
      throw new IOException("receipt-identity");
    }
    if (!String.Equals(Path.GetFullPath(parts[1]), Path.GetFullPath(expectedResolvedPath),
        StringComparison.OrdinalIgnoreCase)) throw new IOException("receipt-path");
  }

  private static void RequireQuarantinedState(
      SafeFileHandle heldHandle, string expectedIdentity, string originalPath,
      string plannedQuarantinePath) {
    RequireIdentity(DescribeDirectoryHandle(heldHandle, false), expectedIdentity);
    string destinationReceipt = Inspect(plannedQuarantinePath);
    if (String.IsNullOrEmpty(destinationReceipt)) {
      throw new IOException("receipt-destination-absent");
    }
    RequireReceipt(destinationReceipt, expectedIdentity, plannedQuarantinePath);
    if (!String.IsNullOrEmpty(Inspect(originalPath))) {
      throw new IOException("receipt-original-present");
    }
  }

  private static bool DirectoryIsEmpty(string path) {
    using (IEnumerator<string> entries = Directory.EnumerateFileSystemEntries(path).GetEnumerator()) {
      return !entries.MoveNext();
    }
  }

  private static void RenameByHandle(SafeFileHandle handle, string destination) {
    string fullDestination = Path.GetFullPath(destination);
    string parent = Path.GetDirectoryName(fullDestination);
    string leaf = Path.GetFileName(fullDestination);
    if (String.IsNullOrEmpty(parent) || String.IsNullOrEmpty(leaf) ||
        leaf.IndexOf(Path.DirectorySeparatorChar) >= 0 ||
        leaf.IndexOf(Path.AltDirectorySeparatorChar) >= 0 ||
        !String.Equals(Path.GetFullPath(Path.Combine(parent, leaf)), fullDestination,
          StringComparison.OrdinalIgnoreCase)) {
      throw new IOException("profile quarantine destination is invalid");
    }
    byte[] name = Encoding.Unicode.GetBytes(fullDestination);
    int rootOffset = IntPtr.Size == 8 ? 8 : 4;
    int lengthOffset = rootOffset + IntPtr.Size;
    int nameOffset = lengthOffset + 4;
    int structureSize = IntPtr.Size == 8 ? 24 : 16;
    int bufferSize = structureSize + name.Length;
    IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
    try {
      for (int index = 0; index < bufferSize; index++) Marshal.WriteByte(buffer, index, 0);
      Marshal.WriteIntPtr(buffer, rootOffset, IntPtr.Zero);
      Marshal.WriteInt32(buffer, lengthOffset, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(buffer, nameOffset), name.Length);
      if (!SetFileInformationByHandle(handle, FILE_RENAME_INFO_CLASS, buffer, (uint)bufferSize)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  private static void MarkDeleteByHandle(SafeFileHandle handle) {
    IntPtr buffer = Marshal.AllocHGlobal(1);
    try {
      Marshal.WriteByte(buffer, 0, 1);
      if (!SetFileInformationByHandle(handle, FILE_DISPOSITION_INFO_CLASS, buffer, 1)) {
        throw new Win32Exception(Marshal.GetLastWin32Error());
      }
    } finally {
      Marshal.FreeHGlobal(buffer);
    }
  }

  public sealed class QuarantineLease : IDisposable {
    private SafeFileHandle handle;
    private readonly string originalPath;
    private readonly string expectedIdentity;
    private readonly string plannedQuarantinePath;
    private string quarantinePath;
    private bool deleteProved;

    internal QuarantineLease(SafeFileHandle heldHandle, string resolvedPath, string identity) {
      handle = heldHandle;
      originalPath = Path.GetFullPath(resolvedPath);
      expectedIdentity = identity;
      string parent = Path.GetDirectoryName(originalPath);
      if (String.IsNullOrEmpty(parent)) throw new IOException("profile directory has no parent");
      plannedQuarantinePath = Path.Combine(
        parent, ".1132-fixer-quarantine-" + Guid.NewGuid().ToString("N"));
      quarantinePath = String.Empty;
      deleteProved = false;
    }

    public string OriginalPath { get { return originalPath; } }
    public string PlannedQuarantinePath { get { return plannedQuarantinePath; } }
    public string QuarantinePath { get { return quarantinePath; } }
    public bool DeleteProved { get { return deleteProved; } }

    public string Quarantine() {
      if (handle == null || handle.IsInvalid || handle.IsClosed || !String.IsNullOrEmpty(quarantinePath)) {
        throw new ObjectDisposedException("profile quarantine lease");
      }
      RequireReceipt(DescribeDirectoryHandle(handle), expectedIdentity, originalPath);
      string destination = plannedQuarantinePath;
      if (Directory.Exists(destination) || File.Exists(destination)) throw new IOException("profile quarantine collision");
      RenameByHandle(handle, destination);
      quarantinePath = destination;
      RequireQuarantinedState(handle, expectedIdentity, originalPath, plannedQuarantinePath);
      return quarantinePath;
    }

    public void DeleteEmpty() {
      if (handle == null || handle.IsInvalid || handle.IsClosed || String.IsNullOrEmpty(quarantinePath)) {
        throw new ObjectDisposedException("profile quarantine lease");
      }
      RequireQuarantinedState(handle, expectedIdentity, originalPath, plannedQuarantinePath);
      if (!DirectoryIsEmpty(quarantinePath)) throw new IOException("quarantined profile directory is not empty");
      RequireQuarantinedState(handle, expectedIdentity, originalPath, plannedQuarantinePath);
      MarkDeleteByHandle(handle);
      handle.Dispose();
      handle = null;
      if (!String.IsNullOrEmpty(Inspect(quarantinePath)) ||
          !String.IsNullOrEmpty(Inspect(originalPath))) {
        throw new IOException("quarantined profile deletion was not proved");
      }
      deleteProved = true;
    }

    public void Dispose() {
      if (handle != null) {
        handle.Dispose();
        handle = null;
      }
    }
  }

  public static QuarantineLease AcquireQuarantineLease(
      string path, string expectedIdentity, string expectedResolvedPath) {
    string full = Path.GetFullPath(path);
    string resolvedFull = Path.GetFullPath(expectedResolvedPath);
    RequireReceipt(Inspect(full), expectedIdentity, resolvedFull);
    int error;
    SafeFileHandle held = CreateFileW(full, DELETE_ACCESS | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ_WRITE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    error = held.IsInvalid ? Marshal.GetLastWin32Error() : 0;
    if (held.IsInvalid) {
      held.Dispose();
      throw new Win32Exception(error);
    }
    try {
      RequireReceipt(DescribeDirectoryHandle(held), expectedIdentity, resolvedFull);
      return new QuarantineLease(held, resolvedFull, expectedIdentity);
    } catch {
      held.Dispose();
      throw;
    }
  }

  public static string Inspect(string path) {
    string full = Path.GetFullPath(path);
    string root = Path.GetPathRoot(full);
    if (String.IsNullOrEmpty(root)) throw new IOException("profile path has no local root");
    var components = new List<string>();
    components.Add(root);
    string current = root;
    string relative = full.Substring(root.Length);
    foreach (string part in relative.Split(new char[] { '\\' }, StringSplitOptions.RemoveEmptyEntries)) {
      current = Path.Combine(current, part);
      components.Add(current);
    }

    for (int index = 0; index < components.Count; index++) {
      int error;
      using (SafeFileHandle handle = OpenNoFollow(components[index], out error)) {
        if (handle.IsInvalid) {
          if (error == 2 || error == 3) return String.Empty;
          throw new Win32Exception(error);
        }
        FILE_ATTRIBUTE_TAG_INFO tag;
        if (!GetFileAttributeTagInfo(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, out tag,
            (uint)Marshal.SizeOf(typeof(FILE_ATTRIBUTE_TAG_INFO)))) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
          throw new IOException("profile path contains a reparse point");
        }
        if (index != components.Count - 1) continue;
        if ((tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0) {
          throw new IOException("profile path is not a directory");
        }

        return DescribeDirectoryHandle(handle);
      }
    }
    return String.Empty;
  }
}
'@ -ErrorAction Stop
}

function Get-FixerProfilePathIdentity {
  [CmdletBinding()]
  param([Parameter(Mandatory=$true)][string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -ne $Path.Trim() -or
      $Path.Contains('/') -or $Path.IndexOfAny([char[]](0..31)) -ge 0 -or
      $Path -notmatch '^[A-Za-z]:\\') {
    throw 'unsafe profile path namespace'
  }
  $candidate = $Path
  while ($candidate.Length -gt 3 -and $candidate.EndsWith('\')) {
    $candidate = $candidate.Substring(0, $candidate.Length - 1)
  }
  $full = [IO.Path]::GetFullPath($candidate)
  if ($full -ine $candidate) { throw 'profile path is not canonical' }
  $native = [FixerProfileIdentityV1]::Inspect($full)
  if (-not $native) {
    return [pscustomobject]@{
      pathExists = $false
      isReparsePoint = $false
      resolvedPath = $full
      stableIdentity = ''
    }
  }
  $parts = @($native -split '\|', 2)
  if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[0-9A-F]{16}:[0-9A-F]{32}$' -or
      $parts[1] -notmatch '^[A-Za-z]:\\') {
    throw 'profile identity receipt is malformed'
  }
  $resolved = [IO.Path]::GetFullPath([string]$parts[1])
  while ($resolved.Length -gt 3 -and $resolved.EndsWith('\')) {
    $resolved = $resolved.Substring(0, $resolved.Length - 1)
  }
  return [pscustomobject]@{
    pathExists = $true
    isReparsePoint = $false
    resolvedPath = $resolved
    stableIdentity = [string]$parts[0]
  }
}

function Assert-FixerProfilePathIdentity {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)][string]$Path,
    [Parameter(Mandatory=$true)][bool]$ExpectedExists,
    [string]$ExpectedIdentity = '',
    [string]$ExpectedResolvedPath = ''
  )
  $current = Get-FixerProfilePathIdentity -Path $Path
  if ($ExpectedExists) {
    if (-not $current.pathExists) {
      throw 'previously present profile folder disappeared after validation'
    }
    if (-not $ExpectedIdentity -or $current.stableIdentity -cne $ExpectedIdentity -or
        -not $ExpectedResolvedPath -or $current.resolvedPath -ine $ExpectedResolvedPath) {
      throw 'profile directory identity changed after validation'
    }
  } elseif ($current.pathExists) {
    throw 'previously absent profile folder appeared after validation'
  }
  return $current
}
`;

// A durable recovery receipt is written to an exact-SID ProfileList key
// before a handle-bound rename. On restart, only the path that still owns the
// recorded file identity is authoritative. Missing, malformed, or ambiguous
// receipts fail closed.
const PS_PROFILE_RECOVERY_HELPER = String.raw`
function Resolve-FixerProfileInventoryPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory=$true)]$Item,
    [Parameter(Mandatory=$true)][string]$KeyName,
    [Parameter(Mandatory=$true)][string]$ExpectedSid
  )
  $pathProperty = $Item.PSObject.Properties['ProfileImagePath']
  $pathPresent = [bool]($null -ne $pathProperty)
  $declaredPath = if ($pathPresent) {
    [Environment]::ExpandEnvironmentVariables([string]$pathProperty.Value)
  } else { '' }
  $recoveryProperty = $Item.PSObject.Properties['FixerProfileQuarantineV1']
  if ($null -eq $recoveryProperty) {
    return [pscustomobject]@{
      profileImagePathPresent = $pathPresent
      profileImagePath = $declaredPath
      recoveryPresent = $false
      recoveryCompleted = $false
    }
  }
  if ([string]::IsNullOrWhiteSpace([string]$recoveryProperty.Value)) {
    throw 'profile quarantine receipt is malformed'
  }
  if (-not $pathPresent -or [string]::IsNullOrWhiteSpace($declaredPath) -or
      ($KeyName -ine $ExpectedSid -and $KeyName -ine ($ExpectedSid + '.bak'))) {
    throw 'profile quarantine receipt has no exact-SID path authority'
  }
  $receipt = ConvertFrom-Json -InputObject ([string]$recoveryProperty.Value) -EA Stop
  $receiptNames = @($receipt.PSObject.Properties.Name | Sort-Object)
  if (($receiptNames -join ',') -cne 'marker,originalPath,phase,quarantinePath,stableIdentity' -or
      [string]$receipt.marker -cne 'FIXER_PROFILE_QUARANTINE_V1' -or
      ([string]$receipt.phase -cne 'moving' -and [string]$receipt.phase -cne 'deleting') -or
      ([string]$receipt.originalPath -ine $declaredPath -and
       [string]$receipt.quarantinePath -ine $declaredPath) -or
      [string]$receipt.stableIdentity -notmatch '^[0-9A-F]{16}:[0-9A-F]{32}$') {
    throw 'profile quarantine receipt is malformed'
  }
  $originalPath = [IO.Path]::GetFullPath([string]$receipt.originalPath).TrimEnd('\')
  $quarantinePath = [IO.Path]::GetFullPath([string]$receipt.quarantinePath).TrimEnd('\')
  if ([IO.Path]::GetDirectoryName($quarantinePath) -ine [IO.Path]::GetDirectoryName($originalPath) -or
      [IO.Path]::GetFileName($quarantinePath) -notmatch '^\.1132-fixer-quarantine-[0-9a-f]{32}$') {
    throw 'profile quarantine receipt path is unsafe'
  }
  $originalIdentity = Get-FixerProfilePathIdentity -Path $originalPath
  $quarantineIdentity = Get-FixerProfilePathIdentity -Path $quarantinePath
  $originalMatch = [bool]($originalIdentity.pathExists -and
    [string]$originalIdentity.stableIdentity -ceq [string]$receipt.stableIdentity)
  $quarantineMatch = [bool]($quarantineIdentity.pathExists -and
    [string]$quarantineIdentity.stableIdentity -ceq [string]$receipt.stableIdentity)
  if ($originalMatch -and $quarantineMatch) {
    throw 'profile quarantine identity is missing or ambiguous'
  }
  if (-not $originalMatch -and -not $quarantineMatch) {
    if ([string]$receipt.phase -ceq 'deleting' -and
        $declaredPath -ieq $quarantinePath -and
        -not $quarantineIdentity.pathExists) {
      return [pscustomobject]@{
        profileImagePathPresent = $true
        profileImagePath = $quarantinePath
        recoveryPresent = $true
        recoveryCompleted = $true
      }
    }
    throw 'profile quarantine identity is missing or ambiguous'
  }
  return [pscustomobject]@{
    profileImagePathPresent = $true
    profileImagePath = if ($quarantineMatch) { $quarantinePath } else { $originalPath }
    recoveryPresent = $true
    recoveryCompleted = $false
  }
}
`;

// Select only ProfileList records that are bound to one exact local-account
// SID. Folder names are never identity evidence. The same selector gates old
// profile cleanup and resolution of the newly-created helper profile.
function selectSidBoundProfileEntries(entries, expectedSid, purpose = 'resolve') {
  const sid = String(expectedSid || '');
  const empty = reason => ({ ok: false, reason, entries: [], keys: [], paths: [], entry: null });
  if (purpose !== 'resolve' && purpose !== 'cleanup') return empty('invalid_purpose');
  if (!sid) {
    return purpose === 'cleanup'
      ? { ok: true, reason: 'no_trusted_sid', entries: [], keys: [], paths: [], entry: null }
      : empty('missing_sid');
  }
  if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/i.test(sid) || !Array.isArray(entries)) {
    return empty('invalid_inventory');
  }

  const trustedProfilePath = (value) => {
    if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f]/.test(value) || value.includes('/')) return '';
    const withoutTrailingSlash = value.replace(/\\+$/, '');
    if (!withoutTrailingSlash || /^(?:\\\\[?.]\\|\\\\)/.test(withoutTrailingSlash)) return '';
    const normalized = path.win32.normalize(withoutTrailingSlash);
    if (normalized.toLowerCase() !== withoutTrailingSlash.toLowerCase() ||
        path.win32.dirname(normalized).toLowerCase() !== 'c:\\users') return '';
    const leaf = path.win32.basename(normalized);
    const leafLower = leaf.toLowerCase();
    const protectedLeaves = new Set(['public', 'default', 'default user', 'all users', 'desktop.ini']);
    if (!leaf || leaf === '.' || leaf === '..' || /[. ]$/.test(leaf) || /[:*?"<>|]/.test(leaf) ||
        protectedLeaves.has(leafLower) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(leaf)) return '';
    return normalized;
  };
  const comparisonPath = (value) => {
    if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || /^(?:\\\\[?.]\\|\\\\)/.test(value)) return '';
    try {
      const normalized = path.win32.normalize(value.replace(/\//g, '\\')).replace(/\\+$/, '');
      return path.win32.isAbsolute(normalized) ? normalized.toLowerCase() : '';
    } catch (_) {
      return '';
    }
  };

  const sidLower = sid.toLowerCase();
  const records = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || typeof raw.keyName !== 'string' ||
        typeof raw.profileImagePath !== 'string' || typeof raw.resolvedPath !== 'string' ||
        typeof raw.stableIdentity !== 'string' || typeof raw.pathExists !== 'boolean' ||
        typeof raw.isReparsePoint !== 'boolean' || typeof raw.hasNtUserDat !== 'boolean' ||
        typeof raw.readable !== 'boolean' || typeof raw.profileImagePathPresent !== 'boolean') {
      return empty('invalid_inventory_shape');
    }
    if (raw.readable !== true) {
      return empty('unreadable_inventory');
    }
    const keyName = raw.keyName;
    const keyLower = keyName.toLowerCase();
    const target = keyLower === sidLower || keyLower === `${sidLower}.bak`;
    const rawPath = typeof raw.profileImagePath === 'string' ? raw.profileImagePath : '';
    const rawComparisonPath = comparisonPath(rawPath);
    const resolvedPath = typeof raw.resolvedPath === 'string' ? raw.resolvedPath : '';
    const resolvedComparisonPath = comparisonPath(resolvedPath);
    const stableIdentity = typeof raw.stableIdentity === 'string' ? raw.stableIdentity : '';
    const profilePath = target && rawPath ? trustedProfilePath(rawPath) : '';
    if (target && (!raw.profileImagePathPresent || !rawPath)) return empty('missing_target_profile_path');
    if (target && !profilePath) return empty('unsafe_target_path');
    if (!rawPath && (raw.pathExists !== false || raw.isReparsePoint !== false ||
        resolvedPath || stableIdentity)) {
      return empty('invalid_empty_path_identity');
    }
    if (rawPath && (!rawComparisonPath || typeof raw.pathExists !== 'boolean' ||
        typeof raw.isReparsePoint !== 'boolean' || raw.isReparsePoint === true ||
        !resolvedComparisonPath)) {
      return empty(target ? 'unsafe_target_directory' : 'unsafe_inventory_directory');
    }
    if (target && rawPath && resolvedComparisonPath !== profilePath.toLowerCase()) {
      return empty('unsafe_target_identity');
    }
    if (rawPath && raw.pathExists === true &&
        !/^[0-9A-F]{16}:[0-9A-F]{32}$/i.test(stableIdentity)) {
      return empty(target ? 'unsafe_target_identity' : 'unresolved_inventory_identity');
    }
    if (rawPath && raw.pathExists === false &&
        (stableIdentity || resolvedComparisonPath !== rawComparisonPath)) {
      return empty('invalid_absent_identity');
    }
    records.push({
      keyName,
      keyLower,
      target,
      profilePath,
      comparisonPath: rawComparisonPath,
      resolvedComparisonPath,
      stableIdentity,
      hasNtUserDat: raw.hasNtUserDat === true,
      pathExists: raw.pathExists === true
    });
  }

  const live = records.filter(record => record.keyLower === sidLower);
  const backup = records.filter(record => record.keyLower === `${sidLower}.bak`);
  if (live.length > 1 || backup.length > 1) return empty('ambiguous_keys');
  if (purpose === 'resolve' && (live.length !== 1 || backup.length !== 0)) return empty('missing_or_ambiguous_live_key');

  const targets = purpose === 'resolve' ? live : [...live, ...backup];
  if (purpose === 'resolve' && (!targets[0].profilePath || !targets[0].pathExists || !targets[0].hasNtUserDat)) {
    return empty('profile_not_ready');
  }
  const targetPaths = [...new Set(targets.map(record => record.profilePath).filter(Boolean))];
  const targetIdentities = new Set(targets
    .filter(record => record.pathExists && record.stableIdentity)
    .map(record => record.stableIdentity.toLowerCase()));
  for (const targetPath of targetPaths) {
    const shared = records.some(record => !record.target && record.comparisonPath === targetPath.toLowerCase());
    if (shared) return empty('path_owned_by_unrelated_sid');
  }
  if (records.some(record => !record.target && record.pathExists &&
      targetIdentities.has(record.stableIdentity.toLowerCase()))) {
    return empty('identity_owned_by_unrelated_sid');
  }
  return {
    ok: true,
    reason: '',
    entries: targets.map(record => ({
      keyName: record.keyName,
      profileImagePath: record.profilePath,
      profileImagePathPresent: true,
      pathExists: record.pathExists,
      resolvedPath: record.resolvedComparisonPath,
      stableIdentity: record.stableIdentity
    })),
    keys: targets.map(record => record.keyName),
    paths: targetPaths,
    entry: purpose === 'resolve' ? { keyName: live[0].keyName, profileImagePath: live[0].profilePath } : null
  };
}

// Resolve the recreated helper profile only through the exact helper SID's
// live ProfileList key. A .bak key, shared path, malformed path, missing hive,
// or any name-only folder is a closed failure.
async function resolveUserProfilePath(username, maxWaitSec, send, expectedSid = '') {
  const sid = String(expectedSid || '');
  const baseKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\';
  const checkedKeys = sid ? [baseKey + sid, baseKey + sid + '.bak'] : [];
  if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/i.test(sid)) {
    return { path: null, source: 'not_found', checkedPaths: [], checkedKeys, sid: '', reason: 'missing_sid' };
  }

  const sidLiteral = sid.replace(/'/g, "''");
  const script = `
    ${PS_PROFILE_PATH_IDENTITY_HELPER}
    ${PS_PROFILE_RECOVERY_HELPER}
    $ErrorActionPreference = 'Stop'
    $sid = '${sidLiteral}'
    $base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList'
    $liveKey = Join-Path $base $sid
    $bakKey = $liveKey + '.bak'
    $deadline = [DateTime]::UtcNow.AddSeconds(${Math.max(1, maxWaitSec)})
    try {
      do {
        if (Test-Path -LiteralPath $bakKey) { break }
        if (Test-Path -LiteralPath $liveKey) {
          $item = Get-ItemProperty -LiteralPath $liveKey -EA Stop
          $effectivePath = Resolve-FixerProfileInventoryPath -Item $item -KeyName $sid -ExpectedSid $sid
          $candidate = [string]$effectivePath.profileImagePath
          if ($candidate) {
            $candidateIdentity = Get-FixerProfilePathIdentity -Path $candidate
            if ($candidateIdentity.pathExists -and
                [System.IO.File]::Exists((Join-Path $candidateIdentity.resolvedPath 'NTUSER.DAT'))) { break }
          }
        }
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)

      $entries = @(Get-ChildItem -LiteralPath $base -EA Stop | ForEach-Object {
        $item = Get-ItemProperty -LiteralPath $_.PSPath -EA Stop
        $effectivePath = Resolve-FixerProfileInventoryPath -Item $item -KeyName ([string]$_.PSChildName) -ExpectedSid $sid
        $profilePathPresent = [bool]$effectivePath.profileImagePathPresent
        $profilePath = [string]$effectivePath.profileImagePath
        $pathIdentity = [pscustomobject]@{
          pathExists = $false
          isReparsePoint = $false
          resolvedPath = ''
          stableIdentity = ''
        }
        if ($profilePath) {
          $pathIdentity = Get-FixerProfilePathIdentity -Path $profilePath
        }
        [pscustomobject]@{
          keyName = [string]$_.PSChildName
          profileImagePath = $profilePath
          profileImagePathPresent = $profilePathPresent
          hasNtUserDat = [bool]($pathIdentity.pathExists -and
            [System.IO.File]::Exists((Join-Path $pathIdentity.resolvedPath 'NTUSER.DAT')))
          pathExists = [bool]$pathIdentity.pathExists
          isReparsePoint = [bool]$pathIdentity.isReparsePoint
          resolvedPath = [string]$pathIdentity.resolvedPath
          stableIdentity = [string]$pathIdentity.stableIdentity
          readable = $true
        }
      })
      [pscustomobject]@{
        marker = 'FIXER_PROFILELIST_V1'
        sid = $sid
        entries = @($entries)
      } | ConvertTo-Json -Compress -Depth 4
    } catch { exit 1 }
  `;

  const r = await runPSCapture(script, { timeoutMs: (maxWaitSec + 20) * 1000 });
  if (!r || r.timedOut || r.code !== 0) {
    return { path: null, source: 'not_found', checkedPaths: [], checkedKeys, sid, reason: 'inventory_failed' };
  }
  try {
    const payload = JSON.parse(String(r.stdout || '').trim());
    if (!payload || payload.marker !== 'FIXER_PROFILELIST_V1' ||
        String(payload.sid || '').toLowerCase() !== sid.toLowerCase()) throw new Error('invalid receipt');
    const entries = Array.isArray(payload.entries) ? payload.entries : (payload.entries ? [payload.entries] : []);
    const selection = selectSidBoundProfileEntries(entries, sid, 'resolve');
    const checkedPaths = entries
      .filter(entry => entry && typeof entry.keyName === 'string' &&
        (entry.keyName.toLowerCase() === sid.toLowerCase() || entry.keyName.toLowerCase() === `${sid.toLowerCase()}.bak`))
      .map(entry => String(entry.profileImagePath || '')).filter(Boolean);
    if (!selection.ok || !selection.entry) {
      return { path: null, source: 'not_found', checkedPaths, checkedKeys, sid, reason: selection.reason };
    }
    send(`  Resolved exact SID profile via registry: ${selection.entry.profileImagePath}`, 'out');
    return {
      path: selection.entry.profileImagePath,
      source: 'registry',
      checkedPaths,
      checkedKeys,
      sid
    };
  } catch (_) {
    return { path: null, source: 'not_found', checkedPaths: [], checkedKeys, sid, reason: 'invalid_inventory_receipt' };
  }
}

// ============================================================
// Re-read ProfileList immediately before every mutation. Exact-SID keys with
// a missing or blank ProfileImagePath are malformed evidence, not equivalent
// to an absent key.
// ============================================================
const PS_PROFILE_INVENTORY_GUARD = String.raw`
function Assert-FixerProfileInventory {
  param([object[]]$Plan, [string]$ExpectedSid, [string]$Base)
  $targets = [System.Collections.Generic.List[object]]::new()
  $plannedPaths = @($Plan | Where-Object { [bool]$_.pathExists } |
    ForEach-Object { [string]$_.profileImagePath } | Where-Object { $_ } | Sort-Object -Unique)
  $plannedIdentities = @($Plan | Where-Object { [bool]$_.pathExists } |
    ForEach-Object { [string]$_.stableIdentity } | Where-Object { $_ } | Sort-Object -Unique)
  foreach ($key in @(Get-ChildItem -LiteralPath $Base -EA Stop)) {
    $name = [string]$key.PSChildName
    $item = Get-ItemProperty -LiteralPath $key.PSPath -EA Stop
    $effectivePath = Resolve-FixerProfileInventoryPath -Item $item -KeyName $name -ExpectedSid $ExpectedSid
    $profilePathPresent = [bool]$effectivePath.profileImagePathPresent
    $profilePath = [string]$effectivePath.profileImagePath
    $pathIdentity = $null
    if ($profilePath) {
      $pathIdentity = Get-FixerProfilePathIdentity -Path $profilePath
    }
    $isTarget = $name -ieq $ExpectedSid -or $name -ieq ($ExpectedSid + '.bak')
    if ($isTarget) {
      if (-not $profilePathPresent -or [string]::IsNullOrWhiteSpace($profilePath)) {
        throw 'exact-SID ProfileImagePath is missing or blank'
      }
      $expected = @($Plan | Where-Object { [string]$_.keyName -ieq $name })
      if ($expected.Count -ne 1 -or -not [bool]$expected[0].profileImagePathPresent -or
          [string]$expected[0].profileImagePath -ine $profilePath) {
        throw 'profile identity changed after validation'
      }
      if ($profilePath) {
        $pathIdentity = Assert-FixerProfilePathIdentity -Path $profilePath -ExpectedExists ([bool]$expected[0].pathExists) -ExpectedIdentity ([string]$expected[0].stableIdentity) -ExpectedResolvedPath ([string]$expected[0].resolvedPath)
      } elseif ([bool]$expected[0].pathExists) {
        throw 'profile identity changed after validation'
      }
      $targets.Add($key)
      continue
    }
    if ($profilePath -and $pathIdentity.pathExists) {
      if ($plannedIdentities -contains [string]$pathIdentity.stableIdentity) {
        throw 'profile identity is shared by an unrelated SID'
      }
      $otherPath = [IO.Path]::GetFullPath($profilePath).TrimEnd('\')
      foreach ($plannedPath in $plannedPaths) {
        if ($otherPath -ieq $plannedPath) { throw 'profile path is shared by an unrelated SID' }
      }
    }
  }
  if ($targets.Count -ne $Plan.Count) { throw 'profile identity changed after validation' }
  return $targets.ToArray()
}
`;

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
        $rc = Start-Process -FilePath (Resolve-FixerTool 'reg.exe') -ArgumentList @('unload', ('HKU\\' + $Sid)) -Wait -WindowStyle Hidden -PassThru
        Write-Host ("    reg unload exit: " + $rc.ExitCode)
    }
}
# Hang guard: default profiles hide XP-compat junctions BELOW the top
# level too — Documents\\My Music, and AppData\\Local\\Application Data which
# points back at AppData\\Local (a real cycle). takeown /R, icacls /T and
# attrib /S all follow junctions, so recursing them across such a subtree
# loops until the step watchdog kills it — the "My Music cycling over and
# over" mid-fix hang (#31 #46 #67). This walk descends WITHOUT entering
# reparse points, deletes each reparse point it finds (the junction entry
# only — never its target), and reports whether the subtree ended
# junction-free. Only a junction-free subtree is safe for the recursive
# tools; otherwise the caller skips them and the junction-safe rd /s /q
# retry still runs.
function Remove-NestedReparsePoints {
    param([string]$Root)
    $clean = $true
    $stack = New-Object System.Collections.Generic.Stack[string]
    $stack.Push($Root)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        $kids = $null
        try { $kids = @(Get-ChildItem -LiteralPath $dir -Force -EA Stop) } catch {
            # Enumeration denied: open up THIS directory only (no /R, no /T —
            # nothing recursive that could chase a junction), then retry once.
            Start-Process -FilePath (Resolve-FixerTool 'takeown.exe') -ArgumentList @('/F',$dir,'/A','/D','Y') -Wait -WindowStyle Hidden | Out-Null
            Start-Process -FilePath (Resolve-FixerTool 'icacls.exe') -ArgumentList @($dir,'/grant','*S-1-5-32-544:F','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
            try { $kids = @(Get-ChildItem -LiteralPath $dir -Force -EA Stop) } catch {
                Write-Host ("    cannot enumerate " + $dir + " - leaving it for the rd retry")
                $clean = $false
                continue
            }
        }
        foreach ($it in $kids) {
            $isRp = $true # unreadable attributes: assume the worst, never descend
            try { $isRp = (($it.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) } catch {}
            if ($isRp) {
                try {
                    if ($it.PSIsContainer) { [System.IO.Directory]::Delete($it.FullName, $false) }
                    else { [System.IO.File]::Delete($it.FullName) }
                    Write-Host ("    removed nested reparse point: " + $it.FullName)
                } catch {
                    Write-Host ("    WARNING: nested reparse point stuck (" + $_.Exception.Message + "): " + $it.FullName)
                    $clean = $false
                }
            } elseif ($it.PSIsContainer) {
                $stack.Push($it.FullName)
            }
        }
    }
    return $clean
}
function Protect-FixerProfileQuarantineRoot {
    param([Parameter(Mandatory=$true)][string]$Path)
    # The custody handle makes this path name stable while ownership and the
    # root DACL are replaced. The helper SID gets no access to the private
    # quarantine; only SYSTEM and elevated Administrators retain full access.
    $takeown = Start-Process -FilePath (Resolve-FixerTool 'takeown.exe') -ArgumentList @('/F',$Path,'/A') -Wait -WindowStyle Hidden -PassThru
    if ($takeown.ExitCode -ne 0) { throw 'profile quarantine ownership could not be established' }
    $privateAcl = [System.Security.AccessControl.DirectorySecurity]::new()
    $privateAcl.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    [System.IO.Directory]::SetAccessControl($Path, $privateAcl)
    $receipt = [System.IO.Directory]::GetAccessControl(
      $Path, [System.Security.AccessControl.AccessControlSections]::Access -bor
        [System.Security.AccessControl.AccessControlSections]::Owner)
    $owner = $receipt.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($null -eq $owner -or [string]$owner.Value -cne 'S-1-5-32-544') {
        throw 'profile quarantine owner is not Administrators'
    }
    if (-not $receipt.AreAccessRulesProtected) { throw 'profile quarantine DACL is not protected' }
    $rules = @($receipt.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))
    $expected = @('S-1-5-18','S-1-5-32-544')
    if ($rules.Count -ne 2) { throw 'profile quarantine DACL is not private' }
    foreach ($rule in $rules) {
        if ($expected -notcontains [string]$rule.IdentityReference.Value -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne
              [System.Security.AccessControl.FileSystemRights]::FullControl) {
            throw 'profile quarantine DACL is not private'
        }
    }
    foreach ($sid in $expected) {
        if (-not @($rules | Where-Object { [string]$_.IdentityReference.Value -eq $sid })) {
            throw 'profile quarantine DACL receipt is incomplete'
        }
    }
}
function Remove-ProfileFolder {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [string]$Sid = '',
        [Parameter(Mandatory=$true)][string]$ExpectedIdentity,
        [Parameter(Mandatory=$true)][string]$ExpectedResolvedPath,
        [Parameter(Mandatory=$true)]$Lease
    )
    $ErrorActionPreference = 'Continue'
    if (-not $Lease.QuarantinePath -or $Lease.QuarantinePath -ine $Path) { throw 'profile directory lease path mismatch' }
    $identity = Assert-FixerProfilePathIdentity -Path $Path -ExpectedExists $true -ExpectedIdentity $ExpectedIdentity -ExpectedResolvedPath $ExpectedResolvedPath
    if (-not $identity.pathExists) { throw 'profile directory custody was lost' }
    Write-Host "  Deleting: $Path"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # PASS 1: rd /s /q FIRST.
    # Default Windows user profiles contain XP-compat junction points
    # (Application Data, Cookies, Local Settings, My Documents, etc.) with
    # explicit DENY-Everyone ACEs. rd /s /q is the only built-in that
    # removes junction reparse points themselves rather than recursing into
    # them. Running takeown /R or icacls /T from the profile root FIRST
    # makes both tools chase those junctions back into AppData and stall
    # for many minutes — that was the "hung on delete user1" symptom.
    $cmdExe = Resolve-FixerTool 'cmd.exe'
    $rdArgs = '/c rd /s /q "' + $Path + '"'
    $identity = Assert-FixerProfilePathIdentity -Path $Path -ExpectedExists $true -ExpectedIdentity $ExpectedIdentity -ExpectedResolvedPath $ExpectedResolvedPath
    if (-not $identity.pathExists) { throw 'profile directory custody was lost' }
    Write-Host "    Pass 1: rd /s /q ..."
    $rc1 = Start-Process -FilePath $cmdExe -ArgumentList $rdArgs -Wait -WindowStyle Hidden -PassThru
    Write-Host ("    rd pass-1 exit: " + $rc1.ExitCode)
    if (-not [System.IO.Directory]::Exists($Path)) { throw 'profile directory custody was lost' }

    # PASS 2: targeted ownership + ACL grant — non-recursive on the root,
    # then walk top-level children explicitly while SKIPPING reparse
    # points. This fixes ACL/ownership on real residue without chasing
    # junctions.
    $identity = Assert-FixerProfilePathIdentity -Path $Path -ExpectedExists $true -ExpectedIdentity $ExpectedIdentity -ExpectedResolvedPath $ExpectedResolvedPath
    if (-not $identity.pathExists) { throw 'profile directory custody was lost' }
    Write-Host "    Pass 1 left residue; running targeted takeown/icacls/attrib (no junction chase)..."
    Start-Process -FilePath (Resolve-FixerTool 'takeown.exe') -ArgumentList @('/F',$Path,'/A','/D','Y') -Wait -WindowStyle Hidden | Out-Null
    Start-Process -FilePath (Resolve-FixerTool 'icacls.exe') -ArgumentList @($Path,'/grant','*S-1-5-32-544:(OI)(CI)F','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
    Start-Process -FilePath (Resolve-FixerTool 'attrib.exe') -ArgumentList @('-r','-h','-s',$Path,'/D') -Wait -WindowStyle Hidden | Out-Null

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
                # takeown /R, icacls /T and attrib /S follow junctions — only
                # run them once the subtree is confirmed junction-free
                # (hang guard); otherwise leave the child to the rd retry.
                if (Remove-NestedReparsePoints -Root $k.FullName) {
                    Start-Process -FilePath (Resolve-FixerTool 'takeown.exe') -ArgumentList @('/F',$k.FullName,'/A','/R','/D','Y') -Wait -WindowStyle Hidden | Out-Null
                    Start-Process -FilePath (Resolve-FixerTool 'icacls.exe') -ArgumentList @($k.FullName,'/grant','*S-1-5-32-544:(OI)(CI)F','/T','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
                    Start-Process -FilePath (Resolve-FixerTool 'attrib.exe') -ArgumentList @('-r','-h','-s',$k.FullName,'/S','/D') -Wait -WindowStyle Hidden | Out-Null
                } else {
                    Write-Host ("    not junction-free; skipping recursive ACL fix for " + $k.Name + " (rd retry still runs)")
                }
            } else {
                Start-Process -FilePath (Resolve-FixerTool 'takeown.exe') -ArgumentList @('/F',$k.FullName,'/A') -Wait -WindowStyle Hidden | Out-Null
                Start-Process -FilePath (Resolve-FixerTool 'icacls.exe') -ArgumentList @($k.FullName,'/grant','*S-1-5-32-544:F','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
                Start-Process -FilePath (Resolve-FixerTool 'attrib.exe') -ArgumentList @('-r','-h','-s',$k.FullName) -Wait -WindowStyle Hidden | Out-Null
            }
        } catch {}
    }

    # PASS 3: rd /s /q again now that ACLs are corrected.
    $identity = Assert-FixerProfilePathIdentity -Path $Path -ExpectedExists $true -ExpectedIdentity $ExpectedIdentity -ExpectedResolvedPath $ExpectedResolvedPath
    if (-not $identity.pathExists) { throw 'profile directory custody was lost' }
    Write-Host "    Pass 3: rd /s /q (retry) ..."
    $rc2 = Start-Process -FilePath $cmdExe -ArgumentList $rdArgs -Wait -WindowStyle Hidden -PassThru
    Write-Host ("    rd pass-3 exit: " + $rc2.ExitCode)

    # PASS 4: final .NET fallback for any single locked file.
    if ([System.IO.Directory]::Exists($Path)) {
        $null = Assert-FixerProfilePathIdentity -Path $Path -ExpectedExists $true -ExpectedIdentity $ExpectedIdentity -ExpectedResolvedPath $ExpectedResolvedPath
        try { [System.IO.Directory]::Delete($Path,$true) } catch { Write-Host ("    .NET Delete: " + $_.Exception.Message) }
    }

    # The retained handle keeps the private quarantine bound to the validated
    # object throughout cleanup. Mark only that exact empty handle for delete.
    $Lease.DeleteEmpty()
    if (-not $Lease.DeleteProved) { throw 'handle-bound profile deletion was not proved' }
    $sw.Stop()
    Write-Host ("  RESULT: exact profile identity quarantined and removed in {0:N1}s" -f $sw.Elapsed.TotalSeconds)
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
  if (fixInProgress || activeChildren.size > 0) {
    return { success: false, error: 'repair_in_progress' };
  }
  // A fix in progress must never be interrupted by an update restart: a
  // ready update is deferred (its countdown cancelled) and the controller's
  // isBusy() blocks any install until the fix has finished.
  fixInProgress = true;
  fixHasRun = true;
  criticalOps.poll('fix-start');
  if (updaterCtl && updaterCtl.isReady()) updaterCtl.defer();
  try {
    return await runFixFlow(event);
  } finally {
    fixInProgress = false;
    criticalOps.poll('fix-end');
    if (updaterCtl) sendUpdateStatus(updaterCtl.getStatus());
  }
});

async function runFixFlow(event) {
  // Secrets minted mid-run (helper password) are pushed here so every log
  // line is redacted. Presence assertions live in profile-safety-smoke.js;
  // never print the secret or put it in PowerShell's command line.
  const secrets = [];
  const send = (line, kind = 'out') => event.sender.send('fix-log', {
    line: profileSafety.redactSecrets(line, secrets),
    kind
  });
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
    send(`  ${ok === null ? '?  ' : ok ? 'OK ' : 'MISS'}  ${t}`, ok ? 'out' : 'err');
  }
  for (const t of OPTIONAL_TOOLS) {
    const ok = pre.info.tools && pre.info.tools[t];
    send(`  ${ok ? 'OK ' : 'opt '}  ${t}${ok ? '' : ' (optional)'}`, 'out');
  }
  send(`  Zoom present: ${pre.info.zoomPath || '(no machine-wide install)'} -> ${pre.info.zoomPath && fs.existsSync(pre.info.zoomPath) ? 'YES' : 'NO'}`, 'out');
  send(`  Firstrun script: ${pre.info.firstRunScript} -> ${fs.existsSync(pre.info.firstRunScript) ? 'YES' : 'NO'}`, 'out');
  send(`  Interactive user: ${pre.info.interactiveUser}`, 'out');
  send(`  Secondary Logon: ${pre.info.seclogon.status}/${pre.info.seclogon.startType}${pre.info.seclogon.selfHeal === 'started' ? ' (was stopped — started it for you)' : ''}`, 'out');
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

  // Resolve the existing LOCAL helper before any process or profile action.
  // A domain account with the same leaf name must never be stopped or used as
  // evidence that the local helper is clear.
  const initialIdentity = await readLocalAccountIdentity(FIX_USER);
  if (!initialIdentity.verified) {
    send(`ERROR: could not prove the local '${FIX_USER}' account identity.`, 'err');
    return { success: false, error: 'helper_sid_unresolved', warnings, steps };
  }
  const accountExisted = initialIdentity.exists;
  const preDeleteSid = initialIdentity.sid;

  // ============================================================
  // STEP 1: Stop only processes owned by the exact local helper SID.
  // ============================================================
  send(`[1/8] Terminating '${FIX_USER}' processes and sessions...`, 'header');
  // Poll until no process with the exact SID remains. GetOwnerSid is the
  // authority; GetOwner().User and DOMAIN\user leaf-name matches are not.
  const drain = await runPSCapture(`
    ${PS_EXACT_SID_PROCESS_STOP_HELPER}
    $sid = '${preDeleteSid}'
    if (-not $sid) { Write-Output 'FIXER_HELPER_INITIAL_DRAIN_V1=CLEAR'; exit 0 }
    $deadline = [DateTime]::UtcNow.AddSeconds(6)
    $state = 'UNKNOWN'
    try {
      do {
        $procs = [System.Collections.Generic.List[object]]::new()
        $unknown = $false
        foreach ($p in @(Get-CimInstance Win32_Process -EA Stop)) {
          $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -EA Stop
          if (-not $o -or $o.ReturnValue -ne 0 -or -not $o.Sid) { $unknown = $true; continue }
          if ([string]$o.Sid -ieq $sid) { $procs.Add($p) }
        }
        if ($unknown) { throw 'process owner inventory is incomplete' }
        if ($procs.Count -eq 0) { $state = 'CLEAR'; break }
        foreach ($process in $procs) {
          $outcome = Stop-FixerOwnedProcessBySid -Candidate $process -ExpectedSid $sid
          if ($outcome -cne 'TERMINATED' -and $outcome -cne 'GONE') {
            throw 'owned process termination was not proved'
          }
        }
        Start-Sleep -Milliseconds 250
      } while ([DateTime]::UtcNow -lt $deadline)
      if ($state -ne 'CLEAR') { $state = 'RESIDUAL' }
    } catch { $state = 'UNKNOWN' }
    Write-Output ('FIXER_HELPER_INITIAL_DRAIN_V1=' + $state)
    if ($state -eq 'CLEAR') { exit 0 }
    exit 1
  `, { timeoutMs: 20000 });
  const drainReceipt = String(drain.stdout || '').trim();
  if (drain.code !== 0 || drain.timedOut ||
      drainReceipt !== 'FIXER_HELPER_INITIAL_DRAIN_V1=CLEAR') {
    send(`ERROR: could not prove all local '${FIX_USER}' processes stopped.`, 'err');
    step('close-sessions', `Close ${FIX_USER} programs and sessions`, 'fail',
      'Exact SID process ownership or termination could not be proved.');
    return { success: false, error: 'helper_process_custody_unresolved', warnings, steps };
  }
  step('close-sessions', `Close ${FIX_USER} programs and sessions`, 'ok', '');

  // ============================================================
  // STEP 2: Bind all later profile cleanup to the exact prior local SID.
  // A folder named user1 (or user1.*) is not proof of ownership.
  // ============================================================
  send('[2/8] Binding old profile cleanup to the prior local account identity...', 'header');
  if (preDeleteSid) {
    send('  Prior local SID verified. Only its ProfileList records may be removed.', 'out');
  } else {
    send('  No prior local SID exists. No profile key or folder will be removed by name.', 'out');
  }

  let profileCleanupPlan = selectSidBoundProfileEntries([], preDeleteSid, 'cleanup');
  if (preDeleteSid) {
    const profileInventory = await runPSCapture(`
      ${PS_PROFILE_PATH_IDENTITY_HELPER}
      ${PS_PROFILE_RECOVERY_HELPER}
      $ErrorActionPreference = 'Stop'
      $base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList'
      try {
        $entries = @(Get-ChildItem -LiteralPath $base -EA Stop | ForEach-Object {
          $item = Get-ItemProperty -LiteralPath $_.PSPath -EA Stop
          $effectivePath = Resolve-FixerProfileInventoryPath -Item $item -KeyName ([string]$_.PSChildName) -ExpectedSid '${preDeleteSid}'
          $profilePathPresent = [bool]$effectivePath.profileImagePathPresent
          $profilePath = [string]$effectivePath.profileImagePath
          $pathIdentity = [pscustomobject]@{
            pathExists = $false
            isReparsePoint = $false
            resolvedPath = ''
            stableIdentity = ''
          }
          if ($profilePath) {
            $pathIdentity = Get-FixerProfilePathIdentity -Path $profilePath
          }
          [pscustomobject]@{
            keyName = [string]$_.PSChildName
            profileImagePath = $profilePath
            profileImagePathPresent = $profilePathPresent
            hasNtUserDat = [bool]($pathIdentity.pathExists -and
              [System.IO.File]::Exists((Join-Path $pathIdentity.resolvedPath 'NTUSER.DAT')))
            pathExists = [bool]$pathIdentity.pathExists
            isReparsePoint = [bool]$pathIdentity.isReparsePoint
            resolvedPath = [string]$pathIdentity.resolvedPath
            stableIdentity = [string]$pathIdentity.stableIdentity
            readable = $true
          }
        })
        [pscustomobject]@{
          marker = 'FIXER_PROFILELIST_V1'
          sid = '${preDeleteSid}'
          entries = @($entries)
        } | ConvertTo-Json -Compress -Depth 4
      } catch { exit 1 }
    `, { timeoutMs: 30000 });

    profileCleanupPlan = null;
    if (!profileInventory.timedOut && profileInventory.code === 0) {
      try {
        const payload = JSON.parse(String(profileInventory.stdout || '').trim());
        const entries = Array.isArray(payload && payload.entries)
          ? payload.entries
          : (payload && payload.entries ? [payload.entries] : []);
        if (payload && payload.marker === 'FIXER_PROFILELIST_V1' &&
            String(payload.sid || '').toLowerCase() === preDeleteSid.toLowerCase()) {
          profileCleanupPlan = selectSidBoundProfileEntries(entries, preDeleteSid, 'cleanup');
        }
      } catch (_) { /* fail closed below */ }
    }
    if (!profileCleanupPlan || !profileCleanupPlan.ok) {
      send('ERROR: old profile ownership could not be proved from the exact prior SID.', 'err');
      step('data-clear', `Clear old ${FIX_USER} profile data`, 'fail',
        'ProfileList ownership was missing, ambiguous, unreadable, redirected, or unsafe. No account, profile key, or folder was removed.');
      return { success: false, error: 'profile_cleanup_identity_unresolved', warnings, steps };
    }
  }

  // ============================================================
  // STEP 3: Delete the existing user1 account, profile folder,
  //         and ProfileList registry entries.
  // ============================================================
  send('[3/8] Removing existing account and profile...', 'header');

  // SECURITY (SEC-A6): the helper account is no longer an administrator —
  // every privileged repair step runs under this app's own elevated token,
  // and user1 only runs Zoom. A user1 left in Administrators by an older
  // version gets the membership removed here, BEFORE the delete→recreate,
  // so even a failed delete leaves no admin rights behind. Detection,
  // removal, and readback all use the exact local-account SID. If that proof
  // is unavailable, stop before touching a same-name principal.
  if (accountExisted) {
    const legacyAdmin = await verifyAdminMembership(preDeleteSid);
    if (!legacyAdmin.verified) {
      send(`ERROR: could not verify administrator membership for the local '${FIX_USER}' SID.`, 'err');
      step('remove-admin-rights', `Remove administrator rights from ${FIX_USER}`, 'fail',
        'Exact SID group membership could not be verified.');
      return { success: false, error: 'helper_admin_membership_unresolved', warnings, steps };
    }
    if (legacyAdmin.inGroup) {
      send(`  '${FIX_USER}' is in the Administrators group — removing rights it no longer needs...`, 'out');
      const adminRemoval = await runPSScript(`
        $targetSid = '${preDeleteSid}'
        try {
          $matches = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -EA Stop |
            Where-Object { $_.SID -and ([string]$_.SID.Value -ieq $targetSid) })
          if ($matches.Count -ne 1) { throw 'exact SID membership was not unique' }
          Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member $matches[0] -EA Stop
          Write-Host '  Exact SID administrator membership removed.'
        } catch { exit 1 }
      `, send, { heartbeatMs: 5000, heartbeatLabel: 'admin-rights removal', timeoutMs: 60000 });
      const adminRecheck = await verifyAdminMembership(preDeleteSid);
      if (adminRemoval.code === 0 && !adminRemoval.timedOut && adminRecheck.verified && !adminRecheck.inGroup) {
        send('  Removed administrator rights the helper account no longer needs.', 'out');
        step('remove-admin-rights', `Remove administrator rights from ${FIX_USER}`, 'ok',
          'Removed administrator rights the helper account no longer needs');
      } else {
        send(`ERROR: could not prove removal of '${FIX_USER}' from the Administrators group.`, 'err');
        step('remove-admin-rights', `Remove administrator rights from ${FIX_USER}`, 'fail',
          'Exact SID membership removal or readback failed.');
        return { success: false, error: 'helper_admin_removal_unproved', warnings, steps };
      }
    }
  }

  // Keep the exact SID as retry evidence, but prevent a new helper logon
  // from acquiring profile handles during destructive cleanup. Then repeat
  // the exact-SID process drain. Any disable or owner uncertainty stops
  // before a profile folder, ProfileList key, or account is mutated.
  if (accountExisted) {
    const disable = await runPSScript(
      exactSidLocalUserDisableScript(preDeleteSid, FIX_USER), send,
      { heartbeatMs: 5000, heartbeatLabel: 'exact-SID local user disable', timeoutMs: 60000 });
    if (!exactSidLocalUserDisableProved(disable)) {
      send(`ERROR: exact-SID disable of local account '${FIX_USER}' was not proved.`, 'err');
      return { success: false, error: 'helper_disable_unproved', warnings, steps };
    }

    const finalDrain = await runPSCapture(
      exactSidFinalDrainScript(preDeleteSid), { timeoutMs: 20000 });
    const finalDrainReceipt = String(finalDrain.stdout || '').trim();
    if (finalDrain.code !== 0 || finalDrain.timedOut ||
        finalDrainReceipt !== 'FIXER_HELPER_FINAL_DRAIN_V1=CLEAR') {
      send(`ERROR: final local '${FIX_USER}' process drain was not proved.`, 'err');
      return { success: false, error: 'helper_final_drain_unproved', warnings, steps };
    }
  }

  // Keep the local account and its SID alive until every selected folder is
  // absent and every exact-SID ProfileList key is removed. A failed cleanup
  // then remains recoverable on the next run through the same trusted SID.
  let plSweep = { code: 0, timedOut: false, stdout: '' };
  if (preDeleteSid) {
    const cleanupPlanJson = JSON.stringify(profileCleanupPlan.entries).replace(/'/g, "''");
    plSweep = await runPSScript(`
        ${PS_PROFILE_PATH_IDENTITY_HELPER}
        ${PS_PROFILE_RECOVERY_HELPER}
        ${PS_PROFILE_INVENTORY_GUARD}
        ${PS_REMOVE_PROFILE_HELPER}
        $ErrorActionPreference = 'Stop'
        $expectedSid = '${preDeleteSid}'
        $base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList'
        $plan = @(ConvertFrom-Json -InputObject '${cleanupPlanJson}')

        try {
          $currentTargets = @(Assert-FixerProfileInventory -Plan $plan -ExpectedSid $expectedSid -Base $base)
          $plannedFolders = @($plan | Where-Object { [bool]$_.pathExists } |
            Group-Object -Property stableIdentity | ForEach-Object { $_.Group[0] })
          foreach ($plannedFolder in $plannedFolders) {
            # Revalidate every ProfileList path immediately before touching one
            # selected directory. This closes alias and mutation-time drift.
            $currentTargets = @(Assert-FixerProfileInventory -Plan $plan -ExpectedSid $expectedSid -Base $base)
            $profilePath = [string]$plannedFolder.profileImagePath
            $profileIdentity = Assert-FixerProfilePathIdentity -Path $profilePath -ExpectedExists $true -ExpectedIdentity ([string]$plannedFolder.stableIdentity) -ExpectedResolvedPath ([string]$plannedFolder.resolvedPath)
            if ($profileIdentity.pathExists) {
              Write-Host "  Removing exact-SID profile folder: $profilePath"
              # A loaded hive can hold the profile tree open without delete
              # sharing. Release it before acquiring the long-lived custody
              # handle; after acquisition no path-only root mutation is
              # authoritative.
              Unload-UserHive -Sid $expectedSid
              $lease = [FixerProfileIdentityV1]::AcquireQuarantineLease(
                $profilePath,
                [string]$plannedFolder.stableIdentity,
                [string]$plannedFolder.resolvedPath)
              try {
                # The held handle has proved that this resolved path is the
                # same object as the raw registry alias. From this point on,
                # receipts and mutations use only the resolved identity.
                $profilePath = [string]$lease.OriginalPath
                $folderPlans = @($plan | Where-Object {
                  [string]$_.stableIdentity -ceq [string]$plannedFolder.stableIdentity
                })
                $folderKeys = [System.Collections.Generic.List[object]]::new()
                foreach ($folderPlan in $folderPlans) {
                  $matchingKeys = @($currentTargets | Where-Object {
                    [string]$_.PSChildName -ieq [string]$folderPlan.keyName
                  })
                  if ($matchingKeys.Count -ne 1) { throw 'exact-SID ProfileList recovery key is unavailable' }
                  $folderKeys.Add($matchingKeys[0])
                  # Normalize a resumed receipt to the currently authenticated
                  # file identity before writing the next durable transition.
                  Set-ItemProperty -LiteralPath $matchingKeys[0].PSPath -Name 'ProfileImagePath' -Value $profilePath -EA Stop
                  $pathItem = Get-ItemProperty -LiteralPath $matchingKeys[0].PSPath -EA Stop
                  $pathProperty = $pathItem.PSObject.Properties['ProfileImagePath']
                  if ($null -eq $pathProperty -or [string]$pathProperty.Value -ine $profilePath) {
                    throw 'exact-SID ProfileList source path was not proved'
                  }
                }
                $quarantinePath = [string]$lease.PlannedQuarantinePath
                $recoveryJson = [ordered]@{
                  marker = 'FIXER_PROFILE_QUARANTINE_V1'
                  phase = 'moving'
                  originalPath = $profilePath
                  quarantinePath = $quarantinePath
                  stableIdentity = [string]$plannedFolder.stableIdentity
                } | ConvertTo-Json -Compress
                foreach ($folderKey in $folderKeys) {
                  New-ItemProperty -LiteralPath $folderKey.PSPath -Name 'FixerProfileQuarantineV1' -Value $recoveryJson -PropertyType String -Force -EA Stop | Out-Null
                  $recoveryItem = Get-ItemProperty -LiteralPath $folderKey.PSPath -EA Stop
                  $recoveryProperty = $recoveryItem.PSObject.Properties['FixerProfileQuarantineV1']
                  if ($null -eq $recoveryProperty -or [string]$recoveryProperty.Value -cne $recoveryJson) {
                    throw 'exact-SID profile quarantine receipt was not proved'
                  }
                }
                # The exact-SID durable receipt now identifies both sides of
                # the transition. A timeout before or after the handle rename
                # can be recovered by physical file identity on the next run.
                Protect-FixerProfileQuarantineRoot -Path $profilePath
                $actualQuarantinePath = $lease.Quarantine()
                if ($actualQuarantinePath -ine $quarantinePath) {
                  throw 'handle-bound quarantine destination changed'
                }
                foreach ($folderPlan in $folderPlans) {
                  $matchingKeys = @($folderKeys | Where-Object {
                    [string]$_.PSChildName -ieq [string]$folderPlan.keyName
                  })
                  if ($matchingKeys.Count -ne 1) { throw 'exact-SID ProfileList recovery key is unavailable' }
                  Set-ItemProperty -LiteralPath $matchingKeys[0].PSPath -Name 'ProfileImagePath' -Value $quarantinePath -EA Stop
                  $recoveryItem = Get-ItemProperty -LiteralPath $matchingKeys[0].PSPath -EA Stop
                  $recoveryProperty = $recoveryItem.PSObject.Properties['ProfileImagePath']
                  if ($null -eq $recoveryProperty -or [string]$recoveryProperty.Value -ine $quarantinePath) {
                    throw 'exact-SID ProfileList recovery path was not proved'
                  }
                  $folderPlan.profileImagePath = $quarantinePath
                  $folderPlan.profileImagePathPresent = $true
                  $folderPlan.resolvedPath = $quarantinePath
                  $folderPlan.pathExists = $true
                }
                $null = @(Assert-FixerProfileInventory -Plan $plan -ExpectedSid $expectedSid -Base $base)
                $deletingRecoveryJson = [ordered]@{
                  marker = 'FIXER_PROFILE_QUARANTINE_V1'
                  phase = 'deleting'
                  originalPath = $profilePath
                  quarantinePath = $quarantinePath
                  stableIdentity = [string]$plannedFolder.stableIdentity
                } | ConvertTo-Json -Compress
                foreach ($folderKey in $folderKeys) {
                  Set-ItemProperty -LiteralPath $folderKey.PSPath -Name 'FixerProfileQuarantineV1' -Value $deletingRecoveryJson -EA Stop
                  $deletingItem = Get-ItemProperty -LiteralPath $folderKey.PSPath -EA Stop
                  $deletingProperty = $deletingItem.PSObject.Properties['FixerProfileQuarantineV1']
                  if ($null -eq $deletingProperty -or [string]$deletingProperty.Value -cne $deletingRecoveryJson) {
                    throw 'profile quarantine delete receipt was not proved'
                  }
                }
                Remove-ProfileFolder -Path $quarantinePath -Sid $expectedSid -ExpectedIdentity ([string]$plannedFolder.stableIdentity) -ExpectedResolvedPath $quarantinePath -Lease $lease
                if (-not $lease.DeleteProved) { throw 'handle-bound profile deletion was not proved' }
                foreach ($folderPlan in $folderPlans) {
                  $folderPlan.pathExists = $false
                  $folderPlan.stableIdentity = ''
                  $folderPlan.resolvedPath = $quarantinePath
                }
                foreach ($folderKey in $folderKeys) {
                  Remove-ItemProperty -LiteralPath $folderKey.PSPath -Name 'FixerProfileQuarantineV1' -Force -EA Stop
                  $recoveryItem = Get-ItemProperty -LiteralPath $folderKey.PSPath -EA Stop
                  if ($null -ne $recoveryItem.PSObject.Properties['FixerProfileQuarantineV1']) {
                    throw 'profile quarantine receipt removal was not proved'
                  }
                }
              } finally {
                if ($null -ne $lease) { $lease.Dispose() }
              }
              $after = Assert-FixerProfilePathIdentity -Path $quarantinePath -ExpectedExists $false
              if ($after.pathExists) { throw 'profile folder remains after cleanup' }
            }
          }
          # Keep exact-SID keys as ownership evidence until every selected
          # folder is absent and the complete inventory is safe again.
          $currentTargets = @(Assert-FixerProfileInventory -Plan $plan -ExpectedSid $expectedSid -Base $base)
          foreach ($plannedFolder in $plannedFolders) {
            $after = Assert-FixerProfilePathIdentity -Path ([string]$plannedFolder.profileImagePath) -ExpectedExists ([bool]$plannedFolder.pathExists) -ExpectedIdentity ([string]$plannedFolder.stableIdentity) -ExpectedResolvedPath ([string]$plannedFolder.resolvedPath)
            if ($after.pathExists) { throw 'profile folder remains after cleanup' }
          }
          foreach ($key in $currentTargets) {
            Write-Host ("  Removing exact-SID ProfileList entry: " + $key.PSChildName)
            Remove-Item -LiteralPath $key.PSPath -Recurse -Force -EA Stop
          }
          $remainingTargets = @(Get-ChildItem -LiteralPath $base -EA Stop |
            Where-Object { $_.PSChildName -ieq $expectedSid -or $_.PSChildName -ieq ($expectedSid + '.bak') })
          if ($remainingTargets.Count -ne 0) { throw 'ProfileList cleanup was not proved' }
        } catch { exit 1 }
    `, send, { heartbeatMs: 5000, heartbeatLabel: 'exact-SID profile cleanup', timeoutMs: 480000 });
    tallyRemovals(plSweep);
    if (plSweep.timedOut) {
      send('ERROR: exact-SID profile cleanup timed out. Reboot and try again.', 'err');
      return { success: false, error: 'delete_profile_timeout', warnings, steps };
    }
    if (plSweep.code !== 0) {
      send('ERROR: exact-SID profile cleanup did not complete safely. No name-only fallback was attempted.', 'err');
      return { success: false, error: 'delete_profile_failed', warnings, steps };
    }
    if (profileCleanupPlan.entries.length === 0) {
      send('  No ProfileList entry belongs to the prior local SID. Name-only folders were preserved.', 'out');
    }
  }

  if (accountExisted) {
    // The folder/key mutation used preDeleteSid as its authority. Re-read the
    // local account immediately before deletion, then pass that exact SID to
    // Remove-LocalUser. The account name never selects this mutation.
    const deleteIdentity = await readLocalAccountIdentity(FIX_USER);
    if (!deleteIdentity.verified || !deleteIdentity.exists ||
        deleteIdentity.sid.toLowerCase() !== preDeleteSid.toLowerCase()) {
      send(`ERROR: local '${FIX_USER}' identity changed before account deletion.`, 'err');
      return { success: false, error: 'helper_identity_changed_before_delete', warnings, steps };
    }
    const del = await runPSScript(exactSidLocalUserDeleteScript(preDeleteSid, FIX_USER), send,
      { heartbeatMs: 5000, heartbeatLabel: 'exact-SID local user deletion', timeoutMs: 60000 });
    if (!exactSidLocalUserDeleteProved(del)) {
      send(`ERROR: exact-SID deletion of local account '${FIX_USER}' was not proved.`, 'err');
      return { success: false, error: 'delete_user_failed', warnings, steps };
    }
    const deletedIdentity = await readLocalAccountIdentity(FIX_USER);
    if (!deletedIdentity.verified || deletedIdentity.exists) {
      send(`ERROR: could not prove that local account '${FIX_USER}' was deleted.`, 'err');
      return { success: false, error: 'delete_user_unproved', warnings, steps };
    }
    send('  Account deleted.', 'out');
  } else {
    send('  Account does not exist - skipping account delete.', 'out');
  }

  // Aggregate data-clear outcome across every removal pass above. A counted
  // leftover ("app only deleted 1 file" class) fails the step -> partial;
  // a timeout or unclean exit with clean counts is at least a warn.
  {
    const deletedCount = Math.max(0, clearAttempts - clearFailures);
    const clearRec = deletionOutcome(deletedCount, clearAttempts);
    let clearOutcome = clearRec.outcome;
    let clearDetail = clearRec.detail;
    if (clearOutcome === 'ok' && (clearTimedOut || plSweep.code !== 0)) {
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
    # PROFSVC_REFRESH is a structured success marker (P1-B): OK is emitted
    # only when a refresh path VERIFIABLY succeeded — Restart-Service without
    # throwing, the sc.exe fallback observed back to Running, or the service
    # was not running (no retained hive handles to drop). Exit code alone
    # cannot carry this: the catches below deliberately keep the script alive.
    $refreshOk = $false
    try {
      $svc = Get-Service ProfSvc -EA Stop
      if ($svc.Status -eq 'Running') {
        try {
          Restart-Service ProfSvc -Force -EA Stop
          Write-Host '  ProfSvc restarted via Restart-Service.'
          $refreshOk = $true
        } catch {
          Write-Host ('  Restart-Service failed: ' + $_.Exception.Message)
          $stop  = & (Resolve-FixerTool 'sc.exe') stop  ProfSvc 2>&1
          Start-Sleep -Seconds 2
          $start = & (Resolve-FixerTool 'sc.exe') start ProfSvc 2>&1
          Write-Host ('  sc.exe stop output:  ' + (($stop  | Out-String).Trim()))
          Write-Host ('  sc.exe start output: ' + (($start | Out-String).Trim()))
          # sc.exe start reports START_PENDING immediately; poll the actual
          # service state for evidence the fallback worked.
          $deadline = [DateTime]::UtcNow.AddSeconds(5)
          do {
            try { if ((Get-Service ProfSvc -EA Stop).Status -eq 'Running') { $refreshOk = $true; break } } catch {}
            Start-Sleep -Milliseconds 500
          } while ([DateTime]::UtcNow -lt $deadline)
        }
      } else {
        Write-Host ('  ProfSvc status=' + $svc.Status + '; nothing to flush.')
        # Not running = no retained hive handles to drop; goal already met.
        $refreshOk = $true
      }
    } catch {
      Write-Host ('  WARNING: could not inspect ProfSvc: ' + $_.Exception.Message)
    }
    # Belt-and-suspenders: flush HKLM hive writes so the next logon
    # reads fresh ProfileList data, not cached.
    & (Resolve-FixerTool 'reg.exe') flush HKLM 2>&1 | Out-Null
    Write-Host '  HKLM flushed.'
    Write-Output ($(if ($refreshOk) { 'PROFSVC_REFRESH=OK' } else { 'PROFSVC_REFRESH=FAILED' }))
  `, send, { heartbeatMs: 5000, heartbeatLabel: 'profsvc flush', timeoutMs: 60000 });
  // A ProfSvc flush that timed out, died, or self-swallowed its failure used
  // to vanish into a green run (#90). When a previous user1 existed the flush
  // is what prevents the TEMP-profile relapse, so its failure invalidates the
  // fix's purpose. The structured marker catches the self-swallow case where
  // the script exits 0 despite both restart paths failing (P1-B).
  const flushMarker = profsvcRefreshResult(flush.stdout);
  if (flush.timedOut || flush.code !== 0 || flushMarker !== 'OK') {
    const profsvcNeeded = accountExisted ||
      profileCleanupPlan.entries.some(entry => entry.pathExists === true);
    const why = flush.timedOut          ? 'timed out after 60 seconds'
      : flush.code !== 0                ? `did not finish cleanly (exit ${flush.code})`
      : flushMarker === 'FAILED'        ? 'could not restart the service'
      :                                   'did not confirm success';
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
  // STEP 4: Recreate the account as a STANDARD user — no
  //         Administrators membership (SEC-A6). Every privileged
  //         repair step runs under this app's own elevated token;
  //         user1 only runs Zoom, which needs no admin. Zoom updates
  //         are machine-wide MSI updates done by the primary user.
  // ============================================================
  send(`[4/8] Creating account '${FIX_USER}' as a standard user...`, 'header');
  // Mint THIS run's password. Rotation is free: STEP 3 deleted the old
  // account, so nothing anywhere needs the previous secret, and every
  // consumer below (launch, relaunch, sealed shortcut blob) is written by
  // this same run. The alphabet is PS-single-quote / argv / net.exe-safe by
  // construction (helper-credential.js). Never logged, never persisted in
  // plain text.
  const fixPass = helperCred.generateHelperPassword();
  secrets.push(fixPass);
  // Password reaches PowerShell through stdin (same as Zoom launch), without
  // a temporary script or a PowerShell command-line secret. The native net.exe
  // account API still receives it in its arguments. /y answers the long-password
  // DOS compatibility prompt; the log sanitizer removes the generated secret.
  const create = await runPSScript(
    profileSafety.accountCreateScript(FIX_USER, fixPass),
    send,
    { heartbeatMs: 5000, heartbeatLabel: 'net user /add', timeoutMs: 60000 }
  );
  if (create.code !== 0) {
    send(`ERROR: failed to create '${FIX_USER}'.`, 'err');
    send('  Common cause: password complexity policy rejected the password.', 'err');
    return { success: false, error: 'create_user_failed', warnings, steps };
  }
  const helperSID = await resolveSID(FIX_USER, preDeleteSid);
  if (!helperSID) {
    send(`ERROR: Windows did not return one fresh local SID for '${FIX_USER}'.`, 'err');
    step('create-account', `Create fresh ${FIX_USER} account`, 'fail',
      'The new local account identity was missing, ambiguous, malformed, or unchanged.');
    return { success: false, error: 'created_helper_sid_unproved', warnings, steps };
  }
  // Invalidate-at-rotation: the OLD password just died with the recreate, so
  // any blob/launcher from a previous run is unusable from this instant.
  // Delete both NOW — if this run exits before the seal block republishes
  // them (launch failure, DPAPI failure, launcher-write failure), what
  // remains is clean ABSENCE, which shortcut-exists / create-shortcut
  // already report honestly ("press FIX NOW"), instead of a stale pair the
  // UI would trust. Publish happens only after a confirmed launch (seal
  // block below). Deletion failure never fails the run.
  for (const stale of [CRED_BLOB_PATH(), LAUNCHER_SCRIPT_PATH()]) {
    try {
      fs.rmSync(stale, { force: true });
    } catch (err) {
      console.warn(`[fix] could not remove stale ${path.basename(stale)}: ${err.message}`);
      warnings.push({
        code: 'stale_credential_cleanup_failed',
        message: `Could not remove the previous shortcut sign-in file (${path.basename(stale)}): ${err.message}. The desktop shortcut may not work until the next successful fix run.`
      });
    }
  }
  send(`  Account '${FIX_USER}' created as a standard user (no administrator rights — it only runs Zoom).`, 'out');
  step('create-account', `Create fresh ${FIX_USER} account`, 'ok', '');

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
  // fixPass is interpolated into a single-quoted PowerShell string and sent
  // through stdin — never on a command line or in a temporary file.
  const launchPs = `
    try {
      $ErrorActionPreference = 'Stop'
      $fixerLaunchPhase = 'credential'
      $pw = [System.Security.SecureString]::new()
      $fixerPasswordChars = '${fixPass}'.ToCharArray()
      try {
        foreach ($fixerPasswordChar in $fixerPasswordChars) {
          $pw.AppendChar($fixerPasswordChar)
        }
      } finally {
        $fixerPasswordChar = $null
        [Array]::Clear($fixerPasswordChars, 0, $fixerPasswordChars.Length)
      }
      $pw.MakeReadOnly()
      $fixerLocalUser = [System.Environment]::MachineName + '\\${FIX_USER}'
      $cred = [System.Management.Automation.PSCredential]::new($fixerLocalUser, $pw)
      Write-Output 'FIXER_LAUNCH_PHASE_V1 phase=credential outcome=success exceptionClass=none hresult=none nativeCode=none'
      $fixerLaunchPhase = 'start_process'
      Start-Process -FilePath '${zi.path}' -WorkingDirectory '${zi.dir}' -Credential $cred -EA Stop
      Write-Host '  Zoom launched as ${FIX_USER}.'
      Write-Output 'FIXER_LAUNCH_PHASE_V1 phase=start_process outcome=success exceptionClass=none hresult=none nativeCode=none'
      exit 0
    } catch {
      $fixerFailurePhase = 'pre_launch'
      try {
        if (($fixerLaunchPhase -eq 'credential') -or ($fixerLaunchPhase -eq 'start_process')) {
          $fixerFailurePhase = [string]$fixerLaunchPhase
        }
      } catch {}
      $fixerExceptionClass = 'unknown'
      try {
        $fixerClassCandidate = [string]$_.Exception.GetType().FullName
        if ($fixerClassCandidate -match '^[A-Za-z][A-Za-z0-9_.]{0,127}$') {
          $fixerExceptionClass = $fixerClassCandidate
        }
      } catch {}
      $fixerHResult = 'none'
      try {
        $fixerHResultValue = [int64]$_.Exception.HResult
        if (($fixerHResultValue -ge -2147483648) -and ($fixerHResultValue -le 4294967295)) {
          $fixerHResult = [string]$fixerHResultValue
        }
      } catch {}
      $fixerNativeCode = 'none'
      try {
        $fixerErrorObject = $_.Exception
        for ($fixerDepth = 0; ($fixerDepth -lt 3) -and ($null -ne $fixerErrorObject); $fixerDepth++) {
          $fixerNativeProperty = $fixerErrorObject.PSObject.Properties['NativeErrorCode']
          if (($null -ne $fixerNativeProperty) -and ($null -ne $fixerNativeProperty.Value)) {
            $fixerNativeValue = [int64]$fixerNativeProperty.Value
            if (($fixerNativeValue -ge -2147483648) -and ($fixerNativeValue -le 4294967295)) {
              $fixerNativeCode = [string]$fixerNativeValue
            }
            break
          }
          $fixerErrorObject = $fixerErrorObject.InnerException
        }
      } catch {}
      try {
        Write-Output ('FIXER_LAUNCH_PHASE_V1 phase={0} outcome=failure exceptionClass={1} hresult={2} nativeCode={3}' -f $fixerFailurePhase, $fixerExceptionClass, $fixerHResult, $fixerNativeCode)
      } catch {}
      exit 1
    }
  `;
  send(`  Dispatching Zoom launch (detached) ...`, 'out');
  const launch = await runPSScriptLaunchCapture(launchPs);
  const launchDiagnostics = formatLaunchDiagnostics(launch);
  for (const diagnostic of launchDiagnostics) {
    send(`  ${diagnostic}`, diagnostic.includes(' outcome=success ') ? 'out' : 'err');
  }
  if (launch.code !== 0 && launch.code !== null) {
    send(`  Launch script exited with code ${launch.code}; verifying via Win32_Process...`, 'err');
  }

  // Verify Zoom is actually running as user1. With stdio:'ignore' on the
  // launcher we have no other signal. Use Win32_Process via Get-CimInstance
  // + Invoke-CimMethod GetOwnerSid. The SID binds this proof to the exact
  // recreated local account generation. Poll up to ~10s INSIDE one PS process — the old spawn-per-tick
  // loop paid a powershell.exe startup for each of up to 12 checks, and the
  // 400ms internal tick also spots Zoom sooner.
  const zpoll = await runPSCapture(`
    $sid = '${helperSID}'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    $hit = $false
    do {
      try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='Zoom.exe'" -EA SilentlyContinue
        foreach ($p in $procs) {
          $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -EA SilentlyContinue
          if ($owner -and $owner.ReturnValue -eq 0 -and ([string]$owner.Sid -ieq $sid)) { $hit = $true; break }
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
  // Seal this run's password for the desktop shortcut (security design, option A).
  // DPAPI scope justification — CurrentUser, NOT LocalMachine: the shortcut
  // runs in the PRIMARY user's non-elevated session, and this elevated
  // process is the SAME account. CurrentUser blobs are keyed to the user
  // profile's DPAPI master keys, which elevation does not change — so
  // seal-elevated / unseal-non-elevated works, and NO other local account
  // can decrypt the blob. LocalMachine would be decryptable by any local
  // user and would need hand-rolled ACLs to compensate.
  // Every fix run rewrites blob + launcher unconditionally (same paths), so
  // legacy plaintext launchers are migrated in place with zero handshake
  // and rotation needs no staleness detection.
  // Soft-fail (#76): if Protect fails (Windows Data Protection disabled or
  // blocked), the fix itself is NOT failed — Zoom already launched with the
  // in-memory credential and STEP 8 relaunch still works. We skip the
  // blob+launcher write and warn that the one-click shortcut is
  // unavailable. NEVER fall back to a static or logged password, NEVER
  // write plaintext. A stale blob from an older run simply stops matching
  // the rotated password; the launcher's catch branch turns that into the
  // same friendly "press FIX NOW" message.
  // ============================================================
  const credDir = path.dirname(LAUNCHER_SCRIPT_PATH());
  const blobPath = CRED_BLOB_PATH();
  // Publish order (invalidate-at-rotation's other half): the blob is sealed
  // to a .tmp sibling and renamed over the final name only once complete,
  // and the launcher is written LAST \u2014 so a launcher on disk always implies
  // its blob exists. Absence (from the rotation delete above) is the only
  // other reachable state; the UI paths handle both honestly.
  const blobTmp = blobPath + '.tmp';
  const psq = s => String(s).replace(/'/g, "''");
  // Password + paths ride inside a tmp script file (runPSCapture), never on
  // a command line. Paths are ''-escaped; the password alphabet cannot
  // contain apostrophes or newlines by construction.
  const seal = await runPSCapture(`
    try {
      Add-Type -AssemblyName System.Security
      if (-not (Test-Path -LiteralPath '${psq(credDir)}')) { New-Item -ItemType Directory -Path '${psq(credDir)}' -Force | Out-Null }
      $pt = [Text.Encoding]::UTF8.GetBytes('${fixPass}')
      $sealed = [Security.Cryptography.ProtectedData]::Protect($pt, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Array]::Clear($pt, 0, $pt.Length)
      [IO.File]::WriteAllBytes('${psq(blobTmp)}', $sealed)
      Write-Output 'SEALED'
    } catch {
      Write-Output ('SEALFAIL: ' + $_.Exception.Message)
    }
  `);
  let sealedOk = (seal.stdout || '').includes('SEALED') && fs.existsSync(blobTmp);
  if (sealedOk) {
    try {
      fs.renameSync(blobTmp, blobPath);
      // BOM for the same PS 5.1 legacy-encoding reason as runPSScriptLaunchCapture.
      fs.writeFileSync(LAUNCHER_SCRIPT_PATH(),
        '\ufeff' + helperCred.launcherScriptContent(FIX_USER, zi.path, zi.dir), 'utf8');
      send('  Helper sign-in stored encrypted (Windows DPAPI) for the desktop shortcut.', 'out');
    } catch (err) {
      // If the rename landed but the launcher write failed, the fresh blob
      // stays \u2014 the post-fix recreate path (shortcut-exists sees no
      // launcher -> invalid -> create-shortcut) rewrites the launcher from
      // it. Only a never-renamed .tmp is swept below.
      sealedOk = false;
    }
  }
  if (!sealedOk) {
    try { fs.rmSync(blobTmp, { force: true }); } catch (_) { /* best-effort sweep */ }
    const sealFailLine = (seal.stdout || '').split(/\r?\n/)
      .map(s => s.trim()).find(l => l.startsWith('SEALFAIL: ')) || '';
    send('  WARNING: could not store the helper sign-in encrypted — the one-click desktop shortcut will not work until a fix run can store it.', 'err');
    warnings.push({
      code: 'dpapi_seal_failed',
      message: 'One-click desktop shortcut unavailable because Windows Data Protection is disabled or blocked on this PC — the helper sign-in could not be stored encrypted. The fix still worked; run FIX NOW again when you want Zoom relaunched.'
        + (sealFailLine ? ` Detail for support: ${sealFailLine.slice(10)}` : '')
    });
  }

  // ============================================================
  // STEP 6: Resolve the new user1 profile from the exact helper SID's
  //         ProfileList key. Deploy firstrun + desktop shortcut.
  // ============================================================
  send('[6/8] Resolving new user1 profile path...', 'header');
  const profile = await resolveUserProfilePath(FIX_USER, 30, send, helperSID);
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
    // helper script) was skipped. Identity is unresolved, so fail closed.
    step('profile-setup', `Set up the ${FIX_USER} profile`, 'fail',
      `The exact ${FIX_USER} SID did not resolve to one trusted local profile, so no per-user file or ACL change was made.`);
    return { success: false, error: 'profile_identity_unresolved', steps, warnings, receipt: null };
  }
  const newUserProfile = profile.path;
  send(`  Profile source: ${profile.source}, path: ${newUserProfile}`, 'out');
  if (profile.sid) send(`  SID: ${profile.sid}`, 'out');

  // ============================================================
  // STEP 6-guard: Verify the launch landed in the REAL C:\Users\user1
  // profile and log the effective environment. Unique logic from closed
  // unmerged PR #40 (ec91d45), rewritten on current main: a TEMP/suffixed
  // landing is a failed profile-setup step (NEEDS ATTENTION), never a
  // silent green. No TEMP-folder deletes, no ProfileList guessing.
  // ============================================================
  const profileLaunch = profileSafety.evaluateLaunchProfile({
    profilePath: newUserProfile,
    source: profile.source,
    username: FIX_USER
  });
  send('  Launched-profile environment:', 'out');
  send(`    USERPROFILE   = ${profileLaunch.env.USERPROFILE}`, 'out');
  send(`    APPDATA       = ${profileLaunch.env.APPDATA}`, 'out');
  send(`    LOCALAPPDATA  = ${profileLaunch.env.LOCALAPPDATA}`, 'out');
  if (profileLaunch.ok) {
    send(`  ${profileLaunch.message}`, 'out');
  } else {
    send(`  ERROR: Zoom did NOT land in ${profileSafety.canonicalProfilePath(FIX_USER)}.`, 'err');
    send(`           Resolved: ${newUserProfile} (source: ${profile.source}).`, 'err');
    send('           Windows fell back to a TEMP/suffixed profile - the 1132', 'err');
    send('           identity may not be clean. Remediation: reboot once, then', 'err');
    send('           re-run the fix (the ProfSvc hive-handle flush only fully', 'err');
    send('           releases stale handles across a reboot).', 'err');
    warnings.push({
      code: profileLaunch.code || 'temp_or_suffixed_profile',
      message: profileLaunch.message
    });
    step('profile-setup', `Set up the ${FIX_USER} profile`, 'fail', profileLaunch.message);
    send('Fix finished, but some outcomes need attention - see the summary below.', 'err');
    const earlyVerdict = computeRunVerdict(steps, warnings, []);
    return { success: true, partial: true, steps, warnings, receipt: null, verdict: earlyVerdict };
  }

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
  if (profile.sid && profile.sid.toLowerCase() === helperSID.toLowerCase()) {
    await runPSScript(`
      $sid = '${helperSID}'
      $base = '${newUserProfile}'
      $targets = @(
        (Join-Path $base 'NTUSER.DAT'),
        (Join-Path $base 'AppData\\Local\\Microsoft\\Windows\\UsrClass.dat')
      )
      foreach ($f in $targets) {
        if (Test-Path $f) {
          $out = & (Resolve-FixerTool 'icacls.exe') $f /grant ('*' + $sid + ':(F)') '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' 2>&1
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
      // firstRunDst is built from the helper profile path plus a fixed file
      // name. A double quote or line break can never be part of a Windows
      // path, so the value is validated rather than escaped: the shortcut's
      // argument string is a PowerShell single-quoted literal that must
      // carry the path inside literal double quotes unchanged.
      if (/["\r\n]/.test(firstRunDst)) {
        throw new Error('first-run script path contains characters that cannot be placed in a shortcut argument');
      }
      const shortcutPs = `
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut('${esc(shortcutPath)}')
        $lnk.TargetPath = Resolve-FixerTool 'powershell.exe'
        $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "${firstRunDst}"'
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
        runProcess('icacls.exe', [firstRunDst, '/grant', `*${helperSID}:(R)`, '/C'], noop),
        runProcess('icacls.exe', [shortcutPath, '/grant', `*${helperSID}:(RX)`, '/C'], noop)
      ]);
    } catch (err) {
      send(`    WARNING: firstrun deploy failed: ${err.message}`, 'err');
      warnings.push({ code: 'firstrun_deploy_failed', message: err.message });
    }
  }
  {
    const profileIssueCodes = ['firstrun_missing', 'shortcut_failed', 'firstrun_deploy_failed'];
    const profileIssues = warnings.filter(w => profileIssueCodes.includes(w.code));
    if (profileLaunch && profileLaunch.silentSuccessForbidden) {
      step('profile-setup', `Set up the ${FIX_USER} profile`, 'fail', profileLaunch.message);
    } else {
      step('profile-setup', `Set up the ${FIX_USER} profile`,
        profileIssues.length ? 'warn' : 'ok', profileIssues.map(w => w.code).join(', '));
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

  const userSID = helperSID;
  if (userSID) {
    await runPSScript(`
      $sid = '${userSID}'
      $null = & (Resolve-FixerTool 'reg.exe') query "HKU\\$sid" 2>$null
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  Setting Windows dark mode for '${FIX_USER}'..."
        & (Resolve-FixerTool 'reg.exe') add "HKU\\$sid\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v AppsUseLightTheme   /t REG_DWORD /d 0 /f | Out-Null
        & (Resolve-FixerTool 'reg.exe') add "HKU\\$sid\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v SystemUsesLightTheme /t REG_DWORD /d 0 /f | Out-Null
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
      // Per-user write confirmations (the script's own post-write readback of
      // the HKU values) — carried for the verification pass: when the hive is
      // unloaded at verify time these are the only per-user evidence (P1-A).
      var consentUserWrite = { cam: consentResult.cam_user === true, mic: consentResult.mic_user === true };
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
    ${PS_EXACT_SID_PROCESS_STOP_HELPER}
    $sid = '${helperSID}'
    $names = @('Zoom.exe','CptHost.exe','CptControl.exe','ZoomWebhook.exe',
               'Zoom_launcher.exe','ZoomTeamChat.exe','airhost.exe')
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    $clear = $false
    $unknown = $false
    do {
      $targets = [System.Collections.Generic.List[object]]::new()
      try {
        $candidates = @(Get-CimInstance Win32_Process -EA Stop | Where-Object {
          ($names -contains $_.Name) -or
          ($_.ExecutablePath -and $_.ExecutablePath -like '*\\Zoom\\*')
        })
        foreach ($candidate in $candidates) {
          $o = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -EA SilentlyContinue
          if (-not $o -or $o.ReturnValue -ne 0 -or -not $o.Sid) { $unknown = $true; continue }
          if ([string]$o.Sid -ieq $sid) { $targets.Add($candidate) }
        }
      } catch { $unknown = $true }
      if ($unknown) { break }
      if ($targets.Count -eq 0) { $clear = $true; break }
      try {
        foreach ($target in $targets) {
          $outcome = Stop-FixerOwnedProcessBySid -Candidate $target -ExpectedSid $sid
          if ($outcome -cne 'TERMINATED' -and $outcome -cne 'GONE') {
            throw 'owned Zoom process termination was not proved'
          }
        }
      } catch { $unknown = $true; break }
      Start-Sleep -Milliseconds 300
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($unknown) { Write-Output 'UNKNOWN' }
    elseif ($clear) { Write-Output 'CLEAR' }
    else { Write-Output ('RESIDUAL=' + $targets.Count) }
  `, { timeoutMs: 30000 });
  if (zoomClose.code === 0 && !zoomClose.timedOut && (zoomClose.stdout || '').trim() === 'CLEAR') {
    send('  Zoom closed.', 'out');
  } else {
    send(`ERROR: could not prove every Zoom process for '${FIX_USER}' stopped.`, 'err');
    step('zoom-config', 'Apply Zoom preferences', 'fail',
      'Exact SID process ownership or termination could not be proved.');
    return { success: false, error: 'zoom_process_custody_unresolved', warnings, steps };
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
      [newZoomDir, '/grant', `*${helperSID}:(OI)(CI)F`, '/T', '/C'], noop);
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
  const relaunch = await runPSScriptLaunchCapture(launchPs);
  const relaunchDiagnostics = formatLaunchDiagnostics(relaunch);
  for (const diagnostic of relaunchDiagnostics) {
    send(`  ${diagnostic}`, diagnostic.includes(' outcome=success ') ? 'out' : 'err');
  }
  if (relaunch.code !== 0 && relaunch.code !== null) {
    warnings.push({
      code: 'relaunch_failed',
      message: `Initial launch succeeded but the relaunch exited with code ${relaunch.code}. Open Zoom manually.`
    });
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
      $null = & (Resolve-FixerTool 'reg.exe') query "HKU\\$sid" 2>$null
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
          $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -EA SilentlyContinue
          if ($o -and $o.ReturnValue -eq 0 -and ([string]$o.Sid -ieq $sid)) { $hit = $true; break }
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
  // Readback is authoritative where it could see the values, and OK requires
  // PER-USER evidence: the HKU value is the toggle Zoom actually reads
  // (grant-media-consent.ps1) — the HKLM device-wide floor alone never yields
  // OK (P1-A). POLICY-BLOCKED always stands. VERIFY_HKLM_* stays in the
  // captured output as diagnostics only. Logic lives in run-verdict.js so
  // tools/run-verdict-smoke.js exercises the exact shipped semantics.
  const userWrite = (typeof consentUserWrite !== 'undefined') ? consentUserWrite : { cam: false, mic: false };
  receipt.camera     = consentOutcome(receipt.camera,     userWrite.cam, vget('VERIFY_USER_webcam'));
  receipt.microphone = consentOutcome(receipt.microphone, userWrite.mic, vget('VERIFY_USER_microphone'));
  if (!vprobeFailed) {
    send(`  Consent readback: camera=${receipt.camera}, microphone=${receipt.microphone}`,
      (receipt.camera !== 'UNVERIFIED' && receipt.microphone !== 'UNVERIFIED') ? 'out' : 'err');
  }
  const consentBad = receipt.camera === 'UNVERIFIED' || receipt.microphone === 'UNVERIFIED';
  const consentPolicy = receipt.camera === 'POLICY-BLOCKED' || receipt.microphone === 'POLICY-BLOCKED';
  step('consent', 'Grant camera and microphone access',
    consentBad ? 'fail' : (consentPolicy ? 'warn' : 'ok'),
    consentBad
      ? `camera=${receipt.camera}, microphone=${receipt.microphone} — sign in as ${FIX_USER}, open Settings > Privacy & security > Camera (and Microphone), and toggle access on manually.`
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
  if (typeof profileLaunch !== 'undefined' && profileLaunch) {
    receipt.profileKind = profileLaunch.kind;
    receipt.profilePath = newUserProfile;
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
const SHORTCUT_FILENAME = profileSafety.PRIMARY_SHORTCUT_FILENAME;
const LEGACY_SHORTCUT_FILENAMES = [
  `Launch Zoom as ${FIX_USER}.lnk`,
  'Open Zoom with 1132 Helper.lnk', // pre-6.1 name, superseded 2026-08-23
];
const LAUNCHER_SCRIPT_NAME = `launch-zoom-as-${FIX_USER}.ps1`;
const LAUNCHER_SCRIPT_PATH = () => path.join(app.getPath('appData'), '1132 Fixer', LAUNCHER_SCRIPT_NAME);
// DPAPI-sealed helper password (security design, option A), co-located with the launcher —
// the launcher resolves it via $PSScriptRoot, so the two must share a dir.
const CRED_BLOB_PATH = () => path.join(app.getPath('appData'), '1132 Fixer', helperCred.CRED_BLOB_NAME);

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
  // A MISSING launcher, however, is a known-dead shortcut, not an unknown:
  // the fix deletes launcher+blob the moment the helper password rotates
  // (invalidate-at-rotation) and republishes only after a confirmed launch,
  // so absence means a run ended between those points — the .lnk points at
  // nothing and must read invalid so the recreate path repairs it.
  const launcherPresent = fs.existsSync(expectedScript);
  let launcherStale = false;
  if (zoomInstall && zoomInstall.path && launcherPresent) {
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
      valid: info ? (shortcutMatchesCurrentApp(info, expectedScript) && !launcherStale && launcherPresent) : null,
      target: info ? info.target : null,
      arguments: info ? info.arguments : null
    };
  });
}

// Legacy → DPAPI credential migration (create-shortcut upgrade path).
// Reads the pre-6.0 plaintext launcher, and — only when it names the
// expected helper user and carries a migratable password — seals that
// password into helper-credential.bin exactly the way the fix run does
// (DPAPI CurrentUser; password rides inside a tmp script file, never on a
// command line; sealed to a .tmp sibling and renamed only once complete).
// Returns true when the blob now exists. Never throws; any failure leaves
// the launcher untouched so the legacy shortcut keeps working as-is.
async function migrateLegacyLauncherCredential() {
  let legacy = null;
  try {
    legacy = helperCred.extractLegacyLauncherCredential(
      fs.readFileSync(LAUNCHER_SCRIPT_PATH(), 'utf8'), FIX_USER);
  } catch (_) {
    return false; // no launcher on disk, or unreadable — nothing to migrate
  }
  if (!legacy) return false;
  const blobPath = CRED_BLOB_PATH();
  const blobTmp = blobPath + '.tmp';
  const psq = s => String(s).replace(/'/g, "''");
  // isMigratableLegacyPassword guarantees no apostrophes/CR/LF, so the
  // single-quoted interpolation below cannot be escaped.
  const seal = await runPSCapture(`
    try {
      Add-Type -AssemblyName System.Security
      $pt = [Text.Encoding]::UTF8.GetBytes('${legacy.password}')
      $sealed = [Security.Cryptography.ProtectedData]::Protect($pt, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      [Array]::Clear($pt, 0, $pt.Length)
      [IO.File]::WriteAllBytes('${psq(blobTmp)}', $sealed)
      Write-Output 'SEALED'
    } catch {
      Write-Output ('SEALFAIL: ' + $_.Exception.Message)
    }
  `);
  if (!((seal.stdout || '').includes('SEALED') && fs.existsSync(blobTmp))) {
    try { fs.rmSync(blobTmp, { force: true }); } catch (_) { /* best-effort sweep */ }
    return false;
  }
  try {
    fs.renameSync(blobTmp, blobPath);
  } catch (_) {
    try { fs.rmSync(blobTmp, { force: true }); } catch (_) { /* best-effort sweep */ }
    return false;
  }
  console.log('[shortcut] migrated legacy plaintext launcher credential to DPAPI blob');
  return true;
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
  // The canonical Desktop exists by definition, but the homedir fallback
  // (used when the PS resolution fails) can point at a classic
  // %USERPROFILE%\Desktop that OneDrive redirection has removed —
  // WScript.Shell Save() then throws file-not-found (#93 #111). Creating
  // the folder is harmless when it already exists; if this fails, the PS
  // step below reports the real error non-fatally as before.
  try { fs.mkdirSync(desktop, { recursive: true }); } catch (_) { /* Save() will report */ }
  const shortcutPath = path.join(desktop, SHORTCUT_FILENAME);
  const iconPath = getHelperIconPath();

  const scriptPath = LAUNCHER_SCRIPT_PATH();
  const scriptDir = path.dirname(scriptPath);
  // The launcher carries NO secret (security design, option A): it reads the DPAPI-sealed
  // helper-credential.bin written by the last fix run. Without that blob
  // there is no working sign-in to point a shortcut at — FIX NOW is what
  // mints and seals it — so refuse with the next step instead of minting a
  // dead shortcut.
  //
  // Upgrade exception: a pre-6.0 install stored the sign-in as plaintext
  // inside the launcher script itself (no blob existed yet), so after an
  // in-place upgrade the blob is missing while a working credential IS on
  // this PC. Migrate it: seal the legacy password with DPAPI, then let the
  // normal path below rewrite the launcher in the secret-free format —
  // which also removes the plaintext from disk.
  if (!fs.existsSync(CRED_BLOB_PATH())) {
    const migrated = await migrateLegacyLauncherCredential();
    if (!migrated) {
      return { success: false, error: 'No stored helper sign-in was found on this PC. Press FIX NOW once, then create the shortcut again.' };
    }
  }
  try {
    fs.mkdirSync(scriptDir, { recursive: true });
    // BOM for the same PS 5.1 legacy-encoding reason as runPSScriptLaunchCapture.
    fs.writeFileSync(scriptPath, '\ufeff' + helperCred.launcherScriptContent(FIX_USER, zi.path, zi.dir), 'utf8');
  } catch (err) {
    return { success: false, error: `Failed to write launcher script: ${err.message}` };
  }

  const escape = s => s.replace(/'/g, "''");
  const ps = [
    "$s = New-Object -ComObject WScript.Shell",
    `$sc = $s.CreateShortcut('${escape(shortcutPath)}')`,
    "$sc.TargetPath = Resolve-FixerTool 'powershell.exe'",
    `$sc.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${escape(scriptPath)}"'`,
    `$sc.IconLocation = '${escape(iconPath)}'`,
    `$sc.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')`,
    `$sc.Description = 'Starts Zoom using the dedicated helper account created by 1132 Fixer.'`,
    "$sc.Save()"
  ].join('; ');

  // Reuse the trusted runner so the child tree has one custody, timeout and
  // settlement policy. WScript.Shell COM can hang behind a stuck Explorer
  // session, so keep the existing 30-second bound.
  const result = await runPSScript(ps, () => {}, { timeoutMs: 30000 });
  if (result.timedOut) {
    return { success: false, error: 'Creating the shortcut took too long. Try again.' };
  }
  if (result.code !== 0) {
    return { success: false, error: result.stderr.trim() || `Exit ${result.code}` };
  }
  // Only after the renamed shortcut exists do we clear the old one, so a
  // failed create never leaves the user with no shortcut at all. Cleanup
  // failure is reported, never fatal.
  const cleanup = await removeLegacyShortcuts();
  return {
    success: true,
    path: shortcutPath,
    legacyRemoved: cleanup.removed,
    legacyRemovalFailed: cleanup.failed
  };
});

// "Open Zoom" on the Fix-complete screen — runs the SAME launcher script
// the desktop shortcut points at (it unseals the DPAPI credential blob
// itself; no secret rides in argv). Refuses honestly when the pair from
// the last fix run is not on disk.
async function launchZoomHelper() {
  const scriptPath = LAUNCHER_SCRIPT_PATH();
  if (!fs.existsSync(scriptPath) || !fs.existsSync(CRED_BLOB_PATH())) {
    return { success: false, reason: 'no stored helper sign-in — run the fix first' };
  }
  const helperSID = await resolveSID(FIX_USER);
  if (!helperSID) {
    return { success: false, reason: 'local helper identity is unavailable — run the fix first' };
  }
  // Completion already launched Zoom as user1. Do not start a second copy.
  const already = await runPSCapture(`
    $sid = '${helperSID}'
    $hit = $false
    $unknown = $false
    try {
      $procs = @(Get-CimInstance Win32_Process -Filter "Name='Zoom.exe'" -EA Stop)
      foreach ($p in $procs) {
        try {
          $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -EA Stop
          if (-not $o -or $o.ReturnValue -ne 0 -or -not $o.Sid) { $unknown = $true; continue }
          if ([string]$o.Sid -ieq $sid) { $hit = $true }
        } catch { $unknown = $true }
      }
    } catch { $unknown = $true }
    if ($unknown) { $result = 'UNKNOWN' }
    elseif ($hit) { $result = 'YES' }
    else { $result = 'NO' }
    Write-Output ('FIXER_ZOOM_DEDUP_V1=' + $result)
  `, { timeoutMs: 15000 });
  const lines = String(already && already.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const marker = lines.length === 1 ? /^FIXER_ZOOM_DEDUP_V1=(YES|NO|UNKNOWN)$/.exec(lines[0]) : null;
  if (!already || already.timedOut || already.code !== 0 || !marker || marker[1] === 'UNKNOWN') {
    return { success: false, reason: 'could not verify helper Zoom process ownership — try again' };
  }
  if (marker[1] === 'YES') {
    return { success: true, alreadyRunning: true };
  }
  try {
    const child = spawnWindowsTool('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}
ipcMain.handle('launch-zoom-helper', launchZoomHelper);

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
  try {
    return await isElevatedSync();
  } catch (_) {
    return false;
  }
});

ipcMain.handle('startup-status', async () => {
  const t0 = Date.now();
  elevation.logStage('startup-status', 'begin');
  let elev = { elevated: false, method: 'failed', error: 'not probed', ms: 0 };
  try {
    elev = typeof elevCtl.snapshot === 'function' ? elevCtl.snapshot() : await elevCtl.isElevated();
  } catch (err) {
    elev = { elevated: false, method: 'failed', error: String(err && err.message || err), ms: Date.now() - t0 };
  }
  const interactiveUser = (os.userInfo().username || '').toLowerCase();
  const runningAsTarget = interactiveUser === FIX_USER.toLowerCase();
  let state = 'ready';
  let stage = 'ready';
  if (elev.elevated !== true) {
    state = 'need-elevation';
    stage = 'elevation';
  } else if (runningAsTarget) {
    state = 'blocked';
    stage = 'interactive-user';
  }
  const result = {
    state,
    stage,
    elevated: elev.elevated === true,
    elevationMethod: elev.method,
    elevationError: elev.error || null,
    runningAsTarget,
    elapsedMs: Date.now() - t0
  };
  elevation.logStage('startup-status', `state=${state} method=${elev.method} ${result.elapsedMs}ms`);
  return result;
});

// Renderer retry for self-elevation. On success the elevated instance is
// already starting, so this one quits itself (shortly after the reply so
// the renderer can paint its "Restarting…" state).
ipcMain.handle('relaunch-elevated', async () => {
  let started = false;
  try { started = await relaunchElevated(); } catch (_) { /* declined/failed */ }
  if (started) setTimeout(() => shutdown.request(shutdown.REASONS.ELEVATED_RELAUNCH), 150);
  return { started, outcome: lastRelaunchOutcome };
});

ipcMain.handle('quit-app', () => {
  shutdown.request(shutdown.REASONS.USER_EXIT);
});

ipcMain.handle('get-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-system-info', async () => {
  // `admin` was hardcoded true. The feedback dialog renders this verbatim as
  // "Admin: Yes" and it is what a support report asserts about the run, so a
  // non-elevated session was reporting itself as elevated — while the footer
  // badge, reading the same probe, said "Not Admin". Measure it.
  let admin = null;
  try {
    admin = await isElevatedSync();
  } catch (_) {
    admin = null;
  }
  return {
    version: app.getVersion(),
    os: `Windows ${os.release()}`,
    admin
  };
});

// Local feature gate only: opening the form never contacts the service.
ipcMain.handle('feedback-capabilities', () => supportClient.capabilities(config));

// User-triggered submissions use one neutral, credential-free adapter.
// Version is the only automatic metadata; optional diagnostics are user chosen.
ipcMain.handle('submit-feedback', async (event, type, text, screenshot, rating) => {
  return supportClient.submitFeedback({
    config,
    type,
    text,
    version: app.getVersion(),
    screenshot,
    rating,
  });
});

// ============================================================
// IPC: preflight-scan — premium UX surface.
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
    # Bind the read-only inventory to the exact local account. NTAccount(name)
    # can select a same-name domain principal on joined machines.
    $sid = $null
    $localUser = $null
    try { $localUser = Get-LocalUser -Name '${FIX_USER}' -EA Stop } catch {}
    if ($localUser) {
      try { $sid = [string]$localUser.SID.Value } catch { $sid = $null }
    }
    $out['user1_exists'] = [bool]$localUser
    $out['user1_identity_verified'] = [bool]($localUser -and $sid)
    # HKU hive — informational only (renderer maps to 'will load temp' vs 'already loaded')
    if ($sid) {
      $null = & (Resolve-FixerTool 'reg.exe') query "HKU\\$sid" 2>$null
      $out['hku_loaded'] = ($LASTEXITCODE -eq 0)
      $out['hku_sid']    = $sid
    } else {
      $out['hku_loaded'] = $false
      $out['hku_sid']    = ''
    }
    # Helper-account health: existence, plus exact-SID Administrators
    # membership to detect a LEGACY admin helper that FIX NOW must strip.
    $out['user1_admin'] = $false
    $out['user1_admin_verified'] = -not $out['user1_exists']
    # Read-only helper-profile inventory (TEMP identification, ProfileList,
    # ownership). Never deletes TEMP folders, the helper profile, or registry keys.
    $out['profile_image_path'] = ''
    $out['profile_list_bak'] = $false
    $out['profile_owner'] = ''
    $out['profile_folder_exists'] = $false
    $out['profile_ntuser'] = $false
    $folder = 'C:\\Users\\${FIX_USER}'
    try { $out['profile_folder_exists'] = [bool](Test-Path -LiteralPath $folder) } catch {}
    if ($sid) {
      $plKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\' + $sid
      try {
        $pip = (Get-ItemProperty -Path $plKey -EA SilentlyContinue).ProfileImagePath
        if ($pip) { $out['profile_image_path'] = [string]$pip }
      } catch {}
      try { $out['profile_list_bak'] = [bool](Test-Path -LiteralPath ($plKey + '.bak')) } catch {}
    }
    if ($out['profile_folder_exists']) {
      try { $out['profile_owner'] = [string](Get-Acl -LiteralPath $folder).Owner } catch {}
      try { $out['profile_ntuser'] = [IO.File]::Exists((Join-Path $folder 'NTUSER.DAT')) } catch {}
    }
    if ($out['user1_exists']) {
      try {
        foreach ($m in (Get-LocalGroupMember -SID 'S-1-5-32-544' -EA Stop)) {
          $mSid = $null
          try { $mSid = $m.SID.Value } catch {}
          if ($sid -and $mSid -and ($mSid -eq $sid)) {
            $out['user1_admin'] = $true; break
          }
        }
        $out['user1_admin_verified'] = [bool]$sid
      } catch {}
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
    : { status: 'blocked', label: 'Administrator', message: 'Not running as Administrator. Close the app, right-click its icon and choose "Run as administrator".' };

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
  if (!probeFailed && probeData.user1_exists &&
      (probeData.user1_identity_verified !== true || probeData.user1_admin_verified !== true)) {
    probeFailed = true;
  }
  const probeFailMsg = probe.timedOut
    ? 'Probe timed out after 20s — Windows Defender or another AV may be holding PowerShell. FIX NOW can still run. To clear this, add 1132 Fixer to your antivirus exclusions; the checklist re-scans when you come back to this window.'
    : 'PowerShell probe failed — could not read this value. FIX NOW can still run; the checklist re-scans when you come back to this window.';

  // --- Helper user (user1) ------------------------------------
  // A user1 that exists WITH a profile as a STANDARD user is the normal,
  // healthy state after a successful fix — report it green. The account
  // is no longer added to Administrators (SEC-A6): a legacy user1 that
  // still has admin rights is repairable — FIX NOW removes them. Amber is
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
    } else if (helperExists && helperAdmin) {
      cards.helperUser = { status: 'repairable', label: 'Helper account', message: `'${FIX_USER}' has administrator rights it no longer needs — FIX NOW will remove them.` };
    } else if (helperExists && helperProfileExists) {
      cards.helperUser = { status: 'ready', label: 'Helper account', message: `'${FIX_USER}' is set up — standard account, profile present. FIX NOW rebuilds it fresh.` };
    } else if (helperExists) {
      cards.helperUser = { status: 'repairable', label: 'Helper account', message: `'${FIX_USER}' account exists but no profile yet. FIX NOW will reset.` };
    } else {
      cards.helperUser = { status: 'warning', label: 'Helper account', message: `Stale profile folder at ${helperProfileDir} with no account. FIX NOW will clean it up.` };
    }
  }

  // --- Helper profile (TEMP / canonical / ownership / ProfileList) --
  // Inventory only. A TEMP ProfileImagePath is repairable (FIX NOW
  // rebuilds the real helper profile). Probe failure is a warning, never ready:
  // unknown is not success. Nothing here deletes TEMP folders by name.
  cards.helperProfile = profileSafety.classifyHelperProfileCard(probeFailed ? { probeFailed: true } : {
    probeFailed: false,
    accountExists: !!probeData.user1_exists,
    folderExists: !!probeData.profile_folder_exists || helperProfileExists,
    folderPath: helperProfileDir,
    profileImagePath: probeData.profile_image_path || '',
    owner: probeData.profile_owner || '',
    profileListBak: !!probeData.profile_list_bak,
    ntuserPresent: !!probeData.profile_ntuser,
    username: FIX_USER
  });

  // --- Secondary Logon (seclogon) -----------------------------
  // Hard gate: launching Zoom as user1 rides Start-Process
  // -Credential, which needs this service actually running. Field reports
  // showed it Stopped with an all-green scan and the launch then silently
  // no-opping — so it now has its own row, self-heal happens inside
  // preflightCheck(), and a not-running service blocks the Fix button.
  {
    const sl = pre.info.seclogon || {};
    if (sl.status === 'Running') {
      cards.seclogon = {
        status: 'ready', label: 'Secondary Logon',
        message: sl.selfHeal === 'started'
          ? 'Was stopped — 1132 Fixer started it for you. Ready to launch Zoom as user1.'
          : 'Running — ready to launch Zoom as user1.'
      };
    } else if (sl.startType === 'Disabled') {
      cards.seclogon = {
        status: 'blocked', label: 'Secondary Logon',
        message: 'Disabled — Windows cannot launch Zoom as user1. Run "sc.exe config seclogon start= demand" from an admin shell, then come back.'
      };
    } else if (sl.status === 'MISSING') {
      cards.seclogon = {
        status: 'blocked', label: 'Secondary Logon',
        message: 'Service not found on this Windows build — launching Zoom as user1 will likely fail.'
      };
    } else if (sl.status === 'not checked') {
      cards.seclogon = { status: 'warning', label: 'Secondary Logon', message: probeFailMsg };
    } else if (sl.selfHeal === 'start-failed') {
      cards.seclogon = {
        status: 'blocked', label: 'Secondary Logon',
        message: 'Stopped and could not be started — the fix would finish without Zoom ever launching. Run "sc.exe start seclogon" from an admin shell, then come back.'
      };
    } else {
      cards.seclogon = {
        status: 'warning', label: 'Secondary Logon',
        message: `${sl.status} / ${sl.startType} — unexpected state; the fix may not be able to launch Zoom as user1.`
      };
    }
  }

  const policyCard = (label, val, valueName) => {
    if (probeFailed) return { status: 'warning', label, message: probeFailMsg };
    // val: 0 = Force Allow, 1 = User in control, 2 = Force Deny, -1 = no policy
    if (val === 2) return { status: 'blocked',   label, message: `Blocked by Windows policy (Force Deny) — 1132 Fixer cannot override it. If IT manages this PC, ask them to allow app access. On a personal PC, run from an admin shell: reg.exe delete "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\AppPrivacy" /v ${valueName} /f — then come back to re-check.` };
    if (val === 0) return { status: 'ready',     label, message: 'Allowed by policy (Force Allow).' };
    if (val === 1) return { status: 'ready',     label, message: 'Under user control (no Force Deny).' };
    if (val === -1) return { status: 'ready',    label, message: 'No restrictive policy detected.' };
    return { status: 'warning', label, message: 'Could not read policy registry.' };
  };
  cards.camPolicy = policyCard('Camera policy',     probeData.cam_policy, 'LetAppsAccessCamera');
  cards.micPolicy = policyCard('Microphone policy', probeData.mic_policy, 'LetAppsAccessMicrophone');

  // FrameServer
  if (probeFailed) {
    cards.frameServer = { status: 'warning', label: 'Camera Frame Server', message: probeFailMsg };
  } else {
    const fsStatus = probeData.fs_status;
    const fsStart  = probeData.fs_starttype;
    if (fsStatus === 'MISSING') {
      cards.frameServer = { status: 'warning', label: 'Camera Frame Server', message: 'Service not present on this Windows build — cameras may not enumerate. This does not mean Zoom error 1132 is absent or present. Open View details if you need the Media Feature Pack path.' };
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

  // Roll up overall readiness for renderer convenience. Preflight blockers
  // count even when no card carries them (running_as_target, missing_tool,
  // tool-probe failure) — otherwise the Fix button sits enabled while
  // run-fix would refuse at [0/8] anyway.
  const statuses = Object.values(cards).map(c => c.status);
  let overall = 'ready';
  if (statuses.includes('blocked') || pre.blockers.length) overall = 'blocked';
  else if (statuses.includes('repairable'))   overall = 'repairable';
  else if (statuses.includes('warning'))      overall = 'warning';

  return {
    cards,
    overall,
    canRunFix: !statuses.includes('blocked') && pre.blockers.length === 0,
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
    const probe = preflight.info && preflight.info.toolProbe;
    if (probe) {
      md.push(`- Windows tool check: exit ${probe.exitCode === null ? 'unknown' : probe.exitCode}; timeout ${probe.timedOut === true}; error ${probe.errorCode || 'none'}`);
      md.push(`- App architecture: ${process.arch}`);
      for (const [name, toolPath] of Object.entries(preflight.info.toolPaths || {})) {
        md.push(`- ${name}: ${sanitize(toolPath)}`);
      }
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
  if (updaterCtl) {
    // Update lifecycle, as the updater log recorded it: stage, reason and
    // the last entries. Paths and URLs are already sanitized by that log.
    let diag = null;
    try { diag = updaterCtl.diagnostics(); } catch (_) { diag = null; }
    if (diag) {
      md.push('### Update status');
      md.push('```');
      md.push(`state:    ${diag.state}${diag.stage ? ` (${diag.stage})` : ''}`);
      md.push(`reason:   ${diag.reason || 'none'}`);
      md.push(`version:  ${diag.current} -> ${diag.target || 'none'} (${diag.channel}, ${diag.executionMode})`);
      md.push(`attempts: ${diag.attempts}`);
      for (const line of (diag.recent || []).slice(-12)) md.push(sanitize(line));
      md.push('```');
      md.push('');
    }
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
