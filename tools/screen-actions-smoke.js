'use strict';

// Smoke test for screen-actions.js — the explicit action map. Imports the
// REAL module (browser script with a module.exports guard), so the map
// under test is the map that ships.
//
// Contract under test:
//  - every screen lists only managed controls, and every managed control
//    belongs to at least one screen (no orphan, no unmanaged surprise);
//  - Ready shows exactly Fix now, the shortcut option, View details, Exit;
//  - Open Zoom is allowed only after a completed repair (success) or the
//    renderer's finished-with-attention notice — never on Checking, Ready,
//    Blocked, Fixing, Cancelling, Cancelled or Unable;
//  - Explore is not a managed control at all: it cannot appear on any
//    screen because no screen can allow it;
//  - Cancel fix exists only while work runs; Back only in the Details
//    overlay; Copy error details only on Unable;
//  - applyScreenControls hides what a screen forbids and never reveals.

const path = require('path');
const fs = require('fs');
const sa = require('../screen-actions.js');

let failures = 0;
function check(cond, name) {
  if (cond) { console.log(`  ok  ${name}`); }
  else      { console.error(`FAIL  ${name}`); failures++; }
}
const has = (screen, id, view) => sa.isAllowed(screen, id, view);

console.log('screen-actions-smoke: map shape');
const STATES = ['checking', 'ready', 'blocked', 'fixing', 'cancelling', 'cancelled', 'success', 'error', 'notice'];
for (const s of STATES) check(sa.isScreen(s), `screen '${s}' is defined`);
check(sa.isScreen('details'), 'details overlay is defined');
for (const s of sa.SCREENS) {
  const unknown = sa.SCREEN_CONTROLS[s].filter(id => sa.MANAGED_CONTROLS.indexOf(id) === -1);
  check(unknown.length === 0, `screen '${s}' lists only managed controls${unknown.length ? ' (unmanaged: ' + unknown.join(', ') + ')' : ''}`);
}
for (const id of sa.MANAGED_CONTROLS) {
  const owners = sa.SCREENS.filter(s => sa.SCREEN_CONTROLS[s].indexOf(id) !== -1);
  check(owners.length > 0, `control '${id}' belongs to at least one screen`);
}
check(sa.MANAGED_CONTROLS.indexOf('btnExplore') === -1, 'Explore is not a managed control (no screen can show it)');
check(sa.SCREENS.every(s => !has(s, 'btnExplore')), 'Explore is allowed on no screen');

console.log('screen-actions-smoke: Ready screen');
const READY = sa.allowedControls('ready').slice().sort().join(',');
check(READY === ['btnExit', 'detailsBtn', 'fixBtn', 'shortcutOpt'].sort().join(','),
  `Ready allows exactly Exit, Fix now, shortcut option, View details (got ${READY})`);
for (const id of ['launchBtn', 'cancelFixBtn', 'doneBtn', 'rescanBtn', 'closeBtn', 'supportBtn', 'copyErrBtn', 'elevateBtn', 'shortcutBtn', 'backBtn']) {
  check(!has('ready', id), `Ready does not allow ${id}`);
}

console.log('screen-actions-smoke: Open Zoom only after verified success');
for (const s of ['checking', 'ready', 'blocked', 'fixing', 'cancelling', 'cancelled', 'error']) {
  check(!has(s, 'launchBtn'), `${s} does not allow Open Zoom`);
}
check(has('success', 'launchBtn'), 'success allows Open Zoom');

console.log('screen-actions-smoke: state-specific controls stay in their state');
check(has('fixing', 'cancelFixBtn') && has('cancelling', 'cancelFixBtn'), 'Cancel fix is allowed while work runs');
for (const s of STATES.filter(s => s !== 'fixing' && s !== 'cancelling')) check(!has(s, 'cancelFixBtn'), `${s} does not allow Cancel fix`);
check(has('success', 'doneBtn'), 'Done is allowed on success');
check(has('success', 'productsBtn'), 'Explore Our Products is allowed on success');
for (const s of STATES.filter(s => s !== 'success')) check(!has(s, 'productsBtn'), `${s} does not show Explore Our Products`);
check(sa.SCREEN_CONTROLS.details.indexOf('productsBtn') === -1, 'the Details overlay does not add the products control');
for (const s of STATES.filter(s => s !== 'success')) check(!has(s, 'doneBtn'), `${s} does not allow Done`);
check(has('error', 'copyErrBtn'), 'Unable allows Copy error details');
for (const s of STATES.filter(s => s !== 'error')) check(!has(s, 'copyErrBtn'), `${s} does not allow Copy error details`);
for (const s of STATES) check(!has(s, 'backBtn'), `${s} does not allow Back without the Details overlay`);
check(has('ready', 'backBtn', 'details'), 'Details overlay on Ready allows Back');
check(has('ready', 'btnExit', 'details'), 'Details overlay keeps Exit');
check(!has('ready', 'launchBtn', 'details'), 'Details overlay does not add Open Zoom');
for (const s of STATES) check(!has(s, 'fixBtn') || s !== 'checking', `${s}: Fix now hidden while checking`);
check(!has('checking', 'fixBtn') && !has('checking', 'detailsBtn'), 'Checking allows Exit only');
check(!has('blocked', 'fixBtn'), 'Blocked never offers Fix now');
check(has('blocked', 'elevateBtn') && has('blocked', 'zrDownloadBtn'), 'Blocked allows the elevation and Zoom recovery path');
check(has('error', 'fixBtn') && has('error', 'supportBtn'), 'Unable allows Try again and Support Report');

console.log('screen-actions-smoke: applyScreenControls hides, never reveals');
{
  const els = {};
  for (const id of sa.MANAGED_CONTROLS) els[id] = { id, hidden: false };
  els.fixBtn.hidden = true;
  const doc = { getElementById: (id) => els[id] || null };
  const hid = sa.applyScreenControls('ready', doc);
  check(hid.indexOf('launchBtn') !== -1 && hid.indexOf('cancelFixBtn') !== -1 && hid.indexOf('backBtn') !== -1,
    'forbidden controls are hidden on Ready');
  check(els.fixBtn.hidden === true, 'an allowed control the renderer hid stays hidden (gate never reveals)');
  check(els.shortcutOpt.hidden === false && els.detailsBtn.hidden === false && els.btnExit.hidden === false,
    'allowed visible controls stay visible');
  const again = sa.applyScreenControls('ready', doc);
  check(again.length === 0, 'second pass changes nothing (idempotent)');
  for (const id of sa.MANAGED_CONTROLS) els[id].hidden = false;
  sa.applyScreenControls('ready', doc, 'details');
  check(els.backBtn.hidden === false && els.detailsOverviewBtn.hidden === false, 'Details overlay keeps Back and Back to details');
  check(els.launchBtn.hidden === true && els.cancelFixBtn.hidden === true, 'Details overlay still hides other-state controls');
  for (const id of sa.MANAGED_CONTROLS) els[id].hidden = false;
  sa.applyScreenControls('not-a-screen', doc);
  check(els.fixBtn.hidden === true && els.btnExit.hidden === false, 'an unknown screen falls back to the Checking allowlist (Exit only)');
}

console.log('screen-actions-smoke: page wiring');
{
  const ROOT = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const shell = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'compact-shell.js'), 'utf8');
  for (const id of sa.MANAGED_CONTROLS) {
    check(html.includes(`id="${id}"`), `index.html defines #${id}`);
  }
  const scriptOrder = ['screen-actions.js', 'details-view.js', 'src/preload/compact-shell.js', 'renderer.js']
    .map(f => html.indexOf(`<script src="${f}"></script>`));
  check(scriptOrder.every((i, n) => i > 0 && (n === 0 || i > scriptOrder[n - 1])),
    'screen-actions.js loads before the compact shell and renderer');
  check(shell.includes('applyGate(state, document, view)'), 'compact shell applies the gate after every sync');
  check(!/#btnExplore/.test(shell), 'compact shell no longer hides Explore with CSS (Explore is not on any screen)');
  check(!/display:\s*none\s*!important/.test(shell), 'compact shell hides nothing with !important CSS');
  // Explore lives inside the About dialog and nowhere else.
  const explorePos = html.indexOf('id="btnExplore"');
  const aboutStart = html.indexOf('id="aboutOverlay"');
  const aboutEnd = html.indexOf('id="fixConfirmOverlay"');
  check(explorePos > aboutStart && explorePos < aboutEnd, 'Explore control is inside the About dialog');
  check((html.match(/id="btnExplore"/g) || []).length === 1, 'exactly one Explore control');
  check(!html.includes('id="btnMinimize"') && !html.includes('id="btnMaximize"'), 'no dead window controls in the header');
  check(!html.includes('id="advPanel"') && !html.includes('id="checkList"') && !html.includes('id="fileList"'),
    'the nested scrolling details panel is gone');
}

if (failures) {
  console.error(`screen-actions-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('screen-actions-smoke: all checks passed');
