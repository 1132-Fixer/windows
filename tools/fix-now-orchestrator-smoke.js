'use strict';

/**
 * Prove Fix now reaches the complete run-fix orchestrator, not launch-only.
 * Static wiring: renderer click -> electronAPI.runFix -> IPC run-fix.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
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
check(main.includes("Creating account '${FIX_USER}' as a standard user"), 'repair recreates helper as a standard user');
check(main.includes('evaluateLaunchProfile'), 'TEMP-profile launch guard remains in the orchestrator');
check(main.includes('alreadyRunning'), 'Open Zoom skips a duplicate helper Zoom process');

console.log('fix-now-orchestrator-smoke: copy contract');
check(messages.WIZARD.READY_TITLE === 'Ready to fix Zoom', 'ready title');
check(!/Everything looks good/.test(messages.WIZARD.READY_TITLE), 'not a false all-good title');
check(messages.WIZARD.SUCCESS_TITLE === "You're all set", 'success title');
check(messages.WIZARD.FAIL_TITLE === "Couldn't complete the fix", 'failure title');

if (failures) {
  console.error(`fix-now-orchestrator-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('fix-now-orchestrator-smoke: all checks passed');
