// Smoke test for ui-state.js — the state -> rendering map for every
// user-visible status surface. Imports the REAL module (browser script with
// a module.exports guard, same as messages.js / run-verdict.js), so the
// mapping under test is the mapping that ships.
//
// Contract under test — GOVERNING RULE: unknown !== success.
//
//  - no state, however unrecognised, may render as the success tick
//  - a check that could not run renders as unknown, never as a pass, and
//    never disappears from the list
//  - a summary badge is never greener than the worst row it summarises
//  - a 'repairable' row (what a detected TEMP helper profile produces)
//    cannot roll up to the green Ready badge  [#160 fail-loud, must only
//    ever get LOUDER]
//  - a disabled Fix button always states a reason
//  - an unknown or failed update check is never rendered as silence
//  - an installer that did not start, or a declined administrator prompt,
//    is never rendered as one that is running
//
// The single most load-bearing assertion here is the exhaustive sweep at
// the bottom: for EVERY status string that is not exactly 'ready', the
// rendering must differ from the 'ready' rendering in icon AND badge word.

const ui = require('../ui-state.js');
const rv = require('../run-verdict.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

// ------------------------------------------------------------
console.log('ui-state-smoke: check-row status normalisation');

const KNOWN = ['ready', 'repairable', 'warning', 'blocked', 'pending', 'unknown'];
for (const s of KNOWN) {
  check(ui.normalizeCheckStatus(s) === s, `known status '${s}' passes through`);
}

// Everything a main process could plausibly emit that this version does not
// know: renamed states, typos, absent fields, wrong types, truthy junk.
const UNRECOGNISED = [
  undefined, null, '', 'ok', 'OK', 'Ready', 'success', 'passed', 'green',
  'healthy', 'fine', 'repaired', 'fixed', 0, 1, true, false, {}, [], 'toString',
  'constructor', '__proto__'
];
for (const s of UNRECOGNISED) {
  const norm = ui.normalizeCheckStatus(s);
  check(norm === 'unknown', `unrecognised status ${JSON.stringify(s)} -> 'unknown'`);
  check(ui.iconKeyForCheckStatus(s) === 'warn', `unrecognised ${JSON.stringify(s)} draws the WARNING icon, not the tick`);
  check(ui.badgeForCheckStatus(s) === 'Unknown', `unrecognised ${JSON.stringify(s)} badge word is 'Unknown'`);
}

// The prototype-chain keys above matter: hasOwnProperty is what keeps
// 'toString' from resolving to a function and rendering as a real state.
check(ui.iconKeyForCheckStatus('ready') === 'check', "only 'ready' draws the tick");
check(ui.badgeForCheckStatus('repairable') === 'Repairable', 'repairable keeps its own word');

// Every status has a non-empty badge word. An empty badge leaves the row's
// state conveyed by border/icon COLOUR alone.
for (const s of KNOWN.concat(['made-up'])) {
  const w = ui.badgeForCheckStatus(s);
  check(typeof w === 'string' && w.length > 0, `status '${s}' has a non-empty badge word (never colour-only)`);
}

// ------------------------------------------------------------
console.log('ui-state-smoke: a failed/unknown check cannot look like a passing one');

// THE core assertion. For every non-'ready' status, BOTH the icon and the
// badge word must differ from 'ready'. A regression that reintroduces
// `default: svgCheck(...)` fails here.
const readyIcon  = ui.iconKeyForCheckStatus('ready');
const readyBadge = ui.badgeForCheckStatus('ready');
const NOT_READY = ['repairable', 'warning', 'blocked', 'pending', 'unknown']
  .concat(UNRECOGNISED.filter(v => typeof v === 'string' && v !== 'ready'));
for (const s of NOT_READY) {
  check(ui.iconKeyForCheckStatus(s) !== readyIcon,  `status ${JSON.stringify(s)} does not draw the ready icon`);
  check(ui.badgeForCheckStatus(s) !== readyBadge,   `status ${JSON.stringify(s)} does not say '${readyBadge}'`);
}

// ------------------------------------------------------------
console.log('ui-state-smoke: summary badge is never greener than its rows');

const GREEN = 'done';
function tone(statuses, overall, canRunFix) {
  return ui.summarizeChecks(statuses, overall, canRunFix).tone;
}

check(tone(['ready', 'ready'], 'ready', true) === GREEN, 'all-ready + overall ready + canRunFix -> green');

// The measured defect: main.js ranks 'repairable' ABOVE 'warning', so a scan
// carrying both reports overall='repairable'. The renderer had no
// 'repairable' branch and fell through to the green badge.
check(tone(['ready', 'repairable'], 'repairable', true) !== GREEN,
  'a repairable row cannot produce the green summary');
// Wizard state language (directive 2026-08-23): repairable = the APP can
// fix it — an accent "Fix available" offer, never the generic amber
// "Action needed" it used to show.
check(ui.summarizeChecks(['ready', 'repairable'], 'repairable', true).text === 'Fix available',
  'a repairable row summarises as "Fix available"');
check(ui.summarizeChecks(['ready', 'repairable'], 'repairable', true).tone === 'action',
  'repairable uses the accent "action" tone, not amber');
check(tone(['ready', 'repairable', 'warning'], 'repairable', true) !== GREEN,
  'repairable + warning (overall=repairable) cannot produce the green summary');

// TEMP / suffixed helper profile — profile-safety.classifyHelperProfileCard
// returns status 'repairable' for both. The #160 contract is that this can
// only ever get louder.
check(tone(['ready', 'ready', 'repairable', 'ready'], 'repairable', true) !== GREEN,
  'TEMP/suffixed helper profile (repairable) never rolls up green');

check(tone(['ready', 'warning'], 'warning', true) !== GREEN, 'a warning row cannot produce the green summary');
// Blocked = a genuine external/manual blocker — amber "Action required".
// Red stays reserved for actual failures (scan threw, fix failed).
check(tone(['ready', 'blocked'], 'blocked', false) === 'warn', 'a blocked row summarises as amber');
check(ui.summarizeChecks(['ready', 'blocked'], 'blocked', false).text === 'Action required',
  'a blocked row summarises as "Action required"');
check(tone(['ready', 'unknown'], 'ready', true) !== GREEN, 'an unknown row cannot produce the green summary');
check(ui.summarizeChecks(['ready', 'unknown'], 'ready', true).text === 'Unknown',
  'an unknown row summarises as "Unknown"');
check(tone(['ready', 'pending'], 'ready', true) === 'scanning', 'a still-pending row summarises as scanning');

// A roll-up label this version does not know must not resolve to green
// even when every row it CAN see is ready — the unknown label means there
// may be a state it cannot see.
check(tone(['ready', 'ready'], 'brand-new-rollup', true) !== GREEN,
  'an unrecognised overall label cannot produce the green summary');
check(tone(['ready'], 'ready', false) === 'warn' &&
      ui.summarizeChecks(['ready'], 'ready', false).text === 'Action required',
  'canRunFix=false is reported even when no card is blocked (non-card blockers)');

// Zero rows is "nothing was checked", not "nothing is wrong".
check(tone([], 'ready', true) === 'error', 'an EMPTY checklist is an error, not a pass');
check(ui.summarizeChecks([], 'ready', true).text === 'No checks ran', 'empty checklist says no checks ran');
check(tone(undefined, 'ready', true) === 'error', 'a missing status list is an error, not a pass');

// ------------------------------------------------------------
console.log('ui-state-smoke: summary icon');

check(ui.summaryIcon('done') === '✓', "tone 'done' is the tick");
for (const t of ['warn', 'error', 'scanning', 'action', 'unknown', '', undefined, 'brand-new', 'toString']) {
  check(ui.summaryIcon(t) !== '✓', `tone ${JSON.stringify(t)} is NOT the tick`);
}

// ------------------------------------------------------------
console.log('ui-state-smoke: missing-card and not-elevated copy');

for (const [name, msg] of [['MISSING_CARD_MESSAGE', ui.MISSING_CARD_MESSAGE],
                           ['NOT_ELEVATED_CARD_MESSAGE', ui.NOT_ELEVATED_CARD_MESSAGE]]) {
  check(msg.length > 40, `${name} is real copy`);
  check(/unknown/i.test(msg), `${name} names the state as unknown`);
  check(/not a pass|it is not a pass/i.test(msg), `${name} says explicitly it is not a pass`);
}
check(/Administrator/.test(ui.NOT_ELEVATED_CARD_MESSAGE), 'not-elevated copy names Administrator rights');

// ------------------------------------------------------------
console.log('ui-state-smoke: a disabled Fix button always says why');

check(ui.fixDisabledNoteText([], true) === '', 'enabled button shows no note');
check(ui.fixDisabledNoteText(['Administrator'], true) === '', 'enabled button shows no note even with labels');
check(ui.fixDisabledNoteText(['Administrator'], false).indexOf('Administrator') !== -1,
  'disabled button names its blocker');
for (const empty of [[], null, undefined, [''], [null]]) {
  const t = ui.fixDisabledNoteText(empty, false);
  check(t === ui.FIX_DISABLED_FALLBACK, `disabled button with reasons ${JSON.stringify(empty)} still explains itself`);
  check(t.length > 40, 'the fallback is real copy, not a bare code');
}

// ------------------------------------------------------------
console.log('ui-state-smoke: update banner never renders unknown as silence');

const shownStates = ['downloading', 'restarting', 'deferred', 'manual', 'error'];
for (const state of shownStates) {
  const v = ui.updateBannerView({ state, version: '5.6.1', percent: 40, seconds: 5 });
  check(v.show === true, `update state '${state}' shows the banner`);
  check(typeof v.msg === 'string' && v.msg.length > 10, `update state '${state}' has real copy`);
}
check(ui.updateBannerView({ state: 'idle' }).show === false, "update state 'idle' hides the banner");

// A failed check leaves the update state UNKNOWN. It must not erase itself.
{
  const v = ui.updateBannerView({ state: 'error' });
  check(!('autoHideMs' in v), 'the update-error banner does not auto-hide');
  check(v.laterBtn === true, 'the update-error banner is dismissable by the user');
  check(/could not confirm/i.test(v.msg), 'the update-error banner says the state could not be confirmed');
}

// Unrecognised / malformed payloads.
for (const bad of [undefined, null, {}, { state: '' }, { state: 'checking' },
                   { state: 'available' }, { state: 'up-to-date' }, 42, 'error']) {
  const v = ui.updateBannerView(bad);
  check(v.show === true, `malformed/unknown update payload ${JSON.stringify(bad)} still tells the user something`);
  check(/unknown/i.test(v.msg), `payload ${JSON.stringify(bad)} is described as unknown`);
  check(v.laterBtn === true, `payload ${JSON.stringify(bad)} stays dismissable`);
}
check(/"checking"/.test(ui.updateBannerView({ state: 'checking' }).msg),
  'an unrecognised update state keeps its raw value visible for support');

// ------------------------------------------------------------
console.log('ui-state-smoke: installer launch and elevation decline');

check(ui.INSTALLER_NOT_STARTED.length > 40, 'installer-not-started is real copy');
check(/nothing was installed/i.test(ui.INSTALLER_NOT_STARTED), 'installer-not-started says nothing was installed');
check(/did not start/i.test(ui.INSTALLER_NOT_STARTED), 'installer-not-started says it did not start');

check(ui.installerExitNote(0) === '', 'a clean installer exit adds no failure note');
for (const code of [1, -1, 1223, 1602, 1603, '1602']) {
  const note = ui.installerExitNote(code);
  check(note === ui.INSTALLER_DECLINED, `installer exit code ${code} reports a non-completion`);
  check(/not installed/i.test(note), `installer exit code ${code} states Zoom was NOT installed`);
}
check(!/success|complete[d]?\b/i.test(ui.INSTALLER_DECLINED), 'a declined elevation never reads as success');

// ------------------------------------------------------------
console.log('ui-state-smoke: a success verdict with no receipt is not silent');

check(ui.RECEIPT_MISSING_MESSAGE.length > 40, 'receipt-missing is real copy');
check(/unknown/i.test(ui.RECEIPT_MISSING_MESSAGE), 'receipt-missing names the results as unknown');
check(/not confirmed/i.test(ui.RECEIPT_MISSING_MESSAGE), 'receipt-missing says the results are not confirmed');

// ------------------------------------------------------------
console.log('ui-state-smoke: run-verdict still fails loud (non-regression)');

// The honest-state work must not soften the #160 contract. A failed step
// still produces NEEDS ATTENTION, and that headline is not a plain success.
{
  const v = rv.computeRunVerdict(
    [{ id: 'profile-setup', label: 'Helper profile', outcome: 'fail', detail: 'TEMP/suffixed profile' }], [], []);
  check(v.partial === true, 'a failed profile-setup step is still partial');
  check(v.header === rv.VERDICT_HEADERS.attention, 'a failed profile-setup step still reads NEEDS ATTENTION');
  check(v.header !== rv.VERDICT_HEADERS.success, 'NEEDS ATTENTION is not the plain success header');
}

// ------------------------------------------------------------
console.log(failures === 0 ? '\nui-state-smoke: PASS' : `\nui-state-smoke: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
