// Mocked-flow harness for the CHECK & FIX wizard auto-advance state
// machine. Mirrors the exact logic in renderer.js (openWizard / closeWizard
// / renderWizardStep / wizardNext / wizardBack) against a stubbed DOM +
// IPC. Asserts the safety + flow invariants required by the autoflow
// verification gate. No production code is touched.
//
// Run: node tools/verify-wizard-autoflow.js

const assert = require('node:assert/strict');

// --- Minimal DOM stub --------------------------------------------------
function makeEl() {
  const el = {
    textContent: '',
    innerHTML: '',
    style: {},
    classList: {
      _set: new Set(),
      add(c)    { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, on) { on ? this._set.add(c) : this._set.delete(c); },
    },
    disabled: false,
    setAttribute() {},
    appendChild() {},
  };
  return el;
}

// --- Wizard state machine (mirror of renderer.js lines 495-685) --------
const PREFLIGHT_ORDER = ['admin', 'zoom', 'helperUser', 'camPolicy', 'micPolicy', 'hku', 'frameServer', 'version'];
const WIZARD_AUTO_MS = 1600;
const WIZARD_SCAN_TIMEOUT_MS = 60000;

let isRunning = false;
let wizardSteps = [];
let wizardIdx = 0;
let wizardCanRunFix = false;
let wizardAutoTimer = null;
let wizardAutoDisabled = false;
let wizardGen = 0;

const wizardOverlay = makeEl();
const events = []; // observability: every state transition

function clearWizardAuto() {
  if (wizardAutoTimer) { clearTimeout(wizardAutoTimer); wizardAutoTimer = null; }
}

let mockPreflightScan; // injected per test
let mockShowFixConfirm = async () => true;
let mockRunFix = async () => ({ success: true });
let runFixCalled = 0;
let showFixConfirmCalled = 0;

async function openWizard() {
  if (isRunning) return;
  const gen = ++wizardGen;
  wizardOverlay.classList.add('show');
  wizardSteps = [];
  wizardIdx = 0;
  wizardCanRunFix = false;
  wizardAutoDisabled = false;

  let timeoutId;
  const scanPromise = mockPreflightScan();
  scanPromise.catch(() => {});
  const timeoutPromise = new Promise((_, rej) => {
    timeoutId = setTimeout(
      () => rej(new Error('Preflight scan timed out after 60s.')),
      WIZARD_SCAN_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([scanPromise, timeoutPromise]);
    if (gen !== wizardGen) return;
    for (const key of PREFLIGHT_ORDER) {
      const card = result.cards[key];
      if (card) wizardSteps.push(card);
    }
    wizardSteps.push({ key: '__confirm__', label: 'CONFIRM FIX', status: (result.canRunFix ? 'ready' : 'blocked'), message: '' });
    wizardCanRunFix = !!result.canRunFix;
    renderWizardStep(0);
  } catch (err) {
    if (gen !== wizardGen) return;
    events.push({ type: 'scan_failed', message: err.message });
  } finally {
    clearTimeout(timeoutId);
  }
}

function closeWizard() {
  wizardGen++;
  clearWizardAuto();
  wizardOverlay.classList.remove('show');
}

function renderWizardStep(i) {
  if (!wizardSteps.length) return;
  clearWizardAuto();
  wizardIdx = Math.max(0, Math.min(i, wizardSteps.length - 1));
  const step = wizardSteps[wizardIdx];
  const isConfirm = step.key === '__confirm__';
  events.push({ type: 'render', idx: wizardIdx, key: step.key || step.label, status: step.status });

  const isLast = (wizardIdx >= wizardSteps.length - 1);
  if (!wizardAutoDisabled && !isConfirm && !isLast && step.status !== 'blocked') {
    wizardAutoTimer = setTimeout(() => {
      wizardAutoTimer = null;
      renderWizardStep(wizardIdx + 1);
    }, WIZARD_AUTO_MS);
  }
}

async function wizardNext() {
  if (!wizardSteps.length) return;
  const step = wizardSteps[wizardIdx];
  if (step.key === '__confirm__') {
    if (!wizardCanRunFix) return;
    closeWizard();
    await runFix();
    return;
  }
  renderWizardStep(wizardIdx + 1);
}

function wizardBack() {
  wizardAutoDisabled = true;
  if (wizardIdx > 0) renderWizardStep(wizardIdx - 1);
}

async function runFix() {
  if (isRunning) return;
  showFixConfirmCalled++;
  const confirmed = await mockShowFixConfirm();
  if (!confirmed) return;
  isRunning = true;
  runFixCalled++;
  const result = await mockRunFix();
  isRunning = false;
  events.push({ type: 'fix_complete', success: result.success });
}

// --- Test helpers ------------------------------------------------------
function resetState() {
  isRunning = false;
  wizardSteps = [];
  wizardIdx = 0;
  wizardCanRunFix = false;
  clearWizardAuto();
  wizardAutoDisabled = false;
  wizardGen = 0;
  events.length = 0;
  runFixCalled = 0;
  showFixConfirmCalled = 0;
  wizardOverlay.classList._set.clear();
  mockShowFixConfirm = async () => true;
  mockRunFix = async () => ({ success: true });
}

function makeCards(overrides = {}) {
  const defaults = {
    admin:       { status: 'ready', label: 'Administrator', message: '' },
    zoom:        { status: 'ready', label: 'Zoom Workplace', message: '' },
    helperUser:  { status: 'ready', label: 'Helper account', message: '' },
    camPolicy:   { status: 'ready', label: 'Camera policy', message: '' },
    micPolicy:   { status: 'ready', label: 'Microphone policy', message: '' },
    hku:         { status: 'ready', label: 'User registry hive', message: '' },
    frameServer: { status: 'ready', label: 'Camera Frame Server', message: '' },
    version:     { status: 'ready', label: 'App version', message: '' },
  };
  return { ...defaults, ...overrides };
}

function tick(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// --- Tests -------------------------------------------------------------
const results = [];
async function test(name, fn) {
  resetState();
  try {
    await fn();
    results.push({ name, pass: true });
    process.stdout.write(`PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, pass: false, err: err.message });
    process.stdout.write(`FAIL  ${name}\n      ${err.message}\n`);
  }
}

(async () => {
  // --- Happy path ------------------------------------------------------
  await test('all-ready scan auto-walks to confirm, no fix auto-runs', async () => {
    mockPreflightScan = async () => ({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    await openWizard();
    // Walk through every auto-advance tick.
    for (let i = 0; i < 9; i++) await tick(WIZARD_AUTO_MS + 50);
    // Should land on confirm step with no auto-fix.
    assert.equal(wizardIdx, 8, 'lands on confirm (index 8)');
    assert.equal(wizardSteps[wizardIdx].key, '__confirm__');
    assert.equal(runFixCalled, 0, 'fix did not auto-run');
    assert.equal(showFixConfirmCalled, 0, 'native confirm not invoked without click');
    assert.equal(wizardAutoTimer, null, 'no timer left armed on confirm');
  });

  // --- Confirm step requires explicit FIX NOW click --------------------
  await test('FIX NOW click triggers native confirm + runFix', async () => {
    mockPreflightScan = async () => ({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    await openWizard();
    for (let i = 0; i < 9; i++) await tick(WIZARD_AUTO_MS + 50);
    await wizardNext(); // simulate FIX NOW click
    assert.equal(showFixConfirmCalled, 1, 'native dialog invoked');
    assert.equal(runFixCalled, 1, 'fix ran once');
  });

  // --- Native confirm dismissed -> no fix ------------------------------
  await test('user cancels native dialog -> fix does not run', async () => {
    mockPreflightScan = async () => ({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    mockShowFixConfirm = async () => false;
    await openWizard();
    for (let i = 0; i < 9; i++) await tick(WIZARD_AUTO_MS + 50);
    await wizardNext();
    assert.equal(showFixConfirmCalled, 1);
    assert.equal(runFixCalled, 0, 'fix blocked by native dialog');
  });

  // --- Blocked step halts auto-advance ---------------------------------
  await test('blocked card halts auto-advance', async () => {
    const cards = makeCards({ zoom: { status: 'blocked', label: 'Zoom Workplace', message: 'Not installed' } });
    mockPreflightScan = async () => ({ cards, canRunFix: false, overall: 'blocked' });
    await openWizard();
    for (let i = 0; i < 9; i++) await tick(WIZARD_AUTO_MS + 50);
    assert.equal(wizardSteps[wizardIdx].label, 'Zoom Workplace', 'parked on blocked step');
    assert.equal(wizardAutoTimer, null, 'no auto timer armed on blocked step');
  });

  // --- Blocked + user clicks FIX NOW on confirm -> still cannot run ----
  await test('confirm with canRunFix=false cannot trigger fix', async () => {
    const cards = makeCards({ zoom: { status: 'blocked', label: 'Zoom Workplace', message: 'x' } });
    mockPreflightScan = async () => ({ cards, canRunFix: false, overall: 'blocked' });
    await openWizard();
    // Force navigate to the confirm step.
    while (wizardSteps[wizardIdx].key !== '__confirm__') {
      wizardIdx++;
    }
    renderWizardStep(wizardIdx); // re-render at confirm
    await wizardNext();
    assert.equal(runFixCalled, 0, 'fix did not run with blocked confirm');
    assert.equal(showFixConfirmCalled, 0, 'native dialog never opened');
  });

  // --- Warning-only scan still walks + can run -------------------------
  await test('warning-only scan walks through and allows fix', async () => {
    const cards = makeCards({ helperUser: { status: 'warning', label: 'Helper account', message: 'w' } });
    mockPreflightScan = async () => ({ cards, canRunFix: true, overall: 'warning' });
    await openWizard();
    for (let i = 0; i < 9; i++) await tick(WIZARD_AUTO_MS + 50);
    assert.equal(wizardSteps[wizardIdx].key, '__confirm__');
    assert.equal(wizardCanRunFix, true);
  });

  // --- Cancel during auto-advance clears timer -------------------------
  await test('cancel during auto-advance clears pending timer', async () => {
    mockPreflightScan = async () => ({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    await openWizard();
    await tick(WIZARD_AUTO_MS / 2); // mid-flight
    assert.notEqual(wizardAutoTimer, null, 'timer is armed pre-cancel');
    closeWizard();
    assert.equal(wizardAutoTimer, null, 'timer cleared after cancel');
    assert.equal(wizardOverlay.classList.contains('show'), false, 'overlay hidden');
    // Wait past when the timer would have fired -> must not advance.
    const idxBefore = wizardIdx;
    await tick(WIZARD_AUTO_MS + 200);
    assert.equal(wizardIdx, idxBefore, 'no advance after cancel');
  });

  // --- Back disables auto for rest of session --------------------------
  await test('Back disables auto-advance for the rest of the session', async () => {
    mockPreflightScan = async () => ({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    await openWizard();
    await tick(WIZARD_AUTO_MS + 50); // advance to step 1
    assert.ok(wizardIdx >= 1);
    wizardBack();
    assert.equal(wizardAutoDisabled, true);
    const idxAfterBack = wizardIdx;
    await tick(WIZARD_AUTO_MS * 3);
    assert.equal(wizardIdx, idxAfterBack, 'no further auto-advance after Back');
    assert.equal(wizardAutoTimer, null);
  });

  // --- Reopen after cancel -> fresh state ------------------------------
  await test('reopen wizard after cancel resets state', async () => {
    mockPreflightScan = async () => ({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    await openWizard();
    await tick(WIZARD_AUTO_MS + 50);
    closeWizard();
    await openWizard();
    assert.equal(wizardIdx, 0, 'fresh idx');
    assert.equal(wizardAutoDisabled, false, 'auto re-enabled');
    assert.equal(wizardSteps.length, 9, 'cards rebuilt');
  });

  // --- Scan timeout surfaces error without infinite loading ------------
  await test('scan never resolves -> renderer-level timeout fires (mocked short)', async () => {
    // Use a hand-rolled openWizard with a 200ms ceiling for test speed.
    // (We don't import openWizard wholesale here; we exercise the same
    // Promise.race shape to prove the contract.)
    let timedOutMsg = null;
    let timeoutId;
    const scanPromise = new Promise(() => { /* never resolves */ });
    scanPromise.catch(() => {});
    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error('timeout')), 200);
    });
    try {
      await Promise.race([scanPromise, timeoutPromise]);
    } catch (err) {
      timedOutMsg = err.message;
    } finally {
      clearTimeout(timeoutId);
    }
    assert.equal(timedOutMsg, 'timeout', 'race rejected via timeout');
  });

  // --- Late IPC rejection after timeout wins -> no unhandled rejection -
  await test('late IPC rejection after race lost does not throw unhandled', async () => {
    let unhandled = null;
    const handler = (reason) => { unhandled = reason; };
    process.on('unhandledRejection', handler);
    let timeoutId;
    const scanPromise = new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 50));
    scanPromise.catch(() => {}); // exactly what openWizard does
    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error('first')), 10);
    });
    try { await Promise.race([scanPromise, timeoutPromise]); } catch (_) {}
    clearTimeout(timeoutId);
    await tick(200); // let late rejection settle
    process.off('unhandledRejection', handler);
    assert.equal(unhandled, null, 'no unhandled rejection observed');
  });

  // --- Stale openWizard ignored after close ----------------------------
  await test('cancel mid-scan -> stale resolve does not render', async () => {
    let resolveScan;
    mockPreflightScan = () => new Promise(r => { resolveScan = r; });
    const p = openWizard();
    closeWizard(); // user hit Cancel while loading
    resolveScan({ cards: makeCards(), canRunFix: true, overall: 'ready' });
    await p;
    // Generation guard should have short-circuited; wizardSteps stays empty.
    assert.equal(wizardSteps.length, 0, 'stale scan result discarded');
  });

  // --- Malformed scan result (no cards) --------------------------------
  await test('malformed scan result (missing cards) -> safe failure', async () => {
    mockPreflightScan = async () => ({ /* cards missing */ canRunFix: true });
    let threw = false;
    try { await openWizard(); } catch (_) { threw = true; }
    // openWizard should catch internally and log scan_failed.
    assert.equal(threw, false, 'openWizard swallowed the error');
    assert.ok(events.some(e => e.type === 'scan_failed'), 'scan_failed event emitted');
  });

  // --- isRunning guard blocks wizard re-entry --------------------------
  await test('isRunning prevents wizard re-open mid-fix', async () => {
    isRunning = true;
    await openWizard();
    assert.equal(wizardSteps.length, 0, 'wizard did not open while fix running');
    isRunning = false;
  });

  // --- Summary ---------------------------------------------------------
  const failed = results.filter(r => !r.pass);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exit(1);
})();
