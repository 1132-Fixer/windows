'use strict';

const assert = require('assert/strict');
const { PS_STDIN_ARGS } = require('../src/main/windows-tools');
const { NATIVE_PS_STDIN_ARGS, nativePowerShell7, prepareNativeScript } = require('./native-powershell');
let checks = 0;
const check = (value, name) => { assert.ok(value, name); checks++; };
check(Object.isFrozen(NATIVE_PS_STDIN_ARGS), 'native process arguments cannot drift after import');
assert.deepEqual(NATIVE_PS_STDIN_ARGS.slice(0, -1), ['-NoProfile', '-NonInteractive', '-Command']); checks++;
check(!NATIVE_PS_STDIN_ARGS.some(value => /executionpolicy|bypass/i.test(value)),
  'native verification never relaxes execution policy');
check(NATIVE_PS_STDIN_ARGS.at(-1) === PS_STDIN_ARGS.at(-1) &&
  NATIVE_PS_STDIN_ARGS.at(-1).includes('[Console]::In.ReadToEnd()'),
  'native verification retains the production fixed UTF-8 stdin parser');
let observed = '';
check(nativePowerShell7({ systemRoot: 'D:\\Windows', existsSync: value => { observed = value; return true; } }) ===
  'D:\\Program Files\\PowerShell\\7\\pwsh.exe', 'native test path follows verified Windows volume');
check(observed.endsWith('\\PowerShell\\7\\pwsh.exe'), 'test driver selects PowerShell 7 explicitly');
for (const systemRoot of [null, '', 'Windows', '\\\\host\\Windows', 'C:\\..\\Windows', 'C:\\Windows\n']) {
  assert.throws(() => nativePowerShell7({ systemRoot, existsSync: () => true })); checks++;
}
assert.throws(() => nativePowerShell7({ systemRoot: 'C:\\Windows', existsSync: () => false }), /No Windows PowerShell fallback/); checks++;
const script = prepareNativeScript("Write-Output 'fixture'");
check(script.includes('$PSVersionTable.PSVersion.Major -lt 7') && script.includes("$PSVersionTable.PSEdition -ne 'Core'"),
  'native payload refuses the wrong PowerShell version and edition');
check(script.indexOf('$PSVersionTable.PSVersion.Major -lt 7') < script.indexOf("Write-Output 'fixture'"),
  'version check runs before the native fixture');
console.log(`native-powershell-smoke: ${checks} checks passed`);
