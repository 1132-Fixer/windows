'use strict';

const CANCEL_CODE = 'ERR_1132_FIX_CANCELLED';

// These explicit engine checkpoints follow completed work. Cancellation
// waits through account/profile rebuilding; this does not provide rollback.
const FIX_CHECKPOINTS = Object.freeze([
  'before-close-helper', 'before-profile-plan', 'before-profile-rebuild',
  'before-preferences', 'before-relaunch', 'before-verification'
]);

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

    const ownedSession = session;
    const wrapped = Object.create(event || null);
    Object.defineProperty(wrapped, 'fixCheckpoint', {
      value(name) {
        if (session !== ownedSession || !FIX_CHECKPOINTS.includes(name)) {
          throw new Error('Invalid repair checkpoint');
        }
        if (ownedSession.requested) {
          ownedSession.stoppedBefore = name;
          try {
            originalSender.send('fix-log', {
              line: 'Repair cancelled after the current step. Completed changes remain; no further steps will run.',
              kind: 'header'
            });
          } catch (_) { /* keep engine cancellation when renderer is gone */ }
          throw makeCancelledError();
        }
      }
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
        return { success: false, cancelled: true, error: 'cancelled', stoppedBefore: session.stoppedBefore };
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
  FIX_CHECKPOINTS,
  createFixCancelBroker
};
