<#
Zoom-Toolkit.ps1
All-in-one Zoom cleanup toolkit:
- Best-effort uninstall (Installer.exe + MSI GUID uninstall)
- MSI product code cleanup (registry-based GUID enumeration)
- Deep wipe (folders, registry keys, caches, creds, firewall, prefetch, DNS)
- Optional reinstall (download latest Zoom MSI and install)

Designed to be run as Administrator. If not elevated, it will relaunch itself as admin.

Usage:
  .\Zoom-Toolkit.ps1 -DoAll
  .\Zoom-Toolkit.ps1 -DoAll -Reinstall
  .\Zoom-Toolkit.ps1 -DoAll -WhatIf
#>

[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [switch]$DoAll,
  [switch]$Reinstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Self-elevate if needed
if (-not (Test-IsAdmin)) {
  $argsList = @()
  if ($DoAll)     { $argsList += "-DoAll" }
  if ($Reinstall) { $argsList += "-Reinstall" }

  # NOTE: the `@(...) + $argsList` MUST be wrapped in parentheses. Without them
  # PowerShell binds only the literal array to -ArgumentList and then parses the
  # bare `+` as a positional argument, throwing "A positional parameter cannot be
  # found that accepts argument '+'." — so the UAC relaunch never happens and
  # -DoAll/-Reinstall are silently dropped.
  Start-Process -FilePath "powershell.exe" -Verb RunAs -WindowStyle Normal -ArgumentList (@(
    "-NoProfile","-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`""
  ) + $argsList)
  exit
}

# --- Reporting ---
$scriptDir = Split-Path -Parent $PSCommandPath
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$reportDir = Join-Path $scriptDir ("Reports\ZoomToolkit_{0}" -f $ts)
New-Item -ItemType Directory -Path $reportDir -Force | Out-Null

$transcript = Join-Path $reportDir "Transcript.txt"
$reportTxt  = Join-Path $reportDir "Report.txt"
$reportJson = Join-Path $reportDir "Report.json"

try { Start-Transcript -Path $transcript -Force | Out-Null } catch { }

$Report = [ordered]@{
  Started      = (Get-Date).ToString("o")
  ComputerName = $env:COMPUTERNAME
  User         = $env:USERNAME
  Admin        = $true
  Options      = @{
    DoAll     = [bool]$DoAll
    Reinstall = [bool]$Reinstall
    WhatIf    = [bool]$WhatIfPreference
  }
  Findings = [ordered]@{
    MsiProducts    = @()
    Uninstallers   = @()
    Processes      = @()
    Services       = @()
    ScheduledTasks = @()
    RegistryKeys   = @()
    RegistryValues = @()
    Credentials    = @()
    Folders        = @()
    Files          = @()
    FirewallRules  = @()
    PrefetchFiles  = @()
  }
  Actions = @()
  Errors  = @()
  Finished = $null
}

function Add-Action([string]$Type,[string]$Target,[string]$Result,[string]$Detail="") {
  $Report.Actions += [ordered]@{
    Time   = (Get-Date).ToString("o")
    Type   = $Type
    Target = $Target
    Result = $Result
    Detail = $Detail
  }
}

function Add-Error([string]$Where,[string]$Message) {
  $Report.Errors += [ordered]@{
    Time    = (Get-Date).ToString("o")
    Where   = $Where
    Message = $Message
  }
}

function Try-Run([string]$Label,[scriptblock]$Block) {
  try { & $Block } catch { Add-Error $Label $_.Exception.Message }
}

function Exists-Path([string]$p) { return (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue) }

function Remove-PathSafe([string]$p, [string]$type="Path") {
  if (-not (Exists-Path $p)) { return }
  if ($PSCmdlet.ShouldProcess($p,"Remove")) {
    Try-Run "Remove $type" {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction Stop
      Add-Action "Remove$type" $p "Removed"
    }
  } else {
    Add-Action "Remove$type" $p "WhatIf/Skipped"
  }
}

function Stop-ProcessSafe([string]$name) {
  $procs = Get-Process -Name $name -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $path = $null
    try { $path = $p.Path } catch { }
    $Report.Findings.Processes += [ordered]@{ Name=$p.Name; Id=$p.Id; Path=$path }
    if ($PSCmdlet.ShouldProcess("$($p.Name) PID $($p.Id)","Stop-Process")) {
      Try-Run "Stop-Process $name" {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        Add-Action "StopProcess" "$($p.Name) PID $($p.Id)" "Stopped"
      }
    } else {
      Add-Action "StopProcess" "$($p.Name) PID $($p.Id)" "WhatIf/Skipped"
    }
  }
}

function Remove-ServiceSafe([string]$svcName) {
  $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
  if (-not $svc) { return }
  $Report.Findings.Services += [ordered]@{ Name=$svc.Name; DisplayName=$svc.DisplayName; Status=$svc.Status.ToString() }

  if ($svc.Status -ne "Stopped") {
    if ($PSCmdlet.ShouldProcess("Service $svcName","Stop-Service")) {
      Try-Run "Stop-Service $svcName" {
        Stop-Service -Name $svcName -Force -ErrorAction Stop
        Add-Action "StopService" $svcName "Stopped"
      }
    } else {
      Add-Action "StopService" $svcName "WhatIf/Skipped"
    }
  }

  if ($PSCmdlet.ShouldProcess("Service $svcName","Delete service")) {
    Try-Run "Delete service $svcName" {
      & sc.exe delete $svcName | Out-Null
      Add-Action "DeleteService" $svcName "Deleted"
    }
  } else {
    Add-Action "DeleteService" $svcName "WhatIf/Skipped"
  }
}

function Remove-TaskSafe {
  $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
    $_.TaskName -like "*Zoom*" -or $_.TaskPath -like "*Zoom*"
  }
  foreach ($t in $tasks) {
    $Report.Findings.ScheduledTasks += [ordered]@{ TaskName=$t.TaskName; TaskPath=$t.TaskPath }
    if ($PSCmdlet.ShouldProcess("$($t.TaskPath)$($t.TaskName)","Unregister-ScheduledTask")) {
      Try-Run "Unregister task $($t.TaskName)" {
        Unregister-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Confirm:$false -ErrorAction Stop
        Add-Action "DeleteTask" "$($t.TaskPath)$($t.TaskName)" "Deleted"
      }
    } else {
      Add-Action "DeleteTask" "$($t.TaskPath)$($t.TaskName)" "WhatIf/Skipped"
    }
  }
}

function Remove-RegKeySafe([string]$keyPath) {
  if (-not (Test-Path $keyPath -ErrorAction SilentlyContinue)) { return }
  $Report.Findings.RegistryKeys += $keyPath
  if ($PSCmdlet.ShouldProcess($keyPath,"Remove-Item (registry key)")) {
    Try-Run "Remove reg key $keyPath" {
      Remove-Item -Path $keyPath -Recurse -Force -ErrorAction Stop
      Add-Action "DeleteRegKey" $keyPath "Deleted"
    }
  } else {
    Add-Action "DeleteRegKey" $keyPath "WhatIf/Skipped"
  }
}

function Remove-RegValueSafe([string]$keyPath, [string]$valueName) {
  if (-not (Test-Path $keyPath -ErrorAction SilentlyContinue)) { return }
  $val = Get-ItemProperty -Path $keyPath -Name $valueName -ErrorAction SilentlyContinue
  if ($null -eq $val) { return }
  $Report.Findings.RegistryValues += [ordered]@{ Key=$keyPath; Value=$valueName }
  if ($PSCmdlet.ShouldProcess("$keyPath\$valueName","Remove-ItemProperty")) {
    Try-Run "Remove reg value $keyPath $valueName" {
      Remove-ItemProperty -Path $keyPath -Name $valueName -ErrorAction Stop
      Add-Action "DeleteRegValue" "$keyPath\$valueName" "Deleted"
    }
  } else {
    Add-Action "DeleteRegValue" "$keyPath\$valueName" "WhatIf/Skipped"
  }
}

function Remove-CredSafe([string]$target) {
  $list = (& cmdkey /list 2>$null) -join "`n"
  if ($list -notmatch [regex]::Escape($target)) { return }
  $Report.Findings.Credentials += $target
  if ($PSCmdlet.ShouldProcess("Credential $target","cmdkey /delete")) {
    Try-Run "cmdkey delete $target" {
      & cmdkey /delete:$target | Out-Null
      Add-Action "DeleteCredential" $target "Deleted"
    }
  } else {
    Add-Action "DeleteCredential" $target "WhatIf/Skipped"
  }
}

function Remove-FirewallZoomRules {
  $rules = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*Zoom*" }
  foreach ($r in $rules) {
    $Report.Findings.FirewallRules += $r.DisplayName
    if ($PSCmdlet.ShouldProcess($r.DisplayName,"Remove-NetFirewallRule")) {
      Try-Run "Remove firewall rule $($r.DisplayName)" {
        $r | Remove-NetFirewallRule -ErrorAction Stop
        Add-Action "DeleteFirewallRule" $r.DisplayName "Deleted"
      }
    } else {
      Add-Action "DeleteFirewallRule" $r.DisplayName "WhatIf/Skipped"
    }
  }
}

function Remove-PrefetchZoom {
  $prefetch = "C:\Windows\Prefetch"
  if (-not (Test-Path $prefetch -ErrorAction SilentlyContinue)) { return }
  $files = @()
  $files += Get-ChildItem $prefetch -Filter "*ZOOM*" -ErrorAction SilentlyContinue
  $files += Get-ChildItem $prefetch -Filter "*CPT*"  -ErrorAction SilentlyContinue
  $files = $files | Sort-Object FullName -Unique
  foreach ($f in $files) {
    $Report.Findings.PrefetchFiles += $f.FullName
    if ($PSCmdlet.ShouldProcess($f.FullName,"Remove-Item (prefetch)")) {
      Try-Run "Remove prefetch $($f.FullName)" {
        Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop
        Add-Action "DeletePrefetch" $f.FullName "Deleted"
      }
    } else {
      Add-Action "DeletePrefetch" $f.FullName "WhatIf/Skipped"
    }
  }
}

function Flush-DnsSafe {
  if ($PSCmdlet.ShouldProcess("DNS cache","ipconfig /flushdns")) {
    Try-Run "Flush DNS" {
      & ipconfig /flushdns | Out-Null
      Add-Action "FlushDNS" "ipconfig /flushdns" "Done"
    }
  } else {
    Add-Action "FlushDNS" "ipconfig /flushdns" "WhatIf/Skipped"
  }
}

function Invoke-UninstallZoom_InstallerExe {
  $candidateInstaller = @(
    "C:\Program Files\Zoom\bin\Installer.exe",
    "C:\Program Files (x86)\Zoom\bin\Installer.exe"
  ) | Where-Object { Test-Path $_ -ErrorAction SilentlyContinue }

  foreach ($inst in $candidateInstaller) {
    $Report.Findings.Uninstallers += [ordered]@{ Method="Installer.exe"; Path=$inst; Args="/uninstall" }
    if ($PSCmdlet.ShouldProcess($inst,"Run /uninstall")) {
      Try-Run "Run Zoom Installer.exe uninstall" {
        Start-Process -FilePath $inst -ArgumentList "/uninstall" -Wait -WindowStyle Hidden
        Add-Action "Uninstall" $inst "Attempted" "/uninstall"
      }
    } else {
      Add-Action "Uninstall" $inst "WhatIf/Skipped" "/uninstall"
    }
  }
}

function Get-ZoomMsiGuidsFromRegistry {
  $roots = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  $out = New-Object System.Collections.Generic.List[object]
  foreach ($root in $roots) {
    if (-not (Test-Path $root -ErrorAction SilentlyContinue)) { continue }
    Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PsPath -ErrorAction SilentlyContinue
      if (-not $p) { return }
      if (-not $p.DisplayName) { return }
      if ($p.DisplayName -notmatch "Zoom") { return }
      $u = $p.UninstallString
      if (-not $u) { return }
      $m = [regex]::Match($u, "\{[0-9A-Fa-f\-]{36}\}")
      if ($m.Success) {
        $out.Add([pscustomobject]@{
          DisplayName     = $p.DisplayName
          Publisher       = $p.Publisher
          Version         = $p.DisplayVersion
          Guid            = $m.Value
          UninstallString = $u
        })
      }
    }
  }
  return $out | Sort-Object Guid -Unique
}

function Uninstall-ZoomMsiGuids([object[]]$items) {
  foreach ($it in $items) {
    $Report.Findings.MsiProducts += [ordered]@{
      DisplayName = $it.DisplayName
      Version     = $it.Version
      Guid        = $it.Guid
      UninstallString = $it.UninstallString
    }
    $guid = $it.Guid
    $cmd = "msiexec /x $guid /qn /norestart"
    if ($PSCmdlet.ShouldProcess($guid,"MSI uninstall")) {
      Try-Run "MSI uninstall $($it.DisplayName)" {
        Start-Process -FilePath "msiexec.exe" -ArgumentList @("/x", $guid, "/qn", "/norestart") -Wait -WindowStyle Hidden
        Add-Action "MSIUninstall" $guid "Attempted" $it.DisplayName
      }
    } else {
      Add-Action "MSIUninstall" $guid "WhatIf/Skipped" $it.DisplayName
    }
  }
}

function DeepWipe-Zoom {
  Add-Action "Phase" "DeepWipe" "Begin" ""

  # Processes (from reference list + common)
  $processNames = @(
    "Zoom","Zoomus","Zoom_launcher","ZoomHybridConf","zSafeChecker",
    "CptHost","CptService","CptControl","CptInstall",
    "zcscpthost","zCSCptService","zcsairhost",
    "aomhost","aomhost64","airhost",
    "zCrashReport","zCrashReport64",
    "ZoomOutlookIMPlugin","ZoomOutlookMAPI","ZoomOutlookMAPI64",
    "ZoomDocConverter","zTscoder",
    "zUpdater","ZoomInstaller","Installer",
    "ZoomWebHost","zWebview2Agent","zCefAgent",
    "ZoomSDKMessenger",
    "ZoomRooms","zrshell","Controller","DigitalSignage","zrairhost","zrcpthost","bcairhost",
    "conmon_server","mDNSResponder","ptp","ZAAPI","zCECHelper","zJob","zPrinterAgent","ZR3rdHW",
    "zrusplayer","apec3","notification_helper",
    "ZoomVDITool","zWspExtension","ZoomVDIPluginManagement"
  ) | Sort-Object -Unique
  foreach ($p in $processNames) { Stop-ProcessSafe $p }

  # Services (from reference)
  $serviceNames = @("Zoom Sharing Service","CptService","ZoomCptService","zCSCptService","ZoomRooms") | Sort-Object -Unique
  foreach ($s in $serviceNames) { Remove-ServiceSafe $s }

  # Tasks
  Remove-TaskSafe

  # Registry keys (core + WOW6432Node)
  $regKeys = @(
    "HKCU:\Software\Zoom",
    "HKCU:\Software\ZoomUMX",
    "HKCU:\Software\zoom.us",
    "HKCU:\Software\Zoom Video Communications",
    "HKCU:\Software\Zoom Workplace",
    "HKCU:\Software\ZoomGifCollector",
    "HKCU:\Software\CptService",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Zoom",

    "HKLM:\Software\Zoom",
    "HKLM:\Software\ZoomUMX",
    "HKLM:\Software\zoom.us",
    "HKLM:\Software\Zoom Video Communications",
    "HKLM:\Software\Zoom Workplace",
    "HKLM:\Software\CptService",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\ZoomUMX",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Zoom",
    "HKLM:\SYSTEM\CurrentControlSet\Services\CptService",
    "HKLM:\SYSTEM\CurrentControlSet\Services\ZoomCptService",

    "HKLM:\Software\WOW6432Node\Zoom",
    "HKLM:\Software\WOW6432Node\ZoomUMX",
    "HKLM:\Software\WOW6432Node\zoom.us"
  )
  foreach ($k in $regKeys) { Remove-RegKeySafe $k }

  # Run values
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  foreach ($v in @("Zoom","ZoomUMX")) { Remove-RegValueSafe $runKey $v }

  # Extra caches (deep forensic wipe)
  $mui = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"
  if (Test-Path $mui -ErrorAction SilentlyContinue) {
    $props = (Get-ItemProperty -Path $mui -ErrorAction SilentlyContinue).PSObject.Properties |
      Where-Object { $_.Name -match "zoom" -or ($_.Value -is [string] -and $_.Value -match "zoom") }
    foreach ($p in $props) {
      $Report.Findings.RegistryValues += [ordered]@{ Key=$mui; Value=$p.Name }
      if ($PSCmdlet.ShouldProcess("$mui\$($p.Name)","Remove-ItemProperty")) {
        Try-Run "Remove MuiCache $($p.Name)" {
          Remove-ItemProperty -Path $mui -Name $p.Name -ErrorAction Stop
          Add-Action "DeleteRegValue" "$mui\$($p.Name)" "Deleted"
        }
      } else {
        Add-Action "DeleteRegValue" "$mui\$($p.Name)" "WhatIf/Skipped"
      }
    }
  }

  $acf = "HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
  if (Test-Path $acf -ErrorAction SilentlyContinue) {
    $props = (Get-ItemProperty -Path $acf -ErrorAction SilentlyContinue).PSObject.Properties |
      Where-Object { $_.Name -match "zoom" -or ($_.Value -is [string] -and $_.Value -match "zoom") }
    foreach ($p in $props) {
      $Report.Findings.RegistryValues += [ordered]@{ Key=$acf; Value=$p.Name }
      if ($PSCmdlet.ShouldProcess("$acf\$($p.Name)","Remove-ItemProperty")) {
        Try-Run "Remove AppCompat $($p.Name)" {
          Remove-ItemProperty -Path $acf -Name $p.Name -ErrorAction Stop
          Add-Action "DeleteRegValue" "$acf\$($p.Name)" "Deleted"
        }
      } else {
        Add-Action "DeleteRegValue" "$acf\$($p.Name)" "WhatIf/Skipped"
      }
    }
  }

  # Credential Manager entries
  foreach ($c in @("zoom.us","Zoom","ZoomVideo","ZoomUMX","ZoomWorkplace")) { Remove-CredSafe $c }

  # Folders (user + system) from reference + common
  $paths = @(
    "$env:APPDATA\Zoom",
    "$env:APPDATA\Zoom Meetings",
    "$env:APPDATA\zoomus",
    "$env:APPDATA\ZoomLogs",
    "$env:APPDATA\ZoomUMX",
    "$env:APPDATA\zoom.us",
    "$env:APPDATA\Zoom Workplace",
    "$env:APPDATA\ZoomOutlookPlugin",
    "$env:APPDATA\ZoomGifCollector",
    "$env:APPDATA\Zoom VDI",

    "$env:LOCALAPPDATA\Zoom",
    "$env:LOCALAPPDATA\zoomus",
    "$env:LOCALAPPDATA\ZoomLogs",
    "$env:LOCALAPPDATA\ZoomUMX",
    "$env:LOCALAPPDATA\zoom.us",
    "$env:LOCALAPPDATA\Zoom Workplace",
    "$env:LOCALAPPDATA\ZoomOutlookPlugin",
    "$env:LOCALAPPDATA\ZoomGifCollector",
    "$env:LOCALAPPDATA\Zoom VDI",
    "$env:LOCALAPPDATA\Programs\Zoom",
    "$env:LOCALAPPDATA\Programs\zoom.us",
    "$env:LOCALAPPDATA\Zoom\data",
    "$env:LOCALAPPDATA\Zoom\cache",
    "$env:LOCALAPPDATA\Zoom\EBWebView",

    "$env:USERPROFILE\AppData\LocalLow\Zoom",
    "$env:USERPROFILE\Documents\Zoom",

    "$env:TEMP\Zoom",
    "$env:TEMP\zoomus",
    "$env:TEMP\zoom_installer",

    "C:\ProgramData\Zoom",
    "C:\ProgramData\ZoomVideo",
    "C:\ProgramData\Zoom Video Communications",
    "C:\ProgramData\CptService",
    "C:\ProgramData\CptHost",
    "C:\ProgramData\Zoom CptService",
    "C:\ProgramData\Zoom VDI",

    "C:\Program Files\Zoom",
    "C:\Program Files (x86)\Zoom",
    "C:\Program Files\Zoom\bin",
    "C:\Program Files\Zoom Workplace",
    "C:\Program Files (x86)\Zoom Workplace",
    "C:\Program Files\Common Files\Zoom",
    "C:\Program Files (x86)\Common Files\Zoom",
    "C:\Program Files\Common Files\zoom.us",
    "C:\Program Files (x86)\Common Files\zoom.us",

    "$env:LOCALAPPDATA\zoom-1132-eliminator-updater",
    "$env:LOCALAPPDATA\zoom-updater",
    "$env:LOCALAPPDATA\squirrel-zoom"
  ) | Sort-Object -Unique

  foreach ($p in $paths) {
    if (Exists-Path $p) { $Report.Findings.Folders += $p }
    Remove-PathSafe $p "Folder"
  }

  # Telemetry files
  $telemetry = @(
    "$env:APPDATA\Zoom\data\telemetrydata.db",
    "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db",
    "$env:APPDATA\Zoom\telemetrydata.db",
    "$env:LOCALAPPDATA\Zoom\telemetrydata.db"
  ) | Sort-Object -Unique
  foreach ($f in $telemetry) {
    if (Exists-Path $f) { $Report.Findings.Files += $f }
    if (Exists-Path $f) { Remove-PathSafe $f "File" }
  }

  # Firewall, Prefetch, DNS
  Remove-FirewallZoomRules
  Remove-PrefetchZoom
  Flush-DnsSafe

  Add-Action "Phase" "DeepWipe" "End" ""
}

function Reinstall-ZoomFreshMsi {
  Add-Action "Phase" "Reinstall" "Begin" ""
  $url = "https://zoom.us/client/latest/ZoomInstallerFull.msi"
  $dst = Join-Path $env:TEMP "ZoomInstallerFull.msi"

  if ($PSCmdlet.ShouldProcess($url,"Download to $dst")) {
    Try-Run "Download Zoom MSI" {
      Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing -ErrorAction Stop
      Add-Action "Download" $url "Downloaded" $dst
    }
  } else {
    Add-Action "Download" $url "WhatIf/Skipped" $dst
  }

  if (Test-Path $dst -ErrorAction SilentlyContinue) {
    if ($PSCmdlet.ShouldProcess($dst,"Install MSI (ALLUSERS=1)")) {
      Try-Run "Install Zoom MSI" {
        Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $dst, "/qn", "/norestart", "ALLUSERS=1") -Wait -WindowStyle Hidden
        Add-Action "MSIInstall" $dst "Attempted" "ALLUSERS=1"
      }
    } else {
      Add-Action "MSIInstall" $dst "WhatIf/Skipped" "ALLUSERS=1"
    }

    # Cleanup installer
    if ($PSCmdlet.ShouldProcess($dst,"Delete installer")) {
      Try-Run "Delete MSI" {
        Remove-Item -LiteralPath $dst -Force -ErrorAction Stop
        Add-Action "DeleteFile" $dst "Removed"
      }
    } else {
      Add-Action "DeleteFile" $dst "WhatIf/Skipped"
    }
  } else {
    Add-Error "Reinstall" "MSI download missing; cannot install."
  }

  Add-Action "Phase" "Reinstall" "End" ""
}

# --- Run requested flow ---
if (-not $DoAll) {
  Write-Host "Nothing to do. Use -DoAll (and optional -Reinstall)." -ForegroundColor Yellow
  Write-Host "Press Enter to close..."
  [void][System.Console]::ReadLine()
  try { Stop-Transcript | Out-Null } catch { }
  exit 0
}

Add-Action "Start" "ZoomToolkit" "Running" "DoAll selected."

# 1) Best-effort uninstaller (Installer.exe)
Invoke-UninstallZoom_InstallerExe

# 2) MSI product code cleanup (clean removal by GUID)
$msiItems = Get-ZoomMsiGuidsFromRegistry
# Wrap in @() before .Count: Get-ZoomMsiGuidsFromRegistry returns $null when no
# Zoom MSI GUID products are registered (per-user EXE install, or already
# removed), and under `Set-StrictMode -Version Latest` a bare $null.Count is a
# terminating error that would abort before the deep wipe ever runs.
if (@($msiItems).Count -gt 0) {
  Uninstall-ZoomMsiGuids -items $msiItems
} else {
  Add-Action "MSIUninstall" "(none)" "NoZoomMSIProductsFound"
}

# 3) Deep wipe
DeepWipe-Zoom

# 4) Optional reinstall-clean
if ($Reinstall) {
  Reinstall-ZoomFreshMsi
}

$Report.Finished = (Get-Date).ToString("o")

# Write reports
Try-Run "Write TXT report" {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("Zoom Toolkit Report $ts")
  $lines.Add("Computer: $($Report.ComputerName)  User: $($Report.User)  Admin: $($Report.Admin)")
  $lines.Add("Options: DoAll=$DoAll Reinstall=$Reinstall WhatIf=$($Report.Options.WhatIf)")
  $lines.Add("ReportDir: $reportDir")
  $lines.Add("")
  $lines.Add("=== FINDINGS (counts) ===")
  foreach ($k in $Report.Findings.Keys) {
    $count = @($Report.Findings[$k]).Count
    $lines.Add(("{0}: {1}" -f $k, $count))
  }
  $lines.Add("")
  $lines.Add("=== ACTIONS ===")
  foreach ($a in $Report.Actions) {
    $lines.Add(("{0}  {1}  {2}  {3}  {4}" -f $a.Time,$a.Type,$a.Result,$a.Target,$a.Detail))
  }
  if ($Report.Errors.Count -gt 0) {
    $lines.Add("")
    $lines.Add("=== ERRORS ===")
    foreach ($e in $Report.Errors) {
      $lines.Add(("{0}  {1}  {2}" -f $e.Time,$e.Where,$e.Message))
    }
  }
  $lines | Out-File -FilePath $reportTxt -Encoding UTF8
}

Try-Run "Write JSON report" {
  ($Report | ConvertTo-Json -Depth 10) | Out-File -FilePath $reportJson -Encoding UTF8
}

try { Stop-Transcript | Out-Null } catch { }

Write-Host ""
Write-Host "DONE. Reports saved to:" -ForegroundColor Green
Write-Host "  $reportDir"
Write-Host ""
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
