// Smoke test for run-verdict.js — the pure verdict/aggregation logic shared
// by main.js (final result object) and renderer.js (headline + warnings
// block). Imports the REAL module, so the logic under test is the logic that
// ships.
//
// Contract under test (fail-loud policy):
//  - all-ok steps -> plain success, header FIX COMPLETE
//  - any 'fail' step (timed-out ProfSvc restart, unconfirmed consent,
//    Zoom-not-running) -> partial + NEEDS ATTENTION header + its detail
//    listed for the warnings block
//  - countable partial data clear (M>N>0 or N==0, M>0) -> 'fail' outcome
//  - hard blockers -> failed verdict, success false
//  - empty/missing steps -> legacy verdict unchanged (success; warning-count
//    headline when warnings exist)
//  - 'warn' steps and plain warnings never flip a run to partial

const rv = require('../run-verdict.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('run-verdict-smoke: all-ok run');
{
  const steps = [
    { id: 'close-sessions', label: 'Close user1 programs and sessions', outcome: 'ok', detail: '' },
    { id: 'data-clear',     label: 'Clear old user1 profile data',      outcome: 'ok', detail: 'deleted 2 of 2' },
    { id: 'relaunch',       label: 'Restart Zoom as user1',             outcome: 'ok', detail: '' }
  ];
  const v = rv.computeRunVerdict(steps, [], []);
  check(v.verdict === 'success' && v.success === true && v.partial === false, 'all-ok -> success, not partial');
  check(v.header === 'FIX COMPLETE', 'all-ok header is plain FIX COMPLETE');
  check(v.attention.length === 0, 'all-ok has no attention items');
}

console.log('run-verdict-smoke: timed-out step -> partial');
{
  const detail = 'The Windows profile service refresh timed out after 60 seconds. Windows may give user1 a temporary profile — if Error 1132 comes back, reboot once and run the fix again.';
  const steps = [
    { id: 'close-sessions', label: 'Close user1 programs and sessions', outcome: 'ok',   detail: '' },
    { id: 'profsvc-flush',  label: 'Refresh Windows profile service',   outcome: 'fail', detail }
  ];
  const v = rv.computeRunVerdict(steps, [], []);
  check(v.verdict === 'partial' && v.partial === true, 'timeout step -> partial');
  check(v.success === true, 'partial still reports success:true (fix ran to the end)');
  check(v.header === rv.VERDICT_HEADERS.attention, 'partial header is FIX COMPLETE — NEEDS ATTENTION');
  check(v.attention.length === 1 && v.attention[0].detail === detail, 'failed-step detail carried for the warnings block');
}

console.log('run-verdict-smoke: countable partial data clear');
{
  check(rv.deletionOutcome(3, 3).outcome === 'ok', 'full clear -> ok');
  check(rv.deletionOutcome(0, 0).outcome === 'ok', 'nothing to clear -> ok');
  const partial = rv.deletionOutcome(1, 3);
  check(partial.outcome === 'fail', 'M>N>0 -> fail outcome');
  check(partial.detail.includes('deleted 1 of 3'), 'partial clear detail says deleted N of M');
  const none = rv.deletionOutcome(0, 2);
  check(none.outcome === 'fail' && none.detail.includes('deleted 0 of 2'), 'N==0 with M>0 -> fail outcome');
  const v = rv.computeRunVerdict(
    [{ id: 'data-clear', label: 'Clear old user1 profile data', outcome: partial.outcome, detail: partial.detail }],
    [], []);
  check(v.partial === true && v.attention[0].detail.includes('deleted 1 of 3'), 'countable partial clear -> partial run');
}

console.log('run-verdict-smoke: hard blocker -> failed');
{
  const v = rv.computeRunVerdict(
    [{ id: 'close-sessions', label: 'Close user1 programs and sessions', outcome: 'ok', detail: '' }],
    [],
    [{ code: 'not_elevated', message: 'Process is not running as Administrator.' }]);
  check(v.verdict === 'failed' && v.success === false && v.partial === false, 'blocker -> failed, success false');
  check(v.header === rv.VERDICT_HEADERS.failed, 'failed header is FIX FAILED');
}

console.log('run-verdict-smoke: legacy shapes unchanged');
{
  const empty = rv.computeRunVerdict([], [], []);
  check(empty.verdict === 'success' && empty.header === 'FIX COMPLETE', 'empty steps + no warnings -> legacy plain success');
  const warned = rv.computeRunVerdict([], [{ code: 'x', message: 'y' }, { code: 'z', message: 'w' }], []);
  check(warned.verdict === 'success' && warned.partial === false, 'empty steps + warnings -> success, never partial');
  check(warned.header === 'FIX COMPLETE (with 2 warning(s))', 'legacy warning-count headline unchanged');
  const missing = rv.computeRunVerdict(undefined, undefined, undefined);
  check(missing.verdict === 'success' && missing.header === 'FIX COMPLETE', 'missing arrays tolerated');
}

console.log('run-verdict-smoke: warn steps never partial');
{
  const v = rv.computeRunVerdict(
    [{ id: 'zoom-config', label: 'Apply Zoom preferences', outcome: 'warn', detail: 'ini_write_failed' }],
    [{ code: 'ini_write_failed', message: 'Could not write dark mode.' }],
    []);
  check(v.verdict === 'success' && v.partial === false, 'warn-outcome step stays a success run');
  check(v.header === 'FIX COMPLETE (with 1 warning(s))', 'warn-outcome run keeps warning headline');
}

console.log('run-verdict-smoke: consent outcome (P1-A — HKU is the toggle Zoom reads)');
{
  check(rv.consentOutcome('OK', false, 'YES') === 'OK', 'per-user readback Allow -> OK');
  check(rv.consentOutcome('UNVERIFIED', false, 'YES') === 'OK', 'readback upgrades marker-lost UNVERIFIED to OK');
  check(rv.consentOutcome('OK', false, 'NO') === 'UNVERIFIED', 'HKLM-only OK with per-user value absent -> UNVERIFIED (never OK)');
  check(rv.consentOutcome('OK', false, '') === 'UNVERIFIED', 'HKLM-only OK, hive unreadable, no per-user write proof -> UNVERIFIED');
  check(rv.consentOutcome('OK', true, '') === 'OK', 'verified per-user write stands when hive is unreadable at verify');
  check(rv.consentOutcome('UNVERIFIED', true, '') === 'OK', 'verified per-user write also rescues a marker-degraded status');
  check(rv.consentOutcome('UNVERIFIED', false, '') === 'UNVERIFIED', 'nothing verified anywhere -> UNVERIFIED');
  check(rv.consentOutcome('POLICY-BLOCKED', true, 'YES') === 'POLICY-BLOCKED', 'policy block always stands');
  const v = rv.computeRunVerdict(
    [{ id: 'consent', label: 'Grant camera and microphone access', outcome: 'fail',
       detail: 'camera=UNVERIFIED, microphone=OK — sign in as user1, open Settings > Privacy & security > Camera (and Microphone), and toggle access on manually.' }],
    [], []);
  check(v.partial === true, 'unconfirmed consent -> partial run');
}

console.log('run-verdict-smoke: ProfSvc refresh marker (P1-B)');
{
  check(rv.profsvcRefreshResult('  ProfSvc restarted via Restart-Service.\nPROFSVC_REFRESH=OK\n') === 'OK', 'OK marker parsed');
  check(rv.profsvcRefreshResult('  Restart-Service failed: denied\n  HKLM flushed.\nPROFSVC_REFRESH=FAILED') === 'FAILED', 'FAILED marker parsed (self-swallowed script exit 0)');
  check(rv.profsvcRefreshResult('  WARNING: could not inspect ProfSvc: boom\n  HKLM flushed.') === '', 'marker absent -> empty (caller treats as failure)');
  check(rv.profsvcRefreshResult('') === '' && rv.profsvcRefreshResult(null) === '', 'empty/null output tolerated');
  check(rv.profsvcRefreshResult('PROFSVC_REFRESH=MAYBE') === '', 'unknown marker value never reads as OK');
}

if (failures) {
  console.error(`run-verdict-smoke: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('run-verdict-smoke: all checks passed');
