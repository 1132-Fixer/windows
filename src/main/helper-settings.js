'use strict';

const path = require('path');

const quote = value => `'${value.replace(/'/g, "''")}'`;
function absoluteWindowsPath(value) {
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value) &&
    !/[\x00-\x1f"<>|?*]/.test(value) && !value.includes('/') &&
    path.win32.normalize(value) === value && !value.endsWith('\\');
}

// Run this script in the verified helper's standard token. The elevated
// parent supplies no operator files and must not perform these writes itself.
function buildHelperSettingsScript({ expectedSid, expectedProfilePath, firstRunSource, iconPath, powerShellPath, nonce } = {}) {
  if (typeof expectedSid !== 'string' || !/^S-1-5-21-\d+-\d+-\d+-\d+$/.test(expectedSid) ||
      typeof expectedProfilePath !== 'string' || expectedProfilePath.toLowerCase() !== 'c:\\users\\user1' ||
      ![firstRunSource, iconPath, powerShellPath].every(absoluteWindowsPath) ||
      !/\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(powerShellPath) ||
      typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) {
    throw new TypeError('Helper settings require one exact identity, trusted source paths and invocation nonce.');
  }
  return String.raw`
$ErrorActionPreference = 'Stop'
function Get-FixerHelperSettingsIdentity {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return [pscustomobject]@{
      Sid = [string]$identity.User.Value
      Groups = @($identity.Groups | ForEach-Object { [string]$_.Value })
      IsAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
      ProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    }
  } finally { if ($null -ne $identity) { $identity.Dispose() } }
}
function Assert-FixerHelperSettingsIdentity {
  param([string]$ExpectedSid, [string]$ExpectedProfilePath)
  if ($ExpectedSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or
      $ExpectedProfilePath -ine 'C:\Users\user1') { throw 'HELPER_IDENTITY_INVALID' }
  $identity = Get-FixerHelperSettingsIdentity
  if ($null -eq $identity -or [string]$identity.Sid -ine $ExpectedSid -or
      [string]$identity.ProfilePath -ine $ExpectedProfilePath -or
      $identity.IsAdministrator -isnot [bool] -or $identity.IsAdministrator -or
      $null -eq $identity.Groups -or @($identity.Groups).Count -eq 0 -or
      @($identity.Groups) -contains 'S-1-5-32-544') { throw 'STANDARD_HELPER_TOKEN_REQUIRED' }
}
function Get-FixerHelperSettingsFolder {
  param([Environment+SpecialFolder]$Folder)
  return [Environment]::GetFolderPath($Folder, [Environment+SpecialFolderOption]::DoNotVerify)
}
function Invoke-FixerHelperSettings {
  param([string]$ExpectedSid, [string]$ExpectedProfilePath, [string]$FirstRunSource,
    [string]$IconPath, [string]$PowerShellPath, [string]$Nonce)
  # All filesystem and shell COM operations follow this token proof. Even a
  # helper-owned redirect then has only the helper's existing access rights.
  Assert-FixerHelperSettingsIdentity -ExpectedSid $ExpectedSid -ExpectedProfilePath $ExpectedProfilePath
  $documents = Get-FixerHelperSettingsFolder -Folder MyDocuments
  $desktop = Get-FixerHelperSettingsFolder -Folder DesktopDirectory
  $appData = Get-FixerHelperSettingsFolder -Folder ApplicationData
  foreach ($folder in @($documents, $desktop, $appData)) {
    if ([string]::IsNullOrWhiteSpace($folder) -or -not [IO.Path]::IsPathRooted($folder)) {
      throw 'HELPER_FOLDER_UNVERIFIED'
    }
  }
  if (-not (Test-Path -LiteralPath $FirstRunSource -PathType Leaf -ErrorAction Stop) -or
      -not (Test-Path -LiteralPath $PowerShellPath -PathType Leaf -ErrorAction Stop)) {
    throw 'HELPER_RESOURCE_UNAVAILABLE'
  }
  New-Item -ItemType Directory -Path $documents -Force -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path $desktop -Force -ErrorAction Stop | Out-Null
  $firstRun = Join-Path $documents 'zoom-firstrun-setup.ps1'
  $shortcut = Join-Path $desktop 'Apply Zoom Settings.lnk'
  Copy-Item -LiteralPath $FirstRunSource -Destination $firstRun -Force -ErrorAction Stop
  $sourceHash = [string](Get-FileHash -LiteralPath $FirstRunSource -Algorithm SHA256 -ErrorAction Stop).Hash
  $copiedHash = [string](Get-FileHash -LiteralPath $firstRun -Algorithm SHA256 -ErrorAction Stop).Hash
  if ($sourceHash -notmatch '^[a-fA-F0-9]{64}$' -or $sourceHash -ine $copiedHash) {
    throw 'HELPER_DEPLOYMENT_UNVERIFIED'
  }
  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $firstRun +
    '" -ExpectedSid "' + $ExpectedSid + '" -ExpectedProfilePath "' + $ExpectedProfilePath + '"'
  $shell = New-Object -ComObject WScript.Shell
  $link = $null
  $readback = $null
  try {
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $PowerShellPath
    $link.Arguments = $arguments
    $link.WorkingDirectory = $documents
    $link.IconLocation = $IconPath + ',0'
    $link.Description = 'Apply standard Zoom UI settings - run after signing into Zoom'
    $link.Save()
    $readback = $shell.CreateShortcut($shortcut)
    if ([string]$readback.TargetPath -ine $PowerShellPath -or
        [string]$readback.Arguments -cne $arguments -or
        [string]$readback.WorkingDirectory -ine $documents -or
        [string]$readback.IconLocation -ine ($IconPath + ',0')) { throw 'HELPER_SHORTCUT_UNVERIFIED' }
  } finally {
    foreach ($ownedCom in @($readback, $link, $shell)) {
      if ($null -ne $ownedCom -and [Runtime.InteropServices.Marshal]::IsComObject($ownedCom)) {
        try { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($ownedCom) }
        catch { <# CreateShortcut can return the same owned RCW twice. #> }
      }
    }
  }
  $zoomDir = Join-Path $appData 'Zoom\data'
  New-Item -ItemType Directory -Path $zoomDir -Force -ErrorAction Stop | Out-Null
  $zoomIni = Join-Path $zoomDir 'Zoom.us.ini'
  $content = if (Test-Path -LiteralPath $zoomIni -PathType Leaf -ErrorAction Stop) {
    [string](Get-Content -LiteralPath $zoomIni -Raw -Encoding UTF8 -ErrorAction Stop)
  } else { '' }
  $themePattern = '(?m)^com\.zoom\.client\.theme\.mode\s*=.*'
  if ([Regex]::IsMatch($content, $themePattern)) {
    $content = [Regex]::Replace($content, $themePattern, 'com.zoom.client.theme.mode=2')
  } else { $content = 'com.zoom.client.theme.mode=2' + [Environment]::NewLine + $content }
  Set-Content -LiteralPath $zoomIni -Value $content -Encoding UTF8 -NoNewline -ErrorAction Stop
  $verified = [string](Get-Content -LiteralPath $zoomIni -Raw -Encoding UTF8 -ErrorAction Stop)
  $themes = [Regex]::Matches($verified, '(?m)^com\.zoom\.client\.theme\.mode\s*=\s*([^\r\n]*)')
  if ($themes.Count -lt 1 -or @($themes | Where-Object { $_.Groups[1].Value.Trim() -cne '2' }).Count -ne 0) {
    throw 'HELPER_THEME_UNVERIFIED'
  }
  Write-Output ('FIXER_HELPER_SETTINGS_V1=' + $Nonce + '|' + $ExpectedSid + '|OK|OK')
}
try {
  Invoke-FixerHelperSettings -ExpectedSid ${quote(expectedSid)} -ExpectedProfilePath ${quote(expectedProfilePath)} -FirstRunSource ${quote(firstRunSource)} -IconPath ${quote(iconPath)} -PowerShellPath ${quote(powerShellPath)} -Nonce ${quote(nonce)}
} catch {
  Write-Output ${quote(`FIXER_HELPER_SETTINGS_V1=${nonce}|${expectedSid}|UNVERIFIED|UNVERIFIED`)}
  exit 1
}
`;
}

module.exports = { buildHelperSettingsScript };
