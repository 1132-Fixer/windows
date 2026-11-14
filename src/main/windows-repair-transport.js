'use strict';

// Wire transport, not persistent authority. The caller must independently gate
// worker creation/recovery and the native store must guard every repair effect.
// No PID is an ownership token. No timeout kills, replaces, or replays a worker.
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { REQUIRED_ADAPTERS } = require('./helper-reset-controller');

const BOOTSTRAP_LOADER = "$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()));$h=[Security.Cryptography.SHA256]::Create();try{$global:FixerResetScriptSha256=([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};& ([scriptblock]::Create($s))";
const BOOTSTRAP_ARGS = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', BOOTSTRAP_LOADER]);
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_BOOTSTRAP_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RECORDS = 4096;
const COMMANDS = new Set([...REQUIRED_ADAPTERS, 'inspectRecovery', 'workflow-launch-zoom',
  'workflow-verify-profile', 'workflow-configure-helper', 'workflow-seal-credential', 'workflow-persist-credential', 'workflow-verify-zoom']);
const SECRET_COMMANDS = new Set(['createDisabledAccount', 'workflow-launch-zoom', 'workflow-seal-credential']);
const READ_ONLY = new Set(['inspectRecovery', 'readJournal', 'inspectAdmission', 'revalidateAdmission',
  'verifyOperatorTarget', 'revalidateEffect', 'captureResetSnapshot', 'verifyProvisionedState', 'acquireLease']);
const NATIVE_ERRORS = new Set(['unsupported_host', 'storage_unverified', 'context_invalid', 'lease_busy',
  'prior_unresolved', 'identity_mismatch', 'target_in_use', 'namespace_not_absent', 'credentials_invalid',
  'profile_purge_incomplete', 'profile_creation_mismatch', 'binding_unverified', 'journal_unverified',
  'recovery_required', 'native_failure', 'zoom_untrusted', 'zoom_not_ready', 'zoom_exited',
  'profile_privileges_unavailable', 'profile_privilege_restore_unverified',
  'standard_account_unverified', 'standard_account_privileged']);
const STARTUP_ERRORS = new Set(['unsupported_host', 'storage_unverified', 'native_failure', 'profile_privileges_unavailable']);
const RETAIN_CODES = new Set(['startup_timeout', 'startup_error', 'invalid_ready', 'invalid_frame', 'oversized_frame',
  'invalid_response', 'unexpected_response', 'duplicate_response', 'secret_in_response', 'worker_error',
  'worker_stderr', 'worker_exited', 'unclear_close', 'stdin_error', 'command_timeout', 'close_timeout', 'caller_retained']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const duration = value => Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
const safeFailure = code => ({ ok: false, completed: false, error: { code } });
function transportError(code) { const error = new Error(code); error.code = code; return error; }
function localPwsh(value) {
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value) &&
    !/[\x00-\x1f"<>|?*]/.test(value) && !value.slice(2).includes(':') &&
    path.win32.basename(value).toLowerCase() === 'pwsh.exe';
}
function jsonValue(value, seen = new Set(), depth = 0) {
  if (depth > 20) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!record(value) && !Array.isArray(value) || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const valid = Object.values(descriptors).every(entry => Object.hasOwn(entry, 'value') && jsonValue(entry.value, seen, depth + 1));
  seen.delete(value);
  return valid;
}
function containsSensitive(value, secrets, depth = 0) {
  if (depth > 24) return true;
  if (typeof value === 'string') return [...secrets].some(secret => value.includes(secret));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => /^(secret|password|credential|plaintext|privateKey|accessToken)$/i.test(key) ||
    [...secrets].some(secret => key.includes(secret)) || containsSensitive(item, secrets, depth + 1));
}

function createWindowsRepairTransport(options = {}) {
  if (typeof options.spawn !== 'function' || !options.fs || typeof options.fs.realpathSync !== 'function' ||
      typeof options.fs.statSync !== 'function') throw new TypeError('Explicit spawn and filesystem adapters are required');
  const timers = options.timers || { setTimeout, clearTimeout };
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') throw new TypeError('Invalid timers');
  const later = (fn, ms) => timers.setTimeout(fn, ms);
  const clear = timer => { if (timer !== null) timers.clearTimeout(timer); };
  const admissions = new Set();
  const nonces = new Set();
  let current = null;

  function start(config = {}) {
    if (current) return Promise.reject(transportError('worker_owned'));
    if (!record(config)) return Promise.reject(transportError('invalid_config'));
    const admission = config.admission;
    if (!record(admission) || admission.verified !== true || admission.kind !== 'recovery-probe' ||
        !identifier(admission.machineId) || !identifier(admission.token)) return Promise.reject(transportError('admission_required'));
    if (admissions.has(admission.token)) return Promise.reject(transportError('admission_replayed'));
    const startupMs = config.startupTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : config.startupTimeoutMs;
    const maxBytes = config.maxResponseBytes === undefined ? DEFAULT_MAX_RESPONSE_BYTES : config.maxResponseBytes;
    const args = config.startArgs === undefined ? BOOTSTRAP_ARGS : config.startArgs;
    if (!duration(startupMs) || !Number.isSafeInteger(maxBytes) || maxBytes < 256 || maxBytes > 1024 * 1024 ||
        !Array.isArray(args) || args.length !== BOOTSTRAP_ARGS.length || args.some((arg, index) => arg !== BOOTSTRAP_ARGS[index]) ||
        typeof config.scriptSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(config.scriptSha256) ||
        typeof config.bootstrapLine !== 'string' || !config.bootstrapLine.length ||
        Buffer.byteLength(config.bootstrapLine) > MAX_BOOTSTRAP_BYTES ||
        config.bootstrapLine.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(config.bootstrapLine)) {
      return Promise.reject(transportError('invalid_config'));
    }
    const source = Buffer.from(config.bootstrapLine, 'base64');
    if (source.toString('base64') !== config.bootstrapLine || !Buffer.from(source.toString('utf8')).equals(source) ||
        crypto.createHash('sha256').update(source).digest('hex') !== config.scriptSha256) {
      return Promise.reject(transportError('script_mismatch'));
    }
    source.fill(0);
    let executable;
    try {
      if (!localPwsh(options.pwshPath)) throw transportError('invalid_pwsh_path');
      executable = options.fs.realpathSync(options.pwshPath);
      if (!localPwsh(executable) || !options.fs.statSync(executable).isFile()) throw transportError('invalid_pwsh_path');
    } catch (_) { return Promise.reject(transportError('invalid_pwsh_path')); }
    admissions.add(admission.token);

    return new Promise((resolveStart, rejectStart) => {
      let child;
      let ready = null;
      let retained = false;
      let retainReason = null;
      let closedObserved = false;
      let cleanReleased = false;
      let startupSettled = false;
      let startupTimer = null;
      let pending = null;
      let writing = null;
      // One fixed byte buffer avoids repeated concatenation for fragmented IO.
      const partial = Buffer.alloc(maxBytes);
      let partialLength = 0;
      let dropping = false;
      let effectDispatched = false;
      let acquired = null;
      let releaseVerified = false;
      let closing = null;
      let closeSerial = 0;
      const records = new Map();
      const secrets = new Set();

      function retain(code) {
        if (retained || cleanReleased) return;
        retained = true;
        retainReason = RETAIN_CODES.has(code) ? code : 'caller_retained';
        try { if (options.onRetained) options.onRetained({ session, workerHandle: child, reason: retainReason }); } catch (_) {}
      }
      function settleStart(error) {
        if (startupSettled) return;
        startupSettled = true; clear(startupTimer); startupTimer = null;
        if (error) rejectStart(transportError(error)); else resolveStart(session);
      }
      function failPending(code) {
        if (!pending) return;
        const item = pending; pending = null; clear(item.timer); item.timer = null;
        item.timedOut = code === 'command_timeout'; item.settled = true;
        item.resolve({ ...safeFailure(code), id: item.id, command: item.command, retained: true });
      }
      function fail(code, startupCode = code) {
        if (cleanReleased) return;
        retain(code); settleStart(startupCode); failPending(code);
        if (closing) finishClose(safeFailure(code));
      }
      function observation(item, observational = false) {
        if (!item.response) return null;
        const copy = JSON.parse(JSON.stringify(item.response));
        // Historical/late observation never substitutes for request settlement
        // or the native adapter's scoped proof validation.
        if (observational) { copy.authoritative = false; copy.retained = retained; }
        return copy;
      }
      function finishRequest(item) {
        if (!item.response || !item.flushed || item.settled) return;
        clear(item.timer); item.timer = null; item.settled = true;
        if (pending === item) pending = null;
        item.resolve(observation(item));
      }
      function flushed(write) {
        if (!write.returned || !write.callback || (write.backpressure && !write.drained)) return;
        write.bytes.fill(0);
        if (writing === write) writing = null;
        if (write.item) { write.item.flushed = true; finishRequest(write.item); }
        else if (ready && !retained) settleStart();
      }
      function writePacket(bytes, item) {
        const write = { bytes, item, returned: false, callback: false, backpressure: false, drained: false };
        writing = write;
        try {
          const accepted = child.stdin.write(bytes, error => {
            if (error) { bytes.fill(0); fail('stdin_error'); return; }
            write.callback = true; flushed(write);
          });
          write.backpressure = accepted === false; write.returned = true;
          if (accepted !== true && accepted !== false) { fail('stdin_error'); return; }
          flushed(write);
        } catch (_) { bytes.fill(0); fail('stdin_error'); }
      }
      function scopeFrom(context) {
        const op = record(context) && context.operation;
        return record(op) ? { id: op.id, generation: op.generation, machineId: op.machineId } : null;
      }
      function releasedResult(item, result) {
        const scope = item.scope;
        return acquired && scope && result.status === 'released' && result.complete === true &&
          result.nonce === acquired.nonce && result.leaseNonce === acquired.nonce &&
          result.operationId === acquired.id && result.generation === acquired.generation &&
          result.machineId === ready.machineId && scope.id === acquired.id &&
          scope.generation === acquired.generation && scope.machineId === ready.machineId;
      }
      function receive(message) {
        if (!record(message) || containsSensitive(message, secrets)) { fail('secret_in_response'); return; }
        if (!ready) {
          if (message.kind === 'startup-error' && message.protocolVersion === 1 && record(message.error)) {
            fail('startup_error', STARTUP_ERRORS.has(message.error.code) ? message.error.code : 'native_failure'); return;
          }
          const shell = message.shell;
          const caps = message.capabilities;
          if (startupSettled || message.kind !== 'ready' || message.protocolVersion !== 1 ||
              message.scriptSha256 !== config.scriptSha256 || !identifier(message.workerNonce) || nonces.has(message.workerNonce) ||
              message.machineId !== admission.machineId || !record(shell) || !Number.isSafeInteger(shell.major) ||
              shell.major < 7 || shell.edition !== 'Core' || shell.is64Bit !== true || message.storageProtected !== true ||
              !record(caps) || caps.atomicIdentityExpectation !== true || caps.exclusiveProfileCreation !== true ||
              caps.completePurgeReadback !== true) { fail('invalid_ready'); return; }
          ready = { protocolVersion: 1, scriptSha256: message.scriptSha256, workerNonce: message.workerNonce,
            machineId: message.machineId, shell: { major: shell.major, edition: 'Core', is64Bit: true },
            capabilities: { atomicIdentityExpectation: true, exclusiveProfileCreation: true, completePurgeReadback: true }, storageProtected: true };
          nonces.add(ready.workerNonce);
          if (!writing && !retained) settleStart();
          return;
        }
        if (message.kind !== 'response' || message.protocolVersion !== 1 || message.scriptSha256 !== ready.scriptSha256 ||
            message.workerNonce !== ready.workerNonce || !identifier(message.id) || typeof message.ok !== 'boolean' ||
            message.completed !== true) { fail('invalid_response'); return; }
        const item = records.get(message.id);
        if (!item || item.command !== message.command) { fail('unexpected_response'); return; }
        if (item.response) { fail('duplicate_response'); return; }
        if (message.ok && (!record(message.result) || Object.hasOwn(message, 'error')) ||
            !message.ok && (!record(message.error) || typeof message.error.code !== 'string')) { fail('invalid_response'); return; }
        const response = { kind: 'response', protocolVersion: 1, scriptSha256: ready.scriptSha256,
          workerNonce: ready.workerNonce, id: item.id, command: item.command, ok: message.ok, completed: true };
        if (message.ok) response.result = message.result;
        else response.error = { code: NATIVE_ERRORS.has(message.error.code) ? message.error.code : 'native_failure' };
        item.response = response;
        if (!item.settled && message.ok && item.command === 'acquireLease') {
          const result = message.result;
          if (result.status === 'held' && result.complete === true && result.scope === 'machine' &&
              result.exclusive === true && identifier(result.nonce) && item.scope && identifier(item.scope.id) &&
              Number.isSafeInteger(item.scope.generation) && item.scope.generation > 0 &&
              item.scope.machineId === ready.machineId && result.operationId === item.scope.id &&
              result.generation === item.scope.generation && result.machineId === ready.machineId) acquired = { ...item.scope, nonce: result.nonce };
        }
        if (!item.settled && message.ok && item.command === 'releaseLease') releaseVerified = releasedResult(item, message.result);
        if (item.settled) {
          try { if (options.onLateResponse) options.onLateResponse({ id: item.id, command: item.command, response: observation(item, true) }); } catch (_) {}
          return;
        }
        finishRequest(item);
      }
      function line(bytes) {
        if (bytes.length && bytes[bytes.length - 1] === 13) bytes = bytes.subarray(0, -1);
        try {
          const decoder = new StringDecoder('utf8');
          const text = decoder.write(bytes) + decoder.end();
          if (!Buffer.from(text, 'utf8').equals(bytes)) { fail('invalid_frame'); return; }
          receive(JSON.parse(text));
        } catch (_) { fail('invalid_frame'); }
      }
      function stdout(chunk) {
        if (closedObserved) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          const end = bytes.indexOf(10, offset);
          const stop = end < 0 ? bytes.length : end;
          const part = bytes.subarray(offset, stop);
          if (!dropping && partialLength + part.length > maxBytes) {
            partialLength = 0; dropping = true; fail('oversized_frame');
          }
          if (!dropping && part.length) { part.copy(partial, partialLength); partialLength += part.length; }
          if (end >= 0) {
            if (!dropping) line(partial.subarray(0, partialLength));
            partialLength = 0; dropping = false; offset = end + 1;
          } else break;
        }
      }
      function request(message, requestOptions = {}, internalClose = false) {
        if (retained || closedObserved) return Promise.resolve(safeFailure('worker_retained'));
        if (!ready || !startupSettled) return Promise.resolve(safeFailure('worker_not_ready'));
        if (pending || writing || closing && !internalClose) return Promise.resolve(safeFailure('rpc_busy'));
        if (!record(requestOptions)) return Promise.resolve(safeFailure('invalid_request'));
        const ms = requestOptions.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : requestOptions.timeoutMs;
        if (!record(message) || !identifier(message.id) || message.id.startsWith('transport-close-') && !internalClose ||
            !(internalClose ? message.command === 'close' : COMMANDS.has(message.command)) ||
            !record(message.context) || !jsonValue(message.context) || !duration(ms) ||
            records.has(message.id) || records.size >= MAX_RECORDS && !internalClose ||
            message.secret !== undefined && (!SECRET_COMMANDS.has(message.command) || typeof message.secret !== 'string' ||
              !message.secret.length || Buffer.byteLength(message.secret) > 512)) return Promise.resolve(safeFailure('invalid_request'));
        const packet = { id: message.id, command: message.command, context: message.context };
        if (message.secret !== undefined) {
          if (containsSensitive({ id: message.id, context: message.context }, new Set([message.secret]))) return Promise.resolve(safeFailure('invalid_request'));
          packet.secret = message.secret; secrets.add(message.secret);
        }
        if (containsSensitive({ id: message.id, command: message.command, context: message.context }, secrets)) return Promise.resolve(safeFailure('invalid_request'));
        let bytes;
        try { bytes = Buffer.from(JSON.stringify(packet) + '\n', 'utf8'); } catch (_) { return Promise.resolve(safeFailure('invalid_request')); }
        if (bytes.length > MAX_REQUEST_BYTES) { bytes.fill(0); return Promise.resolve(safeFailure('oversized_request')); }
        return new Promise(resolve => {
          const item = { id: message.id, command: message.command, scope: scopeFrom(message.context),
            response: null, flushed: false, settled: false, timedOut: false, resolve, timer: null };
          records.set(item.id, item); pending = item;
          if (item.command === 'acquireLease' || !READ_ONLY.has(item.command) && item.command !== 'close') releaseVerified = false;
          if (!READ_ONLY.has(item.command) && item.command !== 'close') effectDispatched = true;
          item.timer = later(() => { retain('command_timeout'); failPending('command_timeout'); }, ms);
          writePacket(bytes, item);
        });
      }
      function finishClose(result) {
        if (!closing || closing.settled) return;
        closing.settled = true; clear(closing.timer); closing.timer = null;
        closing.resolve(result);
      }
      function close(closeOptions = {}) {
        if (closing) return closing.promise;
        if (!record(closeOptions)) return Promise.resolve(safeFailure('close_unverified'));
        const ms = closeOptions.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : closeOptions.timeoutMs;
        if (retained || pending || writing || !ready || !duration(ms) ||
            !releaseVerified && (effectDispatched || acquired)) return Promise.resolve(safeFailure('close_unverified'));
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        closing = { promise, resolve, timer: null, settled: false, receipt: false };
        closing.timer = later(() => {
          retain('close_timeout'); failPending('close_timeout'); finishClose(safeFailure('close_timeout'));
        }, ms);
        request({ id: 'transport-close-' + (++closeSerial), command: 'close', context: {} }, { timeoutMs: ms }, true).then(response => {
          if (closing.settled) return;
          if (!response.ok || !record(response.result) || response.result.status !== 'closed' ||
              response.result.complete !== true || response.result.leaseHeld !== false) { fail('unclear_close'); return; }
          closing.receipt = true;
          try { if (!closedObserved) child.stdin.end(); } catch (_) { fail('stdin_error'); return; }
          if (closedObserved) completeClose();
        });
        return promise;
      }
      function completeClose() {
        if (!closing || !closing.receipt || retained) return;
        cleanReleased = true;
        current = null;
        secrets.clear();
        finishClose({ ok: true, completed: true, result: { status: 'closed', complete: true, leaseHeld: false } });
      }
      const session = Object.freeze({ request: (message, requestOptions) => request(message, requestOptions), close,
        retainCustody: reason => { fail(RETAIN_CODES.has(reason) ? reason : 'caller_retained'); },
        info: () => ready && JSON.parse(JSON.stringify(ready)),
        state: () => ({ retained, reason: retainReason, ready: !!ready, closedObserved, ownsWorker: current === session }),
        observe: id => records.has(id) ? observation(records.get(id), true) : null });
      current = session;
      try { child = options.spawn(executable, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (_) { current = null; settleStart('worker_spawn_failed'); return; }
      if (!child || typeof child.on !== 'function' || !child.stdin || typeof child.stdin.write !== 'function' ||
          typeof child.stdin.on !== 'function' || !child.stdout || typeof child.stdout.on !== 'function' ||
          !child.stderr || typeof child.stderr.on !== 'function') { fail('worker_error'); return; }
      child.on('error', () => fail('worker_error'));
      child.on('exit', (code, signal) => { if (!closing || code !== 0 || signal) fail('worker_exited'); });
      child.on('close', (code, signal) => {
        if (closedObserved) return;
        closedObserved = true;
        if (partialLength || dropping || code !== 0 || signal || !closing) { fail('unclear_close'); return; }
        // The close response may already be parsed but its Promise continuation
        // has not run yet. Only that exact response can complete clean custody.
        const closeRecord = records.get('transport-close-' + closeSerial);
        if (!closeRecord || !closeRecord.response || !closeRecord.response.ok) { fail('unclear_close'); return; }
        if (closing.receipt) completeClose();
      });
      child.stdout.on('data', stdout);
      child.stdout.on('error', () => fail('worker_error'));
      child.stderr.on('data', bytes => { if (bytes && bytes.length) fail('worker_stderr'); });
      child.stderr.on('error', () => fail('worker_error'));
      child.stdin.on('error', () => fail('stdin_error'));
      child.stdin.on('drain', () => { if (writing) { writing.drained = true; flushed(writing); } });
      startupTimer = later(() => fail('startup_timeout'), startupMs);
      writePacket(Buffer.from(config.bootstrapLine + '\n', 'ascii'), null);
    });
  }

  return Object.freeze({ start, currentSession: () => current });
}

module.exports = { createWindowsRepairTransport, BOOTSTRAP_ARGS, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_RESPONSE_BYTES };
