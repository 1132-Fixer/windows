<#
Zoom-Hardened-Install.ps1
"Hardened" Zoom install (best-effort) to reduce persistence:
- Install Zoom MSI with AutoStartAfterReboot=0 (do not start Zoom with Windows)
- Disable client auto-update via Zoom AU2 policy (AU2_EnableAutoUpdate=0)
- Remove any existing HKCU Run entries (Zoom / ZoomUMX)
- Optional: restrict login domains/account IDs (left commented for safety)

Notes:
- Zoom still collects REQUIRED diagnostic data; OPTIONAL diagnostic data is controlled via Zoom web portal admin settings.
- Some persistence (Program Files, HKLM uninstall keys, firewall rules, services) is expected with any install.

Usage:
  .\Zoom-Hardened-Install.ps1
#>

[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

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

$msiUrl = "https://zoom.us/client/latest/ZoomInstallerFull.msi"
$dst = Join-Path $env:TEMP "ZoomInstallerFull.msi"

# Download MSI
if ($PSCmdlet.ShouldProcess($msiUrl,"Download MSI to $dst")) {
  Invoke-WebRequest -Uri $msiUrl -OutFile $dst -UseBasicParsing -ErrorAction Stop
  Write-Host "Downloaded: $dst" -ForegroundColor Green
}

# Install with hardening MSI property (AutoStartAfterReboot=0)
# Zoom documentation lists AutoStartAfterReboot as an MSI option (0 disables). 
if ($PSCmdlet.ShouldProcess($dst,"Install Zoom MSI (AutoStartAfterReboot=0)")) {
  Start-Process -FilePath "msiexec.exe" -ArgumentList @(
    "/i", $dst,
    "/qn", "/norestart",
    "ALLUSERS=1",
    "AutoStartAfterReboot=0"
  ) -Wait -WindowStyle Hidden
  Write-Host "Install attempted (silent)." -ForegroundColor Green
}

# Disable client auto-updates via Zoom AU2 policy
$au2Key = "HKLM:\SOFTWARE\Policies\Zoom\Zoom Meetings\AU2"
if ($PSCmdlet.ShouldProcess($au2Key,"Set AU2_EnableAutoUpdate=0")) {
  New-Item -Path $au2Key -Force | Out-Null
  New-ItemProperty -Path $au2Key -Name "AU2_EnableAutoUpdate" -PropertyType DWord -Value 0 -Force | Out-Null
  Write-Host "Policy set: AU2_EnableAutoUpdate=0" -ForegroundColor Green
}

# Remove any Run entries (Zoom shouldn't auto-start)
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
foreach ($v in @("Zoom","ZoomUMX")) {
  if (Get-ItemProperty -Path $runKey -Name $v -ErrorAction SilentlyContinue) {
    if ($PSCmdlet.ShouldProcess("$runKey\$v","Remove Run value")) {
      Remove-ItemProperty -Path $runKey -Name $v -ErrorAction SilentlyContinue
    }
  }
}

Write-Host ""
Write-Host "Hardened install complete." -ForegroundColor Green
Write-Host "Reminder: Optional diagnostic data is controlled in Zoom web portal (Data & Privacy); required diagnostic data cannot be disabled."
Write-Host ""
Write-Host "Press Enter to close..."
[void][System.Console]::ReadLine()
