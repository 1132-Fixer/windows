'use strict';

const { PS_STDIN_ARGS } = require('./windows-tools');

function buildHelperSettingsLaunchScript({ helperUser, helperPassword, script, powerShellPath, nonce, expectedSid }) {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(helperUser) || typeof helperPassword !== 'string' ||
      !helperPassword || /[\r\n\0]/.test(helperPassword) || typeof script !== 'string' ||
      !script || script.includes(helperPassword) || !/^[a-z]:\\[^"\r\n]*\\powershell\.exe$/i.test(powerShellPath) ||
      !/^[a-f0-9]{32}$/.test(nonce) || !/^S-1-5-21-(?:\d+-){3}\d+$/.test(expectedSid)) {
    throw new Error('Invalid helper settings launch identity.');
  }
  const literal = value => value.replace(/'/g, "''");
  // CreateProcessWithLogonW limits the command line to 1024 characters.
  // Only the fixed stdin bootstrap is encoded into argv. The noncredential
  // script is parent-owned UTF8 input data, never an executable temp file.
  const encoded = Buffer.from(PS_STDIN_ARGS.at(-1), 'utf16le').toString('base64');
  if (powerShellPath.length + encoded.length + 64 >= 1024) {
    throw new Error('Helper settings bootstrap exceeds the logon command bound.');
  }
  const inputBytes = Buffer.from(script, 'utf8').toString('base64');
  const success = `FIXER_HELPER_SETTINGS_V1=${nonce}|${expectedSid}|OK|OK`;
  return String.raw`
$ErrorActionPreference = 'Stop'
$child = $null; $held = $null; $pw = $null
$outPath = $null; $errPath = $null; $inPath = $null
$closed = $false; $proved = $false; $launchAttempted = $false
try {
  $pw = [System.Security.SecureString]::new()
  $chars = '${literal(helperPassword)}'.ToCharArray()
  try { foreach ($character in $chars) { $pw.AppendChar($character) } }
  finally { $character = $null; [Array]::Clear($chars, 0, $chars.Length) }
  $pw.MakeReadOnly()
  $credential = [System.Management.Automation.PSCredential]::new(
    ([Environment]::MachineName + '\${literal(helperUser)}'), $pw)
  # Parent-owned data files never contain credentials or executable temp paths.
  $inPath = [IO.Path]::GetTempFileName()
  [IO.File]::WriteAllBytes($inPath, [Convert]::FromBase64String('${inputBytes}'))
  $outPath = [IO.Path]::GetTempFileName()
  $errPath = [IO.Path]::GetTempFileName()
  $launchAttempted = $true
  $child = Start-Process -FilePath '${literal(powerShellPath)}' -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-EncodedCommand', '${encoded}') -Credential $credential -LoadUserProfile -WindowStyle Hidden -PassThru -RedirectStandardInput $inPath -RedirectStandardOutput $outPath -RedirectStandardError $errPath -ErrorAction Stop
  $held = $child.SafeHandle
  if ($null -eq $held -or $held.IsInvalid -or $held.IsClosed) { throw 'child custody unavailable' }
  if (-not $child.WaitForExit(30000)) { throw 'child deadline exceeded' }
  $closed = $true
  if ($child.ExitCode -ne 0 -or (Get-Item -LiteralPath $outPath).Length -gt 8192 -or
      (Get-Item -LiteralPath $errPath).Length -gt 8192) { throw 'child result unverified' }
  $text = [IO.File]::ReadAllText($outPath).Trim()
  $errors = [IO.File]::ReadAllText($errPath).Trim()
  if ($text -cne '${success}' -or $errors) { throw 'child receipt unverified' }
  $proved = $true
} catch { $proved = $false }
finally {
  if ($null -eq $child) { $closed = -not $launchAttempted }
  else {
    if (-not $closed) {
      try {
        if ($null -eq $held -or $held.IsInvalid -or $held.IsClosed) { throw 'no held identity' }
        if (-not $child.HasExited) { $child.Kill() }
        $closed = $child.WaitForExit(5000)
      } catch { $closed = $false }
    }
    $child.Dispose()
  }
  $credential = $null
  if ($null -ne $pw) { $pw.Dispose() }
  foreach ($ownedPath in @($inPath, $outPath, $errPath)) {
    if ($ownedPath) { try { [IO.File]::Delete($ownedPath) } catch { $proved = $false } }
  }
}
if ($closed) { Write-Output 'FIXER_HELPER_SETTINGS_CUSTODY_V1=CLOSED' }
else { Write-Output 'FIXER_HELPER_SETTINGS_CUSTODY_V1=UNVERIFIED' }
if ($proved -and $closed) { Write-Output '${success}'; exit 0 }
Write-Output 'FIXER_HELPER_SETTINGS_V1=UNVERIFIED'
exit 1
`;
}

module.exports = { buildHelperSettingsLaunchScript };
