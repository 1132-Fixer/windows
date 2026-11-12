'use strict';

// Production generated functions with inert identity, file and shell adapters.
// No account, credential, profile, ACL, registry, UI or real COM effects.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildHelperSettingsScript } = require('../src/main/helper-settings');
const { nativePowerShell7, NATIVE_PS_STDIN_ARGS, prepareNativeScript } = require('./native-powershell');
const options = {
  expectedSid: 'S-1-5-21-100-200-300-1001', expectedProfilePath: 'C:\\Users\\user1',
  firstRunSource: "C:\\Program Files\\1132 Fixer\\resources\\first-run 'ü [literal].ps1",
  iconPath: 'C:\\Program Files\\1132 Fixer\\resources\\icon.ico',
  powerShellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  nonce: '1234567890abcdef1234567890abcdef'
};
let checks = 0;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
for (const change of [
  { expectedSid: '' }, { expectedSid: "S-1-5-21-1-2-3-4';exit" },
  { expectedProfilePath: 'C:\\Users\\TEMP' }, { nonce: 'old' },
  { firstRunSource: 'relative.ps1' }, { firstRunSource: 'C:\\safe\\..\\script.ps1' },
  { firstRunSource: 'C:\\safe\\script.ps1\nexit' }, { iconPath: '\\\\server\\icon.ico' },
  { powerShellPath: 'C:\\tmp\\pwsh.exe' }
]) { assert.throws(() => buildHelperSettingsScript({ ...options, ...change })); checks++; }
const script = buildHelperSettingsScript(options);
check(!/icacls|takeown|Set-Acl|Set-Service|Start-Service|Stop-Service|HKLM:|HKCU:|HKEY_USERS|zoomus\.zmdb|viper\.ini|transcoding\.ini/i.test(script),
  'helper settings have no privileged ACL/shared state or operator preference copy');
check(!/Start-Process|Process\]::Start|Invoke-Expression/.test(script), 'child settings never create another process');
check(script.includes("$identity.Groups) -contains 'S-1-5-32-544'"), 'deny-only administrator membership is refused');
check(script.includes('DoNotVerify') && script.includes('DesktopDirectory') && script.includes('ApplicationData'),
  'helper known folders support fresh and redirected helper profiles');
check(script.includes("first-run ''ü [literal].ps1"), 'literal apostrophes and Unicode survive script generation');
if (process.platform !== 'win32') {
  console.log(`helper-settings-smoke: ${checks} source/input checks passed; inert native fixtures not-run (Windows required)`);
  process.exit(0);
}
const encoded = Buffer.from(script, 'utf8').toString('base64');
const fixture = String.raw`
$ErrorActionPreference = 'Stop'
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'helper settings script failed parsing' }
$definitions = $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]}, $false)
. ([scriptblock]::Create(($definitions | ForEach-Object { $_.Extent.Text }) -join [Environment]::NewLine))
$sid = '${options.expectedSid}'
$profile = 'C:\Users\user1'
$nonce = '${options.nonce}'
$firstRunSource = 'C:\Program Files\1132 Fixer\resources\first-run ''ü [literal].ps1'
$powerShell = '${options.powerShellPath}'
$icon = '${options.iconPath}'
$documents = 'D:\Helper Documents ü [literal]'
$desktop = 'D:\Helper Desktop ü [literal]'
$appData = 'C:\Users\user1\AppData\Roaming'
$zoomIni = $appData + '\Zoom\data\Zoom.us.ini'
function Get-FixerHelperSettingsIdentity {
  if ($script:mode -eq 'identity-unavailable') { throw 'fixture identity query unavailable' }
  return [pscustomobject]@{
    Sid = $(if ($script:mode -eq 'operator') { 'S-1-5-21-100-200-300-9999' } else { $sid })
    ProfilePath = $(if ($script:mode -eq 'temp-profile') { 'C:\Users\TEMP' } else { $profile })
    IsAdministrator = $(if ($script:mode -eq 'admin') { $true } elseif ($script:mode -eq 'unknown-admin') { $null } else { $false })
    Groups = $(if ($script:mode -eq 'deny-only-admin') { @('S-1-5-32-545','S-1-5-32-544') }
      elseif ($script:mode -eq 'unknown-groups') { $null } else { @('S-1-5-32-545','S-1-5-11') })
  }
}
function Get-FixerHelperSettingsFolder {
  param([string]$Folder)
  if ($script:mode -eq 'unknown-folder') { return '' }
  switch ($Folder) { 'MyDocuments' { return $documents }; 'DesktopDirectory' { return $desktop }; 'ApplicationData' { return $appData } }
  throw 'unexpected fixture folder'
}
function Join-Path {
  param([string]$Path,[string]$ChildPath)
  return [IO.Path]::Combine($Path,$ChildPath)
}
function Test-Path {
  [CmdletBinding()]param([string]$LiteralPath,[string]$PathType)
  if ($LiteralPath -ceq $firstRunSource) { return ($script:mode -ne 'missing-source') }
  if ($LiteralPath -ceq $powerShell) { return $true }
  return $script:files.ContainsKey($LiteralPath)
}
function New-Item {
  [CmdletBinding()]param([string]$ItemType,[string]$Path,[switch]$Force)
  if ($ItemType -cne 'Directory' -or $Path -notin @($documents,$desktop,($appData+'\Zoom\data'))) { throw 'unexpected directory effect' }
  $script:effects.Add('directory')
}
function Copy-Item {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Destination,[switch]$Force)
  if ($LiteralPath -cne $firstRunSource -or $Destination -cne ($documents+'\zoom-firstrun-setup.ps1')) { throw 'unexpected copy effect' }
  $script:effects.Add('copy')
  if ($script:mode -eq 'copy-failure') { throw 'fixture copy refused' }
  $script:files[$Destination] = 'bundled-helper-content'
}
function Get-FileHash {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Algorithm)
  if ($Algorithm -cne 'SHA256') { throw 'unexpected hash algorithm' }
  return [pscustomobject]@{ Hash = $(if ($script:mode -eq 'copy-mismatch' -and $LiteralPath -cne $firstRunSource) { 'B'*64 } else { 'A'*64 }) }
}
function Get-Content {
  [CmdletBinding()]param([string]$LiteralPath,[switch]$Raw,[string]$Encoding)
  if ($LiteralPath -cne $zoomIni -or $Encoding -cne 'UTF8' -or -not $script:files.ContainsKey($LiteralPath)) { throw 'unexpected read effect' }
  if ($script:mode -eq 'theme-mismatch' -and $script:themeWritten) { return 'com.zoom.client.theme.mode=1' }
  return $script:files[$LiteralPath]
}
function Set-Content {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Value,[string]$Encoding,[switch]$NoNewline)
  if ($LiteralPath -cne $zoomIni -or $Encoding -cne 'UTF8' -or -not $NoNewline) { throw 'unexpected write effect' }
  $script:effects.Add('theme')
  if ($script:mode -eq 'theme-write-failure') { throw 'fixture theme write refused' }
  $script:files[$LiteralPath] = $Value
  $script:themeWritten = $true
}
function New-Object {
  [CmdletBinding()]param([string]$ComObject)
  if ($ComObject -cne 'WScript.Shell') { throw 'unexpected COM effect' }
  $script:effects.Add('com')
  $shell = [pscustomobject]@{}
  $shell | Add-Member ScriptMethod CreateShortcut {
    param([string]$Path)
    if ($Path -cne ($desktop+'\Apply Zoom Settings.lnk')) { throw 'unexpected shortcut path' }
    $entry = [pscustomobject]@{ Path=$Path; TargetPath=''; Arguments=''; WorkingDirectory=''; IconLocation=''; Description='' }
    if ($script:link) {
      foreach ($name in @('TargetPath','Arguments','WorkingDirectory','IconLocation','Description')) { $entry.$name = $script:link.$name }
      if ($script:mode -eq 'shortcut-mismatch') { $entry.TargetPath = 'C:\unrelated.exe' }
    }
    $entry | Add-Member ScriptMethod Save { $script:effects.Add('shortcut'); $script:link = $this }
    return $entry
  }
  return $shell
}
$records = @()
foreach ($script:mode in @('healthy','operator','admin','deny-only-admin','unknown-admin','unknown-groups',
  'temp-profile','identity-unavailable','unknown-folder','missing-source','copy-failure','copy-mismatch',
  'shortcut-mismatch','theme-write-failure','theme-mismatch','new-ini')) {
  $script:effects = [Collections.Generic.List[string]]::new()
  $script:files = @{}
  $script:themeWritten = $false
  $script:link = $null
  if ($script:mode -ne 'new-ini') {
    $script:files[$zoomIni] = 'keep.setting=café 東京' + [Environment]::NewLine +
      'com.zoom.client.theme.mode=0' + [Environment]::NewLine
  }
  $completed = $false; $output = @()
  try {
    $output = @(Invoke-FixerHelperSettings -ExpectedSid $sid -ExpectedProfilePath $profile -FirstRunSource $firstRunSource -IconPath $icon -PowerShellPath $powerShell -Nonce $nonce)
    $completed = $true
  } catch { <# Expected fixture failures are summarized without raw text. #> }
  $records += [pscustomobject]@{
    mode=$script:mode; completed=$completed; effects=$script:effects.Count; output=@($output)
    theme = [string]$script:files[$zoomIni]
    arguments = if ($script:link) { [string]$script:link.Arguments } else { '' }
  }
}
@($records) | ConvertTo-Json -Compress -Depth 5
`;
const run = spawnSync(nativePowerShell7(), NATIVE_PS_STDIN_ARGS, {
  input: prepareNativeScript(fixture), encoding: 'utf8', windowsHide: true, timeout: 30000
});
assert.equal(run.status, 0, String(run.stdout || run.stderr || run.error?.code || 'helper settings fixture failed'));
assert.equal(String(run.stderr || '').trim(), '');
const records = JSON.parse(String(run.stdout || '').trim());
assert.equal(records.length, 16);
for (const record of records) {
  const success = ['healthy', 'new-ini'].includes(record.mode);
  check(record.completed === success, `${record.mode}: expected production outcome`);
  if (success) {
    check(record.output.length === 1 && record.output[0] === `FIXER_HELPER_SETTINGS_V1=${options.nonce}|${options.expectedSid}|OK|OK`,
      `${record.mode}: one invocation/SID-bound success receipt follows readback`);
    check(record.theme.includes('com.zoom.client.theme.mode=2'), `${record.mode}: dark mode is read back`);
    check(record.arguments.includes('D:\\Helper Documents ü [literal]\\zoom-firstrun-setup.ps1') &&
      record.arguments.includes(`-ExpectedSid "${options.expectedSid}"`) && record.arguments.includes('-ExpectedProfilePath "C:\\Users\\user1"'),
    `${record.mode}: redirected helper folders and exact identity reach the shortcut`);
  } else check(record.output.length === 0, `${record.mode}: failed work cannot emit success`);
  if (['operator','admin','deny-only-admin','unknown-admin','unknown-groups','temp-profile','identity-unavailable','unknown-folder','missing-source'].includes(record.mode)) {
    check(record.effects === 0, `${record.mode}: refusal precedes every file or COM effect`);
  }
  if (record.mode === 'healthy') check(record.theme.includes('keep.setting=café 東京'), 'existing unrelated Unicode Zoom settings remain with explicit UTF8 reads and writes');
}
console.log(`helper-settings-smoke: ${checks} source/input/inert-native checks passed (16 synthetic scenarios; no live writes or COM)`);
