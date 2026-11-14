'use strict';

// Process mechanics only. A bounded result and ownership of a possibly live
// child are separate: only its actual close event releases that custody.
const { StringDecoder } = require('node:string_decoder');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_EXIT_CLOSE_GRACE_MS = 500;
const DEFAULT_TERMINATION_GRACE_MS = 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_STDIN_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_TIMER_MS = 0x7fffffff;
const LINE_FRAGMENT_CHARS = 16384;

function duration(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_MS;
}

function createBoundedProcessRunner(deps = {}) {
  if (typeof deps.spawn !== 'function') throw new TypeError('spawn dependency is required');
  const activeChildren = deps.activeChildren || new Set();
  if (typeof activeChildren.add !== 'function' || typeof activeChildren.delete !== 'function') {
    throw new TypeError('activeChildren must support add and delete');
  }
  if (deps.onUncertain !== undefined && typeof deps.onUncertain !== 'function') {
    throw new TypeError('onUncertain must be a function');
  }
  if (deps.terminate !== undefined && typeof deps.terminate !== 'function') {
    throw new TypeError('terminate must be a function');
  }
  const onUncertain = deps.onUncertain || (() => {});
  const terminate = deps.terminate || (child => typeof child.kill === 'function' && child.kill('SIGKILL'));
  const timers = deps.timers || { setTimeout, clearTimeout };
  if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
    throw new TypeError('timers must support setTimeout and clearTimeout');
  }
  const later = (fn, ms) => timers.setTimeout(fn, ms);
  const clear = id => { if (id !== null) timers.clearTimeout(id); };

  function runProcess(exe, args, onLine = () => {}, opts = {}) {
    const timeoutMs = opts && (opts.timeoutMs === undefined || opts.timeoutMs === 0)
      ? DEFAULT_TIMEOUT_MS : opts && opts.timeoutMs;
    const exitCloseGraceMs = opts && opts.exitCloseGraceMs === undefined
      ? DEFAULT_EXIT_CLOSE_GRACE_MS : opts && opts.exitCloseGraceMs;
    const terminationGraceMs = opts && opts.terminationGraceMs === undefined
      ? DEFAULT_TERMINATION_GRACE_MS : opts && opts.terminationGraceMs;
    const heartbeatMs = opts && opts.heartbeatMs === undefined ? 0 : opts && opts.heartbeatMs;
    const maxOutputBytes = opts && opts.maxOutputBytes === undefined
      ? DEFAULT_MAX_OUTPUT_BYTES : opts && opts.maxOutputBytes;
    if (!opts || typeof opts !== 'object' || Array.isArray(opts) ||
        !duration(timeoutMs) || !duration(exitCloseGraceMs) || !duration(terminationGraceMs) ||
        !(heartbeatMs === 0 || duration(heartbeatMs)) ||
        !(opts.heartbeatLabel === undefined || typeof opts.heartbeatLabel === 'string') ||
        !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES ||
        typeof exe !== 'string' || !exe.length || !Array.isArray(args) ||
        !args.every(arg => typeof arg === 'string') || typeof onLine !== 'function') {
      return Promise.reject(new TypeError('Invalid bounded process arguments or deadline'));
    }
    let stdinInput;
    try { stdinInput = opts.stdinInput; }
    catch (_) { return Promise.reject(new TypeError('Invalid bounded stdin input')); }
    const hasInput = stdinInput !== undefined;
    if (hasInput && (!(typeof stdinInput === 'string' || Buffer.isBuffer(stdinInput)) ||
        (typeof stdinInput === 'string' ? Buffer.byteLength(stdinInput, 'utf8') : stdinInput.length) > MAX_STDIN_INPUT_BYTES)) {
      return Promise.reject(new TypeError('Invalid bounded stdin input'));
    }
    // Own the bytes before spawn. Do not put opts or this payload in an error,
    // argv, a temporary file, or uncertainty-observer metadata.
    let input = hasInput ? Buffer.from(stdinInput, typeof stdinInput === 'string' ? 'utf8' : undefined) : null;

    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let settling = false;
      let closed = false;
      let started = false;
      let rootExitConfirmed = false;
      let timedOut = false;
      let uncertain = false;
      let stdinComplete = !hasInput;
      let failureOutcome = null;
      let rejectOnFinish = false;
      let callbackError;
      let exitCode = -1;
      let deadlineTimer = null;
      let closeTimer = null;
      let terminationTimer = null;
      let heartbeatTimer = null;
      const streams = ['out', 'err'].map(kind => ({
        kind, decoder: new StringDecoder('utf8'), text: '', bytes: 0,
        pending: '', truncated: false, ended: false
      }));

      function releaseInput() {
        if (input) { input.fill(0); input = null; }
      }

      function stopTimers() {
        for (const timer of [deadlineTimer, closeTimer, terminationTimer, heartbeatTimer]) clear(timer);
        deadlineTimer = closeTimer = terminationTimer = heartbeatTimer = null;
      }

      function markUncertain(outcome) {
        if (uncertain) return;
        uncertain = true;
        try { onUncertain({ child, exe, outcome, rootExitConfirmed }); } catch (_) { /* observer cannot change custody */ }
      }

      function deliver(line, kind) {
        if (settled || failureOutcome) return;
        const trimmed = line.replace(/\s+$/, '');
        if (!trimmed) return;
        try { onLine(trimmed, kind); }
        catch (error) { fail('callback-error', true, error); }
      }

      function capture(stream, text) {
        if (!text) return;
        const bytes = Buffer.byteLength(text, 'utf8');
        const remaining = maxOutputBytes - stream.bytes;
        if (bytes <= remaining && !stream.truncated) {
          stream.text += text;
          stream.bytes += bytes;
        } else {
          if (!stream.truncated) {
            // Append whole Unicode code points only, including at a byte cap.
            for (const character of text) {
              const size = Buffer.byteLength(character, 'utf8');
              if (stream.bytes + size > maxOutputBytes) break;
              stream.text += character;
              stream.bytes += size;
            }
          }
          stream.truncated = true;
        }
        stream.pending += text;
        while (stream.pending.length && !failureOutcome) {
          const newline = stream.pending.indexOf('\n');
          if (newline !== -1 && newline <= LINE_FRAGMENT_CHARS) {
            const line = stream.pending.slice(0, newline);
            stream.pending = stream.pending.slice(newline + 1);
            deliver(line, stream.kind);
          } else if (stream.pending.length > LINE_FRAGMENT_CHARS) {
            let length = LINE_FRAGMENT_CHARS;
            const last = stream.pending.charCodeAt(length - 1);
            if (last >= 0xd800 && last <= 0xdbff) length--;
            const fragment = stream.pending.slice(0, length);
            stream.pending = stream.pending.slice(length);
            deliver(fragment, stream.kind);
          } else break;
        }
        if (failureOutcome) stream.pending = '';
      }

      function flushOutput() {
        for (const stream of streams) {
          if (!stream.ended) {
            stream.ended = true;
            capture(stream, stream.decoder.end());
          }
          const tail = stream.pending;
          stream.pending = '';
          if (tail) deliver(tail, stream.kind);
        }
      }

      function finish(outcome) {
        if (settled || settling) return;
        settling = true;
        flushOutput();
        settled = true;
        stopTimers();
        // Descendants may retain these pipes after the root has exited.
        // Closing our read ends bounds the wait; it proves no tree cleanup.
        for (const pipe of child ? [child.stdout, child.stderr] : []) {
          try { if (pipe && typeof pipe.destroy === 'function') pipe.destroy(); } catch (_) { /* retain uncertain custody */ }
        }
        const result = {
          code: exitCode, stdout: streams[0].text, stderr: streams[1].text, timedOut,
          outcome: failureOutcome || outcome,
          cleanupConfirmed: !uncertain && (closed || outcome === 'spawn-error'),
          rootExitConfirmed,
          stdinComplete,
          stdoutTruncated: streams[0].truncated, stderrTruncated: streams[1].truncated
        };
        if (rejectOnFinish) reject(callbackError);
        else resolve(result);
      }

      function fail(outcome, shouldReject = false, error) {
        if (settled || failureOutcome) return;
        failureOutcome = outcome;
        rejectOnFinish = shouldReject;
        callbackError = error;
        markUncertain(outcome);
        clear(deadlineTimer); deadlineTimer = null;
        clear(closeTimer); closeTimer = null;
        clear(heartbeatTimer); heartbeatTimer = null;
        if (closed) { finish(outcome); return; }
        // Arm first: terminate may throw, close synchronously, or never settle.
        terminationTimer = later(() => finish(outcome), terminationGraceMs);
        try {
          const pending = terminate(child);
          // Observe rejection without waiting for completion or trusting success.
          if (pending && typeof pending.then === 'function') Promise.resolve(pending).catch(() => {});
        } catch (_) { /* the independently armed grace still settles */ }
      }

      function onClose(code) {
        closed = true;
        rootExitConfirmed = true;
        exitCode = code;
        activeChildren.delete(child);
        releaseInput();
        if (!settled) {
          if (!stdinComplete && !failureOutcome) fail('stdin-incomplete');
          else finish('exited');
        }
      }

      function onError() {
        if (settled) return;
        const hasPid = Number.isSafeInteger(child && child.pid) && child.pid > 0;
        if (!started && !rootExitConfirmed && !failureOutcome && !hasPid) {
          activeChildren.delete(child);
          releaseInput();
          finish('spawn-error');
        } else fail('process-error');
      }

      function onExit(code) {
        started = true;
        rootExitConfirmed = true;
        exitCode = code;
        if (settled || failureOutcome) return;
        if (!stdinComplete) { fail('stdin-incomplete'); return; }
        clear(deadlineTimer); deadlineTimer = null;
        clear(heartbeatTimer); heartbeatTimer = null;
        if (closeTimer === null) closeTimer = later(() => {
          markUncertain('exit-unclosed');
          finish('exit-unclosed');
        }, exitCloseGraceMs);
      }

      function heartbeat() {
        if (settled || failureOutcome || rootExitConfirmed) return;
        deliver(`  ... still working (${opts.heartbeatLabel || exe})`, 'out');
        if (!settled && !failureOutcome) heartbeatTimer = later(heartbeat, heartbeatMs);
      }

      try { child = deps.spawn(exe, args, hasInput ? { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] } : { windowsHide: true }); }
      catch (_) { releaseInput(); finish('spawn-error'); return; }
      if (!child || typeof child.on !== 'function') {
        if (child) { activeChildren.add(child); fail('process-error'); }
        else { releaseInput(); finish('spawn-error'); }
        return;
      }
      activeChildren.add(child);
      started = Number.isSafeInteger(child.pid) && child.pid > 0;
      // These remain attached after settlement: close releases custody, while
      // an inert late error listener prevents EventEmitter's unhandled error.
      child.on('close', onClose);
      child.on('error', onError);
      child.on('exit', onExit);
      child.on('spawn', () => { if (!settled) started = true; });
      for (const [index, pipe] of [child.stdout, child.stderr].entries()) {
        if (!pipe || typeof pipe.on !== 'function') continue;
        // Stream errors also need an inert listener after bounded settlement.
        pipe.on('error', () => { if (!settled) fail('stream-error'); });
        pipe.on('data', chunk => {
          if (settled) return;
          started = true;
          try {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
            capture(streams[index], streams[index].decoder.write(bytes));
          } catch (error) { fail('callback-error', true, error); }
        });
      }
      deadlineTimer = later(() => { timedOut = true; fail('timeout'); }, timeoutMs);
      if (heartbeatMs > 0) heartbeatTimer = later(heartbeat, heartbeatMs);
      if (hasInput) {
        const pipe = child.stdin;
        if (!pipe || typeof pipe.on !== 'function' || typeof pipe.end !== 'function') { releaseInput(); fail('stdin-unavailable'); return; }
        // Keep listeners after bounded settlement so late EPIPE cannot become
        // an unhandled error or upgrade an already uncertain result.
        pipe.on('error', () => {
          if (settled) return;
          stdinComplete = false; fail('stdin-error');
        });
        pipe.on('close', () => { if (!settled && !stdinComplete) fail('stdin-incomplete'); });
        try {
          pipe.end(input, error => {
            releaseInput();
            if (settled || failureOutcome || rootExitConfirmed) return;
            if (error) { stdinComplete = false; fail('stdin-error'); return; }
            stdinComplete = true;
          });
        } catch (_) { stdinComplete = false; fail('stdin-error'); }
      }
    });
  }

  return runProcess;
}

module.exports = {
  createBoundedProcessRunner,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_EXIT_CLOSE_GRACE_MS,
  DEFAULT_TERMINATION_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  MAX_STDIN_INPUT_BYTES
};
