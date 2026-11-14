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

function unknownCard(label, operation, kind) {
  const what = operationLabel(operation);
  const message = kind === KINDS.TIMEOUT
    ? `Not checked: ${what} did not finish in time. Nothing was changed. Choose Try again.`
    : `Not checked: ${what} could not run. Nothing was changed. Choose Try again.`;
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

module.exports = {
  KINDS,
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
