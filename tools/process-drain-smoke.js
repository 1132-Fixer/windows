'use strict';

// Production drain scripts with synthetic CIM records and a termination adapter.
// No real process stop, account, profile, service, registry, or ACL operation runs.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { NATIVE_PS_STDIN_ARGS, nativePowerShell7, prepareNativeScript } = require('./native-powershell');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const sid = 'S-1-5-21-100-200-300-1001';
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }
const start = main.indexOf('const PS_NON_USER_PROCESS_GUARD =');
const stopStart = main.indexOf('const PS_EXACT_SID_PROCESS_STOP_HELPER =');
const end = main.indexOf('// Check whether the exact local-account SID', stopStart);
check(stopStart > 0 && end > stopStart, 'production process drain definitions are present');
const definitions = main.slice(start >= 0 ? start : stopStart, end);
const production = vm.runInNewContext(definitions + '\n({ exactSidFinalDrainScript, PS_EXACT_SID_PROCESS_STOP_HELPER })');
const initialStart = main.indexOf('const drain = await runPSCapture(');
const initialOpen = main.indexOf('`', initialStart);
const initialEnd = main.indexOf('`, { timeoutMs: 90000 });', initialOpen);
check(initialStart > 0 && initialEnd > initialOpen, 'production initial drain is present');
const initial = vm.runInNewContext(main.slice(initialOpen, initialEnd + 1), {
  preDeleteSid: sid, PS_EXACT_SID_PROCESS_STOP_HELPER: production.PS_EXACT_SID_PROCESS_STOP_HELPER
});
check(initial.includes('AddSeconds(60)') && production.exactSidFinalDrainScript(sid).includes('AddSeconds(60)') &&
  main.includes('exactSidFinalDrainScript(preDeleteSid), { timeoutMs: 90000 }'),
  'both full inventories retain a 60 second poll deadline and a 90 second outer capture bound');

if (process.platform !== 'win32') {
  console.log(`process-drain-smoke: ${checks} source checks passed; native fixtures not run (non-Windows host)`);
  process.exit(0);
}

const host = nativePowerShell7();
const creation = "[datetime]'2026-11-11T23:40:53.588037Z'";
const idle = `[pscustomobject]@{ ProcessId=0; ParentProcessId=0; SessionId=0; Name='System Idle Process'; ExecutablePath=$null; CreationDate=${creation} }`;
const system = `[pscustomobject]@{ ProcessId=4; ParentProcessId=0; SessionId=0; Name='System'; ExecutablePath=$null; CreationDate=${creation} }`;
const ordinary = `[pscustomobject]@{ ProcessId=640; ParentProcessId=400; SessionId=1; Name='fixture.exe'; ExecutablePath='C:\\fixture.exe'; CreationDate=${creation} }`;
function execute(script) {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const diagnosticScript = String.raw`
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$tokens=$null; $errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if ($errors.Count -gt 0) { Write-Output ('FIXTURE_PARSE_ERROR=' + ($errors.Message -join '; ')); exit 96 }
try { & ([scriptblock]::Create($source)) }
catch { Write-Output ('FIXTURE_FAILURE=' + $_.Exception.Message + '; line=' + $_.InvocationInfo.ScriptLineNumber); exit 97 }
`;
  const result = spawnSync(host, [...NATIVE_PS_STDIN_ARGS], {
    input: prepareNativeScript(diagnosticScript), encoding: 'utf8', windowsHide: true, timeout: 20000
  });
  if (result.error) throw result.error;
  assert.equal(String(result.stderr || '').trim(), '', 'fixture has no unhandled PowerShell errors');
  return { status: result.status, lines: String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean) };
}
function drain(kind, inventory, ownerBody, expected, options = {}) {
  const fixture = String.raw`
$ErrorActionPreference='Stop'
$script:scans=0; $script:stops=0; $script:owners=0
function Get-CimInstance {
  [CmdletBinding()]param([Parameter(Position=0)][string]$ClassName,[string]$Filter)
  if ($ClassName -cne 'Win32_Process' -or $Filter) { throw 'unexpected fixture query' }
  $script:scans++
  ${options.clearAfterStop ? 'if ($script:stops -gt 0) { return @() }' : ''}
  ${inventory}
}
function Invoke-CimMethod {
  [CmdletBinding()]param([object]$InputObject,[string]$MethodName)
  if ($MethodName -cne 'GetOwnerSid') { throw 'unexpected fixture method' }
  $script:owners++
  ${ownerBody}
}
function Assert-FixtureResult {
  if ($script:stops -ne ${options.stops || 0}) { throw 'fixture termination count mismatch' }
  if ($script:owners -ne ${options.owners || 0}) { throw 'fixture owner lookup count mismatch' }
}
`;
  const stopAdapter = String.raw`
function Stop-FixerOwnedProcessBySid {
  [CmdletBinding()]param($Candidate,[string]$ExpectedSid)
  if ($ExpectedSid -cne '${sid}' -or [int]$Candidate.ProcessId -ne 640) { throw 'wrong fixture termination target' }
  $script:stops++
  ${options.stopFailure ? "throw 'fixture termination unproved'" : "return 'TERMINATED'"}
}
`;
  let script = kind === 'INITIAL' ? initial.replace(production.PS_EXACT_SID_PROCESS_STOP_HELPER,
    () => production.PS_EXACT_SID_PROCESS_STOP_HELPER + stopAdapter) : production.exactSidFinalDrainScript(sid);
  // Assert adapter calls before the production receipt and exit, without changing its decision.
  script = script.replace("    Write-Output ('FIXER_HELPER_", "    Assert-FixtureResult\n    Write-Output ('FIXER_HELPER_");
  const result = execute(fixture + script);
  check(result.status === (expected === 'CLEAR' ? 0 : 1) &&
    result.lines.length === 1 && result.lines[0] === `FIXER_HELPER_${kind}_DRAIN_V1=${expected}`,
  `${kind}: ${options.label || expected}: ${JSON.stringify(result)}`);
}

// This case reproduced the elevated-host blocker before the guard was added.
for (const kind of ['FINAL', 'INITIAL']) drain(kind, `${idle}; ${system}`, "throw 'kernel owner lookup must not run'", 'CLEAR',
  { label: 'documented kernel records need no user owner lookup' });

check(start >= 0, 'one shared non-user process guard serves both drains');
const predicate = vm.runInNewContext(definitions + '\nPS_NON_USER_PROCESS_GUARD');
const predicateCases = execute(String.raw`
$ErrorActionPreference='Stop'
${predicate}
$idle=${idle}; $system=${system}; $ordinary=${ordinary}
$checks=0
foreach ($record in @($idle,$system)) {
  if (-not (Test-FixerNonUserProcess -Candidate $record)) { throw 'kernel record was not recognized' }; $checks++
}
foreach ($record in @(
  $null, [pscustomobject]@{}, $ordinary,
  [pscustomobject]@{ProcessId=$null;ParentProcessId=0;SessionId=0;Name='System Idle Process';CreationDate=${creation}},
  [pscustomobject]@{ProcessId=8;ParentProcessId=0;SessionId=0;Name='System';CreationDate=${creation}},
  [pscustomobject]@{ProcessId=4;ParentProcessId=1;SessionId=0;Name='System';CreationDate=${creation}},
  [pscustomobject]@{ProcessId=4;ParentProcessId=0;SessionId=1;Name='System';CreationDate=${creation}},
  [pscustomobject]@{ProcessId=4;ParentProcessId=0;SessionId=0;Name='csrss.exe';CreationDate=${creation}},
  [pscustomobject]@{ProcessId=4;ParentProcessId=0;SessionId=0;Name='System';CreationDate=$null},
  [pscustomobject]@{ProcessId=4;ParentProcessId=0;SessionId=0;Name='System';CreationDate='not-a-date'},
  [pscustomobject]@{ProcessId=4;ParentProcessId=0;SessionId=0;Name='System';CreationDate=${creation};ExecutablePath='C:\fixture.exe'},
  [pscustomobject]@{ProcessId=640;ParentProcessId=0;SessionId=0;Name='csrss.exe';CreationDate=${creation}}
)) {
  if (Test-FixerNonUserProcess -Candidate $record) { throw 'unproved process was exempted' }; $checks++
}
Write-Output ('PREDICATE_CASES=' + $checks)
`);
check(predicateCases.status === 0 && predicateCases.lines[0] === 'PREDICATE_CASES=14',
  'missing, malformed, lookalike and protected user-process records remain unproved');

for (const kind of ['INITIAL', 'FINAL']) {
  drain(kind, `${system}; ${ordinary}`, "return [pscustomobject]@{ReturnValue=2;Sid=$null}", 'UNKNOWN',
    { owners: 1, label: 'arbitrary access denied blocks despite valid kernel records' });
  drain(kind, `${ordinary}`, "throw 'fixture owner unavailable'", 'UNKNOWN',
    { owners: 1, label: 'owner exceptions remain blocked' });
  drain(kind, "throw 'fixture inventory unavailable'", "throw 'must not run'", 'UNKNOWN',
    { label: 'enumeration errors remain blocked' });
  drain(kind, `${ordinary}`, "return [pscustomobject]@{ReturnValue=0;Sid='S-1-5-21-900-800-700-1001'}", 'CLEAR',
    { owners: 1, label: 'different or domain SID is never the local helper' });
}
drain('INITIAL', `${ordinary}`, `return [pscustomobject]@{ReturnValue=0;Sid='${sid}'}`, 'CLEAR',
  { owners: 1, stops: 1, clearAfterStop: true, label: 'only an exact helper SID reaches the termination adapter' });
drain('INITIAL', `${ordinary}`, `return [pscustomobject]@{ReturnValue=0;Sid='${sid}'}`, 'UNKNOWN',
  { owners: 1, stops: 1, stopFailure: true, label: 'unproved termination blocks continuation' });
drain('INITIAL', `${ordinary}; ${system.replace('ProcessId=4;', 'ProcessId=644;')}`,
  `if ([int]$InputObject.ProcessId -eq 640) { return [pscustomobject]@{ReturnValue=0;Sid='${sid}'} }; return [pscustomobject]@{ReturnValue=2;Sid=$null}`,
  'UNKNOWN', { owners: 2, label: 'unknown owner blocks all terminations in that inventory' });

console.log(`process-drain-smoke: ${checks} checks passed (synthetic adapters; no live process termination)`);
