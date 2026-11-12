'use strict';

// Execute production code with inert COM inspection; only owned Temp files.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { shortcutMatchesCurrentApp } = require('../src/main/shortcut-ownership');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const start = main.indexOf('async function removeLegacyShortcuts()');
const end = main.indexOf('\n}', start);
assert.ok(start >= 0 && end > start);
const source = main.slice(start, end + 2);
const expectedScript = 'C:\\Users\\operator\\AppData\\Roaming\\1132 Fixer\\launch-zoom-as-user1.ps1';
const expectedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const owned = {
  target: expectedPowerShell,
  arguments: `-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${expectedScript}"`
};
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };

(async () => {
  check(shortcutMatchesCurrentApp(owned, expectedScript, expectedPowerShell), 'exact generated shortcut is owned');
  check(shortcutMatchesCurrentApp({ ...owned, target: expectedPowerShell.toUpperCase() }, expectedScript, expectedPowerShell), 'Windows path casing is accepted');
  for (const info of [
    null, {}, { ...owned, target: 'powershell.exe' },
    { ...owned, target: 'C:\\Users\\operator\\powershell.exe' },
    { ...owned, arguments: owned.arguments.replace('.ps1"', '.ps1.other"') },
    { ...owned, arguments: owned.arguments + ' -Command bad' },
    { ...owned, arguments: `-Command "Write-Output '${expectedScript}'"` },
    { ...owned, arguments: owned.arguments.replace('operator', 'other-user') },
    { ...owned, arguments: owned.arguments + '\r\n' }
  ]) check(!shortcutMatchesCurrentApp(info, expectedScript, expectedPowerShell), 'ambiguous or unrelated shortcut is not owned');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), '1132-shortcut-'));
  try {
    const legacy = path.join(root, 'Launch Zoom as user1.lnk');
    const near = path.join(root, 'Launch Zoom as user1 - Copy.lnk');
    const current = path.join(root, 'Zoom - User1.lnk');
    fs.writeFileSync(near, 'bystander');
    fs.writeFileSync(current, 'new shortcut');
    async function cleanup(info, mutate = () => {}, adapters = fs) {
      fs.writeFileSync(legacy, 'legacy shortcut');
      const context = {
        fs: adapters,
        findLegacyShortcuts: async () => [{ path: legacy }],
        inspectShortcuts: async () => { mutate(); return info ? { [legacy]: info } : {}; },
        LAUNCHER_SCRIPT_PATH: () => expectedScript,
        shortcutMatchesCurrentApp: (item, script) => shortcutMatchesCurrentApp(item, script, expectedPowerShell)
      };
      vm.runInNewContext(source + '\nthis.cleanup = removeLegacyShortcuts;', context);
      return context.cleanup();
    }
    let receipt = await cleanup(owned);
    check(receipt.removed.length === 1 && !fs.existsSync(legacy), 'proved legacy shortcut is removed');
    check(fs.existsSync(current) && fs.readFileSync(near, 'utf8') === 'bystander', 'new and near-match shortcuts survive');
    for (const info of [null, { ...owned, target: 'C:\\Other\\powershell.exe' }]) {
      receipt = await cleanup(info);
      check(receipt.removed.length === 0 && receipt.failed.length === 1 && fs.existsSync(legacy), 'unknown or unrelated same-name shortcut survives');
    }
    receipt = await cleanup(owned, () => fs.writeFileSync(legacy, 'replaced during COM inspection'));
    check(receipt.removed.length === 0 && receipt.failed.length === 1 && fs.existsSync(legacy), 'changed shortcut survives');
    receipt = await cleanup(owned, undefined, { ...fs, unlinkSync() { throw new Error('sharing fixture'); } });
    check(receipt.removed.length === 0 && receipt.failed.length === 1 && fs.existsSync(legacy), 'cleanup error is reported without throwing');
    receipt = await cleanup(owned, undefined, { ...fs, lstatSync() { throw new Error('identity fixture'); } });
    check(receipt.removed.length === 0 && receipt.failed.length === 1 && fs.existsSync(legacy), 'missing identity cannot authorize deletion');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(`shortcut-legacy-smoke: ${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
