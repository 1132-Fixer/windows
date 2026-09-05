'use strict';

/**
 * Update lifecycle controller for 1132 Fixer (Windows, NSIS install).
 *
 * One explicit state machine owns every step from "check" to "the new
 * version is running":
 *
 *   idle -> checking -> available -> downloading -> verifying -> ready
 *        -> installing -> restarting -> (new process) updated
 *   any step can end in failed; a failed or unverified handoff found at the
 *   next start is recovery.
 *
 * Why this exists (root cause, September 2026): releases since 6.3.1 strip
 * `resources/elevate.exe` from the package (Smart App Control policy), but
 * electron-builder still writes `isAdminRightsRequired: true` into latest.yml
 * for a per-machine one-click installer. electron-updater's quitAndInstall()
 * therefore spawned a helper that does not exist, the spawn error arrived
 * after app.quit() had already been scheduled, and the app closed with
 * nothing installed. The downloaded installer stayed in the updater cache,
 * so every later launch re-armed the same 10-second restart and closed the
 * app again.
 *
 * The app already runs elevated (requireAdministrator manifest plus
 * self-elevation at start), so it starts the NSIS installer itself in silent
 * update mode — the same `--updated /S` invocation electron-updater uses —
 * pins the install directory with `/D=`, and asks the installer to relaunch
 * the installed executable (`--fixer-relaunch`, handled by
 * build/installer.nsh) from inside the elevated install, in the interactive
 * user's session, with no second approval prompt. quitAndInstall() and
 * autoInstallOnAppQuit are not used.
 *
 * Everything that touches Electron, the file system, child processes, the
 * registry or the clock is injected so tools/updater-lifecycle-smoke.js can
 * drive every branch deterministically.
 */

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  READY: 'ready',
  INSTALLING: 'installing',
  RESTARTING: 'restarting',
  UPDATED: 'updated',
  FAILED: 'failed',
  RECOVERY: 'recovery'
});

const STAGES = Object.freeze({
  CHECK: 'check',
  METADATA: 'metadata',
  DOWNLOAD: 'download',
  VERIFY: 'verify',
  PREPARE: 'prepare',
  ELEVATION: 'elevation',
  LOCATION: 'location',
  INSTALLER_LAUNCH: 'installer-launch',
  INSTALL: 'install',
  RELAUNCH: 'relaunch'
});

// States during which the app must not be closed by anything but the
// updater's own handoff (inactivity exit, for instance, suspends here).
const CRITICAL_STATES = new Set([
  STATES.CHECKING, STATES.AVAILABLE, STATES.DOWNLOADING, STATES.VERIFYING,
  STATES.INSTALLING, STATES.RESTARTING
]);

const RELAUNCH_FLAG = '--fixer-relaunch';
const UPDATED_FLAG = '--updated';
const HANDOFF_FILE = 'update-handoff.json';
const STATE_FILE = 'update-state.json';
const HANDOFF_SCHEMA = 1;
const HANDOFF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESTART_COUNTDOWN_SECONDS = 10;
const MAX_AUTO_INSTALL_ATTEMPTS = 2;   // automatic countdown allowed below this
const MAX_TOTAL_INSTALL_ATTEMPTS = 4;  // after this only the manual download remains
const BACKOFF_MS = [0, 15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000];
const SPAWN_CONFIRM_MS = 5000;
// How long the install waits for the renderer to confirm the blocking
// "Installing update" notice is on screen before the main process starts
// the installer. Starting a 118 MB unsigned installer blocks the main
// process for several seconds (Windows scans it in CreateProcess); without
// this wait the notice could be sent but never painted before the app exits.
const NOTICE_CONFIRM_MS = 1500;
const CHECK_TIMEOUT_MS = 30 * 1000;   // a check never sits in "Checking for updates" longer than this
const PRODUCT_EXE = '1132 Fixer.exe';
// Installer artifact: 1132-Fixer-Setup-<semver>[-<arch>].exe. The arch
// suffix is split off first so a prerelease tag can never swallow it.
const ARTIFACT_ARCH_RE = /-(x64|arm64|ia32)\.exe$/i;
const ARTIFACT_RE = /^1132-Fixer-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/;
function parseArtifactName(name) {
  const s = String(name || '');
  const archMatch = ARTIFACT_ARCH_RE.exec(s);
  const arch = archMatch ? archMatch[1].toLowerCase() : null;
  const core = archMatch ? s.slice(0, archMatch.index) + '.exe' : s;
  const m = ARTIFACT_RE.exec(core);
  if (!m) return null;
  return { version: m[1], arch: arch || 'x64', explicitArch: !!arch };
}
// electron-builder: UUID v5(appId, ELECTRON_BUILDER_NS_UUID) for
// com.hightexas.1132fixer. The installer reads InstallLocation from this key.
const INSTALL_REGISTRY_KEY = 'HKLM\\Software\\c20c91ed-7fa6-5700-98ba-65c22b67c802';
const LEGACY_INSTALL_REGISTRY_KEY = 'HKLM\\Software\\1132Fixer';

// ------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------

function parseSemver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) { if (+x !== +y) return +x < +y ? -1 : 1; continue; }
    if (nx) return -1;
    if (ny) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function channelOf(version) {
  const p = parseSemver(version);
  return p && p.pre.length ? 'beta' : 'stable';
}

function normalizePath(p) {
  if (typeof p !== 'string' || !p) return '';
  return path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
}

function samePath(a, b) {
  return normalizePath(a) !== '' && normalizePath(a) === normalizePath(b);
}

// Validates the release metadata electron-updater resolved for us BEFORE
// anything is trusted from it. Returns { ok, reason, file } where file is
// the chosen installer entry.
function validateUpdateInfo(info, ctx) {
  const current = ctx.currentVersion;
  const arch = ctx.arch || 'x64';
  if (!info || typeof info !== 'object') return { ok: false, reason: 'metadata-missing' };
  const target = String(info.version || '');
  if (!parseSemver(target)) return { ok: false, reason: 'metadata-version-invalid' };
  const cmp = compareSemver(target, current);
  if (Number.isNaN(cmp)) return { ok: false, reason: 'metadata-version-invalid' };
  if (cmp <= 0) return { ok: false, reason: cmp === 0 ? 'metadata-version-current' : 'metadata-version-older' };
  if (channelOf(target) === 'beta' && (ctx.channel || 'stable') !== 'beta') {
    return { ok: false, reason: 'metadata-prerelease-on-stable' };
  }
  const files = Array.isArray(info.files) && info.files.length ? info.files : (info.path ? [{ url: info.path, sha512: info.sha512, size: info.size }] : []);
  const exes = files.filter((f) => f && typeof f.url === 'string' && /\.exe$/i.test(f.url));
  if (!exes.length) return { ok: false, reason: 'metadata-no-installer' };
  let chosen = null;
  for (const f of exes) {
    const name = path.posix.basename(String(f.url).split('?')[0].replace(/\\/g, '/'));
    const parsed = parseArtifactName(name);
    if (!parsed) continue;
    if (parsed.version !== target) return { ok: false, reason: 'metadata-artifact-version-mismatch', detail: name };
    if (parsed.arch !== arch) continue;
    chosen = { name, sha512: f.sha512 || '', size: Number(f.size) || 0, url: f.url, arch: parsed.arch };
    break;
  }
  if (!chosen) {
    const named = exes.map((f) => path.posix.basename(String(f.url).replace(/\\/g, '/')));
    const anyMatch = named.some((n) => parseArtifactName(n) !== null);
    return { ok: false, reason: anyMatch ? 'metadata-arch-mismatch' : 'metadata-artifact-name', detail: named.join(', ') };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(chosen.sha512) || chosen.sha512.length < 64) {
    return { ok: false, reason: 'metadata-sha512-missing' };
  }
  return { ok: true, file: chosen, target };
}

function buildInstallerArgs({ installDir, relaunch }) {
  const args = [UPDATED_FLAG, '/S'];
  if (relaunch) args.push(RELAUNCH_FLAG);
  // NSIS: /D= must be the last parameter and must not be quoted, even when
  // the directory contains spaces. The spawn uses windowsVerbatimArguments
  // so this exact string reaches the installer.
  args.push(`/D=${installDir}`);
  return args;
}

function buildHandoffRecord(fields) {
  return {
    schema: HANDOFF_SCHEMA,
    currentVersion: fields.currentVersion,
    targetVersion: fields.targetVersion,
    execPath: fields.execPath,
    installDir: fields.installDir,
    channel: fields.channel,
    artifact: { name: fields.artifact.name, sha512: fields.artifact.sha512, size: fields.artifact.size },
    relaunchRequested: !!fields.relaunchRequested,
    attempt: fields.attempt || 1,
    timestamp: fields.timestamp,
    state: fields.state || 'installing',
    installerPid: fields.installerPid || null
  };
}

function parseHandoffRecord(text) {
  try {
    const r = JSON.parse(text);
    if (!r || r.schema !== HANDOFF_SCHEMA) return null;
    if (typeof r.targetVersion !== 'string' || typeof r.currentVersion !== 'string') return null;
    if (typeof r.installDir !== 'string' || typeof r.execPath !== 'string') return null;
    return r;
  } catch (_) {
    return null;
  }
}

// What a fresh process should conclude from a handoff record left by the
// previous one. Pure; the controller acts on the verdict.
function evaluateStartup({ record, currentVersion, execPath, argv, nowMs }) {
  const flagged = Array.isArray(argv) && argv.includes(RELAUNCH_FLAG);
  if (!record) {
    return { state: STATES.IDLE, reason: flagged ? 'relaunch-flag-without-record' : null, clear: false };
  }
  const age = nowMs - Date.parse(record.timestamp || 0);
  if (!Number.isFinite(age) || age > HANDOFF_MAX_AGE_MS) {
    return { state: STATES.IDLE, reason: 'handoff-stale', clear: true, record };
  }
  const expectedExe = path.win32.join(record.installDir, path.win32.basename(record.execPath) || PRODUCT_EXE);
  const pathOk = samePath(execPath, expectedExe);
  const versionOk = compareSemver(currentVersion, record.targetVersion) === 0;
  if (record.state === 'installing') {
    // Written before the installer was confirmed running: the launch never
    // completed (or the previous process died between the write and spawn).
    return { state: STATES.RECOVERY, stage: STAGES.INSTALLER_LAUNCH, reason: 'installer-not-started', clear: false, record, flagged };
  }
  if (versionOk && pathOk) {
    return { state: STATES.UPDATED, reason: flagged ? 'relaunch-verified' : 'manual-reopen-verified', clear: false, record, flagged };
  }
  if (versionOk && !pathOk) {
    return { state: STATES.RECOVERY, stage: STAGES.RELAUNCH, reason: 'unexpected-executable-path', detail: execPath, clear: false, record, flagged };
  }
  const older = compareSemver(currentVersion, record.targetVersion) < 0;
  return {
    state: STATES.RECOVERY,
    stage: STAGES.INSTALL,
    reason: older ? 'previous-version-running' : 'version-mismatch',
    detail: `running ${currentVersion}, expected ${record.targetVersion}`,
    clear: false,
    record,
    flagged
  };
}

function attemptsFor(stateDoc, target) {
  const a = stateDoc && stateDoc.attempts && stateDoc.attempts[target];
  return a && typeof a.count === 'number' ? a : { count: 0, lastAt: 0, lastStage: null, lastReason: null };
}

function retryPolicy(stateDoc, target, nowMs) {
  const a = attemptsFor(stateDoc, target);
  const idx = Math.min(a.count, BACKOFF_MS.length - 1);
  const backoff = BACKOFF_MS[idx];
  const waitMs = Math.max(0, (a.lastAt || 0) + backoff - nowMs);
  return {
    attempts: a.count,
    autoInstallAllowed: a.count < MAX_AUTO_INSTALL_ATTEMPTS,
    installAllowed: a.count < MAX_TOTAL_INSTALL_ATTEMPTS,
    autoCheckAllowed: waitMs === 0,
    waitMs,
    lastStage: a.lastStage,
    lastReason: a.lastReason
  };
}

async function hashFileSha512(file, fsImpl) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    let size = 0;
    const s = (fsImpl || fs).createReadStream(file);
    s.on('data', (c) => { size += c.length; h.update(c); });
    s.on('error', reject);
    s.on('end', () => resolve({ sha512: h.digest('base64'), size }));
  });
}

// ------------------------------------------------------------
// Controller
// ------------------------------------------------------------

function createUpdaterController(deps) {
  const {
    autoUpdater,
    log,
    emit,
    currentVersion,
    execPath,
    argv = [],
    arch = 'x64',
    platform = 'win32',
    userDataDir,
    isPackaged = true,
    isPortable = false,
    isElevated = async () => true,
    isBusy = () => false,
    hasUpdateConfig = () => true,
    spawnInstaller,
    confirmNotice = async () => ({ shown: null, ms: 0 }),
    readRegisteredInstallDir = async () => null,
    hashFile = hashFileSha512,
    fs: fsImpl = fs,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    requestShutdown,
    restartCountdownSeconds = RESTART_COUNTDOWN_SECONDS
  } = deps;

  const installDir = path.win32.dirname(execPath);
  const channel = deps.channel || channelOf(currentVersion);
  const executionMode = !isPackaged ? 'development' : (isPortable ? 'portable' : 'installed');
  const handoffFile = path.join(userDataDir, HANDOFF_FILE);
  const stateFile = path.join(userDataDir, STATE_FILE);

  let state = STATES.IDLE;
  let stage = null;
  let reason = null;
  let detail = null;
  let target = null;          // { version, file: {name, sha512, size}, downloadedFile, verifiedStat }
  let percent = 0;
  let deferred = false;
  let countdownTimer = null;
  let countdownEndsAt = 0;
  let handoffStarted = false;  // exactly-once guard for the whole process lifetime
  let registered = false;
  let startupVerdict = null;
  let readyMarked = false;
  let lastCheckAt = 0;
  let checkInFlight = false;
  let lastCheckOrigin = null;
  let sessionDismissedCheck = false;
  let quiet = false;
  const checkTimeoutMs = deps.checkTimeoutMs || CHECK_TIMEOUT_MS;
  const eventCounts = {};

  // ---- persistence -------------------------------------------------
  function readStateDoc() {
    try { return JSON.parse(fsImpl.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { return {}; }
  }
  function writeStateDoc(doc) {
    try {
      fsImpl.mkdirSync(path.dirname(stateFile), { recursive: true });
      fsImpl.writeFileSync(stateFile, JSON.stringify(doc, null, 2), 'utf8');
    } catch (err) {
      log.warn('state.write-failed', { error: err });
    }
  }
  function recordAttempt(targetVersion, st, why) {
    const doc = readStateDoc();
    doc.schema = 1;
    doc.attempts = doc.attempts || {};
    const a = attemptsFor(doc, targetVersion);
    doc.attempts[targetVersion] = { count: a.count + 1, lastAt: now(), lastStage: st || null, lastReason: why || null };
    writeStateDoc(doc);
    return doc.attempts[targetVersion].count;
  }
  function recordOutcome(targetVersion, st, why) {
    const doc = readStateDoc();
    doc.attempts = doc.attempts || {};
    const a = attemptsFor(doc, targetVersion);
    doc.attempts[targetVersion] = Object.assign({}, a, { lastStage: st || a.lastStage, lastReason: why || a.lastReason });
    doc.lastOutcome = { targetVersion, stage: st || null, reason: why || null, at: now() };
    writeStateDoc(doc);
  }
  function readHandoff() {
    try { return parseHandoffRecord(fsImpl.readFileSync(handoffFile, 'utf8')); } catch (_) { return null; }
  }
  function writeHandoff(record) {
    fsImpl.mkdirSync(path.dirname(handoffFile), { recursive: true });
    const tmp = `${handoffFile}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fsImpl.renameSync(tmp, handoffFile);
  }
  function clearHandoff(why) {
    try { fsImpl.unlinkSync(handoffFile); log.info('handoff.cleared', { reason: why }); } catch (err) {
      if (!err || err.code !== 'ENOENT') log.warn('handoff.clear-failed', { error: err });
    }
  }

  // ---- state ---------------------------------------------------------
  function payload() {
    const policyVersion = target ? target.version : (startupVerdict && startupVerdict.record ? startupVerdict.record.targetVersion : null);
    const policy = policyVersion ? retryPolicy(readStateDoc(), policyVersion, now()) : null;
    return {
      state,
      stage,
      reason,
      current: currentVersion,
      version: target ? target.version : (startupVerdict && startupVerdict.record ? startupVerdict.record.targetVersion : null),
      percent,
      seconds: countdownEndsAt ? Math.max(0, Math.ceil((countdownEndsAt - now()) / 1000)) : 0,
      deferred,
      attempts: policy ? policy.attempts : (startupVerdict && startupVerdict.record ? startupVerdict.record.attempt || 0 : 0),
      canRetry: policy ? policy.installAllowed : true,
      quiet,
      executionMode,
      channel
    };
  }
  function setState(next, extra = {}) {
    const prev = state;
    state = next;
    if ('stage' in extra) stage = extra.stage;
    if ('reason' in extra) reason = extra.reason;
    if ('detail' in extra) detail = extra.detail;
    if (next !== STATES.READY) cancelCountdown();
    log.info('state', { from: prev, to: next, stage, reason, detail, target: target ? target.version : null });
    try { emit(payload()); } catch (_) { /* renderer gone */ }
  }
  function fail(st, why, extra = {}) {
    const targetVersion = target ? target.version : null;
    if (targetVersion) recordOutcome(targetVersion, st, why);
    log.error('update.failed', Object.assign({ stage: st, reason: why, target: targetVersion }, extra));
    // A failed CHECK the user already dismissed this session stays quiet
    // when a later automatic re-check fails the same way; a user-initiated
    // retry always reports.
    quiet = st === STAGES.CHECK && sessionDismissedCheck && lastCheckOrigin !== 'user' && lastCheckOrigin !== 'retry';
    setState(STATES.FAILED, { stage: st, reason: why, detail: extra.detail || null });
  }

  // Which kind of failure this is, in the words the UI needs (never the
  // library's). Error codes and messages stay in the log.
  function classifyError(err) {
    const code = String((err && err.code) || '').toUpperCase();
    const msg = String((err && err.message) || err || '');
    const status = (err && (err.statusCode || err.status)) || (/HTTP (\d{3})|status(?:Code)?[:= ]+(\d{3})/i.exec(msg) || [])[1];
    if (/ENOTFOUND|ENETUNREACH|ECONNREFUSED|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION_REFUSED|ERR_PROXY_CONNECTION_FAILED/.test(code + ' ' + msg)) return 'offline';
    if (/ETIMEDOUT|ESOCKETTIMEDOUT|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|\btimeout\b|timed out/i.test(code + ' ' + msg)) return 'timeout';
    if (/ERR_UPDATER_INVALID_VERSION|ERR_UPDATER_INVALID_CHANNEL|ERR_UPDATER_ZIP_FILE_NOT_FOUND|cannot parse|Unable to find latest version|latest\.yml|YAML|Unexpected token|JSON/i.test(code + ' ' + msg)) return 'invalid-response';
    if (/ERR_UPDATER_CHANNEL_FILE_NOT_FOUND|no compatible|ERR_UPDATER_ASSET/i.test(code + ' ' + msg)) return 'no-compatible-asset';
    if (/ERR_UPDATER_INVALID_SIGNATURE|sha512|checksum|ERR_UPDATER_CHECKSUM/i.test(code + ' ' + msg)) return 'integrity-failed';
    if (/ECONNRESET|EPIPE|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|aborted/i.test(code + ' ' + msg)) return state === STATES.DOWNLOADING ? 'download-failed' : 'service-unavailable';
    const n = Number(status);
    if (n >= 500 || n === 403 || n === 404 || n === 429) return 'service-unavailable';
    if (n >= 400) return 'invalid-response';
    return state === STATES.DOWNLOADING ? 'download-failed' : 'library-error';
  }
  function cancelCountdown() {
    if (countdownTimer) { clearTimer(countdownTimer); countdownTimer = null; }
    countdownEndsAt = 0;
  }
  function stageForState() {
    switch (state) {
      case STATES.CHECKING: return STAGES.CHECK;
      case STATES.AVAILABLE: return STAGES.METADATA;
      case STATES.DOWNLOADING: return STAGES.DOWNLOAD;
      case STATES.VERIFYING: return STAGES.VERIFY;
      case STATES.INSTALLING: return STAGES.INSTALLER_LAUNCH;
      default: return STAGES.CHECK;
    }
  }

  // ---- library events (registered once) ----------------------------
  function count(name) { eventCounts[name] = (eventCounts[name] || 0) + 1; return eventCounts[name]; }

  function onChecking() {
    count('checking-for-update');
    if (state !== STATES.CHECKING) {
      // The library can emit this for a check we did not start (e.g. a
      // second checkForUpdates from an older code path); only log it.
      log.info('check.event-outside-checking', { state });
      return;
    }
    log.info('check.start', { feed: describeFeed() });
  }

  function onAvailable(info) {
    count('update-available');
    if (state !== STATES.CHECKING && state !== STATES.IDLE) {
      log.warn('event.ignored', { event: 'update-available', state });
      return;
    }
    const v = validateUpdateInfo(info, { currentVersion, arch, channel });
    log.info('metadata.resolved', { version: info && info.version, files: info && info.files ? info.files.map((f) => f && f.url) : null, releaseDate: info && info.releaseDate, ok: v.ok, reason: v.reason, detail: v.detail });
    if (!v.ok) {
      // autoDownload is on; the library will start fetching the file it
      // resolved. We refuse to ever hand that file to the installer: the
      // verify step re-checks the same invariants against what landed.
      target = null;
      fail(STAGES.METADATA, v.reason, { detail: v.detail || null });
      return;
    }
    target = { version: v.target, file: v.file, downloadedFile: null, verifiedStat: null };
    percent = 0;
    // A positively verified newer version. The download waits for the user
    // ("Download update"); autoDownload is off in main.js.
    setState(STATES.AVAILABLE, { stage: null, reason: null });
    log.info('update.available', { target: v.target, artifact: v.file.name, size: v.file.size });
  }

  // "Download update": exactly one download per available version.
  async function download(origin) {
    if (state !== STATES.AVAILABLE || !target) {
      log.info('download.refused', { origin, state });
      return { ok: false, reason: state === STATES.DOWNLOADING ? 'already-downloading' : 'not-available' };
    }
    percent = 0;
    setState(STATES.DOWNLOADING, { stage: STAGES.DOWNLOAD, reason: null });
    log.info('download.start', { origin, target: target.version, artifact: target.file.name, size: target.file.size });
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      // dispatchError already routed this through onError → failed(download).
      if (state === STATES.DOWNLOADING) fail(STAGES.DOWNLOAD, classifyError(err), { error: err });
      return { ok: false, reason: 'download-failed' };
    }
  }

  function onNotAvailable(info) {
    count('update-not-available');
    if (state === STATES.CHECKING) {
      log.info('check.up-to-date', { latest: info && info.version });
      target = null;
      setState(STATES.IDLE, { stage: null, reason: null });
    }
  }

  function onProgress(p) {
    if (state !== STATES.DOWNLOADING) return;
    const pct = Math.max(0, Math.min(100, Math.floor((p && p.percent) || 0)));
    if (pct - percent >= 5 || pct === 100) {
      percent = pct;
      log.info('download.progress', { percent: pct, transferred: p && p.transferred, total: p && p.total });
      try { emit(payload()); } catch (_) { /* ignore */ }
    }
  }

  async function onDownloaded(info) {
    const n = count('update-downloaded');
    if (state !== STATES.DOWNLOADING) {
      log.warn('event.ignored', { event: 'update-downloaded', state, occurrence: n });
      return;
    }
    percent = 100;
    setState(STATES.VERIFYING);
    const downloadedFile = info && typeof info.downloadedFile === 'string' ? info.downloadedFile : null;
    const v = await verifyDownloaded(info, downloadedFile);
    if (state !== STATES.VERIFYING) return; // superseded (e.g. shutdown)
    if (!v.ok) {
      fail(STAGES.VERIFY, v.reason, { detail: v.detail || null });
      return;
    }
    target.downloadedFile = downloadedFile;
    target.verifiedStat = v.stat;
    log.info('verify.ok', { target: target.version, artifact: target.file.name, size: v.stat.size, sha512Prefix: target.file.sha512.slice(0, 12) });
    const policy = retryPolicy(readStateDoc(), target.version, now());
    deferred = false;
    setState(STATES.READY, { stage: null, reason: null });
    if (!policy.installAllowed) {
      log.warn('ready.install-disallowed', { attempts: policy.attempts, lastStage: policy.lastStage, lastReason: policy.lastReason });
      setState(STATES.RECOVERY, { stage: policy.lastStage || STAGES.INSTALL, reason: 'retry-limit-reached' });
      return;
    }
    if (isBusy()) {
      deferred = true;
      log.info('ready.deferred', { reason: 'busy' });
      try { emit(payload()); } catch (_) { /* ignore */ }
      return;
    }
    if (!policy.autoInstallAllowed) {
      deferred = true;
      log.info('ready.no-auto-countdown', { attempts: policy.attempts, lastReason: policy.lastReason });
      try { emit(payload()); } catch (_) { /* ignore */ }
      return;
    }
    startCountdown();
  }

  function onError(err) {
    count('error');
    if (state === STATES.READY || state === STATES.INSTALLING || state === STATES.RESTARTING || state === STATES.UPDATED) {
      // A verified file is on disk; a late library error (for example the
      // now-unused autoInstallOnAppQuit path) does not invalidate it.
      log.warn('library.error-ignored', { state, error: err });
      return;
    }
    if (state === STATES.FAILED || state === STATES.RECOVERY || state === STATES.IDLE || state === STATES.AVAILABLE) {
      // A late error from a check that already settled (timed out, or was
      // dismissed): logged, never re-shown.
      log.warn('library.error-late', { state, error: err });
      return;
    }
    const st = stageForState();
    checkInFlight = false;
    fail(st, classifyError(err), { error: err, detail: (err && err.code) || null });
  }

  async function verifyDownloaded(info, downloadedFile) {
    const v = validateUpdateInfo(info, { currentVersion, arch, channel });
    if (!v.ok) return { ok: false, reason: v.reason, detail: v.detail };
    if (!target || compareSemver(v.target, target.version) !== 0) {
      return { ok: false, reason: 'downloaded-version-mismatch', detail: `${v.target} vs ${target && target.version}` };
    }
    if (!downloadedFile) return { ok: false, reason: 'downloaded-file-missing' };
    if (path.win32.basename(downloadedFile).toLowerCase() !== v.file.name.toLowerCase()) {
      return { ok: false, reason: 'downloaded-file-name', detail: path.win32.basename(downloadedFile) };
    }
    let stat;
    try { stat = fsImpl.statSync(downloadedFile); } catch (_) { return { ok: false, reason: 'downloaded-file-missing' }; }
    if (v.file.size && stat.size !== v.file.size) {
      return { ok: false, reason: 'size-mismatch', detail: `${stat.size} vs ${v.file.size}` };
    }
    let hashed;
    try { hashed = await hashFile(downloadedFile, fsImpl); } catch (err) { return { ok: false, reason: 'hash-failed', detail: err && err.message }; }
    if (hashed.sha512 !== v.file.sha512) return { ok: false, reason: 'sha512-mismatch' };
    return { ok: true, stat: { size: stat.size, mtimeMs: stat.mtimeMs } };
  }

  function describeFeed() {
    try {
      const cfg = autoUpdater && autoUpdater.__feedDescription;
      return cfg || null;
    } catch (_) { return null; }
  }

  function registerEvents() {
    if (registered) return;
    registered = true;
    autoUpdater.on('checking-for-update', onChecking);
    autoUpdater.on('update-available', onAvailable);
    autoUpdater.on('update-not-available', onNotAvailable);
    autoUpdater.on('download-progress', onProgress);
    autoUpdater.on('update-downloaded', (info) => { onDownloaded(info).catch((err) => fail(STAGES.VERIFY, 'verify-threw', { error: err })); });
    autoUpdater.on('error', onError);
  }

  // ---- countdown ----------------------------------------------------
  function startCountdown() {
    cancelCountdown();
    countdownEndsAt = now() + restartCountdownSeconds * 1000;
    countdownTimer = setTimer(() => {
      countdownTimer = null;
      countdownEndsAt = 0;
      if (state !== STATES.READY || deferred) return;
      if (isBusy()) { deferred = true; try { emit(payload()); } catch (_) { /* ignore */ } return; }
      installNow('countdown').catch((err) => fail(STAGES.PREPARE, 'install-threw', { error: err }));
    }, restartCountdownSeconds * 1000);
    log.info('ready.countdown', { seconds: restartCountdownSeconds });
    try { emit(payload()); } catch (_) { /* ignore */ }
  }

  // ---- install handoff (exactly once per process) --------------------
  async function installNow(origin, opts = {}) {
    const relaunch = opts.relaunch !== false;
    if (handoffStarted) {
      log.warn('install.duplicate-request', { origin, state });
      return { ok: false, reason: 'already-installing' };
    }
    if (state !== STATES.READY) {
      log.warn('install.not-ready', { origin, state });
      return { ok: false, reason: 'not-ready' };
    }
    if (isBusy() && relaunch) {
      deferred = true;
      log.info('install.blocked-busy', { origin });
      try { emit(payload()); } catch (_) { /* ignore */ }
      return { ok: false, reason: 'busy' };
    }
    if (!target || !target.downloadedFile || !target.verifiedStat) {
      fail(STAGES.PREPARE, 'no-verified-file');
      return { ok: false, reason: 'no-verified-file' };
    }
    handoffStarted = true;
    cancelCountdown();
    setState(STATES.INSTALLING, { stage: STAGES.PREPARE, reason: null });
    log.info('install.begin', { origin, target: target.version, relaunch, artifact: target.file.name, execPath, installDir, executionMode });
    // The user must see the handoff notice before the process goes quiet.
    let notice = { shown: null, ms: 0 };
    try { notice = await confirmNotice(NOTICE_CONFIRM_MS); } catch (err) { notice = { shown: false, ms: 0, error: err && err.message }; }
    log.info('install.notice', notice);

    if (executionMode !== 'installed') {
      handoffStarted = false;
      fail(STAGES.PREPARE, 'not-installed-build', { detail: executionMode });
      return { ok: false, reason: 'not-installed-build' };
    }
    if (path.win32.basename(execPath).toLowerCase() !== PRODUCT_EXE.toLowerCase()) {
      handoffStarted = false;
      fail(STAGES.PREPARE, 'unexpected-executable', { detail: path.win32.basename(execPath) });
      return { ok: false, reason: 'unexpected-executable' };
    }

    // Elevation: the installer is per-machine and the app's manifest already
    // requires administrator, so a non-elevated process cannot start it.
    let elevated = false;
    try { elevated = await isElevated(); } catch (_) { elevated = false; }
    if (!elevated) {
      handoffStarted = false;
      fail(STAGES.ELEVATION, 'elevation-required');
      return { ok: false, reason: 'elevation-required' };
    }

    // The file must still be the bytes we verified.
    let stat;
    try { stat = fsImpl.statSync(target.downloadedFile); } catch (_) { stat = null; }
    if (!stat || stat.size !== target.verifiedStat.size || stat.mtimeMs !== target.verifiedStat.mtimeMs) {
      handoffStarted = false;
      fail(STAGES.VERIFY, 'file-changed-after-verify');
      return { ok: false, reason: 'file-changed-after-verify' };
    }

    // The installer writes to the registered InstallLocation. If that is not
    // where THIS executable lives, a silent update would produce a second
    // copy and the shortcut would keep opening the old one.
    let registered = null;
    try { registered = await readRegisteredInstallDir(); } catch (_) { registered = null; }
    log.info('install.location', { registered, installDir });
    if (registered && !samePath(registered, installDir)) {
      handoffStarted = false;
      fail(STAGES.LOCATION, 'install-location-mismatch', { detail: registered });
      return { ok: false, reason: 'install-location-mismatch' };
    }

    const attempt = recordAttempt(target.version, STAGES.INSTALLER_LAUNCH, null);
    const record = buildHandoffRecord({
      currentVersion, targetVersion: target.version, execPath, installDir, channel,
      artifact: target.file, relaunchRequested: relaunch, attempt,
      timestamp: new Date(now()).toISOString(), state: 'installing'
    });
    try {
      writeHandoff(record);
    } catch (err) {
      handoffStarted = false;
      fail(STAGES.PREPARE, 'handoff-write-failed', { error: err });
      return { ok: false, reason: 'handoff-write-failed' };
    }

    const args = buildInstallerArgs({ installDir, relaunch });
    setState(STATES.INSTALLING, { stage: STAGES.INSTALLER_LAUNCH });
    log.info('installer.invoke', { installer: target.downloadedFile, args });
    let launched;
    try {
      launched = await spawnInstaller(target.downloadedFile, args, { timeoutMs: SPAWN_CONFIRM_MS });
    } catch (err) {
      launched = { ok: false, error: err };
    }
    if (!launched || !launched.ok || !launched.pid) {
      const err = launched && launched.error;
      const code = err && err.code;
      const why = code === 'ENOENT' ? 'installer-missing'
        : (code === 'EACCES' || code === 'UNKNOWN' || code === 'EPERM') ? 'installer-elevation-refused'
          : 'installer-launch-failed';
      try { writeHandoff(Object.assign({}, record, { state: 'failed', failure: why })); } catch (_) { /* keep going */ }
      recordOutcome(target.version, STAGES.INSTALLER_LAUNCH, why);
      handoffStarted = false;
      fail(STAGES.INSTALLER_LAUNCH, why, { error: err });
      return { ok: false, reason: why };
    }
    try {
      writeHandoff(Object.assign({}, record, { state: 'installer-started', installerPid: launched.pid }));
    } catch (err) {
      log.warn('handoff.update-failed', { error: err });
    }
    log.info('installer.started', { pid: launched.pid, relaunch });
    setState(STATES.RESTARTING, { stage: STAGES.INSTALL, reason: null });
    if (typeof requestShutdown === 'function') {
      requestShutdown(relaunch ? 'update_restart' : 'update_install_on_exit');
    }
    return { ok: true, pid: launched.pid };
  }

  // Called from before-quit when the user (or an inactivity exit) closes the
  // app with a verified update waiting. Synchronous: the quit handler cannot
  // await. No relaunch: the user chose to leave.
  function installOnExit(shutdownReason) {
    if (handoffStarted || state !== STATES.READY || !target || !target.downloadedFile || !target.verifiedStat) return { ok: false, reason: 'nothing-to-install' };
    if (shutdownReason === 'update_restart' || shutdownReason === 'elevated_relaunch' || shutdownReason === 'fatal' || shutdownReason === 'second_instance') {
      return { ok: false, reason: 'shutdown-reason-excluded' };
    }
    if (typeof deps.spawnInstallerSync !== 'function') return { ok: false, reason: 'no-sync-spawn' };
    let stat;
    try { stat = fsImpl.statSync(target.downloadedFile); } catch (_) { stat = null; }
    if (!stat || stat.size !== target.verifiedStat.size || stat.mtimeMs !== target.verifiedStat.mtimeMs) {
      log.warn('install-on-exit.skipped', { reason: 'file-changed-after-verify' });
      return { ok: false, reason: 'file-changed-after-verify' };
    }
    if (deps.isElevatedSyncHint && deps.isElevatedSyncHint() === false) {
      log.warn('install-on-exit.skipped', { reason: 'elevation-required' });
      return { ok: false, reason: 'elevation-required' };
    }
    handoffStarted = true;
    const attempt = recordAttempt(target.version, STAGES.INSTALLER_LAUNCH, null);
    const record = buildHandoffRecord({
      currentVersion, targetVersion: target.version, execPath, installDir, channel,
      artifact: target.file, relaunchRequested: false, attempt,
      timestamp: new Date(now()).toISOString(), state: 'installing'
    });
    try { writeHandoff(record); } catch (err) { handoffStarted = false; log.error('install-on-exit.handoff-write-failed', { error: err }); return { ok: false, reason: 'handoff-write-failed' }; }
    const args = buildInstallerArgs({ installDir, relaunch: false });
    log.info('installer.invoke', { installer: target.downloadedFile, args, onExit: true, shutdownReason });
    const launched = deps.spawnInstallerSync(target.downloadedFile, args);
    if (!launched || !launched.ok || !launched.pid) {
      try { writeHandoff(Object.assign({}, record, { state: 'failed', failure: 'installer-launch-failed' })); } catch (_) { /* ignore */ }
      recordOutcome(target.version, STAGES.INSTALLER_LAUNCH, 'installer-launch-failed');
      log.error('install-on-exit.failed', { error: launched && launched.error });
      return { ok: false, reason: 'installer-launch-failed' };
    }
    try { writeHandoff(Object.assign({}, record, { state: 'installer-started', installerPid: launched.pid })); } catch (_) { /* ignore */ }
    log.info('installer.started', { pid: launched.pid, relaunch: false, onExit: true });
    state = STATES.RESTARTING;
    return { ok: true, pid: launched.pid };
  }

  // ---- startup: what did the previous process leave behind? ---------
  function start() {
    registerEvents();
    log.setContext({ app: currentVersion, platform, arch, channel, mode: executionMode });
    log.info('startup', { execPath, installDir, argv: argv.filter((a) => a.startsWith('--')), userData: userDataDir });
    const record = readHandoff();
    const verdict = evaluateStartup({ record, currentVersion, execPath, argv, nowMs: now() });
    startupVerdict = verdict;
    if (verdict.state === STATES.IDLE) {
      if (verdict.reason) log.warn('startup.handoff', { reason: verdict.reason, record });
      if (verdict.clear) clearHandoff(verdict.reason);
      setState(STATES.IDLE);
      return verdict;
    }
    if (verdict.state === STATES.UPDATED) {
      log.info('relaunch.verified', { reason: verdict.reason, from: record.currentVersion, to: record.targetVersion, execPath, relaunchRequested: record.relaunchRequested, attempt: record.attempt });
      try { writeHandoff(Object.assign({}, record, { state: 'updated-pending-ready' })); } catch (_) { /* ignore */ }
      recordOutcome(record.targetVersion, STAGES.RELAUNCH, 'updated');
      setState(STATES.UPDATED, { stage: STAGES.RELAUNCH, reason: verdict.reason });
      return verdict;
    }
    // recovery
    log.error('relaunch.failed', { reason: verdict.reason, detail: verdict.detail, stage: verdict.stage, expected: record.targetVersion, running: currentVersion, execPath, expectedDir: record.installDir, attempt: record.attempt });
    recordOutcome(record.targetVersion, verdict.stage, verdict.reason);
    try { writeHandoff(Object.assign({}, record, { state: 'failed', failure: verdict.reason })); } catch (_) { /* ignore */ }
    setState(STATES.RECOVERY, { stage: verdict.stage, reason: verdict.reason, detail: verdict.detail || null });
    return verdict;
  }

  // The renderer reports that the app reached its ready screen. Only then
  // is a successful handoff considered complete and its record removed.
  function markAppReady() {
    if (readyMarked) return;
    readyMarked = true;
    if (state === STATES.UPDATED && startupVerdict && startupVerdict.record) {
      log.info('update.complete', { version: currentVersion, from: startupVerdict.record.currentVersion, execPath });
      clearHandoff('new-version-ready');
    } else {
      log.info('app.ready', { state });
    }
  }

  // ---- user actions -----------------------------------------------
  async function check(origin) {
    if (!registered) registerEvents();
    if (executionMode !== 'installed') {
      log.info('check.skipped', { origin, executionMode });
      return { ok: false, reason: 'not-installed-build' };
    }
    let configured = true;
    try { configured = !!hasUpdateConfig(); } catch (_) { configured = false; }
    if (!configured) {
      // An unpacked directory build (electron-builder --dir) or a copy made
      // without resources/app-update.yml: nothing to check against. Not a
      // failure the user can act on, so it is logged, never shown.
      log.info('check.skipped', { origin, reason: 'no-update-config' });
      if (state === STATES.CHECKING || state === STATES.FAILED) setState(STATES.IDLE, { stage: null, reason: null });
      return { ok: false, reason: 'no-update-config' };
    }
    if (checkInFlight || CRITICAL_STATES.has(state) || state === STATES.READY) {
      log.info('check.skipped', { origin, state, checkInFlight });
      return { ok: false, reason: 'busy' };
    }
    if (isBusy()) {
      log.info('check.skipped', { origin, reason: 'busy' });
      return { ok: false, reason: 'busy' };
    }
    if (origin === 'interval' || origin === 'startup') {
      const doc = readStateDoc();
      const last = doc.lastOutcome;
      if (last && last.targetVersion) {
        const policy = retryPolicy(doc, last.targetVersion, now());
        if (!policy.autoCheckAllowed) {
          log.info('check.backoff', { origin, waitMs: policy.waitMs, target: last.targetVersion });
          return { ok: false, reason: 'backoff' };
        }
      }
    }
    checkInFlight = true;
    lastCheckAt = now();
    lastCheckOrigin = origin;
    quiet = false;
    const prevTarget = target;
    target = null;
    percent = 0;
    setState(STATES.CHECKING, { stage: STAGES.CHECK, reason: null, detail: null });
    let timer = null;
    const timeout = new Promise((_, reject) => { timer = setTimer(() => reject(Object.assign(new Error(`update check timed out after ${checkTimeoutMs} ms`), { code: 'ETIMEDOUT' })), checkTimeoutMs); });
    try {
      await Promise.race([autoUpdater.checkForUpdates(), timeout]);
      return { ok: true };
    } catch (err) {
      if (state === STATES.CHECKING) fail(STAGES.CHECK, classifyError(err), { error: err });
      return { ok: false, reason: 'check-failed' };
    } finally {
      clearTimer(timer);
      checkInFlight = false;
      if (state === STATES.CHECKING) {
        // The promise settled without an update-available / not-available
        // event: treat as an unknown result rather than staying "checking".
        log.warn('check.no-result', {});
        target = prevTarget && prevTarget.downloadedFile ? prevTarget : null;
        setState(STATES.IDLE, { stage: null, reason: null });
      }
    }
  }

  // "Dismiss" on a failed check: gone for this session. Later automatic
  // re-checks that fail the same way stay quiet; a user retry, or the next
  // launch, reports again.
  function dismiss() {
    log.info('user.dismiss', { state, stage, reason });
    if (state === STATES.FAILED && stage === STAGES.CHECK) sessionDismissedCheck = true;
    if (state === STATES.FAILED || state === STATES.RECOVERY || state === STATES.UPDATED) {
      if (state === STATES.RECOVERY && startupVerdict && startupVerdict.record) clearHandoff('user-dismiss');
      setState(STATES.IDLE, { stage: null, reason: null, detail: null });
    } else if (state === STATES.AVAILABLE) {
      // "Not now": keep the knowledge, drop the banner until the next check.
      quiet = true;
      log.info('available.not-now', { target: target && target.version });
      try { emit(payload()); } catch (_) { /* ignore */ }
    }
    return { ok: true };
  }

  function defer() {
    if (state !== STATES.READY) return { ok: false };
    deferred = true;
    cancelCountdown();
    log.info('ready.deferred', { reason: 'user' });
    try { emit(payload()); } catch (_) { /* ignore */ }
    return { ok: true };
  }

  async function retry(origin) {
    log.info('user.retry', { origin, state, stage, reason });
    if (state === STATES.READY) return installNow('retry');
    if (state === STATES.FAILED || state === STATES.RECOVERY || state === STATES.IDLE || state === STATES.UPDATED) {
      const targetVersion = target ? target.version : (startupVerdict && startupVerdict.record ? startupVerdict.record.targetVersion : null);
      if (targetVersion) {
        const policy = retryPolicy(readStateDoc(), targetVersion, now());
        if (!policy.installAllowed) {
          log.warn('user.retry-blocked', { attempts: policy.attempts, targetVersion });
          setState(STATES.RECOVERY, { stage: policy.lastStage || STAGES.INSTALL, reason: 'retry-limit-reached' });
          return { ok: false, reason: 'retry-limit-reached' };
        }
      }
      if (startupVerdict && startupVerdict.record && state === STATES.RECOVERY) clearHandoff('user-retry');
      return check('retry');
    }
    return { ok: false, reason: 'busy' };
  }

  function continueCurrent() {
    log.info('user.continue-current', { state, stage, reason });
    if (state === STATES.RECOVERY && startupVerdict && startupVerdict.record) clearHandoff('user-continue');
    if (state === STATES.FAILED || state === STATES.RECOVERY || state === STATES.UPDATED) {
      setState(STATES.IDLE, { stage: null, reason: null, detail: null });
    }
    return { ok: true };
  }

  function diagnostics() {
    const doc = readStateDoc();
    const record = readHandoff();
    const s = log.sanitize;
    return {
      state, stage, reason, detail: detail ? s(detail) : null,
      current: currentVersion,
      target: target ? target.version : (record ? record.targetVersion : null),
      channel, executionMode, arch, platform,
      execPath: s(execPath),
      installDir: s(installDir),
      attempts: target ? attemptsFor(doc, target.version).count : (record ? record.attempt : 0),
      lastOutcome: doc.lastOutcome || null,
      handoff: record ? Object.assign({}, record, { execPath: s(record.execPath), installDir: s(record.installDir) }) : null,
      logFile: s(log.file || ''),
      recent: log.tail(40),
      eventCounts: Object.assign({}, eventCounts)
    };
  }

  function dispose() {
    cancelCountdown();
  }

  return {
    STATES, STAGES,
    start, check, download, dismiss, installNow, installOnExit, defer, retry, continueCurrent, diagnostics, markAppReady, dispose,
    classifyError,
    getStatus: payload,
    getState: () => state,
    isCritical: () => CRITICAL_STATES.has(state),
    isReady: () => state === STATES.READY,
    hasHandedOff: () => handoffStarted,
    lastCheckAt: () => lastCheckAt,
    _test: { setStateForTests: setState, eventCounts }
  };
}

module.exports = {
  STATES,
  STAGES,
  CRITICAL_STATES,
  RELAUNCH_FLAG,
  UPDATED_FLAG,
  HANDOFF_FILE,
  STATE_FILE,
  HANDOFF_MAX_AGE_MS,
  RESTART_COUNTDOWN_SECONDS,
  CHECK_TIMEOUT_MS,
  MAX_AUTO_INSTALL_ATTEMPTS,
  MAX_TOTAL_INSTALL_ATTEMPTS,
  BACKOFF_MS,
  PRODUCT_EXE,
  ARTIFACT_RE,
  parseArtifactName,
  INSTALL_REGISTRY_KEY,
  LEGACY_INSTALL_REGISTRY_KEY,
  parseSemver,
  compareSemver,
  channelOf,
  normalizePath,
  samePath,
  validateUpdateInfo,
  buildInstallerArgs,
  buildHandoffRecord,
  parseHandoffRecord,
  evaluateStartup,
  retryPolicy,
  hashFileSha512,
  createUpdaterController
};
