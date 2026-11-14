/**
 * Anonymous support adapter for the canonical stateless Discord relay.
 * Only an explicit submission contacts the endpoint. Retry memory contains
 * hashes and UUIDs, never report bodies, screenshots or account credentials.
 *
 * Relay retry receipts last ten minutes in one process. They are not durable
 * across relay/app restarts or replicas. An acknowledgement proves delivery,
 * not staff review, resolution, or exactly-once delivery after a restart.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const messages = require('../../messages');

const TEXT_MAX_BYTES = 100 * 1024;
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUEST_RECORDS = 32;
const TYPES = new Set(['Bug Report', 'User Rating', 'Contact']);

function endpointUrl(value) {
  if (typeof value === 'string' && /[\u0000-\u001F\u007F]/.test(value)) return null;
  if (typeof value !== 'string' || !/^https:\/\/[^\s?#]+$/i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (!['/', '/v1/feedback', '/v1/feedback/'].includes(url.pathname)) return null;
    url.pathname = '/v1/feedback';
    return url;
  } catch (_) { return null; }
}

function supportConfigRevision(value) {
  const url = endpointUrl(value);
  return crypto.createHash('sha256').update('1132-fixer-public-config-v1\0', 'utf8')
    .update(url ? url.href : '', 'utf8').digest('hex');
}

function configuredUrl(config) {
  if (!config || config.FEEDBACK_CONFIG_INTEGRITY === false) return null;
  return endpointUrl(config.FEEDBACK_PROXY_URL);
}

// Local feature availability only. This does not claim service readiness and
// never probes a remote health route just because a dialog was opened.
function capabilities(config) {
  const configured = Boolean(configuredUrl(config));
  return { configured, screenshots: configured, statelessFeedback: configured, readiness: 'not-checked' };
}

function copy(key) {
  // Keep all transport outcomes in the shared, plain-English catalogue.
  const catalogue = messages.FEEDBACK;
  if (catalogue && typeof catalogue[key] === 'string') return catalogue[key];
  return key === 'NETWORK' ? messages.FEEDBACK_NETWORK : messages.FEEDBACK_FALLBACK;
}

function failure(code, key, details = {}) {
  return { success: false, code, error: copy(key), delivery: 'not-sent', ...details };
}

function imageType(bytes) {
  // Match the canonical relay's structural checks, not just a magic prefix.
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.subarray(12, 16).equals(Buffer.from('IHDR'))) return 'image/png';
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].some(header => bytes.subarray(0, 6).equals(Buffer.from(header)))) return 'image/gif';
  if (bytes.length >= 16 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  return null;
}

function postOnce({ url, body, requestId, version, transportRequest, timeoutMs, schedule, cancelSchedule }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) cancelSchedule(timer);
      if (error) {
        // Finish first: destroy may synchronously emit error or close.
        try { if (response && typeof response.destroy === 'function') response.destroy(); } catch (_) { /* already stopped */ }
        try { if (req && typeof req.destroy === 'function') req.destroy(); } catch (_) { /* already stopped */ }
        reject(error);
      } else resolve(result);
    };
    const transportError = (code) => Object.assign(new Error(code), { code });
    try {
      req = transportRequest({
        protocol: 'https:', hostname: url.hostname, port: url.port || 443,
        path: '/v1/feedback', method: 'POST',
        headers: {
          'Content-Type': 'application/json', 'Content-Length': body.length,
          'Idempotency-Key': requestId, 'User-Agent': '1132Fixer/' + version
        }
      }, (res) => {
        response = res;
        let size = 0;
        const chunks = [];
        res.on('error', () => finish(transportError('network')));
        res.on('aborted', () => finish(transportError('network')));
        res.on('close', () => { if (!res.complete) finish(transportError('network')); });
        res.on('data', (chunk) => {
          if (settled) return;
          let bytes;
          try { bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); }
          catch (_) { finish(transportError('invalid-response')); return; }
          size += bytes.length;
          if (size > RESPONSE_MAX_BYTES) { finish(transportError('invalid-response')); return; }
          chunks.push(bytes);
        });
        res.on('end', () => {
          if (settled) return;
          let json;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (_) { finish(transportError('invalid-response')); return; }
          finish(null, { status: res.statusCode, json });
        });
      });
      req.on('error', () => finish(transportError('network')));
      req.on('close', () => { if (!response) finish(transportError('network')); });
      if (settled) { if (typeof req.destroy === 'function') req.destroy(); return; }
      timer = schedule(() => finish(transportError('timeout')), timeoutMs);
      req.write(body);
      req.end();
    } catch (_) { finish(transportError('network')); }
  });
}

function createSupportClient({
  transportRequest = https.request, timeoutMs = REQUEST_TIMEOUT_MS,
  clock = Date.now, schedule = setTimeout, cancelSchedule = clearTimeout
} = {}) {
  // Fingerprints include the form type and endpoint. Keep bounded identities
  // across edits, not just the latest identity per form: A -> B -> A must not
  // replace an unresolved UUID or silently repost an acknowledged draft.
  // Never evict at capacity, including when an unknown retry window expires.
  // Retain only hashes, UUIDs and outcome/time metadata, not report payloads.
  const records = new Map();
  const activeTypes = new Set();
  const deadline = Number.isFinite(timeoutMs)
    ? Math.min(REQUEST_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))) : REQUEST_TIMEOUT_MS;
  const now = () => {
    try { const value = clock(); return Number.isSafeInteger(value) && value > 0 ? value : null; }
    catch (_) { return null; }
  };
  const uncertainty = (attempt) => ({
    delivery: 'unknown', requestId: attempt.requestId,
    retryUntilMs: attempt.windowStartedAtMs + RETRY_WINDOW_MS,
    retryScope: 'same-app-and-relay-processes'
  });

  async function submitFeedback(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return failure('invalid-input', 'REJECTED');
    const { config, type, text, version, screenshot, rating } = options;
    const url = configuredUrl(config);
    if (!url) return failure('not-configured', 'NOT_CONFIGURED');
    if (!TYPES.has(type) || typeof text !== 'string' || !text.trim()) return failure('invalid-input', 'REJECTED');
    if (Buffer.byteLength(text, 'utf8') > TEXT_MAX_BYTES) return failure('text-too-large', 'TEXT_TOO_LARGE');
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) return failure('invalid-version', 'FAILED');
    if (type === 'User Rating' && (!Number.isInteger(rating) || rating < 1 || rating > 5)) return failure('rating-required', 'RATING_REQUIRED');
    if (type !== 'User Rating' && rating !== undefined) return failure('invalid-rating', 'REJECTED');
    if (activeTypes.has(type)) return failure('busy', 'BUSY');

    const payload = { type, text, version };
    if (type === 'User Rating') payload.rating = rating;
    if (screenshot !== undefined && screenshot !== null) {
      if (type !== 'Bug Report' || !screenshot || typeof screenshot !== 'object') return failure('invalid-screenshot', 'SCREENSHOT_INVALID');
      let bytes;
      try {
        const input = screenshot.bytes;
        const size = Buffer.isBuffer(input) || ArrayBuffer.isView(input) || input instanceof ArrayBuffer
          ? input.byteLength : Array.isArray(input) ? input.length : null;
        // Bound allocation before converting a caller-controlled byte container.
        if (!Number.isSafeInteger(size) || size < 1 || size > SCREENSHOT_MAX_BYTES) return failure('invalid-screenshot', 'SCREENSHOT_INVALID');
        bytes = Buffer.from(input);
      } catch (_) { /* invalid input */ }
      if (!bytes || !bytes.length || bytes.length > SCREENSHOT_MAX_BYTES || imageType(bytes) !== screenshot.mediaType) {
        return failure('invalid-screenshot', 'SCREENSHOT_INVALID');
      }
      payload.screenshot = { data: bytes.toString('base64'), mediaType: screenshot.mediaType };
    }
    const startedAt = now();
    if (startedAt === null || startedAt > Number.MAX_SAFE_INTEGER - RETRY_WINDOW_MS) return failure('clock-unavailable', 'FAILED');
    const fingerprint = crypto.createHash('sha256').update(url.href).update('\0').update(JSON.stringify(payload)).digest('hex');
    const previous = records.get(fingerprint);
    if (previous && previous.acknowledged) {
      const receipt = previous;
      return { success: true, delivery: 'acknowledged', requestId: receipt.requestId,
        replayed: true, receiptScope: 'same-app-process' };
    }
    if (!previous && records.size >= MAX_REQUEST_RECORDS) {
      return failure('client-history-full', 'RETRY_CAPACITY', { retryable: false });
    }
    const attempt = previous || { requestId: crypto.randomUUID(), unknown: false,
      acknowledged: false, windowStartedAtMs: startedAt };

    if (attempt.unknown && (startedAt < attempt.windowStartedAtMs || startedAt >= attempt.windowStartedAtMs + RETRY_WINDOW_MS)) {
      return failure('delivery-unresolved', 'RETRY_WINDOW_EXPIRED', { ...uncertainty(attempt), retryable: false });
    }
    // A definitively rejected attempt may be retried later. The first possible
    // unacknowledged send starts the conservative relay-cache window.
    if (!attempt.unknown) attempt.windowStartedAtMs = startedAt;
    records.set(fingerprint, attempt);
    activeTypes.add(type);
    const markUnknown = (code, key) => {
      attempt.unknown = true;
      const checkedAt = now();
      const retryable = checkedAt !== null && checkedAt >= attempt.windowStartedAtMs &&
        checkedAt < attempt.windowStartedAtMs + RETRY_WINDOW_MS;
      return failure(code, retryable ? key : 'RETRY_WINDOW_EXPIRED', { ...uncertainty(attempt), retryable });
    };
    try {
      const body = Buffer.from(JSON.stringify({ requestId: attempt.requestId, ...payload }));
      const result = await postOnce({
        url, body, requestId: attempt.requestId, version, transportRequest,
        timeoutMs: deadline, schedule, cancelSchedule
      });
      if (result.status === 201 && result.json && result.json.success === true && result.json.requestId === attempt.requestId) {
        attempt.acknowledged = true;
        attempt.unknown = false;
        return { success: true, delivery: 'acknowledged', requestId: attempt.requestId };
      }
      if (result.status === 201) return markUnknown('invalid-acknowledgement', 'SEND_UNKNOWN');
      const remoteCode = result.json && result.json.error && result.json.error.code;
      if (remoteCode === 'send_unknown') return markUnknown('send-unknown', 'SEND_UNKNOWN');
      const key = result.status === 429 ? 'RATE_LIMITED'
        : result.status === 413 ? 'TOO_LARGE'
          : result.status >= 500 ? 'UNAVAILABLE' : 'REJECTED';
      const definiteRejection = (result.status >= 400 && result.status < 500) ||
        ['support_cutover_pending', 'busy', 'rate_limited', 'discord_rate_limited'].includes(remoteCode);
      if (!definiteRejection) return markUnknown('send-unknown', 'SEND_UNKNOWN');
      if (attempt.unknown) return markUnknown('submission-rejected', key);
      return failure('submission-rejected', key, { requestId: attempt.requestId, retryable: true });
    } catch (error) {
      return markUnknown(error.code === 'timeout' ? 'timeout' : error.code === 'invalid-response'
        ? 'invalid-response' : 'network', error.code === 'timeout' ? 'TIMEOUT' : 'SEND_UNKNOWN');
    } finally {
      activeTypes.delete(type);
    }
  }

  return { capabilities, submitFeedback };
}

const defaultClient = createSupportClient();

// Compatibility for callers of the earlier screenshot-only adapter.
// Deliberately ignore old userDataDir/safeStorage/osLabel fields. No old
// credential is read, persisted, migrated or deleted, and no caseRef is invented.
function submitBugWithScreenshot(opts = {}) {
  return defaultClient.submitFeedback({
    config: opts.config, type: 'Bug Report', text: opts.text,
    version: opts.version, screenshot: opts.screenshot
  });
}

module.exports = {
  capabilities, createSupportClient, submitFeedback: defaultClient.submitFeedback,
  submitBugWithScreenshot, endpointUrl, supportConfigRevision,
  TEXT_MAX_BYTES, SCREENSHOT_MAX_BYTES, RESPONSE_MAX_BYTES, REQUEST_TIMEOUT_MS, RETRY_WINDOW_MS, MAX_REQUEST_RECORDS
};
