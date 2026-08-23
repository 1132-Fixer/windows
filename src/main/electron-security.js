// Electron / IPC / updater trust boundary.
// Pure require()-able helpers shared by main.js and tools/electron-security-smoke.js
// — main.js cannot be imported under plain node (Electron requires).
//
// Contract:
//   1. Renderer has no Node. contextIsolation on, sandbox on, nodeIntegration off.
//   2. Preload exposes a fixed API. Main will not register any other ipcMain.handle.
//   3. Invoke payloads are schema-checked; extra args are dropped, never forwarded.
//   4. openExternal and the portable updater fetch only https hosts on an allowlist.
//      The renderer cannot supply those URLs.
//   5. Navigation away from the local index.html is denied.
//   6. User-selected filesystem paths are checked before interpolation into PowerShell.
//
// This is not a signing certificate. Signing state lives in
// docs/security/code-signing.md and scripts/check-signature-state.mjs.

'use strict';

const path = require('path');

const IPC_INVOKE_CHANNELS = Object.freeze([
  'run-fix',
  'create-shortcut',
  'shortcut-exists',
  'is-elevated',
  'preflight',
  'preflight-scan',
  'support-report',
  'zoom-open-download',
  'zoom-choose-installer',
  'zoom-run-installer',
  'install-update-now',
  'defer-update',
  'open-download-page',
  'open-website',
  'window-minimize',
  'window-maximize',
  'quit-app',
  'submit-feedback',
  'feedback-capabilities',
  'get-version',
  'get-system-info',
]);

const IPC_INVOKE_CHANNEL_SET = new Set(IPC_INVOKE_CHANNELS);

// Main -> renderer only. Not registered with ipcMain.handle.
const IPC_SEND_CHANNELS = Object.freeze([
  'fix-log',
  'update-status',
  'zoom-installer-done',
]);

const FEEDBACK_TYPES = Object.freeze(['Bug Report', 'User Rating', 'Contact']);
const SCREENSHOT_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const FEEDBACK_TEXT_MAX = 100 * 1024;
const SUPPORT_LOG_MAX = 256 * 1024;
const SUPPORT_STAGE_MAX = 200;
const SUPPORT_RECEIPT_MAX_KEYS = 32;
const SUPPORT_RECEIPT_VALUE_MAX = 500;

const GITHUB_OWNER_REPO_PREFIX = '/1132-Fixer/windows/';
const UPDATER_CDN_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);
const WEBSITE_HOSTS = new Set(['1132-fixer.xyz', 'www.1132-fixer.xyz']);
const ZOOM_HOSTS = new Set(['zoom.us', 'www.zoom.us']);

const IPC_SCHEMAS = Object.freeze({
  'submit-feedback': { args: ['feedback-type', 'feedback-text', 'screenshot?'] },
  'support-report': { args: ['support-context?'] },
});

function rendererWebPreferences(preloadPath) {
  if (typeof preloadPath !== 'string' || !preloadPath) {
    throw new Error('rendererWebPreferences requires an absolute preload path');
  }
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    navigateOnDragAndDrop: false,
    webviewTag: false,
  };
}

function isolationFlagsOk(prefs) {
  if (!prefs || typeof prefs !== 'object') return false;
  return prefs.nodeIntegration === false
    && prefs.contextIsolation === true
    && prefs.sandbox === true
    && prefs.webSecurity === true
    && prefs.allowRunningInsecureContent === false
    && prefs.nodeIntegrationInWorker === false
    && prefs.nodeIntegrationInSubFrames === false
    && prefs.webviewTag === false
    && typeof prefs.preload === 'string'
    && prefs.preload.length > 0;
}

function parseHttpsUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) return null;
  let u;
  try { u = new URL(urlString); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host || host.includes(':')) return null;
  return { url: u, host, pathname: u.pathname };
}

function isGithubWindowsPath(pathname) {
  return typeof pathname === 'string' && pathname.startsWith(GITHUB_OWNER_REPO_PREFIX);
}

function isAllowedUpdaterUrl(urlString) {
  const parsed = parseHttpsUrl(urlString);
  if (!parsed) return false;
  if (parsed.host === 'github.com' || parsed.host === 'www.github.com') {
    return isGithubWindowsPath(parsed.pathname);
  }
  return UPDATER_CDN_HOSTS.has(parsed.host);
}

function isAllowedExternalUrl(urlString) {
  const parsed = parseHttpsUrl(urlString);
  if (!parsed) return false;
  if (parsed.host === 'github.com' || parsed.host === 'www.github.com') {
    return isGithubWindowsPath(parsed.pathname);
  }
  if (WEBSITE_HOSTS.has(parsed.host)) return true;
  if (ZOOM_HOSTS.has(parsed.host)) return true;
  return false;
}

async function openExternalSafe(openExternal, urlString) {
  if (!isAllowedExternalUrl(urlString)) {
    return { success: false, reason: 'url not allowed' };
  }
  if (typeof openExternal !== 'function') {
    return { success: false, reason: 'openExternal missing' };
  }
  await openExternal(urlString);
  return { success: true };
}

function isAllowedRendererNavigation(urlString, appRoot) {
  if (typeof urlString !== 'string' || !urlString) return false;
  if (typeof appRoot !== 'string' || !appRoot) return false;
  let u;
  try { u = new URL(urlString); } catch (_) { return false; }
  if (u.protocol !== 'file:') return false;
  let filePath = decodeURIComponent(u.pathname);
  if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
  filePath = filePath.replace(/\//g, path.sep);
  const resolved = path.resolve(filePath);
  const root = path.resolve(appRoot);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return path.basename(resolved).toLowerCase() === 'index.html';
}

function hardenWebContents(webContents, opts = {}) {
  const appRoot = opts.appRoot || '';
  if (!webContents) return;
  if (typeof webContents.setWindowOpenHandler === 'function') {
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  const denyNav = (event, url) => {
    if (!isAllowedRendererNavigation(url, appRoot)) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    }
  };
  if (typeof webContents.on === 'function') {
    webContents.on('will-navigate', denyNav);
    webContents.on('will-attach-webview', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    });
  }
  const ses = webContents.session;
  if (ses && typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
}

function isSafeUserSelectedPath(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'empty' };
  if (filePath.includes('\0')) return { ok: false, reason: 'nul' };
  if ([...filePath].some((ch) => ch.charCodeAt(0) < 0x20)) {
    return { ok: false, reason: 'control characters' };
  }
  const resolved = path.resolve(filePath);
  const base = path.basename(resolved);
  if (!base || base.includes(':') || base.includes('/') || base.includes('\\')) {
    return { ok: false, reason: 'illegal basename' };
  }
  if (opts.ext) {
    const want = opts.ext.startsWith('.') ? opts.ext.toLowerCase() : `.${String(opts.ext).toLowerCase()}`;
    if (path.extname(resolved).toLowerCase() !== want) {
      return { ok: false, reason: 'extension' };
    }
  }
  return { ok: true, path: resolved };
}

function psSingleQuote(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not a string' };
  if (value.includes('\0') || [...value].some((ch) => ch.charCodeAt(0) < 0x20)) {
    return { ok: false, reason: 'control characters' };
  }
  return { ok: true, literal: `'${value.replace(/'/g, "''")}'` };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function screenshotBytesLength(bytes) {
  if (!bytes) return -1;
  if (typeof bytes.length === 'number') return bytes.length;
  if (bytes.type === 'Buffer' && Array.isArray(bytes.data)) return bytes.data.length;
  return -1;
}

function coerceArg(kind, value) {
  switch (kind) {
    case 'feedback-type':
      if (typeof value !== 'string' || !FEEDBACK_TYPES.includes(value)) {
        return { ok: false, reason: 'type not allowed' };
      }
      return { ok: true, value };
    case 'feedback-text':
      if (typeof value !== 'string') return { ok: false, reason: 'text not a string' };
      if (value.length > FEEDBACK_TEXT_MAX) return { ok: false, reason: 'text too long' };
      return { ok: true, value };
    case 'screenshot?': {
      if (value === undefined || value === null) return { ok: true, value: undefined };
      if (!isPlainObject(value)) return { ok: false, reason: 'screenshot not an object' };
      const mediaType = typeof value.mediaType === 'string' ? value.mediaType.toLowerCase() : '';
      if (!SCREENSHOT_MIME.includes(mediaType)) return { ok: false, reason: 'mediaType not allowed' };
      const len = screenshotBytesLength(value.bytes);
      if (len < 1) return { ok: false, reason: 'bytes missing' };
      if (len > SCREENSHOT_MAX_BYTES) return { ok: false, reason: 'bytes too large' };
      return { ok: true, value: { bytes: value.bytes, mediaType } };
    }
    case 'support-context?': {
      if (value === undefined || value === null) {
        return { ok: true, value: { receipt: null, logTail: '', stage: '' } };
      }
      if (!isPlainObject(value)) return { ok: false, reason: 'context not an object' };
      let logTail = value.logTail;
      if (logTail === undefined || logTail === null) logTail = '';
      if (typeof logTail !== 'string') return { ok: false, reason: 'logTail not a string' };
      if (logTail.length > SUPPORT_LOG_MAX) return { ok: false, reason: 'logTail too long' };
      let stage = value.stage;
      if (stage === undefined || stage === null) stage = '';
      if (typeof stage !== 'string') return { ok: false, reason: 'stage not a string' };
      if (stage.length > SUPPORT_STAGE_MAX) return { ok: false, reason: 'stage too long' };
      let receipt = value.receipt;
      if (receipt === undefined) receipt = null;
      if (receipt !== null) {
        if (!isPlainObject(receipt)) return { ok: false, reason: 'receipt not an object' };
        const keys = Object.keys(receipt);
        if (keys.length > SUPPORT_RECEIPT_MAX_KEYS) return { ok: false, reason: 'receipt too large' };
        const clean = {};
        for (const key of keys) {
          if (typeof key !== 'string' || key.length > 64) {
            return { ok: false, reason: 'receipt key not allowed' };
          }
          const v = receipt[key];
          if (v === null || v === undefined) { clean[key] = null; continue; }
          if (typeof v === 'number' || typeof v === 'boolean') { clean[key] = v; continue; }
          if (typeof v === 'string' && v.length <= SUPPORT_RECEIPT_VALUE_MAX) {
            clean[key] = v;
            continue;
          }
          return { ok: false, reason: 'receipt value not allowed' };
        }
        receipt = clean;
      }
      return { ok: true, value: { receipt, logTail, stage } };
    }
    default:
      return { ok: false, reason: 'unknown schema kind' };
  }
}

function validateInvoke(channel, args) {
  if (typeof channel !== 'string' || !IPC_INVOKE_CHANNEL_SET.has(channel)) {
    return { ok: false, reason: 'channel not on allowlist' };
  }
  const schema = IPC_SCHEMAS[channel];
  const incoming = Array.isArray(args) ? args : [];
  if (!schema) return { ok: true, args: [] };
  const out = [];
  for (let i = 0; i < schema.args.length; i++) {
    const kind = schema.args[i];
    const optional = kind.endsWith('?');
    const value = incoming[i];
    if ((value === undefined || value === null) && optional) {
      const coerced = coerceArg(kind, value);
      if (!coerced.ok) return { ok: false, reason: `arg ${i}: ${coerced.reason}` };
      out.push(coerced.value);
      continue;
    }
    const coerced = coerceArg(kind, value);
    if (!coerced.ok) return { ok: false, reason: `arg ${i}: ${coerced.reason}` };
    out.push(coerced.value);
  }
  return { ok: true, args: out };
}

function installIpcAllowlist(ipcMain) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('installIpcAllowlist requires Electron ipcMain');
  }
  if (ipcMain.__1132IpcAllowlistInstalled) return ipcMain;
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => {
    if (!IPC_INVOKE_CHANNEL_SET.has(channel)) {
      throw new Error(`IPC channel not on allowlist: ${channel}`);
    }
    if (typeof listener !== 'function') {
      throw new Error(`IPC handler for ${channel} is not a function`);
    }
    return origHandle(channel, async (event, ...args) => {
      const checked = validateInvoke(channel, args);
      if (!checked.ok) {
        throw new Error(`IPC invoke rejected: ${channel}: ${checked.reason}`);
      }
      return listener(event, ...checked.args);
    });
  };
  ipcMain.__1132IpcAllowlistInstalled = true;
  return ipcMain;
}

module.exports = {
  IPC_INVOKE_CHANNELS,
  IPC_SEND_CHANNELS,
  FEEDBACK_TYPES,
  SCREENSHOT_MIME,
  SCREENSHOT_MAX_BYTES,
  GITHUB_OWNER_REPO_PREFIX,
  rendererWebPreferences,
  isolationFlagsOk,
  parseHttpsUrl,
  isAllowedUpdaterUrl,
  isAllowedExternalUrl,
  openExternalSafe,
  isAllowedRendererNavigation,
  hardenWebContents,
  isSafeUserSelectedPath,
  psSingleQuote,
  validateInvoke,
  installIpcAllowlist,
};
