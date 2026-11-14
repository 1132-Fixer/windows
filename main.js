const { app, BrowserWindow, dialog, ipcMain, shell, safeStorage, screen, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const electronSecurity = require('./src/main/electron-security');
electronSecurity.installIpcAllowlist(ipcMain);
const elevation = require('./src/main/elevation');
const elevCtl = elevation.createElevationController({runTimed:runElevationProcess});
const config = require('./src/main/config');
const supportClient = require('./src/main/support-client');
const zoomDetect = require('./zoom-detect');
const messages = require('./messages');
const helperCred = require('./helper-credential');
const profileSafety = require('./profile-safety');
const { createBoundedProcessRunner } = require('./src/main/bounded-process');
const { resolvePowerShell7, preparePowerShellScript } = require('./src/main/powershell7');
const { createWindowsRepairTransport } = require('./src/main/windows-repair-transport');
const { createHelperResetWindows } = require('./src/main/helper-reset-windows');
const { createRepairSession } = require('./src/main/repair-session');
const { createProcessCustodyStore } = require('./src/main/process-custody');
const { RECOVERY_PROBE_SCRIPT, parseRecoveryProbeResult, PROBE_TIMEOUT_MS } = require('./src/main/repair-recovery');
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
// A bounded caller can finish while native cleanup is still unproved. Keep
// repair/update/inactivity exclusion until an explicit reconciliation exists.
let unresolvedProcessCustody = false;
let nativeRecovery = {status:'checking',verified:false};
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
criticalOps.addSource('process-custody', () => hasOwnedWork());
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
    const r = spawnSync('reg.exe', ['query', key, '/v', name], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
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
    isBusy: () => hasOwnedWork(),
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
// first hop and every redirect must pass isAllowedUpdaterUrl. Builds <=5.5.1
// point at a deleted legacy repository and require manual recovery; current
// builds never fetch that GitHub path.
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
    const child = spawn('msiexec.exe', ['/i', file], { windowsHide: false });
    child.on('error', () => { notifyDone(-1); releaseInstaller(); });
    child.on('exit', (code) => { notifyDone(code); releaseInstaller(); });
    return { started: true };
  } catch (_) {
    releaseInstaller();
    return { started: false };
  }
});

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
  mainWindow.on('close', event => {
    if (hasOwnedWork()) {
      event.preventDefault();
      dialog.showMessageBoxSync(mainWindow,{type:'warning',title:'1132 Fixer',message:'Windows work is still owned by this app.',
        detail:messages.PROCESS_RECOVERY,buttons:['Keep open'],noLink:true});
    }
  });

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
        ? messages.PROCESS_RECOVERY
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
      fatalDialogShown = true;
      if (retainFatalCustody()) { app.relaunch(); app.exit(1); }
      else dialog.showErrorBox('Repair recovery required', messages.PROCESS_RECOVERY);
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
const singleInstanceReady = (async () => {
  if (app.requestSingleInstanceLock()) return true;
  if (!process.argv.includes(ELEVATE_RETRY_FLAG)) return false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    if (app.requestSingleInstanceLock()) return true;
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
// launch-error | failed | already-elevated | null.
let lastRelaunchOutcome = null;

async function relaunchElevated() {
  if (hasOwnedWork()) { lastRelaunchOutcome='recovery-required'; return false; }
  if (await isElevatedSync()) { lastRelaunchOutcome = 'already-elevated'; return false; }
  const exe = process.execPath;
  app.releaseSingleInstanceLock();
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
  if (!started) app.requestSingleInstanceLock();
  return started;
}

app.whenReady().then(async () => {
  // Second instance (except the elevated-relaunch retry) — quitting; never
  // open a window from it.
  if (!await singleInstanceReady) return;
  // Establish recovery state before an app relaunch can release this instance.
  // A protected-state read refusal stays blocked; the approval mechanism is
  // preserved and is never treated as evidence that an old worker stopped.
  await refreshRepairRecovery();
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
    }
  }
  await refreshRepairRecovery();
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
      if (!fixInProgress && !unresolvedProcessCustody) checkPortableUpdate();
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

app.on('before-quit', event => {
  if (hasOwnedWork()) {
    event.preventDefault();
    appLog.warn('quit-blocked-owned-work');
    return;
  }
  const reason=shutdown.note(shutdown.REASONS.SYSTEM_SHUTDOWN);
  if(inactivityCtl)inactivityCtl.dispose();
  if(updaterCtl && updaterCtl.isReady() && !hasOwnedWork())updaterCtl.installOnExit(reason);
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
// owned children first. A dispatched kill is not proof of termination, and an
// application restart is not evidence that an interrupted repair is safe.
const activeChildren = new Set();
let processCustodyStore = null;
const processCustodyTokens = new Set();
function getProcessCustodyStore() {
  if (!processCustodyStore) processCustodyStore = createProcessCustodyStore({fs,
    directory:path.join(app.getPath('userData'),'process-custody-v1'),
    randomId:() => crypto.randomBytes(16).toString('hex'),now:Date.now});
  return processCustodyStore;
}
function hasOwnedWork() {
  try {
    return hasActiveLocalWork() || unresolvedProcessCustody || nativeRecovery.status !== 'clear' ||
      (repairSession && repairSession.hasUnresolvedCustody()) || getProcessCustodyStore().inspect().blocked;
  } catch (_) { unresolvedProcessCustody = true; return true; }
}
function hasActiveLocalWork() {
  try {
    const state = repairSession && repairSession.inspect();
    return fixInProgress || activeChildren.size > 0 || !!(state && (state.running || state.nativeOwned || state.pendingNative));
  } catch (_) { unresolvedProcessCustody = true; return true; }
}
async function refreshRepairRecovery() {
  if (hasActiveLocalWork() && !fixInProgress) return {status:'blocked',verified:false,reason:'local_work_active'};
  try {
    const result = await runPSCapture(RECOVERY_PROBE_SCRIPT,{timeoutMs:PROBE_TIMEOUT_MS});
    nativeRecovery = parseRecoveryProbeResult(result,{expectedMachineId:os.hostname(),nowMs:Date.now()});
  } catch (_) { nativeRecovery = {status:'blocked',verified:false,reason:'probe_unverified'}; }
  criticalOps.poll('recovery-probe');
  return nativeRecovery;
}
function retainFatalCustody() {
  if (!hasOwnedWork()) return true;
  unresolvedProcessCustody = true;
  for (const token of processCustodyTokens) {
    try { getProcessCustodyStore().retain(token,'fatal-path-unverified'); } catch (_) { /* pending marker remains blocking */ }
  }
  const native = repairSession && repairSession.activeNative();
  if (native) native.retainCustody('caller_retained');
  criticalOps.poll('fatal-custody');
  return false;
}

process.on('uncaughtException', () => {
  const safeToExit = retainFatalCustody();
  if (!fatalDialogShown) {
    fatalDialogShown = true;
    try { dialog.showErrorBox('1132 Fixer stopped unexpectedly', safeToExit
      ? 'The app will close. Reopen it to inspect the recorded result.'
      : messages.PROCESS_RECOVERY + '\n\nThe app is keeping ownership of unfinished work. Do not start another repair.'); }
    catch (_) { /* durable pending/native journal records remain authoritative */ }
  }
  if (safeToExit) app.exit(1);
});

app.on('render-process-gone', (_event,_contents,details) => {
  if (details && details.reason === 'clean-exit') return;
  const safeToExit = retainFatalCustody();
  if (fatalDialogShown) return;
  fatalDialogShown = true;
  if (!safeToExit) { dialog.showErrorBox('Repair recovery required',messages.PROCESS_RECOVERY); return; }
  const choice=dialog.showMessageBoxSync({type:'error',title:'1132 Fixer',message:'The app window stopped working.',
    detail:'No owned operation remains. You can restart the app.',buttons:['Restart 1132 Fixer','Close'],defaultId:0,cancelId:1,noLink:true});
  if(choice===0)app.relaunch();
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

const boundedProcessRunner = createBoundedProcessRunner({
  spawn,
  activeChildren,
  onUncertain: () => {
    unresolvedProcessCustody = true;
    appLog.warn('process-cleanup-unverified');
    criticalOps.poll('process-custody');
  }
});

function runProcess(exe,args,onLine,opts={}) {
  if (unresolvedProcessCustody) return Promise.reject(Object.assign(new Error(messages.PROCESS_RECOVERY),{code:'ERR_PROCESS_CLEANUP_UNVERIFIED'}));
  const store=getProcessCustodyStore();
  let token;
  try { token=store.begin('windows-command'); processCustodyTokens.add(token); }
  catch (_) { unresolvedProcessCustody=true; return Promise.reject(Object.assign(new Error(messages.PROCESS_RECOVERY),{code:'ERR_PROCESS_CLEANUP_UNVERIFIED'})); }
  return boundedProcessRunner(exe,args,onLine,opts).then(result => {
    if(!result.cleanupConfirmed)throw Object.assign(new Error(messages.PROCESS_RECOVERY),{code:'ERR_PROCESS_CLEANUP_UNVERIFIED'});
    store.complete(token,result);
    processCustodyTokens.delete(token);
    if(result.stdoutTruncated || result.stderrTruncated)throw Object.assign(new Error('A Windows command returned incomplete output.'),{code:'ERR_PROCESS_OUTPUT_TRUNCATED'});
    return result;
  }).catch(error => {
    if(processCustodyTokens.has(token)) {
      unresolvedProcessCustody=true;
      try{store.retain(token,'command-unverified');}catch(_){/* pending record remains */}
    }
    throw error;
  });
}

async function runElevationProcess(exe,args,timeoutMs,opts={}) {
  const started=Date.now();
  try {
    const result=await runProcess(exe,args,() => {},{...opts,timeoutMs});
    return {...result,outcome:result.timedOut?'timeout':result.outcome==='exited'?'ok':'launch-error',ms:Date.now()-started};
  } catch (_) {
    return {outcome:'launch-error',code:-1,timedOut:false,cleanupConfirmed:false,stdinComplete:false,
      stdout:'',stderr:'',ms:Date.now()-started,error:messages.PROCESS_RECOVERY};
  }
}

// Internal scripts travel only through the protected Core 7 host's UTF-8 stdin.
// The bounded runner owns input until flush/close; no plaintext temporary script
// or shell-selected executable is used. Unknown termination blocks all retries.
async function runPSScript(scriptContent, onLine, opts = {}) {
  const call = preparePowerShellScript(scriptContent);
  try {
    const result = await runProcess(call.exe, call.args, onLine, { ...opts, stdinInput: call.input });
    if (result.stdinComplete !== true) throw Object.assign(new Error('Windows command input was incomplete.'), {code:'ERR_PROCESS_INPUT_INCOMPLETE'});
    return result;
  } finally { call.input.fill(0); }
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

// Readiness is read-only. Native adapters re-establish every safety condition
// under the protected machine lease immediately before the actual effect.
async function preflightCheck() {
  const blockers = [], warnings = [], info = {};
  info.elevated = await isElevatedSync();
  info.interactiveUser = (os.userInfo().username || '').toLowerCase();
  info.tools = {};
  if (!info.elevated) blockers.push({code:'not_elevated',message:'Restart 1132 Fixer as administrator using the Windows approval prompt.'});
  if (info.interactiveUser === FIX_USER) blockers.push({code:'running_as_target',message:'Sign out of user1 and use a different administrator account before rebuilding it.'});
  try { info.powerShell = resolvePowerShell7(); info.tools.pwsh = true; }
  catch (_) { blockers.push({code:'powershell7_unavailable',message:'PowerShell 7 x64 is required at its protected installation. Ask your administrator to install or repair it; current security policies remain in effect.'}); }
  zoomInstall = await resolveZoomInstall();
  info.zoomInstall = zoomInstall; info.zoomPath = zoomInstall.path;
  if (!info.zoomPath) blockers.push({code:'zoom_not_found',message:zoomDetect.zoomStatusMessage(zoomInstall)});
  if (unresolvedProcessCustody || (repairSession && repairSession.hasUnresolvedCustody())) blockers.push({code:'repair_recovery_required',message:messages.PROCESS_RECOVERY});
  const recovery = await refreshRepairRecovery();
  if (recovery.status !== 'clear' || recovery.verified !== true) blockers.push({code:'repair_recovery_required',message:messages.PROCESS_RECOVERY});
  info.seclogon = {status:'not checked',startType:'not checked',selfHeal:'none'};
  return {ok:blockers.length === 0,blockers,warnings,info};
}

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
  if (fixInProgress || (repairSession && repairSession.inspect().running)) return {success:false,error:'repair_already_running'};
  if (unresolvedProcessCustody) {
    return { success: false, error: 'process_cleanup_unverified' };
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
  } catch (error) {
    if (error && error.code === 'ERR_PROCESS_CLEANUP_UNVERIFIED') {
      return { success: false, error: 'process_cleanup_unverified' };
    }
    if (error && error.code === 'ERR_PROCESS_OUTPUT_TRUNCATED') {
      return { success: false, error: 'command_output_incomplete' };
    }
    throw error;
  } finally {
    fixInProgress = false;
    criticalOps.poll('fix-end');
    if (updaterCtl) sendUpdateStatus(updaterCtl.getStatus());
  }
});

let repairSession = null;
function getRepairSession() {
  if (repairSession) return repairSession;
  const machineId = os.hostname();
  repairSession = createRepairSession({
    machineId, now: Date.now, randomId: () => crypto.randomBytes(16).toString('hex'),
    generatePassword: helperCred.generateHelperPassword,
    createNative: options => createHelperResetWindows({ ...options,
      admission:{verified:true,kind:'recovery-probe',machineId,token:crypto.randomBytes(16).toString('hex')},
      transport:createWindowsRepairTransport({spawn,fs,pwshPath:resolvePowerShell7(),
        onRetained:() => { unresolvedProcessCustody = true; criticalOps.poll('native-custody'); }})
    })
  });
  return repairSession;
}

// Credential persistence is performed by the fixed native workflow, whose
// attestation includes exact CurrentUser protection, ACL and byte readback.

async function runFixFlow(event) {
  const pre = await preflightCheck();
  if (!pre.ok) return {success:false,error:'preflight_failed',blockers:pre.blockers,warnings:pre.warnings};
  // This is the last cooperative cancellation point. The reset and its
  // postconditions remain one machine-owned transaction after this message.
  event.sender.send('fix-log',{line:'[1/8] Checking the exact helper target before changes...',kind:'header'});
  const result = await getRepairSession().run({zoomPath:pre.info.zoomPath,authorizeExactTarget:true,
    onProgress:progress => event.sender.send('fix-log',{line:progress.label,kind:'out',step:progress.step})});
  if (getRepairSession().hasUnresolvedCustody()) {
    unresolvedProcessCustody = true;
    criticalOps.poll('native-custody');
  }
  return result;
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
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    // Bounded: WScript.Shell COM can hang behind a stuck Explorer session.
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch (_) {}
      settle({ success: false, error: 'Creating the shortcut took too long. Try again.' });
    }, 30000);
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => settle({ success: false, error: err.message }));
    child.on('close', async code => {
      if (settled) return;
      if (code !== 0) {
        return settle({ success: false, error: stderr.trim() || `Exit ${code}` });
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

// "Open Zoom" on the Fix-complete screen — runs the SAME launcher script
// the desktop shortcut points at (it unseals the DPAPI credential blob
// itself; no secret rides in argv). Refuses honestly when the pair from
// the last fix run is not on disk.
ipcMain.handle('launch-zoom-helper', async () => {
  const scriptPath = LAUNCHER_SCRIPT_PATH();
  if (!fs.existsSync(scriptPath) || !fs.existsSync(CRED_BLOB_PATH())) {
    return { success: false, reason: 'no stored helper sign-in — run the fix first' };
  }
  // Completion already launched Zoom as user1. Do not start a second copy.
  const already = await runPSCapture(`
    $hit = $false
    try {
      $procs = Get-CimInstance Win32_Process -Filter "Name='Zoom.exe'" -EA SilentlyContinue
      foreach ($p in $procs) {
        $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -EA SilentlyContinue
        if ($o -and ($o.User -ieq '${FIX_USER}')) { $hit = $true; break }
      }
    } catch {}
    if ($hit) { Write-Output 'YES' } else { Write-Output 'NO' }
  `, { timeoutMs: 15000 });
  if ((already.stdout || '').includes('YES')) {
    return { success: true, alreadyRunning: true };
  }
  try {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
      { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
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
  } else if (nativeRecovery.status !== 'clear' || nativeRecovery.verified !== true) {
    state = 'blocked';
    stage = 'repair-recovery';
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

// Feedback is relayed through feedback-proxy/, which holds the GitHub token
// server-side. The app ships NO credential: it posts plain JSON to a public
// url. Anything embedded here would be extractable from app.asar in the
// shipped installer, which is exactly how the old hardcoded token leaked.
// The proxy builds the issue title/body/labels itself, so a tampered client
// can't forge labels or issue content.
// Attach-screenshot UI gate (#141): the renderer shows the control ONLY when
// the proxy advertises the capability — anything else would be a dead button
// while the support platform is dark.
ipcMain.handle('feedback-capabilities', () => supportClient.capabilities(config));

ipcMain.handle('submit-feedback', async (_event, type, text, screenshot, rating) => {
  try {
    return await supportClient.submitFeedback({
      config, type, text, rating, version: app.getVersion(),
      screenshot: screenshot ? {
        bytes: Buffer.from(screenshot.bytes),
        mediaType: screenshot.mediaType
      } : undefined
    });
  } catch (_) {
    // Neither an unexpected exception nor connectivity establishes delivery.
    // Keep private payloads and transport exceptions out of logs and the UI.
    return { success: false, code: 'send_unknown', delivery: 'unknown',
      error: messages.FEEDBACK.SEND_UNKNOWN };
  }
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
  const pre = await preflightCheck();
  const cards = {
    admin:{status:pre.info.elevated?'ready':'blocked',label:'Administrator',message:pre.info.elevated?'Running elevated.':'Use the Windows approval prompt to restart as administrator.'},
    zoom:{status:pre.info.zoomPath?'ready':'blocked',label:'Zoom Workplace',message:zoomDetect.zoomStatusMessage(pre.info.zoomInstall)},
    helperUser:{status:pre.ok?'repairable':'blocked',label:'Helper account',message:'FIX NOW verifies the exact local user1 identity, fully purges its old profile, and creates a fresh standard helper. Missing or uncertain safety evidence stops the repair.'},
    helperProfile:{status:pre.ok?'warning':'blocked',label:'Helper profile',message:'C:\\Users\\user1 and all files within that verified profile are permanently removed during a successful reset. Loaded profiles, unrelated data and uncertain paths are protected.'},
    seclogon:{status:'warning',label:'Secondary Logon',message:'Native launch readiness is checked before the repair changes the helper account.'},
    camPolicy:{status:'warning',label:'Camera policy',message:'Camera policy and per-user consent require verification. Any policy restriction is preserved.'},
    micPolicy:{status:'warning',label:'Microphone policy',message:'Microphone policy and per-user consent require verification. Any policy restriction is preserved.'},
    hku:{status:'warning',label:'User registry hive',message:'The repair verifies profile and hive loading. Uncertain or loaded old profiles prevent cleanup.'},
    frameServer:{status:'warning',label:'Camera Frame Server',message:'Camera service state has not been verified. Camera operation needs separate application checks.'},
    version:{status:'ready',label:'App version',message:'1132 Fixer v'+app.getVersion()}
  };
  return {cards,overall:pre.ok?'repairable':'blocked',canRunFix:pre.ok,blockers:pre.blockers,warnings:pre.warnings,info:pre.info};
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
