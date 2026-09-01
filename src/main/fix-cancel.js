'use strict';

const CANCEL_CODE = 'ERR_1132_FIX_CANCELLED';

// Cancellation is cooperative. These are the repair boundaries where the
// current step has finished and no account/profile transaction is half-built.
// Steps 3 -> 6 intentionally form one atomic recovery section: once account
// teardown starts, cancellation waits until the new helper profile is stable.
function isSafeFixCancelBoundary(line) {
  const text = String(line || '').trim();
  return /^\[(?:1|2|3|7|8)\/8\]\s/.test(text) || /^\[V\]\s/.test(text);
}

function makeCancelledError() {
  const error = new Error('Fix cancelled at a safe boundary');
  error.code = CANCEL_CODE;
  return error;
}

function senderIdentity(event) {
  const sender = event && event.sender;
  if (!sender) return null;
  return sender.id !== undefined && sender.id !== null ? `id:${sender.id}` : sender;
}

function createFixCancelBroker() {
  let session = null;

  function sameSender(event) {
    return !!session && senderIdentity(event) === session.sender;
  }

  function isRunningFor(event) {
    return sameSender(event);
  }

  function requestCancel(event) {
    if (!sameSender(event)) {
      return { success: false, cancelRequested: false, reason: 'no_fix_running' };
    }
    session.requested = true;
    return { success: true, cancelRequested: true };
  }

  function wrapEvent(event) {
    const originalSender = event && event.sender;
    if (!originalSender || typeof originalSender.send !== 'function') return event;

    const sender = new Proxy(originalSender, {
      get(target, prop) {
        if (prop === 'send') {
          return (channel, payload, ...rest) => {
            const line = channel === 'fix-log' && payload && typeof payload === 'object'
              ? payload.line
              : '';
            if (session && session.requested && isSafeFixCancelBoundary(line)) {
              try {
                target.send('fix-log', {
                  line: 'Fix cancelled safely — no further changes will be made.',
                  kind: 'header'
                });
              } catch (_) { /* renderer may already be gone */ }
              throw makeCancelledError();
            }
            return target.send(channel, payload, ...rest);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });

    const wrapped = Object.create(event || null);
    Object.defineProperty(wrapped, 'sender', {
      configurable: true,
      enumerable: true,
      value: sender
    });
    return wrapped;
  }

  async function run(event, invoke) {
    if (session) throw new Error('A fix cancellation session is already active');
    if (typeof invoke !== 'function') throw new Error('Fix cancellation broker requires an invoke function');

    session = {
      sender: senderIdentity(event),
      requested: false
    };

    try {
      const result = await invoke(wrapEvent(event));
      if (session.requested && result && typeof result === 'object') {
        // The request arrived after the last cancellable boundary. Preserve the
        // real outcome and say explicitly that cancellation was too late.
        if (result.success === true) return { ...result, cancelTooLate: true };
        return { ...result, cancelRequested: true };
      }
      return result;
    } catch (error) {
      if (error && error.code === CANCEL_CODE) {
        return { success: false, cancelled: true, error: 'cancelled' };
      }
      throw error;
    } finally {
      session = null;
    }
  }

  return {
    isRunningFor,
    requestCancel,
    run
  };
}

module.exports = {
  CANCEL_CODE,
  isSafeFixCancelBoundary,
  createFixCancelBroker
};
