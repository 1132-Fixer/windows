<#
.SYNOPSIS
  Grant camera + microphone consent for a freshly created local user so that
  desktop (non-packaged) apps such as Zoom can access them under that user
  without manual Settings -> Privacy trips.

.DESCRIPTION
  Writes the Windows CapabilityAccessManager ConsentStore values that govern
  device access for the "Let desktop apps access ..." Settings toggle. Both
  per-user (HKU\<SID>) and machine (HKLM) surfaces are set so that:

    - HKLM acts as the device-wide floor (HKLM Deny cannot be overridden
      upward by HKCU; setting Allow here ensures no machine-wide block).
    - HKU\<SID> is the per-user "Let desktop apps access camera/microphone"
      toggle that Zoom actually reads.

  Group Policy LetAppsAccess{Camera,Microphone}=2 (Force Deny) takes
  precedence over the registry — the script detects this and emits a
  diagnostic line instead of silently writing dead values.

  The script also unblocks the FrameServer service when it is Disabled
  (default StartType is Manual; without it, no desktop app can enumerate
  cameras even with consent granted).

.PARAMETER Sid
  SID of the local user to grant consent for. If omitted, only HKLM keys
  are written and per-user keys are skipped (diagnostic emitted).

.PARAMETER User
  Display name of the user — used for diagnostic output and for resolving
  the profile NTUSER.DAT path when HKU hive is not loaded.

.PARAMETER ProfilePath
  Optional explicit profile path (e.g. 'C:\Users\user1'). If supplied and
  the HKU\<SID> hive is not currently loaded, the script will attempt
  `reg load` against this profile's NTUSER.DAT, write consent, then
  `reg unload`. If omitted, the script will fall back to ProfileList lookup
  by SID.

.OUTPUTS
  Emits structured KEY=VALUE lines on stdout that the calling Electron
  process parses:

    CAM_USER_GRANTED=YES|NO
    MIC_USER_GRANTED=YES|NO
    CAM_HKLM_GRANTED=YES|NO
    MIC_HKLM_GRANTED=YES|NO
    GPO_DENY_CAMERA           (only if camera GPO == 2)
    GPO_DENY_MICROPHONE       (only if mic    GPO == 2)
    HKU_ALREADY_LOADED=YES    (hive was already loaded — no temp load)
    HKU_LOADED_TEMP=YES       (we loaded the hive ourselves)
    HKU_LOAD_FAILED=<reason>  (we needed to load it but could not)
    HKU_UNLOAD_OK=YES         (cleanup of our temp load succeeded)
    HKU_UNLOAD_FAILED=<reason>(cleanup failed — hive may remain loaded)
    HKU_NOT_LOADED            (legacy marker — still emitted if hive was
                               not loaded and we did not load it ourselves)
    FRAMESERVER_DISABLED      (only if FrameServer is Disabled and could
                               not be re-enabled)
    FRAMESERVER_RESTORED      (FrameServer was Disabled, bumped to Manual)
    FRAMESERVER_MISSING       (FrameServer service not present)
    HKLM_WRITE_FAIL=<device>:<msg>
    HKU_WRITE_FAIL=<device>:<msg>
    ERROR=<message>           (any fatal exception)
#>
[CmdletBinding()]
param(
  [string] $Sid         = '',
  [string] $User        = 'user1',
  [string] $ProfilePath = ''
)

# Use 'Continue' globally — we want to keep going on individual write
# failures and emit structured markers per-device, not abort the whole
# script. Cmdlets that need fail-fast use -ErrorAction Stop locally.
$ErrorActionPreference = 'Continue'
# In PS 7.4+, $PSNativeCommandUseErrorActionPreference defaults to $true,
# which makes any nonzero exit from reg.exe / etc. throw under
# $ErrorActionPreference='Stop'. We explicitly opt out so a reg query
# miss is just a nonzero $LASTEXITCODE, not a thrown exception that we
# can't distinguish from real failures.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $Global:PSNativeCommandUseErrorActionPreference = $false
}

function Set-Consent {
  # -EA Stop so the surrounding try/catch in the device-write loop can
  # convert a write failure into a structured HKLM_WRITE_FAIL / HKU_WRITE_FAIL
  # marker instead of letting it leak to stderr (which the calling
  # Electron process would surface as a user-visible warning).
  param([Parameter(Mandatory)][string] $Path)
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force -ErrorAction Stop | Out-Null }
  New-ItemProperty -Path $Path -Name 'Value' -PropertyType String -Value 'Allow' -Force -ErrorAction Stop | Out-Null
}

function Test-ConsentValue {
  param([Parameter(Mandatory)][string] $Path)
  try {
    $v = (Get-ItemProperty -Path $Path -Name 'Value' -ErrorAction Stop).Value
    return ($v -eq 'Allow')
  } catch {
    return $false
  }
}

try {
  # ----- GPO check -----
  # HKLM\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy
  #   LetAppsAccessCamera     (REG_DWORD) 1 = Force Allow, 2 = Force Deny, 0 = User in control
  #   LetAppsAccessMicrophone (REG_DWORD) same
  # Force Deny (2) makes registry writes a no-op.
  $gpoBase = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppPrivacy'
  $camGpo = $null; $micGpo = $null
  if (Test-Path $gpoBase) {
    try { $camGpo = (Get-ItemProperty -Path $gpoBase -Name LetAppsAccessCamera     -ErrorAction SilentlyContinue).LetAppsAccessCamera } catch {}
    try { $micGpo = (Get-ItemProperty -Path $gpoBase -Name LetAppsAccessMicrophone -ErrorAction SilentlyContinue).LetAppsAccessMicrophone } catch {}
  }
  $camGpoDeny = ($camGpo -eq 2)
  $micGpoDeny = ($micGpo -eq 2)
  if ($camGpoDeny) { Write-Output 'GPO_DENY_CAMERA' }
  if ($micGpoDeny) { Write-Output 'GPO_DENY_MICROPHONE' }

  # ----- HKU hive availability -----
  # If hive is already loaded (target user has an active session — Zoom
  # running as user1 = typical case), write directly.
  # If not loaded, attempt explicit `reg load HKU\<sid> NTUSER.DAT` against
  # the target profile's hive file, write under that key, then unload on
  # exit. This eliminates the HKU race when the main fix runs before the
  # user1 logon session is fully established.
  $hkuLoaded     = $false
  $hkuLoadedHere = $false   # true only if WE loaded it (we must unload)
  if ($Sid) {
    $null = reg query "HKU\$Sid" 2>$null
    if ($LASTEXITCODE -eq 0) { $hkuLoaded = $true }
  }
  if ($hkuLoaded) {
    Write-Output 'HKU_ALREADY_LOADED=YES'
  } else {
    # Resolve profile path: explicit param > ProfileList lookup.
    $resolvedProfilePath = $ProfilePath
    if (-not $resolvedProfilePath -and $Sid) {
      $plKey = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$Sid"
      try {
        $resolvedProfilePath = (Get-ItemProperty -Path $plKey -ErrorAction SilentlyContinue).ProfileImagePath
      } catch {}
    }
    if (-not $resolvedProfilePath -and $User) {
      $resolvedProfilePath = "C:\Users\$User"
    }
    $ntUser = if ($resolvedProfilePath) { Join-Path $resolvedProfilePath 'NTUSER.DAT' } else { '' }
    if ($Sid -and $ntUser -and [System.IO.File]::Exists($ntUser)) {
      # `reg load` writes NTUSER.DAT to the live registry under HKU\<key>.
      # On success the NTUSER.DAT file is opened with an exclusive handle
      # until `reg unload` runs — so we MUST unload in the finally clause.
      $loadResult = & reg.exe load "HKU\$Sid" "$ntUser" 2>&1
      if ($LASTEXITCODE -eq 0) {
        $hkuLoaded     = $true
        $hkuLoadedHere = $true
        Write-Output 'HKU_LOADED_TEMP=YES'
      } else {
        Write-Output ('HKU_LOAD_FAILED=' + (($loadResult -join ' ').Trim()))
        Write-Output 'HKU_NOT_LOADED'
      }
    } else {
      $why = if (-not $Sid) { 'no SID supplied' }
             elseif (-not $ntUser) { 'no profile path resolved' }
             else { "NTUSER.DAT not found at $ntUser" }
      Write-Output ('HKU_LOAD_FAILED=' + $why)
      Write-Output 'HKU_NOT_LOADED'
    }
  }

  try {
    # ----- Per-device consent writes -----
    $results = @{
      cam_user = $false; mic_user = $false
      cam_hklm = $false; mic_hklm = $false
    }
    $devices = @(
      @{ Name = 'webcam';     Gpo = $camGpoDeny; UserKey = 'cam_user'; MachineKey = 'cam_hklm' },
      @{ Name = 'microphone'; Gpo = $micGpoDeny; UserKey = 'mic_user'; MachineKey = 'mic_hklm' }
    )

    foreach ($d in $devices) {
      if ($d.Gpo) { continue }
      $name = $d.Name

      # HKLM floor — always attempt, even if HKU hive missing.
      try {
        $hklmParent = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\$name"
        $hklmChild  = "$hklmParent\NonPackaged"
        Set-Consent $hklmParent
        Set-Consent $hklmChild
        $results[$d.MachineKey] = (Test-ConsentValue $hklmParent) -and (Test-ConsentValue $hklmChild)
      } catch {
        Write-Output ("HKLM_WRITE_FAIL=" + $name + ":" + $_.Exception.Message)
      }

      # HKU per-user consent — required for the actual "Let desktop apps"
      # toggle the user sees in Settings.
      if ($hkuLoaded) {
        try {
          $hkuParent = "Registry::HKEY_USERS\$Sid\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\$name"
          $hkuChild  = "$hkuParent\NonPackaged"
          Set-Consent $hkuParent
          Set-Consent $hkuChild
          $results[$d.UserKey] = (Test-ConsentValue $hkuParent) -and (Test-ConsentValue $hkuChild)
        } catch {
          Write-Output ("HKU_WRITE_FAIL=" + $name + ":" + $_.Exception.Message)
        }
      }
    }

    Write-Output ("CAM_USER_GRANTED=" + ($(if ($results.cam_user) { 'YES' } else { 'NO' })))
    Write-Output ("MIC_USER_GRANTED=" + ($(if ($results.mic_user) { 'YES' } else { 'NO' })))
    Write-Output ("CAM_HKLM_GRANTED=" + ($(if ($results.cam_hklm) { 'YES' } else { 'NO' })))
    Write-Output ("MIC_HKLM_GRANTED=" + ($(if ($results.mic_hklm) { 'YES' } else { 'NO' })))
  }
  finally {
    # Always unload if we loaded — otherwise NTUSER.DAT stays open and the
    # next sign-in / profile delete fails with file-in-use.
    if ($hkuLoadedHere) {
      # PowerShell may hold a RegistryKey handle under the loaded hive
      # (Get-ItemProperty / New-ItemProperty cache). Force a GC so reg
      # unload doesn't fail with "process cannot access the file".
      [GC]::Collect(); [GC]::WaitForPendingFinalizers()
      $unloadResult = & reg.exe unload "HKU\$Sid" 2>&1
      if ($LASTEXITCODE -eq 0) {
        Write-Output 'HKU_UNLOAD_OK=YES'
      } else {
        Write-Output ('HKU_UNLOAD_FAILED=' + (($unloadResult -join ' ').Trim()))
      }
    }
  }

  # ----- FrameServer service -----
  # Default StartType is Manual (trigger-start). If a previous "privacy
  # hardening" script set it to Disabled, no desktop app can enumerate
  # cameras even with consent granted. We only bump from Disabled; we do
  # not change Manual -> Automatic.
  $svc = Get-Service -Name FrameServer -ErrorAction SilentlyContinue
  if ($svc) {
    if ($svc.StartType -eq 'Disabled') {
      try {
        Set-Service -Name FrameServer -StartupType Manual -ErrorAction Stop
        Write-Output 'FRAMESERVER_RESTORED'
      } catch {
        Write-Output 'FRAMESERVER_DISABLED'
      }
    }
  } else {
    Write-Output 'FRAMESERVER_MISSING'
  }
} catch {
  Write-Output ("ERROR=" + $_.Exception.Message)
  exit 1
}
