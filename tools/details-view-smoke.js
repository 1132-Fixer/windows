'use strict';

// Smoke test for details-view.js — the plain-English model behind View
// details. Imports the REAL module and the REAL CHECK_ORDER (messages.js).
//
// Contract under test:
//  - every CHECK_ORDER key has a translation (label + description);
//  - the status vocabulary is exactly Checking / Ready / Needs attention /
//    Unable to verify, and 'repairable' never reads as Ready;
//  - a key the scan did not report is Unable to verify, never Ready;
//  - category and overall roll-ups are never better than their worst row;
//  - no string the model can emit contains technical text (registry
//    hives, commands, account names, paths, policy keys).

const dv = require('../details-view.js');
const { CHECK_ORDER } = require('../messages.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}

console.log('details-view-smoke: every check is translated');
for (const c of CHECK_ORDER) {
  const spec = dv.DETAILS_CHECKS[c.key];
  check(!!spec && spec.label && spec.description, `${c.key} has a plain label and description`);
  check(!!spec && spec.label !== c.label || ['helperUser', 'helperProfile'].indexOf(c.key) !== -1 || (spec && /Helper|Camera service/.test(spec.label)),
    `${c.key} label is user-facing (${spec && spec.label})`);
}
check(dv.DETAILS_CHECKS.seclogon.label !== 'Secondary Logon' && /Secondary Logon/.test(dv.DETAILS_CHECKS.seclogon.description),
  'Secondary Logon is named only beside a plain description');
check(dv.DETAILS_CHECKS.hku.label !== 'User registry hive', 'registry hive has a plain label');
for (const g of Object.keys(dv.DETAILS_CATEGORY_LABELS)) {
  check(CHECK_ORDER.some(c => c.group === g), `category '${g}' exists in CHECK_ORDER`);
}
for (const c of CHECK_ORDER) check(!!dv.DETAILS_CATEGORY_LABELS[c.group], `group '${c.group}' has a category label`);

console.log('details-view-smoke: four status words');
const WORDS = new Set(['Checking', 'Ready', 'Needs attention', 'Unable to verify']);
for (const s of ['pending', 'ready', 'repairable', 'blocked', 'warning', 'unknown', 'nonsense', undefined]) {
  const v = dv.detailsStatusFor(s);
  check(WORDS.has(v.word), `status '${s}' -> '${v.word}'`);
}
check(dv.detailsStatusFor('repairable').word === 'Needs attention', 'repairable never reads as Ready');
check(dv.detailsStatusFor('warning').word === 'Unable to verify', 'warning reads as Unable to verify');
check(dv.detailsStatusFor('unknown').word === 'Unable to verify', 'unknown reads as Unable to verify');
check(dv.detailsStatusFor('bogus').word === 'Unable to verify', 'unrecognised status reads as Unable to verify');
check(dv.checkView('helperUser', 'x', 'repairable').explain.indexOf('Fix now') !== -1, 'repairable explains that Fix now handles it');
check(dv.checkView('admin', 'x', 'ready').explain === '', 'a Ready check has no explanation line');
check(dv.checkView('admin', 'x', 'blocked').explain.length > 0, 'a blocked check explains what to do');

console.log('details-view-smoke: model roll-ups');
const allReady = {};
for (const c of CHECK_ORDER) allReady[c.key] = 'ready';
let m = dv.buildDetailsModel(allReady, CHECK_ORDER);
check(m.categories.length === new Set(CHECK_ORDER.map(c => c.group)).size, 'one category per CHECK_ORDER group');
check(m.overall.tone === 'ready' && m.overall.passed === CHECK_ORDER.length, 'all ready -> overall ready');
check(m.overall.counts === `${CHECK_ORDER.length} of ${CHECK_ORDER.length} checks passed`, `counts line: ${m.overall.counts}`);
check(m.categories.every(c => c.summary === `${c.total} of ${c.total} ${c.total === 1 ? 'check' : 'checks'} passed`), 'category summaries count passes');

m = dv.buildDetailsModel({ ...allReady, seclogon: 'blocked' }, CHECK_ORDER);
const helper = m.categories.find(c => c.group === 'Helper account');
check(helper.tone === 'attention' && helper.summary === '1 item needs attention', `blocked row rolls the category up to attention (${helper.summary})`);
check(m.overall.tone === 'attention' && m.overall.headline === '1 item needs attention.', `overall headline: ${m.overall.headline}`);

m = dv.buildDetailsModel({ ...allReady, hku: 'warning' }, CHECK_ORDER);
check(m.overall.tone === 'unverified' && /could not be verified/.test(m.overall.headline), 'a warning row makes the overall unverified');

m = dv.buildDetailsModel({ ...allReady, camPolicy: 'pending' }, CHECK_ORDER);
check(m.overall.tone === 'checking' && m.categories.find(c => c.group === 'Privacy policies').summary === 'Checking…', 'a pending row reads as Checking');

m = dv.buildDetailsModel({}, CHECK_ORDER);
check(m.overall.passed === 0 && m.categories.every(c => c.checks.every(x => x.word === 'Unable to verify')), 'missing keys are Unable to verify, never Ready');

m = dv.buildDetailsModel({ admin: 'blocked' }, CHECK_ORDER);
check(m.categories.find(c => c.group === 'App').tone === 'attention', 'admin blocked -> App needs attention');

m = dv.buildDetailsModel(null, []);
check(m.categories.length === 0 && /Nothing has been checked/.test(m.overall.headline), 'empty order -> honest empty headline');

console.log('details-view-smoke: repair results');
check(dv.receiptItemView('camera', 'ok', 'x').word === 'Ready' && dv.receiptItemView('camera', 'ok', 'x').explain === '', 'ok receipt -> Ready, no explanation');
check(dv.receiptItemView('camera', 'fail', 'why').word === 'Needs attention' && dv.receiptItemView('camera', 'fail', 'why').explain === 'why', 'fail receipt -> Needs attention with explanation');
check(dv.receiptItemView('hku', 'warn', 'why').word === 'Unable to verify', 'warn receipt -> Unable to verify');
check(dv.receiptItemView('frameServer', 'bogus', 'why').word === 'Unable to verify', 'unrecognised receipt -> Unable to verify');
check(dv.RECEIPT_LABELS.hku !== 'User registry hive', 'receipt labels are plain');

console.log('details-view-smoke: repair attention is visible and private');
const privateDiagnostic = 'C:\\Users\\private-person\\NTUSER.DAT password=do-not-render HKLM user1';
const repairModels = [];
function repairModel(steps, warnings, attention) {
  const result = dv.buildRepairAttentionModel(steps, warnings, attention);
  repairModels.push(result);
  return result;
}
let repair = repairModel([{ id: 'relaunch', outcome: 'ok', label: privateDiagnostic, detail: privateDiagnostic }], [], []);
check(repair.items.length === 0 && repair.tone === null && repair.word === null,
  'successful steps add no attention and do not manufacture verified success');
repair = repairModel([{ id: 'data-clear', outcome: 'fail', label: privateDiagnostic, detail: privateDiagnostic }], [], []);
check(repair.items.length === 1 && repair.items[0].label === 'Old helper settings'
  && repair.items[0].word === 'Needs attention' && /before another reset/.test(repair.items[0].explain),
  'failed cleanup gets a useful plain-English attention row');
repair = repairModel([{ id: 'zoom-config', outcome: 'warn' }], [], []);
check(repair.items[0].label === 'Zoom preferences' && repair.items[0].word === 'Unable to verify',
  'uncertain preferences remain unverified');
repair = repairModel([], [{ code: 'gpo_deny_camera', message: privateDiagnostic }], []);
check(repair.items[0].label === 'Camera permission' && repair.items[0].word === 'Needs attention'
  && /policy blocking camera/.test(repair.items[0].explain), 'known policy denial is not shown as a pass or generic warning');
repair = repairModel([], [{ code: 'ini_write_failed', message: privateDiagnostic }], []);
check(repair.items[0].label === 'Zoom preferences' && repair.items[0].word === 'Unable to verify',
  'a known warning has static copy without copying its diagnostic message');
repair = repairModel([], [], [{ id: 'step-evidence-2', outcome: 'fail', label: privateDiagnostic, detail: privateDiagnostic }]);
check(repair.items[0].label === 'Repair verification' && repair.tone === 'attention',
  'verdict evidence failures are visible even without a failed named step');
repair = repairModel([{ id: 'profsvc-flush', outcome: 'warn' }], [{ code: 'profsvc_flush_failed' }],
  [{ id: 'profsvc-flush', outcome: 'fail' }]);
check(repair.items.length === 1 && repair.items[0].word === 'Needs attention',
  'step, warning and verdict duplicates combine and keep the strongest outcome');
repair = repairModel([{ id: privateDiagnostic, outcome: 'fail', label: privateDiagnostic, detail: privateDiagnostic }],
  [{ code: privateDiagnostic, message: privateDiagnostic, payload: { path: privateDiagnostic } }], []);
check(repair.items.length === 1 && repair.items[0].label === 'Other repair results' && repair.tone === 'attention',
  'unknown identifiers use one bounded fallback and retain a reported failure');
for (const id of ['__proto__', 'constructor', 'toString']) {
  repair = repairModel([{ id, outcome: 'warn' }], [{ code: id }], []);
  check(repair.items.length === 1 && repair.items[0].word === 'Unable to verify',
    `inherited catalog name ${id} is an unknown result`);
}
for (const malformed of [null, false, 7, 'private payload', {}, [null], [false], [[]], [{ id: 'data-clear', outcome: 'unexpected' }]]) {
  repair = repairModel(malformed, [], []);
  check(repair.items.length > 0 && repair.items.every(row => row.word !== 'Ready'),
    'malformed step evidence remains visible and never Ready');
}
repair = repairModel([], [null, 'private warning', { message: privateDiagnostic }], []);
check(repair.items.length > 0 && repair.items.every(row => row.word !== 'Ready'), 'malformed warnings stay visible');
repair = repairModel([], [], [{ id: 'relaunch', outcome: 'ok' }]);
check(repair.items[0].label === 'Repair verification' && repair.items[0].word === 'Unable to verify',
  'contradictory attention evidence is not silently discarded');
let getterReads = 0;
const guardedStep = { id: 'relaunch', outcome: 'fail' };
for (const key of ['label', 'detail', 'payload']) Object.defineProperty(guardedStep, key, {
  get() { getterReads++; throw new Error('private field read'); }
});
const guardedWarning = { code: 'relaunch_failed' };
Object.defineProperty(guardedWarning, 'message', { get() { getterReads++; throw new Error('private message read'); } });
repair = repairModel([guardedStep], [guardedWarning], []);
check(getterReads === 0 && repair.items.length === 1 && repair.tone === 'attention', 'private getters are never evaluated');
const accessorArray = [];
Object.defineProperty(accessorArray, '0', { get() { getterReads++; throw new Error('private entry read'); } });
repair = repairModel(accessorArray, [], []);
check(getterReads === 0 && repair.items[0].word === 'Unable to verify', 'array accessors are missing evidence, not executed');
const revoked = Proxy.revocable([], {});
revoked.revoke();
repair = repairModel(revoked.proxy, [], []);
check(repair.items[0].word === 'Unable to verify', 'a revoked input proxy becomes missing evidence');
const frozenStep = Object.freeze({ id: 'relaunch', outcome: 'fail' });
const frozenSteps = Object.freeze([frozenStep]);
repair = repairModel(frozenSteps, Object.freeze([]), Object.freeze([frozenStep]));
check(repair.items.length === 1 && frozenStep.outcome === 'fail' && frozenSteps.length === 1, 'frozen input evidence is not mutated');
const sparseSteps = new Array(1000000);
repair = repairModel(sparseSteps, [], []);
check(repair.truncated && repair.items.length <= dv.REPAIR_ATTENTION_LIMITS.items
  && repair.items.some(row => row.key === 'repair-additional'), 'large sparse evidence is bounded and discloses incomplete coverage');
repair = repairModel(['close-sessions', 'remove-admin-rights', 'data-clear', 'profsvc-flush', 'create-account',
  'relaunch', 'profile-setup', 'zoom-config', 'consent'].map(id => ({ id, outcome: 'warn' })),
  ['gpo_deny_camera', 'gpo_deny_microphone', 'consent_hku_load_failed', 'frameserver_missing', 'shortcut_failed']
    .map(code => ({ code })), []);
check(repair.truncated && repair.items.length === dv.REPAIR_ATTENTION_LIMITS.items
  && repair.items[repair.items.length - 1].word === 'Needs attention',
  'row limit keeps a disclosed overflow row with the strongest omitted outcome');
for (const model of repairModels) {
  check(!JSON.stringify(model).includes(privateDiagnostic), 'repair output never copies private diagnostic data');
  check(model.items.every(row => WORDS.has(row.word) && row.tone !== 'ready'), 'attention rows use truthful existing status words');
}

console.log('details-view-smoke: no technical text can reach the screen');
const emitted = [];
for (const model of repairModels) {
  emitted.push(model.summary, model.word || '');
  for (const row of model.items) emitted.push(row.label, row.word, row.explain);
}
for (const [key, spec] of Object.entries(dv.DETAILS_CHECKS)) {
  emitted.push(spec.label, spec.description, ...Object.values(spec.explain || {}));
  for (const s of ['pending', 'ready', 'repairable', 'blocked', 'warning', 'unknown']) {
    const v = dv.checkView(key, key, s);
    emitted.push(v.label, v.description, v.explain, v.word);
  }
}
emitted.push(...Object.values(dv.DETAILS_EXPLAIN_DEFAULT), ...Object.values(dv.RECEIPT_LABELS), ...Object.values(dv.DETAILS_CATEGORY_LABELS));
for (const s of ['pending', 'ready', 'repairable', 'blocked', 'warning', 'unknown']) {
  const all = {};
  for (const c of CHECK_ORDER) all[c.key] = s;
  const mm = dv.buildDetailsModel(all, CHECK_ORDER);
  emitted.push(mm.overall.headline, mm.overall.counts, ...mm.categories.map(c => c.summary), ...mm.categories.map(c => c.word));
}
const dirty = emitted.filter(t => !dv.isPlainEnglish(t));
check(dirty.length === 0, `no emitted string is technical${dirty.length ? ': ' + JSON.stringify(dirty.slice(0, 3)) : ''}`);
check(!dv.isPlainEnglish("'user1' will be created on FIX NOW."), 'guard rejects an account name');
check(!dv.isPlainEnglish('HKU\\S-1-5-21 active'), 'guard rejects a registry hive');
check(!dv.isPlainEnglish('run sc.exe config seclogon start= demand'), 'guard rejects a command');
check(!dv.isPlainEnglish('Found at C:\\Program Files\\Zoom\\bin\\Zoom.exe'), 'guard rejects a file path');
check(!dv.isPlainEnglish('Blocked by Windows policy (Force Deny)'), 'guard rejects a policy key');
check(dv.isPlainEnglish('Zoom is not installed for everyone on this PC. Install it, then check again.'), 'guard accepts plain English');

if (failures) {
  console.error(`details-view-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('details-view-smoke: all checks passed');
