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

autoUpdater.autoDownload = true;
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
    readRegisteredInstallDir,
    requestShutdown: (reason) => shutdown.request(reason)
  });
  return updaterCtl;
}

ipcMain.handle('install-update-now', async () => getUpdater().installNow('user'));
ipcMain.handle('defer-update', () => getUpdater().defer());
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
      fatalDialogShown = true;
      killActiveChildren();
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

app.on('before-quit', () => {
  // A quit that nothing in this process asked for (OS session end, a
  // Windows-initiated close) is recorded as such; the first named reason
  // wins so an update restart is never mislabelled.
  const reason = shutdown.note(shutdown.REASONS.SYSTEM_SHUTDOWN);
  // No warning can reopen and no countdown can fire once shutdown began.
  if (inactivityCtl) inactivityCtl.dispose();
  killActiveChildren();
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
        'https://github.com/1132-Fixer/windows/issues\n\n' +
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
        // Kill the TREE, not just the direct child: the profile
        // traversal steps run takeown/icacls via Start-Process inside
        // powershell.exe, and killing only PS orphans a recursive tool
        // mid-cycle — it keeps grinding (and holding profile handles)
        // invisibly. Same idiom as killActiveChildren.
        try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch (_) {}
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

// Output-side twin of the UTF-8 BOM fix below (#93 #111).
// Windows PowerShell 5.1 writes REDIRECTED stdout/stderr in the legacy OEM
// codepage while runProcess decodes the pipes as UTF-8, so any non-ASCII
// character in captured output arrived corrupted \u2014 most damagingly the
// OneDrive-redirected, localized Desktop path from
// [Environment]::GetFolderPath('Desktop') ("\u00c1rea de Trabalho", "\u0420\u0430\u0431\u043e\u0447\u0438\u0439
// \u0441\u0442\u043e\u043b", accented user names), which then fed shortcut creation a folder
// that does not exist. Forcing the console output encoding to UTF-8 as the
// script's first statement makes PS emit what Node decodes. try/catch: the
// setter needs a console handle; if it ever fails we degrade to today's
// behavior instead of breaking the script.
const PS_UTF8_OUTPUT_PREAMBLE =
  'try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}\r\n';

async function runPSScript(scriptContent, onLine, opts = {}) {
  const tmp = path.join(os.tmpdir(),
    `fixer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less files in the legacy
  // system codepage, which corrupts non-ASCII install paths interpolated
  // into the script (review P2 on custom Unicode Zoom dirs).
  await fs.promises.writeFile(tmp, '\ufeff' + PS_UTF8_OUTPUT_PREAMBLE + scriptContent, 'utf8');
  try {
    return await runProcess('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      onLine, opts);
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

// Zoom-launch runner. Start-Process -Credential
// (CreateProcessWithLogonW) makes the launched Zoom inherit the parent
// PowerShell's std handles. The old stdio:'ignore' variant existed because
// with plain runPSScript pipes, Zoom held our stderr pipe open after PS
// exited, so the 'close' event never fired and run-fix froze at Step 5 —
// but 'ignore' also threw away the launcher's "Launch failed: <exception>"
// line, leaving launch_failed diagnoses to a guess-list (#54 #58 #64 #66
// #70 #72). This variant keeps BOTH properties:
//   - detach semantics preserved: Start-Process without -Wait creates a
//     free-standing process; PS exits right after dispatch, and we resolve
//     on 'exit' (process ended) instead of 'close' (pipes drained), so a
//     Zoom that inherited our pipe handles can never wedge the step. The
//     pipes are destroyed after a short drain race; Zoom writing to a
//     broken pipe is the same do-nothing sink 'ignore' gave it.
//   - the launcher's own output (written before PS exits) is captured and
//     returned, so the exact Start-Process exception reaches the log.
// The 30s guard kills only powershell.exe (never the credential-launched
// Zoom — child.kill targets the PS pid alone). Callers still verify launch
// success out-of-band by polling Win32_Process — capture is evidence, the
// poll stays the authority.
async function runPSScriptLaunchCapture(scriptContent) {
  const tmp = path.join(os.tmpdir(),
    `fixer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  // UTF-8 BOM: Windows PowerShell 5.1 reads BOM-less files in the legacy
  // system codepage, which corrupts non-ASCII install paths interpolated
  // into the script (review P2 on custom Unicode Zoom dirs). The output
  // preamble keeps the captured launch-failure lines (localized exception
  // text) decodable \u2014 same OEM-vs-UTF-8 mismatch as runPSScript.
  await fs.promises.writeFile(tmp, '\ufeff' + PS_UTF8_OUTPUT_PREAMBLE + scriptContent, 'utf8');
  return new Promise((resolve) => {
    let stdoutBuf = '';
    let settled = false;
    let killTimer = null;
    let timedOut = false;
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
      { windowsHide: true });
    child.stdout.on('data', d => { stdoutBuf += d.toString(); });
    child.stderr.on('data', d => { stdoutBuf += d.toString(); });
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      try { child.stdout.destroy(); } catch (_) {}
      try { child.stderr.destroy(); } catch (_) {}
      fs.promises.unlink(tmp).catch(() => {});
      resolve({ code, stdout: stdoutBuf, timedOut });
    };
    killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      settle(-1);
    }, 30000);
    child.on('error', () => settle(-1));
    child.on('exit', (code) => {
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
    const child = spawn('net.exe', ['user', username], { windowsHide: true });
    const timer = setTimeout(() => {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }); } catch (_) {}
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
        ? 'PowerShell probe timed out after 20s — Windows tool inventory unavailable. Antivirus or Defender may be blocking powershell.exe. Add 1132 Fixer to your antivirus exclusions (or pause its script shield), then reopen the app to re-check.'
        : 'PowerShell probe failed — could not verify Windows tools. Treating powershell.exe as unavailable. Restart the app once; if this repeats, check that Windows PowerShell is installed and not blocked by AppLocker or antivirus, then re-check.'
    });
    presence = {};
    for (const t of REQUIRED_TOOLS) presence[t] = false;
    for (const t of OPTIONAL_TOOLS) presence[t] = false;
  }
  info.tools = presence;
  info.seclogon = {
    status: presence.seclogon_status || 'not checked',
    startType: presence.seclogon_starttype || 'not checked',
    selfHeal: 'none'
  };
  for (const t of REQUIRED_TOOLS) {
    if (!presence[t]) {
      blockers.push({
        code: 'missing_tool',
        message: `Required Windows tool not on PATH: ${t}. It ships with Windows — an aggressive cleanup tool or a broken PATH removed it. Restore ${t} (or repair PATH under System Properties > Environment Variables), then reopen the app to re-check.`
      });
    }
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
    warnings.push({
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
      $null = & sc.exe start seclogon 2>&1
      $deadline = [DateTime]::UtcNow.AddSeconds(8)
      do {
        try { if ((Get-Service seclogon -EA Stop).Status -eq 'Running') { Write-Output 'SECLOGON_HEAL=RUNNING'; exit 0 } } catch {}
        Start-Sleep -Milliseconds 400
      } while ([DateTime]::UtcNow -lt $deadline)
      $st = ''
      try { $st = [string](Get-Service seclogon -EA Stop).Status } catch { $st = 'unreadable' }
      Write-Output ('SECLOGON_HEAL=FAILED=' + $st)
    `, { timeoutMs: 10000 });
    if (/SECLOGON_HEAL=RUNNING/.test(heal.stdout || '')) {
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
    warnings.push({
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
// Check whether user is in local Administrators (S-1-5-32-544) by SID.
// Falls back to `net localgroup` parsing. Returns { inGroup, method, raw }.
// user1 must NOT be a member (SEC-A6) — the fix flow uses this to detect
// a legacy admin user1 and to confirm the membership removal took.
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
            Start-Process takeown.exe -ArgumentList @('/F',$dir,'/A','/D','Y') -Wait -WindowStyle Hidden | Out-Null
            Start-Process icacls.exe -ArgumentList @($dir,'/grant','*S-1-5-32-544:F','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
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
                # takeown /R, icacls /T and attrib /S follow junctions — only
                # run them once the subtree is confirmed junction-free
                # (hang guard); otherwise leave the child to the rd retry.
                if (Remove-NestedReparsePoints -Root $k.FullName) {
                    Start-Process takeown.exe -ArgumentList @('/F',$k.FullName,'/A','/R','/D','Y') -Wait -WindowStyle Hidden | Out-Null
                    Start-Process icacls.exe -ArgumentList @($k.FullName,'/grant','*S-1-5-32-544:(OI)(CI)F','/T','/C','/Q') -Wait -WindowStyle Hidden | Out-Null
                    Start-Process attrib.exe -ArgumentList @('-r','-h','-s',$k.FullName,'/S','/D') -Wait -WindowStyle Hidden | Out-Null
                } else {
                    Write-Host ("    not junction-free; skipping recursive ACL fix for " + $k.Name + " (rd retry still runs)")
                }
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
  // never print the secret, never put it on CreateProcess argv.
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
    send(`  ${ok ? 'OK ' : 'MISS'}  ${t}`, ok ? 'out' : 'err');
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

  // SECURITY (SEC-A6): the helper account is no longer an administrator —
  // every privileged repair step runs under this app's own elevated token,
  // and user1 only runs Zoom. A user1 left in Administrators by an older
  // version gets the membership removed here, BEFORE the delete→recreate,
  // so even a failed delete leaves no admin rights behind. Removal is
  // SID-first with a net-localgroup fallback (same technique the old
  // add-path used); a failed removal warns — never fails the run — because
  // the recreate in STEP 4 builds a standard account either way.
  if (accountExisted) {
    const legacyAdmin = await verifyAdminMembership(FIX_USER);
    if (legacyAdmin.inGroup) {
      send(`  '${FIX_USER}' is in the Administrators group — removing rights it no longer needs...`, 'out');
      await runPSScript(`
        try { Remove-LocalGroupMember -SID 'S-1-5-32-544' -Member '${FIX_USER}' -EA Stop; Write-Host '  Remove-LocalGroupMember OK.' }
        catch {
          Write-Host ('  Remove-LocalGroupMember failed: ' + $_.Exception.Message)
          $r = net localgroup Administrators '${FIX_USER}' /delete 2>&1
          Write-Host ('  net localgroup fallback: ' + ($r | Out-String).Trim())
        }
      `, send, { heartbeatMs: 5000, heartbeatLabel: 'admin-rights removal', timeoutMs: 60000 });
      const adminRecheck = await verifyAdminMembership(FIX_USER);
      if (!adminRecheck.inGroup) {
        send('  Removed administrator rights the helper account no longer needs.', 'out');
        step('remove-admin-rights', `Remove administrator rights from ${FIX_USER}`, 'ok',
          'Removed administrator rights the helper account no longer needs');
      } else {
        send(`  WARNING: could not remove '${FIX_USER}' from the Administrators group.`, 'err');
        send('  The account is deleted and rebuilt as a standard user below either way.', 'err');
        step('remove-admin-rights', `Remove administrator rights from ${FIX_USER}`, 'warn',
          `'${FIX_USER}' was still visible in the Administrators group after the removal attempt — the rebuilt account is created without admin rights regardless`);
      }
    }
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
          $stop  = & sc.exe stop  ProfSvc 2>&1
          Start-Sleep -Seconds 2
          $start = & sc.exe start ProfSvc 2>&1
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
    & reg.exe flush HKLM 2>&1 | Out-Null
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
    const profsvcNeeded = accountExisted || profileFolderExisted;
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
  // Password rides in a tmp PowerShell file (same residual as Zoom launch)
  // — never as a net.exe CreateProcess argument, which Win32_Process would
  // enumerate. /y auto-answers net.exe's ">14 characters" DOS-compat prompt.
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
  // fixPass is interpolated into a single-quoted PS string inside a tmp
  // script file (runPSScriptLaunchCapture) — never onto a command line where
  // Win32_Process could enumerate it. The tmp file is unlinked after the run;
  // its seconds-long lifetime is the accepted residual (see PR notes).
  const launchPs = `
    $pw = ConvertTo-SecureString '${fixPass}' -AsPlainText -Force
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
  const launch = await runPSScriptLaunchCapture(launchPs);
  // The launcher writes '  Zoom launched as user1.' on success or
  // '  Launch failed: <exception>' before exit 1 — captured now,
  // so the exact Start-Process error reaches the log instead of a guess-list.
  const launchFailLine = (launch.stdout || '').split(/\r?\n/)
    .map(s => s.trim()).find(l => l.startsWith('Launch failed: ')) || '';
  if (launch.code !== 0 && launch.code !== null) {
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
    if (launchFailLine) {
      // The exact exception beats the guess-list; messages.js
      // launch_failed copy already points the user at this log line.
      send(`  PowerShell launcher reported: ${launchFailLine}`, 'err');
    } else {
      send('  Likely causes: Secondary Logon disabled, password policy mismatch, or Zoom crashed on startup.', 'err');
      send('  Try: sc.exe config seclogon start= demand && sc.exe start seclogon', 'err');
    }
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
        $lnk.TargetPath = 'powershell.exe'
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
  const relaunch = await runPSScriptLaunchCapture(launchPs);
  if (relaunch.code !== 0 && relaunch.code !== null) {
    const relaunchFailLine = (relaunch.stdout || '').split(/\r?\n/)
      .map(s => s.trim()).find(l => l.startsWith('Launch failed: ')) || '';
    warnings.push({
      code: 'relaunch_failed',
      message: `Initial launch succeeded but the relaunch ${relaunchFailLine ? `failed — ${relaunchFailLine}` : `exited with code ${relaunch.code}`}. Open Zoom manually.`
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

ipcMain.handle('submit-feedback', async (event, type, text, screenshot) => {
  try {
    const version = app.getVersion();
    const endpoint = config.FEEDBACK_PROXY_URL;
    if (!endpoint) {
      return { success: false, error: 'Feedback service not configured' };
    }

    // A report carrying a screenshot goes through the /v1 support API — the
    // legacy /feedback contract caps bodies at 8 KB and cannot carry an
    // image. Screenshot bytes are never logged.
    if (screenshot && screenshot.bytes && screenshot.bytes.length) {
      return supportClient.submitBugWithScreenshot({
        config,
        userDataDir: app.getPath('userData'),
        safeStorage,
        version,
        osLabel: `Windows ${os.release()}`,
        text,
        screenshot: {
          bytes: Buffer.from(screenshot.bytes),
          mediaType: String(screenshot.mediaType || ''),
        },
      });
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
    # Helper-account health: existence, plus Administrators membership to
    # detect a LEGACY admin user1 that FIX NOW must strip (SEC-A6 — membership
    # is no longer created and no longer healthy). SID-based, same technique
    # as verifyAdminMembership — Get-LocalGroupMember chokes on orphaned SIDs,
    # so fall back to net localgroup parsing.
    $out['user1_exists'] = $false
    try { if (Get-LocalUser -Name '${FIX_USER}' -EA SilentlyContinue) { $out['user1_exists'] = $true } } catch {}
    $out['user1_admin'] = $false
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
        status: 'warning', label: 'Secondary Logon',
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
