'use strict';

// Node only: evaluate the shipped renderer functions against inert elements,
// deferred IPC promises, and manual timers. No Electron, browser, subprocess,
// network, file writes, or application initialization runs in this driver.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeRunVerdict } = require('../run-verdict');
const receiptMessages = require('../messages');
const { receiptItemView, buildRepairAttentionModel } = require('../details-view');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

function shippedFunction(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `shipped function ${name} exists`);
  // Top-level declarations close at column zero; nested blocks are indented.
  const end = source.indexOf('\n}', start.index);
  assert.ok(end > start.index, `shipped function ${name} has a closing brace`);
  return source.slice(start.index, end + 2);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function element(id) {
  const classes = new Set();
  const listeners = new Map();
  return {
    id, hidden: true, disabled: false, checked: true, textContent: '',
    innerHTML: '', title: '', dataset: {}, attributes: {}, focusCount: 0,
    classList: {
      contains: name => classes.has(name),
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focusCount++; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    click() {
      const callback = listeners.get('click');
      if (callback) callback();
    }
  };
}

function harness() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  };
  const scans = [];
  const repairs = [];
  const timers = [];
  const logs = [];
  const body = { dataset: {} };
  let shortcutCalls = 0;
  const context = vm.createContext({
    document: { body, getElementById: get },
    window: { electronAPI: {
      preflightScan() { const request = deferred(); scans.push(request); return request.promise; },
      runFix() { const request = deferred(); repairs.push(request); return request.promise; },
      shortcutExists: async () => ({ exists: false })
    } },
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    CHECK_ORDER: [{ key: 'zoom', label: 'Zoom', group: 'Zoom' }],
    WIZARD_GROUPS: [{ group: 'Zoom', keys: ['zoom'] }],
    CARD_COVERED_BLOCKER_CODES: new Set(),
    GROUP_STATUS_RANK: ['blocked', 'unknown', 'repairable', 'warning', 'pending', 'ready'],
    WIZ_GLYPH: { ok: 'ok', warn: 'warn', err: 'err' },
    WIZARD: {
      READY_TITLE: 'Ready to fix Zoom', READY_SUB: 'Ready',
      BLOCKED_TITLE: 'Action required', UNABLE_TITLE: 'Unable to complete',
      UNABLE_SUB: 'Try again', TRY_AGAIN: 'Try again',
      CONFIRM_TITLE: 'Confirm repair', CONFIRM_BODY: 'Replace helper setup',
      CONFIRM_CONTINUE: 'Continue', CONFIRM_CANCEL: 'Cancel',
      FAIL_TITLE: 'Repair failed', SUCCESS_TITLE: 'Complete', SUCCESS_SUB: 'Complete',
      PARTIAL_TITLE: 'Needs attention', PARTIAL_SUB: 'Read details', WARNINGS_SUB: 'Read details',
      SHORTCUT_DEFERRED: 'The shortcut was not changed because the repair could not be verified.'
    },
    VERDICT_HEADERS: { attention: 'Needs attention' },
    normalizeCheckStatus: status => status,
    summarizeChecks: (_statuses, _overall, allowed) => ({ tone: allowed ? 'ready' : 'warn', text: 'Scan finished' }),
    renderWizChecks() {}, updateFixDisabledNote() {}, updateZoomRecovery() {},
    wizardBlockedSub: () => 'Resolve blocker', scanFailureMessage: () => 'Scan failed',
    resetStages() {}, advanceStageTo() {}, finalizeStages() {},
    clearFileList() { logs.length = 0; }, addEmptyLine() {},
    addFileItem(line) { logs.push(line); },
    computeRunVerdict,
    receiptItemView, buildRepairAttentionModel,
    receiptStatusFor: receiptMessages.receiptStatusFor,
    describeHku: receiptMessages.describeHku,
    describeFrameServer: receiptMessages.describeFrameServer,
    friendlyError: error => error || 'Unknown',
    unexpectedFixFailure: () => 'Unexpected repair failure',
    createShortcut: async () => { shortcutCalls++; return { ok: true }; },
    installFocusTrap: () => () => {},
    showDetailsOverview() {}, showDetailsCategory() {}
  });
  const bindings = [
    'elevateBtn', 'fixBtn', 'launchBtn', 'shortcutBtn', 'rescanBtn', 'closeBtn',
    'detailsBtn', 'supportBtn', 'copyErrBtn', 'buttonNote', 'fixConfirmOverlay',
    'fixConfirmContinue', 'fixConfirmCancel', 'detailsView', 'backBtn', 'wizardCard'
  ].map(id => `const ${id} = document.getElementById('${id}');`).join('\n');
  const functions = [
    'setWizardPane', 'fillWizHeadline', 'showResultPane', 'showNoticePane', 'setActions',
    'worstStatus', 'ownsEnvironmentScan', 'runEnvironmentScan', 'presentScanResult',
    'clearPendingFixAfterScan', 'hideFixConfirm', 'showFixConfirm', 'onFixButtonClick', 'hasVerifiedZoomReceipt', 'runFix',
    'renderFixReceipt', 'receiptPlainText',
    'detailsOpen', 'openDetails', 'closeDetails', 'refreshDetailsIfOpen'
  ].map(shippedFunction).join('\n');
  vm.runInContext(`${bindings}
    const actionArea = document.getElementById('actionArea');
    const WIZ_PANES = Object.fromEntries(['checking', 'result', 'fixing', 'notice']
      .map(name => [name, document.getElementById('pane-' + name)]));
    let isRunning = false, scanInProgress = false, scanGeneration = 0;
    let lastScanAt = 0, canRunFix = true, pendingFixAfterScan = false;
    let lastScan = { statusByKey: {} }, lastReceipt = null, lastReceiptItems = null, detailsOpenCategoryId = null;
    let releaseFixConfirmFocus = null;
    function setStatus(tone, text) {
      const badge = document.getElementById('statusBadge');
      badge.hidden = false; badge.dataset.tone = tone; badge.textContent = text;
    }
    ${functions}
  `, context, { filename: 'renderer-operation-functions.js' });
  // Use the real Continue registration, including its call to runFix.
  const registration = source.indexOf('if (fixConfirmContinue) {');
  assert.ok(registration !== -1, 'shipped Continue registration exists');
  const registrationEnd = source.indexOf('\n}', registration);
  assert.ok(registrationEnd > registration, 'Continue registration has a closing brace');
  vm.runInContext(source.slice(registration, registrationEnd + 2), context);
  const evaluate = code => vm.runInContext(code, context);
  evaluate("setWizardPane('result'); setActions({ fix: true, shortcutOption: true, details: true });");
  get('wizardCard').hidden = false;
  get('actionArea').hidden = false;
  return {
    get, scans, repairs, timers, body, evaluate,
    shortcutCalls: () => shortcutCalls,
    state: () => evaluate('({ isRunning, scanInProgress, canRunFix, pendingFixAfterScan, scanGeneration })'),
    screen: () => ({
      pane: ['checking', 'result', 'fixing', 'notice'].find(name => get('pane-' + name).classList.contains('active')),
      fixHidden: get('fixBtn').hidden,
      launchHidden: get('launchBtn').hidden,
      badgeHidden: get('statusBadge').hidden,
      badgeTone: get('statusBadge').dataset.tone
    }),
    fireTimer(ms) {
      const index = timers.findIndex(timer => timer.ms === ms);
      assert.ok(index !== -1, `manual ${ms}ms timer exists`);
      timers.splice(index, 1)[0].callback();
    }
  };
}

function focusHarness(count = 2) {
  const timers = new Map();
  let nextTimer = 0;
  const nodes = new Map();
  const doc = { activeElement: null, contains: node => [...nodes.values()].includes(node) };
  class FakeElement {
    constructor(id) {
      this.id = id; this.hidden = false; this.offsetParent = {}; this.listeners = new Map();
      this.textContent = ''; this.focusCount = 0;
    }
    focus() { this.focusCount++; doc.activeElement = this; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    querySelectorAll() { return this === overlay ? items : []; }
    contains(node) { return node === this || (this === overlay && items.includes(node)); }
  }
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, new FakeElement(id));
    return nodes.get(id);
  };
  const opener = get('opener');
  const overlay = get('fixConfirmOverlay');
  overlay.hidden = true;
  const items = Array.from({ length: count }, (_, index) => get('item-' + index));
  doc.activeElement = opener;
  doc.getElementById = get;
  const context = vm.createContext({
    document: doc, HTMLElement: FakeElement,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    WIZARD: { CONFIRM_TITLE: 'Confirm', CONFIRM_BODY: 'Check', CONFIRM_CONTINUE: 'Continue', CONFIRM_CANCEL: 'Cancel' },
    runFix() { throw new Error('Focus fixture must not start repair'); }
  });
  vm.runInContext(`
    const FOCUSABLE_SEL = 'fixture';
    const fixConfirmOverlay = document.getElementById('fixConfirmOverlay');
    const fixConfirmContinue = document.getElementById('item-0');
    const fixConfirmCancel = document.getElementById('item-1');
    let releaseFixConfirmFocus = null;
    ${['getFocusable', 'installFocusTrap', 'hideFixConfirm', 'showFixConfirm'].map(shippedFunction).join('\n')}
  `, context);
  return {
    context, doc, nodes, opener, overlay, items, timers,
    evaluate: code => vm.runInContext(code, context),
    flush() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    tab(shiftKey = false) {
      let prevented = false;
      overlay.listeners.get('keydown')({ key: 'Tab', shiftKey, preventDefault() { prevented = true; } });
      return prevented;
    }
  };
}

const ready = () => ({ cards: { zoom: { status: 'ready', label: 'Zoom' } }, canRunFix: true, overall: 'ready' });
const blocked = () => ({ cards: { zoom: { status: 'blocked', label: 'Zoom' } }, canRunFix: false, overall: 'blocked' });
const repaired = () => ({ success: true, steps: [{ id: 'relaunch', label: 'Restart Zoom', outcome: 'ok' }], warnings: [],
  receipt: { profileKind: 'canonical', zoomRelaunch: 'confirmed' } });
const flush = () => new Promise(resolve => setImmediate(resolve));

async function check(name, run) {
  await run();
  console.log(`  ok  ${name}`);
}

// An accidentally unresolved fixture must fail instead of letting Node exit
// successfully with an unfinished Promise and no remaining event-loop handle.
const deadline = setTimeout(() => {
  console.error('renderer-operation-smoke: timed out before all checks completed');
  process.exitCode = 1;
}, 10000);

(async () => {
  await check('latest quiet scan publishes normally', async () => {
    const h = harness();
    const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.scans[0].resolve(ready());
    await scan;
    assert.equal(h.state().scanInProgress, false);
    assert.equal(h.state().canRunFix, true);
    assert.equal(h.evaluate('lastScan.statusByKey.zoom'), 'ready');
    assert.equal(h.screen().pane, 'result');
    assert.equal(h.get('fixBtn').hidden, false);
  });

  await check('latest foreground scan completes its delayed presentation', async () => {
    const h = harness();
    const scan = h.evaluate('runEnvironmentScan()');
    h.scans[0].resolve(ready());
    await flush();
    assert.equal(h.screen().pane, 'checking');
    assert.equal(h.state().scanInProgress, true);
    h.fireTimer(650);
    await scan;
    assert.equal(h.state().scanInProgress, false);
    assert.equal(h.screen().pane, 'result');
    assert.equal(h.get('fixBtn').hidden, false);
  });

  await check('Continue during quiet scan keeps repair pane and cancellation path', async () => {
    const h = harness();
    h.evaluate('showFixConfirm()');
    const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.get('fixConfirmContinue').click();
    assert.equal(h.repairs.length, 1);
    assert.equal(h.get('fixConfirmOverlay').hidden, true);
    assert.equal(h.state().isRunning, true);
    assert.equal(h.screen().pane, 'fixing');
    const repairing = h.screen();
    h.scans[0].resolve(blocked());
    await scan;
    // Compact shell derives Cancel availability from this active fixing pane.
    assert.deepEqual(h.screen(), repairing);
    assert.equal(h.state().isRunning, true);
    assert.equal(h.state().canRunFix, true);
    h.repairs[0].resolve(repaired());
    await flush();
    assert.equal(h.state().isRunning, false);
  });

  await check('old scan cannot overwrite newer scan or release its lock', async () => {
    const h = harness();
    const old = h.evaluate('runEnvironmentScan({ quiet: true })');
    const repair = h.evaluate('runFix()');
    h.repairs[0].resolve(repaired());
    await repair;
    const latest = h.evaluate('runEnvironmentScan({ quiet: true })');
    const beforeOldCompletion = h.screen();
    h.scans[0].resolve(blocked());
    await old;
    assert.deepEqual(h.screen(), beforeOldCompletion);
    assert.equal(h.state().scanInProgress, true);
    assert.equal(h.state().canRunFix, true);
    h.scans[1].resolve(ready());
    await latest;
    assert.equal(h.state().scanInProgress, false);
    assert.equal(h.evaluate('lastScan.statusByKey.zoom'), 'ready');
    assert.equal(h.screen().pane, 'result');
  });

  await check('stale scan failure cannot replace repair or newer scan', async () => {
    const h = harness();
    const old = h.evaluate('runEnvironmentScan({ quiet: true })');
    const repair = h.evaluate('runFix()');
    const repairing = h.screen();
    h.scans[0].reject(new Error('old probe failed'));
    await old;
    assert.deepEqual(h.screen(), repairing);
    h.repairs[0].resolve(repaired());
    await repair;
    const superseded = h.evaluate('runEnvironmentScan({ quiet: true })');
    const nextRepair = h.evaluate('runFix()');
    h.repairs[1].resolve(repaired());
    await nextRepair;
    const latest = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.scans[1].reject(new Error('superseded probe failed'));
    await superseded;
    assert.equal(h.state().scanInProgress, true);
    assert.equal(h.state().canRunFix, true);
    h.scans[2].resolve(ready());
    await latest;
  });

  await check('current scan failure clears queued confirmation and offers retry', async () => {
    const h = harness();
    h.evaluate('showFixConfirm()');
    assert.equal(h.get('fixConfirmOverlay').hidden, false);
    const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.evaluate('onFixButtonClick()');
    assert.equal(h.state().pendingFixAfterScan, true);
    h.scans[0].reject(new Error('current probe failed'));
    await scan;
    assert.equal(h.state().pendingFixAfterScan, false);
    assert.equal(h.state().canRunFix, false);
    assert.equal(h.state().scanInProgress, false);
    assert.equal(h.get('fixBtn').textContent, 'Fix now');
    assert.equal(h.get('fixConfirmOverlay').hidden, true);
    assert.equal(h.screen().pane, 'notice');
    assert.equal(h.get('rescanBtn').hidden, false);
    assert.equal(h.get('rescanBtn').textContent, 'Try again');
  });

  await check('clearing queued intent does not depend on the displayed copy', async () => {
    const h = harness();
    const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.evaluate('onFixButtonClick()');
    h.get('fixBtn').textContent = 'Waiting for the current check';
    h.evaluate('clearPendingFixAfterScan()');
    assert.equal(h.state().pendingFixAfterScan, false);
    assert.equal(h.get('fixBtn').textContent, 'Fix now');
    h.scans[0].resolve(ready());
    await scan;
    assert.equal(h.get('fixConfirmOverlay').hidden, true);
  });

  await check('delayed scan presentation also loses ownership when repair starts', async () => {
    const h = harness();
    const scan = h.evaluate('runEnvironmentScan()');
    h.scans[0].resolve(ready());
    await flush();
    assert.equal(h.timers.length, 1);
    const repair = h.evaluate('runFix()');
    const repairing = h.screen();
    h.fireTimer(650);
    await scan;
    assert.deepEqual(h.screen(), repairing);
    h.repairs[0].resolve(repaired());
    await repair;
  });

  await check('Fix during quiet scan waits, then confirms once with restored label', async () => {
    const h = harness();
    const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.evaluate('onFixButtonClick()');
    assert.equal(h.get('fixConfirmOverlay').hidden, true);
    assert.equal(h.get('fixBtn').textContent, 'Starting after check\u2026');
    h.scans[0].resolve(ready());
    await scan;
    assert.equal(h.get('fixConfirmOverlay').hidden, false);
    assert.equal(h.state().pendingFixAfterScan, false);
    assert.equal(h.get('fixBtn').textContent, 'Fix now');
    h.get('fixConfirmContinue').click();
    h.get('fixConfirmContinue').click();
    assert.equal(h.repairs.length, 1);
    h.repairs[0].resolve(repaired());
    await flush();
  });

  await check('current blocked scan withdraws earlier confirmation', async () => {
    const h = harness();
    h.evaluate('showFixConfirm()');
    const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
    h.scans[0].resolve(blocked());
    await scan;
    assert.equal(h.get('fixConfirmOverlay').hidden, true);
    h.get('fixConfirmContinue').click();
    assert.equal(h.repairs.length, 0);
    assert.equal(h.state().canRunFix, false);
  });

  await check('verified completion offers launch and the requested shortcut', async () => {
    const h = harness();
    const repair = h.evaluate('runFix()');
    h.repairs[0].resolve(repaired());
    await repair;
    assert.equal(h.screen().launchHidden, false);
    assert.equal(h.shortcutCalls(), 1);
  });
  for (const [name, alter] of [
    ['explicit partial result', result => { result.partial = true; }],
    ['missing receipt', result => { delete result.receipt; }],
    ['null receipt', result => { result.receipt = null; }],
    ['temporary profile', result => { result.receipt.profileKind = 'temp'; }],
    ['suffixed profile', result => { result.receipt.profileKind = 'suffixed'; }],
    ['unverified launch', result => { result.receipt.zoomRelaunch = 'unverified'; }],
    ['undetected launch', result => { result.receipt.zoomRelaunch = 'not-detected'; }],
    ['missing steps', result => { delete result.steps; }],
    ['empty steps', result => { result.steps = []; }],
    ['invalid ledger entry', result => { result.steps.push(null); }],
    ['contradictory relaunch warning', result => { result.steps[0].outcome = 'warn'; }]
  ]) {
    await check(name + ' cannot offer launch or create a shortcut', async () => {
      const h = harness();
      const result = repaired();
      alter(result);
      const repair = h.evaluate('runFix()');
      h.repairs[0].resolve(result);
      await repair;
      assert.equal(h.screen().launchHidden, true);
      assert.equal(h.get('shortcutBtn').hidden, true);
      assert.equal(h.shortcutCalls(), 0);
      assert.equal(h.screen().badgeTone, 'warn');
    });
  }

  for (const checked of [false, true]) {
    await check(`Details and checkbox ${checked} survive scan and repair ownership changes`, async () => {
      const h = harness();
      h.get('shortcutOptInput').checked = checked;
      h.evaluate('openDetails()');
      const scan = h.evaluate('runEnvironmentScan({ quiet: true })');
      h.scans[0].resolve(ready());
      await scan;
      assert.equal(h.body.dataset.view, 'details');
      assert.equal(h.get('wizardCard').hidden, true);
      assert.equal(h.get('actionArea').hidden, true);
      assert.equal(h.get('shortcutOptInput').checked, checked);
      h.evaluate('closeDetails()');
      assert.equal(h.body.dataset.view, undefined);
      assert.equal(h.get('detailsBtn').focusCount, 1);
      const repair = h.evaluate('runFix()');
      h.evaluate('openDetails()');
      h.repairs[0].resolve(repaired());
      await repair;
      assert.equal(h.body.dataset.view, 'details');
      assert.equal(h.get('shortcutOptInput').checked, checked);
      assert.equal(h.shortcutCalls(), checked ? 1 : 0);
      h.evaluate('closeDetails()');
      assert.equal(h.screen().pane, 'notice');
      assert.equal(h.get('shortcutOptInput').checked, checked);
    });
  }
  await check('Details receives failed steps and warnings without exposing their raw private text', async () => {
    const h = harness();
    h.evaluate("renderFixReceipt(null, [{code: 'temp_or_suffixed_profile', message: 'private detail'}], [{id: 'data-clear', outcome: 'fail', detail: 'private detail'}], []);");
    const rows = h.evaluate('lastReceiptItems');
    assert.equal(rows.length, 6);
    assert.equal(rows.find(row => row.key === 'repair-cleanup').tone, 'attention');
    assert.equal(rows.find(row => row.key === 'repair-profileSetup').tone, 'attention');
    assert.equal(JSON.stringify(rows).includes('private detail'), false);
    assert.deepEqual(Array.from(rows.slice(0, 4), row => row.key), ['camera', 'microphone', 'hku', 'frameServer']);
  });
  await check('failed result records verification gaps in Details', async () => {
    const h = harness();
    const repair = h.evaluate('runFix()');
    h.repairs[0].resolve({ success: false, error: 'process_teardown_unverified' });
    await repair;
    const rows = h.evaluate('lastReceiptItems');
    assert.equal(rows.length >= 5, true);
    assert.equal(rows.some(row => row.key === 'repair-verification' && row.tone === 'attention'), true);
    assert.equal(h.screen().launchHidden, true);
  });
  await check('confirmation traps focus in both directions and restores its opener once', async () => {
    const h = focusHarness();
    h.evaluate('showFixConfirm()');
    h.flush();
    assert.equal(h.doc.activeElement, h.items[0]);
    assert.equal(h.tab(true), true);
    assert.equal(h.doc.activeElement, h.items[1]);
    assert.equal(h.tab(), true);
    assert.equal(h.doc.activeElement, h.items[0]);
    h.doc.activeElement = h.opener;
    assert.equal(h.tab(), true);
    assert.equal(h.doc.activeElement, h.items[0]);
    h.evaluate('hideFixConfirm(); hideFixConfirm();');
    assert.equal(h.doc.activeElement, h.opener);
    assert.equal(h.opener.focusCount, 1);
    assert.equal(h.overlay.listeners.has('keydown'), false);
  });
  await check('closing confirmation cancels deferred focus before it can escape back into hidden content', async () => {
    const h = focusHarness();
    h.evaluate('showFixConfirm()');
    const oldCallbacks = [...h.timers.values()];
    h.evaluate('hideFixConfirm()');
    assert.equal(h.timers.size, 0);
    for (const callback of oldCallbacks) callback();
    assert.equal(h.doc.activeElement, h.opener);
    h.evaluate('showFixConfirm()');
    h.flush();
    assert.equal(h.doc.activeElement, h.items[0]);
  });
  for (const count of [0, 1]) {
    await check(`focus trap handles ${count} visible controls and a removed opener`, async () => {
      const h = focusHarness(count);
      h.evaluate('showFixConfirm()');
      h.flush();
      assert.equal(h.tab(), true);
      assert.equal(h.tab(true), true);
      h.nodes.delete('opener');
      h.evaluate('hideFixConfirm()');
      assert.equal(h.opener.focusCount, 0);
    });
  }
  await check('native progress uses the shipped fixed step mapping without adding cancellation headers', async () => {
    const stages=[],logs=[];
    const ctx=vm.createContext({isRunning:true,advanceStageTo:stage=>stages.push(stage),addFileItem:(line,kind)=>logs.push({line,kind})});
    vm.runInContext(shippedFunction('stageForRepairStep')+'\n'+shippedFunction('handleRepairLog'),ctx);
    ctx.payload={line:'Preparing the repair',kind:'out',step:'preparing'};vm.runInContext('handleRepairLog(payload)',ctx);
    ctx.payload={line:'Opening Zoom in the fresh profile',kind:'out',step:'launch-zoom'};vm.runInContext('handleRepairLog(payload)',ctx);
    ctx.payload={line:'Checking Zoom permissions',kind:'out',step:'configure-helper'};vm.runInContext('handleRepairLog(payload)',ctx);
    ctx.payload={line:'Confirming Zoom is running',kind:'out',step:'verify-zoom'};vm.runInContext('handleRepairLog(payload)',ctx);
    ctx.payload={line:'Finishing the repair',kind:'out',step:'closing-worker'};vm.runInContext('handleRepairLog(payload)',ctx);
    assert.deepEqual(stages,['prep','verify','consent','launch','receipt']);
    assert.equal(logs.some(item=>/^\[(?:1|2|3|7|8)\/8\]|^\[V\]/.test(item.line)),false);
    assert.ok(source.includes('api.onFixLog(handleRepairLog)'));
    for(const step of ['__proto__','constructor','arbitrary-native-text',null]) {
      ctx.payload={line:'bounded display text',step};vm.runInContext('handleRepairLog(payload)',ctx);
    }
    ctx.isRunning=false;ctx.payload={line:'late display',step:'preparing'};vm.runInContext('handleRepairLog(payload)',ctx);
    assert.equal(stages.length,5,'foreign or completed-run progress cannot move stages');
    const before=logs.length;
    for(const payload of [null,{}, {line:'x'.repeat(2049)}, {line:5}]) {ctx.payload=payload;vm.runInContext('handleRepairLog(payload)',ctx);}
    assert.equal(logs.length,before);
  });
  console.log('renderer-operation-smoke: all checks passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => clearTimeout(deadline));
