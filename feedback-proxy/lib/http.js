/**
 * Shared HTTP primitives for the feedback proxy.
 *
 * Extracted verbatim from the original single-file server.js so the legacy
 * /feedback path and the /v1 support API use the exact same behavior.
 */
'use strict';

const crypto = require('crypto');

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/** Read the request body as a Buffer, rejecting with code 413 past maxBytes. */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      // Once over the cap, keep draining but stop buffering. Do NOT destroy the
      // socket here: destroying it before the handler writes a response gives
      // the client a "socket hang up" instead of a clean 413.
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        chunks.length = 0;
        reject(Object.assign(new Error('payload too large'), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

// Strip control characters (keep newline and tab), then cap length.
const CONTROL_CHARS = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]', 'g');

function clean(v, max) {
  return String(v == null ? '' : v).replace(CONTROL_CHARS, '').slice(0, max).trim();
}

/**
 * In-memory per-IP rate limiter (adequate for a single instance).
 * Same sliding-window pattern the /feedback endpoint has always used.
 */
function createRateLimiter(max, windowMs) {
  const hits = new Map(); // ip -> number[] of timestamps

  // Bound memory: drop stale IP buckets periodically.
  setInterval(() => {
    const now = Date.now();
    for (const [ip, arr] of hits) {
      const live = arr.filter((t) => now - t < windowMs);
      if (live.length) hits.set(ip, live);
      else hits.delete(ip);
    }
  }, windowMs).unref();

  return {
    limited(ip, now) {
      const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
      if (arr.length >= max) {
        hits.set(ip, arr);
        return true;
      }
      arr.push(now);
      hits.set(ip, arr);
      return false;
    },
  };
}

/**
 * Standard error shape for the support API (spec pack):
 *   { error: { code, message, requestId } }
 * The legacy /feedback contract keeps its own { ok:false, error } shape.
 */
function fail(res, status, code, message) {
  const requestId = 'req_' + crypto.randomBytes(4).toString('hex').toUpperCase();
  json(res, status, { error: { code, message, requestId } });
  return requestId;
}

module.exports = { json, fail, clientIp, readBody, clean, createRateLimiter };
