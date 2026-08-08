// Pure verdict + aggregation logic for the fix flow — decides the final
// headline (success / needs-attention / failed) from per-step outcomes,
// warnings, and blockers. Loaded as a plain browser script before renderer.js
// (same pattern as messages.js) and require()-able from main.js and
// tools/run-verdict-smoke.js.
//
// Contract:
//  - steps: [{ id, label, outcome: 'ok'|'warn'|'fail', detail }]
//  - a 'fail' step means the flow ran to the end but an outcome the fix
//    exists to deliver could not be confirmed (incomplete data clear,
//    unconfirmed consent write, Zoom not running as user1, profile-service
//    refresh failure) -> overall partial: NEEDS ATTENTION, never a silent
//    green.
//  - 'warn' steps and plain warnings never flip a run to partial — additive
//    honesty only.
//  - empty/missing steps preserve the legacy verdict exactly: success, with
//    the warning-count headline when warnings exist.

const VERDICT_HEADERS = {
  success:   'FIX COMPLETE',
  attention: 'FIX COMPLETE — NEEDS ATTENTION',
  failed:    'FIX FAILED'
};

function computeRunVerdict(steps, warnings, blockers) {
  const stepList  = Array.isArray(steps)    ? steps.filter(s => s && typeof s === 'object') : [];
  const warnList  = Array.isArray(warnings) ? warnings  : [];
  const blockList = Array.isArray(blockers) ? blockers  : [];
  const attention = stepList.filter(s => s.outcome === 'fail');

  if (blockList.length > 0) {
    return { verdict: 'failed', success: false, partial: false, header: VERDICT_HEADERS.failed, attention };
  }
  if (attention.length > 0) {
    return { verdict: 'partial', success: true, partial: true, header: VERDICT_HEADERS.attention, attention };
  }
  const header = warnList.length > 0
    ? `FIX COMPLETE (with ${warnList.length} warning(s))`
    : VERDICT_HEADERS.success;
  return { verdict: 'success', success: true, partial: false, header, attention: [] };
}

// Outcome for a countable removal pass: `deleted` confirmed-gone out of
// `total` attempted. Anything left behind fails the step (partial fix) —
// leftover profile data is the exact 1132 relapse mechanism.
function deletionOutcome(deleted, total) {
  const t = Math.max(0, Number(total) || 0);
  const d = Math.min(Math.max(0, Number(deleted) || 0), t);
  if (t === 0) return { outcome: 'ok', detail: 'nothing needed removing' };
  if (d === t) return { outcome: 'ok', detail: `deleted ${d} of ${t}` };
  return {
    outcome: 'fail',
    detail: `deleted ${d} of ${t} — some old profile data could not be removed. Reboot once and run the fix again.`
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VERDICT_HEADERS, computeRunVerdict, deletionOutcome };
}
