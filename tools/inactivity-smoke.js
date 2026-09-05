'use strict';

/**
 * Inactivity warning / automatic exit — deterministic tests with a fake
 * monotonic clock and fake timers (src/main/inactivity.js,
 * src/main/critical-ops.js), plus the static wiring in main.js, preload,
 * the IPC allowlist, index.html and renderer.js.
 *
 * Numbered cases follow the addendum's list (1 no warning before 30 s …
 * 22 layout at 100/125/150 % scaling — the last three are packaged checks
 * in tools/packaged-inactivity-acceptance.js and are only wired here).
 */

const fs = require('fs');
const path = require('path');
const inactivity = require('../src/main/inactivity');
const { createCriticalOps } = require('../src/main/critical-ops');
const shutdownMod = require('../src/main/shutdown');
const updater = require('../src/main/updater');
const security = require('../src/main/electron-security');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

// Fake clock + timers: timers fire in order when the clock passes them.
function makeClock() {
  let t = 100000;
  let wall = 1_800_000_000_000;
  const timers = [];
  let seq = 0;
  const api = {
    now: () => t,
    wallNow: () => wall,
    setTimer: (fn, ms) => { const h = { id: ++seq, at: t + ms, fn, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.cleared = true; },
    live: () => timers.filter((x) => !x.cleared && !x.fired),
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = timers.filter((x) => !x.cleared && !x.fired && x.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at; wall += 0; due.fired = true; due.fn();
      }
      wall += (target - t);
      t = target;
    },
    sleepFor(ms) { wall += ms; } // wall clock moves while the monotonic clock is paused
  };
  return api;
}

function makeEnv(opts = {}) {
  const clock = makeClock();
  const statuses = [];
  const exits = [];
  const ops = createCriticalOps();
  if (opts.sources) for (const [n, fn] of Object.entries(opts.sources)) ops.addSource(n, fn);
  const ctl = inactivity.createInactivityController({
    now: clock.now,
    wallNow: clock.wallNow,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    emit: (s) => statuses.push(s),
    requestExit: (reason) => { exits.push(reason); return { accepted: exits.length === 1, reason }; },
    criticalOps: ops,
    tickMs: opts.tickMs || 1000
  });
  return { clock, ctl, ops, statuses, exits, last: () => statuses[statuses.length - 1], events: () => statuses.filter((s) => s.event).map((s) => s.event) };
}

console.log('inactivity-smoke: 1–5 timing (warning at 30 s, exit at 60 s)');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(29000);
  check(env.ctl.getState() === 'ACTIVE' && !env.events().includes('warning'), '1. no warning before 30 s');
  env.clock.advance(1000);
  check(env.ctl.getState() === 'INACTIVE_WARNING' && env.events().includes('warning'), '2. warning at 30 s of inactivity');
  check(env.last().remainingMs === 30000, '3. countdown starts at 30 s');
  env.clock.advance(29000);
  check(env.ctl.getState() === 'INACTIVE_WARNING' && env.exits.length === 0 && env.last().remainingMs === 1000, '4a. still open at 59 s (1 s left, from elapsed time)');
  env.clock.advance(1000);
  check(env.ctl.getState() === 'EXITING' && env.exits.length === 1 && env.exits[0] === 'inactive_exit', '4. exits after another 30 s, reason inactive_exit');
  check(env.clock.now() - 100000 === 60000, '5. total inactivity is 60 s');
  check(env.clock.live().length === 0, 'no timers left after exit');
}

console.log('inactivity-smoke: countdown uses elapsed time, not tick count');
{
  const env = makeEnv({ tickMs: 1000 });
  env.ctl.start();
  env.clock.advance(30000);
  // A tick that fires late (a stalled event loop) must not stretch the countdown.
  env.clock.advance(7300);
  check(env.ctl.status().remainingMs === 22700, `remaining is 22.7 s after 7.3 s, not "N ticks" (${env.ctl.status().remainingMs})`);
  env.clock.advance(22700);
  check(env.ctl.getState() === 'EXITING', 'exit lands at 60 s of elapsed time');
}

console.log('inactivity-smoke: 6–7 Keep open and Close now');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(30000);
  env.ctl.keepOpen('button');
  check(env.ctl.getState() === 'ACTIVE' && env.events().includes('dismiss'), '6. Keep open dismisses the warning');
  env.clock.advance(29000);
  check(env.ctl.getState() === 'ACTIVE', '6. …and resets the timer (no warning 29 s later)');
  env.clock.advance(1000);
  check(env.ctl.getState() === 'INACTIVE_WARNING', '6. warning returns after a fresh 30 s');
  const r = env.ctl.closeNow('button');
  check(r.accepted === true && env.exits[0] === 'user_exit' && env.ctl.getState() === 'EXITING', '7. Close now uses graceful shutdown with reason user_exit');
  check(env.clock.live().length === 0, 'no timers after Close now');
}

console.log('inactivity-smoke: 8–11 activity kinds');
{
  for (const [kind, label] of [['pointermove', '8. mouse'], ['pointerdown', '8. click'], ['keydown', '9. keyboard'], ['touch', '10. touch'], ['scroll', '10. scroll'], ['wheel', '10. wheel'], ['pen', '10. pen'], ['focus', 'window focus'], ['command', 'application command'], ['dialog', 'dialog interaction']]) {
    const env = makeEnv();
    env.ctl.start();
    env.clock.advance(25000);
    check(env.ctl.activity(kind, 'test') === true, `${label} activity is accepted`);
    env.clock.advance(20000);
    check(env.ctl.getState() === 'ACTIVE', `${label} activity resets the timer (no warning at 45 s)`);
    env.clock.advance(10000);
    check(env.ctl.getState() === 'INACTIVE_WARNING', `${label}: warning 30 s after that activity`);
    env.ctl.activity(kind, 'test');
    check(env.ctl.getState() === 'ACTIVE' && env.events().includes('dismiss'), `${label} activity during the countdown cancels the exit`);
  }
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(20000);
  for (const bad of ['update-status', 'fix-log', 'timer', 'telemetry', '', null, 42, 'animation']) {
    check(env.ctl.activity(bad, 'internal') === false, `11. background event ${JSON.stringify(bad)} is not activity`);
  }
  env.clock.advance(10000);
  check(env.ctl.getState() === 'INACTIVE_WARNING', '11. background events did not reset the timer');
  check(env.ctl.counters().ignored >= 8, 'ignored events are counted for diagnostics');
}

console.log('inactivity-smoke: 12 repeated mouse movement does not create duplicate timers');
{
  const env = makeEnv();
  env.ctl.start();
  for (let i = 0; i < 500; i++) { env.clock.advance(20); env.ctl.activity('pointermove', 'mouse'); }
  check(env.clock.live().length === 1, `one live timer after 500 moves (${env.clock.live().length})`);
  check(env.ctl.timers().inactivity === true && env.ctl.timers().countdown === false, 'exactly one inactivity timer, no countdown timer');
  const active = env.ctl.counters().activity;
  check(active === 500, 'every move is recorded as activity');
  env.clock.advance(30000);
  check(env.ctl.getState() === 'INACTIVE_WARNING' && env.ctl.timers().countdown === true && env.ctl.timers().inactivity === false, 'during the warning: one countdown timer, no inactivity timer');
}

console.log('inactivity-smoke: 13 a critical repair operation suspends automatic exit');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(10000);
  const done = env.ops.begin('repair');
  check(env.ctl.getState() === 'SUSPENDED_FOR_OPERATION', 'repair begins → suspended');
  env.clock.advance(120000);
  check(env.ctl.getState() === 'SUSPENDED_FOR_OPERATION' && env.exits.length === 0 && !env.events().includes('warning'), 'two minutes idle during a repair: no warning, no exit');
  done();
  check(env.ctl.getState() === 'ACTIVE', 'repair ends → active with a fresh timer');
  env.clock.advance(29000);
  check(env.ctl.getState() === 'ACTIVE', 'fresh 30 s after the operation, not the old deadline');
  env.clock.advance(1000);
  check(env.ctl.getState() === 'INACTIVE_WARNING', 'warning 30 s after the operation finished');
  // An operation that starts during the countdown dismisses the warning.
  const done2 = env.ops.begin('shortcut');
  check(env.ctl.getState() === 'SUSPENDED_FOR_OPERATION' && env.events().filter((e) => e === 'dismiss').length >= 1, 'operation during the countdown dismisses the warning');
  done2();
}

console.log('inactivity-smoke: 14–16 update download / install never interrupted, new process not killed');
{
  let updaterState = 'idle';
  const fakeUpdater = { isCritical: () => updater.CRITICAL_STATES.has(updaterState), isReady: () => updaterState === 'ready' };
  const env = makeEnv({ sources: { updater: () => fakeUpdater.isCritical() || fakeUpdater.isReady() } });
  env.ctl.start();
  env.clock.advance(20000);
  updaterState = 'downloading'; env.ops.poll('update-status');
  check(env.ctl.getState() === 'SUSPENDED_FOR_OPERATION', '14. update download suspends automatic exit');
  env.clock.advance(300000);
  check(env.exits.length === 0, '14. no exit during a five-minute download');
  updaterState = 'verifying'; env.ops.poll('update-status');
  updaterState = 'ready'; env.ops.poll('update-status');
  env.clock.advance(120000);
  check(env.ctl.getState() === 'SUSPENDED_FOR_OPERATION' && env.exits.length === 0 && !env.events().includes('warning'), '15. update ready to install: no hourglass, no exit');
  updaterState = 'installing'; env.ops.poll('update-status');
  updaterState = 'restarting'; env.ops.poll('update-status');
  env.clock.advance(120000);
  check(env.exits.length === 0, '15. installing / restarting: never interrupted by inactivity');
  // The updater's restart is its own shutdown reason; the inactivity
  // controller never produces it and a later exit request is refused.
  const sd = shutdownMod.createShutdownController({ quit: () => {} });
  sd.request('update_restart');
  const r = sd.request('inactive_exit');
  check(!r.accepted && sd.reason() === 'update_restart' && sd.isUpdateRestart(), '15. an inactivity exit cannot override an update restart');
  // 16: the new process starts its own controller; nothing from the old
  // process reaches it (disposed on before-quit).
  env.ctl.dispose();
  env.clock.advance(600000);
  check(env.exits.length === 0 && env.clock.live().length === 0, '16. a disposed (old-process) timer fires nothing afterwards');
  const fresh = makeEnv();
  fresh.ctl.start();
  check(fresh.ctl.getState() === 'ACTIVE' && fresh.ctl.status().warningInMs === 30000, '16. the relaunched process starts a fresh 30 s timer');
}

console.log('inactivity-smoke: 17 renderer reload does not disable the main-process timer');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(30000);
  // A reloaded page asks for the current status and gets the live countdown.
  const s = env.ctl.status();
  check(s.state === 'INACTIVE_WARNING' && s.remainingMs === 30000, 'status() reports the warning to a reloaded renderer');
  env.clock.advance(30000);
  check(env.ctl.getState() === 'EXITING', 'the exit still happens with no renderer input at all');
}

console.log('inactivity-smoke: 18 sleep and resume');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(10000);
  env.ctl.pause('sleep');
  env.clock.sleepFor(3600000); // an hour asleep (wall clock only)
  env.ctl.resume('resume');
  check(env.ctl.getState() === 'INACTIVE_WARNING' && env.exits.length === 0, 'long sleep: warning shown on resume, no immediate exit');
  check(env.last().remainingMs === 30000, 'the countdown after resume is a full 30 s');
  env.ctl.activity('pointermove', 'mouse');
  check(env.ctl.getState() === 'ACTIVE', 'activity on resume keeps the app open');
  const env2 = makeEnv();
  env2.ctl.start();
  env2.clock.advance(10000);
  env2.ctl.pause('lock');
  env2.clock.advance(5000); // timers paused: nothing fires
  env2.clock.sleepFor(5000);
  env2.ctl.resume('unlock');
  check(env2.ctl.getState() === 'ACTIVE', 'short lock: continues where the clock stopped (10 s idle + 10 s locked = 20 s)');
  env2.clock.advance(9000);
  check(env2.ctl.getState() === 'ACTIVE', 'real elapsed inactivity counts the lock: 29 s, still no warning');
  env2.clock.advance(1000);
  check(env2.ctl.getState() === 'INACTIVE_WARNING', 'warning at 30 s of real inactivity across the lock');
  const env3 = makeEnv();
  env3.ctl.start();
  env3.clock.advance(45000); // in the countdown
  env3.ctl.pause('sleep');
  check(env3.ctl.getState() === 'ACTIVE' && env3.events().includes('dismiss'), 'sleep during the countdown dismisses the warning');
  env3.clock.sleepFor(120000);
  env3.ctl.resume('resume');
  check(env3.ctl.getState() === 'INACTIVE_WARNING' && env3.exits.length === 0, 'after waking the warning is shown again, not skipped');
}

console.log('inactivity-smoke: 19 duplicate shutdown requests are prevented');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(60000);
  check(env.exits.length === 1, 'one exit request from the countdown');
  const r1 = env.ctl.exitNow('again');
  const r2 = env.ctl.closeNow('again');
  env.ctl.activity('keydown', 'late');
  check(env.exits.length === 1 && r1.accepted === false && r2.accepted === false, 'no second exit request; late activity ignored while exiting');
  check(env.ctl.getState() === 'EXITING' && env.ctl.status().remainingMs === null, 'state stays EXITING');
  const sd = shutdownMod.createShutdownController({ quit: () => {} });
  check(sd.request('inactive_exit').accepted && !sd.request('inactive_exit').accepted && sd.duplicates().length === 1, 'shutdown controller dedupes inactive_exit');
}

console.log('inactivity-smoke: last-moment guards');
{
  const env = makeEnv();
  env.ctl.start();
  env.clock.advance(59500);
  const done = env.ops.begin('zoom-installer');
  env.clock.advance(1000);
  check(env.exits.length === 0 && env.ctl.getState() === 'SUSPENDED_FOR_OPERATION', 'an operation that starts in the last second wins over the exit');
  done();
  check(env.ctl.getState() === 'ACTIVE', 'and the timer starts fresh afterwards');
  const env2 = makeEnv();
  env2.ctl.start();
  check(env2.ctl.exitNow('forced').accepted === false && env2.ctl.getState() === 'ACTIVE', 'exitNow with recent activity refuses and stays active');
}

console.log('inactivity-smoke: critical-ops registry');
{
  const ops = createCriticalOps();
  const flips = [];
  ops.onChange((active, names) => flips.push([active, names.slice()]));
  const a = ops.begin('repair');
  const b = ops.begin('shortcut');
  check(ops.isActive() && ops.active().length === 2, 'two scoped operations active');
  a(); a();
  check(ops.isActive() && ops.active()[0] === 'shortcut', 'double release is harmless; the other stays active');
  b();
  check(!ops.isActive() && flips.length === 2 && flips[0][0] === true && flips[1][0] === false, 'listeners see one flip on, one flip off');
  let src = false;
  ops.addSource('updater', () => src);
  src = true; ops.poll();
  check(ops.isActive() && ops.active().includes('updater'), 'a source makes the registry active');
  src = false; ops.poll();
  check(!ops.isActive(), 'source clears');
  let ran = false;
  ops.run('x', async () => { ran = ops.isActive(); throw new Error('boom'); }).catch(() => {});
  check(ran === true, 'run() marks the operation active for its duration');
}

console.log('inactivity-smoke: static wiring');
{
  const main = read('main.js');
  const preload = read('preload.js');
  const html = read('index.html');
  const renderer = read('renderer.js');
  check(main.includes("require('./src/main/inactivity')") && main.includes("require('./src/main/critical-ops')"), 'main requires the inactivity and critical-ops modules');
  check(/criticalOps\.addSource\('updater', \(\) => !!updaterCtl && \(updaterCtl\.isCritical\(\) \|\| updaterCtl\.isReady\(\)\)\)/.test(main), 'the update lifecycle (including ready) is a critical source');
  check(/criticalOps\.addSource\('repair', \(\) => fixInProgress\)/.test(main), 'a running fix is a critical source');
  for (const ch of ['run-fix', 'create-shortcut', 'launch-zoom-helper', 'preflight', 'preflight-scan', 'relaunch-elevated', 'install-update-now', 'update-retry']) {
    check(new RegExp(`'${ch}': '`).test(main), `${ch} is wrapped as a critical operation`);
  }
  check(/criticalOps\.begin\('zoom-installer'\)/.test(main) && /criticalOps\.begin\('dialog'\)/.test(main), 'Zoom installer run and the blocking dialog are scoped operations');
  check(/requestExit: \(reason\) => shutdown\.request\(reason\)/.test(main), 'the inactivity exit is a graceful shutdown with a reason');
  check(!/app\.exit\(\)/.test(main.slice(main.indexOf('function getInactivity'), main.indexOf('function sendUpdateStatus'))), 'no forced exit in the inactivity wiring');
  check(/startInactivityTimer\('app-ready'\)/.test(main) && /ipcMain\.handle\('update-app-ready'/.test(main), 'the timer starts fresh when the (possibly relaunched) app reports ready');
  check(/inactivityCtl\.dispose\(\)/.test(main) && main.indexOf('inactivityCtl.dispose()') > main.indexOf("app.on('before-quit'"), 'before-quit disposes the controller (no warning can reopen)');
  check(/powerMonitor\.on\('suspend'/.test(main) && /powerMonitor\.on\('resume'/.test(main) && /powerMonitor\.on\('lock-screen'/.test(main) && /powerMonitor\.on\('unlock-screen'/.test(main), 'sleep and session lock pause / resume the clock');
  check(/browser-window-focus/.test(main), 'window focus counts as activity');
  for (const ch of ['user-activity', 'inactivity-keep-open', 'inactivity-close-now', 'inactivity-status-get']) {
    check(security.IPC_INVOKE_CHANNELS.includes(ch), `${ch} is allowlisted`);
    check(preload.includes(`ipcRenderer.invoke('${ch}'`), `${ch} is exposed by preload`);
    check(main.includes(`ipcMain.handle('${ch}'`), `${ch} is handled by main`);
  }
  check(security.IPC_SEND_CHANNELS.includes('inactivity-status'), 'inactivity-status is a documented send channel');
  check(security.validateInvoke('user-activity', ['pointermove']).ok && !security.validateInvoke('user-activity', ['update-status']).ok && !security.validateInvoke('user-activity', [42]).ok, 'user-activity kinds are validated at the IPC boundary');
  for (const k of security.ACTIVITY_KINDS) check(inactivity.ACTIVITY_KINDS.has(k), `IPC kind ${k} is known to the controller`);
  // 20–22: markup and behaviour the packaged run measures.
  check(html.includes('id="idleOverlay"') && /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="idleTitle"/.test(html.slice(html.indexOf('id="idleOverlay"') - 200, html.indexOf('id="idleOverlay"') + 300)), 'overlay is a modal dialog labelled by its heading');
  check(html.includes('>Closing soon<') && html.includes('1132 Fixer will close in 30 seconds because it hasn’t been used.'), 'heading and body copy verbatim');
  check(html.includes('id="idleKeepBtn"') && html.includes('>Keep open<') && html.includes('id="idleCloseBtn"') && html.includes('>Close now<'), 'Keep open (primary) and Close now buttons');
  check(/id="idleAnnounce"[^>]*role="status"[^>]*aria-live="polite"/.test(html), 'countdown announcements through a polite live region');
  check(/prefers-reduced-motion: reduce\)\s*\{\s*\.idle-stream \{ animation: none; \}/.test(html), '20. reduced motion removes the sand animation');
  check(/idle-stream[^}]*animation: idle-stream 900ms linear infinite/.test(html) && !/idle-hourglass[^}]*rotate/.test(html), 'restrained animation: a slow sand stream, no rotation');
  check(renderer.includes("if (event.key === 'Escape')") && renderer.includes("idleKeepBtn.click()") && renderer.includes("event.key === 'Enter' || event.key === ' '"), '21. Escape, Enter and Space are Keep open');
  check(/order = \[idleCloseBtn, idleKeepBtn\]/.test(renderer) && renderer.includes('idleKeepBtn.focus()'), '21. focus lands on Keep open and is trapped');
  check(renderer.includes('performance.now()') && renderer.includes('idleDeadline'), 'renderer countdown derives from the monotonic clock');
  check(/IDLE_MOVE_THROTTLE_MS = 1000/.test(renderer) && /IDLE_DISCRETE_THROTTLE_MS = 250/.test(renderer), 'high-frequency events are throttled before the bridge');
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart']) check(renderer.includes(`window.addEventListener('${ev}'`), `renderer listens for ${ev}`);
  check(!/reportActivity\([^)]*\)/.test(renderer.slice(renderer.indexOf('function handleUpdateStatus'), renderer.indexOf('function signalUpdateAppReady'))), 'update status handling never reports activity');
  check(/api\.onInactivityStatus\(handleInactivityStatus\)/.test(renderer) && /api\.inactivityStatus\(\)\.then\(handleInactivityStatus\)/.test(renderer), 'renderer subscribes and pulls the current state after (re)load');
  check(/\.idle-dialog \{ width: min\(360px, 100%\)/.test(html) && /max-height: 560px/.test(html), '22. dialog sized for the smallest window at 150 % scaling');
}

if (failures) { console.error(`\ninactivity-smoke: ${failures} FAIL`); process.exit(1); }
console.log('\ninactivity-smoke: PASS');
