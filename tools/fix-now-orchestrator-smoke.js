'use strict';

/**
 * Prove Fix now reaches the complete run-fix orchestrator, not launch-only.
 * Static wiring: renderer click -> electronAPI.runFix -> IPC run-fix.
 */

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const nativeSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'helper-reset-windows.js'), 'utf8');
const provisionedSource = fs.readFileSync(path.join(ROOT, 'src', 'main', 'provisioned-helper-flow.js'), 'utf8');
const messages = require('../messages.js');

let failures = 0;
function check(cond, name) {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('fix-now-orchestrator-smoke: primary action');
check(html.includes('id="fixBtn"') && html.includes('Fix now'), 'Fix now button exists');
check(/aria-label="Open Zoom"/.test(html) && />Open Zoom</.test(html), 'Open Zoom label is generic, not user1');
check(!html.includes('Open Zoom as user1'), 'HTML does not ship Open Zoom as user1');
check(html.includes('id="fixConfirmOverlay"'), 'destructive confirmation overlay exists');

console.log('fix-now-orchestrator-smoke: renderer routes Fix now to runFix');
check(renderer.includes('fixBtn.addEventListener(\'click\', onFixButtonClick)'), 'Fix now click is wired');
check(renderer.includes('function onFixButtonClick'), 'onFixButtonClick exists');
check(renderer.includes('showFixConfirm()'), 'Fix now opens confirmation first');
check(/fixConfirmContinue\.addEventListener\('click'[\s\S]*runFix\(\)/.test(renderer), 'Continue starts runFix');
check(renderer.includes('await window.electronAPI.runFix()'), 'runFix invokes electronAPI.runFix');
{
  const start = renderer.indexOf('function onFixButtonClick');
  const next = renderer.indexOf('\nfunction ', start + 1);
  const body = renderer.slice(start, next === -1 ? start + 600 : next);
  check(start !== -1 && !body.includes('launchZoomHelper'), 'Fix now handler does not call launchZoomHelper');
  let confirmations = 0;
  vm.runInNewContext(body + '\nonFixButtonClick();', { isRunning: false, scanInProgress: false, canRunFix: true,
    fixBtn: {}, showFixConfirm: () => { confirmations++; },
    runFix: () => { throw new Error('Fix must await confirmation'); },
    launchZoomHelper: () => { throw new Error('Fix is not a launch shortcut'); } }, { timeout: 1000 });
  check(confirmations === 1, 'actual shipped Fix now handler requests confirmation before repair or launch');
}
check(renderer.includes("showResultPane('ok', WIZARD.READY_TITLE, WIZARD.READY_SUB)"), 'healthy preflight uses READY copy');
check(renderer.includes('setActions({ fix: true, shortcutOption: true, details: true })'), 'healthy preflight exposes Fix now');
check(!renderer.includes("shortcutLabel: shortcutMissing ? 'Create desktop shortcut' : 'Recreate desktop shortcut'"),
  'healthy preflight no longer promotes Recreate desktop shortcut as a competing primary');

console.log('fix-now-orchestrator-smoke: IPC and main orchestrator');
check(preload.includes("ipcRenderer.invoke('run-fix')"), 'preload runFix invokes run-fix');
check(preload.includes("launchZoomHelper: () => ipcRenderer.invoke('launch-zoom-helper')"),
  'launch-zoom-helper stays a separate completion action');
check(main.includes("ipcMain.handle('run-fix'"), 'main registers run-fix');
check(main.includes('async function runFixFlow'), 'complete repair orchestrator is runFixFlow');
check(main.includes("ipcMain.handle('launch-zoom-helper'"), 'launch-zoom-helper remains separate');
// A creation command or UI description cannot prove Standard membership.
// This remains red until the native owner supplies the measured role contract.
const roleFields = ['usersGroupSid', 'usersMembershipVerified', 'administratorsExcluded',
  'groupEnumerationComplete', 'standardAccountVerified', 'membershipProofKind'];
check(/function Assert-StandardAccount\b/.test(nativeSource) && /function Ensure-StandardAccountMembership\b/.test(nativeSource) &&
  nativeSource.includes('NetLocalGroupGetMembers') && nativeSource.includes('S-1-5-32-545') && nativeSource.includes('S-1-5-32-544') &&
  roleFields.every(field => nativeSource.includes(field)) && nativeSource.includes('raw-local-sid'),
  'native repair proves exact SID Users membership and Administrators exclusion with complete raw-SID readback');
check(main.includes('createRepairSession') && provisionedSource.includes('sameProfile(proof.profilePath)') &&
  provisionedSource.includes('sameProfile(proof.registeredPath)') && provisionedSource.includes('proof.registeredSid === operation.accountSid') &&
  provisionedSource.includes('profile.loaded === true') && provisionedSource.includes('profile.special === false') &&
  provisionedSource.includes('profile.ownershipVerified === true') && nativeSource.includes('function Assert-Workflow'),
  'maintained native/session flow guards TEMP, suffixed, foreign and unowned launch profiles');
check(main.includes('alreadyRunning'), 'Open Zoom skips a duplicate helper Zoom process');

console.log('fix-now-orchestrator-smoke: copy contract');
check(messages.WIZARD.READY_TITLE === 'Ready to fix Zoom', 'ready title');
check(messages.WIZARD.READY_SUB.includes('Start Zoom with a fresh setup.'), 'ready description starts the fresh setup');
check(messages.WIZARD.READY_SUB.includes('Your personal files won’t be changed.'), 'ready description does not claim personal files change');
check(!/Everything looks good/.test(messages.WIZARD.READY_TITLE), 'not a false all-good title');
const confirmation = messages.WIZARD.CONFIRM_BODY;
check(confirmation.includes('C:\\Users\\user1') && /permanently deletes/i.test(confirmation) && /all files/i.test(confirmation) &&
  /fresh helper account/i.test(confirmation), 'confirm names exact complete helper profile purge and fresh account replacement');
check(/signed-in Windows account/i.test(confirmation) && /other Windows profiles are preserved/i.test(confirmation),
  'confirm protects the signed-in account and other profile data');
check(/Cancellation stops only at verified safe checkpoints/i.test(confirmation), 'confirm names verified safe cancellation bounds');
check(renderer.includes('body.textContent = WIZARD.CONFIRM_BODY'), 'confirmation renders the approved complete-erasure explanation');
check(messages.WIZARD.SUCCESS_TITLE === 'Complete', 'success title');
check(messages.WIZARD.FAIL_TITLE === "Couldn't complete the fix", 'failure title');

if (failures) {
  console.error(`fix-now-orchestrator-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('fix-now-orchestrator-smoke: all checks passed');
