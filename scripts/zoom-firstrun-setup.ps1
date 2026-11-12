# ============================================================
#  zoom-firstrun-setup.ps1
#  Applies the standard Zoom UI toggles for a fresh user profile.
#  Run AS the new user (user1), AFTER signing into Zoom.
#  Double-click the desktop shortcut after Zoom is signed in.
#
#  How it works:
#    - Locates the Zoom main window via UI Automation.
#    - Opens Settings by clicking the gear/Settings control.
#    - For each tab, finds toggles by visible name and flips them
#      to the configured state. Dropdowns are set via SelectionItem.
#    - Closes Settings on completion.
#
#  Maintaining:
#    - Edit the $Settings hashtable below to change toggle states.
#    - If a toggle name in the log says "NOT FOUND", Zoom renamed
#      the UI element - inspect with Accessibility Insights and
#      update the Name string here.
# ============================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ExpectedSid,
    [Parameter(Mandatory=$true)][string]$ExpectedProfilePath
)
$ErrorActionPreference = 'Stop'

function Get-FixerFirstRunIdentity {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $process = [Diagnostics.Process]::GetCurrentProcess()
    try { return @{ Sid=[string]$identity.User.Value; SessionId=$process.SessionId; ProfilePath=[Environment]::GetFolderPath('UserProfile') } }
    finally { $identity.Dispose(); $process.Dispose() }
}

function Assert-FixerFirstRunIdentity {
    param([string]$ExpectedSid, [string]$ExpectedProfilePath)
    if ($ExpectedSid -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$' -or
        $ExpectedProfilePath -ine 'C:\Users\user1') { throw 'HELPER_IDENTITY_INVALID' }
    $identity = Get-FixerFirstRunIdentity
    if ($identity.Sid -ine $ExpectedSid -or $identity.SessionId -isnot [int] -or
        $identity.SessionId -le 0) { throw 'HELPER_SESSION_REQUIRED' }
    $accounts = @(Get-CimInstance -ClassName Win32_UserAccount -Filter ("LocalAccount=True AND SID='" + $ExpectedSid + "'") -ErrorAction Stop)
    if ($accounts.Count -ne 1 -or [string]$accounts[0].SID -ine $ExpectedSid -or
        $accounts[0].LocalAccount -isnot [bool] -or -not $accounts[0].LocalAccount -or
        [string]$accounts[0].Name -cne 'user1' -or
        [string]$accounts[0].Domain -ine [Environment]::MachineName) { throw 'LOCAL_HELPER_REQUIRED' }
    $profile = Get-ItemProperty -LiteralPath ('HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $ExpectedSid) -ErrorAction Stop
    if ([string]$profile.ProfileImagePath -ine $ExpectedProfilePath -or
        [string]$identity.ProfilePath -ine $ExpectedProfilePath) { throw 'HELPER_PROFILE_REQUIRED' }
    return $identity.SessionId
}

# This guard precedes the log file, registry, assembly loads and UI operations.
try { $script:FixerSessionId = Assert-FixerFirstRunIdentity -ExpectedSid $ExpectedSid -ExpectedProfilePath $ExpectedProfilePath }
catch { Write-Output ('FIRST_RUN_REFUSED=' + $_.Exception.Message); exit 1 }

$logFile = Join-Path $env:TEMP "zoom-firstrun-setup.log"
"--- zoom-firstrun-setup started $(Get-Date) ---" | Out-File -FilePath $logFile

function Log {
    param([string]$Message)
    "$((Get-Date).ToString('HH:mm:ss')) $Message" | Out-File -FilePath $logFile -Append
    Write-Host $Message
}

# ----------------------------------------------------------------
# Media consent is owned by grant-media-consent.ps1. This manual helper
# changes Zoom settings only, after proving the exact helper session.
# ----------------------------------------------------------------
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# ----------------------------------------------------------------
# Desired settings keyed by visible UI name.
# $true / $false  -> toggle/checkbox target state
# 'string'         -> ComboBox / dropdown text to select
# 'radio'          -> radio button to select (treated like a click)
# ----------------------------------------------------------------
$DesiredToggles = @{
    # General
    'Auto-start Zoom Workplace'                                  = $false
    'Update app automatically'                                   = $false

    # Video & effects
    'HD'                                                         = $false
    'Original ratio'                                             = $false
    'Mirror my video preview'                                    = $false
    'Touch up my appearance'                                     = $false

    # Audio
    'Spatial audio'                                              = $false
    'Hear incoming call ringtones on an additional device'       = $false
    'Automatically adjust microphone volume'                     = $false
    'High-fidelity music mode'                                   = $false
    # 'Echo cancellation' is a DROPDOWN (Auto/Low/Medium/High), handled in
    # $DesiredDropdowns below. Listing it here too made the toggle pass log a
    # misleading "FAILED (no Toggle pattern): Echo cancellation" every run.
    'Stereo audio'                                               = $true
    'Live performance audio'                                     = $false
    'Automatically sync headset buttons'                         = $false

    # Meetings & webinars
    'Show video preview first'                                   = $true
    'Keep my camera off'                                         = $false
    'Keep my microphone muted'                                   = $true
    'Automatically connect to computer audio'                    = $true
    'Enter full screen automatically'                            = $false
    'Use dual monitors'                                          = $true
    'Keep participant names visible'                             = $true
    'Show meeting timer'                                         = $true
    'Show participant profile pictures in chat'                  = $true
    'Press and hold "Space" key to temporarily unmute yourself'  = $true
    'Play audio chime for mute/unmute'                           = $false
    'Automatically copy invite link to clipboard'                = $false
    'Hide your own video from the video gallery'                 = $false
    'Show me as an active speaker when I talk'                   = $false
    'Show non-video participants'                                = $true
    'Show reactions above toolbar'                               = $false
    'Animate emojis'                                             = $false
    'Ask me to confirm when leaving'                             = $true
    'Enable stop incoming video feature'                         = $true
    'Do not automatically end meetings after inactivity'         = $false
    'Optimize incoming video quality with super resolution'      = $true
    'Optimize outgoing video quality with de-noise'              = $true
}

# Dropdowns (combo boxes) keyed by visible name
$DesiredDropdowns = @{
    'Echo cancellation'                              = 'Low'
    'Windows system audio enhancements'              = 'Off'
    'Signal processing by Windows audio device drivers' = 'Off'
    'Audio capture and playback API'                 = 'Windows Audio Session API'
    'Video rendering method'                         = 'Auto'
    'Video rendering post-processing'                = 'Auto'
    'Video capturing method'                         = 'Auto'
    'Color mode'                                     = 'Dark'
}

# Radio buttons (within a group, pick one)
$DesiredRadios = @(
    'Original sound for musicians'   # Microphone modes
    '25 participants'                # Maximum participants per screen
)

# ----------------------------------------------------------------
# UI Automation helpers
# ----------------------------------------------------------------
$UIA = [System.Windows.Automation.AutomationElement]
$Tree = [System.Windows.Automation.TreeScope]::Descendants

function Assert-FixerZoomProcess {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { throw 'ZOOM_PROCESS_REQUIRED' }
    $candidates = @(Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId=" + $ProcessId) -ErrorAction Stop)
    if ($candidates.Count -ne 1 -or [int]$candidates[0].ProcessId -ne $ProcessId -or
        [string]$candidates[0].Name -ine 'Zoom.exe' -or
        ($candidates[0].SessionId -isnot [uint32] -and $candidates[0].SessionId -isnot [int])) { throw 'ZOOM_PROCESS_UNVERIFIED' }
    if ([int]$candidates[0].SessionId -ne $script:FixerSessionId) { throw 'ZOOM_SESSION_MISMATCH' }
    $owner = Invoke-CimMethod -InputObject $candidates[0] -MethodName GetOwnerSid -ErrorAction Stop
    if ($null -eq $owner -or $owner.ReturnValue -ne 0 -or [string]$owner.Sid -ine $ExpectedSid) { throw 'ZOOM_OWNER_MISMATCH' }
}

function Assert-FixerZoomElement {
    param($Element)
    if ($null -eq $Element) { throw 'ZOOM_ELEMENT_REQUIRED' }
    Assert-FixerZoomProcess -ProcessId ([int]$Element.Current.ProcessId)
}

function Find-ByName {
    param($Root, [string]$Name)
    $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $Name)
    return $Root.FindFirst($Tree, $cond)
}

function Find-AllByName {
    param($Root, [string]$Name)
    $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $Name)
    return $Root.FindAll($Tree, $cond)
}

function Invoke-Element {
    param($Element)
    Assert-FixerZoomElement $Element
    try {
        $pat = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pat.Invoke()
        return $true
    } catch {
        try {
            Assert-FixerZoomElement $Element
            $pat = $Element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $pat.Select()
            return $true
        } catch {
            return $false
        }
    }
}

function Set-Toggle {
    param($Element, [bool]$Desired)
    Assert-FixerZoomElement $Element
    try {
        $pat = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        $current = $pat.Current.ToggleState
        if (($current -eq 'On' -and -not $Desired) -or ($current -eq 'Off' -and $Desired)) {
            $pat.Toggle()
        }
        return $true
    } catch {
        return $false
    }
}

function Set-ComboValue {
    param($Element, [string]$Value)
    Assert-FixerZoomElement $Element
    try {
        $expand = $Element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $expand.Expand()
        Start-Sleep -Milliseconds 300
        $item = Find-ByName -Root $Element -Name $Value
        if ($item) {
            Assert-FixerZoomElement $item
            $sel = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $sel.Select()
            Assert-FixerZoomElement $Element
            $expand.Collapse()
            return $true
        }
        Assert-FixerZoomElement $Element
        $expand.Collapse()
    } catch {}
    return $false
}

# ----------------------------------------------------------------
# Locate Zoom and open Settings
# ----------------------------------------------------------------
function Wait-ZoomMainWindow {
    param([int]$TimeoutSec = 60)
    Log "Waiting for Zoom main window (up to ${TimeoutSec}s)..."
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $matches = @()
        foreach ($candidate in @(Get-CimInstance -ClassName Win32_Process -Filter "Name='Zoom.exe'" -ErrorAction Stop)) {
            if ([int]$candidate.SessionId -ne $script:FixerSessionId) { continue }
            $owner = Invoke-CimMethod -InputObject $candidate -MethodName GetOwnerSid -ErrorAction Stop
            if ($owner.ReturnValue -ne 0 -or [string]$owner.Sid -ine $ExpectedSid) { continue }
            $process = Get-Process -Id $candidate.ProcessId -ErrorAction Stop
            try {
                if ($process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
                Assert-FixerZoomProcess -ProcessId $candidate.ProcessId
                $window = $UIA::FromHandle($process.MainWindowHandle)
                Assert-FixerZoomElement $window
                $matches += $window
            } finally { $process.Dispose() }
        }
        if ($matches.Count -gt 1) { throw 'ZOOM_WINDOW_AMBIGUOUS' }
        if ($matches.Count -eq 1) { return $matches[0] }
        Start-Sleep -Seconds 1
    }
    return $null
}

function Open-ZoomSettings {
    param($ZoomWindow)
    Assert-FixerZoomElement $ZoomWindow
    Log "Opening Settings dialog..."
    $settingsBtn = Find-ByName -Root $ZoomWindow -Name 'Settings'
    if ($settingsBtn -and (Invoke-Element $settingsBtn)) {
        Start-Sleep -Seconds 2
    } else {
        Log "Settings button unavailable; no keyboard fallback was sent."
        return $null
    }
    # Settings can be a separate top-level window. Match its exact Zoom PID,
    # then re-prove the helper owner/session before returning any UI target.
    $condition = [System.Windows.Automation.AndCondition]::new(
        [System.Windows.Automation.PropertyCondition]::new($UIA::NameProperty, 'Settings'),
        [System.Windows.Automation.PropertyCondition]::new($UIA::ProcessIdProperty, [int]$ZoomWindow.Current.ProcessId))
    $windows = ($UIA::RootElement).FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    if ($windows.Count -ne 1) { return $null }
    Assert-FixerZoomElement $windows[0]
    return $windows[0]
}

# ----------------------------------------------------------------
# Main flow
# ----------------------------------------------------------------
$zoomWindow = Wait-ZoomMainWindow -TimeoutSec 60
if (-not $zoomWindow) {
    Log "ERROR: Could not find Zoom main window. Sign into Zoom first, then re-run."
    exit 1
}

$settingsWin = Open-ZoomSettings -ZoomWindow $zoomWindow
if (-not $settingsWin) {
    Log "ERROR: Could not open Zoom Settings dialog."
    exit 1
}
Log "Settings dialog open."

# Apply toggles
Log "Applying toggle settings ($($DesiredToggles.Count) entries)..."
foreach ($name in $DesiredToggles.Keys) {
    $desired = $DesiredToggles[$name]
    $elems = Find-AllByName -Root $settingsWin -Name $name
    if ($elems.Count -eq 0) {
        Log "  NOT FOUND: $name"
        continue
    }
    $applied = $false
    foreach ($e in $elems) {
        if (Set-Toggle -Element $e -Desired $desired) {
            $applied = $true
            break
        }
    }
    if ($applied) { Log "  $name = $desired" } else { Log "  FAILED (no Toggle pattern): $name" }
}

# Apply dropdowns
Log "Applying dropdown settings ($($DesiredDropdowns.Count) entries)..."
foreach ($name in $DesiredDropdowns.Keys) {
    $value = $DesiredDropdowns[$name]
    $elems = Find-AllByName -Root $settingsWin -Name $name
    if ($elems.Count -eq 0) {
        Log "  NOT FOUND: $name"
        continue
    }
    $applied = $false
    foreach ($e in $elems) {
        if (Set-ComboValue -Element $e -Value $value) {
            $applied = $true
            break
        }
    }
    if ($applied) { Log "  $name -> $value" } else { Log "  FAILED (no Combo): $name" }
}

# Apply radios
Log "Applying radio selections ($($DesiredRadios.Count) entries)..."
foreach ($name in $DesiredRadios) {
    $e = Find-ByName -Root $settingsWin -Name $name
    if (-not $e) {
        Log "  NOT FOUND: $name"
        continue
    }
    if (Invoke-Element $e) { Log "  selected: $name" } else { Log "  FAILED: $name" }
}

# Close the Settings window
$closeBtn = Find-ByName -Root $settingsWin -Name 'Close'
if ($closeBtn) {
    Invoke-Element $closeBtn | Out-Null
    Log "Settings dialog closed."
}

Log "First-run setup complete. Log: $logFile"
