'use strict';
/**
 * The one authoritative "Automatic app updates" preference.
 *
 * Stored in <userData>/settings.json. That folder belongs to the Windows
 * user, not to the install directory, so the value survives app restarts,
 * Windows restarts and application upgrades (the installer never writes
 * there).
 *
 * Meaning:
 *   enabled  true   automatic update checks run at startup and on the
 *                   interval, and a downloaded update may install after its
 *                   countdown or when the app exits.
 *   enabled  false  nothing about updates happens unless the user asks for
 *                   it: no automatic check, no countdown, no install on exit.
 *                   "Check for updates" stays available.
 *
 * Default for an installation with no saved preference: ON. That is the
 * behaviour every earlier release had hardcoded. It is reported with
 * `explicit: false` so it is never confused with a choice the user made.
 *
 * A settings file that exists but cannot be read or parsed is NOT treated
 * as "no preference". The user's choice is unknown, so the safe reading is
 * OFF until they choose again: a damaged file must never re-enable updates
 * the user turned off.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'settings.json';
const SETTINGS_SCHEMA = 1;
const DEFAULT_AUTOMATIC_UPDATES = true;

function createUpdatePreference(deps) {
  const {
    userDataDir,
    fs: fsImpl = fs,
    now = () => Date.now(),
    log = null
  } = deps || {};
  if (typeof userDataDir !== 'string' || !userDataDir) {
    throw new Error('createUpdatePreference requires userDataDir');
  }
  const file = path.join(userDataDir, SETTINGS_FILE);
  let cached = null;

  function note(level, event, fields) {
    if (!log || typeof log[level] !== 'function') return;
    try { log[level](event, fields || {}); } catch (_) { /* logging never breaks a preference read */ }
  }

  function readDoc() {
    let text;
    try {
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return { exists: false, doc: null, readable: true };
      return { exists: true, doc: null, readable: false, error: (err && err.code) || 'read-failed' };
    }
    try {
      const doc = JSON.parse(text);
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        return { exists: true, doc: null, readable: false, error: 'not-an-object' };
      }
      return { exists: true, doc, readable: true };
    } catch (_) {
      return { exists: true, doc: null, readable: false, error: 'invalid-json' };
    }
  }

  function evaluate() {
    const r = readDoc();
    if (!r.exists) {
      return { enabled: DEFAULT_AUTOMATIC_UPDATES, explicit: false, source: 'default', setAt: null };
    }
    if (!r.readable) {
      note('warn', 'preference.unreadable', { error: r.error });
      return { enabled: false, explicit: false, source: 'unreadable', setAt: null };
    }
    const entry = r.doc.automaticUpdates;
    if (entry && typeof entry === 'object' && typeof entry.enabled === 'boolean') {
      return {
        enabled: entry.enabled,
        explicit: true,
        source: 'saved',
        setAt: typeof entry.setAt === 'string' ? entry.setAt : null
      };
    }
    if (entry === undefined) {
      // The file exists for another setting; no update choice was ever saved.
      return { enabled: DEFAULT_AUTOMATIC_UPDATES, explicit: false, source: 'default', setAt: null };
    }
    note('warn', 'preference.invalid-entry', {});
    return { enabled: false, explicit: false, source: 'unreadable', setAt: null };
  }

  function get() {
    if (!cached) cached = evaluate();
    return Object.assign({}, cached);
  }

  // Saved immediately and atomically (write a temporary file, then rename).
  // Other keys already in the file are kept.
  function set(enabled) {
    if (typeof enabled !== 'boolean') {
      return { ok: false, reason: 'invalid-value', preference: get() };
    }
    const r = readDoc();
    const doc = (r.exists && r.readable && r.doc) ? Object.assign({}, r.doc) : {};
    doc.schema = SETTINGS_SCHEMA;
    doc.automaticUpdates = { enabled, setAt: new Date(now()).toISOString() };
    const tmp = `${file}.tmp`;
    try {
      fsImpl.mkdirSync(path.dirname(file), { recursive: true });
      fsImpl.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      fsImpl.renameSync(tmp, file);
    } catch (err) {
      try { fsImpl.unlinkSync(tmp); } catch (_) { /* nothing to clean */ }
      note('error', 'preference.write-failed', { error: (err && err.code) || String(err && err.message || err) });
      // The choice was not saved, so it is not reported as saved.
      return { ok: false, reason: 'write-failed', preference: get() };
    }
    cached = { enabled, explicit: true, source: 'saved', setAt: doc.automaticUpdates.setAt };
    note('info', 'preference.saved', { enabled });
    return { ok: true, preference: get() };
  }

  return {
    file,
    get,
    set,
    isEnabled: () => get().enabled === true,
    reloadForTests: () => { cached = null; }
  };
}

module.exports = {
  SETTINGS_FILE,
  SETTINGS_SCHEMA,
  DEFAULT_AUTOMATIC_UPDATES,
  createUpdatePreference
};
