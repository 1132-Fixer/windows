'use strict';
/**
 * Startup scan helpers: keep one failed operation from erasing every result.
 *
 * Before this module the scan handler awaited its two inputs with
 * Promise.all and built the cards with no guard. Any rejection or throw
 * rejected the whole IPC call. The window then showed "The startup check did
 * not finish in time" for every kind of failure, discarded the results that
 * had completed, and reported all nine checks as unverified. The real error
 * was not shown and not logged.
 *
 * Rules here:
 *   - an operation that fails or times out is named (operation, kind, code);
 *   - results from operations that completed are kept;
 *   - a check that could not run is 'unknown', never 'ready' and never
 *     'blocked' (a failed check and an unverified check are different);
 *   - one scan runs at a time: a retry joins the scan already running
 *     instead of starting a second set of worker processes.
 */

const { STARTUP_FAILURE } = require('../../messages');

const KINDS = Object.freeze({ TIMEOUT: 'timeout', ERROR: 'error', UNAVAILABLE: 'unavailable' });

const OPERATIONS = Object.freeze({
  WINDOWS_CHECKS: 'windows-checks',     // preflightCheck(): tools, Zoom, Secondary Logon, elevation
  ACCOUNT_PROBE: 'account-and-policy',  // helper account, privacy policies, camera service
  RESULTS: 'results',                   // turning the answers into the checklist
  SCAN: 'scan'                          // the scan as a whole (unexpected failure)
});

const OPERATION_LABELS = Object.freeze({
  'windows-checks': 'the Windows tools, Zoom and Secondary Logon check',
  'account-and-policy': 'the helper account, privacy policy and camera service check',
  results: 'reading the check results',
  scan: 'the startup check',
  'startup-status': 'the administrator check'
});

function operationLabel(operation) {
  return OPERATION_LABELS[operation] || OPERATION_LABELS.scan;
}

// Short, non-identifying code for the log and the support report. Never a
// path, a user name or a stack.
function errorCode(err) {
  if (!err) return 'unknown';
  if (typeof err.code === 'string' && /^[A-Za-z0-9_.-]{1,48}$/.test(err.code)) return err.code;
  if (typeof err.name === 'string' && /^[A-Za-z]{1,40}$/.test(err.name)) return err.name;
  return 'Error';
}

function isTimeoutError(err) {
  const text = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
  return /ETIMEDOUT|\btimeout\b|timed out/i.test(text);
}

// Why a step timed out, when the measurements can tell (#275). A timed
// script prints one fixed line as soon as PowerShell reaches it; startMs is
// the time from spawn to that line, or null when the line never arrived.
// If the start alone used at least half of the step's limit, or the script
// was never reached at all, the step did not run slowly: PowerShell was slow
// to start. Security software holding the new process is the measured cause
// (#266), but the app cannot know which program does it and names none.
// One time limit per scan step. The checks inside a step take 1 to 100 ms
// each once PowerShell runs (#266), so a limit per check would add nothing:
// what uses the limit is the start of PowerShell, and that is measured and
// reported on its own.
const STEP_LIMITS_MS = Object.freeze({ WINDOWS_CHECKS: 20000, ACCOUNT_PROBE: 20000 });

const REASONS = Object.freeze({ SLOW_START: 'slow-start' });
const SLOW_START_SHARE = 0.5;

function timeoutReason(result, limitMs) {
  if (!result || result.timedOut !== true) return null;
  if (!(Number.isFinite(limitMs) && limitMs > 0)) return null;
  const startMs = result.startMs;
  if (startMs === null || startMs === undefined) return REASONS.SLOW_START;
  if (!Number.isFinite(startMs) || startMs < 0) return null;
  return startMs >= limitMs * SLOW_START_SHARE ? REASONS.SLOW_START : null;
}

// Numbers only: safe for the log and the support report.
function stepTiming(operation, result, limitMs) {
  const ms = (value) => (Number.isFinite(value) && value >= 0 ? Math.round(value) : null);
  const r = result || {};
  return {
    operation,
    startMs: ms(r.startMs),
    elapsedMs: ms(r.elapsedMs),
    limitMs: ms(limitMs),
    timedOut: r.timedOut === true,
    reason: timeoutReason(r, limitMs)
  };
}

function timingLine(timing) {
  const t = timing || {};
  const show = (value) => (Number.isFinite(value) ? `${value} ms` : 'not reached');
  return `${t.operation || 'scan'}: PowerShell start ${show(t.startMs)}; step ${show(t.elapsedMs)}; ` +
    `limit ${show(t.limitMs)}; timeout ${t.timedOut === true}; reason ${t.reason || 'none'}`;
}

function issueFor(operation, err) {
  return {
    operation,
    kind: isTimeoutError(err) ? KINDS.TIMEOUT : KINDS.ERROR,
    code: errorCode(err)
  };
}

// Promise.allSettled over the scan inputs. A rejected input becomes a named
// issue plus a fallback value, so the inputs that settled still produce cards.
async function settleInputs(inputs) {
  const names = Object.keys(inputs);
  const settled = await Promise.allSettled(names.map((n) => inputs[n].promise));
  const values = {};
  const issues = [];
  names.forEach((name, i) => {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      values[name] = { ok: true, value: s.value };
    } else {
      values[name] = { ok: false, value: inputs[name].fallback };
      issues.push(issueFor(inputs[name].operation, s.reason));
    }
  });
  return { values, issues };
}

// Copy lives in messages.js; this module only chooses the sentence.
const SLOW_START_CARD = STARTUP_FAILURE.SLOW_START_CARD;

function unknownCard(label, operation, kind, reason) {
  const what = operationLabel(operation);
  let message = kind === KINDS.TIMEOUT
    ? `Not checked: ${what} did not finish in time. Nothing was changed. Choose Try again.`
    : `Not checked: ${what} could not run. Nothing was changed. Choose Try again.`;
  if (kind === KINDS.TIMEOUT && reason === REASONS.SLOW_START) message = SLOW_START_CARD;
  return { status: 'unknown', label, message, unverified: true };
}

// The result for a scan that produced no usable cards at all.
function failedScanResult(issue, labels, elapsedMs) {
  const cards = {};
  for (const key of Object.keys(labels || {})) {
    cards[key] = unknownCard(labels[key], issue.operation, issue.kind);
  }
  return {
    cards,
    overall: 'unknown',
    canRunFix: false,
    blockers: [],
    warnings: [],
    info: {},
    scanIssues: [issue],
    scanTimings: [],
    scanElapsedMs: elapsedMs
  };
}

// One scan at a time. While a scan runs, every caller gets the same promise.
function createSingleFlight(run) {
  let inFlight = null;
  let started = 0;
  const call = () => {
    if (inFlight) return inFlight;
    started += 1;
    inFlight = Promise.resolve()
      .then(run)
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  call.isRunning = () => inFlight !== null;
  call.startedCount = () => started;
  return call;
}

/**
 * The "Helper account" checklist card, from the read-only account probe.
 * It never changes an account: a legacy administrator user1 is reported as
 * repairable, and only the user's FIX NOW click rebuilds it.
 */
function helperAccountCard({ probeFailed, probeFailMessage, exists, admin, profileExists, user, profileDir, copy }) {
  const label = 'Helper account';
  if (probeFailed) return { status: 'warning', label, message: probeFailMessage };
  if (!exists && !profileExists) return { status: 'ready', label, message: copy.WILL_CREATE(user) };
  // reason drives the visible warning: the result pane (renderer.js,
  // readyPaneFor) and the View details explanation (details-view.js).
  if (exists && admin) return { status: 'repairable', label, message: copy.LEGACY_ADMIN(user), reason: 'legacy_admin' };
  if (exists && profileExists) return { status: 'ready', label, message: copy.READY(user) };
  if (exists) return { status: 'repairable', label, message: copy.NO_PROFILE(user) };
  return { status: 'warning', label, message: copy.STALE_PROFILE(profileDir) };
}

module.exports = {
  helperAccountCard,
  KINDS,
  REASONS,
  STEP_LIMITS_MS,
  SLOW_START_SHARE,
  SLOW_START_CARD,
  timeoutReason,
  stepTiming,
  timingLine,
  OPERATIONS,
  OPERATION_LABELS,
  operationLabel,
  errorCode,
  isTimeoutError,
  issueFor,
  settleInputs,
  unknownCard,
  failedScanResult,
  createSingleFlight
};
