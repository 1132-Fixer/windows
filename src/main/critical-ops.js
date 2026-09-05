'use strict';

/**
 * Critical-operation registry for 1132 Fixer.
 *
 * One place that answers "may the app be closed automatically right now?".
 * Two kinds of input:
 *   - scoped operations: `const done = ops.begin('repair'); … done();`
 *     (fix run, shortcut creation, Zoom installer, elevated relaunch,
 *     blocking native dialogs, essential state writes);
 *   - sources: `ops.addSource('updater', () => updater.isCritical())` for
 *     state that lives elsewhere (the update lifecycle).
 *
 * Listeners are told when the answer flips, so the inactivity controller
 * can suspend and resume without polling. Names are for diagnostics only.
 */

function createCriticalOps(deps = {}) {
  const log = deps.log || null;
  const scoped = new Map(); // token -> name
  const sources = new Map(); // name -> fn
  const listeners = [];
  let seq = 0;
  let lastActive = null;

  function scopedActive() {
    return scoped.size > 0;
  }
  function sourceActive() {
    for (const [name, fn] of sources) {
      try { if (fn()) return name; } catch (_) { /* a throwing source is not active */ }
    }
    return null;
  }
  function active() {
    const names = Array.from(new Set(scoped.values()));
    const src = sourceActive();
    if (src) names.push(src);
    return names;
  }
  function isActive() {
    return scopedActive() || sourceActive() !== null;
  }
  function notify(why) {
    const now = isActive();
    if (now === lastActive) return;
    lastActive = now;
    if (log) log.info('critical-ops', { active: now, names: active(), why });
    for (const fn of listeners) {
      try { fn(now, active()); } catch (_) { /* never let a listener break an operation */ }
    }
  }

  function begin(name) {
    const token = ++seq;
    scoped.set(token, String(name || 'operation'));
    notify(`begin:${name}`);
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      scoped.delete(token);
      notify(`end:${name}`);
    };
  }

  // Wraps an async function so the operation is active for its duration,
  // including when it throws.
  async function run(name, fn) {
    const release = begin(name);
    try { return await fn(); } finally { release(); }
  }

  function addSource(name, fn) {
    sources.set(name, fn);
    return () => { sources.delete(name); notify(`remove-source:${name}`); };
  }

  // Sources cannot push change events; callers poke this when a source
  // may have changed (cheap: it only notifies on a flip).
  function poll(why) {
    notify(why || 'poll');
  }

  return {
    begin,
    run,
    addSource,
    poll,
    isActive,
    active,
    onChange: (fn) => { if (typeof fn === 'function') listeners.push(fn); },
    _test: { scoped, sources }
  };
}

module.exports = { createCriticalOps };
