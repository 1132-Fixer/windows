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

$ErrorActionPreference = 'Continue'
$logFile = Join-Path $env:TEMP "zoom-firstrun-setup.log"
"--- zoom-firstrun-setup started $(Get-Date) ---" | Out-File -FilePath $logFile

function Log {
    param([string]$Message)
    "$((Get-Date).ToString('HH:mm:ss')) $Message" | Out-File -FilePath $logFile -Append
    Write-Host $Message
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

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
    'Echo cancellation'                                          = $true
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
    try {
        $pat = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pat.Invoke()
        return $true
    } catch {
        try {
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
    try {
        $expand = $Element.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        $expand.Expand()
        Start-Sleep -Milliseconds 300
        $item = Find-ByName -Root $Element -Name $Value
        if ($item) {
            $sel = $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $sel.Select()
            $expand.Collapse()
            return $true
        }
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
        $root = $UIA::RootElement
        $candidates = @('Zoom Workplace', 'Zoom')
        foreach ($n in $candidates) {
            $w = Find-ByName -Root $root -Name $n
            if ($w) {
                Log "Found Zoom window: '$n'"
                return $w
            }
        }
        Start-Sleep -Seconds 1
    }
    return $null
}

function Open-ZoomSettings {
    param($ZoomWindow)
    Log "Opening Settings dialog..."
    $settingsBtn = Find-ByName -Root $ZoomWindow -Name 'Settings'
    if ($settingsBtn -and (Invoke-Element $settingsBtn)) {
        Start-Sleep -Seconds 2
    } else {
        Log "Settings button not found via UIA - falling back to Ctrl+,"
        [System.Windows.Forms.SendKeys]::SendWait("^,")
        Start-Sleep -Seconds 2
    }
    $root = $UIA::RootElement
    return Find-ByName -Root $root -Name 'Settings'
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
