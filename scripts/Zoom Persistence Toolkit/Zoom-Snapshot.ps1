<#
Zoom-Snapshot.ps1
Creates a JSON snapshot of Zoom persistence artifacts.

Usage:
  .\Zoom-Snapshot.ps1 -Label "Before"
  .\Zoom-Snapshot.ps1 -Label "After"

Output:
  .\Snapshots\ZoomSnapshot_<Label>_<timestamp>.json
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)]
  [string]$Label
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

function Get-Exists($p) { Test-Path -LiteralPath $p -ErrorAction SilentlyContinue }

$baseDir = Split-Path -Parent $PSCommandPath
$snapDir = Join-Path $baseDir "Snapshots"
New-Item -ItemType Directory -Path $snapDir -Force | Out-Null
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$outPath = Join-Path $snapDir ("ZoomSnapshot_{0}_{1}.json" -f ($Label -replace '\W','_'), $ts)

$regKeys = @(
  "HKCU:\Software\Zoom",
  "HKCU:\Software\ZoomUMX",
  "HKCU:\Software\zoom.us",
  "HKCU:\Software\Zoom Video Communications",
  "HKCU:\Software\Zoom Workplace",
  "HKCU:\Software\ZoomGifCollector",
  "HKCU:\Software\CptService",

  "HKLM:\Software\Zoom",
  "HKLM:\Software\ZoomUMX",
  "HKLM:\Software\zoom.us",
  "HKLM:\Software\Zoom Video Communications",
  "HKLM:\Software\Zoom Workplace",
  "HKLM:\Software\CptService",

  "HKLM:\Software\WOW6432Node\Zoom",
  "HKLM:\Software\WOW6432Node\ZoomUMX",
  "HKLM:\Software\WOW6432Node\zoom.us",

  "HKLM:\SYSTEM\CurrentControlSet\Services\CptService",
  "HKLM:\SYSTEM\CurrentControlSet\Services\ZoomCptService",

  # Policy roots (GPO/registry policies)
  "HKLM:\SOFTWARE\Policies\Zoom",
  "HKLM:\SOFTWARE\Policies\Zoom\Zoom Meetings",
  "HKLM:\SOFTWARE\Policies\Zoom\Zoom Meetings\General",
  "HKLM:\SOFTWARE\Policies\Zoom\Zoom Meetings\AU2"
)

$regValues = @(
  @{ Key="HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"; Values=@("Zoom","ZoomUMX") },
  @{ Key="HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"; Values=@("*") },
  @{ Key="HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"; Values=@("*") }
)

$folders = @(
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

  "C:\ProgramData\Zoom",
  "C:\ProgramData\ZoomVideo",
  "C:\ProgramData\Zoom Video Communications",
  "C:\ProgramData\CptService",
  "C:\ProgramData\CptHost",
  "C:\ProgramData\Zoom CptService",
  "C:\ProgramData\Zoom VDI",

  "C:\Program Files\Zoom",
  "C:\Program Files (x86)\Zoom",
  "C:\Program Files\Zoom Workplace",
  "C:\Program Files (x86)\Zoom Workplace",
  "C:\Program Files\Common Files\Zoom",
  "C:\Program Files (x86)\Common Files\Zoom",
  "C:\Program Files\Common Files\zoom.us",
  "C:\Program Files (x86)\Common Files\zoom.us"
) | Sort-Object -Unique

$files = @(
  "$env:APPDATA\Zoom\data\telemetrydata.db",
  "$env:LOCALAPPDATA\Zoom\data\telemetrydata.db",
  "$env:APPDATA\Zoom\telemetrydata.db",
  "$env:LOCALAPPDATA\Zoom\telemetrydata.db"
) | Sort-Object -Unique

$prefetchPatterns = @("C:\Windows\Prefetch\*ZOOM*","C:\Windows\Prefetch\*CPT*")

$svcNames = @("Zoom Sharing Service","CptService","ZoomCptService","zCSCptService","ZoomRooms")

$procNames = @(
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

# MSI products by uninstall registry entries (Zoom in DisplayName + GUID in UninstallString)
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
      if (-not $p -or -not $p.DisplayName -or -not $p.UninstallString) { return }
      if ($p.DisplayName -notmatch "Zoom") { return }
      $m = [regex]::Match($p.UninstallString, "\{[0-9A-Fa-f\-]{36}\}")
      if ($m.Success) {
        $out.Add([pscustomobject]@{
          DisplayName     = $p.DisplayName
          Publisher       = $p.Publisher
          Version         = $p.DisplayVersion
          Guid            = $m.Value
          UninstallString = $p.UninstallString
          KeyPath         = $_.PsPath
        })
      }
    }
  }
  return $out | Sort-Object Guid -Unique
}

# Credentials that Zoom commonly uses (via cmdkey)
function Get-CmdKeyTargets {
  $list = (& cmdkey /list 2>$null) -join "`n"
  $targets = @()
  foreach ($t in @("zoom.us","Zoom","ZoomVideo","ZoomUMX","ZoomWorkplace")) {
    if ($list -match [regex]::Escape($t)) { $targets += $t }
  }
  $targets | Sort-Object -Unique
}

# Scheduled tasks containing "Zoom"
function Get-ZoomTasks {
  try {
    Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
      $_.TaskName -like "*Zoom*" -or $_.TaskPath -like "*Zoom*"
    } | Select-Object TaskName,TaskPath,State
  } catch { @() }
}

# Firewall rules containing "Zoom"
function Get-ZoomFirewallRules {
  try {
    Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*Zoom*" } |
      Select-Object DisplayName,Enabled,Direction,Action,Profile
  } catch { @() }
}

# Registry values collector (safe)
function Get-RegValues {
  param([string]$KeyPath,[string[]]$Values)
  if (-not (Test-Path $KeyPath -ErrorAction SilentlyContinue)) { return @() }
  $ip = Get-ItemProperty -Path $KeyPath -ErrorAction SilentlyContinue
  if (-not $ip) { return @() }

  if ($Values.Count -eq 1 -and $Values[0] -eq "*") {
    # return only those that look related to zoom to keep output smaller
    return $ip.PSObject.Properties |
      Where-Object { $_.Name -match "zoom" -or ($_.Value -is [string] -and $_.Value -match "zoom") } |
      Select-Object Name,Value
  }

  $out = @()
  foreach ($v in $Values) {
    $prop = $ip.PSObject.Properties | Where-Object { $_.Name -eq $v }
    if ($prop) { $out += [pscustomobject]@{ Name=$prop.Name; Value=$prop.Value } }
  }
  return $out
}

$Snapshot = [ordered]@{
  Meta = [ordered]@{
    Label = $Label
    Timestamp = (Get-Date).ToString("o")
    ComputerName = $env:COMPUTERNAME
    User = $env:USERNAME
  }
  MsiProducts = Get-ZoomMsiGuidsFromRegistry
  ProcessesRunning = @()
  Services = @()
  ScheduledTasks = Get-ZoomTasks
  FirewallRules = Get-ZoomFirewallRules
  Credentials = Get-CmdKeyTargets
  Registry = [ordered]@{
    Keys = @()
    Values = @()
  }
  Paths = [ordered]@{
    Folders = @()
    Files = @()
    PrefetchFiles = @()
  }
}

# Running processes (by name)
foreach ($n in $procNames) {
  $procs = Get-Process -Name $n -ErrorAction SilentlyContinue
  foreach ($p in $procs) {
    $path = $null
    try { $path = $p.Path } catch { }
    $Snapshot.ProcessesRunning += [pscustomobject]@{ Name=$p.Name; Id=$p.Id; Path=$path }
  }
}

# Services
foreach ($s in $svcNames) {
  $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
  if ($svc) { $Snapshot.Services += [pscustomobject]@{ Name=$svc.Name; DisplayName=$svc.DisplayName; Status=$svc.Status.ToString() } }
}

# Registry keys existence
foreach ($k in $regKeys) {
  if (Test-Path $k -ErrorAction SilentlyContinue) { $Snapshot.Registry.Keys += $k }
}

# Registry values
foreach ($rv in $regValues) {
  $vals = Get-RegValues -KeyPath $rv.Key -Values $rv.Values
  foreach ($v in $vals) {
    $Snapshot.Registry.Values += [pscustomobject]@{ Key=$rv.Key; Name=$v.Name; Value=$v.Value }
  }
}

# Folders/files existence
foreach ($p in $folders) {
  if (Get-Exists $p) { $Snapshot.Paths.Folders += $p }
}
foreach ($f in $files) {
  if (Get-Exists $f) { $Snapshot.Paths.Files += $f }
}

# Prefetch hits
foreach ($pat in $prefetchPatterns) {
  $hits = Get-ChildItem -Path $pat -ErrorAction SilentlyContinue
  foreach ($h in $hits) { $Snapshot.Paths.PrefetchFiles += $h.FullName }
}
$Snapshot.Paths.PrefetchFiles = $Snapshot.Paths.PrefetchFiles | Sort-Object -Unique

($Snapshot | ConvertTo-Json -Depth 8) | Out-File -FilePath $outPath -Encoding UTF8
Write-Host "Snapshot saved: $outPath" -ForegroundColor Green
