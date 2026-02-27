<#
Install-MonitorTask.ps1
Creates a scheduled task to run Zoom-Monitor.ps1:
- At logon
- Repeats every 1 hour

Usage:
  .\Install-MonitorTask.ps1
#>

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p  = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
  Start-Process -FilePath "powershell.exe" -Verb RunAs -WindowStyle Normal -ArgumentList @(
    "-NoProfile","-ExecutionPolicy","Bypass","-NoExit","-File","`"$PSCommandPath`""
  )
  exit
}

$baseDir = Split-Path -Parent $PSCommandPath
$script = Join-Path $baseDir "Zoom-Monitor.ps1"

$taskName = "Zoom Persistence Monitor"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Once"
$trigger1 = New-ScheduledTaskTrigger -AtLogOn
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$trigger2.Repetition = (New-TimeSpan -Hours 1)
$trigger2.RepetitionDuration = ([TimeSpan]::MaxValue)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger1,$trigger2) -RunLevel Highest -Force | Out-Null

Write-Host "Installed scheduled task: $taskName" -ForegroundColor Green
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
