'use strict';

/**
 * Structured, sanitized updater log for 1132 Fixer.
 *
 * One JSON object per line, appended to <userData>/logs/updater.log. The
 * file lives under %APPDATA%\1132-fixer, which the installer keeps across
 * an update (`--updated` / `/KEEP_APP_DATA`) and the uninstaller keeps
 * (`deleteAppDataOnUninstall: false`), so the record of a failed handoff
 * survives the relaunch that failed and can be read afterwards.
 *
 * What never reaches the file:
 *   - query strings and fragments of any URL (signed CDN parameters,
 *     tokens);
 *   - anything that looks like a bearer token or GitHub token;
 *   - the signed-in user's home directory and bare username (replaced by
 *     placeholders, same policy as the support report sanitizer in main.js).
 *
 * Rotation: when the file passes MAX_BYTES it is renamed to updater.log.1
 * (one generation kept) and a fresh file starts. Every write is
 * best-effort: a logging failure must never break the update itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 512 * 1024;
const MAX_FIELD_CHARS = 2000;

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createSanitizer(opts = {}) {
  const homeDir = (opts.homeDir !== undefined ? opts.homeDir : os.homedir() || '').trim();
  const user = (opts.username !== undefined ? opts.username : (os.userInfo().username || '')).trim();
  const hostname = (opts.hostname !== undefined ? opts.hostname : os.hostname() || '').trim();
  const helperUser = (opts.helperUser || 'user1').toLowerCase();
  const homeRe = homeDir ? new RegExp(escRe(homeDir), 'gi') : null;
  const usersRe = user ? new RegExp(`([A-Za-z]:\\\\Users\\\\)${escRe(user)}(?=\\\\|$|[\\s"'])`, 'gi') : null;
  const bareUserRe = user && user.toLowerCase() !== helperUser ? new RegExp(`\\b${escRe(user)}\\b`, 'gi') : null;
  const hostRe = hostname ? new RegExp(`\\b${escRe(hostname)}\\b`, 'gi') : null;

  return function sanitize(input) {
    if (input === null || input === undefined) return '';
    let out = String(input);
    if (out.length > MAX_FIELD_CHARS) out = out.slice(0, MAX_FIELD_CHARS) + '…';
    // URLs: keep scheme+host+path, drop query and fragment (signed params).
    out = out.replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, '$1?…');
    // Token shapes: GitHub PATs, bearer headers, generic long secrets.
    out = out.replace(/\b(gh[pous]_|github_pat_)[A-Za-z0-9_]{8,}/g, '$1<redacted>');
    out = out.replace(/\b(Bearer|token|Authorization)([=:\s]+)[A-Za-z0-9._\-]{8,}/gi, '$1$2<redacted>');
    out = out.replace(/S-1-5-21-\d+-\d+-\d+-\d+/g, 'S-1-5-21-XXXX-XXXX-XXXX-XXXX');
    if (homeRe) out = out.replace(homeRe, 'C:\\Users\\<you>');
    if (usersRe) out = out.replace(usersRe, '$1<you>');
    if (bareUserRe) out = out.replace(bareUserRe, '<you>');
    if (hostRe) out = out.replace(hostRe, '<host>');
    return out;
  };
}

function sanitizeValue(sanitize, value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitize(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, code: value.code || null, message: sanitize(value.message || '') };
  }
  if (depth >= 3) return sanitize(String(value));
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeValue(sanitize, v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).slice(0, 50)) {
      if (/token|secret|password|authorization|credential|cookie/i.test(key)) {
        out[key] = '<redacted>';
        continue;
      }
      out[key] = sanitizeValue(sanitize, value[key], depth + 1);
    }
    return out;
  }
  return sanitize(String(value));
}

function createUpdaterLog(opts = {}) {
  const file = opts.file;
  const fsImpl = opts.fs || fs;
  const now = opts.now || (() => new Date());
  const sanitize = opts.sanitize || createSanitizer(opts);
  const mirror = opts.mirror; // optional console-like sink
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const context = Object.assign({}, opts.context || {});
  let failedWrites = 0;

  function rotateIfNeeded() {
    try {
      const st = fsImpl.statSync(file);
      if (st.size < maxBytes) return;
      const old = `${file}.1`;
      try { fsImpl.unlinkSync(old); } catch (_) { /* absent */ }
      fsImpl.renameSync(file, old);
    } catch (_) { /* file absent or unreadable: nothing to rotate */ }
  }

  function write(level, event, fields) {
    const entry = Object.assign(
      { ts: now().toISOString(), level, event },
      context,
      sanitizeValue(sanitize, fields || {})
    );
    const line = JSON.stringify(entry);
    if (mirror && typeof mirror.log === 'function') {
      try { mirror.log(`[updater] ${event} ${JSON.stringify(sanitizeValue(sanitize, fields || {}))}`); } catch (_) { /* ignore */ }
    }
    if (!file) return entry;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      rotateIfNeeded();
      fsImpl.appendFileSync(file, line + '\n', 'utf8');
    } catch (_) {
      failedWrites++;
    }
    return entry;
  }

  function tail(maxLines = 80) {
    try {
      const text = fsImpl.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines);
    } catch (_) {
      return [];
    }
  }

  return {
    file,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    setContext: (patch) => Object.assign(context, patch || {}),
    tail,
    sanitize,
    get failedWrites() { return failedWrites; }
  };
}

module.exports = { createUpdaterLog, createSanitizer, sanitizeValue, MAX_BYTES };
