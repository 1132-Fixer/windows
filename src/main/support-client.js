/**
 * Support-API client for bug reports that carry a screenshot (#141).
 *
 * Plain-text reports keep the legacy /feedback path untouched. A report WITH
 * a screenshot needs the /v1 support API (the legacy contract caps bodies at
 * 8 KB and cannot carry an image), which authenticates with a per-install
 * principal token:
 *
 *   - The token is minted by POST /v1/principals on first use and returned
 *     exactly once. It is NOT a shipped secret — every install mints its own.
 *   - At rest it is sealed with Electron safeStorage (DPAPI on Windows) when
 *     available; a machine without safeStorage stores it plain in userData,
 *     which is already the app's private per-user directory.
 *   - The renderer never sees the token; screenshot bytes are never logged.
 *
 * The attach UI only renders when GET /health advertises
 * capabilities.screenshots (see feedback-capabilities in main.js), so this
 * path is dark until the support platform is activated server-side.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const PRINCIPAL_FILE = 'support-principal.json';

function endpointUrl(config, pathname) {
  if (!config.FEEDBACK_PROXY_URL) return null;
  let url;
  try {
    url = new URL(pathname, config.FEEDBACK_PROXY_URL);
  } catch (_) {
    return null;
  }
  // Same plaintext refusal as the legacy path (localhost excepted, for dev).
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return null;
  }
  return url;
}

/** Minimal JSON request helper; resolves { status, json } or rejects on network error. */
function request(method, url, headers, bodyBuffer, timeoutMs) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      timeout: timeoutMs || 20000,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* non-JSON body */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/** GET /health -> { screenshots: boolean }. Never throws. */
async function capabilities(config) {
  const url = endpointUrl(config, '/health');
  if (!url) return { screenshots: false };
  try {
    const r = await request('GET', url, {}, null, 5000);
    return { screenshots: Boolean(r.json && r.json.capabilities && r.json.capabilities.screenshots) };
  } catch (_) {
    return { screenshots: false };
  }
}

// --- principal persistence -------------------------------------------

function principalPath(userDataDir) {
  return path.join(userDataDir, PRINCIPAL_FILE);
}

function loadPrincipal(userDataDir, safeStorage) {
  try {
    const raw = JSON.parse(fs.readFileSync(principalPath(userDataDir), 'utf8'));
    if (raw.sealed) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      const plain = safeStorage.decryptString(Buffer.from(raw.sealed, 'base64'));
      return JSON.parse(plain);
    }
    if (raw.principalId && raw.token) return raw;
    return null;
  } catch (_) {
    return null; // absent or corrupt -> re-register
  }
}

function savePrincipal(userDataDir, safeStorage, principal) {
  const plain = JSON.stringify({ principalId: principal.principalId, token: principal.token });
  const record = (safeStorage && safeStorage.isEncryptionAvailable())
    ? { sealed: safeStorage.encryptString(plain).toString('base64') }
    : JSON.parse(plain);
  fs.writeFileSync(principalPath(userDataDir), JSON.stringify(record));
}

function discardPrincipal(userDataDir) {
  try { fs.unlinkSync(principalPath(userDataDir)); } catch (_) { /* already gone */ }
}

/** Register this install as a support principal. Returns principal or null. */
async function registerPrincipal(config, version) {
  const url = endpointUrl(config, '/v1/principals');
  if (!url) return null;
  const body = Buffer.from(JSON.stringify({ product: 'WINDOWS', appVersion: version }));
  try {
    const r = await request('POST', url, {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'User-Agent': `1132Fixer/${version}`,
    }, body);
    if (r.status === 201 && r.json && r.json.principalId && r.json.token) {
      return { principalId: r.json.principalId, token: r.json.token };
    }
  } catch (_) { /* fall through */ }
  return null;
}

// --- bug submission with screenshot ----------------------------------

/** Client-safe copy for the /v1 error surface; never a raw exception. */
function messageFor(r) {
  if (r.status === 429) return 'Too many submissions — try again later.';
  if (r.status === 413) return 'The report is too large — remove the screenshot and try again.';
  if (r.status === 400 && r.json && r.json.error && r.json.error.code === 'validation_failed') {
    // Server validation messages are written as user-facing copy
    // ("Only image files can be attached…", "Screenshot must be 5 MB or smaller.").
    return r.json.error.message;
  }
  if (r.status === 503) return 'The support service is not available right now — try again later.';
  return 'Submission failed';
}

/**
 * Submit a bug report with a screenshot via POST /v1/cases.
 * screenshot = { bytes: Buffer, mediaType: string }.
 * Returns { success, caseRef? , error? } — success ONLY on a 201 from the
 * proxy, so the UI can never claim a screenshot was sent when it was not.
 */
async function submitBugWithScreenshot(opts) {
  const { config, userDataDir, safeStorage, version, osLabel, text, screenshot } = opts;
  const url = endpointUrl(config, '/v1/cases');
  if (!url) return { success: false, error: 'Feedback service not configured' };

  let principal = loadPrincipal(userDataDir, safeStorage);
  if (!principal) {
    principal = await registerPrincipal(config, version);
    if (!principal) return { success: false, error: 'Could not reach the support service — try again later.' };
    savePrincipal(userDataDir, safeStorage, principal);
  }

  const titleText = text.slice(0, 80).replace(/\s+/g, ' ').trim();
  const payload = {
    type: 'bug',
    title: titleText || 'Bug report',
    description: text,
    os: osLabel,
    appVersion: version,
    screenshot: { data: screenshot.bytes.toString('base64'), mediaType: screenshot.mediaType },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const headers = (p) => ({
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'User-Agent': `1132Fixer/${version}`,
    Authorization: `Bearer ${p.token}`,
    'Idempotency-Key': crypto.randomUUID(),
  });

  try {
    let r = await request('POST', url, headers(principal), body);
    if (r.status === 401) {
      // Token revoked or the service pepper rotated: mint a fresh principal
      // once and retry; a second 401 is surfaced honestly.
      discardPrincipal(userDataDir);
      const fresh = await registerPrincipal(config, version);
      if (!fresh) return { success: false, error: 'Could not reach the support service — try again later.' };
      savePrincipal(userDataDir, safeStorage, fresh);
      r = await request('POST', url, headers(fresh), body);
    }
    if (r.status === 201 && r.json && r.json.caseRef) {
      if (!r.json.screenshotAttached) {
        // Defensive: a 201 without the attachment must not read as "sent".
        return { success: false, error: 'The report went through but the screenshot did not — try again.' };
      }
      return { success: true, caseRef: r.json.caseRef };
    }
    return { success: false, error: messageFor(r) };
  } catch (err) {
    return { success: false, error: err && err.message === 'timeout'
      ? 'The support service timed out — try again later.'
      : 'Network error' };
  }
}

module.exports = { capabilities, submitBugWithScreenshot };
