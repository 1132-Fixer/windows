'use strict';

// Production functions, synthetic CIM/registry/service/UI adapters only.
// No account, registry, service, ACL, profile, or live UI changes are made.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { NATIVE_PS_STDIN_ARGS, nativePowerShell7, prepareNativeScript } = require('./native-powershell');
const root = path.join(__dirname, '..');
const media = fs.readFileSync(path.join(root, 'scripts/grant-media-consent.ps1'), 'utf8');
const firstRun = fs.readFileSync(path.join(root, 'scripts/zoom-firstrun-setup.ps1'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
let checks = 0;
function check(condition, label) { assert.ok(condition, label); checks++; }

check(!/\b(?:Set-Service|Start-Service|Stop-Service|Restart-Service|Start-Process|reg(?:\.exe)?\s+(?:load|unload))\b/i.test(media),
  'automatic media script contains no service mutation, external process, or hive mount/unmount');
check(!/HKCU:|New-ItemProperty|SendKeys|SendWait/.test(firstRun),
  'manual first-run helper has no registry write or untargeted keyboard fallback');
check(firstRun.indexOf('try { $script:FixerSessionId = Assert-FixerFirstRunIdentity') < firstRun.indexOf('$logFile ='),
  'first-run identity guard precedes log-file writes');
check(firstRun.indexOf('try { $script:FixerSessionId = Assert-FixerFirstRunIdentity') < firstRun.indexOf('Add-Type -AssemblyName'),
  'first-run identity guard precedes UI assembly loading');
const helperSettings = fs.readFileSync(path.join(root, 'src/main/helper-settings.js'), 'utf8');
check(main.includes('expectedSid: helperSID, expectedProfilePath: newUserProfile') &&
  helperSettings.includes('-ExpectedSid "') && helperSettings.includes('-ExpectedProfilePath "') &&
  helperSettings.includes("'\" -ExpectedSid \"' + $ExpectedSid") &&
  helperSettings.includes("'\" -ExpectedProfilePath \"' + $ExpectedProfilePath"),
  'standard-token shortcut writer receives the exact recreated SID and profile path');
check(main.includes('Expected profile paths (not measured from Zoom)') && !main.includes('Launched-profile environment:'),
  'expected profile strings are not reported as measured Zoom environment');
check(main.includes("checkpoint('before-preferences');"), 'operator cancellation checkpoint is preserved');

// Execute the actual main-process receipt parser, including stale/partial output.
const parserStart = main.indexOf('      const mediaLines = String(consent.stdout');
const parserEnd = main.indexOf("      send('  Consent: camera='", parserStart);
check(parserStart > 0 && parserEnd > parserStart, 'production media receipt parser is present');
const parser = main.slice(parserStart, parserEnd);
const nonce = '12345678-1234-1234-1234-123456789abc';
const sid = 'S-1-5-21-100-200-300-1001';
const goodLine = 'FIXER_MEDIA_V1=' + nonce + '|' + sid + '|OK|OK';
function receiptResult(consent) {
  return vm.runInNewContext('(function(){' + parser + '\nreturn { mediaProof, camStatus, micStatus, frameState }; })()',
    { consentNonce: nonce, helperSID: sid, consent, Set, String });
}
const healthy = { code: 0, timedOut: false, stdout: 'FRAMESERVER_STATE=AVAILABLE\n' + goodLine, stderr: '' };
check(receiptResult(healthy).mediaProof && receiptResult(healthy).camStatus === 'OK', 'complete nonce/SID-bound receipt permits success');
for (const broken of [
  { ...healthy, timedOut: true }, { ...healthy, timedOut: undefined }, { ...healthy, code: 1 },
  { ...healthy, stderr: 'fixture error' }, { ...healthy, stdout: '' },
  { ...healthy, stdout: goodLine + '\n' + goodLine },
  { ...healthy, stdout: goodLine.replace(nonce, '00000000-0000-0000-0000-000000000000') },
  { ...healthy, stdout: goodLine.replace(sid, 'S-1-5-21-100-200-300-9999') },
  { ...healthy, stdout: goodLine.replace('|OK|OK', '|OK') },
  { ...healthy, stdout: goodLine.replace('|OK|OK', '|ALLOW|OK') }
]) check(!receiptResult(broken).mediaProof && receiptResult(broken).camStatus === 'UNVERIFIED', 'failed, stale or incomplete receipt never grants success');
check(receiptResult({ ...healthy, stdout: goodLine.replace('|OK|OK', '|MACHINE-BLOCKED|POLICY-BLOCKED') }).camStatus === 'MACHINE-BLOCKED',
  'precise blocked states survive the production parser');

if (process.platform === 'win32') {
  const encodedMedia = Buffer.from(media, 'utf8').toString('base64');
  const encodedFirst = Buffer.from(firstRun, 'utf8').toString('base64');
  const fixture = String.raw`
$ErrorActionPreference = 'Stop'
try {
$mediaSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedMedia}'))
$firstSource = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFirst}'))
function Import-FixtureFunctions([string]$Source) {
  $tokens=$null; $errors=$null
  $ast=[Management.Automation.Language.Parser]::ParseInput($Source,[ref]$tokens,[ref]$errors)
  if ($errors.Count -ne 0) { throw ('Parser errors: ' + ($errors.Message -join '; ')) }
  $definitions=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$false)
  return ($definitions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine
}
# Load definitions only. Script entrypoints and all real side effects stay inert.
. ([scriptblock]::Create((Import-FixtureFunctions $mediaSource)))
function Get-FixerMediaOperatorSid { return $script:case.operator }
function Get-CimInstance {
  [CmdletBinding()]param([string]$ClassName,[string]$Filter)
  if ($script:case.queryFail) { throw 'fixture query denied' }
  if ($ClassName -eq 'Win32_UserAccount') {
    $script:identityChecks++
    if ($script:case.identityRace -and $script:identityChecks -gt 1) { throw 'fixture account changed' }
    return [pscustomobject]@{ SID=$script:case.accountSid; Name=$script:case.name; Domain=$script:case.domain; LocalAccount=$script:case.local }
  }
  if ($ClassName -eq 'Win32_UserProfile') {
    return [pscustomobject]@{ SID='${sid}'; Loaded=$script:case.loaded; Special=$false; LocalPath=$script:case.profilePath }
  }
  if ($ClassName -eq 'Win32_Process') { return $script:case.process }
  throw 'unexpected fixture query'
}
function Get-ItemProperty {
  [CmdletBinding()]param([string]$LiteralPath)
  if ($LiteralPath -like '*ProfileList*') { return [pscustomobject]@{ ProfileImagePath=$script:case.registeredPath } }
  if ($LiteralPath -like '*Policies*') { return [pscustomobject]@{ LetAppsAccessCamera=$script:case.policy; LetAppsAccessMicrophone=$script:case.policy } }
  if ($LiteralPath.StartsWith('HKLM:')) {
    if ($script:case.machineUnknown) { throw 'fixture machine read denied' }
    return [pscustomobject]@{ Value=$script:case.machine }
  }
  if (-not $script:values.ContainsKey($LiteralPath)) { throw 'fixture value absent' }
  return [pscustomobject]@{ Value=$(if ($script:case.readbackFail) { 'Deny' } else { $script:values[$LiteralPath] }) }
}
function Test-Path {
  [CmdletBinding()]param([string]$LiteralPath)
  if ($LiteralPath -eq ('Registry::HKEY_USERS\' + '${sid}')) { return $script:case.hive }
  if ($LiteralPath -like '*Policies*') { return $true }
  return $script:values.ContainsKey($LiteralPath)
}
function Get-Item {
  [CmdletBinding()]param([string]$LiteralPath,[switch]$Force)
  return [pscustomobject]@{ PSIsContainer=$true; FullName=$script:case.profilePath; Attributes=$script:case.attributes }
}
function Get-Service { [CmdletBinding()]param([string]$Name) return [pscustomobject]@{ StartType=$script:case.frame } }
function Assert-FixtureWrite([string]$Path) {
  if (-not $Path.StartsWith('Registry::HKEY_USERS\' + '${sid}' + '\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\')) { throw 'OUTSIDE_HELPER_WRITE' }
}
function New-Item {
  [CmdletBinding()]param([string]$Path,[switch]$Force)
  Assert-FixtureWrite $Path; $script:writes.Add('create:'+$Path); $script:values[$Path]=''
}
function New-ItemProperty {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Name,[string]$PropertyType,[string]$Value,[switch]$Force)
  Assert-FixtureWrite $LiteralPath
  if ($Name -ne 'Value' -or $Value -ne 'Allow') { throw 'unexpected fixture value' }
  $script:writes.Add('set:'+$LiteralPath); $script:values[$LiteralPath]=$Value
}
function Set-Service { throw 'FORBIDDEN_SERVICE_WRITE' }
function Start-Service { throw 'FORBIDDEN_SERVICE_WRITE' }
function Stop-Service { throw 'FORBIDDEN_SERVICE_WRITE' }
function Restart-Service { throw 'FORBIDDEN_SERVICE_WRITE' }
function Start-Process { throw 'FORBIDDEN_PROCESS' }
function Out-File { throw 'FORBIDDEN_FILE_WRITE' }
function Add-Type { throw 'FORBIDDEN_UI_LOAD' }
$records=[Collections.Generic.List[object]]::new()
$scenarios=@(
  @{ label='valid'; states='OK|OK'; sets=4 },
  @{ label='missing-sid'; sid=''; refused=$true },
  @{ label='wrong-sid'; sid='S-1-5-21-100-200-300-9999'; refused=$true },
  @{ label='invalid-sid'; sid='user1'; refused=$true },
  @{ label='operator-sid'; operator='${sid}'; refused=$true },
  @{ label='wrong-name'; name='other'; refused=$true },
  @{ label='foreign-domain'; domain='FOREIGN'; refused=$true },
  @{ label='not-local'; local=$false; refused=$true },
  @{ label='wrong-path'; profilePath='C:\Users\operator'; refused=$true },
  @{ label='wrong-registration'; registeredPath='C:\Users\operator'; refused=$true },
  @{ label='unloaded-hive'; hive=$false; refused=$true },
  @{ label='profile-unloaded'; loaded=$false; refused=$true },
  @{ label='profile-unknown'; loaded='True'; refused=$true },
  @{ label='reparse-profile'; attributes=[IO.FileAttributes]::ReparsePoint; refused=$true },
  @{ label='query-error'; queryFail=$true; refused=$true },
  @{ label='missing-receipt'; receipt=''; refused=$true },
  @{ label='machine-block'; machine='Deny'; states='MACHINE-BLOCKED|MACHINE-BLOCKED'; sets=0 },
  @{ label='policy-block'; policy=2; states='POLICY-BLOCKED|POLICY-BLOCKED'; sets=0 },
  @{ label='machine-unknown'; machineUnknown=$true; states='UNVERIFIED|UNVERIFIED'; sets=0 },
  @{ label='frame-disabled'; frame='Disabled'; states='MACHINE-BLOCKED|OK'; sets=2 },
  @{ label='identity-race'; identityRace=$true; states='UNVERIFIED|UNVERIFIED'; sets=0 },
  @{ label='readback-failure'; readbackFail=$true; states='UNVERIFIED|UNVERIFIED'; sets=4 }
)
foreach ($scenario in $scenarios) {
  $script:case=@{ operator='S-1-5-21-100-200-300-9998'; accountSid='${sid}'; sid='${sid}'; name='user1'; domain=[Environment]::MachineName; local=$true; profilePath='C:\Users\user1'; registeredPath='C:\Users\user1'; loaded=$true; hive=$true; attributes=[IO.FileAttributes]::Directory; machine='Allow'; frame='Manual'; policy=0; receipt='${nonce}' }
  foreach ($key in $scenario.Keys) { $script:case[$key]=$scenario[$key] }
  $script:writes=[Collections.Generic.List[string]]::new(); $script:values=@{}; $script:identityChecks=0
  $output=@(Invoke-FixerMediaConsent -Sid $script:case.sid -User 'user1' -ProfilePath $script:case.profilePath -Receipt $script:case.receipt)
  $line=@($output | Where-Object { $_ -like 'FIXER_MEDIA_V1=*' })
  $sets=@($script:writes | Where-Object { $_.StartsWith('set:') }).Count
  if ($scenario.refused) {
    if ($script:writes.Count -ne 0 -or $line.Count -ne 0 -or -not ($output -like 'MEDIA_UNVERIFIED=*')) { throw ('refusal failed: '+$scenario.label) }
  } elseif ($line.Count -ne 1 -or $line[0] -cne ('FIXER_MEDIA_V1=${nonce}|${sid}|'+$scenario.states) -or $sets -ne $scenario.sets) {
    throw ('consent fixture failed: '+$scenario.label+' '+($output -join '; ')+' sets='+$sets)
  }
  $records.Add([pscustomobject]@{ kind='media'; label=$scenario.label; sets=$sets })
}

. ([scriptblock]::Create((Import-FixtureFunctions $firstSource)))
function Get-FixerFirstRunIdentity { return $script:case.identity }
function Invoke-CimMethod {
  [CmdletBinding()]param($InputObject,[string]$MethodName)
  return [pscustomobject]@{ ReturnValue=$script:case.ownerCode; Sid=$script:case.owner }
}
$script:ExpectedSid='${sid}'; $script:FixerSessionId=3
foreach ($scenario in @(
  @{ label='valid'; expected=$true },
  @{ label='wrong-current-sid'; actual='S-1-5-21-100-200-300-9998'; expected=$false },
  @{ label='missing-sid'; target=''; expected=$false },
  @{ label='wrong-profile'; actualPath='C:\Users\operator'; expected=$false },
  @{ label='wrong-account'; name='operator'; expected=$false },
  @{ label='session-zero'; session=0; expected=$false }
)) {
  $script:case=@{ identity=@{ Sid='${sid}'; SessionId=3; ProfilePath='C:\Users\user1' }; accountSid='${sid}'; name='user1'; domain=[Environment]::MachineName; local=$true; registeredPath='C:\Users\user1' }
  if ($scenario.ContainsKey('actual')) { $script:case.identity.Sid=$scenario.actual }
  if ($scenario.ContainsKey('actualPath')) { $script:case.identity.ProfilePath=$scenario.actualPath }
  if ($scenario.ContainsKey('name')) { $script:case.name=$scenario.name }
  if ($scenario.ContainsKey('session')) { $script:case.identity.SessionId=$scenario.session }
  $target=if ($scenario.ContainsKey('target')) { $scenario.target } else { '${sid}' }
  $accepted=$false
  try { $session=Assert-FixerFirstRunIdentity -ExpectedSid $target -ExpectedProfilePath 'C:\Users\user1'; $accepted=$session -eq 3 } catch {}
  if ($accepted -ne $scenario.expected) { throw ('first-run identity fixture failed: '+$scenario.label) }
  $records.Add([pscustomobject]@{ kind='first-run'; label=$scenario.label; accepted=$accepted })
}
foreach ($scenario in @(
  @{ label='owned'; owner='${sid}'; code=0; session=3; expected=$true },
  @{ label='foreign-owner'; owner='S-1-5-21-100-200-300-9998'; code=0; session=3; expected=$false },
  @{ label='unknown-owner'; owner=''; code=2; session=3; expected=$false },
  @{ label='other-session'; owner='${sid}'; code=0; session=4; expected=$false }
)) {
  $script:case=@{ process=[pscustomobject]@{ ProcessId=12345; Name='Zoom.exe'; SessionId=$scenario.session }; owner=$scenario.owner; ownerCode=$scenario.code }
  $accepted=$false; try { Assert-FixerZoomProcess -ProcessId 12345; $accepted=$true } catch {}
  if ($accepted -ne $scenario.expected) { throw ('Zoom ownership fixture failed: '+$scenario.label) }
  if (-not $scenario.expected) {
    $element=[pscustomobject]@{ Current=[pscustomobject]@{ ProcessId=12345 } }
    foreach ($action in @('Invoke-Element','Set-Toggle','Set-ComboValue')) {
      $refused=$false; try { & $action $element $true | Out-Null } catch { $refused=$true }
      if (-not $refused) { throw ('UI action failed open: '+$action+' '+$scenario.label) }
    }
  }
  $records.Add([pscustomobject]@{ kind='zoom-owner'; label=$scenario.label; accepted=$accepted })
}
ConvertTo-Json -InputObject @($records.ToArray()) -Compress
} catch { Write-Output ('FIXTURE_FAILURE=' + $_.Exception.Message + '; line=' + $_.InvocationInfo.ScriptLineNumber); exit 1 }
`;
  const run = spawnSync(nativePowerShell7(), NATIVE_PS_STDIN_ARGS, {
    input: prepareNativeScript(fixture), encoding: 'utf8', windowsHide: true, timeout: 30000
  });
  check(run.status === 0 && !run.error, 'production script parser and synthetic native behaviors pass: ' + (run.stdout || run.stderr || ''));
  const records = JSON.parse(String(run.stdout || '').trim());
  check(records.length === 32, 'all 22 media, 6 first-run identity and 4 Zoom ownership cases returned evidence');
  for (const record of records) check(!!record.label, record.kind + ': ' + record.label);
} else {
  console.log('media-isolation-smoke: native parser/adapter fixtures not-run (non-Windows host)');
}
console.log('media-isolation-smoke: ' + checks + ' checks passed');
