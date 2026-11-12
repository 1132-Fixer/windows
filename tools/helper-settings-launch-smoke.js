'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { nativePowerShell7, prepareNativeScript, NATIVE_PS_STDIN_ARGS } = require('./native-powershell');
const { buildHelperSettingsLaunchScript } = require('../src/main/helper-settings-launch');
const sid = 'S-1-5-21-100-200-300-1001';
const nonce = '0123456789abcdef0123456789abcdef';
const input = { helperUser: 'user1', helperPassword: 'synthetic fixture password', script: "Write-Output 'fixture'", powerShellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', nonce, expectedSid: sid };
const script = buildHelperSettingsLaunchScript(input);
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
for (const change of [{ helperUser: "bad';" }, { helperPassword: '' }, { script: '' }, { script: input.helperPassword }, { nonce: '' }, { expectedSid: 'S-1-5-18' }, { powerShellPath: 'powershell.exe' }]) {
  assert.throws(() => buildHelperSettingsLaunchScript({ ...input, ...change })); checks++;
}
check(!script.includes('-Password') && !script.includes('-ArgumentList @(' + input.helperPassword), 'password is not a native argument');
check(script.includes('[Array]::Clear') && script.includes('$pw.Dispose()'), 'temporary password buffer and SecureString are disposed');
check(!/ExecutionPolicy|Stop-Process|taskkill|ProcessId\s*=/.test(script), 'wrapper has no policy change or PID/name termination');
check(script.includes('$held = $child.SafeHandle') && script.includes('$held.IsInvalid') && script.includes('$child.WaitForExit(5000)'), 'termination requires original retained identity and exit readback');

if (process.platform === 'win32') {
  const native = nativePowerShell7();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), '1132-settings-launch-'));
  try {
    for (const scenario of ['healthy', 'bad-receipt', 'stderr', 'nonzero', 'timeout', 'kill-failure', 'launch-failure', 'bad-handle']) {
      const record = path.join(temp, scenario + '.json');
      const escape = value => value.replace(/'/g, "''");
      const prelude = String.raw`
$script:scenario = '${scenario}'
$script:recordPath = '${escape(record)}'
$script:record = @{ kills = 0; disposed = $false; calls = 0; outputs = @() }
function Start-Process {
  [CmdletBinding()]
  param($FilePath, $ArgumentList, $Credential, [switch]$LoadUserProfile, $WindowStyle,
    [switch]$PassThru, $RedirectStandardInput, $RedirectStandardOutput, $RedirectStandardError)
  $script:record.outputs = @($RedirectStandardInput, $RedirectStandardOutput, $RedirectStandardError)
  if ($script:scenario -eq 'launch-failure') {
    $script:record | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:recordPath
    throw 'synthetic launch failure'
  }
  if (-not $LoadUserProfile -or $WindowStyle -cne 'Hidden' -or
      @($ArgumentList).Count -ne 4 -or $ArgumentList[2] -cne '-EncodedCommand' -or
      ($FilePath.Length + ($ArgumentList -join ' ').Length + 4) -ge 1024 -or
      [IO.File]::ReadAllText($RedirectStandardInput) -cne "Write-Output 'fixture'") { throw 'unsafe adapter contract' }
  [IO.File]::WriteAllText($RedirectStandardOutput, $(if ($script:scenario -eq 'bad-receipt') { 'stale receipt' } else { 'FIXER_HELPER_SETTINGS_V1=${nonce}|${sid}|OK|OK' }))
  [IO.File]::WriteAllText($RedirectStandardError, $(if ($script:scenario -eq 'stderr') { 'synthetic diagnostic' } else { '' }))
  $process = [pscustomobject]@{
    SafeHandle = [pscustomobject]@{ IsInvalid = ($script:scenario -eq 'bad-handle'); IsClosed = $false }
    ExitCode = $(if ($script:scenario -eq 'nonzero') { 7 } else { 0 })
    HasExited = $false
  }
  $process | Add-Member ScriptMethod WaitForExit {
    param($Milliseconds)
    $script:record.calls++
    if ($script:record.calls -eq 1 -and $script:scenario -in @('timeout','kill-failure')) { return $false }
    return $true
  }
  $process | Add-Member ScriptMethod Kill {
    $script:record.kills++
    if ($script:scenario -eq 'kill-failure') { throw 'synthetic kill failure' }
  }
  $process | Add-Member ScriptMethod Dispose {
    $script:record.disposed = $true
    $script:record | ConvertTo-Json -Compress | Set-Content -LiteralPath $script:recordPath
  }
  return $process
}
`;
      const result = spawnSync(native, NATIVE_PS_STDIN_ARGS, { input: prepareNativeScript(prelude + '\n' + script), encoding: 'utf8', windowsHide: true, timeout: 15000 });
      check(!result.error && !result.signal && result.status === (scenario === 'healthy' ? 0 : 1), `${scenario} returns the bounded expected result`);
      const state = JSON.parse(fs.readFileSync(record, 'utf8').replace(/^\uFEFF/, ''));
      check(state.outputs.every(file => !fs.existsSync(file)), `${scenario} closes and removes exact parent-owned output files`);
      if (scenario !== 'launch-failure') check(state.disposed === true, `${scenario} disposes the original process object`);
      check(state.kills === (['timeout','kill-failure'].includes(scenario) ? 1 : 0), `${scenario} never kills without its retained valid handle`);
      const uncertain = ['kill-failure','launch-failure','bad-handle'].includes(scenario);
      check(result.stdout.includes('FIXER_HELPER_SETTINGS_CUSTODY_V1=' + (uncertain ? 'UNVERIFIED' : 'CLOSED')), `${scenario} reports custody independently of settings`);
      check(scenario === 'healthy' ? result.stdout.includes(`FIXER_HELPER_SETTINGS_V1=${nonce}|${sid}|OK|OK`) : !result.stdout.includes(`FIXER_HELPER_SETTINGS_V1=${nonce}|${sid}|OK|OK`), `${scenario} cannot overstate settings success`);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
} else console.log('helper-settings-launch-smoke: native inert adapters not-run on this host');
console.log(`helper-settings-launch-smoke: ${checks} checks passed`);
