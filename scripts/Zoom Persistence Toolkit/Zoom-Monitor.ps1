<#
Zoom-Monitor.ps1
Checks whether Zoom persistence artifacts have been (re)created and alerts via:
- Log file in .\Monitor\
- Windows Event Log (source: ZoomPersistenceMonitor)

Usage:
  .\Zoom-Monitor.ps1
  .\Zoom-Monitor.ps1 -Once
#>

[CmdletBinding()]
param(
  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$baseDir = Split-Path -Parent $PSCommandPath
$monDir = Join-Path $baseDir "Monitor"
New-Item -ItemType Directory -Path $monDir -Force | Out-Null
$ts = Get-Date -Format "yyyyMMdd_HHmmss"
$log = Join-Path $monDir ("ZoomMonitor_{0}.log" -f $ts)

$items = @(
  # Key persistence artifacts
  @{ Type="Folder"; Path="$env:APPDATA\Zoom" },
  @{ Type="Folder"; Path="$env:LOCALAPPDATA\Zoom" },
  @{ Type="Folder"; Path="C:\Program Files\Zoom" },
  @{ Type="RegKey"; Path="HKCU:\Software\Zoom" },
  @{ Type="RegKey"; Path="HKLM:\Software\Zoom" },
  @{ Type="RegKey"; Path="HKLM:\SOFTWARE\Policies\Zoom\Zoom Meetings\AU2" },
  @{ Type="RegValue"; Path="HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"; Name="Zoom" },
  @{ Type="Service"; Name="ZoomCptService" },
  @{ Type="Service"; Name="Zoom Sharing Service" }
)

function Exists-RegKey($p) { Test-Path $p -ErrorAction SilentlyContinue }
function Exists-Path($p) { Test-Path -LiteralPath $p -ErrorAction SilentlyContinue }
function Exists-RegValue($k,$n) {
  try { $null -ne (Get-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue) } catch { $false }
}
function Exists-Service($n) { $null -ne (Get-Service -Name $n -ErrorAction SilentlyContinue) }

# Ensure event source exists (requires admin)
$source = "ZoomPersistenceMonitor"
try {
  if (-not [System.Diagnostics.EventLog]::SourceExists($source)) {
    New-EventLog -LogName Application -Source $source
  }
} catch { }

$alerts = New-Object System.Collections.Generic.List[string]

foreach ($it in $items) {
  switch ($it.Type) {
    "Folder"   { if (Exists-Path $it.Path) { $alerts.Add("Folder exists: $($it.Path)") | Out-Null } }
    "RegKey"   { if (Exists-RegKey $it.Path) { $alerts.Add("Registry key exists: $($it.Path)") | Out-Null } }
    "RegValue" { if (Exists-RegValue $it.Path $it.Name) { $alerts.Add("Registry value exists: $($it.Path)\$($it.Name)") | Out-Null } }
    "Service"  { if (Exists-Service $it.Name) { $alerts.Add("Service exists: $($it.Name)") | Out-Null } }
  }
}

# Also check for Zoom firewall rules
try {
  $fw = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*Zoom*" }
  if ($fw) { $alerts.Add("Firewall rules present: " + ($fw | Select-Object -ExpandProperty DisplayName | Sort-Object -Unique -Join "; ")) | Out-Null }
} catch { }

# Also check for Zoom scheduled tasks
try {
  $tasks = Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "*Zoom*" -or $_.TaskPath -like "*Zoom*" }
  if ($tasks) { $alerts.Add("Scheduled tasks present: " + (($tasks | ForEach-Object {"$($_.TaskPath)$($_.TaskName)"}) | Sort-Object -Unique -Join "; ")) | Out-Null }
} catch { }

if ($alerts.Count -gt 0) {
  $msg = ("[{0}] Zoom persistence detected:`n - {1}" -f (Get-Date).ToString("o"), ($alerts -join "`n - "))
  $msg | Out-File -FilePath $log -Encoding UTF8
  try { Write-EventLog -LogName Application -Source $source -EventId 42001 -EntryType Warning -Message $msg } catch { }
  Write-Host $msg -ForegroundColor Yellow
} else {
  $msg = ("[{0}] No Zoom persistence detected in monitored items." -f (Get-Date).ToString("o"))
  $msg | Out-File -FilePath $log -Encoding UTF8
  try { Write-EventLog -LogName Application -Source $source -EventId 42000 -EntryType Information -Message $msg } catch { }
  Write-Host $msg -ForegroundColor Green
}

if (-not $Once) {
  Write-Host ""
  Write-Host "Press Enter to close..." 
  [void][System.Console]::ReadLine()
}
