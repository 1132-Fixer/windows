'use strict';

/**
 * Shutdown reasons for 1132 Fixer.
 *
 * Every path that ends the process names why, once. The first reason wins;
 * later requests are recorded as duplicates and do not start a second
 * quit. The reason is what distinguishes an updater restart (the installer
 * relaunches the new version) from a user exit, an inactivity exit, and an
 * OS-initiated shutdown, so cleanup logic can tell them apart instead of
 * treating every quit the same.
 */

const REASONS = Object.freeze({
  USER_EXIT: 'user_exit',
  INACTIVE_EXIT: 'inactive_exit',
  UPDATE_RESTART: 'update_restart',
  UPDATE_INSTALL_ON_EXIT: 'update_install_on_exit',
  SYSTEM_SHUTDOWN: 'system_shutdown',
  FATAL: 'fatal',
  SECOND_INSTANCE: 'second_instance',
  ELEVATED_RELAUNCH: 'elevated_relaunch'
});

const KNOWN = new Set(Object.values(REASONS));

function createShutdownController(deps = {}) {
  const quit = typeof deps.quit === 'function' ? deps.quit : () => {};
  const log = deps.log || null;
  let reason = null;
  let requestedAt = null;
  const duplicates = [];
  const listeners = [];

  function request(why, extra) {
    const r = KNOWN.has(why) ? why : REASONS.USER_EXIT;
    if (reason) {
      duplicates.push({ reason: r, at: Date.now() });
      if (log) log.warn('shutdown.duplicate-request', { reason: r, firstReason: reason });
      return { accepted: false, reason };
    }
    reason = r;
    requestedAt = Date.now();
    if (log) log.info('shutdown.start', Object.assign({ reason: r }, extra || {}));
    for (const fn of listeners) {
      try { fn(r); } catch (_) { /* a listener must not block shutdown */ }
    }
    try { quit(r); } catch (_) { /* quit itself failing is reported by the caller */ }
    return { accepted: true, reason: r };
  }

  // Marks a shutdown that is already under way from outside (window-all-
  // closed, OS session end) so the reason is recorded without quitting twice.
  function note(why) {
    if (reason) return reason;
    reason = KNOWN.has(why) ? why : REASONS.SYSTEM_SHUTDOWN;
    requestedAt = Date.now();
    if (log) log.info('shutdown.start', { reason });
    for (const fn of listeners) {
      try { fn(reason); } catch (_) { /* ignore */ }
    }
    return reason;
  }

  return {
    REASONS,
    request,
    note,
    onShutdown: (fn) => { if (typeof fn === 'function') listeners.push(fn); },
    isShuttingDown: () => reason !== null,
    reason: () => reason,
    requestedAt: () => requestedAt,
    duplicates: () => duplicates.slice(),
    isUpdateRestart: () => reason === REASONS.UPDATE_RESTART || reason === REASONS.UPDATE_INSTALL_ON_EXIT,
    resetForTests: () => { reason = null; requestedAt = null; duplicates.length = 0; }
  };
}

module.exports = { REASONS, createShutdownController };
