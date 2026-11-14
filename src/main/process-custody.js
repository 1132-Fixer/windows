'use strict';

// Recovery exclusion for generic commands, not native mutation authority or a
// machine writer lease. The caller must hold the application's single-instance
// boundary and may complete a token only after the bounded runner observed an
// actual child close or a proved refusal to spawn. PIDs are never proof.
//
// Records are immutable. Completion cannot overwrite a pending record, and a
// retained record permanently overrides completion. An interrupted write leaves
// the pending/partial record visible to a fresh instance. No record is deleted.
const path = require('node:path').win32;
const crypto = require('node:crypto');

const SCHEMA = '1132-process-custody/1';
const MAX_RECORD_BYTES = 4096;
const MAX_RECORD_FILES = 12288;
const ID = /^[a-f0-9]{32}$/;
const NAME = /^([a-f0-9]{32})\.(pending|complete|retained)\.json$/;
const CODE = /^[a-z][a-z0-9-]{0,63}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');

function custodyError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createProcessCustodyStore(options = {}) {
  const io = options.fs;
  const randomId = options.randomId;
  const clock = options.now;
  const directory = options.directory;
  const required = ['lstatSync', 'realpathSync', 'mkdirSync', 'readdirSync', 'openSync',
    'writeSync', 'readSync', 'fstatSync', 'fsyncSync', 'closeSync'];
  if (!io || required.some(name => typeof io[name] !== 'function') ||
      typeof randomId !== 'function' || typeof clock !== 'function' ||
      typeof directory !== 'string' || !/^[A-Za-z]:\\/.test(directory) ||
      /[\x00-\x1f"<>|?*]/.test(directory) || directory.slice(2).includes(':') ||
      path.normalize(directory) !== directory || path.dirname(directory) === directory ||
      directory.endsWith('\\')) throw new TypeError('Explicit canonical custody-store adapters are required');

  const owned = new WeakMap();
  const active = new Map();
  let sticky = false;

  function now() {
    const value = clock();
    if (!positive(value)) throw custodyError('custody-clock-unverified');
    return value;
  }
  function id() {
    const value = randomId();
    if (typeof value !== 'string' || !ID.test(value)) throw custodyError('custody-id-unverified');
    return value;
  }
  function identicalPath(a, b) {
    return typeof a === 'string' && typeof b === 'string' &&
      path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
  }
  function fileIdentity(stat) {
    return stat && typeof stat.isFile === 'function' && stat.isFile() &&
      stat.nlink === 1 && Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino) && stat.ino > 0;
  }
  function sameFile(a, b) {
    return fileIdentity(a) && fileIdentity(b) && a.dev === b.dev && a.ino === b.ino;
  }
  function guardExisting(target, kind) {
    const root = path.parse(target).root;
    const parts = target.slice(root.length).split('\\').filter(Boolean);
    let current = root;
    const entries = [root];
    for (const part of parts) { current = path.join(current, part); entries.push(current); }
    let leaf;
    for (const entry of entries) {
      const stat = io.lstatSync(entry);
      if (!stat || typeof stat.isSymbolicLink !== 'function' || stat.isSymbolicLink() ||
          !identicalPath(io.realpathSync(entry), entry)) throw custodyError('custody-path-unverified');
      if (entry !== target || kind === 'directory') {
        if (typeof stat.isDirectory !== 'function' || !stat.isDirectory()) throw custodyError('custody-path-unverified');
      } else if (!fileIdentity(stat)) throw custodyError('custody-file-unverified');
      leaf = stat;
    }
    return leaf;
  }
  function directoryExists() {
    guardExisting(path.dirname(directory), 'directory');
    try { guardExisting(directory, 'directory'); return true; }
    catch (error) {
      // Only a missing leaf is absence. A denied/malformed/redirected parent
      // cannot become an empty store, including when an adapter throws ENOENT.
      if (error && error.code === 'ENOENT') {
        guardExisting(path.dirname(directory), 'directory');
        try { io.lstatSync(directory); } catch (leafError) {
          if (leafError && leafError.code === 'ENOENT') return false;
          throw leafError;
        }
      }
      throw error;
    }
  }
  function readHandle(fd) {
    const stat = io.fstatSync(fd);
    if (!fileIdentity(stat) || !Number.isSafeInteger(stat.size) ||
        stat.size < 1 || stat.size > MAX_RECORD_BYTES) throw custodyError('custody-record-unverified');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = io.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!Number.isInteger(count) || count < 1 || count > bytes.length - offset) throw custodyError('custody-record-unverified');
      offset += count;
    }
    if (io.readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0 ||
        !sameFile(stat, io.fstatSync(fd)) || io.fstatSync(fd).size !== bytes.length) {
      throw custodyError('custody-record-unverified');
    }
    return { bytes, stat };
  }
  function readRecord(name) {
    const target = path.join(directory, name);
    const before = guardExisting(target, 'file');
    const fd = io.openSync(target, 'r');
    try {
      const read = readHandle(fd);
      if (!sameFile(before, read.stat) || !sameFile(read.stat, guardExisting(target, 'file'))) {
        throw custodyError('custody-file-unverified');
      }
      const text = read.bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(read.bytes)) throw custodyError('custody-record-unverified');
      const value = JSON.parse(text);
      if (!object(value) || JSON.stringify(value) !== text) throw custodyError('custody-record-unverified');
      return { value, hash: digest(read.bytes) };
    } finally { io.closeSync(fd); }
  }
  function writeRecord(name, value) {
    guardExisting(directory, 'directory');
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    if (!bytes.length || bytes.length > MAX_RECORD_BYTES) throw custodyError('custody-record-unverified');
    const target = path.join(directory, name);
    const fd = io.openSync(target, 'wx+', 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = io.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!Number.isInteger(count) || count < 1 || count > bytes.length - offset) throw custodyError('custody-record-unverified');
        offset += count;
      }
      io.fsyncSync(fd);
      const read = readHandle(fd);
      if (!read.bytes.equals(bytes) || !sameFile(read.stat, guardExisting(target, 'file'))) {
        throw custodyError('custody-record-unverified');
      }
      return digest(bytes);
    } finally { io.closeSync(fd); }
  }
  function scan() {
    if (!directoryExists()) return { entries: new Map(), count: 0 };
    const names = io.readdirSync(directory);
    if (!Array.isArray(names) || names.length > MAX_RECORD_FILES || names.some(name => typeof name !== 'string' || !NAME.test(name))) {
      throw custodyError('custody-inventory-unverified');
    }
    const entries = new Map();
    for (const name of names) {
      const [, operationId, type] = NAME.exec(name);
      const entry = entries.get(operationId) || {};
      if (entry[type]) throw custodyError('custody-inventory-unverified');
      entry[type] = readRecord(name);
      entries.set(operationId, entry);
    }
    guardExisting(directory, 'directory');
    for (const [operationId, entry] of entries) {
      const pending = entry.pending && entry.pending.value;
      if (!exactKeys(pending, ['schema', 'type', 'id', 'owner', 'kind', 'createdAtMs']) ||
          pending.schema !== SCHEMA || pending.type !== 'pending' || pending.id !== operationId ||
          !ID.test(pending.owner) || typeof pending.kind !== 'string' || !CODE.test(pending.kind) || !positive(pending.createdAtMs)) {
        throw custodyError('custody-record-unverified');
      }
      for (const type of ['complete', 'retained']) {
        if (!entry[type]) continue;
        const value = entry[type].value;
        const tail = type === 'complete' ? 'outcome' : 'reason';
        if (!exactKeys(value, ['schema', 'type', 'id', 'owner', 'pendingSha256', 'capturedAtMs', tail]) ||
            value.schema !== SCHEMA || value.type !== type || value.id !== operationId || value.owner !== pending.owner ||
            value.pendingSha256 !== entry.pending.hash || !positive(value.capturedAtMs) || value.capturedAtMs < pending.createdAtMs ||
            (type === 'complete' ? !['exited', 'spawn-error'].includes(value.outcome) :
              typeof value.reason !== 'string' || !CODE.test(value.reason))) throw custodyError('custody-record-unverified');
      }
    }
    return { entries, count: names.length };
  }
  function inspect() {
    try {
      const state = scan();
      let pendingCount = 0, retainedCount = 0, completedCount = 0;
      for (const entry of state.entries.values()) {
        if (entry.retained) retainedCount++;
        else if (entry.complete) completedCount++;
        else pendingCount++;
      }
      return Object.freeze({ status: sticky || pendingCount || retainedCount ? 'blocked' : 'clear',
        blocked: !!(sticky || pendingCount || retainedCount), complete: true,
        pendingCount, retainedCount, completedCount, recordCount: state.count,
        reason: sticky ? 'custody-write-unverified' : retainedCount ? 'custody-retained' :
          pendingCount ? 'custody-prior-unresolved' : null });
    } catch (_) {
      return Object.freeze({ status: 'blocked', blocked: true, complete: false,
        reason: 'custody-storage-unverified' });
    }
  }
  function begin(kind = 'windows-command') {
    if (typeof kind !== 'string' || !CODE.test(kind)) throw new TypeError('Invalid command kind');
    if (sticky) throw custodyError('custody-write-unverified');
    let state;
    try {
      state = scan();
      for (const [operationId, entry] of state.entries) {
        const local = active.get(operationId);
        if (entry.retained || (!entry.complete && (!local || local.retained || local.completed ||
            local.hash !== entry.pending.hash))) throw custodyError('custody-prior-unresolved');
      }
      // Leave room for pending, completion and a later retention record. A full
      // ledger needs an evidenced maintenance action; it is never an empty one.
      if (state.count > MAX_RECORD_FILES - 3) throw custodyError('custody-ledger-full');
      if (!directoryExists()) {
        guardExisting(path.dirname(directory), 'directory');
        io.mkdirSync(directory, { recursive: false, mode: 0o700 });
        guardExisting(directory, 'directory');
      }
      const operationId = id();
      if (state.entries.has(operationId)) throw custodyError('custody-id-collision');
      const value = { schema: SCHEMA, type: 'pending', id: operationId,
        owner: id(), kind, createdAtMs: now() };
      const hash = writeRecord(operationId + '.pending.json', value);
      const token = Object.freeze({ id: operationId });
      const entry = { token, pending: value, hash, retained: false, completed: false };
      owned.set(token, entry); active.set(operationId, entry);
      return token;
    } catch (error) {
      sticky = true;
      throw custodyError(error && /^custody-/.test(error.code || '') ? error.code : 'custody-storage-unverified');
    }
  }
  function ownedEntry(token) {
    const entry = object(token) && owned.get(token);
    if (!entry || entry.completed) throw custodyError('custody-token-unverified');
    return entry;
  }
  function complete(token, proof) {
    const entry = ownedEntry(token);
    if (entry.retained || sticky) throw custodyError('custody-retained');
    if (!object(proof) || proof.cleanupConfirmed !== true || proof.timedOut === true ||
        !['exited', 'spawn-error'].includes(proof.outcome) ||
        (proof.outcome === 'exited' ? proof.rootExitConfirmed !== true : proof.rootExitConfirmed === true)) {
      sticky = true;
      throw custodyError('custody-completion-unverified');
    }
    try {
      const current = scan().entries.get(entry.pending.id);
      if (!current || current.retained || current.complete || current.pending.hash !== entry.hash) throw custodyError('custody-record-unverified');
      const capturedAtMs = now();
      if (capturedAtMs < entry.pending.createdAtMs) throw custodyError('custody-clock-unverified');
      writeRecord(entry.pending.id + '.complete.json', { schema: SCHEMA, type: 'complete', id: entry.pending.id,
        owner: entry.pending.owner, pendingSha256: entry.hash, capturedAtMs, outcome: proof.outcome });
      entry.completed = true; active.delete(entry.pending.id);
      return Object.freeze({ complete: true, cleanupConfirmed: true });
    } catch (_) { sticky = true; throw custodyError('custody-completion-unverified'); }
  }
  function retain(token, reason = 'command-unverified') {
    const entry = ownedEntry(token);
    if (typeof reason !== 'string' || !CODE.test(reason)) throw new TypeError('Invalid retention reason');
    if (entry.retained) return Object.freeze({ retained: true });
    entry.retained = true;
    try {
      const current = scan().entries.get(entry.pending.id);
      if (!current || current.complete || current.retained || current.pending.hash !== entry.hash) throw custodyError('custody-record-unverified');
      const capturedAtMs = now();
      if (capturedAtMs < entry.pending.createdAtMs) throw custodyError('custody-clock-unverified');
      writeRecord(entry.pending.id + '.retained.json', { schema: SCHEMA, type: 'retained', id: entry.pending.id,
        owner: entry.pending.owner, pendingSha256: entry.hash, capturedAtMs, reason });
    } catch (_) { sticky = true; throw custodyError('custody-retention-unverified'); }
    return Object.freeze({ retained: true });
  }
  return Object.freeze({ begin, complete, retain, inspect });
}

module.exports = { createProcessCustodyStore, SCHEMA, MAX_RECORD_BYTES, MAX_RECORD_FILES };
