// Smoke test for run-verdict.js — the pure verdict/aggregation logic shared
// by main.js (final result object) and renderer.js (headline + warnings
// block). Imports the REAL module, so the logic under test is the logic that
// ships.
//
// Contract under test (fail-loud policy, triage cluster W2-VERIFY):
//  - all-ok steps -> plain success, header FIX COMPLETE
//  - any 'fail' step (timed-out ProfSvc restart, unconfirmed consent,
//    Zoom-not-running) -> partial + NEEDS ATTENTION header + its detail
//    listed for the warnings block
//  - countable partial data clear (M>N>0 or N==0, M>0) -> 'fail' outcome
//  - hard blockers -> failed verdict, success false
//  - empty/missing/sparse/malformed steps or unknown outcomes -> partial,
//    never an unqualified completion without evidence
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

console.log('run-verdict-smoke: missing evidence requires attention');
{
  const empty = rv.computeRunVerdict([], [], []);
  check(empty.verdict === 'partial' && empty.partial === true, 'empty steps + no warnings -> partial');
  check(empty.header === rv.VERDICT_HEADERS.attention && empty.attention.length === 1, 'empty ledger explains missing verification');
  const warned = rv.computeRunVerdict([], [{ code: 'x', message: 'y' }, { code: 'z', message: 'w' }], []);
  check(warned.verdict === 'partial' && warned.partial === true, 'warnings cannot replace missing step evidence');
  check(warned.header === rv.VERDICT_HEADERS.attention, 'missing evidence outranks warning-count completion');
  const missing = rv.computeRunVerdict(undefined, undefined, undefined);
  check(missing.verdict === 'partial' && missing.partial === true, 'missing arrays tolerated without claiming completion');
}

console.log('run-verdict-smoke: full valid ledger and malformed negative controls');
{
  const fullLedger = [
    ['close-sessions', 'Close helper programs and sessions'],
    ['data-clear', 'Clear old helper profile data'],
    ['profsvc-flush', 'Refresh Windows profile service'],
    ['create-account', 'Create fresh helper account'],
    ['launch-zoom', 'Start Zoom'],
    ['profile-setup', 'Set up helper profile'],
    ['zoom-config', 'Apply Zoom preferences'],
    ['consent', 'Grant camera and microphone access'],
    ['relaunch', 'Restart Zoom']
  ].map(([id, label]) => ({ id, label, outcome: 'ok', detail: '' }));
  const completed = rv.computeRunVerdict(fullLedger, [], []);
  check(completed.verdict === 'success' && completed.partial === false, 'full valid all-ok ledger -> success');
  check(completed.attention.length === 0, 'full valid ledger has no invented attention items');
  const valid = fullLedger[0];
  const invalidLedgers = [
    ['null ledger', null],
    ['object ledger', { 0: valid, length: 1 }],
    ['string ledger', 'ok'],
    ['entirely sparse ledger', new Array(2)],
    ['large sparse ledger', new Array(1000000)],
    ['sparse ledger with valid result', [valid, , valid]],
    ['undefined step', [undefined]],
    ['null step', [null]],
    ['primitive step', ['ok']],
    ['array step', [[]]],
    ['empty step record', [{}]],
    ['missing id', [{ label: 'Repair step', outcome: 'ok' }]],
    ['blank id', [{ id: ' ', label: 'Repair step', outcome: 'ok' }]],
    ['non-string id', [{ id: 1, label: 'Repair step', outcome: 'ok' }]],
    ['missing label', [{ id: 'repair', outcome: 'ok' }]],
    ['blank label', [{ id: 'repair', label: '\t', outcome: 'ok' }]],
    ['non-string label', [{ id: 'repair', label: true, outcome: 'ok' }]],
    ['missing outcome', [{ id: 'repair', label: 'Repair step' }]],
    ['unknown outcome', [{ ...valid, outcome: 'unknown' }]],
    ['unsupported outcome', [{ ...valid, outcome: 'success' }]],
    ['wrong-case outcome', [{ ...valid, outcome: 'OK' }]],
    ['null outcome', [{ ...valid, outcome: null }]],
    ['boolean outcome', [{ ...valid, outcome: true }]],
    ['numeric outcome', [{ ...valid, outcome: 1 }]],
    ['object outcome', [{ ...valid, outcome: { status: 'ok' } }]],
    ['invalid detail', [{ ...valid, detail: { status: 'ok' } }]],
    ['null detail', [{ ...valid, detail: null }]],
    ['undefined detail', [{ ...valid, detail: undefined }]],
    ['inherited outcome', [Object.assign(Object.create({ outcome: 'ok' }), { id: 'repair', label: 'Repair step' })]],
    ['inherited evidence', [Object.create(valid)]],
    ['mixed valid and malformed', [...fullLedger, null]],
    ['mixed valid and unknown outcome', [...fullLedger, { ...valid, outcome: 'pending' }]]
  ];
  for (const [name, ledger] of invalidLedgers) {
    const verdict = rv.computeRunVerdict(ledger, [{ code: 'advisory', message: 'Optional preference was not applied.' }], []);
    check(verdict.verdict === 'partial' && verdict.success === true && verdict.partial === true, `${name} -> partial with compatible result flags`);
    check(verdict.header === rv.VERDICT_HEADERS.attention, `${name} never receives an unqualified completion headline`);
    check(verdict.attention.length > 0 && verdict.attention.every(item => item.outcome === 'fail' && typeof item.detail === 'string' && item.detail.length > 0),
      `${name} includes useful verification failure evidence`);
  }
  const optionalDetail = rv.computeRunVerdict([{ id: 'repair', label: 'Repair step', outcome: 'ok' }], [], []);
  check(optionalDetail.verdict === 'success', 'detail may be omitted when valid step identity and outcome are present');
  const failedStep = { id: 'relaunch', label: 'Restart Zoom', outcome: 'fail', detail: 'Zoom did not start.' };
  const mixed = rv.computeRunVerdict([valid, failedStep, null], [], []);
  check(mixed.attention.includes(failedStep), 'valid failed-step evidence is preserved alongside malformed data');
  check(mixed.attention.length === 2, 'mixed explicit failure and invalid evidence remain separate');
  const blocked = rv.computeRunVerdict(undefined, [], [{ code: 'not_elevated', message: 'Administrator access required.' }]);
  check(blocked.verdict === 'failed' && blocked.success === false && blocked.partial === false, 'hard blocker remains authoritative when step evidence is absent');
  const advised = rv.computeRunVerdict(fullLedger.map(step => step.id === 'zoom-config' ? { ...step, outcome: 'warn' } : step),
    [{ code: 'preference', message: 'Optional preference was not applied.' }], []);
  check(advised.verdict === 'success' && advised.partial === false && advised.header === 'FIX COMPLETE (with 1 warning(s))',
    'known advisory outcome alongside valid completed work remains additive');
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
