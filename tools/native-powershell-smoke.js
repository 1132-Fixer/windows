'use strict';

const assert = require('assert/strict');
const { nativePowerShell7, prepareNativeScript } = require('./native-powershell');
let checks = 0;
const check = (value, name) => { assert.ok(value, name); checks++; };
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
