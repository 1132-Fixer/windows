'use strict';

/**
 * Inactivity warning and automatic exit for 1132 Fixer.
 *
 * Authoritative timer in the main process. The renderer only reports user
 * activity and displays the warning; if it reloads, crashes or is hidden,
 * the timer here keeps its own time.
 *
 *   ACTIVE ──30 s without activity──▶ INACTIVE_WARNING ──30 s──▶ EXIT_PENDING ──▶ EXITING
 *     ▲            │ activity                 │ activity
 *     └────────────┴───────────────────────────┘
 *   any of the above ──critical operation begins──▶ SUSPENDED_FOR_OPERATION
 *   SUSPENDED_FOR_OPERATION ──operation ends──▶ ACTIVE (timer starts fresh)
 *
 * Time is read from a monotonic clock through `now()`; the countdown shown
 * to the user is `exitAt - now()`, never "ticks × 1 s". Exactly one
 * inactivity timer (to the warning) and one countdown timer (the 1 s tick
 * during the warning) exist at any moment. Sleep and session lock pause the
 * clock; on resume the real elapsed inactivity is evaluated and, if the
 * limit passed, the warning is shown with a full countdown — the app is
 * never closed straight out of sleep.
 *
 * Exiting goes through `requestExit('inactive_exit')`, i.e. the normal
 * graceful shutdown with a named reason, never a process kill. An updater
 * restart is a different reason and is never produced here.
 */

const STATES = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE_WARNING: 'INACTIVE_WARNING',
  EXIT_PENDING: 'EXIT_PENDING',
  SUSPENDED_FOR_OPERATION: 'SUSPENDED_FOR_OPERATION',
  EXITING: 'EXITING'
});

const WARNING_AFTER_MS = 30 * 1000;
const EXIT_AFTER_WARNING_MS = 30 * 1000;
const TICK_MS = 1000;
const ACTIVITY_THROTTLE_MS = 250;

// Activity kinds the renderer / main may report. Anything else is ignored,
// so an internal event can never be mistaken for the user.
const ACTIVITY_KINDS = new Set([
  'pointermove', 'pointerdown', 'keydown', 'touch', 'pen', 'wheel', 'scroll',
  'focus', 'command', 'dialog'
]);

function createInactivityController(deps = {}) {
  const now = deps.now || (() => Number(process.hrtime.bigint() / 1000000n));
  const wallNow = deps.wallNow || (() => Date.now());
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};
  const requestExit = typeof deps.requestExit === 'function' ? deps.requestExit : () => ({ accepted: false });
  const log = deps.log || null;
  const warningAfterMs = deps.warningAfterMs || WARNING_AFTER_MS;
  const exitAfterWarningMs = deps.exitAfterWarningMs || EXIT_AFTER_WARNING_MS;
  const tickMs = deps.tickMs || TICK_MS;
  const criticalOps = deps.criticalOps || null;
  const enabled = deps.enabled !== false;

  let state = STATES.ACTIVE;
  let lastActivityAt = now();
  let lastActivityWall = wallNow();
  let lastActivityKind = 'start';
  let warningAt = 0;
  let exitAt = 0;
  let inactivityTimer = null;
  let countdownTimer = null;
  let paused = null; // { reason, at }
  let started = false;
  let disposed = false;
  let exitRequested = false;
  const counters = { activity: 0, ignored: 0, warnings: 0, resets: 0, suspends: 0 };

  function logInfo(event, fields) { if (log) log.info(`inactivity.${event}`, fields || {}); }

  function status() {
    const t = now();
    return {
      state,
      remainingMs: state === STATES.INACTIVE_WARNING || state === STATES.EXIT_PENDING ? Math.max(0, exitAt - t) : null,
      warningInMs: state === STATES.ACTIVE && warningAt ? Math.max(0, warningAt - t) : null,
      totalMs: warningAfterMs + exitAfterWarningMs,
      paused: paused ? paused.reason : null,
      critical: criticalOps ? criticalOps.active() : []
    };
  }
  function publish(extra) {
    try { emit(Object.assign(status(), extra || {})); } catch (_) { /* renderer gone */ }
  }

  function clearInactivityTimer() {
    if (inactivityTimer) { clearTimer(inactivityTimer); inactivityTimer = null; }
  }
  function clearCountdownTimer() {
    if (countdownTimer) { clearTimer(countdownTimer); countdownTimer = null; }
  }
  function clearAll() {
    clearInactivityTimer();
    clearCountdownTimer();
  }

  function scheduleWarning(delayMs) {
    clearInactivityTimer();
    warningAt = now() + Math.max(0, delayMs);
    inactivityTimer = setTimer(onInactivityElapsed, Math.max(0, delayMs));
  }

  function setState(next, why) {
    if (state === next) return;
    const prev = state;
    state = next;
    logInfo('state', { from: prev, to: next, why });
  }

  function enterActive(why, fresh) {
    if (disposed || state === STATES.EXITING) return;
    clearAll();
    if (fresh) { lastActivityAt = now(); lastActivityWall = wallNow(); }
    setState(STATES.ACTIVE, why);
    if (!enabled || paused) { warningAt = 0; publish(); return; }
    scheduleWarning(Math.max(0, lastActivityAt + warningAfterMs - now()));
    publish();
  }

  function enterWarning(why) {
    if (disposed || state === STATES.EXITING) return;
    if (criticalOps && criticalOps.isActive()) { enterSuspended('critical-at-warning'); return; }
    clearAll();
    counters.warnings++;
    setState(STATES.INACTIVE_WARNING, why);
    exitAt = now() + exitAfterWarningMs;
    countdownTimer = setTimer(onTick, tickMs);
    logInfo('warning', { why, exitInMs: exitAfterWarningMs, sinceActivityMs: now() - lastActivityAt, lastActivityKind });
    publish({ event: 'warning' });
  }

  function enterSuspended(why) {
    if (disposed || state === STATES.EXITING) return;
    const wasWarning = state === STATES.INACTIVE_WARNING || state === STATES.EXIT_PENDING;
    clearAll();
    counters.suspends++;
    setState(STATES.SUSPENDED_FOR_OPERATION, why);
    warningAt = 0;
    exitAt = 0;
    publish(wasWarning ? { event: 'dismiss' } : undefined);
  }

  function onInactivityElapsed() {
    inactivityTimer = null;
    if (state !== STATES.ACTIVE) return;
    const idle = now() - lastActivityAt;
    if (idle < warningAfterMs) { scheduleWarning(warningAfterMs - idle); return; }
    enterWarning('idle');
  }

  function onTick() {
    countdownTimer = null;
    if (state !== STATES.INACTIVE_WARNING) return;
    const remaining = exitAt - now();
    if (remaining > 0) {
      countdownTimer = setTimer(onTick, Math.min(tickMs, remaining));
      publish();
      return;
    }
    exitNow('countdown-elapsed');
  }

  function exitNow(why) {
    if (disposed || exitRequested) return { accepted: false, reason: 'already' };
    setState(STATES.EXIT_PENDING, why);
    // Final guards, evaluated at the moment of exit: a critical operation
    // that started during the last tick, or activity that arrived late.
    if (criticalOps && criticalOps.isActive()) { enterSuspended('critical-at-exit'); return { accepted: false, reason: 'critical' }; }
    if (now() - lastActivityAt < warningAfterMs + exitAfterWarningMs - tickMs) { enterActive('late-activity', false); return { accepted: false, reason: 'activity' }; }
    clearAll();
    exitRequested = true;
    setState(STATES.EXITING, why);
    logInfo('exit', { why, sinceActivityMs: now() - lastActivityAt, lastActivityKind });
    publish({ event: 'exiting' });
    let r;
    try { r = requestExit('inactive_exit'); } catch (err) { r = { accepted: false, error: err && err.message }; }
    return r || { accepted: true };
  }

  // ---- inputs -----------------------------------------------------------
  function activity(kind, source) {
    if (disposed || state === STATES.EXITING) { counters.ignored++; return false; }
    if (!ACTIVITY_KINDS.has(kind)) { counters.ignored++; return false; }
    const t = now();
    const throttled = t - lastActivityAt < ACTIVITY_THROTTLE_MS && state === STATES.ACTIVE;
    lastActivityAt = t;
    lastActivityWall = wallNow();
    lastActivityKind = kind;
    counters.activity++;
    if (throttled) return true; // recorded; no timer churn
    if (state === STATES.INACTIVE_WARNING || state === STATES.EXIT_PENDING) {
      counters.resets++;
      logInfo('dismissed', { kind, source: source || null });
      clearAll();
      setState(STATES.ACTIVE, `activity:${kind}`);
      scheduleWarning(warningAfterMs);
      publish({ event: 'dismiss' });
      return true;
    }
    if (state === STATES.ACTIVE) {
      // One timer: re-arm to the new deadline instead of stacking timers.
      if (!paused && enabled) scheduleWarning(warningAfterMs);
      return true;
    }
    // SUSPENDED: the time is recorded; the timer restarts when the
    // operation ends.
    return true;
  }

  function keepOpen(source) {
    return activity('command', source || 'keep-open');
  }

  function closeNow(source) {
    if (disposed || exitRequested) return { accepted: false };
    clearAll();
    exitRequested = true;
    setState(STATES.EXITING, `close-now:${source || 'user'}`);
    logInfo('close-now', { source: source || 'user' });
    publish({ event: 'exiting' });
    return requestExit('user_exit') || { accepted: true };
  }

  function onCriticalChange(active) {
    if (disposed || state === STATES.EXITING) return;
    if (active) { enterSuspended('operation'); return; }
    if (state === STATES.SUSPENDED_FOR_OPERATION) enterActive('operation-finished', true);
  }

  // Sleep / lock: stop the clock. Resume / unlock: real elapsed time decides.
  function pause(reason) {
    if (disposed || state === STATES.EXITING) return;
    if (paused) return;
    paused = { reason, at: now(), wall: wallNow() };
    clearAll();
    if (state === STATES.INACTIVE_WARNING || state === STATES.EXIT_PENDING) {
      setState(STATES.ACTIVE, `pause:${reason}`);
      publish({ event: 'dismiss' });
    }
    logInfo('pause', { reason });
  }
  function resume(reason) {
    if (disposed || state === STATES.EXITING) return;
    if (!paused) return;
    const p = paused;
    paused = null;
    const elapsedWall = wallNow() - lastActivityWall;
    logInfo('resume', { reason, pausedFor: p.reason, elapsedSinceActivityMs: elapsedWall });
    if (state === STATES.SUSPENDED_FOR_OPERATION) return;
    if (elapsedWall >= warningAfterMs) {
      // Long absence: warn first with a full countdown, never exit at once.
      lastActivityAt = now() - warningAfterMs;
      enterWarning(`resume:${reason}`);
      return;
    }
    // Continue where the clock stopped.
    lastActivityAt = now() - elapsedWall;
    enterActive(`resume:${reason}`, false);
  }

  function start() {
    if (started || disposed) return;
    started = true;
    if (criticalOps && typeof criticalOps.onChange === 'function') criticalOps.onChange(onCriticalChange);
    if (criticalOps && criticalOps.isActive()) { enterSuspended('start'); return; }
    enterActive('start', true);
  }

  function dispose() {
    disposed = true;
    clearAll();
  }

  return {
    STATES,
    start,
    activity,
    keepOpen,
    closeNow,
    pause,
    resume,
    exitNow,
    dispose,
    status,
    getState: () => state,
    timers: () => ({ inactivity: !!inactivityTimer, countdown: !!countdownTimer }),
    counters: () => Object.assign({}, counters),
    _test: { onCriticalChange }
  };
}

module.exports = {
  STATES,
  WARNING_AFTER_MS,
  EXIT_AFTER_WARNING_MS,
  TICK_MS,
  ACTIVITY_THROTTLE_MS,
  ACTIVITY_KINDS,
  createInactivityController
};
