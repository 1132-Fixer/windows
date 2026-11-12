<#
.SYNOPSIS
  Set helper-only consent; machine privacy and FrameServer are read-only.
.DESCRIPTION
  Requires the exact local helper SID, canonical profile, and loaded hive.
  No machine changes, hive mount/unload, or administrator HKCU fallback.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string] $Sid,
  [Parameter(Mandatory=$true)][string] $User,
  [Parameter(Mandatory=$true)][string] $ProfilePath,
  [Parameter(Mandatory=$true)][string] $Receipt
)
$ErrorActionPreference = 'Stop'

function Get-FixerMediaOperatorSid {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try { return [string]$identity.User.Value }
  finally { if ($null -ne $identity) { $identity.Dispose() } }
}

function Assert-FixerMediaIdentity {
  param([string]$Sid, [string]$User, [string]$ProfilePath)
  if ($Sid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or $User -cne 'user1') { throw 'HELPER_IDENTITY_INVALID' }
  $operatorSid = Get-FixerMediaOperatorSid
  if (-not $operatorSid -or $operatorSid -ieq $Sid) { throw 'OPERATOR_IDENTITY_REFUSED' }
  $accounts = @(Get-CimInstance -ClassName Win32_UserAccount -Filter ("LocalAccount=True AND SID='" + $Sid + "'") -ErrorAction Stop)
  if ($accounts.Count -ne 1 -or $accounts[0].LocalAccount -isnot [bool] -or
      -not $accounts[0].LocalAccount -or [string]$accounts[0].SID -ine $Sid -or
      [string]$accounts[0].Name -ine $User -or
      [string]$accounts[0].Domain -ine [Environment]::MachineName) { throw 'HELPER_ACCOUNT_UNVERIFIED' }
  if (-not $ProfilePath -or $ProfilePath -ine ('C:\Users\' + $User)) { throw 'HELPER_PATH_INVALID' }
  $profiles = @(Get-CimInstance -ClassName Win32_UserProfile -Filter ("SID='" + $Sid + "'") -ErrorAction Stop)
  if ($profiles.Count -ne 1 -or [string]$profiles[0].SID -ine $Sid -or
      $profiles[0].Loaded -isnot [bool] -or -not $profiles[0].Loaded -or
      $profiles[0].Special -isnot [bool] -or $profiles[0].Special -or
      [string]$profiles[0].LocalPath -ine $ProfilePath) { throw 'HELPER_PROFILE_UNVERIFIED' }
  $registered = Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $Sid) -ErrorAction Stop
  if ([string]$registered.ProfileImagePath -ine $ProfilePath) { throw 'HELPER_PROFILE_PATH_MISMATCH' }
  $folder = Get-Item -LiteralPath $ProfilePath -Force -ErrorAction Stop
  if (-not $folder.PSIsContainer -or [string]$folder.FullName -ine $ProfilePath -or
      ($folder.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'HELPER_PROFILE_PATH_UNVERIFIED' }
  if (-not (Test-Path -LiteralPath ('Registry::HKEY_USERS\' + $Sid) -ErrorAction Stop)) { throw 'HELPER_HIVE_NOT_LOADED' }
}

function Get-FixerMediaMachineState {
  param([string]$Device, [string]$PolicyName)
  try {
    $policyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy'
    if (Test-Path -LiteralPath $policyPath -ErrorAction Stop) {
      $policy = Get-ItemProperty -LiteralPath $policyPath -ErrorAction Stop
      $property = $policy.PSObject.Properties[$PolicyName]
      if ($null -ne $property -and $property.Value -eq 2) { return 'POLICY-BLOCKED' }
      if ($null -ne $property -and $property.Value -notin @(0, 1)) { return 'UNVERIFIED' }
    }
    $base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\' + $Device
    $parent = [string](Get-ItemProperty -LiteralPath $base -ErrorAction Stop).Value
    $child = [string](Get-ItemProperty -LiteralPath ($base + '\NonPackaged') -ErrorAction Stop).Value
    if ($parent -eq 'Deny' -or $child -eq 'Deny') { return 'MACHINE-BLOCKED' }
    if ($parent -eq 'Allow' -and $child -eq 'Allow') { return 'ALLOW' }
  } catch { return 'UNVERIFIED' }
  return 'UNVERIFIED'
}

function Invoke-FixerMediaConsent {
  param([string]$Sid, [string]$User, [string]$ProfilePath, [string]$Receipt)
  try {
    if ($Receipt -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'RECEIPT_INVALID' }
    Assert-FixerMediaIdentity -Sid $Sid -User $User -ProfilePath $ProfilePath
    $frameState = 'UNVERIFIED'
    try {
      $service = Get-Service -Name FrameServer -ErrorAction Stop
      if ($service.StartType -eq 'Disabled') { $frameState = 'DISABLED' }
      elseif ($service.StartType -in @('Manual', 'Automatic')) { $frameState = 'AVAILABLE' }
    } catch { $frameState = 'UNVERIFIED' }
    Write-Output ('FRAMESERVER_STATE=' + $frameState)
    $results = @{}
    foreach ($device in @(
      @{ Name='webcam'; Prefix='CAM'; Policy='LetAppsAccessCamera' },
      @{ Name='microphone'; Prefix='MIC'; Policy='LetAppsAccessMicrophone' }
    )) {
      $state = Get-FixerMediaMachineState -Device $device.Name -PolicyName $device.Policy
      Write-Output ($device.Prefix + '_MACHINE_STATE=' + $state)
      if ($device.Name -eq 'webcam' -and $state -eq 'ALLOW') {
        if ($frameState -eq 'DISABLED') { $state = 'MACHINE-BLOCKED' }
        elseif ($frameState -ne 'AVAILABLE') { $state = 'UNVERIFIED' }
      }
      $granted = $false
      if ($state -eq 'ALLOW') {
        try {
          foreach ($leaf in @('', '\NonPackaged')) {
            # Re-prove identity and loaded-hive state before each user write.
            Assert-FixerMediaIdentity -Sid $Sid -User $User -ProfilePath $ProfilePath
            $key = 'Registry::HKEY_USERS\' + $Sid + '\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\' + $device.Name + $leaf
            if (-not (Test-Path -LiteralPath $key -ErrorAction Stop)) { New-Item -Path $key -Force -ErrorAction Stop | Out-Null }
            New-ItemProperty -LiteralPath $key -Name Value -PropertyType String -Value Allow -Force -ErrorAction Stop | Out-Null
          }
          Assert-FixerMediaIdentity -Sid $Sid -User $User -ProfilePath $ProfilePath
          $base = 'Registry::HKEY_USERS\' + $Sid + '\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\' + $device.Name
          $granted = ((Get-ItemProperty -LiteralPath $base -ErrorAction Stop).Value -eq 'Allow') -and
            ((Get-ItemProperty -LiteralPath ($base + '\NonPackaged') -ErrorAction Stop).Value -eq 'Allow')
          $state = if ($granted) { 'OK' } else { 'UNVERIFIED' }
        } catch { $state = 'UNVERIFIED' }
      }
      Write-Output ($device.Prefix + '_USER_GRANTED=' + $(if ($granted) { 'YES' } else { 'NO' }))
      $results[$device.Prefix] = $state
    }
    Write-Output ('FIXER_MEDIA_V1=' + $Receipt + '|' + $Sid + '|' + $results.CAM + '|' + $results.MIC)
  } catch { Write-Output ('MEDIA_UNVERIFIED=' + $_.Exception.Message) }
}

Invoke-FixerMediaConsent -Sid $Sid -User $User -ProfilePath $ProfilePath -Receipt $Receipt
