/**
 * Anonymous, user-triggered support submission adapter.
 *
 * The public desktop app knows only a public HTTPS endpoint. Each Submit
 * performs one bounded POST. Temporary request IDs let an explicit retry of
 * unchanged content reuse the same key; no identity or report is persisted.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const { FEEDBACK } = require('../../messages');

const TYPES = Object.freeze(['Bug Report', 'User Rating', 'Contact']);
const TEXT_MAX_BYTES = 100 * 1024;
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
const RESPONSE_MAX_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

/** Configuration is public. Credentials and alternate API paths are refused. */
function endpointUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!/^https:\/\/[^\s?#]+$/i.test(value.trim())) return null;
  if (/gh[pous]_\w+|github_pat_|\bbearer\b|\d{15,}:\w+/i.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (!['/', '/v1/feedback', '/v1/feedback/'].includes(url.pathname)) return null;
    url.pathname = '/v1/feedback';
    return url;
  } catch (_) {
    return null;
  }
}

/** Stable identity for the one public support setting. Unsafe input is never
 * copied into the revision: invalid and unset values share the disabled form. */
function supportConfigRevision(value) {
  const url = endpointUrl(value);
  const endpoint = url ? url.href : '';
  return crypto.createHash('sha256')
    .update('1132-fixer-public-config-v1\0', 'utf8')
    .update(endpoint, 'utf8')
    .digest('hex');
}

function capabilities(config) {
  const enabled = Boolean(endpointUrl(config && config.FEEDBACK_PROXY_URL));
  return { configured: enabled, screenshots: enabled };
}

function imageType(bytes) {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const head = bytes.subarray(0, 12).toString('ascii');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function messageFor(status) {
  if (status === 429) return FEEDBACK.RATE_LIMITED;
  if (status === 413) return FEEDBACK.TOO_LARGE;
  if (status === 400) return FEEDBACK.REJECTED;
  if (status === 503 || status === 502) return FEEDBACK.UNAVAILABLE;
  return FEEDBACK.FAILED;
}

/** A single exchange with absolute deadline and a bounded response body. */
function request(url, body, requestId, transportRequest, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let timer;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };
    try {
      req = transportRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'Idempotency-Key': requestId,
        },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > RESPONSE_MAX_BYTES) {
            finish(new Error('invalid-response'));
            res.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', () => finish(new Error('network')));
        res.on('aborted', () => finish(new Error('network')));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* rejected below */ }
          finish(null, { status: res.statusCode, json });
        });
      });
      req.on('error', () => finish(new Error('network')));
      timer = setTimeout(() => {
        finish(new Error('timeout'));
        req.destroy();
      }, timeoutMs);
      req.end(body);
    } catch (_) {
      finish(new Error('network'));
      if (req) req.destroy();
    }
  });
}

function createSupportClient({ transportRequest = https.request, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  // At most one unfinished request ID per form type. No text or images stored.
  const attempts = new Map();
  const activeTypes = new Set();
  const deadline = Math.min(REQUEST_TIMEOUT_MS, Math.max(1, timeoutMs));

  async function submitFeedback({ config, type, text, version, screenshot, rating } = {}) {
    const url = endpointUrl(config && config.FEEDBACK_PROXY_URL);
    if (!url) return { success: false, error: FEEDBACK.NOT_CONFIGURED };
    if (!TYPES.includes(type) || typeof text !== 'string' || !text.trim()) {
      return { success: false, error: FEEDBACK.REJECTED };
    }
    if (Buffer.byteLength(text, 'utf8') > TEXT_MAX_BYTES) {
      return { success: false, error: FEEDBACK.TEXT_TOO_LARGE };
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)) {
      return { success: false, error: FEEDBACK.FAILED };
    }
    const payload = { type, text, version };
    if (type === 'User Rating') {
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { success: false, error: FEEDBACK.RATING_REQUIRED };
      payload.rating = rating;
    } else if (rating !== undefined) {
      return { success: false, error: FEEDBACK.REJECTED };
    }
    if (screenshot) {
      let bytes;
      try { bytes = Buffer.from(screenshot.bytes); } catch (_) { /* invalid bytes */ }
      if (!bytes || bytes.length < 1 || bytes.length > SCREENSHOT_MAX_BYTES || imageType(bytes) !== screenshot.mediaType) {
        return { success: false, error: FEEDBACK.SCREENSHOT_INVALID };
      }
      payload.screenshot = { data: bytes.toString('base64'), mediaType: screenshot.mediaType };
    }
    if (activeTypes.has(type)) return { success: false, error: FEEDBACK.BUSY };
    const fingerprint = crypto.createHash('sha256').update(url.href).update(JSON.stringify(payload)).digest('hex');
    const previous = attempts.get(type);
    const requestId = previous && previous.fingerprint === fingerprint ? previous.requestId : crypto.randomUUID();
    attempts.set(type, { fingerprint, requestId });
    activeTypes.add(type);
    try {
      const body = Buffer.from(JSON.stringify({ requestId, ...payload }));
      const result = await request(url, body, requestId, transportRequest, deadline);
      if (result.status === 201 && result.json && result.json.success === true && result.json.requestId === requestId) {
        attempts.delete(type);
        return { success: true };
      }
      return { success: false, error: messageFor(result.status) };
    } catch (err) {
      return { success: false, error: err.message === 'timeout' ? FEEDBACK.TIMEOUT :
        err.message === 'invalid-response' ? FEEDBACK.FAILED : FEEDBACK.NETWORK };
    } finally {
      activeTypes.delete(type);
    }
  }

  return { capabilities, submitFeedback };
}

module.exports = {
  ...createSupportClient(),
  createSupportClient,
  endpointUrl,
  supportConfigRevision,
  TEXT_MAX_BYTES,
  SCREENSHOT_MAX_BYTES
};
