'use strict';

const fs = require('fs');
const path = require('path');
const { compactStageView } = require('../src/preload/compact-shell');

const ROOT = path.join(__dirname, '..');
const shell = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'compact-shell.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
let failures = 0;
function check(condition, name) {
  if (condition) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
}

console.log('compact-shell-smoke: requested four-state copy');
for (const text of [
  'Checking…',
  'Making sure everything',
  'Ready to fix Zoom',
  'Start Zoom with a fresh setup.',
  'Your personal files won’t be changed.',
  'Fixing Zoom',
  'Getting things ready…',
  'Step ${view.step} of ${FIX_STAGE_COUNT}',
  "You're all set",
  'Zoom is ready to use.',
  'Open Zoom',
  'View details'
]) {
  check(shell.includes(text), `shell covers ${JSON.stringify(text)}`);
}

check(shell.includes("document.getElementById('shortcutOpt')"), 'existing Create desktop shortcut option is retained');
check(shell.includes("aboutBtn.textContent = 'About'"), 'independence disclosure is reachable from About');
check(shell.includes("document.getElementById('btnExplore')"), 'Explore node is still referenced so it can be hidden');
check(/body\.compact-shell-enabled #btnExplore/.test(shell) && /display:\s*none/.test(shell),
  'Explore is hidden from compact production chrome');
check(!shell.includes("footerMeta.appendChild(exploreBtn)"), 'Explore is not placed in the compact footer');
check(shell.includes("document.getElementById('projectDisclosure')") &&
  shell.includes('compactFooter.appendChild(disclosure)'),
  'exact independence disclosure is in the compact footer');
check(!shell.includes("actionArea.appendChild(exploreBtn)"), 'Explore is not placed in the Fix now action area');
check(!shell.includes("setCompactStatus('✓', 'Ready')"), 'ready state does not add a duplicate Ready pill');
check(!/Everything looks good/.test(shell), 'shell never claims everything looks good');
check(shell.includes("appMark.src = 'assets/brand/app-mark.png'"), 'header mark is the canonical gear');
check(shell.includes('topbar.appendChild(appMark)'), 'gear lives in the stable compact-topbar');
check(!shell.includes('compact-brand-slot'), 'gear is not in a state-owned brand slot');
check(!shell.includes('1132-helper-shortcut'), 'helper-shortcut artwork is not the header mark');

console.log('compact-shell-smoke: four-step mapping');
check(compactStageView('prep').step === 1, 'prep -> step 1');
check(compactStageView('verify').step === 2, 'verify -> step 2');
check(compactStageView('consent').step === 3, 'consent -> step 3');
check(compactStageView('launch').step === 4, 'launch -> step 4');
check(compactStageView('receipt').step === 5, 'receipt (verification) is its own step 5');
check(!shell.includes('compact-progress-fill') && !/progressFill\.style\.width/.test(shell), 'no decorative progress bar; the stage tracker is the progress display');
check(!/#wizFixing \.stage-tracker[^{]*\{[^}]*display:\s*none/.test(shell), 'compact shell shows the five-stage tracker while fixing');

console.log('compact-shell-smoke: cancellation is real, not Exit masquerading as Cancel');
check(shell.includes('requestCancel'), 'shell requests cooperative cancellation');
check(!shell.includes("cancelBtn.addEventListener('click', () => exitBtn.click())"), 'Cancel is not wired to the old Exit button');
check(shell.includes('Cancel fix and exit') && shell.includes('Keep running'), 'Exit-during-fix confirmation is present');
check(shell.includes('Finishing the current step safely…'), 'cancelling state explains safe-boundary behavior');
check(shell.includes('Fix cancelled') && shell.includes('Nothing else will be changed.'), 'cancelled terminal state is conclusive');
check(/requestCancel: \(\) => \(api\(\) && api\(\)\.quitApp \? api\(\)\.quitApp\(\)/.test(shell) && preload.includes("quitApp: () => ipcRenderer.invoke('quit-app')"),
  'shell routes cancellation through the brokered quit-app IPC exposed by preload');
check(preload.includes("dataset.fixOutcome = 'running'"), 'preload exposes run outcome to the presentation shell');

console.log('compact-shell-smoke: presentation remains version-agnostic');
check(!/v5\.5\.1/.test(shell + preload), 'example version is not hardcoded');
check(shell.includes("document.getElementById('appVersion')"), 'real app version node is reused');

console.log('compact-shell-smoke: loads as a page script, never through the sandboxed preload');
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const shellTag = html.indexOf('<script src="src/preload/compact-shell.js"></script>');
  const rendererTag = html.indexOf('<script src="renderer.js"></script>');
  check(shellTag > 0, 'index.html loads src/preload/compact-shell.js');
  check(shellTag > 0 && rendererTag > shellTag, 'compact shell script precedes renderer.js');
  check(!/require\(['"]\.\/src\/preload\/compact-shell['"]\)/.test(preload), 'preload.js does not require the compact shell');
  check(/typeof module !== 'undefined'/.test(shell) && /installCompactShell\(\{/.test(shell), 'shell self-installs in the page and exports under Node');
}

if (failures) {
  console.error(`compact-shell-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('compact-shell-smoke: all checks passed');
