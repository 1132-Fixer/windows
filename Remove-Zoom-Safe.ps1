<#
Remove-Zoom-Safe.ps1 (Current User Only)
- Auto-elevates
- Only removes Zoom items that actually exist
- Outputs TXT + JSON report in the same folder
- Best-effort uninstall first (Zoom Installer.exe or UninstallString) then cleanup
#>
[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [switch]$UninstallFirst
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
  if ($UninstallFirst) { $argsList += "-UninstallFirst" }
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-NoProfile","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`""
  ) + $argsList
  exit
}
# Report setup
$scriptDir = Split-Path -Parent $PSCommandPath
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$reportTxt  = Join-Path $scriptDir "ZoomCleanup_Report_$ts.txt"
$reportJson = Join-Path $scriptDir "ZoomCleanup_Report_$ts.json"
$Report = [ordered]@{
  Started      = (Get-Date).ToString("o")
  ComputerName = $env:COMPUTERNAME
  User         = $env:USERNAME
  Admin        = $true
  Options      = @{
    UninstallFirst = [bool]$UninstallFirst
    WhatIf         = [bool]$WhatIfPreference
  }
  Findings = [ordered]@{
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
    Uninstallers   = @()
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
    $Report.Findings.Processes += [ordered]@{ Name=$p.Name; Id=$p.Id; Path=($p.Path 2>$null) }
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
function Invoke-UninstallZoomBestEffort {
  # Try Zoom Installer.exe /uninstall
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
  # Try UninstallString entries that match "Zoom"
  $uninstallRoots = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )
  foreach ($root in $uninstallRoots) {
    if (-not (Test-Path $root -ErrorAction SilentlyContinue)) { continue }
    $apps = Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PsPath -ErrorAction SilentlyContinue
      if ($p.DisplayName -and $p.DisplayName -match "Zoom") { $p }
    }
    foreach ($app in $apps) {
      $disp = $app.DisplayName
      $u = $app.UninstallString
      if (-not $u) { continue }
      $Report.Findings.Uninstallers += [ordered]@{ Method="UninstallString"; DisplayName=$disp; UninstallString=$u }
      $exe = "cmd.exe"
      $args = "/c $u"
      if ($u -match "msiexec\.exe" -and $u -match "\{[0-9A-Fa-f-]+\}") {
        $guid = [regex]::Match($u,"\{[0-9A-Fa-f-]+\}").Value
        $args = "/c msiexec /x $guid /qn /norestart"
      }
      if ($PSCmdlet.ShouldProcess($disp,"Run uninstall")) {
        Try-Run "Uninstall $disp" {
          Start-Process -FilePath $exe -ArgumentList $args -Wait -WindowStyle Hidden
          Add-Action "Uninstall" $disp "Attempted" $args
        }
      } else {
        Add-Action "Uninstall" $disp "WhatIf/Skipped" $args
      }
    }
  }
}
# Targets from your reference (processes/services/etc.)
$processNames = @(
  "Zoom","Zoomus","Zoom_launcher","ZoomHybridConf","zSafeChecker",
  "CptHost","CptService","CptControl","CptInstall",
  "zcscpthost","zCSCptService","zcsairhost",
  "aomhost","aomhost64","airhost",
  "zCrashReport","zCrashReport64",
  "ZoomOutlookIMPlugin","ZoomOutlookMAPI","ZoomOutlookMAPI64",
  "ZoomDocConverter","zTscoder",
  "zUpdater","ZoomInstaller","Installer",
  "ZoomWebHost","zWebview2Agent","zCefAgent","msedgewebview2",
  "ZoomSDKMessenger",
  "ZoomRooms","zrshell","Controller","DigitalSignage","zrairhost","zrcpthost","bcairhost",
  "conmon_server","mDNSResponder","ptp","ZAAPI","zCECHelper","zJob","zPrinterAgent","ZR3rdHW",
  "zrusplayer","apec3","notification_helper",
  "ZoomVDITool","zWspExtension","ZoomVDIPluginManagement"
) | Sort-Object -Unique
$serviceNames = @("Zoom Sharing Service","CptService","ZoomCptService","zCSCptService","ZoomRooms") | Sort-Object -Unique
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
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValues = @("Zoom","ZoomUMX")
$credTargets = @("zoom.us","Zoom","ZoomVideo","ZoomUMX","ZoomWorkplace") | Sort-Object -Unique
$userPaths = @(
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
  "$env:LOCALAPPDATA\zoom-1132-eliminator-updater",
  "$env:LOCALAPPDATA\zoom-updater",
  "$env:LOCALAPPDATA\squirrel-zoom"
) | Sort-Object -Unique
$systemPaths = @(
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
  "C:\Program Files (x86)\Common Files\zoom.us"
) | Sort-Object -Unique
$telemetryFiles = @(
  "$env:APPDATA\Zoom\data\telemetrydata.db",
  "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db",
  "$env:APPDATA\Zoom\telemetrydata.db",
  "$env:LOCALAPPDATA\Zoom\telemetrydata.db"
) | Sort-Object -Unique
Add-Action "Start" "ZoomCleanup" "Running" "Current user only. Only existing items are removed."
if ($UninstallFirst) {
  Add-Action "UninstallFirst" "Zoom" "Enabled" ""
  Invoke-UninstallZoomBestEffort
}
foreach ($p in $processNames) { Stop-ProcessSafe $p }
foreach ($s in $serviceNames) { Remove-ServiceSafe $s }
Remove-TaskSafe
foreach ($k in $regKeys) { Remove-RegKeySafe $k }
foreach ($v in $runValues) { Remove-RegValueSafe $runKey $v }
foreach ($c in $credTargets) { Remove-CredSafe $c }
foreach ($p in $userPaths) {
  if (Exists-Path $p) { $Report.Findings.Folders += $p }
  Remove-PathSafe $p "Folder"
}
foreach ($p in $systemPaths) {
  if (Exists-Path $p) { $Report.Findings.Folders += $p }
  Remove-PathSafe $p "Folder"
}
foreach ($f in $telemetryFiles) {
  if (Exists-Path $f) { $Report.Findings.Files += $f }
  if (Exists-Path $f) { Remove-PathSafe $f "File" }
}
Remove-FirewallZoomRules
Remove-PrefetchZoom
Flush-DnsSafe
$Report.Finished = (Get-Date).ToString("o")
Try-Run "Write TXT report" {
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("Zoom Cleanup Report $ts")
  $lines.Add("Computer: $($Report.ComputerName)  User: $($Report.User)  Admin: $($Report.Admin)")
  $lines.Add("Options: UninstallFirst=$UninstallFirst WhatIf=$($Report.Options.WhatIf)")
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
  ($Report | ConvertTo-Json -Depth 8) | Out-File -FilePath $reportJson -Encoding UTF8
}
Write-Host ""
Write-Host "Done."
Write-Host "Report saved:"
Write-Host "  $reportTxt"
Write-Host "  $reportJson"
Write-Host ""
Write-Host "Close this window when ready."
